/**
 * 凭据解析。
 *
 *   key       = credentials SENSENOVA_ACC<N>_KEY > env SENSENOVA_KEY_<N>
 *   用户名/密码 = 凭据中心注册表 SENSENOVA_ACCOUNTS（条目内嵌，无独立 refs）
 *
 * 凭据中心只暴露两类 refs：SENSENOVA_ACCOUNTS（账号清单 + 内嵌用户名/密码）
 * 与 SENSENOVA_ACC<N>_KEY（key）。账号清单本身不来自配置文件（已移除
 * config.accounts），由设置页「账号管理」维护（见 ACCOUNTS_REGISTRY_REF）。
 *
 * credentials 服务可能晚于本插件挂载（跨 bundle 顺序）——运行期
 * ctx.get('credentials') 动态获取，不进 inject、不在 apply 时缓存。
 * ref 全部为纯文本值（key 只存第一个，无 JSON 包装）。
 *
 * 自动抓取（DESIGN.md §7.4，按需登录）：key 缺失或失效时才登录
 * （OAuth2+PKCE → JWT → apiKeys 枚举取第一个 enabled），成功后写回
 * SENSENOVA_ACC<N>_KEY；JWT 只进进程内存（jwtCache），不落库——重启即失、
 * 按需重登。重抓限频 ≥10 分钟/账号。
 *
 * @module lib/credentials.js
 */

import { login as senseNovaLogin, fetchApiKey } from './auth.js'
import { fetchPoolUsage } from './usage.js'

/** 重抓限频：同账号两次登录抓取的最小间隔（ms）。 */
const REFETCH_MIN_INTERVAL_MS = 10 * 60_000
/** JWT 视为过期的提前量（5 分钟）。 */
const JWT_EXPIRY_MARGIN_MS = 5 * 60_000

/** 重置进程内限频状态（测试接缝）。 */
export function _resetRefetchStateForTests() {
  refetchState.clear()
}

/** label（如 'ACC1'）→ ref 编号段。仅 [A-Z0-9_]，防 ref 注入。 */
export function accountLabelToRef(label) {
  const normalized = String(label ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '')
  if (normalized === '') throw new Error('dsh-sensenova: 账号 label 不能为空（且仅允许字母/数字/下划线）')
  return normalized
}

export function refNames(label) {
  const seg = accountLabelToRef(label)
  return { key: `SENSENOVA_${seg}_KEY` }
}

// ── 账号注册表（设置页卡片 → 凭据中心）────────────────────────────────────
//
// 账号清单与登录凭据（用户名/密码）都落在这一个 ref：JSON 数组
// [{label, enabled, username, password}]；key 仍按 SENSENOVA_<LABEL>_KEY
// 逐账号落库。不再支持 config.accounts 配置方式。

/** 账号清单注册表的 ref 名（JSON 数组：label/enabled + 内嵌用户名/密码）。 */
export const ACCOUNTS_REGISTRY_REF = 'SENSENOVA_ACCOUNTS'

/** 读账号注册表；凭据中心不可用或内容损坏时返回 []。 */
export async function loadAccountRegistry(credentials) {
  if (!credentials) return []
  try {
    const resolved = await credentials.resolve(ACCOUNTS_REGISTRY_REF)
    const parsed = JSON.parse(resolved?.value ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.label === 'string')
      .map((entry) => ({
        label: entry.label,
        enabled: entry.enabled !== false,
        ...(typeof entry.username === 'string' ? { username: entry.username } : {}),
        ...(typeof entry.password === 'string' ? { password: entry.password } : {}),
      }))
  } catch {
    return []
  }
}

/** 写账号注册表（覆盖式）。凭据中心未挂载时抛错——调用方决定如何提示。 */
export async function saveAccountRegistry(credentials, entries) {
  if (!credentials) throw new Error('dsh-sensenova: 凭据中心未挂载，无法保存账号清单')
  await credentials.set(ACCOUNTS_REGISTRY_REF, JSON.stringify(entries))
}

/**
 * 解析账号清单（骨架=凭据中心注册表条目，内嵌用户名/密码；key 两轨填充）。
 *
 * @param {Array<{label:string,enabled?:boolean,username?:string,password?:string}>} skeleton 注册表条目
 * @param {object} [credentials] ctx.get('credentials')（可 undefined，key 走 env）
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{label:string,username:string,password:string,key:string,enabled:boolean,keySource:string,credSource:string}>}
 */
