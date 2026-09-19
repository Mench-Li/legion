// scripts/prt/ci-reading-integrity.mjs
// ============================================================================
// 「全量 CI 9/9 PASS @ <sha>」这句读数，**必须把树一起说清楚**。
//
// ---------------------------------------------------------------------------
// ★ 起因（第 28 轮）：我自己那些"9/9 PASS"从来没有说过跑在哪棵树上
//
// 本会话第 24～27 轮我跑了 5 次全量 CI，逐条写成：
//
//     | 全量 CI（**交付 HEAD**） | 9/9 PASS，exit 0（HEAD `dd6eb8f`，`.ci/r27b`） | …
//
// 而 `summary.json` 里当时只有 `git head=<sha>` 能回答"跑的哪棵树"——
// **那是提交的名字，不是树的状态**。本轮实测：那一天**每一次**全量 CI
// 都跑在一棵脏树上（同一工作树里还有另一个会话的 13 个已改文件 +
// 441 个未跟踪文件）。
//
//   > `git head` 回答"哪个提交"，读者读成"哪棵树"。
//   > 在一份 9/9 PASS 的报告里，这两个问题**长得一模一样**。
//
// 这是本会话那一族的**第六种形态**：
//   ① 覆盖声明 ② 指针 ③ 计数 ④ 报告标题 ⑤ 表内两格
//   ⑥ **读数的适用范围** —— 绿的是"这棵树"，被读成了"那个提交"
//
// ---------------------------------------------------------------------------
// ★ 两层，刻意分开（因为它们的**可判性**不同）
//
//   第一层 `checkDocDisclosure` —— **能进 CI**：
//     报告的「交付 HEAD」那一行必须写出树的状态，用**封闭词表**：
//       `干净树`  或  `脏树 <N> 改 + <M> 未跟踪`
//     纯文档判据 ⇒ 在任何一次全新检出里都跑得动。
//
//   第二层 `checkArtifacts` —— **只能本机跑**：
//     把报告引用的 `.ci/<dir>/summary.json` 真读出来，核对
//       · 目录存不存在（引用指不到产物 = 一句无法复核的话）
//       · 有没有记 `tree`（没记 ⇒ "没记"，**不许当成干净**）
//       · 报告说"干净树"而产物说脏 ⇒ **张冠李戴**
//     ⚠️ `.ci/` 在 `.gitignore:43` 里、tracked 文件数 **0** ⇒
//      **新检出的树里这份产物根本不存在**，所以这一层**不能**当 CI 门禁：
//      它在 CI 里会永远"没有可核对的产物"，而那种绿是假的。
//
// ★ 它**不**查：读数到底绿不绿（那要看 summary 的 stages），
//   也不查"脏树上的绿算不算数"（那是判断，不是机械事实）。
// ============================================================================
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const HANDOVER_DOC = 'docs/superpowers/prt/PRT-HANDOVER-2026-09-18-ROUND22.md'
export const CI_DIR = '.ci'

/** 「交付 HEAD」那一行的标志词。 */
export const HEAD_ROW_RE = /交付 HEAD/

/**
 * 封闭词表：树的状态只有这几种写法。
 * ★ 封闭是刻意的：「看起来像提了树」的自由文本（"已确认工作树"）与
 *   真的提了树，在正则下的区别是**猜**出来的。
 */
export const TREE_TOKENS = Object.freeze({
  clean: /干净树/,
  dirty: /脏树\s*\d+\s*改\s*\+\s*\d+\s*未跟踪/,
})

/**
 * ★★ 什么才算**一条 CI 读数行**（第 28 轮实测踩到的坑，必须记下来）。
 *
 * 第一版只要求"这一行以 `|` 开头、且含『交付 HEAD』"，于是它**当场红在一处
 * 完全正确的地方**：第十四节自己的那张对照表里有一行
 *
 *     | 文档层 | 「交付 HEAD」那一行必须用**封闭词表**写树 | **能**（纯文本） |
 *
 * ——那是在**说这条规则**，不是在**报告一次 CI 读数**。两者被当成了同一种东西。
 *
 * 这是第 26 轮 `ANCHOR_AMBIGUOUS` 那个坑的**新形态**：
 * *一段解释"这个标签为什么要被检查"的文字，自己变成了第二个匹配。*
 * 处置也一样：**把谓词写准**，而不是去改文档（文档那句话是对的）。
 *
 * 谓词：以 `|` 开头 + 含「交付 HEAD」+ **含 `PASS`**（读数行的必要特征）。
 * ⇒ 只提到标签的散文行不算；而**没写 `.ci/` 引用的**读数行仍然算（不给漏洞）。
 */
