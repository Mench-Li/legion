// scripts/prt/spec-status-calibration.mjs
// ============================================================================
// 规格文档（`MULTI-AGENT-FEATURE-OPTIMIZATION.md`）标题里的**状态注记**
// 必须与功能状态表**对得上**。
//
// ---------------------------------------------------------------------------
// ★ 起因（第 29 轮）：**目标点名的那份输入文档**自己在说工作没做完
//
// 目标原话是「以这份文档要增加的功能为基础」。而它的 §4 每个功能标题后面
// 括着**写作当时**的状态注记：
//
//     #### F-01 Runtime Contract（基础已落地，收口中）
//     #### F-03 Runtime Manager（规格已定义，产品级闭环待补）
//     #### F-10 Permission Engine（控制面基础已落地，DSH 工具全量接线待收口）
//     #### F-12 Product Launcher（产品级 Launcher 待完成）
//
// 实测：**8 条带注记的标题里，7 条说"还没做完"，而状态表里那 7 条全是 ✅**
// （只有 F-04 仍是 🟡，它的注记是对的）。
//
//   > 一份说"F-12 待完成"的设计文档，与一份说"F-12 ✅"的进度表，
//   > 放在一起，**读者信哪一份取决于他先打开哪一份**。
//
// 这是本会话那一族的**第七种形态**：不再是"某个数没人核"，
// 而是**两份文档对同一件事各说各话，且没有一处交叉引用**。
//
//   ① 覆盖声明 ② 指针 ③ 计数 ④ 报告标题 ⑤ 表内两格 ⑥ 读数适用范围
//   ⑦ **跨文档的状态各说各话**
//
// ---------------------------------------------------------------------------
// ★ 处置：**不删注记**，而是把"它已被取代"这件事写成一张可核对的表
//
// 注记是**设计期的快照**，删掉等于篡改历史（与本会话一贯的做法一致：
// 历史读数冻结、当前读数跟着代码走）。⇒ 在 §1.1 之后加一节 §1.2
// **校准表**，逐条写明"当时的注记 → 现在是什么 → 依据"。
//
// 于是这条判据的规则可以写得很窄、不需要猜：
//
//   R1 标题注记**说没做完** + 状态表里这个 F-NN **已全 ✅**
//      ⇒ 它**必须**出现在校准表里（否则读者被那句注记误导）
//   R2 校准表里每条的状态，必须**等于**状态表当前的状态
//      （⇒ 万一哪天 F-01 退回 🟡，校准表会红，而不是继续宣称 ✅）
//   R3 校准表里不许有**没有被取代**的条目
//      （注记本身没说完、或还没做完的，写进去就是一句新的、没人核的话）
//
// ★ 只有 R1 的"说没做完"需要识别语义，所以那部分用**封闭词表**
//   （待补/收口/待完成/尚未/未完成/部分）——自由文本下的识别是**猜**。
//   刻意**不**去判断"收口中"到底算不算"没做完"这种模糊问题：
//   词表命中即算，宁可多要求几条校准。
// ============================================================================
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★★★ 第 47 轮：功能对照表的**状态词表所有者**是 `progress-check.mjs`。
//   本模块此前自己读状态格、认不出就归进 `aggregate` 的"其余 ⇒ 🟡"那一支
//   ⇒ "读不出来"与"部分完成"在汇总里同形。现在**取**它、并把认不出改成抛。
import { FEATURE_STATUS_MARKS, FEATURE_STATUS_RE } from './progress-check.mjs'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SPEC_DOC = 'docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md'
export const STATUS_DOC = 'docs/MULTI-AGENT-FEATURE-STATUS.md'

/** 规格标题里的状态注记：`#### F-01 标题（注记）`。 */
export const HEADING_RE = /^####\s*(F-\d+)\s+([^\n（(]*?)\s*(?:[（(]([^）)]*)[）)])?\s*$/gm

/**
 * **封闭词表**：注记里出现这些词，就算它在说"还没做完"。
 * ★ 封闭是刻意的 —— 自由文本下的识别是猜出来的（见文件头）。
 */
export const INCOMPLETE_TOKENS = Object.freeze([
  '待补', '收口', '待完成', '尚未', '未完成', '部分',
])

/** 校准表所在的小节标题。 */
export const CALIBRATION_HEADING = '## 1.2'

/** 判断一条注记是否在说"还没做完"。 */
export function assertsIncomplete(note) {
  if (note === null || note === undefined) return false
  return INCOMPLETE_TOKENS.some((t) => note.includes(t))
}

/** 从状态格取**终点**状态（`🟡→✅` ⇒ `✅`）。 */
export function endState(status) {
  const parts = String(status).split('→')
  return (parts[parts.length - 1] ?? String(status)).trim()
}

/**
 * 抽出规格文档里的 8 条带注记标题。
 * 返回 `[{id, title, note, incomplete}]`。
 */