export async function resolveAccounts(skeleton, credentials, env = process.env) {
  const out = []
  const seen = new Set()
  for (const entry of skeleton ?? []) {
    const label = accountLabelToRef(entry.label)
    if (seen.has(label)) continue
    seen.add(label)
    const refs = refNames(label)

    // 用户名/密码只来自注册表条目（内嵌；没有独立 _USERNAME/_PASSWORD refs）
    const username = String(entry.username ?? '').trim()
    const password = String(entry.password ?? '')

    let key = ''
    let keySource = 'none'
    if (credentials) {
      try {
        const resolved = await credentials.resolve(refs.key)
        if (resolved?.value) { key = resolved.value; keySource = 'credentials' }
      } catch { /* 未配置或服务异常 */ }
    }
    if (!key && env[`SENSENOVA_KEY_${label}`]) { key = env[`SENSENOVA_KEY_${label}`]; keySource = 'env' }

    out.push({
      label,
      username,
      password,
      key: String(key).trim(),
      enabled: entry.enabled !== false,
      keySource,
      credSource: username !== '' && password !== '' ? 'registry' : 'none',
    })
  }
  return out
}

// ── 自动抓取（按需登录）─────────────────────────────────────────────────────

/** 进程内运行态：每账号的重抓限频与并发去重。 */
const refetchState = new Map() // label → { lastAttemptAt, inflight: Promise }
/** 进程内 JWT 缓存：label → jwt。JWT 不落凭据中心（精简暴露 refs），重启即失、按需重登。 */
const jwtCache = new Map()

function jwtExpired(jwt) {
  if (!jwt) return true
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
    return typeof payload.exp !== 'number' || payload.exp * 1000 - Date.now() < JWT_EXPIRY_MARGIN_MS
  } catch {
    return true
  }
}

/**
 * 登录 → 枚举 key → 写回凭据中心（仅 KEY ref）；JWT 只进进程内存。
 * 不检查限频——调用方负责。
 * @returns {Promise<string>} 新抓到的 key
 */
export async function loginAndFetchKey({ label, username, password, credentials, logger, fetchImpl }) {
  if (!username || !password) throw new Error(`账号 ${label} 缺少用户名或密码，无法登录抓取`)

  logger?.info?.(`dsh-sensenova: 账号 ${label} 登录中（按需）…`)
  const token = await senseNovaLogin({ username, password, fetchImpl })
  const { key, total } = await fetchApiKey({ jwt: token.access_token, fetchImpl })
  logger?.info?.(`dsh-sensenova: 账号 ${label} 抓取成功（${total} 个 key，取第一个）`)

  // JWT 只进内存：进程内复用（含 5 分钟提前量过期判断），重启即失、按需重登
  jwtCache.set(accountLabelToRef(label), token.access_token)
  if (credentials) {
    try {
      await credentials.set(refNames(label).key, key)
    } catch (error) {
      logger?.warn?.(`dsh-sensenova: 凭据中心写回 key 失败（${error?.message ?? error}），key 仅本次会话可用`)
    }
  }
  // 登录成功后 JWT 现成，顺带拉一次积分池用量（按需，无定时器；失败不影响）
  await fetchPoolUsage({ label, jwt: token.access_token, fetchImpl })
  return key
}

/**
 * 确保账号有可用 key：凭据已有 → 原样返回；缺失/失效 → 限频重抓。
 * 并发去重：同账号同时只跑一次登录。
 * @param {object} account resolveAccounts 产出的账号对象
 * @param {object} hooks { credentials, logger, fetchImpl, now }
 * @returns {Promise<{key: string, refreshed: boolean, reason?: string}>}
 */
export async function ensureAccountKey(account, { credentials, logger, fetchImpl, now = Date.now } = {}) {
  const { label, key, username, password } = account
  if (key) return { key, refreshed: false }

  const state = refetchState.get(label) ?? {}
  const inflight = state.inflight
  if (inflight) return inflight

  if (state.lastAttemptAt !== undefined && now() - state.lastAttemptAt < REFETCH_MIN_INTERVAL_MS) {
    throw new Error(`账号 ${label} 重抓限频中（10 分钟一次），上次尝试 ${Math.round((now() - state.lastAttemptAt) / 1000)}s 前`)
  }
  if (!username || !password) {
    throw new Error(`账号 ${label} 无 key 且无登录凭据，请在设置页「账号管理」补齐（用户名/密码内嵌于 SENSENOVA_ACCOUNTS）`)
  }

  const attempt = (async () => {
    try {
      const newKey = await loginAndFetchKey({ label, username, password, credentials, logger, fetchImpl })
      return { key: newKey, refreshed: true, reason: 'fetched' }
    } finally {
      state.lastAttemptAt = now()
      state.inflight = undefined
      refetchState.set(label, state)
    }
  })()
  state.inflight = attempt
  refetchState.set(label, state)
  return attempt
}

/** key 失效（401/403）后的重抓入口：忽略现有 key，走同一限频路径。 */
export async function refetchAfterKeyDead(account, hooks = {}) {
  return ensureAccountKey({ ...account, key: '' }, hooks)
}

/** 读内存 JWT 并校验有效期（提前 JWT_EXPIRY_MARGIN_MS 视为过期；重启后为空 → 调用方按需重登）。 */
export function resolveUsableJwt(label) {
  const jwt = jwtCache.get(accountLabelToRef(label))
  return jwt && !jwtExpired(jwt) ? jwt : undefined
}

