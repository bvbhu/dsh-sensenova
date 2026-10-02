/**
 * apply() 冒烟：mock ctx 验证插件加载与注册路径，不发起任何网络请求。
 * 用于改 profile patch 前的本地校验。
 */

import { apply, resolveOptions } from '../../lib/index.js'

const calls = { providers: [], adapters: [] }
const ctx = {
  logger: console,
  get: () => undefined,
  effect: (fn, tag) => { ctx.effects = ctx.effects ?? []; ctx.effects.push({ fn, tag }) },
  inject: (services, fn) => {
    const sctx = { effect: (fn2, tag2) => ctx.effects.push({ fn: fn2, tag: tag2 }), webServer: { registered: [] } }
    sctx.webServer.register = (route) => { sctx.webServer.registered.push(route.path); return () => {} }
    fn(sctx)
    ctx.injected = ctx.injected ?? []
    ctx.injected.push({ services, sctx })
  },
  fiber: { entry: { options: { id: 'sensenova' } } },
  llm: {
    registerConfigurableProviders: (entries) => calls.providers.push(...entries),
    registerAdapter: (routes, adapter) => calls.adapters.push({ routes, adapter }),
  },
}

const config = {
  enabled: true,
  accounts: [
    { label: 'ACC1', username: 'u1', password: 'p1', key: '' },
    { label: 'ACC2', key: 'sk-test', enabled: true },
  ],
}

apply(ctx, config)

console.log('providers:', calls.providers.map((p) => `${p.provider}(${p.displayName}, ns=${p.settingsNs})`))
console.log('adapters:', calls.adapters.map((a) => a.routes.join('/')))
console.log('effects:', (ctx.effects ?? []).map((e) => e.tag))

// resolveOptions 校验
const opts = resolveOptions(config)
console.log('options:', {
  models: opts.models.map((m) => `${m.id}@${m.contextWindow}`).join(' / '),
  rateLimitMode: opts.rateLimitMode,
})

// 非法配置：不应抛（lastGood 兜底在 apply 内；resolveOptions 直接抛）
try {
  resolveOptions({ rateLimitMode: 'bogus' })
  console.log('ERROR: 非法配置未被拒绝')
} catch (error) {
  console.log('非法配置正确拒绝:', error.message)
}

if (calls.providers.length !== 1 || calls.adapters.length !== 1) {
  console.error('注册不完整')
  process.exit(1)
}
// 执行记录的 effect（真实宿主在 fiber 挂载时执行）
for (const { fn } of ctx.effects ?? []) { try { fn() } catch {} }
const injected = ctx.injected?.[0]
console.log('注入服务:', injected?.services.join(','))
console.log('注册路由:', injected?.sctx.webServer.registered.join(', '))
if (injected?.sctx.webServer.registered.length !== 7) {
  console.error('管理路由数量不对')
  process.exit(1)
}
console.log('SMOKE OK')
