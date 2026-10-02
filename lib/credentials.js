/**
 * 凭据解析：三轨优先级（DESIGN.md §7.3）。
 *
 *   key     = credentials SENSENOVA_ACC<N>_KEY > settings.accounts[].key > env SENSENOVA_KEY_<N>
 *   账号密码 = credentials SENSENOVA_ACC<N>_USERNAME/PASSWORD > settings > env
 *
 * credentials 服务可能晚于本插件挂载（跨 bundle 顺序）——运行期
 * ctx.get('credentials') 动态获取，不进 inject、不在 apply 时缓存。
 * ref 全部为纯文本值（key 只存第一个，无 JSON 包装）。
 *
 * 自动抓取（DESIGN.md §7.4，按需登录）：key 缺失或失效时才登录
 * （OAuth2+PKCE → JWT → apiKeys 枚举取第一个 enabled），成功后写回
 * SENSENOVA_ACC<N>_KEY 与 SENSENOVA_ACC<N>_JWT。重抓限频 ≥10 分钟/账号。
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
  return {
    username: `SENSENOVA_${seg}_USERNAME`,
    password: `SENSENOVA_${seg}_PASSWORD`,
    key: `SENSENOVA_${seg}_KEY`,
    jwt: `SENSENOVA_${seg}_JWT`,
  }
}

// ── 页面账号注册表（设置页卡片 → 凭据中心）────────────────────────────────
//
// 设置页卡片创建的账号不经过 config.accounts（schemastery 表单渲染不了
// 对象数组），清单本身也落在凭据中心：单个 ref 存 JSON [{label, enabled}]，
// 用户名/密码仍按上面的 SENSENOVA_<LABEL>_* refs 逐项落库。

/** 账号清单注册表的 ref 名（JSON 数组，仅 label+enabled，不含明文凭据）。 */
export const ACCOUNTS_REGISTRY_REF = 'SENSENOVA_ACCOUNTS'

