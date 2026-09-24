// scripts/probes/feature-row-judges.mjs
// ============================================================================
// **T5**（2026-09-24）：权威表（`docs/MULTI-AGENT-FEATURE-STATUS.md` 的 F-01～F-25）
// 里每一条 **✅** 行，**有没有一条别人能复跑的判据**。
//
// ## 为什么要它
//
// T5 行原话是「**16 条 ✅ 行**做**声称级**核对」：每行一条可复跑判据，
// 否则**如实降级"未核"**。
//
//   > "这一条 ✅ 了"与"这一条有东西在核"，在表里是同一个 ✅。
//   > 把后者当前者读，表就从"读数"变成了"愿望"。
//
// 本轮先量：**✅ 行的数量不是 16，是 18**（另有 3 行是 `🟡→✅`）；而"可复跑判据"
// 有三种来源，强度依次不同：
//
//   ① **点名 F-id 的套件**（`run-ci.mjs` 里 `label: '…（F-18：…）'`）—— 最强：
//      套件自己声明覆盖哪个功能，且门禁会跑它；
//   ② 行里**引用**的套件名（`` 套件 `context-store` ``）—— 中等：名字存在且真能跑，
//      但"覆盖到什么程度"是作者说的；
//   ③ 行里**引用**的 `scripts/**` 判据脚本（存在即可复跑）—— 中等。
//
// ## 为什么它是**普查**而不是门禁（这一条是本脚本存在的理由）
//
// 把"✅ 行必须有判据"直接做成门禁 ⇒ 今天**立刻红**，而红的意思是
// "**有若干行需要如实降级**"。降级是一次**对业主可见的表态**（把 ✅ 改成"未核"），
// 不是机械动作 —— 本脚本**先把名单印出来**，把那个决定留给该做决定的人。
//
//   这与本仓处理"41 个不可达模块"的方式一致：先**清点**（`reachability --diff`），
//   再逐条挂裁决处，而不是把门禁一按、让所有人对着红灯猜。
//
// 用法：node scripts/probes/feature-row-judges.mjs [--json]
// 退出码：0 = 印完了（**这不表示"每行都有判据"**，看输出）；找不到文档 ⇒ 3（未观察）。
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { featureTableRow } from '../prt/progress-check.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
export const STATUS_DOC = 'docs/MULTI-AGENT-FEATURE-STATUS.md'
export const CI_SCRIPT = 'scripts/ci/run-ci.mjs'

/** `run-ci.mjs` 里**点名 F-id** 的套件标签：`…（F-18：摩擦只从…）`。
 *  ★ 排除区间写法（`（F-01～F-25 …）` 是整表的套件，不是某一条的判据）。 */
export function idNamedSuites(ciText) {
  const out = []
  for (const m of String(ciText).matchAll(/label:\s*'([^']*（(F-\d+)([^']*)')/g)) {
    if (/^[～~]/.test(m[3] ?? '')) continue
    out.push({ label: m[1], feature: m[2] })
  }
  return out
}

/** `run-ci.mjs` 里所有套件标签的集合（用来判"引用的套件名真的存在吗"）。 */
export function knownSuiteLabels(ciText) {
  return new Set([...String(ciText).matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]))
}

/**
 * 逐条 ✅ 行判"有没有可复跑的判据"。
 *
 * @param {{statusText: string, ciText: string, exists?: (rel: string) => boolean}} input
 */
export function rowJudges({ statusText, ciText, exists = (rel) => existsSync(resolve(REPO, rel)) }) {
  const idNamed = idNamedSuites(ciText)
  const labels = knownSuiteLabels(ciText)
  const rows = []
  for (const [i, line] of String(statusText).split(/\r?\n/).entries()) {
    const r = featureTableRow(line)
    if (r === null) continue
    if (!r.status.includes('✅')) continue
    const text = r.cells.join(' ')
    const judges = []
    for (const s of idNamed) {
      // ★ `note: null` 不能省：第一版这里没有这个字段，而下面按 `note === null` 收"可用"，
      //   于是 `undefined !== null` ⇒ **最强的那一类判据被静默排除**，
      //   名单里凭空多出一批"没有判据"的 ✅ 行（我第一版据此读到"16 条"，那是**错数**）。
      if (s.feature === r.id) judges.push({ kind: 'named-suite', what: s.label, strong: true, note: null })
    }
    for (const m of text.matchAll(/套件\s*`([^`]+)`/g)) {
      const name = m[1]
      const inCi = [...labels].some((l) => l.startsWith(name) || l.includes(name))
      judges.push({
        kind: 'cited-suite', what: name, strong: false,
        note: inCi ? null : '★ 这个名字在 `run-ci.mjs` 的套件标签里找不到',
      })
    }
    for (const m of text.matchAll(/`(scripts\/[\w./-]+\.mjs)`/g)) {
      judges.push({ kind: 'cited-script', what: m[1], strong: false, note: exists(m[1]) ? null : '★ 这个脚本不存在' })
    }
    const usable = judges.filter((j) => j.note == null)   // ★ 宽松比较，见上
    rows.push({
      line: i + 1, id: r.id, status: r.status,
      judges, usable: usable.length,
      strongest: usable.some((j) => j.strong) ? 'named-suite' : (usable.length > 0 ? usable[0].kind : null),
    })
  }
  const unverified = rows.filter((r) => r.usable === 0)
  return {
    ok: true,                       // ★ 普查：不判红，见文件头"为什么它是普查而不是门禁"
    rows, unverified,
    namedSuiteCount: idNamed.length,
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const statusPath = resolve(REPO, STATUS_DOC)
  if (!existsSync(statusPath)) {
    console.log(`feature-row-judges: **未观察**（不是通过）—— 找不到 ${STATUS_DOC}`)
    process.exit(3)
  }
  const r = rowJudges({
    statusText: readFileSync(statusPath, 'utf8'),
    ciText: readFileSync(resolve(REPO, CI_SCRIPT), 'utf8'),
  })
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    console.log(`feature-row-judges（T5 普查）：✅ 行 ${r.rows.length} 条；`
      + '`run-ci.mjs` 里点名 F-id 的套件 ' + r.namedSuiteCount + ' 个')
    console.log('  最强判据（点名该 F-id 的套件）：'
      + (r.rows.filter((x) => x.strongest === 'named-suite').map((x) => x.id).join(' ') || '（无）'))
    console.log('  只有"引用式"判据（套件名 / 判据脚本）：'
      + (r.rows.filter((x) => x.strongest !== null && x.strongest !== 'named-suite').map((x) => x.id).join(' ') || '（无）'))
    console.log(`  ★ **没有可复跑判据** ${r.unverified.length} 条：`
      + (r.unverified.map((x) => `${x.id}（第 ${x.line} 行）`).join(' ') || '（无）'))
    console.log('  ★ 本脚本**不判红**（理由见文件头）：把"✅ 行必须有判据"做成门禁')
    console.log('     会立刻红，而红的意思是"有若干行需要**如实降级未核**" ——')
    console.log('     那是一次对业主可见的表态，不是机械动作。名单在上面。')
  }
  process.exit(0)
}
