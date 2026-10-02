import { test } from 'node:test'
import assert from 'node:assert/strict'

import { generateKeyPairSync } from 'node:crypto'
import { pkce, encryptPassword, CookieJar, login, fetchApiKey } from '../../lib/auth.js'

// 一次性 RSA 密钥：JWE 加密与 fake JWKS 共用
const { publicKey, publicKeyJwk } = (() => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { publicKey, publicKeyJwk: publicKey.export({ format: 'jwk' }) }
})()

/** 给假 fetch 注入 JWKS 分支（login 内部会拉平台 JWKS）。 */
function withJwks(handler) {
  return async (url, init) => {
    const u = String(url)
    if (u.startsWith('https://signin.sensecore.cn/.well-known/jwks.json')) {
      return fakeResponse({ json: { keys: [{ kid: 'public:hydra.openid.id-token', ...publicKeyJwk }] } })
    }
    return handler(url, init)
  }
}

function fakeResponse({ status = 200, location, setCookie = [], body = '', json } = {}) {
  const headers = new Map()
  if (location) headers.set('location', location)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => headers.get(name.toLowerCase()) ?? null,
      getSetCookie: () => setCookie,
    },
    async text() { return body },
    async json() { return json !== undefined ? json : JSON.parse(body) },
  }
}

test('PKCE：verifier/challenge 形态且每次不同', () => {
  const a = pkce()
  const b = pkce()
  assert.ok(a.verifier.length >= 43)
  assert.notEqual(a.verifier, b.verifier)
  assert.notEqual(a.challenge, b.challenge)
})

test('encryptPassword：紧凑五段 JWE，头部声明 RSA-OAEP + A256GCM', async () => {
  const jwe = await encryptPassword('secret-pass', publicKey)
  const segments = jwe.split('.')
  assert.equal(segments.length, 5)
  const header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'))
  assert.equal(header.alg, 'RSA-OAEP')
  assert.equal(header.enc, 'A256GCM')
})

test('CookieJar：吸收 Set-Cookie 并回传', () => {
  const jar = new CookieJar()
  jar.absorb({ headers: { getSetCookie: () => ['a=1; Path=/', 'b=2; HttpOnly'] } })
  assert.equal(jar.header(), 'a=1; b=2')
  jar.absorb({ headers: { getSetCookie: () => ['a=9; Path=/'] } })
  assert.equal(jar.header(), 'a=9; b=2')
})

test('login：全链路（脚本化 fake fetch，cookie 逐跳回传）', async () => {
  const calls = []
  const fake = withJwks(async (url, init = {}) => {
    const u = String(url)
    calls.push(u.split('?')[0])
    if (u.startsWith('https://platform.sensenova.cn/oauth2/auth')) {
      return fakeResponse({ status: 302, location: 'https://platform.sensenova.cn/oauth2/intermediate?client_id=nova', setCookie: ['oauth2_authentication_csrf=CSRFTOKEN; Path=/'] })
    }
    if (u.includes('/oauth2/intermediate')) {
      assert.equal(init.headers.Cookie, 'oauth2_authentication_csrf=CSRFTOKEN', 'cookie 应逐跳回传')
      return fakeResponse({ status: 302, location: 'https://platform.sensenova.cn/login?login_challenge=LC123' })
    }
    if (u.includes('/login?login_challenge=LC123')) return fakeResponse({ status: 200, body: '<html>login page</html>' })
    if (u.includes('/iam/authn/v1/auth/nova/login')) {
      const payload = JSON.parse(init.body)
      assert.equal(payload.is_encrypt, true)
      assert.match(payload.password, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./, '密码应为 JWE 紧凑串')
      return fakeResponse({ json: { redirect: 'https://platform.sensenova.cn/callback?ticket=x' } })
    }
    if (u.includes('/callback?ticket=x')) {
      return fakeResponse({ status: 302, location: 'https://platform.sensenova.cn/?code=AUTHCODE&state=s' })
    }
    if (u.startsWith('https://signin.sensecore.cn/oauth2/token')) {
      const form = new URLSearchParams(init.body)
      assert.equal(form.get('code'), 'AUTHCODE')
      assert.ok(form.get('code_verifier'))
      return fakeResponse({ json: { access_token: 'JWT123', refresh_token: 'R1', expires_in: 10800 } })
    }
    throw new Error(`unexpected fetch: ${u}`)
  })
  const token = await login({ username: 'u', password: 'p', fetchImpl: fake })
  assert.equal(token.access_token, 'JWT123')
  assert.equal(token.expires_in, 10800)
  assert.ok(calls.some((c) => c.includes('/oauth2/auth')))
})

test('login：200 响应体里的 JS 跳转也能跟随', async () => {
  const fake = withJwks(async (url) => {
    const u = String(url)
    if (u.startsWith('https://platform.sensenova.cn/oauth2/auth')) {
      return fakeResponse({ status: 302, location: 'https://platform.sensenova.cn/login?login_challenge=LC9' })
    }
    if (u.includes('/login?login_challenge=LC9')) return fakeResponse({ status: 200, body: '<html>ok</html>' })
    if (u.includes('nova/login')) return fakeResponse({ json: { redirect: 'https://platform.sensenova.cn/step' } })
    if (u.includes('/step')) {
      return fakeResponse({ status: 200, body: '<script>window.location.replace("https://platform.sensenova.cn/done?code=JS2&x=1")</script>' })
    }
    if (u.startsWith('https://signin.sensecore.cn/oauth2/token')) return fakeResponse({ json: { access_token: 'T2' } })
    throw new Error(`unexpected: ${u}`)
  })
  const token = await login({ username: 'u', password: 'p', fetchImpl: fake })
  assert.equal(token.access_token, 'T2')
})

test('fetchApiKey：tokenplan 类型优先，取第一个 enabled', async () => {
  const fake = async () => fakeResponse({ json: { api_keys: [
    { id: '1', status: 'disabled', api_key: 'sk-dead', type: 'nova.tokenplan.v1' },
    { id: '2', status: 'enabled', api_key: 'sk-other', type: '' },
    { id: '3', status: 'enabled', api_key: 'sk-tp', type: 'nova.tokenplan.v1' },
    { id: '4', status: 'enabled', api_key: 'sk-tp2', type: 'nova.tokenplan.v1' },
  ], total_size: 4 } })
  const { key, total } = await fetchApiKey({ jwt: 'J', fetchImpl: fake })
  assert.equal(key, 'sk-tp')
  assert.equal(total, 4)
})

test('fetchApiKey：无可用 key 时报错', async () => {
  const fake = async () => fakeResponse({ json: { api_keys: [{ id: '1', status: 'disabled', api_key: 'x' }] } })
  await assert.rejects(() => fetchApiKey({ jwt: 'J', fetchImpl: fake }), /没有可用的 API key/)
})