/** 读账号注册表；凭据中心不可用或内容损坏时返回 []（不影响 config 账号）。 */
export async function loadAccountRegistry(credentials) {
  if (!credentials) return []
  try {
    const resolved = await credentials.resolve(ACCOUNTS_REGISTRY_REF)
    const parsed = JSON.parse(resolved?.value ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.label === 'string')
      .map((entry) => ({ label: entry.label, enabled: entry.enabled !== false }))
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
 * 合并账号骨架：config accounts 优先，注册表条目按 label 去重后补入。
 * @returns {Array<{label:string,enabled:boolean}>} 传给 resolveAccounts 的骨架
 */
export function mergeAccountSkeletons(settingsAccounts, registryEntries) {
  const merged = (settingsAccounts ?? []).map((entry) => ({ label: entry.label, enabled: entry.enabled !== false }))
  const known = new Set(merged.map((entry) => accountLabelToRef(entry.label)))
  for (const entry of registryEntries ?? []) {
    const label = accountLabelToRef(entry.label)
    if (known.has(label)) continue
    known.add(label)
    merged.push({ label, enabled: entry.enabled !== false })
  }
  return merged
}

/**
 * 解析一份账号清单（settings 的 accounts[] 为骨架，三轨填充凭据）。
 *
 * @param {Array<{label:string,username?:string,password?:string,key?:string,enabled?:boolean}>} settingsAccounts
 * @param {object} [credentials] ctx.get('credentials')（可 undefined）
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<{label:string,username:string,password:string,key:string,enabled:boolean,keySource:string,credSource:string}>}
 */
export async function resolveAccounts(settingsAccounts, credentials, env = process.env) {
  const out = []
  const seen = new Set()
  for (const entry of settingsAccounts ?? []) {
    const label = accountLabelToRef(entry.label)
    if (seen.has(label)) continue
    seen.add(label)
    const refs = refNames(label)

    let username = entry.username ?? ''
    let password = entry.password ?? ''
    let key = entry.key ?? ''
    let keySource = 'settings'
    let credSource = 'settings'

    if (credentials) {
      try {
        const resolved = await credentials.resolve(refs.username)
        if (resolved?.value) { username = resolved.value; credSource = 'credentials' }
      } catch { /* 未配置或服务异常 */ }
      try {
        const resolved = await credentials.resolve(refs.password)
        if (resolved?.value) password = resolved.value
      } catch { /* 同上 */ }
      try {
        const resolved = await credentials.resolve(refs.key)
        if (resolved?.value) { key = resolved.value; keySource = 'credentials' }
      } catch { /* 同上 */ }
    }
    if (!key && env[`SENSENOVA_KEY_${label}`]) { key = env[`SENSENOVA_KEY_${label}`]; keySource = 'env' }
    if (!username && env[`SENSENOVA_${label}_USERNAME`]) username = env[`SENSENOVA_${label}_USERNAME`]
    if (!password && env[`SENSENOVA_${label}_PASSWORD`]) password = env[`SENSENOVA_${label}_PASSWORD`]

    out.push({
      label,
      username: String(username).trim(),
      password: String(password),
      key: String(key).trim(),
      enabled: entry.enabled !== false,
      keySource,
      credSource,
    })
  }
  return out
}

// ── 自动抓取（按需登录）─────────────────────────────────────────────────────

/** 进程内运行态：每账号的重抓限频与并发去重。 */
const refetchState = new Map() // label → { lastAttemptAt, inflight: Promise }

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
 * 登录 → 枚举 key → 写回凭据中心（KEY + JWT ref）。不检查限频——调用方负责。
 * @returns {Promise<string>} 新抓到的 key
 */
export async function loginAndFetchKey({ label, username, password, credentials, logger, fetchImpl }) {
  const refs = refNames(label)
  if (credentials) {
    // credentials 里的凭据优先于 settings（与 resolveAccounts 同序）
    try {
      const resolved = await credentials.resolve(refs.username)
      if (resolved?.value) username = resolved.value
    } catch { /* 保持传入值 */ }
    try {
      const resolved = await credentials.resolve(refs.password)
      if (resolved?.value) password = resolved.value
    } catch { /* 同上 */ }
  }
  if (!username || !password) throw new Error(`账号 ${label} 缺少用户名或密码，无法登录抓取`)

  logger?.info?.(`dsh-sensenova: 账号 ${label} 登录中（按需）…`)
  const token = await senseNovaLogin({ username, password, fetchImpl })
  const { key, total } = await fetchApiKey({ jwt: token.access_token, fetchImpl })
  logger?.info?.(`dsh-sensenova: 账号 ${label} 抓取成功（${total} 个 key，取第一个）`)

  if (credentials) {
    try {
      await credentials.set(refs.key, key)
      await credentials.set(refs.jwt, token.access_token)
    } catch (error) {
      logger?.warn?.(`dsh-sensenova: 凭据中心写回失败（${error?.message ?? error}），本次会话内存可用`)
    }
  }
  // 登录成功后 JWT 现成，顺带拉一次积分池用量（按需，无定时器；失败不影响）
  await fetchPoolUsage({ label, jwt: token.access_token, fetchImpl })
  return key
}

/**
 * 确保账号有可用 key：三轨已有 → 原样返回；缺失/失效 → 限频重抓。
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
    throw new Error(`账号 ${label} 无 key 且无登录凭据（用户名/密码），请在设置页或凭据中心补齐`)
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

/** key 失效（401/403）后的重抓入口：清内存 JWT 缓存判断，走同一限频路径。 */
export async function refetchAfterKeyDead(account, hooks = {}) {
  return ensureAccountKey({ ...account, key: '' }, hooks)
}

/** 读取 JWT ref 并判断是否过期（pool-usage 按需拉取时用）。 */
export async function resolveUsableJwt(label, credentials) {
  if (!credentials) return undefined
  try {
    const resolved = await credentials.resolve(refNames(label).jwt)
    if (resolved?.value && !jwtExpired(resolved.value)) return resolved.value
  } catch { /* 未配置 */ }
  return undefined
}

