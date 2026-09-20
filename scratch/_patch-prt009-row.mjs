// scratch/_patch-prt009-row.mjs —— 给台账 PRT-009 那一行补第 44 轮的读数
//
// ★ 用脚本改而不是手改：那一行有 8300 字，肉眼改一次就可能碰坏别处。
//   脚本只做一次**尾部追加**，并把"改前/改后长度"打出来当读数。
//
// ★★ 第一版在这里踩了一个坑（记下来）：文件是 **CRLF**，而我用
//    `text.split(/\r?\n/)` 拆、用 `'\n'` 合 ⇒ **每一行都掉一个 `\r`**。
//    结果是"追加了 1000 字，文件反而变短了"，于是我那条
//    `out.length <= text.length` 的自检把它拦下了（拦对了）。
//    但就算没拦住，那也会是一次**全文件换行重写**——而 `git diff` 会显示
//    "改了 6000 行"，真正的改动被淹没在里面。
//
//    > 一次"顺手规范化换行"的改动，与一次"整个文件被重写"的改动，
//    > 在 `git diff --stat` 上是同一个东西——
//    > 只不过前者的意图是好的，而后者的代价是没人再看得清这次到底改了什么。
//
//    ⇒ 拆用 `split('\n')`（把 `\r` 留在行尾）、合用 `join('\n')`，逐字节保持。
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const F = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-PROGRESS.md'
const text = readFileSync(F, 'utf8')
const lines = text.split('\n') // ★ 保留每行结尾的 \r
const beforeLines = [...lines]

const idx = lines.findIndex((l) => /^\|\s*PRT-009/.test(l))
if (idx < 0) throw new Error('没找到 PRT-009 那一行')

const row = lines[idx]
const ANCHOR = '本批推进的是**"接了没有"那一半**，不是"跑过了没有"那一半。'
if (!row.includes(ANCHOR)) throw new Error('锚点没找到——那一行的尾部变了？')
if (row.split(ANCHOR).length !== 2) throw new Error('锚点不唯一')

const ADD = ' ⑧ ★★★ **第 44 轮：剩下那半也切开了——"接线从没被观测过"关掉，"产品基线数值"仍开。** '
  + '（a）**整条链第一次被一次真读数走通**：起一台真子进程，经真采样器 → 真 `status()` → '
  + '逐字复刻 launcher 那句映射 → 真落盘 → 真读回，实测 `peakWorkingSet=194.5 MiB`、`cpuMs=47`，'
  + '**磁盘上与内存里逐字段相等**（`scratch/_probe-peak-e2e.mjs`，可复跑）。'
  + '此前两条证据都不是端到端（一条只到采样器、一条用假 io）。⚠️ 覆盖的是**机制**不是产品基线：'
  + '那台子进程是探针造的，不是黄金任务那一次 Run。'
  + '（b）**而"每次 Run 真的印出一行"当时还不成立**：`supervisor.mjs` 的 `handleExit` 在 '
  + '`if (stopping || disposed)` 那条分支里**直接 return**，`reportPeakResource()` 只在**非主动退出**时走到。'
  + '而主动停止正是一次**成功** Run 的正常结束方式 ⇒ 读数是反的：**崩溃那一次印、正常那一次不印**'
  + '（`scratch/_probe-peak-on-stop.mjs` 并排实测：A 主动停止 0 条 / B 非主动退出 1 条，两者 `status()` 上都是 64MiB）。'
  + '叠加 `forgetRunRecord()` 在正常停止后删记录（那条是**有意**的）⇒ **成功 Run 的峰值两处都不留**。'
  + '**已修**：主动停止那条分支补一句、判据 `!disposed`（`dispose()` 那条路上 sink 可能已关，只有它仍不报）。'
  + '修后 A 1 条 / B 1 条。读数：`supervisor.test.mjs` **22 → 25/25**（+3），'
  + '破验 `scratch/_mutate-r44.mjs` **5/5 咬住 0 漏网**逐字节还原。'
  + '⑨ **本行状态仍是 ⏸**，理由收窄到一句：缺的是**真实部署上一次 Run 的基线数值**'

lines[idx] = row.replace(ANCHOR, ADD + ANCHOR)
const out = lines.join('\n')

if (out.length <= text.length) throw new Error('追加之后没有变长——替换没生效')
const changed = lines.filter((l, i) => l !== beforeLines[i]).length
if (changed !== 1) throw new Error(`应当只有 1 行变化，实际 ${changed} 行`)
if (lines.length !== beforeLines.length) throw new Error('行数变了')
if (out.length - text.length !== lines[idx].length - row.length) {
  throw new Error('文件增量与行增量不一致 ⇒ 换行被动过')
}
writeFileSync(F, out)

console.log(`  PRT-009 行：${row.length} → ${lines[idx].length} 字（+${lines[idx].length - row.length}）`)
console.log(`  文件：${text.length} → ${out.length} 字节（+${out.length - text.length}）`)
console.log(`  变化的行数：${changed}（应当恰好 1）`)
console.log(`  总行数：${lines.length}（原 ${beforeLines.length}）`)
console.log(`  CRLF 还在吗：${out.includes('\r\n') ? '是' : '★ 否——换行被改了'}`)
console.log(`  \r 个数：${(out.match(/\r/g) ?? []).length}（原 ${(text.match(/\r/g) ?? []).length}）`)
console.log(`  新行 sha256 前缀：${createHash('sha256').update(lines[idx]).digest('hex').slice(0, 12)}`)
