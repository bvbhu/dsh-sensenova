/**
 * saveConfig 孤儿写锁恢复（recoverStaleWriterLock）的单测。
 *
 * 宿主 dsh-atomic-write 的竞争者只等不清锁，持有进程崩溃后 <file>.lock
 * 永久残留 → settings 保存全部超时。恢复动作仅当锁内 PID 可证明已死才执行。
 *
 * @module test/unit/save-lock-recovery.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoverStaleWriterLock } from '../../lib/index.js'

const lockError = (lockPath) =>
  new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)

/** 找一个确定不存在的 PID（kill(pid,0) 报 ESRCH）。 */
function findDeadPid() {
  for (let pid = 100000; pid < 1_000_000; pid += 4) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') return pid
    }
  }
  throw new Error('no dead pid found')
}

test('写锁超时 + 锁内 PID 已死：删除锁文件并返回 true', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sensenova-lock-'))
  try {
    const lockPath = join(dir, 'package.json.lock')
    const deadPid = findDeadPid()
    await writeFile(lockPath, `${deadPid}\n`)
    assert.equal(await recoverStaleWriterLock(lockError(lockPath)), true)
    await assert.rejects(() => readFile(lockPath, 'utf8'), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('锁内 PID 存活（当前进程）：不动锁，返回 false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sensenova-lock-'))
  try {
    const lockPath = join(dir, 'package.json.lock')
    await writeFile(lockPath, `${process.pid}\n`)
    assert.equal(await recoverStaleWriterLock(lockError(lockPath)), false)
    assert.equal(await readFile(lockPath, 'utf8'), `${process.pid}\n`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('锁内容不是数字 PID / 锁文件缺失：返回 false 不抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sensenova-lock-'))
  try {
    const lockPath = join(dir, 'package.json.lock')
    await writeFile(lockPath, 'not-a-pid\n')
    assert.equal(await recoverStaleWriterLock(lockError(lockPath)), false)
    assert.equal(await recoverStaleWriterLock(lockError(join(dir, 'missing.lock'))), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('非写锁超时错误：直接返回 false', async () => {
  assert.equal(await recoverStaleWriterLock(new Error('settings 中没有 dsh-sensenova 命名空间')), false)
  assert.equal(await recoverStaleWriterLock(undefined), false)
})
