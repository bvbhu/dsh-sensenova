import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveAccounts, refNames, accountLabelToRef } from '../../lib/credentials.js'

test('ref 命名：ACC1 → SENSENOVA_ACC1_*', () => {
  assert.deepEqual(refNames('ACC1'), {
    username: 'SENSENOVA_ACC1_USERNAME',
    password: 'SENSENOVA_ACC1_PASSWORD',
    key: 'SENSENOVA_ACC1_KEY',
    jwt: 'SENSENOVA_ACC1_JWT',
  })
})

test('label 规范化：小写/非法字符', () => {
  assert.equal(accountLabelToRef('acc1'), 'ACC1')
  assert.throws(() => accountLabelToRef('  '), Error)
  assert.equal(accountLabelToRef('my-acc 2'), 'MYACC2')
})

test('两轨优先级：credentials > env', async () => {
  const credentials = {
    async resolve(ref) {
      const store = {
        SENSENOVA_ACC1_USERNAME: 'cred-user',
        SENSENOVA_ACC1_PASSWORD: 'cred-pass',
        SENSENOVA_ACC1_KEY: 'sk-cred',
      }
      return store[ref] ? { value: store[ref] } : undefined
    },
  }
  const accounts = await resolveAccounts(
    [{ label: 'acc1', enabled: true }],
    credentials,
    { SENSENOVA_KEY_ACC1: 'sk-env', SENSENOVA_ACC1_USERNAME: 'env-user' },
  )
  const acc = accounts[0]
  assert.equal(acc.username, 'cred-user')
  assert.equal(acc.password, 'cred-pass')
  assert.equal(acc.key, 'sk-cred')
  assert.equal(acc.keySource, 'credentials')
  assert.equal(acc.credSource, 'credentials')
})

test('credentials 缺项时回退 env', async () => {
  const credentials = { async resolve() { return undefined } }
  const accounts = await resolveAccounts(
    [{ label: 'ACC2', enabled: true }],
    credentials,
    { SENSENOVA_KEY_ACC2: 'sk-env', SENSENOVA_ACC2_USERNAME: 'env-user' },
  )
  const acc = accounts[0]
  assert.equal(acc.key, 'sk-env')
  assert.equal(acc.keySource, 'env')
  assert.equal(acc.username, 'env-user')
  assert.equal(acc.credSource, 'env')
})

test('无 credentials 服务：纯 env（缺失项为 none）', async () => {
  const accounts = await resolveAccounts(
    [{ label: 'ACC3', enabled: false }],
    undefined,
    { SENSENOVA_KEY_ACC3: 'sk-3', SENSENOVA_ACC3_USERNAME: 'u', SENSENOVA_ACC3_PASSWORD: 'p' },
  )
  assert.deepEqual(accounts, [{
    label: 'ACC3', username: 'u', password: 'p', key: 'sk-3',
    enabled: false, keySource: 'env', credSource: 'env',
  }])
})

test('无任何凭据来源：key/username 为空，来源为 none', async () => {
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
