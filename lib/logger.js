/**
 * 插件自有文件日志：落插件安装目录下 logs/dsh-sensenova.log。
 *
 * dsh 宿主的 ctx.logger 不一定把插件 info 行送到可见位置（实测），所以
 * 关键链路（注册、按需登录、429、key 失效/重抓）同时 tee 到文件。
 * 同步追加（低频、量小），单文件 5MB 轮转一次（.old）；目录不可写时
 * 静默降级到 ~/.dsh/logs（都不行则放弃文件日志，不影响主流程）。
 *
 * @module lib/logger.js
 */

import { appendFileSync, mkdirSync, renameSync, existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const MAX_BYTES = 5 * 1024 * 1024

function fmt(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.message}${value.cause ? ` ← ${value.cause.message ?? value.cause}` : ''}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 本地时间戳 YYYY-MM-DD HH:mm:ss.SSS（UTC 的 toISOString 在日志里要心算时差，弃用）。 */
function localTimestamp(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  )
}

function resolveLogFile() {
  const candidates = [
    path.join(PLUGIN_DIR, 'logs', 'dsh-sensenova.log'),
    path.join(os.homedir(), '.dsh', 'logs', 'dsh-sensenova.log'),
  ]
  for (const file of candidates) {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      appendFileSync(file, '')
      return file
    } catch { /* 下一个候选 */ }
  }
  return undefined
}

/**
 * 创建文件日志器； tee 到 dsh 宿主 logger（有则兼得，无则只写文件）。
 */
export function createLogger(hostLogger) {
  const file = resolveLogFile()
  const write = (level, args) => {
    if (file === undefined) return
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) {
        renameSync(file, `${file}.old`)
      }
      appendFileSync(file, `[${localTimestamp()}] [${level}] ${args.map(fmt).join(' ')}\n`)
    } catch { /* 日志失败不影响主流程 */ }
  }
  const tee = (level) => (...args) => {
    hostLogger?.[level]?.(...args)
    write(level, args)
  }
  return {
    logFile: file,
    debug: tee('debug'),
    info: tee('info'),
    warn: tee('warn'),
    error: tee('error'),
  }
}
