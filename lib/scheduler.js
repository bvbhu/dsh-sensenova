/**
 * 账号池调度器。
 *
 * M1 形态：多账号数据结构 + 单账号串行闸门就位；跨账号轮换 / 会话粘性 /
 * 余量评分在 M2 补齐（见 DESIGN.md §5）。失败域处理已实现：429 账号微冷却、
 * key 失效标记、全池耗尽按 rateLimitMode 终局（wait-until-available 默认）。
 *
 * 并发模型：**单账号串行**（2026-10-02 决策，见 SerialGate）——maxSockets:1
 * 的钉连 agent 本就把账号内请求顺序化到同一条 TCP 连接上，闸门只保证同一
 * 账号同一时刻至多一个请求。
 *
 * @module lib/scheduler.js
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { pinnedAgent, streamChat } from './client.js'

/**
 * 账号级串行闸门：同一账号同一时刻只放行一个请求，其余排队。
 *
 * 为什么取消账号内并发（2026-10-02 决策）：TPM 是首要瓶颈，并发只会更快
 * 烧满分钟窗口引发 429；钉连（maxSockets:1）+ 顺序请求保住前缀缓存命中；
 * 横向吞吐由多账号轮换提供，账号内并发有害无益。abort 时排队者直接取消。
 */
class SerialGate {
  constructor() {
    this.busy = false
    this.waiters = []
  }
  /** 占用闸门；已占用则排队，abort 时 reject。 */
  acquire(signal) {
    if (!this.busy) {
      this.busy = true
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const waiter = () => {
        cleanup()
        this.busy = true
        resolve()
      }
      const onAbort = () => {
        const at = this.waiters.indexOf(waiter)
        if (at !== -1) this.waiters.splice(at, 1)
        cleanup()
        reject(new LlmError('dsh-sensenova: 排队等待已取消', 'ABORTED'))
      }
      const cleanup = () => signal?.removeEventListener('abort', onAbort)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }
  release() {
    this.busy = false
    this.waiters.shift()?.()
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); resolve() }, ms)
    const onAbort = () => { cleanup(); clearTimeout(t); reject(new LlmError('dsh-sensenova: 退避等待已取消', 'ABORTED')) }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** TPM 滚动窗口时长（实测约 1 分钟，429 报文不区分 TPM/RPM，只能客户端推断）。 */
const TPM_WINDOW_MS = 60_000

export class Scheduler {
  /**
   * @param {object} args
   * @param {() => Array<{label:string,key:string,enabled:boolean}>} args.listAccounts 运行期账号清单（凭据解析后）
   * @param {object} args.options 已解析配置（accountCooldownMs/rateLimitMode…；账号内串行无并发配置）
   * @param {(label:string, fact:object) => void} [args.onEvent] 调度事件（状态页/日志）
   * @param {{ onEmptyPool?: () => void, onKeyDead?: (label:string) => void }} [args.hooks]
   *   onEmptyPool：池空时每回合触发一次（按需登录抓 key 的入口，由实现方限频）；
   *   onKeyDead：key 被拒（401/403）后触发重抓（fire-and-forget，实现方限频）。
   * @param {typeof streamChat} [args.streamImpl] 测试注入
   */
  constructor({ listAccounts, options, onEvent, hooks, streamImpl = streamChat }) {
    this.listAccounts = listAccounts
    this.options = options
    this.onEvent = onEvent ?? (() => {})
    this.hooks = hooks ?? {}
    this.streamImpl = streamImpl
    /** label → 运行态 */
    this.accounts = new Map()
    /** label → 最近的 429 时间戳（状态页展示） */
    this.lastRateLimit = new Map()
    /** 空池回合只触发一次 onEmptyPool，出现可用账号后复位 */
    this.emptyPoolHandled = false
  }

  /** 取（或建）账号运行态；key 变化视为换 key（重置健康标记）。 */
  account(label, key, enabled, creditsRatio) {
    let acc = this.accounts.get(label)
    if (!acc) {
      acc = {
        label,
        gate: new SerialGate(),
        agent: pinnedAgent(),
        cooldownUntil: 0,
        key,
        keyStatus: 'ok',
        busy: false,
        lastUsedAt: 0,
        lastSessionId: undefined,
        creditsRatio: undefined,
        /** 60s 滚动 TPM 记账：[{at, tokens}]（usage chunk 喂入，判别 429 归因用） */
        spendLog: [],
      }
      this.accounts.set(label, acc)
    }
    if (key !== undefined && acc.key !== key) {
      acc.key = key
      acc.keyStatus = 'ok' // 新 key 重置健康（重抓后的覆写走这里）
    }
    if (enabled !== undefined) acc.enabled = enabled
    if (creditsRatio !== undefined) acc.creditsRatio = creditsRatio
    return acc
  }

