/**
 * dsh-sensenova — SenseNova Token Plan 账号池统一接入。
 *
 * provider id `sensenova-token-plans`：OpenAI 兼容端点 + 多账号调度（限流桶=账号，
 * 实测）+ 每账号 keep-alive 钉连（前缀缓存亲和）+ 按需凭据抓取（M3）。
 * 设计与实测依据见 DESIGN.md。
 *
 * @module dsh-sensenova
 */

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

import { DEFAULT_MODELS } from './models.js'
import {
  resolveAccounts, ensureAccountKey, refetchAfterKeyDead,
  refNames, accountLabelToRef,
  loadAccountRegistry, saveAccountRegistry, mergeAccountSkeletons,
  resolveUsableJwt, loginAndFetchKey,
} from './credentials.js'
import { SenseNovaAdapter } from './adapter.js'
import { Scheduler } from './scheduler.js'
import { createLogger } from './logger.js'
import { cachedDefaultPoolRatio, fetchPoolUsage } from './usage.js'
import { makeRoutes } from './routes.js'

export const name = 'dsh-sensenova'

/** `llm` 承载模型提供方注册；credentials 运行期动态取（可能晚挂载）。 */
export const inject = ['llm']

const MODEL_MODALITIES = ['text', 'image']

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1).default(128000),
  maxTokens: z.number().step(1).min(1).default(16384),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
})

export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('总开关：关掉后不注册模型提供方'),
  accounts: z.array(z.object({
    // 注意：外层 accounts 已是 volatile（Loader 传活引用），嵌套字段不得再
    // 声明 volatile——cordis 规则"volatile 字段要求不含外层 volatile 的固定路径"
    label: z.string().required(),
    username: z.string(),
    password: z.string().role('secret'),
    key: z.string().role('secret'),
    enabled: z.boolean().default(true),
  })).default([]).volatile().description('账号池（多账号轮换是横向扩容限流的唯一手段）'),
  models: z.array(catalogModel).default(DEFAULT_MODELS).volatile().description('模型目录（deepseek-v4-flash 主力）'),
  enabledModels: z.array(z.string()).default([]).volatile().description('启用的模型 id 列表（字符串数组；留空 = 全部启用）'),
  rateLimitMode: z.union(['wait-until-available', 'failover-then-fail']).default('wait-until-available').volatile()
    .description('全池 429 耗尽后的终局：等待直到可用 | 快速失败交 dsh 重试'),
  accountCooldownMs: z.number().min(0).default(60_000).volatile().description('429 后账号微冷却时长'),
  usagePollSeconds: z.number().min(60).default(300).volatile().description('状态页打开期间的用量刷新周期（无后台轮询）'),
  autoCreateKey: z.boolean().default(false).volatile().description('账号无可用 key 时自动创建（敏感操作，默认关）'),
  maxTokens: z.number().step(1).min(1).default(16384).volatile().description('目录外模型的默认 max_tokens（需覆盖 reasoning 预算）'),
  defaultContextWindow: z.number().step(1).min(1).default(128000).volatile().description('目录外模型的默认上下文窗口'),
  baseUrl: z.string().default('https://token.sensenova.cn/v1').volatile().description('推理端点'),
  retryPolicy: RetryPolicySchema,
})

/** 校验并规范化模型清单（照 dsh-zcode2api 的校验强度）。 */
function resolveModels(models) {
  const seen = new Set()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (typeof model.id !== 'string' || model.id.length === 0) throw new Error('dsh-sensenova: 模型 id 不能为空')
    if (seen.has(model.id)) throw new Error(`dsh-sensenova: 模型 "${model.id}" 重复`)
    seen.add(model.id)
    const inputModalities = model.inputModalities ?? ['text']
    if (inputModalities.length === 0) throw new Error(`dsh-sensenova: 模型 "${model.id}" 的 inputModalities 不能为空`)
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.description === undefined ? {} : { description: model.description }),
      contextWindow: model.contextWindow ?? 128000,
      maxTokens: model.maxTokens ?? 16384,
      inputModalities: [...inputModalities],
    }
  })
}

