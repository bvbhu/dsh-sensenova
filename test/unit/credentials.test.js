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

test('三轨优先级：credentials > settings > env', async () => {
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
    [{ label: 'acc1', username: 'set-user', password: 'set-pass', key: 'sk-set' }],
    credentials,
    { SENSENOVA_KEY_ACC1: 'sk-env' },
  )
  const acc = accounts[0]
  assert.equal(acc.username, 'cred-user')
  assert.equal(acc.password, 'cred-pass')
  assert.equal(acc.key, 'sk-cred')
  assert.equal(acc.keySource, 'credentials')
  assert.equal(acc.credSource, 'credentials')
})

test('credentials 缺项时回退 settings / env', async () => {
  const credentials = { async resolve() { return undefined } }
  const accounts = await resolveAccounts(
    [{ label: 'ACC2', username: '', key: '' }],
    credentials,
    { SENSENOVA_KEY_ACC2: 'sk-env', SENSENOVA_ACC2_USERNAME: 'env-user' },
  )
  const acc = accounts[0]
  assert.equal(acc.key, 'sk-env')
  assert.equal(acc.keySource, 'env')
  assert.equal(acc.username, 'env-user')
})

test('无 credentials 服务：纯 settings + env', async () => {
  const accounts = await resolveAccounts(
    [{ label: 'ACC3', username: 'u', password: 'p', key: 'sk-3' }],
    undefined,
    {},
  )
  assert.deepEqual(accounts, [{
    label: 'ACC3', username: 'u', password: 'p', key: 'sk-3',
    enabled: true, keySource: 'settings', credSource: 'settings',
  }])
})

test('重复 label 去重', async () => {
  const accounts = await resolveAccounts(
    [{ label: 'ACC1', key: 'sk-a' }, { label: 'acc1', key: 'sk-b' }],
    undefined, {},
  )
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].key, 'sk-a')
})
