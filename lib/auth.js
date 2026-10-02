/**
 * SenseNova 控制台登录：账号密码 → OAuth2 授权码 + PKCE → JWT（3h）。
 *
 * 流程移植自 sensenova-usage-dashboard/auth_login.py（Python，已长期稳定运行），
 * 密码用平台 JWKS 公钥（kid=public:hydra.openid.id-token）做 RSA-OAEP + A256GCM
 * 的 JWE 加密（与网页端一致）。关键坑位（实测）：
 *   - 授权端点必须用 platform.sensenova.cn 发起：CSRF cookie
 *     （oauth2_authentication_csrf）的域随入口域名走，用 signin.sensecore.cn
 *     发起会在 nova/login 回调兑换时报 "No CSRF value available in the session cookie"。
 *   - 登录回调可能经多跳重定向（302 Location 或 200 响应体里的 meta refresh /
 *     JS 跳转），逐跳手动跟随并携带 cookie。
 *
 * 按需登录策略（DESIGN.md §7.4）：本模块不做任何定时器；login() 只在
 * key 缺失/失效、或状态页显式刷新时被调用。fetch 可注入（测试）。
 *
 * @module lib/auth.js
 */

import { CompactEncrypt, importJWK } from 'jose'
import { createHash, randomBytes } from 'node:crypto'

const IAM_BASE = 'https://iam.sensecoreapi.cn'
const OIDC_AUTH = 'https://platform.sensenova.cn/oauth2/auth'
const OIDC_TOKEN = 'https://signin.sensecore.cn/oauth2/token'
const JWKS_URL = 'https://signin.sensecore.cn/.well-known/jwks.json'
const CLIENT_ID = 'nova'
const REDIRECT_URI = 'https://platform.sensenova.cn'
const SCOPE = 'openid offline offline_access'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

/** JWKS 公钥缓存（1h）——避免每次登录都拉一遍。 */
const pubkeyCache = { key: undefined, at: 0 }
const PUBKEY_TTL_MS = 3600_000

/** PKCE S256：verifier + challenge（照 auth_login.py）。 */
export function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 极简 cookie jar：合并 Set-Cookie，逐跳回传（credentials 同域）。 */
export class CookieJar {
  constructor() {
    /** @type {Map<string, string>} name → full pair */
    this.cookies = new Map()
  }
  absorb(response) {
    const set = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : []
    for (const line of set) {
      const pair = line.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair)
    }
  }
  header() {
    return [...this.cookies.values()].join('; ')
  }
}

/** 带共享 cookie jar 的 fetch（redirect 手动，逐跳回传 cookie）。 */
async function jarFetch(jar, url, init = {}, fetchImpl = fetch) {
  const headers = { 'User-Agent': UA, Accept: '*/*', ...(init.headers ?? {}) }
  const cookie = jar.header()
  if (cookie) headers.Cookie = cookie
  const response = await fetchImpl(url, { ...init, headers, redirect: 'manual' })
  jar.absorb(response)
  return response
}

async function fetchPubKey(fetchImpl) {
  if (pubkeyCache.key && Date.now() - pubkeyCache.at < PUBKEY_TTL_MS) return pubkeyCache.key
  const response = await fetchImpl(JWKS_URL, { headers: { 'User-Agent': UA } })
  if (!response.ok) throw new Error(`JWKS 拉取失败 HTTP ${response.status}`)
  const jwks = await response.json()
  const jwk = jwks.keys?.find((k) => k.kid === 'public:hydra.openid.id-token')
  if (!jwk) throw new Error('JWKS 中没有 public:hydra.openid.id-token')
  const key = await importJWK({ kty: 'RSA', n: jwk.n, e: jwk.e }, 'RSA-OAEP')
  pubkeyCache.key = key
  pubkeyCache.at = Date.now()
  return key
}

/** 密码 JWE（RSA-OAEP + A256GCM，紧凑五段）。 */
export async function encryptPassword(password, pubKey) {
  return new CompactEncrypt(new TextEncoder().encode(password))
    .setProtectedHeader({ alg: 'RSA-OAEP', enc: 'A256GCM' })
    .encrypt(pubKey)
}

