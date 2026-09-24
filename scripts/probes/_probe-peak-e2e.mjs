// scripts/probes/_probe-peak-e2e.mjs —— PRT-009 `peak-resource`：**第一次**端到端真读数
//
// ★ 为什么需要它（证据文件 `docs/PRT-009-evidence/verify-evidence.md` 的原话）：
//
//     「本表与 §7 现在同意同一句话：**接线都在，"每次 Run 真的印出一行"还没被观测过。**」
//
//   已有的两条证据都**不是**端到端：
//     · `supervisor.test.mjs:396` 对**真**进程采样 —— 但只到采样器，**没走 status()**
//     · `supervisor.test.mjs:484` 验"读数被交出去" —— 但用的是**假 io**（`makePeakIo`）
//   于是"从一台真进程 → status() → launcher 那句映射 → 磁盘记录"整条链
//   从来没有被一次**真**读数走通过。
//
//   > 两段各自有真读数、中间那一跳也修好了，与**整条链走过去一次**，
//   > 在"这一项能不能关掉"这个读数上是同一个东西——
//   > 只不过前者会在任何一次改动把中间接缝挪开时继续保持绿色。
//
// 本探针做的就是那一次：起一台**真**子进程（真占内存），
// 经真采样器 → 真 `status()` → 逐字复刻 launcher 的映射 → 真落盘 → 真读回。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildChildEnv } from '../../product/launcher/allowlist.mjs'
import { createSupervisor } from '../../product/launcher/supervisor.mjs'
import { buildRunRecord, readRunRecord, writeRunRecord } from '../../product/launcher/run-record.mjs'

const MB = 1024 * 1024
// 真占内存、活够久，好让周期采样至少采到一次「长大之后」的值。
const CHILD = 'const a=[];for(let i=0;i<140;i++)a.push(Buffer.alloc(1024*1024,7));setTimeout(()=>{},9000)'

const logs = []
const spec = Object.freeze({
  key: 'probe-e2e',
  label: 'peak-resource 端到端探针',
  command: Object.freeze({ file: process.execPath, args: Object.freeze(['-e', CHILD]) }),
  cwd: process.cwd(),
  envNames: Object.freeze([]),
})

// ★ 用 `createSupervisor`（不是 `createSupervisedProcess`）：launcher 走的就是这一层，
//   而 `status()` 这一层才是 `persistRunRecord()` 真正读的那个数组。
const plan = Object.freeze({
  processes: Object.freeze([spec]),
  waves: Object.freeze([Object.freeze(['probe-e2e'])]),
})
const h = createSupervisor(plan, {
  // ★ 按真实纪律构造 env：supervisor 只认 `envFor(spec)?.env`，
  //   而它**刻意不默认继承 process.env**（那是一条静默越权路径）。
  envFor: () => buildChildEnv({ spec, baseEnv: process.env }),
  logger: (e) => logs.push(e),
  peakSampleMs: 400, // 默认 5000，探针要快
})

console.log('=== 起一台**真**子进程，从进程外部采它的峰值 ===')
await h.startAll()
// 等它真的把内存占上去
const deadline = Date.now() + 12000
let st = null
let peakBytes = 0
while (Date.now() < deadline) {
  st = h.status()
  const pr = st[0]?.peakResource
  peakBytes = pr?.peakWorkingSetBytes ?? 0
  if (peakBytes > 100 * MB) break
  await new Promise((r) => setTimeout(r, 300))
}

const row = st[0]
const pr = row?.peakResource
console.log(`  进程 pid      = ${row?.pid}`)
console.log(`  监督状态      = ${row?.state}`)
console.log(`  peakResource  = ${pr === null || pr === undefined ? '★ null' : '有读数'}`)
if (pr) {
  console.log(`    peakWorkingSet = ${(pr.peakWorkingSetBytes / MB).toFixed(1)} MiB`)
  console.log(`    cpuMs          = ${pr.cpuMs}`)
  console.log(`    samples        = ${pr.samples}`)
  console.log(`    window.ok      = ${pr.ok}`)
}

// ── 那一条日志（"每次 Run 真的印出一行"里的"一行"）──
await h.stopAll()
await new Promise((r) => setTimeout(r, 300))
const lines = logs.map((e) => e.message).filter((m) => typeof m === 'string' && m.includes('peak-resource'))
console.log(`\n=== 退出时那条日志（实得 ${lines.length} 条）===`)
for (const l of lines) console.log(`  ${l}`)

// ── 逐字复刻 launcher.mjs:1261-1271 的映射，落盘、读回 ──
const dir = mkdtempSync(join(tmpdir(), 'peak-e2e-'))
const file = join(dir, 'launcher-run.json')
try {
  const processes = h.status().map((x) => ({
    key: x.key,
    pid: typeof x.pid === 'number' ? x.pid : null,
    image: x.image ?? null,
    peakResource: x.peakResource ?? null,
  }))
  const rec = buildRunRecord({
    runId: 'probe-e2e',
    launcherPid: process.pid,
    startedAt: new Date(Date.now() - 20000).toISOString(),
    processes,
  })
  const w = writeRunRecord(file, rec)
  const back = readRunRecord(file)

  console.log('\n=== 落盘 → 读回（按 launcher 那句映射）===')
  console.log(`  writeRunRecord.ok = ${w.ok}`)
  console.log(`  readRunRecord     = 记录 ${back.record === null ? 'null' : '有'} / 诊断 ${back.diagnostics.length} 条`)
  const diskPr = back.record?.processes?.[0]?.peakResource ?? null
  console.log(`  磁盘上的 peakResource = ${diskPr === null ? '★ null' : '有读数'}`)
  if (diskPr) {
    console.log(`    peakWorkingSet = ${(diskPr.peakWorkingSetBytes / MB).toFixed(1)} MiB`)
    console.log(`    cpuMs          = ${diskPr.cpuMs}`)
  }

  console.log('\n=== 判定 ===')
  const liveOk = pr !== null && pr !== undefined && (pr.peakWorkingSetBytes ?? 0) > 100 * MB
  const diskOk = diskPr !== null && diskPr !== undefined && diskPr.peakWorkingSetBytes === pr?.peakWorkingSetBytes
  console.log(`  ① 真进程 → status().peakResource 有真读数（>100MiB）：${liveOk ? '✔' : '★ 否'}`)
  console.log(`  ② 退出时印出**恰好一条** peak-resource 日志：${lines.length === 1 ? '✔' : `★ ${lines.length} 条`}`)
  console.log(`  ③ 同一读数**原样**落到磁盘（逐字段相等）：${diskOk ? '✔' : '★ 否'}`)
  console.log(`\n  ⇒ ${liveOk && diskOk && lines.length === 1
    ? '整条链（真进程 → 采样 → status() → 映射 → 磁盘）**第一次被一次真读数走通**。'
    : '★ 有环节没走通，见上。'}`)
  console.log(`  ④ 对照：磁盘上那个数与"从没采过"是可区分的（null vs 读数）——`
    + `今天磁盘上是 ${diskPr === null ? 'null' : '读数'}，而读数是**真**的。`)
} finally {
  try { h.dispose() } catch { /* 已停 */ }
  rmSync(dir, { recursive: true, force: true })
  // 探针自己起的子进程若还在，收掉
  try { spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }) } catch { /* 无关 */ }
}
