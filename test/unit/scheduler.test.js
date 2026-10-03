import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Scheduler } from '../../lib/scheduler.js'
import { parseSseText } from '../../lib/client.js'

const OPTS = { accountCooldownMs: 60_000, retryIntervalMs: 20, rateLimitMode: 'failover-then-fail' }

const SIMPLE_EVENTS = [
  { choices: [{ index: 0, delta: { content: '你' } }] },
  { choices: [{ index: 0, delta: { content: '好' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [{ index: 0, delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
]
const SSE_TEXT = SIMPLE_EVENTS.map((e) => `data: ${JSON.stringify(e)}`).join('\n') + '\ndata: [DONE]\n\n'

/** 假流实现：跳过传输层，直接喂 SSE 文本给真解析器。 */
const fakeStream = (text = SSE_TEXT, delayMs = 0) =>
  async function* () {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    yield* parseSseText([text])
  }

const rateLimitError = (bodyText = 'inference exceeds tpm/rpm limit') => {
  const error = new Error('rate')
  // 真实 client 的 429 报错形状（报文摘要进 facts，调度器归因用）
  error.failure = { code: 'RATE_LIMIT', facts: { status: 429, bodyText } }
  return error
}

async function collect(iter) {
  const out = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

function makeScheduler(impl, accounts) {
  return new Scheduler({
    listAccounts: () => accounts,
    options: OPTS,
    streamImpl: impl,
  })
}

test('成功路径：block-start → deltas → block-end → usage → finish', async () => {
  const s = makeScheduler(fakeStream(), [{ label: 'ACC1', key: 'sk-1', enabled: true }])
  const chunks = await collect(s.stream({ model: 'm' }, {}))
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks[0].blockType, 'text')
  const deltas = chunks.filter((c) => c.type === 'text-delta')
  assert.deepEqual(deltas.map((c) => c.text), ['你', '好'])
  const blockEnd = chunks.find((c) => c.type === 'block-end')
  assert.equal(blockEnd.block.text, '你好')
  const usage = chunks.find((c) => c.type === 'usage')
  assert.equal(usage.usage.totalTokens, 7)
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.deepEqual(finish.reason, { kind: 'stop' })
})

test('空窗 429：固定（账号, 模型）重试直到成功（不换账号），成功后解除', async () => {
  const calledKeys = []
  let calls = 0
  const impl = async function* ({ key }) {
    calledKeys.push(key)
    calls += 1
    if (calls === 1) throw rateLimitError()
    yield* fakeStream()()
  }
  const s = makeScheduler(impl, [
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  const chunks = await collect(s.stream({ model: 'glm-5.2' }, {}))
  assert.equal(calls, 2)
  // 全部请求都落在 ACC1（固定重试），ACC2 从未被调用
  assert.deepEqual(calledKeys, ['sk-1', 'sk-1'])
  assert.equal(chunks.at(-1).type, 'finish')
  assert.ok(s.accounts.get('ACC1').cooldowns.get('glm-5.2'), 'ACC1 的 glm-5.2 有冷却记录')
  assert.ok(s.lastRateLimit.get('ACC1')?.at > 0)
  assert.equal(s.busyHold.get('glm-5.2'), undefined, '成功后解除固定')
})

test('空窗 429 的固定只影响该模型：其他模型照常看到两个候选账号', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let calls = 0
  const impl = async function* () {
    calls += 1
    if (calls === 1) throw rateLimitError() // glm-5.2 空窗 → 固定 ACC1
    if (calls === 2) await gate // 第 2 次请求挂住：固定保持中
    yield* fakeStream()()
  }
  const s = makeScheduler(impl, [
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  const iter = s.stream({ model: 'glm-5.2' }, {})
  // collect() 开始消费，生成器才真正运行：429 → 固定 → 重试挂住
  const done = collect(iter)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(s.busyHold.get('glm-5.2'), 'ACC1')
  // 其他模型（kimi-k3）不受固定影响：候选池仍是两个账号（顺序按轮转，不固定）
  const cands = await s.candidates(Date.now(), undefined, 'kimi-k3')
  assert.deepEqual(cands.map((a) => a.label).sort(), ['ACC1', 'ACC2'])
  // glm-5.2 本身：固定在 ACC1
  const candsGlm = await s.candidates(Date.now(), undefined, 'glm-5.2')
  assert.deepEqual(candsGlm.map((a) => a.label), ['ACC1'])
  release()
  assert.equal((await done).at(-1).type, 'finish')
})

test('已固定的（账号, 模型）再次 429 且窗口有消耗：保持固定，不解钉换号', async () => {
  let calls = 0
  const impl = async function* () {
    calls += 1
    if (calls === 1) throw rateLimitError() // 空窗 → 固定 ACC1
    if (calls === 2) {
      // 探测成功消耗了一点，紧接着又 429——不能因此判 TPM 换号
      yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 10 } }
      throw rateLimitError()
    }
    yield* fakeStream()()
  }
  const s = makeScheduler(impl, [
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  const chunks = await collect(s.stream({ model: 'glm-5.2' }, {}))
  assert.ok(calls >= 3)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(s.busyHold.get('glm-5.2'), undefined, '成功后解除固定')
  assert.equal(s.lastRateLimit.get('ACC1')?.kind, 'busy', '第二次 429 仍是 busy 归因')
})

test('固定重试在 failover-then-fail 下也不快速失败（直到成功或手动中断）', async () => {
  let calls = 0
  const impl = async function* () {
    calls += 1
    if (calls <= 2) throw rateLimitError()
    yield* fakeStream()()
  }
  const s = makeScheduler(impl, [{ label: 'ACC1', key: 'sk-1', enabled: true }])
  const chunks = await collect(s.stream({ model: 'glm-5.2' }, {}))
  assert.ok(calls >= 3)
  assert.equal(chunks.at(-1).type, 'finish')
})

test('固定期间手动中断：以 ABORTED 结束，固定保持', async () => {
  const controller = new AbortController()
  const calledKeys = []
  const impl = async function* ({ key }) {
    calledKeys.push(key)
    throw rateLimitError()
  }
  const s = makeScheduler(impl, [
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  setTimeout(() => controller.abort(), 80)
  await assert.rejects(
    () => collect(s.stream({ model: 'glm-5.2' }, { signal: controller.signal })),
    (error) => error.failure?.code === 'ABORTED',
  )
  assert.equal(s.busyHold.get('glm-5.2'), 'ACC1')
  assert.deepEqual([...new Set(calledKeys)], ['sk-1'], '只在固定账号上重试')
})

test('固定账号 key 失效：解除固定并换号', async () => {
  let calls = 0
  const impl = async function* () {
    calls += 1
    if (calls === 1) throw rateLimitError() // 空窗 → 固定 ACC1
    if (calls === 2) { // 固定的 ACC1 key 失效
      const error = new Error('unauthorized')
      error.failure = { code: 'INVALID_CREDENTIAL' }
      throw error
    }
    yield* fakeStream()()
  }
  const s = makeScheduler(impl, [
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  const chunks = await collect(s.stream({ model: 'glm-5.2' }, {}))
  assert.equal(calls, 3)
  assert.equal(s.accounts.get('ACC1').keyStatus, 'dead')
  assert.equal(s.busyHold.get('glm-5.2'), undefined, 'key 失效解除固定')
  assert.equal(chunks.at(-1).type, 'finish')
})

test('key 失效（401）：标记 dead 并换号', async () => {
  let calls = 0
  const impl = async function* () {
    calls += 1
    if (calls === 1) {
      const error = new Error('unauthorized')
      error.failure = { code: 'INVALID_CREDENTIAL' }
      throw error
    }
    yield* fakeStream()()
  }
  const s = makeScheduler(impl, [
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  const chunks = await collect(s.stream({ model: 'm' }, {}))
  assert.equal(calls, 2)
  assert.equal(s.accounts.get('ACC1').keyStatus, 'dead')
  assert.equal(chunks.at(-1).type, 'finish')
})

test('key 换新：重置健康标记（重抓后的覆写）', async () => {
  const s = makeScheduler(fakeStream(), [{ label: 'ACC1', key: 'sk-old', enabled: true }])
  await collect(s.stream({ model: 'm' }, {}))
  s.accounts.get('ACC1').keyStatus = 'dead'
  // listAccounts 下次返回新 key → account() 重置健康
  const acc = s.account('ACC1', 'sk-new', true)
  assert.equal(acc.keyStatus, 'ok')
  assert.equal(acc.key, 'sk-new')
})

test('failover-then-fail：全池 TPM 耗尽后上抛 RATE_LIMIT', async () => {
  // 大额消耗（≥16384 阈值）的 429 → TPM 归因（不固定）：两账号都冷却 ~60s → 池耗尽 → 快速失败
  const impl = async function* () {
    yield { type: 'usage', usage: { inputTokens: 20_000, outputTokens: 10 } }
    throw rateLimitError()
  }
  const s = makeScheduler(impl, [
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  await assert.rejects(
    () => collect(s.stream({ model: 'glm-5.2' }, {})),
    (error) => error.failure?.code === 'RATE_LIMIT',
  )
  assert.equal(s.busyHold.get('glm-5.2'), undefined, 'TPM 归因不固定')
})

test('wait-until-available：全池冷却时等待重扫直到成功', async () => {
  let calls = 0
  const impl = async function* () {
    calls += 1
    if (calls <= 2) throw rateLimitError()
    yield* fakeStream()()
  }
  const s = new Scheduler({
    listAccounts: () => [{ label: 'ACC1', key: 'sk-1', enabled: true }],
    options: { ...OPTS, rateLimitMode: 'wait-until-available', accountCooldownMs: 50 },
    streamImpl: impl,
  })
  const chunks = await collect(s.stream({ model: 'glm-5.2' }, {}))
  assert.ok(calls >= 3, `至少重试到第三发（实际 ${calls}）`)
  assert.equal(chunks.at(-1).type, 'finish')
})

test('429 归因 other：空窗但报文非 tpm/rpm 超限措辞 → 不固定，按 accountCooldownMs 冷却换号', async () => {
  const calledKeys = []
  const s = makeScheduler(
    async function* ({ key }) {
      calledKeys.push(key)
      throw rateLimitError('some other limit message')
    },
    [
      { label: 'ACC1', key: 'sk-1', enabled: true },
      { label: 'ACC2', key: 'sk-2', enabled: true },
    ],
  )
  const t0 = Date.now()
  // 无固定 → mode B 快速失败（RATE_LIMIT），不会像空窗超限那样一直重试
  await assert.rejects(
    () => collect(s.stream({ model: 'glm-5.2' }, {})),
    (error) => error.failure?.code === 'RATE_LIMIT',
  )
  assert.equal(s.busyHold.get('glm-5.2'), undefined, '报文措辞不符不固定')
  const limit = s.lastRateLimit.get('ACC1')
  assert.equal(limit.kind, 'other')
  const entry = s.accounts.get('ACC1').cooldowns.get('glm-5.2')
  assert.equal(entry.kind, 'other')
  assert.ok(entry.until - t0 >= 60_000 - 500, `未知 429 走 accountCooldownMs（实际 ${entry.until - t0}ms）`)
  // 换号发生：ACC2 也被调用过
  assert.ok(calledKeys.includes('sk-2'), '冷却换号而不是固定原账号')
})

test('429 归因 busy：空窗（无成功消耗）→ 短冷却 = retryIntervalMs，仅限该模型', async () => {
  const controller = new AbortController()
  const s = makeScheduler(async function* () { throw rateLimitError() }, [
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  const t0 = Date.now()
  setTimeout(() => controller.abort(), 80)
  await assert.rejects(
    () => collect(s.stream({ model: 'glm-5.2' }, { signal: controller.signal })),
    (error) => error.failure?.code === 'ABORTED',
  )
  const acc = s.accounts.get('ACC1')
  const limit = s.lastRateLimit.get('ACC1')
  assert.equal(limit.kind, 'busy')
  assert.equal(limit.model, 'glm-5.2')
  assert.equal(limit.windowSpend, 0)
  // 空窗 429 判服务侧繁忙：冷却 = 重试间隔（20ms），远短于 accountCooldownMs
  const entry = acc.cooldowns.get('glm-5.2')
  assert.ok(entry.until - t0 <= 200, `短冷却（实际 ${entry.until - t0}ms）`)
  assert.equal(entry.kind, 'busy')
  // 其他模型不受该冷却影响
  const cands = await s.candidates(Date.now(), undefined, 'kimi-k3')
  assert.equal(cands.filter((a) => a.label === 'ACC1').length, 1)
})

test('429 归因 tpm：窗口内有成功消耗 → 冷却至滚动窗口释放（≈60s），仅限该模型', async () => {
  const impl = async function* () {
    yield { type: 'usage', usage: { inputTokens: 50_000, outputTokens: 100, cacheReadTokens: 0 } }
    throw rateLimitError()
  }
  const s = makeScheduler(impl, [
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  await assert.rejects(
    () => collect(s.stream({ model: 'glm-5.2' }, {})),
    (error) => error.failure?.code === 'RATE_LIMIT',
  )
  const acc = s.accounts.get('ACC1')
  const limit = s.lastRateLimit.get('ACC1')
  assert.equal(limit.kind, 'tpm')
  // 记账：缓存未命中部分 + completion = 50000 + 100
  assert.equal(limit.windowSpend, 50_100)
  const entry = acc.cooldowns.get('glm-5.2')
  assert.ok(entry.until - limit.at >= 55_000, `TPM 冷却应接近满窗口（实际 ${entry.until - limit.at}ms）`)
  assert.equal(entry.kind, 'tpm')
  // 其他模型不受该冷却影响
  const cands = await s.candidates(Date.now(), undefined, 'kimi-k3')
  assert.equal(cands.filter((a) => a.label === 'ACC1').length, 1)
})

test('空窗判定阈值：窗口消耗 <16384 视为服务繁忙（固定重试），≥16384 判 TPM 冷却', async () => {
  const impl = (tokens) => async function* () {
    yield { type: 'usage', usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0 } }
    throw rateLimitError()
  }
  // 16383 < 阈值：空窗 → 服务繁忙 → 固定（账号, 模型）重试
  const controller = new AbortController()
  const busy = makeScheduler(impl(16_383), [{ label: 'ACC1', key: 'sk-1', enabled: true }])
  setTimeout(() => controller.abort(), 60)
  await assert.rejects(
    () => collect(busy.stream({ model: 'glm-5.2' }, { signal: controller.signal })),
    (error) => error.failure?.code === 'ABORTED',
  )
  assert.equal(busy.lastRateLimit.get('ACC1')?.kind, 'busy')
  assert.equal(busy.busyHold.get('glm-5.2'), 'ACC1')
  // 16384 ≥ 阈值：TPM 归因 → 冷却不固定
  const tpm = makeScheduler(impl(16_384), [{ label: 'ACC1', key: 'sk-1', enabled: true }])
  await assert.rejects(
    () => collect(tpm.stream({ model: 'glm-5.2' }, {})),
    (error) => error.failure?.code === 'RATE_LIMIT',
  )
  assert.equal(tpm.lastRateLimit.get('ACC1')?.kind, 'tpm')
  assert.equal(tpm.busyHold.get('glm-5.2'), undefined, 'TPM 归因不固定')
})

test('固定回合的重复 429 只发一次 rate-limit 事件（重复请求不刷日志）', async () => {
  let calls = 0
  const impl = async function* () {
    calls += 1
    if (calls <= 3) throw rateLimitError()
    yield* fakeStream()()
  }
  const events = []
  const s = new Scheduler({
    listAccounts: () => [{ label: 'ACC1', key: 'sk-1', enabled: true }],
    options: OPTS,
    streamImpl: impl,
    onEvent: (_label, fact) => events.push(fact),
  })
  const chunks = await collect(s.stream({ model: 'glm-5.2' }, {}))
  assert.ok(calls >= 4)
  assert.equal(chunks.at(-1).type, 'finish')
  const busyEvents = events.filter((e) => e.type === 'rate-limit' && e.kind === 'busy')
  assert.equal(busyEvents.length, 1, `固定回合只发一次事件（实际 ${busyEvents.length}）`)
  assert.equal(busyEvents[0].cooldownMs, 20, '事件携带冷却时长（= retryIntervalMs）')
  assert.ok(s.lastRateLimit.get('ACC1'), 'lastRateLimit 照常刷新（状态页不受影响）')
})

test('TPM 记账：缓存命中 tokens 不计（实测命中不计 TPM）', async () => {
  const impl = async function* () {
    yield { type: 'usage', usage: { inputTokens: 50_000, outputTokens: 50, cacheReadTokens: 49_000 } }
  }
  const s = makeScheduler(impl, [{ label: 'ACC1', key: 'sk-1', enabled: true }])
  await collect(s.stream({ model: 'glm-5.2' }, {}))
  const acc = s.accounts.get('ACC1')
  assert.equal(s.windowSpend(acc, 'glm-5.2'), 1000 + 50)
})

test('无可用账号（无 key）：failover 模式报 MISSING_CREDENTIAL', async () => {
  const s = makeScheduler(async function* () { throw new Error('should not call') }, [
    { label: 'ACC1', key: '', enabled: true },
  ])
  await assert.rejects(
    () => collect(s.stream({ model: 'm' }, {})),
    (error) => error.failure?.code === 'MISSING_CREDENTIAL',
  )
})

test('同账号串行：并发请求不重叠、依次完成', async () => {
  let inFlight = 0
  let peak = 0
  const impl = async function* () {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    try {
      yield* fakeStream(SSE_TEXT, 30)()
    } finally {
      inFlight -= 1
    }
  }
  const s = makeScheduler(impl, [{ label: 'ACC1', key: 'sk-1', enabled: true }])
  const results = await Promise.all(Array.from({ length: 3 }, () => collect(s.stream({ model: 'm' }, {}))))
  assert.ok(results.every((chunks) => chunks.at(-1).type === 'finish'))
  assert.ok(peak === 1, `同账号请求必须串行（峰值 ${peak}）`)
})

test('全部账号忙时：等待重扫而不是报错（busy ≠ 不可用）', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let firstDone = false
  const impl = async function* () {
    if (!firstDone) {
      // 第一个请求挂住，直到测试放行
      await gate
      firstDone = true
    }
    yield* fakeStream(SSE_TEXT, 10)()
  }
  const s = new Scheduler({
    listAccounts: () => [{ label: 'ACC1', key: 'sk-1', enabled: true }],
    options: { ...OPTS, rateLimitMode: 'wait-until-available' },
    streamImpl: impl,
  })
  const slow = collect(s.stream({ model: 'm' }, {}))
  // 等第一个请求进入闸门后，第二个并发请求应排队等待而非 MISSING_CREDENTIAL
  await new Promise((r) => setTimeout(r, 60))
  const fast = collect(s.stream({ model: 'm' }, {}))
  release()
  const [a, b] = await Promise.all([slow, fast])
  assert.ok(a.at(-1).type === 'finish')
  assert.ok(b.at(-1).type === 'finish')
})

test('取消：signal 中止时流以 ABORTED 结束', async () => {
  const controller = new AbortController()
  // 模拟真实传输：https.request 的 signal 中止会销毁流、for-await 抛错
  const impl = async function* () {
    yield* parseSseText((async function* () {
      yield 'data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\n'
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000)
        controller.signal.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('aborted'))
        }, { once: true })
      })
      yield 'data: [DONE]\n\n'
    })(), controller.signal)
  }
  const s = makeScheduler(impl, [{ label: 'ACC1', key: 'sk-1', enabled: true }])
  const iter = s.stream({ model: 'm' }, { signal: controller.signal })
  assert.equal((await iter.next()).value.type, 'block-start')
  assert.equal((await iter.next()).value.type, 'text-delta') // 已缓冲的第二个块
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(() => iter.next(), (error) => error.failure?.code === 'ABORTED' || error.name === 'AbortError')
})