  /**
   * 候选账号与选号评分（DESIGN.md §5.2）：
   *   会话粘性（保前缀温度，软粘性）> 5h 余量占比（无缓存视为中性）> 轮转。
   *   同账号串行由闸门保证（忙账号直接排除出候选池），故无"在途"排序键。
   */
  async candidates(now = Date.now(), sessionId) {
    const out = []
    for (const spec of await this.listAccounts()) {
      const acc = this.account(spec.label, spec.key, spec.enabled, spec.creditsRatio)
      if (acc.enabled === false) continue
      if (acc.keyStatus !== 'ok' || !acc.key) continue
      if (acc.cooldownUntil > now) continue
      out.push(acc)
    }
    const score = (acc) => {
      let value = 0
      if (sessionId !== undefined && acc.lastSessionId === sessionId) value += 1000
      // 余量越大分越高；无缓存（undefined）按中性 0 处理，不干扰排序
      value += ((acc.creditsRatio ?? 1) - 1) * 100
      return value
    }
    out.sort((a, b) =>
      score(b) - score(a)
      || a.lastUsedAt - b.lastUsedAt)
    return out
  }

  /**
   * 429 归因（报文不区分 TPM/RPM/繁忙，只能靠本插件自己的记账推断）：
   *   - 60s 滚动窗口内有成功消耗（usage chunk 实测值，缓存命中不计）→ 判 TPM：
   *     冷却到「当前窗口最早一笔消耗完全滚出窗口」的时刻，不盲等满 60s。
   *   - 窗口内零消耗（空窗 429）→ 本插件没烧过 TPM 还被拒，判服务侧繁忙：
   *     短冷却（= retryIntervalMs，默认 5s）继续轮换；全池都如此时自然退化为
   *     5s 间隔的轮换探测（429 不烧配额，轮换无害；间隔 5s 避免再触 RPM）。
   */
  markRateLimit(acc, now = Date.now()) {
    const spend = this.windowSpend(acc, now)
    const retry = this.options.retryIntervalMs ?? 5_000
    let kind
    let cooldownMs
    if (spend > 0) {
      kind = 'tpm'
      const releaseAt = acc.spendLog[0].at + TPM_WINDOW_MS
      cooldownMs = Math.min(Math.max(releaseAt - now, retry), this.options.accountCooldownMs)
    } else {
      kind = 'busy'
      cooldownMs = retry
    }
    acc.cooldownUntil = Math.max(acc.cooldownUntil, now + cooldownMs)
    this.lastRateLimit.set(acc.label, { at: now, kind, windowSpend: spend })
    this.onEvent(acc.label, { type: 'rate-limit', kind, windowSpend: spend })
  }

  /** 裁剪并汇总账号 60s 滚动窗口内的 TPM 消耗。 */
  windowSpend(acc, now = Date.now()) {
    const cutoff = now - TPM_WINDOW_MS
    acc.spendLog = acc.spendLog.filter((entry) => entry.at > cutoff)
    return acc.spendLog.reduce((sum, entry) => sum + entry.tokens, 0)
  }

