import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchPoolUsage, cachedUsageSnapshot, _resetUsageCacheForTests } from '../../lib/usage.js'

test('reset_at 秒级时间戳归一化为毫秒（防 1970 误解析）', async () => {
  _resetUsageCacheForTests()
  // 2026-10-02 18:10:00 GMT+8 ≈ 1790943000 秒 / 1790943000000 毫秒
  const SEC = 1_790_943_000
  const json = {
    grant_balance: 12.5,
    pools: [{
      pool_type: 'default',
      name: '通用积分池',
      window_5h: { limit: 60000, used: 100, remaining: 59900, reset_at: SEC },
      window_7d: { limit: 600000, used: 1000, remaining: 599000, reset_at: SEC },
    }],
  }
  const entry = await fetchPoolUsage({ label: 'ACC1', jwt: 'jwt-x', fetchImpl: async () => ({ ok: true, json: async () => json }) })
  assert.equal(entry.pools[0].resetAt, SEC * 1000)
  assert.equal(entry.pools[0].resetAt7d, SEC * 1000)
  assert.equal(entry.grantBalance, 12.5)

  const snap = cachedUsageSnapshot('ACC1')
  // 归一化后必须落在合理年份（> 2001-09-09 的毫秒阈值 1e12），而非 1970
  assert.ok(snap.pools[0].resetAt > 1e12, 'resetAt 应为毫秒级')
  assert.equal(new Date(snap.pools[0].resetAt).getFullYear(), 2026)
})

test('已是毫秒级或为 0 的 reset_at 原样保留', async () => {
  _resetUsageCacheForTests()
  const MS = 1_790_943_000_000
  const json = {
    pools: [{
      pool_type: 'default',
      window_5h: { limit: 1, used: 0, remaining: 1, reset_at: MS },
      window_7d: { limit: 1, used: 0, remaining: 1, reset_at: 0 },
    }],
  }
  await fetchPoolUsage({ label: 'ACC2', jwt: 'jwt-x', fetchImpl: async () => ({ ok: true, json: async () => json }) })
  const pool = cachedUsageSnapshot('ACC2').pools[0]
  assert.equal(pool.resetAt, MS)
  assert.equal(pool.resetAt7d, 0)
})