/** 把 Config 解析成运行期只读配置；非法值直接抛错。 */
export function resolveOptions(config) {
  const rateLimitMode = config.rateLimitMode ?? 'wait-until-available'
  if (!['wait-until-available', 'failover-then-fail'].includes(rateLimitMode)) {
    throw new Error('dsh-sensenova: rateLimitMode 必须是 wait-until-available 或 failover-then-fail')
  }
  // 启用过滤：目录内未列出的 id 静默忽略（目录本身可配置覆盖，不在这里校验）
  const catalog = resolveModels(config.models)
  const enabledIds = new Set(
    (Array.isArray(config.enabledModels) ? config.enabledModels : [])
      .map((id) => String(id).trim())
      .filter(Boolean),
  )
  return {
    enabled: config.enabled !== false,
    accounts: config.accounts ?? [],
    models: enabledIds.size > 0 ? catalog.filter((model) => enabledIds.has(model.id)) : catalog,
    rateLimitMode,
    accountCooldownMs: config.accountCooldownMs ?? 60_000,
    usagePollSeconds: config.usagePollSeconds ?? 300,
    autoCreateKey: config.autoCreateKey === true,
    maxTokens: config.maxTokens ?? 16384,
    defaultContextWindow: config.defaultContextWindow ?? 128000,
    baseUrl: (config.baseUrl ?? 'https://token.sensenova.cn/v1').trim() || 'https://token.sensenova.cn/v1',
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'dsh-sensenova: retryPolicy'),
  }
}

