/**
 * Token Plan 推理客户端：SSE 流 → StreamChunk。
 *
 * 连接管理是本插件的核心杠杆（实测，见 DESIGN.md §6）：前缀缓存命中与否
 * 取决于请求路由到哪个推理节点——单条 keep-alive 连接（maxSockets:1）
 * 顺序请求稳定命中（6/6），默认连接池随机命中（~50%）。因此每个账号
 * 固定一条 pinned https.Agent，账号内请求顺序化；账号内串行由 scheduler
 * 的闸门保证。传输用 node:https.request（限流报告 makePinnedCaller 的
 * 已验证模式），不用 fetch——Node 全局 fetch 的 dispatcher 需要 undici
 * Agent，与 node:https.Agent 不兼容。
 *
 * SSE 形态（P0 实测 2026-10-02）：
 *   data: {"choices":[{"delta":{"content"|"reasoning_content"|"tool_calls"?}}], "usage"?}
 *   data: [DONE]
 * usage 独立块（stream_options.include_usage）含
 *   prompt_tokens_details.cached_tokens / completion_tokens_details.reasoning_tokens
 *
 * @module lib/client.js
 */

import https from 'node:https'
import { LlmError } from '@deepseek-ai/dsh-llm'

const DEFAULT_BASE_URL = 'https://token.sensenova.cn/v1'

/**
 * 每账号一个 pinned agent。keepAlive + maxSockets:1 = 该账号全部请求走
 * 同一条 TCP 连接、顺序发出（账号内串行由 scheduler 闸门保证，不在这里并发）。
 */
export function pinnedAgent() {
  return new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30_000 })
}

/**
 * 发起一次流式 chat/completions 并迭代为 StreamChunk。
 * key / agent 由调用方（scheduler）注入；baseUrl 可覆盖（测试/网关）。
 *
 * @param {object} args
 * @param {string} args.key sk- key
 * @param {https.Agent} args.agent 账号钉连 agent
 * @param {object} args.body wire.js 产出的 OpenAI 载荷
 * @param {AbortSignal} [args.signal] 取消
 * @param {(fact: {status?: number}) => void} [args.onResponse] 响应状态回调（调度器记账）
 * @param {string} [args.baseUrl]
 * @yields {import('@deepseek-ai/dsh-llm').StreamChunk}
 */
export async function* streamChat({ key, agent, body, signal, onResponse, baseUrl = DEFAULT_BASE_URL }) {
  const payload = JSON.stringify(body)
  const url = new URL(`${baseUrl}/chat/completions`)

  let response
  try {
    response = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        agent,
        signal,
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, resolve)
      req.on('error', reject)
      req.end(payload)
    })
  } catch (error) {
    if (signal?.aborted) throw abortError()
    throw new LlmError(`dsh-sensenova: 请求失败：${error?.message ?? error}`, 'PROVIDER_UNAVAILABLE', { cause: error })
  }
  onResponse?.({ status: response.statusCode })

  const status = response.statusCode ?? 0
  if (status === 429) {
    response.resume()
    throw new LlmError('dsh-sensenova: 限流（tpm/rpm）', 'RATE_LIMIT', { facts: { status: 429 } })
  }
  if (status === 401 || status === 403) {
    const text = await readBody(response)
    throw new LlmError(`dsh-sensenova: key 被拒绝（${status}）：${snippet(text)}`, 'INVALID_CREDENTIAL', { facts: { status } })
  }
  if (status < 200 || status >= 300) {
    const text = await readBody(response)
    throw new LlmError(`dsh-sensenova: 上游错误 ${status}：${snippet(text)}`, 'PROVIDER_ERROR', { facts: { status } })
  }

  response.setEncoding('utf8')
  yield* parseSseText(response, signal)
}

function abortError() {
  const error = new LlmError('dsh-sensenova: 请求已取消', 'ABORTED')
  error.name = 'AbortError'
  return error
}

function snippet(text) {
  return (text ?? '').replace(/\s+/g, ' ').slice(0, 160)
}

async function readBody(response) {
  response.setEncoding('utf8')
  let text = ''
  for await (const chunk of response) text += chunk
  return text
}

/**
 * finish_reason → dsh FinishReason（dsh-llm 契约：带 kind 的对象联合）。
 * 未映射的按 stop 处理。length → max-tokens（宿主据此丢弃不可安全执行的 tool-calls）。
 */
