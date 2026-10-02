/**
 * M1 实链路验证：真 key 走 adapter → scheduler → client 全链路。
 *
 * 用法：node test/probe/real-link.mjs [account别名]
 * key 从限流报告 scripts/keys.json 读取（默认 acc2key1），不打印 key。
 * 消耗：两轮小请求（文本 + 工具），~500 tokens。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { resolveOptions, DEFAULT_MODELS } from '../../lib/index.js'
import { Scheduler } from '../../lib/scheduler.js'
import { SenseNovaAdapter } from '../../lib/adapter.js'
import { resolveAccounts } from '../../lib/credentials.js'

const REPORT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sensenova-ratelimit-report')

const alias = process.argv[2] ?? 'acc2key1'
const keys = JSON.parse(readFileSync(path.join(REPORT_DIR, 'scripts/keys.json'), 'utf8'))
const key = keys[alias]
if (!key) {
  console.error(`keys.json 里没有 "${alias}"。可选：${Object.keys(keys).join(', ')}`)
  process.exit(1)
}

const rawConfig = {
  accounts: [{ label: 'ACC1' }],
  baseUrl: 'https://token.sensenova.cn/v1',
}
const options = () => {
  if (!options.cached) {
    options.cached = { ...resolveOptions(rawConfig), accounts: rawConfig.accounts }
  }
  return options.cached
}

const scheduler = new Scheduler({
  listAccounts: async () => {
    const resolved = await resolveAccounts(options().accounts, undefined)
    return resolved.map((acc) => ({ ...acc, key: acc.key || key }))
  },
  options: {
    get accountCooldownMs() { return options().accountCooldownMs },
    get rateLimitMode() { return options().rateLimitMode },
  },
  onEvent: (label, fact) => console.log(`  [event] ${label}:`, fact.type),
})

const adapter = new SenseNovaAdapter({ options, scheduler, resolveAttachments: () => undefined, logger: console })

async function run(label, gen) {
  const types = []
  let text = ''
  let usage
  let finish
  for await (const chunk of gen) {
    types.push(chunk.type)
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'reasoning-delta') text += `⟨思⟩${chunk.text}`
    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      text += `⟨tool⟩${chunk.block.name}(${chunk.block.arguments})`
    }
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') finish = chunk.reason
  }
  console.log(`${label}: finish=${finish}`)
  console.log(`  块序列: ${[...new Set(types)].join(',')}`)
  console.log(`  内容: ${text.slice(0, 200)}`)
  console.log(`  usage: ${JSON.stringify(usage)}`)
}

// 1) 纯文本流式（主力 deepseek-v4-flash）
await run('T1 文本流式', adapter.stream({
  provider: 'sensenova-token-plans',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: '用一句话介绍你自己。' }],
  maxTokens: 300,
  sessionId: 'probe-1',
}))

// 2) 工具调用
await run('T2 工具调用', adapter.stream({
  provider: 'sensenova-token-plans',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: '北京天气怎么样？用工具查一下。' }],
  tools: [{
    name: 'get_weather',
    description: '查询指定城市当前天气',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  }],
  maxTokens: 400,
  sessionId: 'probe-1',
}))

scheduler.dispose()
console.log('模型目录:', DEFAULT_MODELS.map((m) => m.id).join(' / '))
