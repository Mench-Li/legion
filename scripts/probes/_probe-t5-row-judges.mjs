// scripts/probes/_probe-t5-row-judges.mjs
// T5 变异验证：`feature-row-judges.mjs` 的三种判据来源必须**分得开**，
// 且"没有判据"的判定不许把最强的那一类漏掉（这正是我第一版犯的错）。
// ★ 全部内存 fixture，不写磁盘。
import { rowJudges } from './feature-row-judges.mjs'

const HEAD = '| 编号 | 名称 | 状态 | 代码落点 | 备注 | — |\n|---|---|---|---|---|---|\n'
const CI = "  { label: 'alpha（F-01：甲）', files: [] },\n  { label: 'beta（F-02：乙）', files: [] },\n  { label: 'gamma', files: [] },\n"
let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✔' : '✖'} ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures += 1
}

// ① 点名 F-id 的套件 ⇒ 必须算"最强"，且**不许**落进"没有判据"
{
  const t = HEAD + '| F-01 | 甲 | ✅ | `a/b.mjs` | 无 | — |\n'
  const r = rowJudges({ statusText: t, ciText: CI, exists: () => true })
  check('① 点名 F-id ⇒ strongest=named-suite 且 0 条未核',
    r.rows[0].strongest === 'named-suite' && r.unverified.length === 0,
    `strongest=${r.rows[0].strongest} unverified=${r.unverified.length}`)
}

// ② 引用的套件名在 run-ci 里找不到 ⇒ 不算可用判据（引用会让名字看起来"有人核"）
{
  const t = HEAD + '| F-03 | 丙 | ✅ | `a/b.mjs` | 套件 `不存在套件` | — |\n'
  const r = rowJudges({ statusText: t, ciText: CI, exists: () => true })
  check('② 引用了不存在的套件名 ⇒ 判为未核', r.unverified.length === 1 && r.rows[0].usable === 0,
    `unverified=${r.unverified.length}`)
}

// ③ 引用的 `scripts/**` 判据脚本存在 ⇒ 算可用（引用式）
{
  const t = HEAD + '| F-04 | 丁 | ✅ | `a/b.mjs` | 见 `scripts/prt/x.mjs` | — |\n'
  const r = rowJudges({ statusText: t, ciText: CI, exists: () => true })
  check('③ 引用了存在的判据脚本 ⇒ 可用（非最强）', r.unverified.length === 0 && r.rows[0].strongest === 'cited-script',
    `strongest=${r.rows[0].strongest}`)
}

// ④ 真的什么都没有 ⇒ 未核（这才是"如实降级"的对象）
{
  const t = HEAD + '| F-05 | 戊 | ✅ | `a/b.mjs` | PRT-1 | — |\n'
  const r = rowJudges({ statusText: t, ciText: CI, exists: () => true })
  check('④ 零锚行 ⇒ 未核', r.unverified.length === 1, `unverified=${r.unverified.length}`)
}

// ⑤ 区间标签（`（F-01～F-25 …）`）不算某一条的判据
{
  const ci = "  { label: '整表（F-01～F-25 对照表）', files: [] },\n"
  const t = HEAD + '| F-01 | 甲 | ✅ | `a/b.mjs` | 无 | — |\n'
  const r = rowJudges({ statusText: t, ciText: ci, exists: () => false })
  check('⑤ 区间标签不误配为某条的判据', r.rows[0].strongest === null, `strongest=${r.rows[0].strongest}`)
}

// ⑥ 两名单漂移之一：未核的行**没标**「未核（T5）」⇒ 必须红
{
  const t = HEAD + '| F-06 | 己 | ✅ | `a/b.mjs` | PRT-1 | — |\n'
  const r = rowJudges({ statusText: t, ciText: CI, exists: () => true })
  const bit = !r.ok && r.violations.some((v) => v.id === 'unverified-row-not-marked' && v.feature === 'F-06')
  check('⑥ 未核却没标 ⇒ 红（unverified-row-not-marked）', bit, `ok=${r.ok}`)
}

// ⑦ 两名单漂移之二：**有判据**的行却标着「未核（T5）」⇒ 必须红（标记漂回去与漏标一样是名单说谎）
{
  const t = HEAD + '| F-01 | 甲 | ✅ | `a/b.mjs` | 未核（T5） | — |\n'
  const r = rowJudges({ statusText: t, ciText: CI, exists: () => true })
  const bit = !r.ok && r.violations.some((v) => v.id === 'marked-row-has-judge' && v.feature === 'F-01')
  check('⑦ 有判据却标未核 ⇒ 红（marked-row-has-judge）', bit, `ok=${r.ok}`)
}

console.log(failures === 0 ? '\n  ⇒ T5 普查的三种判据来源分得开（5 反向 + 1 防误配 + 2 漂移守卫）' : `\n  ⇒ 有 ${failures} 处不达预期`)
process.exit(failures === 0 ? 0 : 1)