function finishReason(reason) {
  if (reason === 'length') return { kind: 'max-tokens' }
  if (reason === 'tool_calls' || reason === 'function_call') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/** usage 字段映射（P0 实测确认字段名）。 */
export function translateUsage(usage) {
  const out = {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  }
  if (typeof usage.total_tokens === 'number') out.totalTokens = usage.total_tokens
  const cached = usage.prompt_tokens_details?.cached_tokens
  if (typeof cached === 'number') out.cacheReadTokens = cached
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  if (typeof reasoning === 'number') out.reasoningTokens = reasoning
  return out
}

/**
 * SSE 文本流解析（纯函数，测试直接喂数组）：输入是字符串块的异步可迭代
 * （真实响应 = setEncoding('utf8') 的 IncomingMessage；测试 = 字符串数组）。
 *
 * 块 index 分配：文本 / 推理 / 每个 tool-call 各占一个块，按首个增量到达
 * 顺序编号；block-end 在流结束时统一收口（平台总是在 [DONE] 前发完全部
 * 增量，收口放最后是防御性顺序，不依赖它）。
 *
 * @param {AsyncIterable<string> | Iterable<string>} chunks
 * @param {AbortSignal} [signal]
 * @yields {import('@deepseek-ai/dsh-llm').StreamChunk}
 */
export async function* parseSseText(chunks, signal) {
  let buffer = ''
  let nextIndex = 0
  let finish = { kind: 'stop' }
  /** @type {{ index: number, text: string } | null} */
  let textBlock = null
  /** @type {{ index: number, text: string } | null} */
  let reasoningBlock = null
  /** upstream tool index → { index, id, name, args, started } */
  const tools = new Map()
  const out = []

  const handleEvent = (event) => {
    const choice = event.choices?.[0]
    const delta = choice?.delta ?? {}

    if (typeof delta.content === 'string' && delta.content !== '') {
      if (!textBlock) {
        textBlock = { index: nextIndex++, text: '' }
        out.push({ type: 'block-start', index: textBlock.index, blockType: 'text' })
      }
      textBlock.text += delta.content
      out.push({ type: 'text-delta', index: textBlock.index, text: delta.content })
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      if (!reasoningBlock) {
        reasoningBlock = { index: nextIndex++, text: '' }
        out.push({ type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' })
      }
      reasoningBlock.text += delta.reasoning_content
      out.push({ type: 'reasoning-delta', index: reasoningBlock.index, text: delta.reasoning_content })
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const upstreamIndex = call.index ?? 0
        let slot = tools.get(upstreamIndex)
        if (!slot) {
          slot = { index: nextIndex++, id: call.id ?? '', name: '', args: '', started: false }
          tools.set(upstreamIndex, slot)
        }
        if (call.id) slot.id = call.id
        if (typeof call.function?.name === 'string' && call.function.name !== '') slot.name = call.function.name
        if (typeof call.function?.arguments === 'string') slot.args += call.function.arguments
        if (!slot.started && (slot.id !== '' || slot.args !== '')) {
          slot.started = true
          out.push({ type: 'block-start', index: slot.index, blockType: 'tool-call' })
        }
        if (typeof call.function?.arguments === 'string' && call.function.arguments !== '') {
          out.push({
            type: 'tool-call-delta',
            index: slot.index,
            id: slot.id,
            ...(slot.name !== '' ? { name: slot.name } : {}),
            argumentsDelta: call.function.arguments,
          })
        }
      }
    }
    if (event.usage) {
      out.push({ type: 'usage', usage: translateUsage(event.usage) })
    }
    if (choice?.finish_reason) finish = finishReason(choice.finish_reason)
  }

  try {
    for await (const chunk of chunks) {
      if (signal?.aborted) throw abortError()
      buffer += chunk
      let newlineIndex
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '') continue
        if (payload === '[DONE]') {
          yield* closeOut()
          return
        }
        let event
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }
        out.length = 0
        handleEvent(event)
        for (const chunk_ of out) yield chunk_
      }
    }
  } catch (error) {
    if (signal?.aborted) throw abortError()
    throw error
  }
  if (signal?.aborted) throw abortError()
  yield* closeOut()

  function* closeOut() {
    const blocks = [
      ...(textBlock ? [{ block: textBlock, end: { type: 'text', text: textBlock.text } }] : []),
      ...(reasoningBlock ? [{ block: reasoningBlock, end: { type: 'reasoning', text: reasoningBlock.text } }] : []),
      ...[...tools.values()].map((slot) => ({
        block: slot,
        end: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args },
      })),
    ].sort((a, b) => a.block.index - b.block.index)

    for (const { block, end } of blocks) {
      yield { type: 'block-end', index: block.index, block: end }
    }
    yield { type: 'finish', reason: finish }
  }
}
