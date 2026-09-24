// scripts/probes/_probe-t6-row-anchors.mjs
// T6 变异验证：`scripts/prt/feature-landing-paths.mjs` 新增的「可核的锚」那一段，
// 在**该红的时候**必须红，且红的必须是它自己那一条。
//
// ★ 本探针**不写磁盘**：`checkRowAnchors({statusText, tracked})` 收的就是文本，
//   所以在内存里改文档就能证伪 —— 比"改真文件再还原"少一整类事故。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkRowAnchors, STATUS_DOC } from '../prt/feature-landing-paths.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const original = readFileSync(resolve(REPO, STATUS_DOC), 'utf8')
const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').map((s) => s.trim()).filter((s) => s !== '')

let failures = 0
const ids = (r) => r.violations.map((v) => v.id)

// ⓪ 基准：原样必须绿
{
  const r = checkRowAnchors({ statusText: original, tracked })
  const ok = r.ok && r.rows === 29 && r.paused === 2
  console.log(`  ${ok ? '✔' : '✖'} ⓪ 基准：原文档绿、29 行、2 条 ⏸（实为 ok=${r.ok} rows=${r.rows} paused=${r.paused}）`)
  if (!ok) failures += 1
}

// ① ⏸ 行被抽掉 §条款 ⇒ 必须报 paused-without-clause
{
  const t = original.replace('§2 明写「**不在契约稳定前同时支持多个 Harness**」', '明写「**不在契约稳定前同时支持多个 Harness**」')
  const r = checkRowAnchors({ statusText: t, tracked })
  const bit = !r.ok && ids(r).includes('feature-paused-without-clause')
  console.log(`  ${bit ? '✔' : '✖'} ① F-23 抽掉 §2 ⇒ 报 paused-without-clause（实为 ${ids(r).join(',') || '绿'}）`)
  if (!bit) failures += 1
}

// ② 台账里那条裁决不再点名 F-23/F-25 ⇒ 必须报 paused-without-ruling
{
  const t = original.replace('| 8 | F-23 / F-25 是否要做 | 已裁决 | 产品 |', '| 8 | 多 Harness 是否要做 | 已裁决 | 产品 |')
  const r = checkRowAnchors({ statusText: t, tracked })
  const bit = !r.ok && ids(r).includes('feature-paused-without-ruling') && ids(r).filter((x) => x === 'feature-paused-without-ruling').length === 2
  console.log(`  ${bit ? '✔' : '✖'} ② 裁决不再点名 F-23/F-25 ⇒ 两条都报 paused-without-ruling（实为 ${ids(r).join(',') || '绿'}）`)
  if (!bit) failures += 1
}

// ③ 普通行被抽成"零锚" ⇒ 必须报 row-no-anchor
{
  const t = original.replace('`product/launcher/*`', '产品级启动器（见设计文档）')
  const r = checkRowAnchors({ statusText: t, tracked })
  const v = r.violations.find((x) => x.id === 'feature-row-no-anchor')
  const bit = !r.ok && v !== undefined && v.feature === 'F-12'
  console.log(`  ${bit ? '✔' : '✖'} ③ F-12 的目录通配被抽掉 ⇒ 报 row-no-anchor 且点名 F-12（实为 ${ids(r).join(',') || '绿'}）`)
  if (!bit) failures += 1
}

// ④ 通配指向**不存在**的目录 ⇒ 也是零锚，且消息要说清"目录不在被跟踪的文件里"
//    ★ 第一版这里挑的是 F-02 —— 它**还有第二个锚**（套件 `dsh-adapter`）⇒ 不咬。
//      挑只有**一个**锚的行才有意义：F-12 的落点就是它唯一的锚。
{
  const t = original.replace('`product/launcher/*`', '`product/__不存在__/*`')
  const r = checkRowAnchors({ statusText: t, tracked })
  const v = r.violations.find((x) => x.id === 'feature-row-no-anchor')
  const bit = !r.ok && v !== undefined && v.feature === 'F-12' && v.message.includes('目录**不在被跟踪的文件里**')
  console.log(`  ${bit ? '✔' : '✖'} ④ 通配目录不存在 ⇒ 报 row-no-anchor 且说明理由（实为 ${ids(r).join(',') || '绿'}）`)
  if (!bit) failures += 1
}

// ⑤ 反面之反面：**有锚**的行不许被报（判据不许惩罚合规）
{
  const r = checkRowAnchors({ statusText: original, tracked })
  const noFalsePositive = r.violations.length === 0
  console.log(`  ${noFalsePositive ? '✔' : '✖'} ⑤ 原文档零违规（不许误报合规行）`)
  if (!noFalsePositive) failures += 1
}

console.log(failures === 0 ? '\n  ⇒ T6 变异验证全过（4 条反向 + 1 条对称 + 基准）' : `\n  ⇒ 有 ${failures} 处不达预期`)
process.exit(failures === 0 ? 0 : 1)
