/**
 * 线格式转换：dsh 消息 ↔ OpenAI 兼容载荷。
 *
 * 纯函数模块（无 I/O），可独立单测。GenerateOptions 的 messages 是
 * dsh-llm 的 RequestMessage[]（块式 content），这里拍平成 Token Plan
 * 端点接受的 OpenAI 格式；SSE 块到 StreamChunk 的映射在 client.js。
 *
 * @module lib/wire.js
 */

/**
 * 把一条 dsh 消息的 content 块序列化为 OpenAI content 字符串
 * （非工具调用场景；图片占位由 images.js 先行替换）。
 */
function flattenText(content, imageText) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text') parts.push(block.text ?? '')
    else if (block.type === 'image') parts.push(imageText?.get(block) ?? '[图片]')
    // tool-call 块绝不进入文本：assistant 场景由 buildRequestBody 映射为
    // tool_calls 结构字段；user 场景里的罕见 tool-call 块同样跳过。
    // 曾用 "[调用工具 xxx]" 占位文本拼进上下文 → 模型会复述该模式，
    // 造成"对话流里出现 [调用工具 xxx]"（非模型原始输出）。
    else if (block.type === 'tool-call') continue
    // tool-result 不在此展开：它由 buildRequestBody 单独映射为 role:'tool' 消息，
    // 这里再拍平会使其内容在 tool 消息与 user 文本中重复出现
    else if (block.type === 'thinking' || block.type === 'reasoning') continue
  }
  return parts.filter((s) => s !== '').join('\n')
}

/**
 * GenerateOptions → OpenAI chat/completions 载荷。
 *
 * 图片块的三种形态（offloaded / 宿主文件 / 字节附件）由调用方通过
 * imageParts 预先物化（images.js），这里只消费结果：
 *   - imageText: Map<image块, 占位文本>（纯文本模型 / offloaded）
 *   - imageUrls: 数组，追加到最后一条用户消息（视觉模型，顺序保留）
 *
 * tool-call / tool-result 用 OpenAI 标准映射（assistant.tool_calls /
 * user 里 tool 消息）；同一 user 消息内多个 tool-result 合并为多条
 * role:'tool' 消息（OpenAI 语义按 tool_call_id 配对）。
 */
export function buildRequestBody(options, { imageText = new Map(), imageUrls = [] } = {}) {
  const messages = []
  if (typeof options.system === 'string' && options.system.trim() !== '') {
    messages.push({ role: 'system', content: options.system })
  }

  // 块引用计数：为未在 imageText 里的图片块兜底占位
  let imageIndex = 0
  const placeholder = (block) => imageText.get(block) ?? `[图片 #${++imageIndex}（当前模型不支持图像输入）]`

  for (const message of options.messages ?? []) {
    const content = message.content ?? []

    // user 消息里的 tool-result 块 → 独立 role:'tool' 消息（放在文本之前）。
    // 注：dsh 清单中工具结果以 role:'tool' 消息到达（上方分支处理），此处
    // tool-result 块仅作防御性兜底（dsh 契约里没有该块类型，属死路径）。
    if (message.role === 'user' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool-call') {
          // user 内容里出现 tool-call（罕见）按文本占位，不映射为 tool_calls
          continue
        }
        if (block?.type === 'tool-result' && typeof block.toolCallId === 'string') {
          messages.push({
            role: 'tool',
            tool_call_id: block.toolCallId,
            content: flattenText(block.content, imageText),
          })
        }
      }
    }

    if (message.role === 'assistant' && Array.isArray(content)) {
      const toolCalls = content.filter((b) => b?.type === 'tool-call')
      const text = flattenText(content, imageText)
      if (toolCalls.length > 0 || text !== '') {
        const entry = { role: 'assistant' }
        if (text !== '') entry.content = text
        else entry.content = null
        if (toolCalls.length > 0) {
          entry.tool_calls = toolCalls.map((b) => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}) },
          }))
        }
        messages.push(entry)
      }
      continue
    }

    if (message.role === 'tool') {
      // 工具结果是一等 role:'tool' 消息（dsh 契约），映射为 OpenAI 的
      // role:'tool' + tool_call_id 配对；空内容给占位以免上游报错。
      const text = flattenText(content, imageText)
      messages.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: text === '' ? '(no tool output)' : text,
      })
      continue
    }

    if (message.role === 'system' && Array.isArray(content)) {
      const text = flattenText(content, imageText)
      if (text !== '') messages.push({ role: 'system', content: text })
      continue
    }

    // user（及字符串 content 的兜底）
    const text = flattenText(content, imageText)
    if (text !== '' || (message.role === 'user' && Array.isArray(content) && content.some((b) => b?.type === 'image'))) {
      messages.push({ role: 'user', content: text === '' && Array.isArray(content) ? placeholderImages(content, placeholder) : text })
    } else if (text !== '') {
      messages.push({ role: message.role === 'user' ? 'user' : 'assistant', content: text })
    }
  }

  // 视觉模型：图片以 image_url 数组追加到最后一条 user 消息
  if (imageUrls.length > 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') {
        const parts = []
        if (typeof messages[i].content === 'string' && messages[i].content !== '') {
          parts.push({ type: 'text', text: messages[i].content })
        } else if (messages[i].content) {
          parts.push(...messages[i].content)
        }
        for (const url of imageUrls) parts.push({ type: 'image_url', image_url: { url } })
        messages[i].content = parts
        break
      }
    }
  }

  const body = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }))
  }
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens
  if (options.stop && options.stop.length > 0) body.stop = options.stop
  return body
}

/** 无文本的纯图 user 消息：把占位符列表作为文本内容。 */
function placeholderImages(content, placeholder) {
  const parts = []
  for (const block of content) {
    if (block?.type === 'image') parts.push(placeholder(block))
  }
  return parts.join('\n') || '[图片]'
}
