/**
 * 平台层用量（pool-usage）按需拉取与缓存（DESIGN.md §8.2）。
 *
 * 无后台定时器：只在两个时机拉取——① 登录成功后顺带一次（JWT 现成）；
 * ② 状态页显式刷新（M4）。缓存进内存，进程重启归零（除凭据外无持久化）。
 * 余量进调度器做软约束评分（§5.2）：TPM 限制下池不会耗尽，此数据是
 * 展示与极端保护，不是硬约束。
 *
 * @module lib/usage.js
 */

const POOL_USAGE_URL = 'https://platform.sensenova.cn/lite/console/v1/tokenplan/pool-usage'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36'

/** label → { at, pools: [{poolType, name, limit, used, remaining, resetAt, ratio5h}] } */
const cache = new Map()

/** 测试/重置接缝。 */
export function _resetUsageCacheForTests() {
  cache.clear()
}

/** 上游 reset_at 是秒级 Unix 时间戳，归一化为毫秒（防 1970 年误解析）。 */
function toMs(seconds) {
  const n = Number(seconds ?? 0)
  return n > 0 && n < 1e12 ? n * 1000 : n
}

/**
 * 拉取一个账号的积分池用量并写缓存。
 * @returns {Promise<{pools: Array, grantBalance: number} | undefined>} 失败返回 undefined（保留旧缓存）
 */
export async function fetchPoolUsage({ label, jwt, fetchImpl = fetch }) {
  if (!jwt) return undefined
  try {
    const response = await fetchImpl(POOL_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
        Referer: 'https://platform.sensenova.cn/console',
        'User-Agent': UA,
      },
    })
    if (!response.ok) return undefined
    const data = await response.json()
    const pools = (data.pools ?? (typeof data.pools === 'object' ? Object.values(data.pools) : []))
      .filter((p) => p && typeof p === 'object')
      .map((p) => {
        const w5 = p.window_5h ?? {}
        const w7 = p.window_7d ?? {}
        const h5limit = Number(w5.limit ?? 0)
        const h5remaining = Number(w5.remaining ?? 0)
        return {
          poolType: p.pool_type ?? '',
          name: p.name ?? '',
          // 5h 窗口（旧字段保留：调度评分 cachedDefaultPoolRatio 依赖 ratio5h）
          limit: h5limit,
          used: Number(w5.used ?? 0),
          remaining: h5remaining,
          resetAt: toMs(w5.reset_at),
          ratio5h: h5limit > 0 ? h5remaining / h5limit : 1,
          // 7 天窗口（状态页明细用）
          limit7d: Number(w7.limit ?? 0),
          used7d: Number(w7.used ?? 0),
          remaining7d: Number(w7.remaining ?? 0),
          resetAt7d: toMs(w7.reset_at),
        }
      })
    const entry = { at: Date.now(), pools, grantBalance: Number(data.grant_balance ?? 0) }
    cache.set(label, entry)
    return entry
  } catch {
    return undefined
  }
}

/**
 * 调度用：账号 5h 窗口的"通用池"余量占比（0–1）。无缓存返回 undefined（中性）。
 * flash-lite 走专属池，但调度评分只需要账号级别的粗粒度信号，通用池占比足够。
 */
export function cachedDefaultPoolRatio(label) {
  const entry = cache.get(label)
  if (!entry) return undefined
  const pool = entry.pools.find((p) => p.poolType === 'default') ?? entry.pools[0]
  return pool?.ratio5h
}

/** 状态页用：完整缓存快照。 */
export function cachedUsageSnapshot(label) {
  return cache.get(label)
}

/** 状态页用：全部账号的缓存快照（label → entry）。 */
export function allUsageSnapshots() {
  return cache.entries()
}
