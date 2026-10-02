/**
 * 账号注册表（凭据中心）的单测。
 *
 * @module test/unit/accounts-registry.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCOUNTS_REGISTRY_REF,
  loadAccountRegistry,
  saveAccountRegistry,
  refNames,
} from '../../lib/credentials.js'

/** 模拟凭据中心：resolve/set 走同一个 Map（与 dsh-credentials-local 同形接口）。 */
function fakeCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    async resolve(ref) {
      if (!store.has(ref)) return undefined
      return { value: store.get(ref), source: 'credentials' }
    },
    async set(ref, value) { store.set(ref, value) },
  }
}

test('注册表：未挂载凭据中心时 loadAccountRegistry 返回空数组', async () => {
  assert.deepEqual(await loadAccountRegistry(undefined), [])
})

test('注册表：空值/坏 JSON/非数组都安全降级为空数组', async () => {
  for (const stored of [undefined, '', 'not json', '{"a":1}', 'null']) {
    const credentials = fakeCredentials(stored === undefined ? {} : { [ACCOUNTS_REGISTRY_REF]: stored })
    assert.deepEqual(await loadAccountRegistry(credentials), [])
  }
})

test('注册表：roundtrip 保存与读取，坏条目被过滤', async () => {
  const credentials = fakeCredentials()
  const entries = [
    { label: 'ACC2', enabled: true },
    { label: 'ACC3', enabled: false },
    { label: 42 },
    null,
    'oops',
  ]
  await saveAccountRegistry(credentials, entries)
  const loaded = await loadAccountRegistry(credentials)
  assert.deepEqual(loaded, [
    { label: 'ACC2', enabled: true },
    { label: 'ACC3', enabled: false },
  ])
})

test('注册表：saveAccountRegistry 在凭据中心未挂载时抛错', async () => {
  await assert.rejects(() => saveAccountRegistry(undefined, []), /凭据中心未挂载/)
})

test('注册表账号的 username/password 走既有 SENSENOVA_<LABEL>_* refs', async () => {
  const credentials = fakeCredentials({
    SENSENOVA_ACC7_USERNAME: 'user7',
    SENSENOVA_ACC7_PASSWORD: 'pass7',
  })
  const skeleton = [{ label: 'ACC7', enabled: true }]
  const [acc] = await import('../../lib/credentials.js').then((m) => m.resolveAccounts(skeleton, credentials))
  assert.equal(acc.label, 'ACC7')
  assert.equal(acc.username, 'user7')
  assert.equal(acc.password, 'pass7')
  assert.equal(acc.credSource, 'credentials')
  assert.deepEqual(refNames('ACC7'), {
    username: 'SENSENOVA_ACC7_USERNAME',
    password: 'SENSENOVA_ACC7_PASSWORD',
    key: 'SENSENOVA_ACC7_KEY',
    jwt: 'SENSENOVA_ACC7_JWT',
  })
})
