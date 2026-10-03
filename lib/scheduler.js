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

/** 429 报文中 tpm/rpm 超限的固定措辞（实测恒为 `inference exceeds tpm/rpm limit`）。
 *  只有这种报文且窗口消耗不足阈值，才判服务繁忙并固定（账号,模型）重试。 */
const RATE_LIMIT_BODY_RE = /tpm\/rpm/i

/** 空窗判定阈值（用户指定 16384）：60s 窗口本地消耗（缓存命中不计）低于它
 *  视为「没打满 TPM」→ 429 归服务繁忙；达到它才判 TPM 冷却。 */
const BUSY_SPEND_THRESHOLD = 16_384

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
    /** label → 最近的 429 时间戳与归因（状态页展示） */
    this.lastRateLimit = new Map()
    /** 空窗 429 固定账号表：model → label。限流桶按 账号×模型 划分
     * （cross-model-tpm.mjs 2026-10-03 实测：A 模型 429 后同账号 B 模型
     * 立即可用），所以空窗 429 只固定（账号, 模型）对——该模型留在原账号
     * 重试、不换账号也不换模型；其他模型照常选号 */
    this.busyHold = new Map()
    /** 已发过「同账号继续请求」事件的固定回合（label|model）：固定期间的
     *  重复 429 不再发事件（日志不刷屏）；冷却与 lastRateLimit 照常刷新 */
    this.busyLogged = new Set()
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
        key,
        keyStatus: 'ok',
        busy: false,
        lastUsedAt: 0,
        lastSessionId: undefined,
        creditsRatio: undefined,
        /** 模型 → {until, kind}：429 冷却按（账号, 模型）记账（桶按模型分） */
        cooldowns: new Map(),
        /** 模型 → [{at, tokens}]：60s 滚动 TPM 记账（usage chunk 喂入，429 归因用） */
        spendByModel: new Map(),
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
   *
   * 按（账号, 模型）过滤（cross-model-tpm.mjs 2026-10-03 实测：限流桶按
   * 账号×模型划分）：某模型 429 只冷却该账号上的该模型，其他模型照常选号。
   * 空窗 429 固定（busyHold）也按模型分键：该模型固定在原账号重试、不换
   * 账号——多账号轮番请求会被服务商误判为规避限流的滥用行为；固定账号
   * 不可用（停用/移除/key 失效）时恢复轮换。
   */
  async candidates(now = Date.now(), sessionId, model = '') {
    const healthy = []
    for (const spec of await this.listAccounts()) {
      const acc = this.account(spec.label, spec.key, spec.enabled, spec.creditsRatio)
      if (acc.enabled === false) continue
      if (acc.keyStatus !== 'ok' || !acc.key) continue
      healthy.push(acc)
    }
    let out = healthy
    const holdLabel = this.busyHold.get(model)
    if (holdLabel !== undefined) {
      const held = healthy.find((acc) => acc.label === holdLabel)
      if (held) out = [held]
      else this.releaseHold(model) // 固定账号已不可用，恢复正常轮换
    }
    const score = (acc) => {
      let value = 0
      if (sessionId !== undefined && acc.lastSessionId === sessionId) value += 1000
      // 余量越大分越高；无缓存（undefined）按中性 0 处理，不干扰排序
      value += ((acc.creditsRatio ?? 1) - 1) * 100
      return value
    }
    return out
      .filter((acc) => (acc.cooldowns.get(model)?.until ?? 0) <= now)
      .sort((a, b) =>
        score(b) - score(a)
        || a.lastUsedAt - b.lastUsedAt)
  }

  /**
   * 429 归因（全部按（账号, 模型）记账与冷却——限流桶按模型分）：
   *   - 该模型 60s 滚动窗口消耗（usage chunk 实测值，缓存命中不计）达到
   *     BUSY_SPEND_THRESHOLD 且当前未固定 → 判 TPM：冷却到「当前窗口最早
   *     一笔消耗完全滚出窗口」的时刻（不盲等满 60s），只冷却（账号, 模型），
   *     其他模型照常。
   *   - 消耗低于阈值（"空窗"：本地没打满 TPM）**且报文是 tpm/rpm 超限措辞**
   *     （实测恒为 `inference exceeds tpm/rpm limit`）→ 视为服务繁忙：短冷却
     *     （= retryIntervalMs）后**固定在（账号, 模型）对上重试**直到成功/
     *     手动中断——绝不换账号（多账号轮番请求会被服务商误判为规避限流
     *     的滥用行为），也不换模型。已固定期间再次 429 时保持固定。
   *   - 低消耗但报文措辞不符 → 未知 429：按 accountCooldownMs 冷却换号，不固定。
   *   固定的退出：成功（解除）/ signal 手动中断 / key 失效（自动解除换号）。
   * @param {string} [bodyText] 429 响应报文摘要（client 传入）
   * @returns {{kind:'tpm'|'busy'|'other', windowSpend:number}}
   */
  markRateLimit(acc, model = '', bodyText = '', now = Date.now()) {
    const spend = this.windowSpend(acc, model, now)
    const retry = this.options.retryIntervalMs ?? 5_000
    const held = this.busyHold.get(model) === acc.label
    let kind
    let cooldownMs
    if (spend >= BUSY_SPEND_THRESHOLD && !held) {
      kind = 'tpm'
      const log = acc.spendByModel.get(model)
      const releaseAt = log[0].at + TPM_WINDOW_MS
      cooldownMs = Math.min(Math.max(releaseAt - now, retry), this.options.accountCooldownMs)
    } else if (RATE_LIMIT_BODY_RE.test(bodyText ?? '')) {
      // 低消耗 429 且报文是 tpm/rpm 超限 → 视为服务繁忙，固定（账号, 模型）重复
      // 请求；已固定期间探测成功的少量消耗不算 TPM 归因（否则一次偶发成功
      // 就会换号，违背"固定直到成功/手动中断"）
      kind = 'busy'
      cooldownMs = retry
      this.busyHold.set(model, acc.label)
    } else {
      kind = 'other'
      cooldownMs = this.options.accountCooldownMs
    }
    const prev = acc.cooldowns.get(model)?.until ?? 0
    acc.cooldowns.set(model, { until: Math.max(prev, now + cooldownMs), kind })
    this.lastRateLimit.set(acc.label, { at: now, kind, model, windowSpend: spend })
    // 同一固定回合（label|model）只发一次事件——固定期间的重复 429 不刷日志
    const holdKey = `${acc.label}|${model}`
    const announce = kind !== 'busy' || !this.busyLogged.has(holdKey)
    if (kind === 'busy') this.busyLogged.add(holdKey)
    else this.busyLogged.delete(holdKey)
    if (announce) this.onEvent(acc.label, { type: 'rate-limit', kind, model, windowSpend: spend, cooldownMs })
    return { kind, windowSpend: spend }
  }

  /** 解除（账号, 模型）固定：清 busyHold 与对应的已记事件标记。 */
  releaseHold(model) {
    const label = this.busyHold.get(model)
    if (label === undefined) return
    this.busyHold.delete(model)
    this.busyLogged.delete(`${label}|${model}`)
  }

  /** 裁剪并汇总（账号, 模型）60s 滚动窗口内的 TPM 消耗。 */
  windowSpend(acc, model = '', now = Date.now()) {
    const cutoff = now - TPM_WINDOW_MS
    const log = (acc.spendByModel.get(model) ?? []).filter((entry) => entry.at > cutoff)
    acc.spendByModel.set(model, log)
    return log.reduce((sum, entry) => sum + entry.tokens, 0)
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

          const model = body.model ?? ''
          const all = await self.candidates(Date.now(), sessionId, model)
          const pool = all.filter((acc) => !acc.gate.busy)
          if (all.length > 0 && pool.length === 0) {
            // 账号都在忙（串行闸门占用）：短暂等待重扫，不属于"不可用"
            await sleep(150, signal)
            continue
          }
          if (pool.length === 0) {
            // 空池回合：给按需登录一次机会（实现方限频），每 episode 一次。
            // 空窗 429 固定重试期间池"空"只是该（账号,模型）在短冷却——不是
            // 真不可用：不触发登录钩子，也不按 mode B 快速失败（用户决策：
            // 服务繁忙就固定该账号一直请求，直到手动中断）。
            // holdAlive 查原始账号清单而非 candidates 输出——固定账号可能
            // 正处于自己的短冷却里，candidates 会把它过滤成空。
            const holdLabel = self.busyHold.get(model)
            const holdAlive = holdLabel !== undefined
              && (await self.listAccounts()).some((spec) => {
                if (spec.label !== holdLabel || spec.enabled === false || !spec.key) return false
                const held = self.accounts.get(holdLabel)
                return (held?.keyStatus ?? 'ok') === 'ok'
              })
            if (!holdAlive && !self.emptyPoolHandled) {
              self.emptyPoolHandled = true
              try { self.hooks.onEmptyPool?.() } catch { /* 钩子自负 */ }
            }
            if (self.options.rateLimitMode === 'failover-then-fail' && !holdAlive) {
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
          // 429 报文摘要：onResponse 先拿到（client 抛错前回传），catch 归因用
          let limitBodyText = ''
          try {
            for await (const chunk of self.streamImpl({
              key: acc.key,
              agent: acc.agent,
              body,
              signal,
              onResponse: ({ status, bodyText }) => {
                if (status === 429) limitBodyText = bodyText ?? ''
              },
            })) {
              if (chunk.type === 'usage' && chunk.usage) {
                // TPM 记账（按模型）：缓存命中不计（实测命中 tokens 不计 TPM）；
                // reasoning tokens 已含在 completion_tokens 里，不重复加。
                const usage = chunk.usage
                const spend = Math.max(0, (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0)) + (usage.outputTokens ?? 0)
                if (spend > 0) {
                  const log = acc.spendByModel.get(model) ?? []
                  log.push({ at: Date.now(), tokens: spend })
                  acc.spendByModel.set(model, log)
                }
              }
              yield chunk
            }
            // 成功：解除该模型的固定，恢复正常轮换
            if (self.busyHold.get(model) === acc.label) self.releaseHold(model)
            return
          } catch (error) {
            lastError = error
            if (error?.failure?.code === 'RATE_LIMIT') {
              // 冷却必须在这里兜底设置（不依赖 onResponse 记账——注入的流实现
              // 可能直接抛错），否则下一轮排序可能再次选中同一账号 → 死循环。
              // 报文文本优先取错误 facts（真 client 路径），回退 onResponse 摘要。
              self.markRateLimit(acc, model, error?.failure?.facts?.bodyText ?? limitBodyText)
              continue
            }
            if (error?.failure?.code === 'INVALID_CREDENTIAL') {
              acc.keyStatus = 'dead'
              // 该账号 key 失效：它在所有模型上的固定全部解除（换号）
              for (const [m, label] of [...self.busyHold]) {
                if (label === acc.label) self.releaseHold(m)
              }
              self.onEvent(acc.label, { type: 'key-dead' })
              // fire-and-forget 重抓（实现方限频）；成功后 listAccounts 下轮带来新 key
              try { self.hooks.onKeyDead?.(acc.label) } catch { /* 钩子自负 */ }
              continue
            }
            if (error?.failure?.code === 'ABORTED') throw error
            // PROVIDER_UNAVAILABLE / PROVIDER_ERROR：短冷却（账号,模型）换号
            acc.cooldowns.set(model, { until: Date.now() + self.options.accountCooldownMs, kind: 'provider-error' })
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
      const heldModels = [...this.busyHold]
        .filter(([, label]) => label === spec.label)
        .map(([model]) => model)
      const cooldowns = [...(acc?.cooldowns ?? [])]
        .filter(([, entry]) => entry.until > now)
        .map(([model, entry]) => ({ model, remainingMs: entry.until - now, kind: entry.kind }))
      return {
        label: spec.label,
        enabled: spec.enabled,
        keyConfigured: Boolean(spec.key),
        keySource: spec.keySource,
        credSource: spec.credSource,
        hasLoginCredentials: Boolean(spec.username && spec.password),
        keyStatus: acc?.keyStatus ?? (spec.key ? 'ok' : 'missing'),
        busy: Boolean(acc?.busy),
        // 汇总视图：最晚到期的冷却（旧字段保留，客户端徽章继续用）
        cooldownRemainingMs: cooldowns.reduce((max, c) => Math.max(max, c.remainingMs), 0),
        cooldowns,
        lastUsedAt: acc?.lastUsedAt ?? 0,
        lastSessionId: acc?.lastSessionId,
        lastRateLimitAt: limit?.at,
        lastRateLimitKind: limit?.kind,
        lastRateLimitModel: limit?.model,
        lastRateLimitWindowSpend: limit?.windowSpend,
        heldModels,
        windowSpend: acc
          ? [...acc.spendByModel.values()].reduce((sum, log) => sum + log.reduce((s2, e) => s2 + e.tokens, 0), 0)
          : 0,
        creditsRatio: acc?.creditsRatio,
      }
    })
  }
}