export function parseSpecHeadings(specText) {
  const out = []
  const seen = new Set()
  for (const m of String(specText).matchAll(HEADING_RE)) {
    const id = m[1]
    if (seen.has(id)) continue          // 同一个 F-NN 只取第一个标题
    seen.add(id)
    const note = m[3] === undefined ? null : m[3].trim()
    out.push({ id, title: (m[2] ?? '').trim(), note, incomplete: assertsIncomplete(note) })
  }
  return out
}

/**
 * 状态表里 F-NN → 状态（可能多行，如 `F-05 前半` / `F-05 后半`）。
 * 返回 `Map<F-NN, {rows, statuses, aggregate}>`。
 *
 * `aggregate`：全部 ✅ ⇒ `✅`；全部 ⏸ ⇒ `⏸`；其余 ⇒ `🟡`。
 *
 * ★★★ 第 47 轮：本函数此前是**功能对照表的第三个手写解析器** ——
 *   自己判行、自己分格、**自己定格子数**（`≠5 且 ≠6 ⇒ continue`）、
 *   自己取状态；而"认不出的状态"会安静地落进 `aggregate` 的
 *   **"其余 ⇒ 🟡"** 那一支。
 *
 *   > 一个"认不出就算部分完成"的默认值，与一份"真的有一部分没做完"的表，
 *   > 在汇总里是同一个读数——
 *   > 只不过前者会把**读不出来的东西**报成一个**看起来需要关注**的数。
 *
 *   实测（`scratch/_probe-status-table-owner.mjs`）：
 *
 *   | 输入 | 旧 `parseStatusTable` | 所有者（`featureRows`）|
 *   | --- | --- | --- |
 *   | 状态格 = `🔵` | 静默算成 **🟡** | **抛** |
 *   | 4 格 / 7 格的状态行 | **静默跳过** | 收下 |
 *   | 真文档 | 25 个 F-NN / 29 行 | 25 个 F-NN / 29 行（**一致**）|
 *
 *   ⇒ 差异**今天不显形**（真文档里没有 🔵、也没有 4/7 格的状态行），
 *     而这正是修它的时候。
 *
 *   ★ 另有一个**就在本文件里**的旁证：`parseCalibration()` 用的是
 *     `cells.length < 4 ⇒ continue`，而本函数用的是 `≠5 且 ≠6` ——
 *     **同一个文件里两个函数对同一张表用了两条不同的接受规则**。
 *     现在两者都对齐到所有者那条**量出来的**阈值（`>= 4`）。
 */
export function parseStatusTable(statusText) {
  const map = new Map()
  for (const line of String(statusText).split(/\r?\n/)) {
    if (!/^\|\s*F-\d+/.test(line)) continue
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
    // ★ 阈值 `< 4` 与 `parseCalibration()` 及所有者一致（见上面那段）。
    if (cells.length < 4) continue
    // ★★ 状态格必须是所有者许可的形状之一 —— **认不出就抛**，不再默认成 🟡。
    if (!FEATURE_STATUS_RE.test(cells[2] ?? '')) {
      throw new Error(`功能对照表的状态格不是已知形状：`
        + `第 1 格 "${cells[0].slice(0, 30)}"，第 3 格是 "${cells[2]}"，`
        + `而许可的是 ${FEATURE_STATUS_MARKS.join(' ')}，或其中任意两个用 \`→\` 相连。`
        + `★ 这里**抛**而不是归进"其余 ⇒ 🟡"：那样会把"读不出来"报成"部分完成"，`
        + `两者在汇总里同形（第 47 轮实测形状）。`)
    }
    const key = /^(F-\d+)/.exec(cells[0])[1]
    if (!map.has(key)) map.set(key, { rows: [], statuses: [] })
    const e = map.get(key)
    e.rows.push(cells[0])
    e.statuses.push(endState(cells[2]))
  }
  for (const e of map.values()) {
    e.aggregate = e.statuses.every((s) => s === '✅') ? '✅'
      : e.statuses.every((s) => s.startsWith('⏸')) ? '⏸' : '🟡'
  }
  return map
}

/**
 * 抽出 §1.2 校准表：`| F-01 | <原文注记> | ✅ | <依据> |`。
 * ★ 只认**第一节**里的那张表，避免把别处的 F-* 表格读进来。
 */
export function parseCalibration(specText) {
  const lines = String(specText).split(/\r?\n/)
  let inSection = false
  const out = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inSection = line.startsWith(CALIBRATION_HEADING)
      continue
    }
    if (!inSection) continue
    if (!/^\|\s*F-\d+/.test(line)) continue
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim())
    if (cells.length < 4) continue
    out.push({ id: /^(F-\d+)/.exec(cells[0])[1], note: cells[1], status: endState(cells[2]), basis: cells[3] })
  }
  return out
}

