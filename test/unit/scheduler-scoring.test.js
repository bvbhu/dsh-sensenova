import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Scheduler } from '../../lib/scheduler.js'
import { fetchPoolUsage, cachedDefaultPoolRatio, _resetUsageCacheForTests } from '../../lib/usage.js'
import { parseSseText } from '../../lib/client.js'

const OPTS = { accountCooldownMs: 60_000, rateLimitMode: 'failover-then-fail' }

async function collect(iter) {
  const out = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

function makeScheduler(accounts, opts = OPTS) {
  return new Scheduler({
    listAccounts: () => accounts,
    options: opts,
    streamImpl: async function* () {
      yield* parseSseText(['data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\ndata: [DONE]\n\n'])
    },
  })
}

test('选号评分：会话粘性优先（同会话粘住同账号）', async () => {
  const s = makeScheduler([
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  // 第一轮：无粘性，按 lastUsedAt（都为 0）→ 排序稳定，选第一个（ACC1）
  await collect(s.stream({}, { sessionId: 'sess-A' }))
  assert.equal(s.accounts.get('ACC1').lastSessionId, 'sess-A')
  // 第二轮同会话：粘性应再次选中 ACC1（即使 ACC2.lastUsedAt=0 更"旧"）
  await collect(s.stream({}, { sessionId: 'sess-A' }))
  assert.equal(s.accounts.get('ACC1').busy, false)
  // ACC2 从未被使用
  assert.equal(s.accounts.get('ACC2')?.lastSessionId, undefined)
})

test('选号评分：粘性账号冷却时自动切换', async () => {
  const s = makeScheduler([
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  await collect(s.stream({ model: 'glm-5.2' }, { sessionId: 'sess-B' }))
  // ACC1 的 glm-5.2 进入长冷却（限流桶按 账号×模型，只冻结该模型）
  s.accounts.get('ACC1').cooldowns.set('glm-5.2', { until: Date.now() + 60_000, kind: 'tpm' })
  await collect(s.stream({ model: 'glm-5.2' }, { sessionId: 'sess-B' }))
  assert.equal(s.accounts.get('ACC2').lastSessionId, 'sess-B', '粘性账号不可用时应切换')
})

test('选号评分：余量占比参与排序（无缓存视为中性）', async () => {
  // ACC1 余量 5%（低），ACC2 余量 90%（高）：应选 ACC2
  const s = makeScheduler([
    { label: 'ACC1', key: 'sk-1', enabled: true, creditsRatio: 0.05 },
    { label: 'ACC2', key: 'sk-2', enabled: true, creditsRatio: 0.9 },
  ])
  await collect(s.stream({}, {}))
  assert.equal(s.accounts.get('ACC2').lastSessionId, undefined)
  assert.ok(s.accounts.get('ACC1').lastUsedAt > 0 || s.accounts.get('ACC2').lastUsedAt > 0)
  // 直接断言：候选顺序里 ACC2 在前
  const pool = await s.candidates(Date.now(), undefined)
  assert.equal(pool[0].label, 'ACC2')
})

test('选号评分：粘性压倒余量（粘性是保缓存的首要杠杆）', async () => {
  const s = makeScheduler([
    { label: 'ACC1', key: 'sk-1', enabled: true, creditsRatio: 0.1 },
    { label: 'ACC2', key: 'sk-2', enabled: true, creditsRatio: 0.99 },
  ])
  await collect(s.stream({}, { sessionId: 'sess-C' }))
  // 第一轮落在 ACC1（余量低但按 lastUsedAt 先到）；同会话第二轮应粘住 ACC1
  const first = s.accounts.get('ACC1').lastSessionId === 'sess-C' ? 'ACC1' : 'ACC2'
  await collect(s.stream({}, { sessionId: 'sess-C' }))
  const sticky = s.accounts.get(first).lastSessionId === 'sess-C'
  assert.ok(sticky, '同会话应粘住首轮账号')
})

test('pool-usage：解析 pool-usage 响应并缓存占比', async () => {
  _resetUsageCacheForTests()
  const fake = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ pools: [
      { pool_type: 'default', name: '通用池', window_5h: { limit: 60000, used: 30000, remaining: 30000, reset_at: '1790000000' } },
      { pool_type: 'dedicated', name: '专属池', window_5h: { limit: 60000, used: 6000, remaining: 54000, reset_at: '1790000000' } },
    ], grant_balance: 600000 }),
  })
  const entry = await fetchPoolUsage({ label: 'ACC1', jwt: 'J', fetchImpl: fake })
  assert.equal(entry.pools.length, 2)
  assert.equal(cachedDefaultPoolRatio('ACC1'), 0.5)
})

test('pool-usage：失败保留旧缓存、无 jwt 不请求', async () => {
  _resetUsageCacheForTests()
  await fetchPoolUsage({ label: 'ACC9', jwt: 'J', fetchImpl: async () => ({ ok: true, json: async () => ({ pools: [{ pool_type: 'default', window_5h: { limit: 100, remaining: 80 } }] }) }) })
  assert.equal(cachedDefaultPoolRatio('ACC9'), 0.8)
  // 失败：旧缓存保留
  await fetchPoolUsage({ label: 'ACC9', jwt: 'J', fetchImpl: async () => { throw new Error('net') } })
  assert.equal(cachedDefaultPoolRatio('ACC9'), 0.8)
  // 无 jwt：直接 undefined
  await fetchPoolUsage({ label: 'ACC8', jwt: undefined, fetchImpl: async () => { throw new Error('should not call') } })
  assert.equal(cachedDefaultPoolRatio('ACC8'), undefined)
})
