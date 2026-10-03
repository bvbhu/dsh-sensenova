// 跨模型 TPM 探针：同一账号（同一 key，同限流桶）上把模型 A 打到 429 后，
// 立刻调用模型 B —— 回答「限流桶是按账号还是按 账号×模型」：
//   B 200 → 桶按模型分（A 打满不影响 B，冷却/调度应按 账号×模型 粒度）
//   B 429 → 桶按账号（现状设计正确：账号级冷却）
//
// 用法：node cross-model-tpm.mjs [key别名] [模型A] [模型B] [--rpm] [--wait]
//   默认 acc1key1 / deepseek-v4-flash / glm-5.2，TPM 模式烧大载荷
//   --rpm：连发小请求打 RPM 429（近零成本）；--wait：追加 P4 窗口释放验证
// keys.json 需填真实 key；脚本不打印 key。结果追加到 ../data/cross-model-tpm.jsonl。
//
// 注意：429 报文不区分 TPM/RPM，P1 若在累计 token 很小时就 429 说明触的是
// RPM——此时 P3 的结论对应「RPM 桶粒度」而非「TPM 桶粒度」，输出里会标注。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chat, loadKeys, makeJsonlLogger, makePayloadFactory, sleep } from './lib.mjs'

const args = process.argv.slice(2)
const flagIdx = args.indexOf('--wait')
const doWait = flagIdx !== -1
if (flagIdx !== -1) args.splice(flagIdx, 1)
const rpmFlagIdx = args.indexOf('--rpm')
const rpmMode = rpmFlagIdx !== -1
if (rpmFlagIdx !== -1) args.splice(rpmFlagIdx, 1)
const numArg = (i, dflt) => (args[i] !== undefined && Number.isFinite(Number(args[i])) ? Number(args[i]) : dflt)
const [aliasArg, modelAArg, modelBArg] = args
const alias = aliasArg ?? 'acc1key1'
const modelA = modelAArg ?? 'deepseek-v4-flash'
const modelB = modelBArg ?? 'glm-5.2'
const BURN_CHARS_OVERRIDE = numArg(3, 0)
const BURN_MAX_OVERRIDE = numArg(4, 0)

const keys = loadKeys()
const key = keys[alias.toLowerCase()]
if (!key || key.includes('*')) {
  console.error(`keys.json 里没有 "${alias}" 的真实 key（当前是脱敏示例）。填好后重跑。`)
  process.exit(1)
}

const poolText = readFileSync(join(import.meta.dirname, '../data/text-pool.txt'), 'utf8')
const payload = makePayloadFactory(poolText)
const log = makeJsonlLogger(join(import.meta.dirname, '../data/cross-model-tpm.jsonl'))

// 每次运行唯一 tag：payload 前缀随 run 变化，避免吃到上一 run 的 prompt cache
// （缓存命中不计 TPM，会让烧窗失真——上轮实测 cached≈8k/发）。
const RUN_TAG = `run${Date.now().toString(36)}`

/** chat 网络容错：连接级异常（ECONNRESET 等）2s 后重试一次，仍失败则抛出。 */
async function chatSafe(key, model, content, opts) {
  try {
    return await chat(key, model, content, opts)
  } catch (error) {
    console.log(`  [网络异常 ${error?.cause?.code ?? error?.code ?? error?.message}，2s 后重试]`)
    await sleep(2_000)
    return chat(key, model, content, opts)
  }
}

// 单次烧窗载荷：~24k 字符（中文 ≈2 字符/token → ~12k tokens）。
// 5 发即超 deepseek-v4-flash 的 ≈50k TPM；8s 间隔把 RPM 压在 ≈7.5/min（< 实测 8–10）。
const BURN_CHARS = BURN_CHARS_OVERRIDE || 32_000
const BURN_MAX = BURN_MAX_OVERRIDE || 12
const BURN_INTERVAL_MS = 8_000
const MAX_TOKENS = 8

const fmt = (r) => `HTTP ${r.status} prompt=${r.prompt} cached=${r.cached} ${r.ms}ms`

console.log(`账号=${alias}  A=${modelA}  B=${modelB}  烧窗载荷≈${BURN_CHARS} 字符/发  间隔 ${BURN_INTERVAL_MS}ms\n`)

