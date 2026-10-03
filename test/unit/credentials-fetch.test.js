import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'

import { ensureAccountKey, refetchAfterKeyDead, resolveUsableJwt, _resetRefetchStateForTests } from '../../lib/credentials.js'

// 一次性 RSA JWK（login 内部拉 JWKS）
const { publicKeyJwk } = (() => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { publicKeyJwk: publicKey.export({ format: 'jwk' }) }
})()

/** 可控 exp 的 JWT 形状（resolveUsableJwt 只解析 payload.exp）。 */
const makeJwt = (expSeconds) => `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.s`
const FUTURE_JWT = makeJwt(Math.floor(Date.now() / 1000) + 3600)
const PAST_JWT = makeJwt(Math.floor(Date.now() / 1000) - 3600)

/** 假 credentials 服务（记录 set 调用）。 */
function fakeCredentials(store) {
  return {
    async resolve(ref) { return store[ref] ? { value: store[ref] } : undefined },
    writes: [],
    async set(ref, value) { store[ref] = value; this.writes.push([ref, value]) },
  }
}

const okAccount = (over = {}) => ({ label: 'ACC1', username: 'u', password: 'p', key: '', enabled: true, ...over })

/**
 * 脚本化假 fetch：处理 JWKS，其余按 url 片段匹配 scripts 的响应描述
 * { match, status?, location?, json?, body?, setCookie? }。
 */
function scriptedFetch(scripts) {
  return async (url, init = {}) => {
    const u = String(url)
    if (u.startsWith('https://signin.sensecore.cn/.well-known/jwks.json')) {
      return { status: 200, ok: true, headers: { get: () => null, getSetCookie: () => [] }, json: async () => ({ keys: [{ kid: 'public:hydra.openid.id-token', ...publicKeyJwk }] }) }
    }
    for (const s of scripts) {
      if (u.includes(s.match)) {
        const status = s.status ?? (s.json !== undefined || s.body !== undefined ? 200 : 302)
        return {
          status,
          ok: status >= 200 && status < 300,
          headers: { get: (n) => (n === 'location' ? s.location : null) ?? null, getSetCookie: () => s.setCookie ?? [] },
          text: async () => s.body ?? '',
          json: async () => s.json ?? JSON.parse(s.body ?? '{}'),
        }
      }
    }
    throw new Error(`unexpected: ${u}`)
  }
}

const HAPPY_SCRIPTS = [
  { match: '/iam/idp/v1/apiKeys', json: { api_keys: [{ id: '1', status: 'enabled', api_key: 'sk-fresh', type: 'nova.tokenplan.v1' }] } },
  { match: 'oauth2/token', json: { access_token: FUTURE_JWT } },
  { match: '/callback', location: 'https://platform.sensenova.cn/?code=C1' },
  { match: 'nova/login', json: { redirect: 'https://platform.sensenova.cn/callback' } },
  { match: 'login_challenge=LC', body: '<html>login</html>' },
  { match: '/oauth2/auth', location: 'https://platform.sensenova.cn/login?login_challenge=LC' },
]

test('ensureAccountKey：已有 key 直接返回，不登录', async () => {
  _resetRefetchStateForTests()
  let logins = 0
  const hooks = { fetchImpl: async () => { logins += 1; throw new Error('should not') } }
  const result = await ensureAccountKey(okAccount({ key: 'sk-have' }), hooks)
  assert.equal(result.key, 'sk-have')
  assert.equal(result.refreshed, false)
  assert.equal(logins, 0)
})

test('ensureAccountKey：无 key → 登录抓取，key 写回凭据中心、JWT 只进内存', async () => {
  _resetRefetchStateForTests()
  const store = {}
  const credentials = fakeCredentials(store)
  const hooks = { credentials, fetchImpl: scriptedFetch(HAPPY_SCRIPTS) }
  const result = await ensureAccountKey(okAccount(), hooks)
  assert.equal(result.key, 'sk-fresh')
  assert.equal(result.refreshed, true)
  assert.equal(store.SENSENOVA_ACC1_KEY, 'sk-fresh')
  assert.equal(store.SENSENOVA_ACC1_JWT, undefined, 'JWT 不再落凭据中心')
  assert.equal(credentials.writes.length, 1)
  // JWT 在进程内存缓存中可直接取用（有效期校验通过）
  assert.equal(resolveUsableJwt('ACC1'), FUTURE_JWT)
})

