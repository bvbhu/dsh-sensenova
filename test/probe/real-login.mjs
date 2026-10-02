/**
 * M3 实链路验证：用插件的 auth.js 真实登录 + 抓 key（不打印明文）。
 * 用法：node test/probe/real-login.mjs [acc1|acc2]（读 usage-dashboard 的 accounts.json）
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { login, fetchApiKey } from '../../lib/auth.js'

const dashboardDir = 'D:/projects/sensenova-usage-dashboard'
const which = process.argv[2] ?? 'acc2'
const raw = JSON.parse(readFileSync(path.join(dashboardDir, 'accounts.json'), 'utf8'))
const acc = raw.accounts[which === 'acc1' ? 0 : 1]

console.log(`登录 ${acc.username} …`)
const token = await login({ username: acc.username, password: acc.password })
console.log(`登录成功：expires_in=${token.expires_in}s，JWT 长度=${token.access_token.length}，refresh=${token.refresh_token ? '有' : '无'}`)

const { key, total } = await fetchApiKey({ jwt: token.access_token })
console.log(`apiKeys：共 ${total} 个，取第一个 → ${key.slice(0, 5)}***${key.slice(-4)}`)

// 用抓到的 key 打一次 /v1/models 验证 key 有效
const models = await fetch('https://token.sensenova.cn/v1/models', {
  headers: { Authorization: `Bearer ${key}` },
})
console.log(`key 有效性（/v1/models）：HTTP ${models.status}，${models.ok ? (await models.json()).data.length + ' 个模型' : ''}`)