/** 核对三件事（R1/R2/R3），并把扫描面一起报出来。 */
export function checkCalibration({ specText, statusText }) {
  const headings = parseSpecHeadings(specText)
  const statuses = parseStatusTable(statusText)
  const calib = parseCalibration(specText)
  const calibById = new Map(calib.map((c) => [c.id, c]))
  const violations = []

  // ★ 扫描面为空 ⇒ "什么都没查"，不许报绿
  if (headings.filter((h) => h.incomplete).length === 0) {
    violations.push({
      id: 'spec-headings-empty',
      message: '规格文档里一条"说没做完"的标题注记都没解析到 ⇒ 这条判据**什么都没查**。'
        + '（解析器跑偏与"全部合规"在只报 ok 的输出里是同一个东西。）',
    })
  }
  if (calib.length === 0) {
    violations.push({
      id: 'calibration-empty',
      message: `规格文档里找不到 §${CALIBRATION_HEADING.slice(3)} 校准表（或它是空的）⇒ `
        + '标题注记与状态表之间没有任何交叉引用。',
    })
  }

  // R1：注记说没做完 而 表里已全 ✅ ⇒ 必须在校准表里
  let superseded = 0
  for (const h of headings) {
    if (!h.incomplete) continue
    const st = statuses.get(h.id)
    if (st === undefined) continue          // 状态表里没有这个 F-NN，不归这条判据管
    if (st.aggregate !== '✅') continue     // 还没做完 ⇒ 注记仍然成立
    superseded += 1
    if (!calibById.has(h.id)) {
      violations.push({
        id: 'spec-note-superseded-unlisted', id_short: h.id,
        message: `规格标题 ${h.id} 的注记「${h.note}」说还没做完，`
          + `而状态表里 ${st.rows.join(' / ')} = ${st.statuses.join(' / ')}（全 ✅）`
          + `⇒ 这条注记**已被取代**，但它不在 §${CALIBRATION_HEADING.slice(3)} 校准表里。`
          + '读者打开规格文档会以为这项工作没做完。',
      })
    }
  }

  // R2：校准表里的状态必须等于状态表当前的状态
  for (const c of calib) {
    const st = statuses.get(c.id)
    if (st === undefined) {
      violations.push({
        id: 'calibration-unknown-feature', id_short: c.id,
        message: `校准表里的 ${c.id} 在状态表里找不到 ⇒ 它校准的是一个不存在的行。`,
      })
      continue
    }
    if (c.status !== st.aggregate) {
      violations.push({
        id: 'calibration-status-mismatch', id_short: c.id,
        message: `校准表说 ${c.id} 是「${c.status}」，而状态表当前是「${st.aggregate}」`
          + `（${st.rows.join(' / ')} = ${st.statuses.join(' / ')}）⇒ 校准表自己过期了。`,
      })
    }
  }

  // R3：校准表里不许有**没有被取代**的条目
  const headingById = new Map(headings.map((h) => [h.id, h]))
  for (const c of calib) {
    const h = headingById.get(c.id)
    if (h === undefined || !h.incomplete) {
      violations.push({
        id: 'calibration-not-superseded', id_short: c.id,
        message: `校准表里的 ${c.id} 在规格里**没有**一条"说没做完"的标题注记 ⇒ `
          + '这条校准没有对象（它是新写的一句、没有任何东西对照的话）。',
      })
      continue
    }
    const st = statuses.get(c.id)
    if (st !== undefined && st.aggregate !== '✅') {
      violations.push({
        id: 'calibration-not-superseded', id_short: c.id,
        message: `校准表里的 ${c.id} 当前状态是「${st.aggregate}」⇒ 那条注记**还没被取代**，`
          + '不该出现在"已被取代"的校准表里。',
      })
    }
  }

  return {
    ok: violations.length === 0,
    headings: headings.length,
    annotated: headings.filter((h) => h.incomplete).length,
    superseded, calib: calib.length,
    violations,
  }
}

/** 从磁盘按真实仓库核对。 */
export function checkRepo({ cwd = REPO } = {}) {
  return checkCalibration({
    specText: readFileSync(resolve(cwd, SPEC_DOC), 'utf8'),
    statusText: readFileSync(resolve(cwd, STATUS_DOC), 'utf8'),
  })
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const r = checkRepo()
  console.log(`spec-status-calibration: 规格标题 ${r.headings} 条，其中带"没做完"注记 ${r.annotated} 条；`
    + `已被取代 ${r.superseded} 条；校准表 ${r.calib} 条`)
  for (const v of r.violations) console.log(`  ✖ ${v.message}`)
  if (r.ok) console.log('  ✅ 每条被取代的注记都在校准表里，且校准表与状态表一致')
  process.exit(r.ok ? 0 : 1)
}