export function apply(ctx, config) {
  // 文件日志（插件目录 logs/）+ tee 到 dsh 宿主 logger（实测宿主不一定透出插件 info 行）
  const logger = createLogger(ctx.logger ?? console)
  logger.info(`dsh-sensenova: 加载，日志文件=${logger.logFile}`)

  // 配置热更新：非法改动不打挂正在跑的插件，保留上一份可用配置（照 zcode2api）。
  let lastRaw
  let lastGood
  const options = () => {
    const raw = resolveVolatile(config)
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      logger.error?.('dsh-sensenova: 配置非法，继续使用上一份可用配置')
      logger.error?.(error)
      return lastGood
    }
  }
  options()

  // 凭据解析：账号骨架 = config accounts ∪ 凭据中心注册表（设置页卡片创建的
  // 账号不进 config——schemastery 渲染不了对象数组），三轨填充（credentials/settings/env）
  const accountList = async () => {
    const registry = await loadAccountRegistry(ctx.get('credentials'))
    const skeleton = mergeAccountSkeletons(options().accounts, registry)
    return resolveAccounts(skeleton, ctx.get('credentials'))
  }

  // 按需登录（DESIGN.md §7.4）：只在 key 缺失（空池回合）或 key 失效时触发，
  // 由 ensureAccountKey 内部限频（10 分钟/账号）+ 并发去重，无任何后台定时器。
  const ensureHooks = () => ({ credentials: ctx.get('credentials'), logger })
  const ensurePendingAccounts = async () => {
    for (const acc of await accountList()) {
      if (!acc.enabled || acc.key) continue
      try {
        const result = await ensureAccountKey(acc, ensureHooks())
        // 立即注入调度器运行态（凭据中心写回失败时 key 在本次会话也可用）
        scheduler.account(acc.label, result.key, acc.enabled)
      } catch (error) {
        logger?.warn?.(`dsh-sensenova: 账号 ${acc.label} 自动抓取不可用：${error?.message ?? error}`)
      }
    }
  }
  const refetchDead = async (label) => {
    const acc = (await accountList()).find((a) => a.label === label)
    if (!acc) return
    try {
      const result = await refetchAfterKeyDead(acc, ensureHooks())
      scheduler.account(label, result.key, acc.enabled)
      logger?.info?.(`dsh-sensenova: 账号 ${label} key 重抓完成`)
    } catch (error) {
      logger?.warn?.(`dsh-sensenova: 账号 ${label} key 重抓失败：${error?.message ?? error}`)
    }
  }

  const scheduler = new Scheduler({
    listAccounts: async () => (await accountList())
      .map((acc) => ({ ...acc, creditsRatio: cachedDefaultPoolRatio(acc.label) }))
      .filter((acc) => acc.key !== ''),
    options: {
      get accountCooldownMs() { return options().accountCooldownMs },
      get rateLimitMode() { return options().rateLimitMode },
    },
    hooks: {
      onEmptyPool: () => { void ensurePendingAccounts() },
      onKeyDead: (label) => { void refetchDead(label) },
    },
    onEvent: (label, fact) => {
      if (fact.type === 'rate-limit') logger.warn?.(`dsh-sensenova: 账号 ${label} 429，冷却 ${options().accountCooldownMs}ms`)
      else if (fact.type === 'key-dead') logger.warn?.(`dsh-sensenova: 账号 ${label} key 被拒绝（401/403），已标记失效`)
    },
  })
  ctx.effect(() => () => scheduler.dispose(), 'dsh-sensenova: scheduler')

  // 管理面路由（free-search 桥模式）：状态 / 刷新用量 / 重抓 key / 日志尾部
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const routes = makeRoutes({
        snapshot: () => scheduler.snapshot(),
        resolveJwt: (label) => resolveUsableJwt(label, ctx.get('credentials')),
        refreshUsage: (label, jwt) => fetchPoolUsage({ label, jwt }),
        refetchKey: async (label) => {
          const acc = (await accountList()).find((a) => a.label === label)
          if (!acc) throw new Error(`账号 ${label} 不存在`)
          const result = await loginAndFetchKey({ label, username: acc.username, password: acc.password, credentials: ctx.get('credentials'), logger })
          scheduler.account(label, result.key, acc.enabled)
          return result
        },
        // ── 设置页账号管理（凭据中心注册表）───────────────────────────
        listAccountInfo: async () => {
          const registry = await loadAccountRegistry(ctx.get('credentials'))
          const registryLabels = new Set(registry.map((e) => accountLabelToRef(e.label)))
          const accounts = await accountList()
          const settingsOnly = options().accounts
            .map((a) => accountLabelToRef(a.label))
            .filter((label) => !accounts.some((acc) => acc.label === label))
            .map((label) => ({ label, enabled: true, source: 'settings', hasUsername: false, hasPassword: false, hasKey: false }))
          return [
            ...settingsOnly,
            ...accounts.map((acc) => ({
              label: acc.label,
              enabled: acc.enabled,
              source: registryLabels.has(acc.label) ? 'credentials' : 'settings',
              username: acc.username,
              hasUsername: acc.username !== '',
              hasPassword: acc.password !== '',
              hasKey: acc.key !== '',
              keyStatus: acc.key === '' ? 'missing' : undefined,
            })),
          ]
        },
        saveAccount: async ({ label, username, password, enabled = true }) => {
          const credentials = ctx.get('credentials')
          const seg = accountLabelToRef(label)
          const refs = refNames(seg)
          if (!username || !String(username).trim()) throw new Error('用户名不能为空')
          await credentials.set(refs.username, String(username).trim())
          if (password) await credentials.set(refs.password, String(password))
          const registry = await loadAccountRegistry(credentials)
          const next = registry.filter((entry) => accountLabelToRef(entry.label) !== seg)
          next.push({ label: seg, enabled: enabled !== false })
          await saveAccountRegistry(credentials, next)
          logger.info?.(`dsh-sensenova: 账号 ${seg} 凭据已写入凭据中心`)
          // 立即登录抓 key；失败不回滚——凭据已落库，空池回合会自动重试
          try {
            const acc = (await accountList()).find((a) => a.label === seg)
            const result = await loginAndFetchKey({ label: seg, username: acc.username, password: acc.password, credentials, logger })
            scheduler.account(seg, result.key, enabled !== false)
            return { label: seg, saved: true, keyUpdated: true }
          } catch (error) {
            return { label: seg, saved: true, keyUpdated: false, loginError: error?.message ?? String(error) }
          }
        },
        removeAccount: async (label) => {
          const seg = accountLabelToRef(label)
          const credentials = ctx.get('credentials')
          const registry = await loadAccountRegistry(credentials)
          if (!registry.some((entry) => accountLabelToRef(entry.label) === seg)) {
            throw new Error(`账号 ${seg} 不在页面账号清单中（config 配置的账号请在配置里删除）`)
          }
          await saveAccountRegistry(credentials, registry.filter((entry) => accountLabelToRef(entry.label) !== seg))
          logger.info?.(`dsh-sensenova: 账号 ${seg} 已从清单移除（凭据中心 refs 保留，可手动清理）`)
          return { label: seg, removed: true }
        },
        logFile: logger.logFile,
        logger,
      })
      const disposers = routes.map((route) => sctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-sensenova: management routes')
    })
  }

  const adapter = new SenseNovaAdapter({
    options,
    scheduler,
    resolveAttachments: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined),
    logger,
  })

  if (options().enabled) {
    const entryNs = ctx.fiber?.entry?.options?.id ?? name
    ctx.llm.registerConfigurableProviders([{
      provider: 'sensenova-token-plans',
      displayName: 'SenseNova Token Plans',
      settingsNs: entryNs,
      settingsPath: [],
    }])
    ctx.llm.registerAdapter(['sensenova-token-plans'], adapter)
    logger.info?.(
      `dsh-sensenova: provider 已注册，模型=${options().models.map((m) => m.id).join('/')}`,
    )
    // 账号清单需读凭据中心注册表（页面创建的账号），异步补一条准确计数
    void accountList().then((list) => {
      logger.info?.(`dsh-sensenova: 账号=${list.length} 个（config + 页面注册表，有 key 的经调度可用）`)
    })
  } else {
    logger.info?.('dsh-sensenova: 已加载但 enabled=false，未注册 provider')
  }
}

/** 解开 rc.1 Loader 传给 .volatile() 字段的活引用（照 dsh-free-search）。 */
function resolveVolatile(config) {
  if (config === null || typeof config !== 'object') return {}
  const out = Array.isArray(config) ? [] : {}
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return out
}

export { SenseNovaAdapter, Scheduler, DEFAULT_MODELS }
export default { name, inject, Config, apply }
