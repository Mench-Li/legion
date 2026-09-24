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
// ## 为什么它**曾经**是普查、现在**是**门禁（2026-09-24 同轮升级）
//
// 第一版**不判红**，因为"✅ 行必须有判据"直接做门禁 ⇒ 立刻红，而红的意思是
// "有若干行需要**如实降级未核**"——那是一次对业主可见的表态，不是机械动作。
//
// 本轮把那 6 行的表态**落了**（文档里就地标 `未核（T5）`）之后，判红的口径随之改变：
//
//   > 它现在判的**不是**"每行都必须有判据"，而是"**普查名单与文档里的标记必须一致**"。
//   > 前者要求所有人立刻做决定；后者只要求**已经做过的决定不许悄悄漂回去**。
//
// ⇒ 未核的行必须带标记、带标记的行必须真未核，两边都不许单方面变化。
//    （本仓处理"两份名单各自漂移"用的是同一个形状，见 T7 那次。）
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
/** 文档里"如实降级"用的标记（标准写法，判据按它核）。 */
export const UNVERIFIED_MARK = '未核（T5）'

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
    // ★★ 扫判据时**切掉标记正文**：那句"如实降级"的说明里会引用普查脚本自己，
    //    不切的话它就变成了这一行的"可复跑判据"，于是标记一落、判据就有了 ⇒
    //    `marked-row-has-judge` **必然红**（本轮真的红了一次，这条注释就是那次的产品）。
    const scanText = text.includes(UNVERIFIED_MARK) ? text.slice(0, text.indexOf(UNVERIFIED_MARK)) : text
    const judges = []
    for (const s of idNamed) {
      // ★ `note: null` 不能省：第一版这里没有这个字段，而下面按 `note === null` 收"可用"，
      //   于是 `undefined !== null` ⇒ **最强的那一类判据被静默排除**，
      //   名单里凭空多出一批"没有判据"的 ✅ 行（我第一版据此读到"16 条"，那是**错数**）。
      if (s.feature === r.id) judges.push({ kind: 'named-suite', what: s.label, strong: true, note: null })
    }
    for (const m of scanText.matchAll(/套件\s*`([^`]+)`/g)) {
      const name = m[1]
      const inCi = [...labels].some((l) => l.startsWith(name) || l.includes(name))
      judges.push({
        kind: 'cited-suite', what: name, strong: false,
        note: inCi ? null : '★ 这个名字在 `run-ci.mjs` 的套件标签里找不到',
      })
    }
    for (const m of scanText.matchAll(/`(scripts\/[\w./-]+\.mjs)`/g)) {
      judges.push({ kind: 'cited-script', what: m[1], strong: false, note: exists(m[1]) ? null : '★ 这个脚本不存在' })
    }
    const usable = judges.filter((j) => j.note == null)   // ★ 宽松比较，见上
    rows.push({
      line: i + 1, id: r.id, status: r.status,
      judges, usable: usable.length,
      // ★ 文档里有没有那句"如实降级"的标记（备注格）
      marked: line.includes(UNVERIFIED_MARK),
      strongest: usable.some((j) => j.strong) ? 'named-suite' : (usable.length > 0 ? usable[0].kind : null),
    })
  }
  const unverified = rows.filter((r) => r.usable === 0)
  // ★ 两名单不许漂移：未核的必须带标记；带标记的必须真未核。
  const violations = []
  for (const r of unverified) {
    if (!r.marked) {
      violations.push({ id: 'unverified-row-not-marked', feature: r.id,
        message: `第 ${r.line} 行（${r.id}）**没有任何可复跑的判据**，却没有在备注里标「${UNVERIFIED_MARK}」`
          + '⇒ 它读起来与"有东西在核"的 ✅ 一模一样。' })
    }
  }
  for (const r of rows) {
    if (r.marked && r.usable > 0) {
      violations.push({ id: 'marked-row-has-judge', feature: r.id,
        message: `第 ${r.line} 行（${r.id}）标着「${UNVERIFIED_MARK}」，但它**有**可复跑的判据：`
          + r.judges.filter((j) => j.note == null).map((j) => j.what).join('、')
          + ' ⇒ 标记该撤（标记漂回去与漏标一样，都是名单在说谎）。' })
    }
  }
  return {
    ok: violations.length === 0,     // ★ 判的是"两份名单是否一致"，不是"是否每行都有判据"
    rows, unverified, violations,
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
    for (const v of r.violations) console.log(`  ✖ ${v.message}`)
    if (r.ok) {
      console.log('  ✅ 两份名单一致：未核的都标了「未核（T5）」，标了的都真的未核')
    }
  }
  process.exit(process.argv.includes('--json') ? 0 : (r.ok ? 0 : 1))
}
