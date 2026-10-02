/**
 * 管理路由行为单测（无网络）：
 *   GET /api/dsh-sensenova/models —— listModels 返回 {models, source?, error?}
 *   时路由正确透出结构（客户端据此判断"API 成功"还是"降级静态目录"）。
 *
 * makeRoutes 是纯函数，listModels 为注入参数，无需触碰全局 fetch 或
 * ESM 模块绑定时序。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { makeRoutes } from '../../lib/routes.js'

function callHandler(handler, req = { method: 'GET', headers: {} }) {
  const res = {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(payload) { this.payload = payload },
  }
  return handler(req, res).then(() => res)
}

const baseArgs = {
  snapshot: async () => [],
  resolveJwt: async () => undefined,
  refreshUsage: async () => undefined,
  refetchKey: async () => ({ key: 'k', refreshed: false }),
  saveConfig: async () => ({ ok: true }),
  saveAccount: async () => ({}),
  removeAccount: async () => ({}),
  logFile: '/dev/null',
  logger: { info() {}, warn() {}, error() {} },
}

function modelsRoute(routes) {
  return routes.find((r) => r.path === '/api/dsh-sensenova/models').handler
}

test('models 路由：listModels 返回 {models, source} → 结构透出', async () => {
  const listModels = async () => ({
    models: [
      { id: 'deepseek-v4-flash', enabled: true, contextWindow: 1048576, maxTokens: 65536 },
      { id: 'sensenova-6.8-flash-lite', enabled: false, contextWindow: 262144, maxTokens: 65536, inputModalities: ['text', 'image'] },
    ],
    source: 'api',
  })
  const routes = makeRoutes({ ...baseArgs, listModels })
  const res = await callHandler(modelsRoute(routes))
  const body = JSON.parse(res.payload)
  assert.equal(body.ok, true)
  assert.equal(body.value.source, 'api')
  assert.equal(body.value.models.length, 2)
  assert.equal(body.value.models[1].inputModalities[0], 'text')
})

test('models 路由：listModels 降级（source=static + error）→ 透出 error', async () => {
  const listModels = async () => ({
    models: [{ id: 'deepseek-v4-flash', enabled: true }],
    source: 'static',
    error: '没有可用 key，无法拉取模型目录',
  })
  const routes = makeRoutes({ ...baseArgs, listModels })
  const res = await callHandler(modelsRoute(routes))
  const body = JSON.parse(res.payload)
  assert.equal(body.ok, true)
  assert.equal(body.value.source, 'static')
  assert.ok(body.value.error.includes('没有可用 key'), '降级原因应透出')
})

test('models 路由：listModels 抛错 → 502 透出错误', async () => {
  const listModels = async () => { throw new Error('boom') }
  const routes = makeRoutes({ ...baseArgs, listModels })
  const res = await callHandler(modelsRoute(routes))
  assert.equal(res.status, 502)
  const body = JSON.parse(res.payload)
  assert.equal(body.ok, false)
  assert.ok(String(body.error).includes('boom'))
})

test('status 路由：调用 refreshUsageIfStale（打开设置页触发惰性刷新）', async () => {
  let staleCalls = 0
  const routes = makeRoutes({
    ...baseArgs,
    refreshUsageIfStale: async () => { staleCalls += 1 },
  })
  const statusHandler = routes.find((r) => r.path === '/api/dsh-sensenova/status').handler
  const res = await callHandler(statusHandler)
  assert.equal(res.status, 200)
  assert.equal(staleCalls, 1, 'status 路由应触发一次惰性刷新')
  const body = JSON.parse(res.payload)
  assert.equal(body.ok, true)
  assert.ok('usage' in body.value, '状态返回含 usage 快照')
})

test('status 路由：refreshUsageIfStale 抛错不影响状态返回', async () => {
  const routes = makeRoutes({
    ...baseArgs,
    refreshUsageIfStale: async () => { throw new Error('refresh boom') },
  })
  const statusHandler = routes.find((r) => r.path === '/api/dsh-sensenova/status').handler
  const res = await callHandler(statusHandler)
  assert.equal(res.status, 200, '刷新失败不 500')
  const body = JSON.parse(res.payload)
  assert.equal(body.ok, true)
})
