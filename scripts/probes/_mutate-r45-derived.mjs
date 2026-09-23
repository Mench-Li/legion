// scripts/probes/_mutate-r45-derived.mjs —— 第 45 轮（第三段）破验：**派生**那两条会咬人吗
//
// ★ 被验的两条性质：
//
//     D1 `intervention-coverage.NON_DONE_STATUSES` 是**派生**的
//        （词表加一个标记 ⇒ 它立刻多一个）
//     D2 `boundary-facts.GENERATED_STATUS_VOCAB` **⊇** 台账词表
//        （生成物词表不许比它引用的那次普查窄）
//
// ★★ 为什么必须用**变异**而不是"看它今天是绿的"：
//   D1：手写的 `['🟡','⬜','⏸']` 与派生结果**逐字节相等**；今天任何输入都分不开。
//   D2：并集与子集在两个判据今天的那个仓库上读数**都是 0**（实测），
//       所以"表窄了"这件事**没有任何真实输入能触发**。
//
//   > 一个"从词表算出来"的实现，与一个"把标记手写一遍"的实现，
//   > 在词表**没变**的时候结果完全一样。
//
// ★ 纪律：一条一跑；信号与 `exit` 上补还原；逐字节还原（sha256）后才算通过。
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const OWNER = `${ROOT}/scripts/prt/progress-check.mjs`
const FACTER = `${ROOT}/scripts/prt/boundary-facts.mjs`
const SUITE_IV = 'scripts/prt/intervention-coverage.test.mjs'
const SUITE_BF = 'scripts/prt/boundary-facts.test.mjs'

const sha = (b) => createHash('sha256').update(b).digest('hex')

const PRISTINE = new Map()
for (const f of [OWNER, FACTER]) PRISTINE.set(f, readFileSync(f))
const restoreAll = () => { for (const [f, b] of PRISTINE) writeFileSync(f, b) }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); process.exit(130) })
}
process.on('exit', () => {
  for (const [f, b] of PRISTINE) {
    if (sha(readFileSync(f)) !== sha(b)) writeFileSync(f, b)
  }
})

function runSuite(file) {
  try {
    const out = execFileSync('node', ['--test', file], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return sum(out, 0)
  } catch (e) {
    return sum(String(e.stdout ?? ''), e.status ?? 1)
  }
}
function sum(out, code) {
  const g = (re) => { const m = re.exec(out); return m === null ? null : Number(m[1]) }
  return { ok: code === 0, pass: g(/^ℹ pass (\d+)$/m), fail: g(/^ℹ fail (\d+)$/m),
    tail: out.trim().split('\n').slice(-3).join(' | ').slice(0, 180) }
}

/** 换行符无关的替换。 */
function swap(file, from, to) {
  const buf = readFileSync(file)
  const text = buf.toString('utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const f = from.split('\n').join(eol)
  const t = to.split('\n').join(eol)
  const hits = text.split(f).length - 1
  if (hits !== 1) return { err: `锚点命中 ${hits} 次（应为 1）；换行=${eol === '\r\n' ? 'CRLF' : 'LF'}` }
  writeFileSync(file, text.replace(f, t))
  return { ok: true }
}

const ONLY = process.argv[2] ?? null
const results = []

function mutate({ label, file, from, to, suite }) {
  if (ONLY !== null && !label.startsWith(ONLY)) return
  const buf = readFileSync(file)
  const r = swap(file, from, to)
  if (r.err !== undefined) {
    console.log(`  ✖ ${label}：${r.err}`)
    console.log('     ⚠️ 也请核对：**上一次变异跑是不是被杀了、把这个文件留在变异形态**？')
    results.push(false)
    return
  }
  let res
  try {
    res = runSuite(suite)
  } finally {
    writeFileSync(file, buf)
  }
  const restored = sha(readFileSync(file)) === sha(buf)
  const red = res.ok === false
  const ok = red && restored
  console.log(`  ${ok ? '✔' : '✖'} ${label}`)
  console.log(`      ${suite}：exit=${res.ok ? 0 : 1} pass=${res.pass} fail=${res.fail}`
    + `  咬住=${red} 还原=${restored}`)
  if (!ok) console.log(`      ⇒ ${res.tail}`)
  results.push(ok)
}

console.log('第 45 轮（第三段）破验：派生那两条会不会咬人\n')

// ── D1：`nonDoneStatuses` 退回"照抄一份"（不再过滤）──
//    ★ 期望红：⑬d 里"给它一张只含完成标记的词表，结果必须是空"会报。
mutate({
  label: 'D1 `nonDoneStatuses` 不再过滤（退回照抄）⇒ 套件必须红',
  file: OWNER,
  from: 'return Object.freeze(marks.filter((m) => m !== DONE_STATUS_MARK))',
  to: 'return Object.freeze([...marks])',
  suite: SUITE_IV,
})

// ── D2：`DONE_STATUS_MARK` 取错一格 ⇒ 完成的那一个不被排除 ──
mutate({
  label: 'D2 `DONE_STATUS_MARK` 取错（取第 2 个）⇒ 套件必须红',
  file: OWNER,
  from: 'export const DONE_STATUS_MARK = STATUS_MARKS[0].mark',
  to: 'export const DONE_STATUS_MARK = STATUS_MARKS[1].mark',
  suite: SUITE_IV,
})

// ── D3：生成物词表退回**窄的那一份**（只有散文写法，丢掉四个标记）──
//    ★ 期望红：⑯ 的包含关系会报。
mutate({
  label: 'D3 生成物词表退回窄子集（丢掉四个标记）⇒ 套件必须红',
  file: FACTER,
  from: 'export const GENERATED_STATUS_VOCAB = Object.freeze([\n  ...LEDGER_STATUS_MARKS,\n  ...STATUS_WORD_FORMS,\n])',
  to: "export const GENERATED_STATUS_VOCAB = Object.freeze([\n  ...STATUS_WORD_FORMS,\n])",
  suite: SUITE_BF,
})

const good = results.filter(Boolean).length
console.log(`\n  汇总：${good}/${results.length} 咬住`)
if (results.length > 0 && good === results.length) console.log('  逐字节还原 ✔')
process.exit(good === results.length ? 0 : 1)
