#!/usr/bin/env node
// scripts/prt/push-verify.mjs
// ============================================================================
// 推送验证（PRT-509 事故的直接产物）
//
// ## 为什么需要这个脚本
//
// 我在 PRT-509 那批用的是这样一条判据：
//
//     if ($r -match 'codex/prt-runtime ->') { "PUSH OK" }
//
// 而 `git push` 的**失败**输出里也含这一串：
//
//   成功：`   6070c48..6460552  codex/prt-runtime -> codex/prt-runtime`
//   失败：`! [remote rejected] codex/prt-runtime -> codex/prt-runtime (push declined...)`
//
// 于是「被 GitHub 以 push protection 拒绝」被判成了「推送成功」，
// 而我在**两次拒绝**之后都以为已经推上去了。
//
// 这是本项目反复记过的那个家族的又一个实例：
//
//   **一个测不到东西的用例，和一个正确的实现，在输出上完全一样。**
//
// 这里的具体形态是：**一个永远为真的验证，和一个真的验证，在输出上完全一样。**
//
// ## 正确的判据
//
// 只有一条：**远端 tip 等于本地 HEAD**。
//
// 用**远端的事实**说话，不用推送命令自己的输出说话——
// 命令的输出是「我尝试了什么」，远端的状态才是「发生了什么」。
// 这两者在「命令成功但被服务端规则拒绝」时是**分离**的，
// 而那正是本条判据存在的唯一理由。
//
// 另外，判据必须**能失败**：`ls-remote` 取不到（网络不通）时返回
// `unreachable`，绝不返回 `verified`。
// ============================================================================

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** 判定结果。`verified` 是**唯一**代表成功的那一个。 */
export const PUSH_VERDICTS = Object.freeze({
  VERIFIED: 'verified',
  MISMATCH: 'mismatch',
  UNREACHABLE: 'unreachable',
  INVALID: 'invalid',
})

/**
 * 从 `git ls-remote` 的输出里取 tip。
 *
 * 真实输出是 `<40位sha>\t<ref>`，一行。取不到就是 `null`——
 * **不抛、也不编一个值出来**：网络不通与"远端就是空的"是两件不同的事，
 * 但两者都不等于"已推送"。
 */
export function parseRemoteTip(output) {
  if (typeof output !== 'string') return null
  const line = output.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '')
  if (line === undefined) return null
  const m = /^([0-9a-f]{7,64})\s+(\S+)$/.exec(line)
  if (m === null) return null
  return { sha: m[1], ref: m[2] }
}

/** 本地 HEAD 是否已等于远端 tip。**只有相等才是 verified。** */
export function verdictFor({ localSha = null, remoteSha = null, reachable = true } = {}) {
  if (reachable !== true) return { verdict: PUSH_VERDICTS.UNREACHABLE, ok: false }
  if (typeof localSha !== 'string' || localSha === '' ||
      typeof remoteSha !== 'string' || remoteSha === '') {
    return { verdict: PUSH_VERDICTS.INVALID, ok: false }
  }
  if (localSha === remoteSha) return { verdict: PUSH_VERDICTS.VERIFIED, ok: true }
  return { verdict: PUSH_VERDICTS.MISMATCH, ok: false }
}

/**
 * 这个函数存在的唯一目的是**把那条错误的正则钉在用例里**。
 *
 * 它接受推送命令的原始输出，**永远不据此判成功**——
 * 返回 `true` 只表示"输出里出现了成功的样子"，而成功的样子与失败的样子
 * 共用同一段子串。调用方必须用远端 tip 复核。
 */
export function looksLikeSuccessText(pushOutput) {
  return typeof pushOutput === 'string' && pushOutput.includes('->')
}

// ------------------------------------------------------------------ CLI

function git(args, { cwd }) {
  return execFileSync('git', ['-c', 'http.proxy=', '-c', 'https.proxy=', ...args],
    { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function runPushVerify({ cwd, ref, doPush = true, log = console.log } = {}) {
  let localSha
  try {
    localSha = git(['rev-parse', 'HEAD'], { cwd })
  } catch (e) {
    log(`无法读取本地 HEAD：${e?.message ?? e}`)
    return { verdict: PUSH_VERDICTS.INVALID, ok: false }
  }

  let pushOutput = ''
  if (doPush === true) {
    try {
      pushOutput = git(['push', 'origin', ref], { cwd })
    } catch (e) {
      pushOutput = `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
  }

  let remote
  try {
    remote = parseRemoteTip(git(['ls-remote', 'origin', ref], { cwd }))
  } catch {
    remote = null
  }

  const result = verdictFor({
    localSha,
    remoteSha: remote?.sha ?? null,
    reachable: remote !== null,
  })

  log(`local  = ${localSha}`)
  log(`remote = ${remote?.sha ?? '(unreachable)'}`)
  log(result.ok
    ? 'PUSH VERIFIED ✔（远端 tip 等于本地 HEAD）'
    : `PUSH NOT VERIFIED ✖（${result.verdict}）`)

  if (!result.ok && pushOutput !== '') {
    // 失败时把远端的话**原样**带出来（这里只打印，不解析）。
    // 解析失败输出正是上一个版本出错的地方。
    log('--- 推送输出 ---')
    for (const line of pushOutput.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 30)) log(line)
  } else if (!result.ok) {
    log('（推送命令没有报错，但远端 tip 不是本次 HEAD——网络不可达或 ref 被拒）')
  }

  return result
}

const invokedDirectly = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  const args = process.argv.slice(2)
  const ref = args.find((a) => !a.startsWith('--')) ?? 'HEAD'
  const cwd = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const result = runPushVerify({ cwd, ref, doPush: !args.includes('--no-push') })
  process.exit(result.ok ? 0 : 1)
}
