import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildRequestBody } from '../../lib/wire.js'

const base = { provider: 'sensenova', model: 'deepseek-v4-flash' }

test('system → 首条 system 消息', () => {
  const body = buildRequestBody({ ...base, system: '你是助手', messages: [{ role: 'user', content: '你好' }] })
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, '你是助手')
  assert.equal(body.messages[1].role, 'user')
})

test('字符串 content 原样透传', () => {
  const body = buildRequestBody({ ...base, messages: [{ role: 'user', content: '你好' }] })
  assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }])
})

test('assistant tool-call 块 → tool_calls 字段', () => {
  const body = buildRequestBody({ ...base, messages: [
    { role: 'user', content: '查天气' },
    { role: 'assistant', content: [
      { type: 'text', text: '我来查' },
      { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
    ] },
  ] })
  const assistant = body.messages[1]
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.tool_calls.length, 1)
  assert.equal(assistant.tool_calls[0].function.name, 'get_weather')
  assert.equal(assistant.tool_calls[0].function.arguments, '{"city":"北京"}')
  // 回归：tool-call 块绝不进入 content 文本（此前 "[调用工具 xxx]" 占位
  // 会拼进 assistant 历史并发回上游 → 模型复述成对话流里的 [调用工具 xxx]）
  assert.equal(assistant.content, '我来查')
  assert.ok(!JSON.stringify(body).includes('调用工具'), '载荷不得含 [调用工具] 占位文本')
})

test('assistant 纯 tool-call 块 → content=null + tool_calls（无占位文本）', () => {
  const body = buildRequestBody({ ...base, messages: [
    { role: 'user', content: '查' },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'f', arguments: '{}' }] },
  ] })
  const assistant = body.messages[1]
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.content, null)
  assert.equal(assistant.tool_calls.length, 1)
  assert.ok(!JSON.stringify(body).includes('调用工具'), '载荷不得含 [调用工具] 占位文本')
})

test('assistant reasoning + tool-call → content=null（reasoning 与 tool-call 都不进文本）', () => {
  const body = buildRequestBody({ ...base, messages: [
    { role: 'assistant', content: [
      { type: 'reasoning', text: '思考中' },
      { type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' },
    ] },
  ] })
  const assistant = body.messages[0]
  assert.equal(assistant.role, 'assistant')
  assert.equal(assistant.content, null)
  assert.ok(!JSON.stringify(body).includes('调用工具'))
})

test('user 消息里的 tool-call 块不产生占位文本', () => {
  const body = buildRequestBody({ ...base, messages: [
    { role: 'user', content: [
      { type: 'text', text: '接着做' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' },
    ] },
  ] })
  assert.equal(body.messages[0].content, '接着做')
  assert.ok(!JSON.stringify(body).includes('调用工具'))
})

test('role:tool 消息 → role:tool + tool_call_id 配对（不降级成 user）', () => {
  const body = buildRequestBody({ ...base, messages: [
    { role: 'user', content: '查' },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_a', name: 'read_file', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call_a', content: [{ type: 'text', text: 'FILE A CONTENT' }] },
  ] })
  const tool = body.messages.find((m) => m.role === 'tool')
  assert.equal(tool.tool_call_id, 'call_a')
  assert.equal(tool.content, 'FILE A CONTENT')
  assert.equal(body.messages.filter((m) => m.role === 'user').length, 1, 'tool 消息不得降级为 user')
})

test('role:tool 空 content → 占位文本（不丢配对）', () => {
  const body = buildRequestBody({ ...base, messages: [
    { role: 'tool', toolCallId: 'call_b', content: [] },
  ] })
  const tool = body.messages[0]
  assert.equal(tool.role, 'tool')
  assert.equal(tool.tool_call_id, 'call_b')
  assert.equal(tool.content, '(no tool output)')
})

test('user 里的 tool-result → role:tool 消息（带 tool_call_id）', () => {
  const body = buildRequestBody({ ...base, messages: [
    { role: 'user', content: '查' },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'f', arguments: '{}' }] },
    { role: 'user', content: [
      { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '晴' }] },
      { type: 'text', text: '总结一下' },
    ] },
  ] })
  const tool = body.messages.find((m) => m.role === 'tool')
  assert.equal(tool.tool_call_id, 'call_1')
  assert.equal(tool.content, '晴')
  assert.equal(body.messages.at(-1).content, '总结一下')
})

test('图片：纯文本模型用占位文本', () => {
  const imageBlock = { type: 'image', attachment: {} }
  const imageText = new Map()
  imageText.set(imageBlock, '[图片 #1（当前模型不支持图像输入）]')
  const body = buildRequestBody({ ...base, messages: [{ role: 'user', content: [
    { type: 'text', text: '看图' },
    imageBlock,
  ] }] }, { imageText })
  assert.equal(body.messages[0].content, '看图\n[图片 #1（当前模型不支持图像输入）]')
})

test('图片：视觉模型以 image_url 数组追加到最后一条 user 消息', () => {
  const imageBlock = { type: 'image', attachment: {} }
  const imageText = new Map()
  imageText.set(imageBlock, '[图片 #1]')
  const body = buildRequestBody({ ...base, messages: [
    { role: 'user', content: '前一轮' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: [
      { type: 'text', text: '看图' },
      imageBlock,
    ] },
  ] }, { imageText, imageUrls: ['data:image/png;base64,AAA'] })
  const last = body.messages.at(-1)
  assert.equal(last.role, 'user')
  assert.deepEqual(last.content, [
    { type: 'text', text: '看图\n[图片 #1]' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
  ])
})

test('tools / temperature / maxTokens / stop 映射', () => {
  const body = buildRequestBody({
    ...base,
    tools: [{ name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }],
    temperature: 0.2,
    maxTokens: 512,
    stop: ['END'],
    messages: [{ role: 'user', content: 'x' }],
  })
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tools[0].function.name, 'f')
  assert.equal(body.temperature, 0.2)
  assert.equal(body.max_tokens, 512)
  assert.deepEqual(body.stop, ['END'])
  assert.equal(body.stream, true)
  assert.equal(body.stream_options.include_usage, true)
})

test('reasoning 块不进载荷', () => {
  const body = buildRequestBody({ ...base, messages: [
    { role: 'assistant', content: [
      { type: 'reasoning', text: '思考中' },
      { type: 'text', text: '答案' },
    ] },
  ] })
  assert.equal(body.messages[0].content, '答案')
})
