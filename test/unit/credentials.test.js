import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveAccounts, refNames, accountLabelToRef } from '../../lib/credentials.js'

test('ref 命名：ACC1 → SENSENOVA_ACC1_KEY（仅 key；用户名/密码内嵌 SENSENOVA_ACCOUNTS）', () => {
  assert.deepEqual(refNames('ACC1'), { key: 'SENSENOVA_ACC1_KEY' })
})

test('label 规范化：小写/非法字符', () => {
  assert.equal(accountLabelToRef('acc1'), 'ACC1')
  assert.throws(() => accountLabelToRef('  '), Error)
  assert.equal(accountLabelToRef('my-acc 2'), 'MYACC2')
})

test('key 两轨优先级：credentials > env；用户名/密码只来自注册表条目', async () => {
  const credentials = {
    async resolve(ref) {
      const store = { SENSENOVA_ACC1_KEY: 'sk-cred' }
      return store[ref] ? { value: store[ref] } : undefined
    },
  }
  const accounts = await resolveAccounts(
    [{ label: 'acc1', enabled: true, username: ' reg-user ', password: 'reg-pass' }],
    credentials,
    { SENSENOVA_KEY_ACC1: 'sk-env' },
  )
  const acc = accounts[0]
  assert.equal(acc.username, 'reg-user')
  assert.equal(acc.password, 'reg-pass')
  assert.equal(acc.key, 'sk-cred')
  assert.equal(acc.keySource, 'credentials')
  assert.equal(acc.credSource, 'registry')
})

test('注册表条目缺密码：credSource none，key 回退 env', async () => {
  const credentials = { async resolve() { return undefined } }
  const accounts = await resolveAccounts(
    [{ label: 'ACC2', enabled: true, username: 'u2' }],
    credentials,
    { SENSENOVA_KEY_ACC2: 'sk-env' },
  )
  const acc = accounts[0]
  assert.equal(acc.key, 'sk-env')
  assert.equal(acc.keySource, 'env')
  assert.equal(acc.username, 'u2')
  assert.equal(acc.password, '')
  assert.equal(acc.credSource, 'none')
})

test('无 credentials 服务：注册表内嵌凭据照常解析（key 为 none）', async () => {
  const accounts = await resolveAccounts(
    [{ label: 'ACC3', enabled: false, username: 'u', password: 'p' }],
    undefined,
    {},
  )
  assert.deepEqual(accounts, [{
    label: 'ACC3', username: 'u', password: 'p', key: '',
    enabled: false, keySource: 'none', credSource: 'registry',
  }])
})

test('无任何凭据：key/username 为空，来源为 none', async () => {
  const accounts = await resolveAccounts([{ label: 'ACC4' }], undefined, {})
  assert.deepEqual(accounts, [{
    label: 'ACC4', username: '', password: '', key: '',
    enabled: true, keySource: 'none', credSource: 'none',
  }])
})

test('重复 label 去重', async () => {
  const accounts = await resolveAccounts(
    [{ label: 'ACC1' }, { label: 'acc1' }],
    undefined,
    { SENSENOVA_KEY_ACC1: 'sk-a' },
  )
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].key, 'sk-a')
})

test('空骨架返回空数组', async () => {
  assert.deepEqual(await resolveAccounts([], undefined, {}), [])
  assert.deepEqual(await resolveAccounts(undefined, undefined, {}), [])
})
