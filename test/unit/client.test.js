import { test } from 'node:test'
import assert from 'node:assert/strict'

import { translateUsage, parseSseText } from '../../lib/client.js'

async function collect(iter) {
  const out = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

/** 把 OpenAI chunk 对象数组变成一段 SSE 文本（含 [DONE]）。 */
function sseText(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}`).join('\n') + '\n\ndata: [DONE]\n\n'
}

test('usage 映射：cached/reasoning tokens', () => {
  const usage = translateUsage({
    prompt_tokens: 159,
    completion_tokens: 102,
    total_tokens: 261,
    completion_tokens_details: { reasoning_tokens: 86 },
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
  })
  assert.deepEqual(usage, {
    inputTokens: 159,
    outputTokens: 102,
    totalTokens: 261,
    cacheReadTokens: 0,
    reasoningTokens: 86,
  })
})

test('usage 缺 details 时字段省略', () => {
  const usage = translateUsage({ prompt_tokens: 10, completion_tokens: 5 })
  assert.equal('cacheReadTokens' in usage, false)
  assert.equal('reasoningTokens' in usage, false)
  assert.equal('totalTokens' in usage, false)
})

test('SSE：文本流完整块序列', async () => {
  const chunks = await collect(parseSseText([sseText([
    { choices: [{ index: 0, delta: { content: '你' } }] },
    { choices: [{ index: 0, delta: { content: '好' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])]))
  assert.deepEqual(chunks.map((c) => c.type), [
    'block-start', 'text-delta', 'text-delta', 'block-end', 'finish',
  ])
  assert.equal(chunks[0].blockType, 'text')
  assert.equal(chunks[1].text, '你')
  assert.equal(chunks[3].block.text, '你好')
  assert.deepEqual(chunks[4].reason, { kind: 'stop' })
})

test('SSE：reasoning 与 text 双通道分块', async () => {
  const chunks = await collect(parseSseText([sseText([
    { choices: [{ index: 0, delta: { reasoning_content: '思考' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: '中' } }] },
    { choices: [{ index: 0, delta: { content: '答案' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])]))
  assert.deepEqual(chunks.filter((c) => c.type === 'block-start').map((c) => c.blockType), ['reasoning', 'text'])
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.equal(reasoning, '思考中')
  const ends = chunks.filter((c) => c.type === 'block-end')
  assert.equal(ends[0].block.type, 'reasoning')
  assert.equal(ends[1].block.text, '答案')
})

test('SSE：tool_calls 分片参数累积', async () => {
  const chunks = await collect(parseSseText([sseText([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ])]))
  const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
  assert.equal(deltas.length, 2)
  assert.equal(deltas[0].id, 'call_1')
  assert.equal(deltas[0].name, 'get_weather')
  assert.deepEqual(deltas.map((d) => d.argumentsDelta), ['{"city":', '"北京"}'])
  const end = chunks.find((c) => c.type === 'block-end')
  assert.equal(end.block.type, 'tool-call')
  assert.equal(end.block.arguments, '{"city":"北京"}')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('SSE：usage 独立块透传', async () => {
  const chunks = await collect(parseSseText([sseText([
    { choices: [{ index: 0, delta: { content: '好' } }] },
    { choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 91, completion_tokens: 60, total_tokens: 151, prompt_tokens_details: { cached_tokens: 40 } } },
  ])]))
  const usage = chunks.find((c) => c.type === 'usage')
  assert.equal(usage.usage.cacheReadTokens, 40)
  assert.equal(usage.usage.totalTokens, 151)
})

test('SSE：跨块分割的行与非法 JSON 容错', async () => {
  // 一个事件被切成三段喂入；中间夹一行垃圾
  const text = 'data: {"choices":[{"index":0,"delta":{"con' + 'tent":"你"}}]}\n\ngarbage-line\n\ndata: [DONE]\n'
  const chunks = await collect(parseSseText([text.slice(0, 20), text.slice(20, 60), text.slice(60)]))
  assert.equal(chunks.filter((c) => c.type === 'text-delta').length, 1)
  assert.equal(chunks.at(-1).type, 'finish')
})

test('SSE：finish_reason=length 映射为 max-tokens', async () => {
  const chunks = await collect(parseSseText([sseText([
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
  ])]))
  assert.deepEqual(chunks.at(-1).reason, { kind: 'max-tokens' })
})
