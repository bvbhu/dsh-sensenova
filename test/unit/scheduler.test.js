import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Scheduler } from '../../lib/scheduler.js'
import { parseSseText } from '../../lib/client.js'

const OPTS = { accountCooldownMs: 60_000, rateLimitMode: 'failover-then-fail' }

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

const rateLimitError = () => {
  const error = new Error('rate')
  error.failure = { code: 'RATE_LIMIT' }
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
  assert.equal(finish.reason, 'stop')
})

test('429：账号冷却并换下一账号成功', async () => {
  let calls = 0
  const impl = async function* () {
    calls += 1
    if (calls === 1) throw rateLimitError()
    yield* fakeStream()()
  }
  const s = makeScheduler(impl, [
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  const chunks = await collect(s.stream({}, {}))
  assert.equal(calls, 2)
  assert.equal(chunks.at(-1).type, 'finish')
  assert.ok(s.accounts.get('ACC1').cooldownUntil > 0, 'ACC1 进入冷却')
  assert.ok(s.lastRateLimit.get('ACC1') > 0)
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
  const chunks = await collect(s.stream({}, {}))
  assert.equal(calls, 2)
  assert.equal(s.accounts.get('ACC1').keyStatus, 'dead')
  assert.equal(chunks.at(-1).type, 'finish')
})

test('key 换新：重置健康标记（重抓后的覆写）', async () => {
  const s = makeScheduler(fakeStream(), [{ label: 'ACC1', key: 'sk-old', enabled: true }])
  await collect(s.stream({}, {}))
  s.accounts.get('ACC1').keyStatus = 'dead'
  // listAccounts 下次返回新 key → account() 重置健康
  const acc = s.account('ACC1', 'sk-new', true)
  assert.equal(acc.keyStatus, 'ok')
  assert.equal(acc.key, 'sk-new')
})

test('failover-then-fail：全池 429 耗尽后上抛 RATE_LIMIT', async () => {
  const impl = async function* () { throw rateLimitError() }
  const s = makeScheduler(impl, [
    { label: 'ACC1', key: 'sk-1', enabled: true },
    { label: 'ACC2', key: 'sk-2', enabled: true },
  ])
  await assert.rejects(
    () => collect(s.stream({}, {})),
    (error) => error.failure?.code === 'RATE_LIMIT',
  )
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
  const chunks = await collect(s.stream({}, {}))
  assert.ok(calls >= 3, `至少重试到第三发（实际 ${calls}）`)
  assert.equal(chunks.at(-1).type, 'finish')
})

test('无可用账号（无 key）：failover 模式报 MISSING_CREDENTIAL', async () => {
  const s = makeScheduler(async function* () { throw new Error('should not call') }, [
    { label: 'ACC1', key: '', enabled: true },
  ])
  await assert.rejects(
    () => collect(s.stream({}, {})),
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
  const results = await Promise.all(Array.from({ length: 3 }, () => collect(s.stream({}, {}))))
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
  const slow = collect(s.stream({}, {}))
  // 等第一个请求进入闸门后，第二个并发请求应排队等待而非 MISSING_CREDENTIAL
  await new Promise((r) => setTimeout(r, 60))
  const fast = collect(s.stream({}, {}))
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
  const iter = s.stream({}, { signal: controller.signal })
  assert.equal((await iter.next()).value.type, 'block-start')
  assert.equal((await iter.next()).value.type, 'text-delta') // 已缓冲的第二个块
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(() => iter.next(), (error) => error.failure?.code === 'ABORTED' || error.name === 'AbortError')
})
