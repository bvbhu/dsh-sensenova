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

import { DEFAULT_MODELS, discoverModels } from './models.js'
import {
  resolveAccounts, ensureAccountKey, refetchAfterKeyDead,
  accountLabelToRef, ACCOUNTS_REGISTRY_REF,
  loadAccountRegistry, saveAccountRegistry,
  resolveUsableJwt, loginAndFetchKey,
} from './credentials.js'
import { SenseNovaAdapter } from './adapter.js'
import { Scheduler } from './scheduler.js'
import { createLogger } from './logger.js'
import { cachedDefaultPoolRatio, fetchPoolUsage, cachedUsageSnapshot } from './usage.js'
import { makeRoutes } from './routes.js'

// ── 孤儿写锁恢复 ────────────────────────────────────────────────────────────
// settings.mutate 落盘走宿主 dsh-atomic-write：竞争者只等不清锁（"orphan
// recovery is an operator action"），持有进程崩溃后 <file>.lock 永久残留，
// 之后所有插件的 settings 保存都会超时失败。这里做安全的操作员动作：
// 仅当锁内 PID 可证明已死（kill(pid,0) 报 ESRCH）才删锁重试一次。
const WRITER_LOCK_RE = /atomic-write: timed out waiting for the writer lock at (.+)/

/** 进程存活探测：ESRCH = 不存在；EPERM = 存在但无权发信号（视为存活）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 识别写锁超时错误并尝试清除孤儿锁。
 * @returns {Promise<boolean>} true = 已清除孤儿锁，调用方可重试原操作
 */
export async function recoverStaleWriterLock(error, logger) {
  const match = WRITER_LOCK_RE.exec(error?.message ?? '')
  if (!match) return false
  const lockPath = match[1].trim()
  try {
    const { readFile, rm } = await import('node:fs/promises')
    const pid = Number.parseInt((await readFile(lockPath, 'utf8')).trim(), 10)
    // PID 非法 / 是自己 / 仍存活：不动锁（宁可继续失败也不误删活锁）
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || pidAlive(pid)) return false
    await rm(lockPath, { force: true })
    logger?.warn?.(`dsh-sensenova: 清除孤儿写锁 ${lockPath}（持有进程 ${pid} 已退出），重试写入`)
    return true
  } catch {
    return false
  }
}

