// scripts/probes/_probe-t3t4-run-binding.mjs
// ============================================================================
// **T3② / T4**（2026-09-24）的**变异验证**。
//
// 三处新判据各自都在说"今天不是那样"。所以每一处都要能被**改坏**：
//
//   ①（T3②）把用例里那个"装配期绑死"的错法改成**按事件取** ⇒ ⑥ 必须红。
//      这一条防的是"反例其实什么也没反" —— 若错法与正法在断言上看不出差别，
//      ⑥ 就是在为一个不存在的区别写注释。
//   ②（T4a）让**生产源码**真的产一条 `result` 行（`observeDecision` 用 RESULT 作 kind）
//      ⇒ ⑦ 必须红（它断言"生产路径上一个 result 都不产"）。
//   ③（T4b）从 `toolCallRowOf` 里**删掉** `attemptId` 那一行 ⇒ ⑧ 必须红
//      （"缺键"与"显式 null"在账上不是同一件事）。
//
// 用法：node scripts/probes/_probe-t3t4-run-binding.mjs
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SUITE = 'runtime/dsh-composition/spool-writer-wiring.test.mjs'
const WRITER = 'runtime/toolcall/spool-writer.mjs'
const REQUEST = 'runtime/dsh-composition/tool-request.mjs'

const run = () => {
  const r = spawnSync(process.execPath, ['--test', SUITE], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const p = /^ℹ pass (\d+)/m.exec(out)
  const f = /^ℹ fail (\d+)/m.exec(out)
  const failed = (out.split('\n').find((l) => /^✖ /.test(l.trim()) && /（/.test(l)) ?? '').trim()
  return { code: r.status, line: `pass ${p === null ? '?' : p[1]} · fail ${f === null ? '?' : f[1]}`, failed }
}

const FILES = [SUITE, WRITER, REQUEST]
const original = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]))

const MUTATIONS = [
  {
    name: '① 把"装配期绑死"的错法改成按事件取（反例自己是否承重）',
    file: SUITE,
    from: '      runIdOf: () => firstRun,',
    to: '      runIdOf: (event) => identityOverlayForExecution(event?.execution)?.runId ?? null,',
  },
  {
    name: '② 让生产源码产一条 result 行（observeDecision 的 kind 换成 RESULT）',
    file: WRITER,
    from: '  return appendFor(event, TOOLCALL_SPOOL_KINDS.DECISION)',
    to: '  return appendFor(event, TOOLCALL_SPOOL_KINDS.RESULT)',
  },
  {
    name: '③ 从 toolCallRowOf 里删掉 attemptId 那一行',
    file: REQUEST,
    from: '    attemptId,\n',
    to: '',
    crlf: true,
  },
]

for (const m of MUTATIONS) {
  const src = original.get(m.file)
  const hit = m.crlf === true
    ? (src.split('\r\n    attemptId,\r\n').length - 1) + (src.split('\n    attemptId,\n').length - 1)
    : src.split(m.from).length - 1
  if (hit !== 1) { console.log(`  ✖ 锚点不唯一（${hit} 次）：${m.name}`); process.exit(1) }
}

console.log('基线：')
const base = run()
console.log(`  退出码 ${base.code} · ${base.line}`)
if (base.code !== 0) { console.log('  ✖ 基线本应是绿的'); process.exit(1) }

let bad = 0
const restoreAll = () => { for (const [f, s] of original) writeFileSync(f, s) }
try {
  for (const m of MUTATIONS) {
    const src = original.get(m.file)
    const mutated = m.crlf === true
      ? (src.split('\r\n    attemptId,\r\n').length - 1 === 1
        ? src.replace('\r\n    attemptId,\r\n', '\r\n')
        : src.replace('\n    attemptId,\n', '\n'))
      : src.replace(m.from, m.to)
    writeFileSync(m.file, mutated)
    const r = run()
    const bit = r.code !== 0
    console.log(`变异 ${m.name}：`)
    console.log(`  退出码 ${r.code} · ${r.line}${r.failed === '' ? '' : ` · 红的是「${r.failed}」`} · ${bit ? '✔ 咬住了' : '✖ 没咬住'}`)
    if (!bit) bad += 1
    restoreAll()
  }
} finally {
  restoreAll()
}

const same = FILES.every((f) => readFileSync(f, 'utf8') === original.get(f))
const back = run()
console.log('还原：')
console.log(`  三份文件逐字与变异前一致：${same ? '✔' : '✖'} · 退出码 ${back.code} · ${back.line}`)
if (!same) bad += 1
if (back.code !== 0) bad += 1
console.log(bad === 0 ? '\n⇒ 三个方向都咬住，且三份文件已逐字还原。' : `\n⇒ 有 ${bad} 处不符合预期。`)
process.exit(bad === 0 ? 0 : 1)