// ── P0 基线：A/B 各一发小请求，都应 200 ──────────────────────────────────
const p0a = await chatSafe(key, modelA, 'ping', { maxTokens: MAX_TOKENS })
console.log(`P0 基线 A（${modelA}）: ${fmt(p0a)}`)
log({ phase: 'p0-baseline', model: modelA, ...p0a })
if (p0a.status !== 200) {
  console.error('基线 A 就不通过（key 无效或服务异常），中止。')
  process.exit(1)
}
const p0b = await chatSafe(key, modelB, 'ping', { maxTokens: MAX_TOKENS })
console.log(`P0 基线 B（${modelB}）: ${fmt(p0b)}`)
log({ phase: 'p0-baseline', model: modelB, ...p0b })
if (p0b.status !== 200) {
  console.error('基线 B 不通过（换一个 B 模型重跑），中止。')
  process.exit(1)
}

// ── P1 打到 429：TPM 模式烧大载荷；--rpm 模式连发小请求打 RPM（近零成本）──
let burned = 0
let first429 = null
if (rpmMode) {
  for (let i = 1; i <= 16; i++) {
    const r = await chatSafe(key, modelA, 'ping', { maxTokens: MAX_TOKENS })
    console.log(`P1 连发 #${i}（${modelA}）: ${fmt(r)}`)
    log({ phase: 'p1-rpm-burst', seq: i, model: modelA, ...r })
    if (r.status === 429) { first429 = { seq: i, cumTpm: 0, at: Date.now() }; break }
    await sleep(700)
  }
} else {
  for (let i = 1; i <= BURN_MAX; i++) {
    if (i > 1) await sleep(BURN_INTERVAL_MS)
    const r = await chatSafe(key, modelA, payload(BURN_CHARS, RUN_TAG), { maxTokens: MAX_TOKENS })
    if (r.prompt) burned += Math.max(0, (r.prompt ?? 0) - (r.cached ?? 0))
    console.log(`P1 烧窗 #${i}（${modelA}）: ${fmt(r)}  累计计入TPM≈${burned}`)
    log({ phase: 'p1-burn', seq: i, model: modelA, cumTpm: burned, ...r })
    if (r.status === 429) { first429 = { seq: i, cumTpm: burned, at: Date.now() }; break }
  }
}
if (!first429) {
  console.error(`\n${BURN_MAX} 发未打出 429（累计≈${burned} tokens）——加大 BURN_CHARS 后重跑。`)
  process.exit(1)
}
const bucketGuess = first429.cumTpm >= 40_000 ? 'TPM（累计≈' + first429.cumTpm + '）' : 'RPM（累计仅≈' + first429.cumTpm + '，非 TPM）'
console.log(`→ A 已触发 429，判型：${bucketGuess}\n`)

// ── P2 复核：A 再来一发小请求，应仍 429（窗口未释放，P3 才有意义）─────────
const p2 = await chatSafe(key, modelA, 'ping', { maxTokens: MAX_TOKENS })
console.log(`P2 复核 A 仍受限: ${fmt(p2)}`)
log({ phase: 'p2-recheck-A', model: modelA, ...p2 })

// ── P3 关键判定：立刻调 B ─────────────────────────────────────────────────
const p3 = await chatSafe(key, modelB, 'ping', { maxTokens: MAX_TOKENS })
console.log(`P3 立即调 B（${modelB}）: ${fmt(p3)}`)
log({ phase: 'p3-cross-model', model: modelB, ...p3 })
console.log('')
if (p3.status === 200) {
  console.log(`结论：A 被 429 后 B 立即可用 → 限流桶按 账号×模型 划分（${bucketGuess}）。`)
  console.log('      调度器冷却粒度应改为（账号, 模型），单模型打满不该冻结账号上其他模型。')
} else if (p3.status === 429) {
  console.log(`结论：A 被 429 后 B 同样 429 → 限流桶按 账号 划分（${bucketGuess}），现状账号级冷却正确。`)
} else {
  console.log(`结论：B 返回异常状态 ${p3.status}，需人工检查：${p3.body}`)
}
log({ phase: 'verdict', bucket: p3.status === 200 ? 'per-account-per-model' : p3.status === 429 ? 'per-account' : 'unknown', limitKind: bucketGuess })

// ── P4（--wait）：等 65s 验证 A 窗口释放 ──────────────────────────────────
if (doWait) {
  console.log('\n等待 65s（滚动窗口释放）…')
  await sleep(65_000)
  const since429 = Math.round((Date.now() - first429.at) / 1000)
  const p4 = await chatSafe(key, modelA, 'ping', { maxTokens: MAX_TOKENS })
  console.log(`P4 429 后 ${since429}s 调 A: ${fmt(p4)}`)
  log({ phase: 'p4-recovery', model: modelA, since429s: since429, ...p4 })
}
