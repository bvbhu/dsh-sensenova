/**
 * enabledModels（启用的模型列表）过滤逻辑单测。
 *
 * @module test/unit/enabled-models.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveOptions } from '../../lib/index.js'

const base = {
  accounts: [],
  models: [
    { id: 'deepseek-v4-flash', contextWindow: 1000000 },
    { id: 'sensenova-6.8-flash-lite', contextWindow: 256000 },
    { id: 'kimi-k3', contextWindow: 256000 },
  ],
}

test('enabledModels 留空 = 全部启用', () => {
  assert.equal(resolveOptions(base).models.length, 3)
  assert.equal(resolveOptions({ ...base, enabledModels: [] }).models.length, 3)
  assert.equal(resolveOptions({ ...base, enabledModels: undefined }).models.length, 3)
})

test('enabledModels 按目录 id 过滤，保持目录顺序', () => {
  const models = resolveOptions({ ...base, enabledModels: ['kimi-k3', 'deepseek-v4-flash'] }).models
  assert.deepEqual(models.map((m) => m.id), ['deepseek-v4-flash', 'kimi-k3'])
})

test('enabledModels 中的未知 id 被忽略；空白项清洗', () => {
  const models = resolveOptions({ ...base, enabledModels: [' deepseek-v4-flash ', 'not-a-model', ''] }).models
  assert.deepEqual(models.map((m) => m.id), ['deepseek-v4-flash'])
})

test('enabledModels 全部未知 = 空模型列表（不回退到全量）', () => {
  assert.deepEqual(resolveOptions({ ...base, enabledModels: ['nope'] }).models, [])
})

test('configCatalog = 配置声明目录（用于判定"手动指定的图像模型"，不被 API 发现结果污染）', () => {
  const opts = resolveOptions(base)
  assert.deepEqual(opts.configCatalog.map((m) => m.id), ['deepseek-v4-flash', 'sensenova-6.8-flash-lite', 'kimi-k3'])
  // configCatalog 与 catalog 同源（都来自 config.models），供 discover 的
  // merge 用「配置显式声明」判定手动指定，避免把 API 标注误判成手动指定
  assert.deepEqual(opts.configCatalog, opts.catalog)
})

test('imageModels：手动指定的图像模型解析为 Set（留空 = 空集）', () => {
  assert.equal(resolveOptions(base).imageModelIds.size, 0)
  assert.equal(resolveOptions({ ...base, imageModels: [] }).imageModelIds.size, 0)
  const opts = resolveOptions({ ...base, imageModels: [' kimi-k3 ', 'kimi-k3', ''] })
  assert.equal(opts.imageModelIds.size, 1, '去重 + 清洗空白项')
  assert.ok(opts.imageModelIds.has('kimi-k3'))
})
