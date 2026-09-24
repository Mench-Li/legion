#!/usr/bin/env node
/**
 * 量具：把 `docs/MULTI-AGENT-FEATURE-STATUS.md` 权威表里**非 ✅** 的那几行摊开 ——
 * 一行的**格首**与**格尾**分开放，因为**订正写在格尾**。
 *
 * 为什么要这个量具（第 118 轮第四十一→四十二轮）：
 *   本会话抓到过**五次**同一个动作的后果 —— 读一个长格子的**开头**，而那句结论
 *   早已在**同一个格子的末尾**被订正掉。第 28 条（读 §5 索引、没读台账 §2）是一次，
 *   F-21 的「① 投递」是一次（格首说"不在 envNames 里"，格尾写着"① 已经不成立"）。
 *
 *   > 长格子的**开头是旧读数、末尾是订正** —— 于是"读第一个分句"这个最快的读法，
 *   > 恰好是最容易读到过期结论的那一种。
 *
 * 所以本量具**故意**把同一格切成两半打印，并标注它引用的路径今天还在不在。
 *
 * 用法：`node scripts/probes/_probe-frows-nongreen.mjs [--id F-21] [--tail 700]`
 * 退出码：0 = 打印完成（这是量具，不是门禁；它只给读数、不下结论）。
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const STATUS_DOC = path.join(ROOT, 'docs', 'MULTI-AGENT-FEATURE-STATUS.md')

const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const ONLY = argOf('--id', null)
const TAIL = Number(argOf('--tail', '700'))

const lines = readFileSync(STATUS_DOC, 'utf8').split('\n')
const rows = []
for (const l of lines) {
  const m = /^\|\s*\*{0,2}(F-\d{2})\*{0,2}\s*\|/.exec(l)
  if (m === null) continue
  const cells = l.split('|').slice(1).map((c) => c.trim())
  const si = cells.findIndex((c) => /✅|🟡|⬜|⏸/.test(c))
  if (si < 0) continue
  rows.push({ id: m[1], status: cells[si], cells })
}

/** 终态：`X→Y` 取箭头右边那个。 */
const FINAL = (s) => {
  const m = /→\s*(✅|🟡|⬜|⏸)/.exec(s)
  return m === null ? (s.match(/✅|🟡|⬜|⏸/) ?? ['?'])[0] : m[1]
}

const nonGreen = rows.filter((r) => FINAL(r.status) !== '✅' && (ONLY === null || r.id === ONLY))
console.log(`权威表 ${rows.length} 行；非 ✅ 的 ${rows.length - rows.filter((r) => FINAL(r.status) === '✅').length} 行`
  + `（本次打印 ${nonGreen.length} 行；格尾取 ${TAIL} 字）\n`)

for (const r of nonGreen) {
  console.log(`════ ${r.id}  ${r.status}`)
  for (let i = 0; i < r.cells.length; i += 1) {
    const c = r.cells[i].replace(/\s+/g, ' ').trim()
    if (c === '' || /^[✅🟡⬜⏸→\s★]+$/.test(c)) continue
    const hasFix = /订正|被取代|已经?不成立|已收口|更正/.test(c)
    console.log(`   [${i}] ${c.slice(0, 180)}`)
    if (c.length > 220) {
      console.log(`   [${i}] ⋯⋯ **格尾**${hasFix ? '（★ 这一格里有订正字样）' : '（没有订正字样）'}：`
        + `…${c.slice(-TAIL)}`)
    }
  }
  const paths = [...new Set((r.cells.join(' ').match(/[a-z][a-z0-9-]*(?:\/[a-z0-9._-]+)+\.(?:mjs|md)/g) ?? []))]
  const missing = paths.filter((p) => !existsSync(path.join(ROOT, p)))
  if (paths.length > 0) {
    console.log(`   ↳ 引用路径 ${paths.length} 个；**不存在** ${missing.length} 个`
      + (missing.length ? `：${missing.slice(0, 4).join(' / ')}` : ' ✓'))
  }
  console.log('')
}