/** 从 200 响应体里找下一跳（meta refresh / JS location / 裸 code= URL）。 */
function nextFromHtml(html) {
  if (!html) return undefined
  const codeUrl = html.match(/(https?:\/\/[^"'\s<>]+[?&]code=[^&"'\s<>]+)/)?.[1]
  if (codeUrl) return codeUrl
  const meta = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=["']([^"']+)/i)?.[1]
  if (meta) return meta.replace(/&amp;/g, '&')
  for (const pattern of [
    /window\.location\.replace\(["']([^"']+)["']\)/,
    /window\.location\.href\s*=\s*["']([^"']+)["']/,
    /location\.href\s*=\s*["']([^"']+)["']/,
    /window\.location\s*=\s*["']([^"']+)["']/,
  ]) {
    const js = html.match(pattern)?.[1]
    if (js) return js.replace(/&amp;/g, '&')
  }
  return undefined
}

/**
 * 手动跟随重定向直到 predicate(location) 成立（照 auth_login.py 的
 * _follow_until，含 200 响应体跳转解析；上限 maxHops）。
 * @returns {Promise<string>} 命中的 location
 */
async function followUntil(jar, startLocation, predicate, fetchImpl, maxHops = 8) {
  let loc = startLocation
  for (let hop = 0; hop < maxHops && loc; hop += 1) {
    if (predicate(loc)) return loc
    const response = await jarFetch(jar, loc, {}, fetchImpl)
    const location = response.headers.get('location')
    if (location) {
      loc = new URL(location, loc).toString()
      continue
    }
    if (response.status === 200 || response.status === 201) {
      loc = nextFromHtml(await response.text())
      continue
    }
    break
  }
  if (loc && predicate(loc)) return loc
  throw new Error('登录回调链中断：未取到 authorization code')
}

/**
 * 完整登录。返回 {access_token, refresh_token, expires_in}。
 * @param {object} args
 * @param {string} args.username 用户名/邮箱
 * @param {string} args.password 明文密码（仅在本函数内加密传输）
 * @param {typeof fetch} [args.fetchImpl] 测试注入
 */
export async function login({ username, password, fetchImpl = fetch }) {
  if (!username || !password) throw new Error('登录需要 username 与 password')
  const jar = new CookieJar()

  // 1) 授权入口（platform.sensenova.cn 域发起，PKCE）→ 跟随到 login_challenge
  const { verifier, challenge } = pkce()
  const state = randomBytes(16).toString('base64url')
  const authUrl = new URL(OIDC_AUTH)
  authUrl.searchParams.set('client_id', CLIENT_ID)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', SCOPE)
  authUrl.searchParams.set('state', state)

  const first = await jarFetch(jar, authUrl, {}, fetchImpl)
  const firstLoc = first.headers.get('location')
  if (!firstLoc) throw new Error(`OAuth2 入口未重定向（HTTP ${first.status}）`)
  const challengeLoc = await followUntil(
    jar, new URL(firstLoc, authUrl).toString(),
    (u) => u.includes('login_challenge='), fetchImpl,
  )
  const loginChallenge = new URL(challengeLoc).searchParams.get('login_challenge')
  if (!loginChallenge) throw new Error('未能解析 login_challenge')

  // 2) JWE 加密密码 → nova/login
  const pubKey = await fetchPubKey(fetchImpl)
  const encrypted = await encryptPassword(password, pubKey)
  const loginResponse = await jarFetch(jar, `${IAM_BASE}/iam/authn/v1/auth/nova/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://platform.sensenova.cn',
      Referer: 'https://platform.sensenova.cn/',
    },
    body: JSON.stringify({ username, password: encrypted, challenge: loginChallenge, is_encrypt: true }),
  }, fetchImpl)
  const loginBody = await loginResponse.json().catch(async () => {
    throw new Error(`nova/login 返回异常（HTTP ${loginResponse.status}）`)
  })
  const redirect = loginBody.redirect
  if (!redirect) {
    throw new Error(`登录失败：${loginBody.message ?? loginBody.error ?? JSON.stringify(loginBody).slice(0, 160)}`)
  }

  // 3) 跟随回调 → authorization code
  const codeLoc = await followUntil(jar, redirect, (u) => /[?&]code=/.test(u), fetchImpl)
  const code = new URL(codeLoc).searchParams.get('code')
  if (!code) throw new Error('未能从回调地址解析 code')

  // 4) code + PKCE verifier 换 token
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
  })
  const tokenResponse = await fetchImpl(OIDC_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: form.toString(),
  })
  const token = await tokenResponse.json().catch(async () => {
    throw new Error(`token 接口返回异常（HTTP ${tokenResponse.status}）`)
  })
  if (!token.access_token) {
    throw new Error(`未返回 access_token：${token.error_description ?? token.error ?? '未知'}`)
  }
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? '',
    expires_in: Number(token.expires_in ?? 10800),
  }
}

/**
 * 用 JWT 枚举账号 API key（iam/idp/v1/apiKeys，明文 sk- 值）。
 * 过滤 status=enabled，优先 type='nova.tokenplan.v1'，取第一个。
 * @returns {Promise<{key: string, total: number}>}
 */
export async function fetchApiKey({ jwt, fetchImpl = fetch, baseUrl = 'https://iam.sensecoreapi.cn' }) {
  const response = await fetchImpl(`${baseUrl}/iam/idp/v1/apiKeys?page_size=100`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/json',
      Referer: 'https://platform.sensenova.cn/console',
      'User-Agent': UA,
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`apiKeys 拉取失败 HTTP ${response.status}：${text.slice(0, 120)}`)
  }
  const data = await response.json()
  const all = data.api_keys ?? []
  const enabled = all.filter((k) => k.status === 'enabled' && k.api_key)
  const tokenPlan = enabled.find((k) => k.type === 'nova.tokenplan.v1')
  const picked = tokenPlan ?? enabled[0]
  if (!picked) throw new Error('账号下没有可用的 API key（enabled 且有明文值）')
  return { key: picked.api_key, total: all.length }
}
