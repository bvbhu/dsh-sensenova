/**
 * 管理面 HTTP 路由（free-search 的 webServer.register 桥模式）：
 *
 *   GET  /api/dsh-sensenova/status        账号池快照 + 余量缓存 + 日志尾部
 *   POST /api/dsh-sensenova/refresh-usage 强制刷新 pool-usage（需凭据中心有未过期 JWT）
 *   POST /api/dsh-sensenova/refetch-key   强制重抓 key（限频 10 分钟/账号）
 *   GET  /api/dsh-sensenova/accounts      账号信息（仅 has* 标志，不含明文凭据）
 *   POST /api/dsh-sensenova/accounts      保存账号（用户名/密码落凭据中心 + 立即登录抓 key）
 *   DELETE /api/dsh-sensenova/accounts    从注册表移除页面创建的账号（config 账号拒绝）
 *   GET  /api/dsh-sensenova/log?tail=N    日志尾部（默认 80 行）
 *
 * 这些路由是 M4 自定义客户端页的数据源；curl/浏览器也可直接用。
 *
 * @module lib/routes.js
 */

import { readFileSync } from 'node:fs'
import { resolveUsableJwt } from './credentials.js'
import { fetchPoolUsage, allUsageSnapshots } from './usage.js'

function writeJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function tail(text, lines) {
  const all = text.split('\n')
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

/**
 * @param {object} args
 * @param {() => Promise<Array>} args.snapshot 调度器快照（scheduler.snapshot()）
 * @param {(label: string) => Promise<{jwt?: string}>} args.resolveJwt 读账号 JWT ref
 * @param {(label: string) => Promise<{key: string}>} args.refetchKey 强制重抓（内部限频）
 * @param {(label: string, jwt: string) => Promise<unknown>} args.refreshUsage
 * @param {() => Promise<Array>} [args.listAccountInfo] 账号信息（不含明文凭据，仅 has* 标志）
 * @param {(input: {label:string,username:string,password?:string,enabled?:boolean}) => Promise<object>} [args.saveAccount]
 * @param {(label: string) => Promise<object>} [args.removeAccount]
 * @param {string} args.logFile 日志文件路径
 * @param {object} [args.logger]
 */
export function makeRoutes({ snapshot, resolveJwt, refetchKey, refreshUsage, listAccountInfo, saveAccount, removeAccount, logFile, logger }) {
  const guard = (req, res, method) => {
    if ((req.method ?? '') !== method) {
      writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method ?? ''}` })
      return false
    }
    return true
  }

  return [
    {
      kind: 'exact',
      path: '/api/dsh-sensenova/status',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        let logTail
        try { logTail = tail(readFileSync(logFile, 'utf8'), 80) } catch { logTail = '' }
        writeJson(res, 200, {
          ok: true,
          value: {
            accounts: await snapshot(),
            usage: Object.fromEntries(allUsageSnapshots()),
            logTail,
          },
        })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-sensenova/refresh-usage',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) ?? {}
        const label = String(body.label ?? '')
        if (!/^[A-Z0-9_]+$/.test(label)) {
          writeJson(res, 400, { ok: false, error: 'label 必填（仅 A-Z0-9_）' })
          return
        }
        // resolveJwt 返回 JWT 字符串（resolveUsableJwt 已过滤过期）
        const jwt = await resolveJwt(label)
        if (!jwt) {
          writeJson(res, 409, { ok: false, error: `账号 ${label} 没有可用的 JWT（登录后才有；可用 refetch-key 触发）` })
          return
        }
        const entry = await refreshUsage(label, jwt)
        if (!entry) {
          writeJson(res, 502, { ok: false, error: 'pool-usage 拉取失败（JWT 可能已过期，可 refetch-key 重新登录）' })
          return
        }
        writeJson(res, 200, { ok: true, value: entry })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-sensenova/refetch-key',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = (await readJsonBody(req)) ?? {}
        const label = String(body.label ?? '')
        if (!/^[A-Z0-9_]+$/.test(label)) {
          writeJson(res, 400, { ok: false, error: 'label 必填（仅 A-Z0-9_）' })
          return
        }
        try {
          const result = await refetchKey(label)
          writeJson(res, 200, { ok: true, value: { label, keyUpdated: true, refreshed: result.refreshed } })
        } catch (error) {
          writeJson(res, 502, { ok: false, error: error?.message ?? String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-sensenova/accounts',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          if (!listAccountInfo) { writeJson(res, 501, { ok: false, error: '账号管理未启用' }); return }
          writeJson(res, 200, { ok: true, value: { accounts: await listAccountInfo() } })
          return
        }
        if (req.method === 'POST') {
          if (!saveAccount) { writeJson(res, 501, { ok: false, error: '账号管理未启用' }); return }
          const body = (await readJsonBody(req)) ?? {}
          const label = String(body.label ?? '').trim()
          if (!/^[A-Za-z0-9_]+$/.test(label)) {
            writeJson(res, 400, { ok: false, error: 'label 必填（仅字母/数字/下划线）' })
            return
          }
          try {
            const result = await saveAccount({
              label,
              username: String(body.username ?? ''),
              password: body.password === undefined ? undefined : String(body.password),
              enabled: body.enabled !== false,
            })
            writeJson(res, 200, { ok: true, value: result })
            logger?.info?.(`dsh-sensenova: 账号 ${label} 保存完成（keyUpdated=${result.keyUpdated}）`)
          } catch (error) {
            writeJson(res, 502, { ok: false, error: error?.message ?? String(error) })
          }
          return
        }
        if (req.method === 'DELETE') {
          if (!removeAccount) { writeJson(res, 501, { ok: false, error: '账号管理未启用' }); return }
          const body = (await readJsonBody(req)) ?? {}
          const label = String(body.label ?? '').trim()
          try {
            writeJson(res, 200, { ok: true, value: await removeAccount(label) })
          } catch (error) {
            writeJson(res, 409, { ok: false, error: error?.message ?? String(error) })
          }
          return
        }
        writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method ?? ''}` })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-sensenova/log',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/api/dsh-sensenova/log', 'http://localhost')
        const lines = Math.min(Math.max(Number(url.searchParams.get('tail') ?? 80), 1), 2000)
        let text
        try { text = tail(readFileSync(logFile, 'utf8'), lines) } catch { text = '' }
        writeJson(res, 200, { ok: true, value: { logFile, tail: text } })
      },
    },
  ]
}