/** 写锁仍被占用时的错误提示（指向操作员动作）。 */
function writerLockHint(error) {
  const match = WRITER_LOCK_RE.exec(error?.message ?? '')
  return match
    ? `${error.message}（写锁被其他进程占用：确认没有 dsh 实例正在写配置后，可手动删除 ${match[1].trim()}）`
    : error?.message ?? String(error)
}


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
  models: z.array(catalogModel).default(DEFAULT_MODELS).volatile().description('模型目录（deepseek-v4-flash 主力；API 不可用时的降级）'),
  enabledModels: z.array(z.string()).default([]).volatile().description('启用的模型 id 列表（字符串数组；留空 = 全部启用）'),
  imageModels: z.array(z.string()).default([]).volatile().description('手动指定的图像模型 id 列表（API 未标注但确支持图像输入时手动补；刷新目录不被 API 覆盖）'),
  rateLimitMode: z.union(['wait-until-available', 'failover-then-fail']).default('wait-until-available').volatile()
    .description('全池 429 耗尽后的终局：等待直到可用 | 快速失败交 dsh 重试'),
  accountCooldownMs: z.number().min(0).default(60_000).volatile().description('429 后账号微冷却时长上限（TPM 归因时按窗口释放时刻缩短）'),
  retryIntervalMs: z.number().min(100).default(5_000).volatile().description('429/空池重试间隔（固定 5s，避免密集重试触发 RPM）'),
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
  // 启用过滤：目录内未列出的 id 静默忽略（目录本身可配置覆盖，不在这里校验）。
  // 模态（含图像）由 API 返回值决定，不在此人工指定。
  const catalog = resolveModels(config.models)
  const enabledIds = new Set(
    (Array.isArray(config.enabledModels) ? config.enabledModels : [])
      .map((id) => String(id).trim())
      .filter(Boolean),
  )
  const imageIds = new Set(
    (Array.isArray(config.imageModels) ? config.imageModels : [])
      .map((id) => String(id).trim())
      .filter(Boolean),
  )
  return {
    enabled: config.enabled !== false,
    catalog,
    // configCatalog：配置里显式声明的目录（config.models），用于判定
    // 「手动指定的图像模型」——不被 API 发现结果污染，否则 API 撤回 image
    // 时无法恢复（手动指定应保持，未指定的才以 API 为准）。
    configCatalog: catalog,
    enabledModelIds: enabledIds,
    imageModelIds: imageIds,
    models: enabledIds.size > 0 ? catalog.filter((model) => enabledIds.has(model.id)) : catalog,
    rateLimitMode,
    accountCooldownMs: config.accountCooldownMs ?? 60_000,
    retryIntervalMs: config.retryIntervalMs ?? 5_000,
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

  // 模型目录状态：discovered = 实际生效目录（API 发现优先于 config 静态目录）。
  // 必须在 options() 之前声明——options() 会用 discovered 覆盖目录，
  // 否则「启用过滤」基于过期的 config 静态目录，启用 API 新模型不生效。
  let discovered = null
  let discovering = null
  let lastDiscoveryError = null

  // 配置热更新：非法改动不打挂正在跑的插件，保留上一份可用配置（照 zcode2api）。
  let lastRaw
  let lastGood
  /**
   * 以「实际生效目录」为准的输出：API 发现成功时目录 = discovered，
   * 否则才是 config 静态目录。关键点——启用过滤（models）必须基于实际目录，
   * 否则用户启用了 API 发现的新模型（不在 config.models 里）会被过滤掉，
   * 且 adapter 的模型列表/能力参数会退回静态目录与兜底值 → 「保存不生效」。
   */
  const effectiveOptions = (opts) => {
    if (!discovered || discovered.length === 0) return opts
    const enabledIds = opts.enabledModelIds
    return {
      ...opts,
      catalog: discovered,
      models: enabledIds.size > 0 ? discovered.filter((model) => enabledIds.has(model.id)) : discovered,
    }
  }
  const options = () => {
    const raw = resolveVolatile(config)
    if (raw === lastRaw && lastGood !== undefined) return effectiveOptions(lastGood)
    try {
      const next = resolveOptions(raw)
      lastRaw = raw
      lastGood = next
      return effectiveOptions(next)
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      logger.error?.('dsh-sensenova: 配置非法，继续使用上一份可用配置')
      logger.error?.(error)
      return effectiveOptions(lastGood)
    }
  }
  options()

  // 凭据解析：账号清单只来自凭据中心注册表（设置页「账号管理」维护，
  // 因为 schemastery 表单渲染不了对象数组）；用户名/密码内嵌注册表条目，
  // key 按 SENSENOVA_<label>_KEY ref 或环境变量解析。
  const accountList = async () => {
    const registry = await loadAccountRegistry(ctx.get('credentials'))
    return resolveAccounts(registry, ctx.get('credentials'))
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
      get retryIntervalMs() { return options().retryIntervalMs },
      get rateLimitMode() { return options().rateLimitMode },
    },
    hooks: {
      onEmptyPool: () => { void ensurePendingAccounts() },
      onKeyDead: (label) => { void refetchDead(label) },
    },
    onEvent: (label, fact) => {
      if (fact.type === 'rate-limit') {
        const head = `dsh-sensenova: ${label} ${fact.model}`
        if (fact.kind === 'busy') logger.info?.(`${head} TPM:${fact.windowSpend} 返回tpm/rpm超限，同账号继续请求`)
        else if (fact.kind === 'tpm') logger.info?.(`${head} TPM:${fact.windowSpend} 返回tpm/rpm超限，冷却${Math.ceil(fact.cooldownMs / 1000)}秒`)
        else logger.warn?.(`${head} 429（报文非 tpm/rpm 超限措辞），冷却换号`)
      } else if (fact.type === 'key-dead') logger.warn?.(`dsh-sensenova: 账号 ${label} key 被拒绝（401/403），已标记失效`)
    },
  })
  ctx.effect(() => () => scheduler.dispose(), 'dsh-sensenova: scheduler')

  // 模型目录：启动时从 /v1/models 拉一次（API 发现，照 dsh-connect-trae），
  // 失败降级为静态 DEFAULT_MODELS 目录。registerModelDiscovery / 设置页共用。
  // （discovered / discovering / lastDiscoveryError 已声明在 options() 之前）
  const discover = async (opts = {}) => {
    if (discovering) return discovering
    discovering = (async () => {
      try {
        // 有界等待可用 key（仅启动调用开启 waitForKeyMs）：credentials 服务可能
        // 晚于本插件挂载（跨 bundle 顺序），启动瞬间账号 key 为空会静默降级。
        const deadline = Date.now() + (opts.waitForKeyMs ?? 0)
        let usable
        while (true) {
          const accounts = await accountList()
          usable = accounts.find((acc) => acc.enabled && acc.key !== '')
          if (usable || Date.now() >= deadline) break
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
        if (!usable) throw new Error('没有可用 key，无法拉取模型目录')
        lastDiscoveryError = null
        const apiModels = await discoverModels({
          baseUrl: options().baseUrl,
          key: usable.key,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        })
        // merge 手动指定：config.models[].inputModalities 或 imageModels 里
        // 标了 image 的模型，API 目录刷新后保持 image（手动指定不被 API
        // 覆盖）；未指定的以 API 为准。
        const manualVision = new Set([
          // 用 configCatalog（配置显式声明的目录）而非 options().catalog
          // ——后者已被 discovered 覆盖，会把「API 标注的 image」误判成手动
          // 指定而永久保留；未指定的模型须以 API 为准（API 撤回即移除）。
          ...(options().configCatalog ?? [])
            .filter((m) => (m.inputModalities ?? []).includes('image'))
            .map((m) => m.id),
          ...options().imageModelIds,
        ])
        discovered = apiModels.map((model) => {
          if (!manualVision.has(model.id)) return model
          const mods = model.inputModalities ?? []
          return mods.includes('image') ? model : { ...model, inputModalities: [...mods, 'image'] }
        })
        logger.info?.(`dsh-sensenova: 模型目录已从 API 拉取（${discovered.length} 个，含 ${manualVision.size} 个手动指定图像）`)
      } catch (error) {
        lastDiscoveryError = error?.message ?? String(error)
        logger.warn?.(`dsh-sensenova: API 模型目录拉取失败（${lastDiscoveryError}），用静态目录`)
      } finally {
        discovering = null
      }
    })()
    return discovering
  }

  // 余量惰性刷新（打开设置页时由 status 路由触发；不再启动时硬拉）。
  // 为什么不在启动时刷新：credentials 服务可能晚于本插件挂载（跨 bundle
  // 顺序），启动瞬间既解析不到 JWT 也解析不到登录凭据，硬拉只会空等后
  // 全跳过（此前「启动后余量没刷新」的根因）。用户打开设置页时宿主
  // 服务早已就绪，此时触发最可靠。
  //
  // 触发语义：status 路由每次被调用（客户端打开设置页即 GET /status）时，
  // 若余量缓存为空或超过 usagePollSeconds 未更新，则逐个启用账号拉一次
  // （有 JWT 直接拉；无 JWT 但有登录凭据则登录后拉）。force 强制重拉。
  let usageRefreshInflight = null
  const refreshUsageIfStale = async ({ force = false } = {}) => {
    if (usageRefreshInflight) return usageRefreshInflight
    usageRefreshInflight = (async () => {
      try {
        const stale = force || (await accountList()).some((acc) => {
          if (!acc.enabled) return false
          const entry = cachedUsageSnapshot(acc.label)
          return !entry || Date.now() - entry.at > (options().usagePollSeconds * 1000)
        })
        if (!stale) return
        // 严格串行（用户决策：不并行登录，避免被服务商误判为滥用）；冷启动
        // JWT 不在内存时这里是 N 场顺序 OAuth 登录，页面用骨架屏等待。结果
        // 聚合成一行，失败/跳过仍单独 warn（罕见且需要定位）
        let ok = 0
        let total = 0
        for (const acc of await accountList()) {
          if (!acc.enabled) continue
          total += 1
          const jwt = resolveUsableJwt(acc.label)
          if (jwt) {
            try {
              const entry = await fetchPoolUsage({ label: acc.label, jwt })
              if (entry) ok += 1
              else logger.warn?.(`dsh-sensenova: 余量刷新 ${acc.label} 拉取失败（pool-usage 返回空）`)
            } catch (error) {
              logger?.warn?.(`dsh-sensenova: 余量刷新 ${acc.label} 失败（${error?.message ?? error}）`)
            }
            continue
          }
          // 无 JWT：有用户名/密码则无条件登录（JWT 进内存 + 顺带拉余量）。
          // 不用 ensureAccountKey——它有 key 会短路（只认 key 不补 JWT）。
          if (acc.username && acc.password) {
            try {
              await loginAndFetchKey({
                label: acc.label,
                username: acc.username,
                password: acc.password,
                credentials: ctx.get('credentials'),
                logger,
              })
              ok += 1
            } catch (error) {
              logger?.warn?.(`dsh-sensenova: 账号 ${acc.label} 余量刷新跳过（登录不可用：${error?.message ?? error}）`)
            }
          } else {
            logger?.warn?.(`dsh-sensenova: 账号 ${acc.label} 余量刷新跳过（无 JWT 且无登录凭据）`)
          }
        }
        logger.info?.(`dsh-sensenova: 惰性余量刷新 ${ok}/${total}账号成功（设置页/status 触发）`)
      } finally {
        usageRefreshInflight = null
      }
    })()
    return usageRefreshInflight
  }
  // 启动：目录发现等待凭据就绪（有界），避免晚挂载竞态。余量不再启动
  // 时拉——打开设置页（GET /status）才惰性刷新，天然绕开晚挂载。
  void discover({ waitForKeyMs: 15_000 })

  // 管理面路由（free-search 桥模式）：状态 / 刷新用量 / 重抓 key / 日志尾部
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const routes = makeRoutes({
        snapshot: () => scheduler.snapshot(),
        resolveJwt: (label) => resolveUsableJwt(label),
        // refresh-usage 的自动登录：内存无 JWT（重启后常态）时现场登录一次
        ensureJwt: async (label) => {
          const acc = (await accountList()).find((a) => a.label === label)
          if (!acc) throw new Error(`账号 ${label} 不在账号清单中`)
          await loginAndFetchKey({ label, username: acc.username, password: acc.password, credentials: ctx.get('credentials'), logger })
          return resolveUsableJwt(label)
        },
        refreshUsage: (label, jwt) => fetchPoolUsage({ label, jwt }),
        refreshUsageIfStale: (opts) => refreshUsageIfStale(opts),
        refetchKey: async (label) => {
          const acc = (await accountList()).find((a) => a.label === label)
          if (!acc) throw new Error(`账号 ${label} 不存在`)
          const result = await loginAndFetchKey({ label, username: acc.username, password: acc.password, credentials: ctx.get('credentials'), logger })
          scheduler.account(label, result.key, acc.enabled)
          return result
        },
        // ── 配置写回（照 dsh-connect-workbuddy 的 __save 端点）──────────
        // 设置页勾选经此在宿主进程内写 enabledModels——客户端 configForms
        // scope 在 0.1.7 上不可靠，Host mutate 才是唯一可靠写者。
        saveConfig: async ({ field, value }) => {
          if (field !== 'enabledModels' && field !== 'imageModels') {
            return { ok: false, error: '仅支持写入 enabledModels / imageModels' }
          }
          const settings = ctx.get?.('settings')
          if (!settings) return { ok: false, error: 'settings 服务不可用' }
          let ns
          try {
            const row = settings.describe().find((r) => /sensenova/i.test(String(r.ns ?? '')))
            ns = row?.ns
          } catch {
            ns = undefined
          }
          if (!ns) return { ok: false, error: 'settings 中没有 dsh-sensenova 命名空间' }
          const writeField = () => settings.mutate(ns, [{ op: 'set', path: [field], value }], undefined)
          try {
            await writeField()
          } catch (error) {
            // 孤儿写锁（持有进程已崩）会让保存永久超时——清锁后重试一次
            if (!(await recoverStaleWriterLock(error, logger))) {
              return { ok: false, error: writerLockHint(error) }
            }
            try {
              await writeField()
            } catch (retryError) {
              return { ok: false, error: writerLockHint(retryError) }
            }
          }
          logger.info?.(`dsh-sensenova: 配置 ${field} 已写入（${value.length} 个模型）`)
          return { ok: true }
        },
        // ── 设置页模型列表（API 发现全量目录 + 启用状态）───────────────
        // 刷新语义：每次请求都主动触发一次 discover（discover 内部去重，
        // 并发安全），保证「刷新目录」按钮重新调 API 而不是读启动时的旧
        // 目录；发现失败时返回静态目录并透出降级原因。
        listModels: async () => {
          const pending = discover()
          await pending
          const opts = options()
          const rows = discovered ?? opts.catalog
          const enabled = opts.enabledModelIds
          const active = new Set(opts.models.map((m) => m.id))
          return {
            models: rows.map((model) => ({
              ...model,
              enabled: enabled.size === 0 || active.has(model.id),
              image: (model.inputModalities ?? []).includes('image'),
            })),
            source: discovered ? 'api' : 'static',
            ...(discovered ? {} : lastDiscoveryError ? { error: lastDiscoveryError } : {}),
          }
        },
        // ── 状态页模型状态（（账号,模型）粒度冷却的展示面）─────────────
        // 每个暴露给 dsh 的模型：几个账号空闲 / 正在请求 / 冷却中。
        // eligible 与调度器候选同判（enabled + key ok）；busy 在别的模型上
        // 的账号不计入这三种状态（既不算请求中也不算空闲）。
        modelStatus: async () => {
          const opts = options()
          const rows = discovered ?? opts.catalog
          const enabled = opts.enabledModelIds
          const active = new Set(opts.models.map((m) => m.id))
          const eligible = (await scheduler.snapshot()).filter((a) => a.enabled && a.keyStatus === 'ok')
          return rows
            .filter((m) => enabled.size === 0 || active.has(m.id))
            .map((m) => {
              let notCooling = 0
              let requesting = 0
              let idle = 0
              for (const acc of eligible) {
                const cooling = (acc.cooldowns ?? []).some((c) => c.model === m.id && c.remainingMs > 0)
                if (cooling) continue
                notCooling += 1
                // 三态互斥全覆盖（idle+requesting+cooling === total）：账号忙于
                // 其他模型不影响本模型的额度池（桶按 账号×模型 划分，探针实测）
                // → 对本模型仍算空闲
                if (acc.busy && acc.inflightModel === m.id) requesting += 1
                else idle += 1
              }
              return {
                id: m.id,
                name: m.name ?? m.id,
                total: eligible.length,
                notCooling,
                idle,
                requesting,
                cooling: eligible.length - notCooling,
              }
            })
        },
        // ── 设置页账号管理（凭据中心注册表）───────────────────────────
        listAccountInfo: async () => {
          const accounts = await accountList()
          return accounts.map((acc) => ({
            label: acc.label,
            enabled: acc.enabled,
            source: 'credentials',
            username: acc.username,
            hasUsername: acc.username !== '',
            hasPassword: acc.password !== '',
            hasKey: acc.key !== '',
            keyStatus: acc.key === '' ? 'missing' : undefined,
          }))
        },
        saveAccount: async ({ label, username, password, enabled = true }) => {
          const credentials = ctx.get('credentials')
          const seg = accountLabelToRef(label)
          if (!username || !String(username).trim()) throw new Error('用户名不能为空')
          const registry = await loadAccountRegistry(credentials)
          const existing = registry.find((entry) => accountLabelToRef(entry.label) === seg)
          // 用户名/密码内嵌注册表条目（不再落独立 refs）；密码留空 = 保留原密码
          const nextPassword = password ? String(password) : existing?.password
          if (!nextPassword) throw new Error('密码不能为空（首次保存必填）')
          const next = registry.filter((entry) => accountLabelToRef(entry.label) !== seg)
          next.push({ label: seg, enabled: enabled !== false, username: String(username).trim(), password: nextPassword })
          await saveAccountRegistry(credentials, next)
          logger.info?.(`dsh-sensenova: 账号 ${seg} 凭据已写入 ${ACCOUNTS_REGISTRY_REF}`)
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
            throw new Error(`账号 ${seg} 不在账号清单中`)
          }
          await saveAccountRegistry(credentials, registry.filter((entry) => accountLabelToRef(entry.label) !== seg))
          logger.info?.(`dsh-sensenova: 账号 ${seg} 已从清单移除（其 SENSENOVA_${seg}_KEY ref 保留，可手动清理）`)
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
    // 把插件 Config 注册进 settings 服务（照 dsh-connect-workbuddy）：
    // 没有这一步，settings.describe() 里不会有 dsh-sensenova 命名空间，
    // saveConfig 的 settings.mutate 无处可写 → 「模型列表无法保存」。
    if (typeof ctx.inject === 'function') {
      ctx.inject(['settings'], (sctx) => {
        const settings = sctx.settings
        ctx.effect(() => settings.configure({ auto: true }, ctx.fiber), 'dsh-sensenova: settings configure')
      })
    }
    ctx.llm.registerConfigurableProviders([{
      provider: 'sensenova-token-plans',
      displayName: 'SenseNova Token Plans',
      settingsNs: entryNs,
      settingsPath: [],
    }])
    ctx.llm.registerAdapter(['sensenova-token-plans'], adapter)
    // 模型发现（dsh-connect-trae 同款）：模型选择器从 API 实时拉取目录，
    // 应用 enabledModels 勾选后返回；模态（含图像）直接采用 API 返回值。
    if (typeof ctx.llm.registerModelDiscovery === 'function') {
      ctx.llm.registerModelDiscovery(entryNs, async (request, signal) => {
        // 先持有 discover() 返回的 promise 再 await：discover 的 finally 会把
        // discovering 置 null，直接 await discovering 在并发下可能拿到 null
        const pending = discover()
        await pending
        const opts = options()
        const rows = discovered ?? opts.catalog
        const enabled = opts.enabledModelIds
        const active = new Set(opts.models.map((m) => m.id))
        return rows
          .filter((model) => enabled.size === 0 || active.has(model.id))
          .map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
            ...(model.description ? { description: model.description } : {}),
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            inputModalities: model.inputModalities ?? ['text'],
          }))
      })
    }
    logger.info?.(
      `dsh-sensenova: provider 已注册，模型=${options().models.map((m) => m.id).join('/')}`,
    )
    // 账号清单需读凭据中心注册表（页面创建的账号），异步补一条准确计数
    void accountList().then((list) => {
      logger.info?.(`dsh-sensenova: 账号=${list.length} 个（凭据中心注册表，有 key 的经调度可用）`)
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