export function isCiReadingRow(line) {
  const t = String(line)
  return t.trim().startsWith('|') && HEAD_ROW_RE.test(t) && /PASS/.test(t)
}

/** 报告里引用到的 `.ci/<dir>` 目录名（去重、保序）。 */
export function parseCiCitations(text) {
  const out = []
  const seen = new Set()
  for (const m of String(text).matchAll(/`\.ci\/([A-Za-z0-9._-]+)`/g)) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    out.push(m[1])
  }
  return out
}

/**
 * 第一层：**「交付 HEAD」那一行必须写出树的状态**（CI 可跑，纯文档）。
 *
 * 只约束「交付 HEAD」这一行，因为它是读者最依赖的那一行
 * （其余行带着具体轮次，读的人知道那是某一轮的快照）。
 */
export function checkDocDisclosure({ text }) {
  const lines = String(text).split(/\r?\n/)
  const violations = []
  let headRows = 0

  for (let i = 0; i < lines.length; i++) {
    if (!isCiReadingRow(lines[i])) continue
    headRows += 1
    const l = lines[i]
    if (!TREE_TOKENS.clean.test(l) && !TREE_TOKENS.dirty.test(l)) {
      violations.push({
        id: 'ci-head-row-tree-undisclosed', line: i + 1,
        message: `第 ${i + 1} 行是「交付 HEAD」的 CI 读数，但**没说跑在哪棵树上**。`
          + '`git head=<sha>` 回答的是"哪个提交"，不是"哪棵树"——'
          + '读者会把「这棵树是绿的」读成「那个提交是绿的」。'
          + '写法：`干净树` 或 `脏树 <N> 改 + <M> 未跟踪`。',
      })
    }
  }

  if (headRows === 0) {
    violations.push({
      id: 'ci-head-row-missing',
      message: '报告里找不到「交付 HEAD」那一行 ⇒ 这条判据**什么都没查**。'
        + '一个扫到 0 行的门禁与一个全部合规的门禁，在只报 ok 的输出里是同一个东西。',
    })
  }
  return { ok: violations.length === 0, headRows, violations }
}

/** 读一份 summary 的 `tree`；缺字段 ⇒ `known:false`（**不许当成干净**）。 */
export function readSummaryTree(summaryPath) {
  if (!existsSync(summaryPath)) return { known: false, reason: 'summary.json 不存在' }
  let j
  try {
    j = JSON.parse(readFileSync(summaryPath, 'utf8'))
  } catch (e) {
    return { known: false, reason: 'summary.json 解析失败：' + e.message }
  }
  const t = j.tree
  if (t === undefined || t === null) {
    return { known: false, reason: '这份 summary 没有 `tree` 字段（第 28 轮之前跑的）' }
  }
  return { known: t.known === true, ...t }
}

/**
 * 第二层：**本机**把产物真读出来核对。见文件头：`.ci/` 不进版本库，
 * 所以这一层**不能**当 CI 门禁。
 *
 * ★ 只对 **「交付 HEAD」那一行引用的那一份**产物判红，其余引用算**历史**。
 *
 *   第一版要求"报告引用的**每一份** summary 都要记树"，于是它报了 6 条红——
 *   全是第 22～27 轮的老产物，**它们的树状态当年根本没被记录，今天补不上**。
 *   一条会红在 6 个**改不动**的地方的规则，下场就是被人整体关掉
 *   （与 §5.9「全仓 N 例都不许过期」、§5.11「任何状态下都不许 `—`」是同一种错）。
 *   ⇒ 历史产物**只报数不判红**：它们是当年的快照。
 */