test('ensureAccountKey：限频——10 分钟内第二次直接报错，超时后放行', async () => {
  _resetRefetchStateForTests()
  let now = Date.now()
  // 网络失败脚本（oauth2/auth 5xx）→ 登录尝试失败并记录时间
  const failing = [{ match: '/oauth2/auth', status: 503, body: 'unavailable' }]
  const acc = okAccount()
  await assert.rejects(() => ensureAccountKey(acc, { now: () => now, fetchImpl: scriptedFetch(failing) }), /登录|503|中断/)
  await assert.rejects(() => ensureAccountKey(acc, { now: () => now, fetchImpl: scriptedFetch(failing) }), /限频/)
  now += 11 * 60_000
  await assert.rejects(() => ensureAccountKey(acc, { now: () => now, fetchImpl: scriptedFetch(failing) }), (e) => !/限频/.test(e.message))
})

test('ensureAccountKey：并发去重——同账号同时只跑一次登录链', async () => {
  _resetRefetchStateForTests()
  let entryHits = 0
  let release
  const gate = new Promise((r) => { release = r })
  const scripts = [
    { match: '/iam/idp/v1/apiKeys', json: { api_keys: [{ id: '1', status: 'enabled', api_key: 'sk-x', type: '' }] } },
    { match: 'oauth2/token', json: { access_token: 'J1' } },
    { match: '/callback', location: 'https://platform.sensenova.cn/?code=C1' },
    { match: 'nova/login', json: { redirect: 'https://platform.sensenova.cn/callback' } },
    { match: 'login_challenge=LC', body: '<html>login</html>' },
  ]
  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.startsWith('https://signin.sensecore.cn/.well-known/jwks.json')) {
      return { status: 200, ok: true, headers: { get: () => null, getSetCookie: () => [] }, json: async () => ({ keys: [{ kid: 'public:hydra.openid.id-token', ...publicKeyJwk }] }) }
    }
    if (u.startsWith('https://platform.sensenova.cn/oauth2/auth')) {
      entryHits += 1
      await gate // 挂住第一个请求，第二个并发调用应复用 inflight 而不是再发一次
      return { status: 302, ok: false, headers: { get: () => 'https://platform.sensenova.cn/login?login_challenge=LC', getSetCookie: () => [] } }
    }
    for (const s of scripts) {
      if (u.includes(s.match)) {
        return { status: s.json !== undefined ? 200 : 302, ok: true, headers: { get: () => s.location ?? null, getSetCookie: () => [] }, json: async () => s.json, text: async () => s.body ?? '' }
      }
    }
    throw new Error(`unexpected: ${u}`)
  }
  const hooks = { fetchImpl }
  const p1 = ensureAccountKey(okAccount(), hooks)
  const p2 = ensureAccountKey(okAccount(), hooks)
  release()
  const [a, b] = await Promise.all([p1, p2])
  assert.equal(a.key, 'sk-x')
  assert.equal(b.key, 'sk-x')
  assert.equal(entryHits, 1, 'OAuth2 入口只应命中一次（并发去重）')
})

test('refetchAfterKeyDead：忽略现有 key，走重抓并写回', async () => {
  _resetRefetchStateForTests()
  const store = {}
  const hooks = { credentials: fakeCredentials(store), fetchImpl: scriptedFetch(HAPPY_SCRIPTS) }
  const result = await refetchAfterKeyDead(okAccount({ key: 'sk-dead' }), hooks)
  assert.equal(result.key, 'sk-fresh')
  assert.equal(result.refreshed, true)
  assert.equal(store.SENSENOVA_ACC1_KEY, 'sk-fresh')
})

test('resolveUsableJwt：内存 JWT 过期（含 5 分钟提前量）→ undefined，需重登', async () => {
  _resetRefetchStateForTests()
  const scripts = HAPPY_SCRIPTS.map((s) => (s.match === 'oauth2/token' ? { ...s, json: { access_token: PAST_JWT } } : s))
  const hooks = { credentials: fakeCredentials({}), fetchImpl: scriptedFetch(scripts) }
  await ensureAccountKey(okAccount(), hooks)
  assert.equal(resolveUsableJwt('ACC1'), undefined, '过期 JWT 不可用，调用方按需重登')
})
