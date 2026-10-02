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
