import { test } from 'node:test'
import assert from 'node:assert/strict'

import { discoverModels, FALLBACK_CONTEXT_WINDOW, FALLBACK_MAX_TOKENS } from '../../lib/models.js'

test('discoverModels：字段直接采用 API 返回值（含图像模态）', async () => {
  const fake = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        input_modalities: ['text'],
        output_modalities: ['text'],
        context_length: 1048576,
        max_output_length: 65536,
        description: '主力模型',
      },
      {
        id: 'sensenova-6.8-flash-lite',
        name: 'Flash Lite',
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
        context_length: 262144,
        max_output_length: 65536,
      },
    ] }),
  })
  const models = await discoverModels({ baseUrl: 'https://token.sensenova.cn/v1', key: 'sk-1', fetchImpl: fake })
  assert.equal(models.length, 2)
  const flash = models.find((m) => m.id === 'deepseek-v4-flash')
  assert.equal(flash.contextWindow, 1048576, '上下文直接取 API context_length')
  assert.equal(flash.maxTokens, 65536, '输出上限直接取 API max_output_length')
  assert.deepEqual(flash.inputModalities, ['text'])
  assert.equal(flash.description, '主力模型', 'description 原样带出')
  const lite = models.find((m) => m.id === 'sensenova-6.8-flash-lite')
  assert.deepEqual(lite.inputModalities, ['text', 'image'], '图像模态来自 API input_modalities，不需人工指定')
})

test('discoverModels：非文本输出模型被过滤（u1-fast/u1.5-lite 输出 image）', async () => {
  const fake = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [
      { id: 'deepseek-v4-flash', input_modalities: ['text'], output_modalities: ['text'], context_length: 1048576, max_output_length: 65536 },
      { id: 'sensenova-u1-fast', input_modalities: ['text'], output_modalities: ['image'], context_length: 262144, max_output_length: 65536 },
      { id: 'sensenova-u1.5-lite', input_modalities: ['text'], output_modalities: ['image'], context_length: 262144, max_output_length: 65536 },
      { id: 'sensenova-6.8-flash-lite', input_modalities: ['text', 'image'], output_modalities: ['text'], context_length: 262144, max_output_length: 65536 },
    ] }),
  })
  const models = await discoverModels({ baseUrl: 'https://token.sensenova.cn/v1', key: 'sk-1', fetchImpl: fake })
  assert.deepEqual(models.map((m) => m.id), ['deepseek-v4-flash', 'sensenova-6.8-flash-lite'], '输出不含 text 的模型剔除')
})

test('discoverModels：output_modalities 缺省视为文本输出（保留）', async () => {
  const fake = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [
      { id: 'model-x', input_modalities: ['text'], context_length: 131072, max_output_length: 8192 },
    ] }),
  })
  const models = await discoverModels({ baseUrl: 'https://token.sensenova.cn/v1', key: 'sk-1', fetchImpl: fake })
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'model-x')
})

test('discoverModels：字段缺失/非法时兜底默认值', async () => {
  const fake = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [
      { id: 'bare-model' },
      { id: 'bad-nums', context_length: -1, max_output_length: 'x', input_modalities: ['video'] },
    ] }),
  })
  const models = await discoverModels({ baseUrl: 'https://token.sensenova.cn/v1', key: 'sk-1', fetchImpl: fake })
  const bare = models.find((m) => m.id === 'bare-model')
  assert.equal(bare.contextWindow, FALLBACK_CONTEXT_WINDOW)
  assert.equal(bare.maxTokens, FALLBACK_MAX_TOKENS)
  assert.deepEqual(bare.inputModalities, ['text'], '缺省模态兜底 text')
  const bad = models.find((m) => m.id === 'bad-nums')
  assert.equal(bad.contextWindow, FALLBACK_CONTEXT_WINDOW, '负数 context 兜底')
  assert.equal(bad.maxTokens, FALLBACK_MAX_TOKENS, '非数字 max_output 兜底')
  assert.deepEqual(bad.inputModalities, ['text'], '未知模态过滤后兜底 text')
})

test('discoverModels：无 data 数组抛错', async () => {
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ object: 'list', data: [] }) })
  await assert.rejects(() => discoverModels({ baseUrl: 'https://token.sensenova.cn/v1', key: 'sk-1', fetchImpl: fake }), /没有 data/)
})

test('discoverModels：非 200 抛错', async () => {
  const fake = async () => ({ ok: false, status: 401 })
  await assert.rejects(() => discoverModels({ baseUrl: 'https://token.sensenova.cn/v1', key: 'sk-1', fetchImpl: fake }), /HTTP 401/)
})