export function checkArtifacts({ cwd = REPO, text }) {
  const doc = text ?? readFileSync(resolve(cwd, HANDOVER_DOC), 'utf8')
  const citations = parseCiCitations(doc)
  const headLine = doc.split(/\r?\n/).find((l) => isCiReadingRow(l)) ?? ''
  const saysClean = TREE_TOKENS.clean.test(headLine)
  // 「交付 HEAD」那一行引用的目录 —— 只有这一份是**当前**读数
  const currentDirs = new Set(parseCiCitations(headLine))

  const readings = citations.map((dir) => {
    const p = resolve(cwd, CI_DIR, dir, 'summary.json')
    return {
      dir, exists: existsSync(p), path: p, current: currentDirs.has(dir),
      ...readSummaryTree(p),
    }
  })

  const violations = []
  // ① 引用指不到产物：**只对当前那一条判红**（历史的可能已被清理）
  const currentReadings = readings.filter((r) => r.current)
  if (currentReadings.length === 0) {
    violations.push({
      id: 'ci-reading-scan-empty',
      message: '「交付 HEAD」那一行没有引用任何 `.ci/<dir>` ⇒ 这一层**什么都没查**。',
    })
  }
  for (const r of currentReadings) {
    if (!r.exists) {
      violations.push({
        id: 'ci-reading-artifact-missing', dir: r.dir,
        message: `「交付 HEAD」引用了 \`.ci/${r.dir}\`，但那份 summary.json 不存在 ⇒ `
          + '当前这条读数在本机无法复核。',
      })
    } else if (!r.known) {
      violations.push({
        id: 'ci-reading-tree-unknown', dir: r.dir,
        message: `「交付 HEAD」引用的 \`.ci/${r.dir}\` 没记树的状态（${r.reason}）⇒ `
          + '当次读数回答不了"绿的是哪棵树"。',
      })
    }
  }

  // ★ 张冠李戴：报告那行说"干净树"，而当前那份产物说脏
  const cur = currentReadings.filter((r) => r.known)
  if (saysClean && cur.length > 0 && cur.every((r) => r.dirty === true)) {
    violations.push({
      id: 'ci-reading-clean-but-dirty',
      message: '报告那一行写着 `干净树`，而它引用的产物写着**脏** '
        + `（${cur.map((r) => '`.ci/' + r.dir + '`').join('、')}）⇒ 张冠李戴。`,
    })
  }

  const historical = readings.filter((r) => !r.current)
  return {
    ok: violations.length === 0,
    available: currentReadings.some((r) => r.exists),
    cited: citations.length,
    clean: readings.filter((r) => r.known && r.dirty === false).length,
    dirty: readings.filter((r) => r.known && r.dirty === true).length,
    unknown: readings.filter((r) => r.exists && !r.known).length,
    // ★ 历史引用单独报：它们是当年的快照，**不判红**，但要说出来有多少条
    historical: historical.length,
    historicalUnrecorded: historical.filter((r) => !r.known).length,
    saysClean, readings, violations,
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//   node scripts/prt/ci-reading-integrity.mjs              # 只跑第一层（CI 用）
//   node scripts/prt/ci-reading-integrity.mjs --artifacts  # 外加第二层（本机）
const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const cwd = REPO
  const text = readFileSync(resolve(cwd, HANDOVER_DOC), 'utf8')
  const doc = checkDocDisclosure({ text })
  console.log(`ci-reading-integrity（文档层）：找到 ${doc.headRows} 行「交付 HEAD」读数`)
  for (const v of doc.violations) console.log(`  ✖ ${v.message}`)
  if (doc.ok) console.log('  ✅ 那一行写出了跑在哪棵树上')

  let ok = doc.ok
  if (process.argv.includes('--artifacts')) {
    const art = checkArtifacts({ cwd, text })
    console.log('')
    console.log(`ci-reading-integrity（产物层，仅本机）：引用 ${art.cited} 份 —— `
      + `干净 ${art.clean}、脏 ${art.dirty}、没记 ${art.unknown}；`
      + `其中历史引用 ${art.historical} 份（没记树状态的 ${art.historicalUnrecorded} 份，**不判红**）`)
    if (!art.available) {
      console.log('  ⚠ 本机没有任何 `.ci/` 产物可核对（`.ci/` 在 .gitignore:43）'
        + '——这一层**不能**当 CI 门禁，那种绿是假的。')
    }
    for (const v of art.violations) console.log(`  ✖ ${v.message}`)
    if (art.ok && art.available) console.log('  ✅ 每条引用都指得到产物，且没有张冠李戴')
    ok = ok && (art.ok || !art.available)
  }
  process.exit(ok ? 0 : 1)
}