  /**
   * 执行一次模型调用：选号 → 排队 → 流式 → 失败域处理 → 归还。
   * 返回 StreamChunk 异步迭代器。
   */
  stream(body, { sessionId, signal, purpose } = {}) {
    const self = this
    return (async function* () {
      const attempt = async function* () {
        let lastError
        while (true) {
          if (signal?.aborted) throw new LlmError('dsh-sensenova: 已取消', 'ABORTED')

          const all = await self.candidates(Date.now(), sessionId)
          const pool = all.filter((acc) => !acc.gate.busy)
          if (all.length > 0 && pool.length === 0) {
            // 账号都在忙（串行闸门占用）：短暂等待重扫，不属于"不可用"
            await sleep(150, signal)
            continue
          }
          if (pool.length === 0) {
            // 空池回合：给按需登录一次机会（实现方限频），每 episode 一次
            if (!self.emptyPoolHandled) {
              self.emptyPoolHandled = true
              try { self.hooks.onEmptyPool?.() } catch { /* 钩子自负 */ }
            }
            // 全池不可用：按终局模式分派。重试固定 5s 间隔（retryIntervalMs）——
            // 不再指数退避：密集重试本身会触 RPM，且 429 请求不烧配额，等待
            // 节奏对 TPM 滚动窗口的恢复速度没有影响（实测窗口 ~1 分钟）。
            if (self.options.rateLimitMode === 'failover-then-fail') {
              throw lastError ?? new LlmError('dsh-sensenova: 没有可用账号（未配置或凭据缺失）', 'MISSING_CREDENTIAL')
            }
            await sleep(self.options.retryIntervalMs ?? 5_000, signal)
            continue
          }
          self.emptyPoolHandled = false

          const acc = pool[0]
          await acc.gate.acquire(signal)
          acc.busy = true
          acc.lastUsedAt = Date.now()
          if (sessionId !== undefined) acc.lastSessionId = sessionId
          try {
            for await (const chunk of self.streamImpl({
              key: acc.key,
              agent: acc.agent,
              body,
              signal,
              onResponse: ({ status }) => {
                if (status === 429) self.markRateLimit(acc)
              },
            })) {
              if (chunk.type === 'usage' && chunk.usage) {
                // TPM 记账：缓存命中不计（实测命中 tokens 不计 TPM）；
                // reasoning tokens 已含在 completion_tokens 里，不重复加。
                const usage = chunk.usage
                const spend = Math.max(0, (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0)) + (usage.outputTokens ?? 0)
                if (spend > 0) acc.spendLog.push({ at: Date.now(), tokens: spend })
              }
              yield chunk
            }
            return
          } catch (error) {
            lastError = error
            if (error?.failure?.code === 'RATE_LIMIT') {
              // 冷却必须在这里兜底设置（不依赖 onResponse 记账——注入的流实现
              // 可能直接抛错），否则下一轮排序可能再次选中同一账号 → 死循环
              self.markRateLimit(acc)
              continue
            }
            if (error?.failure?.code === 'INVALID_CREDENTIAL') {
              acc.keyStatus = 'dead'
              self.onEvent(acc.label, { type: 'key-dead' })
              // fire-and-forget 重抓（实现方限频）；成功后 listAccounts 下轮带来新 key
              try { self.hooks.onKeyDead?.(acc.label) } catch { /* 钩子自负 */ }
              continue
            }
            if (error?.failure?.code === 'ABORTED') throw error
            // PROVIDER_UNAVAILABLE / PROVIDER_ERROR：短冷却换号
            acc.cooldownUntil = Date.now() + self.options.accountCooldownMs
            self.onEvent(acc.label, { type: 'provider-error', code: error?.failure?.code })
            continue
          } finally {
            acc.busy = false
            acc.gate.release()
          }
        }
      }
      yield* attempt()
    })()
  }

  dispose() {
    for (const acc of this.accounts.values()) {
      try { acc.agent.destroy() } catch { /* best effort */ }
    }
    this.accounts.clear()
  }

  /** 状态页快照：账号运行态 + 配置面账号（含未注入运行态的）。 */
  async snapshot(now = Date.now()) {
    const specs = await this.listAccounts()
    return specs.map((spec) => {
      const acc = this.accounts.get(spec.label)
      const limit = this.lastRateLimit.get(spec.label)
      return {
        label: spec.label,
        enabled: spec.enabled,
        keyConfigured: Boolean(spec.key),
        keySource: spec.keySource,
        credSource: spec.credSource,
        hasLoginCredentials: Boolean(spec.username && spec.password),
        keyStatus: acc?.keyStatus ?? (spec.key ? 'ok' : 'missing'),
        busy: Boolean(acc?.busy),
        cooldownRemainingMs: Math.max(0, (acc?.cooldownUntil ?? 0) - now),
        lastUsedAt: acc?.lastUsedAt ?? 0,
        lastSessionId: acc?.lastSessionId,
        lastRateLimitAt: limit?.at,
        lastRateLimitKind: limit?.kind,
        lastRateLimitWindowSpend: limit?.windowSpend,
        windowSpend: acc ? this.windowSpend(acc, now) : 0,
        creditsRatio: acc?.creditsRatio,
      }
    })
  }
}
