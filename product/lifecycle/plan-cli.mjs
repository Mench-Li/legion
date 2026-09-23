// product/lifecycle/plan-cli.mjs
// ============================================================================
// 第 16 条第二刀：把三份**计划**接进生产（PRT-904 / PRT-905 / PRT-908）。
//
// ## 这第二刀补的**不是** CLI，是一个读法
//
// 第一刀（`product/report-cli.mjs`）接的三份报告**没有入参**：入参是各模块自己的默认。
// 而这三份计划的主入口都要一份**磁盘上的现实**：
//
//   · `planExport({stores})`            ← 实际存在的落点（带类别）
//   · `planRetention({entries, nowMs})` ← 逐条的 `{path, bytes, atMs}`
//   · `planUninstall({stores, mode, layout})` ← 同 `planExport`，**外加一个显式模式**
//
// 那份现实由 `product/lifecycle/store-scan.mjs` 读（它自己有一套用例：
// 上限、读不了的目录、符号链接、认不出就不猜）。本文件只负责：**扫哪些根**、**怎么算**、**怎么打**。
//
// ## 三个不许含糊的口径
//
// ### ① 扫哪些根：**全部来自 `resolveLayout`**
//
// 本文件**一个默认值都不加**。根就是布局自己那几个：
// 安装目录（`program`）/ 数据目录 / 工作区 / 缓存 / 日志 / 密钥库（`secret`）/ 产品配置文件（`config`）。
//
// ★ 安装目录**必须**在列表里：`uninstall` 的 `program-only` 模式要删的就是它，
//   漏了它，计划会打印"会删：无"——而模式名正说着要删程序。**漏一个根，就是一份假计划。**
//
// ### ② `findings` 是**内容**，不是退出码
//
// 三份计划都会带回"发现"（`export-entry-unhashed`、`uninstall-unclassified-store` …）。
// 它们是**用户必须看到的东西**，所以：
//
//   · 有发现 ⇒ 打印里**照着说**，`--json` 里 `ok:false` —— 但**退出码仍是 0**；
//   · 退出码只表达**入口自己**的问题：kind 不认识（2）、**卸载模式不认识（2）**、渲染不出来（9）。
//
//   > 一个"计划里有拒绝就退出非零"的入口，
//   > 与一个"脚本把这份计划整段丢掉"的入口，是同一个东西 ——
//   > 只不过后者再也看不见那些拒绝。
//
// ★ 唯一的例外是**卸载模式不认识**：那时计划**整份不可用**（`planUninstall` 对未知模式
//   什么都不删，见 `uninstall.mjs:82` 的注释："猜 purge 会删掉用户的数据"），
//   所以它既是内容也是**参数错** ⇒ 打出来（让人看见合法值）+ 退出码 2。
//
// ### ③ 本入口**零副作用**
//
// 三份都是**计划**：不删、不导出、不写配置、不建目录。正文最后一行必须**自己说出来**
// ——"这是计划"与"这是已经做了"在输出上不许同形。
// ============================================================================

import { planExport, EXPORT_FORMAT } from './data-export.mjs'
import { planRetention, DEFAULT_RETENTION } from './retention.mjs'
import { planUninstall } from './uninstall.mjs'
import { scanStores, DEFAULT_MAX_ENTRIES } from './store-scan.mjs'

/** 结果码。★ 具名，不靠"字符串里有没有那个词"。 */
export const PLAN_CLI_CODES = Object.freeze({
  /** `--*-plan` 里那个 kind 不认识。 */
  UNKNOWN_KIND: 'PLAN_CLI_UNKNOWN_KIND',
  /** 卸载模式不认识（`planUninstall` 的具名拒绝）——参数错，退出码 2。 */
  MODE_UNKNOWN: 'PLAN_CLI_MODE_UNKNOWN',
  /** 渲染返回的不是一段非空文字。 */
  NOT_TEXT: 'PLAN_CLI_NOT_TEXT',
  /** 渲染过程抛了。 */
  RENDER_FAILED: 'PLAN_CLI_RENDER_FAILED',
})

/**
 * 要扫的根：**布局自己那几个**（非空的才算），一个默认值都不加。
 *
 * @param {object} layout `resolveLayout` 的 layout
 * @returns {ReadonlyArray<{dir: string, note: string}>}
 */
export function layoutRoots(layout = {}) {
  const spec = [
    ['installDir', '安装目录（class=program）'],
    ['dataDir', '数据目录'],
    ['workspaceDir', '工作区'],
    ['cacheDir', '缓存'],
    ['logDir', '日志'],
    ['secretsFile', '密钥库（class=secret）'],
    ['productConfigPath', '产品配置文件（class=config）'],
  ]
  const out = []
  const seen = new Set()
  for (const [key, note] of spec) {
    const v = layout[key]
    if (typeof v !== 'string' || v.trim() === '') continue
    const norm = v.replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(Object.freeze({ dir: v, note }))
  }
  return Object.freeze(out)
}

/** 把清单折成上限内的一段（长了就说还有多少条）。 */
function bullet(lines, items, label, limit = 12) {
  if (items.length === 0) { lines.push(`  ${label}：无`); return }
  lines.push(`  ${label}：${items.length} 条`)
  for (const it of items.slice(0, limit)) lines.push(`    · ${it}`)
  if (items.length > limit) lines.push(`    … 还有 ${items.length - limit} 条（用 --json 看全部）`)
}

/** 发现 → 几行。**每一条都要有人读到**。 */
function findingLines(findings, indent = '  ') {
  return findings.map((f) => `${indent}⚠ ${f.code}${f.path !== undefined ? ` ${f.path}` : ''}：${f.detail}`)
}

/** 扫描面的公共段。 */
function scanLines(scan) {
  const lines = []
  lines.push(`扫描：根 ${scan.roots.length} 个 · 落点 ${scan.stores.length} 条 · 访问条目 ${scan.scanned}`)
  for (const r of scan.roots) lines.push(`  · ${r.dir}${r.note ? `（${r.note}）` : ''}`)
  if (scan.truncated) {
    lines.push('  ★★★ **没扫完**（到上限就停了）：下面的清单**不完整**，别拿它当"全部落点"')
  }
  lines.push(...findingLines(scan.findings))
  lines.push('  ★ 认不出类别的落点在下面各计划里**原样出现**（不在这里猜一个类别）')
  return lines
}

/** 卸载计划的正文。 */
function renderUninstall(plan) {
  const lines = [`卸载计划（mode=${plan.mode ?? '（未给）'}）`]
  bullet(lines, plan.remove.map((x) => `[${x.classId}] ${x.path}`), '会删')
  bullet(lines, plan.keep.map((x) => `[${x.classId}] ${x.path}`), '会留')
  bullet(lines, plan.refuse.map((x) => `[${x.classId ?? '未标注'}] ${x.path}`), '★★ 拒绝（不会被删）')
  const byClass = Object.entries(plan.byClass ?? {}).map(([k, v]) => `${k}=${v}`).join(' · ')
  lines.push(`  按类：${byClass === '' ? '（无）' : byClass}`)
  lines.push(`  密钥库：${plan.secretsKept === true ? '保留（永不随卸载删除）' : '★ 这个模式会动密钥库 —— 请逐字读上面的拒绝清单'}`)
  lines.push(...findingLines(plan.findings))
  return lines
}

/** 导出计划的正文。 */
function renderExport(plan) {
  const lines = [`导出计划（格式 ${plan.format ?? EXPORT_FORMAT}）`]
  bullet(lines, plan.entries.map((x) => `[${x.classId}] ${x.path}${x.format ? ` → ${x.format}` : ''}`), '会进包')
  bullet(lines, plan.excluded.map((x) => `[${x.classId}] ${x.path}（${x.why ?? x.handling}）`), '按台账排除')
  bullet(lines, plan.omitted.map((x) => `[${x.classId ?? '未标注'}] ${x.path}（${x.reason}）`), '★ 落不下（要人决定）')
  const c = plan.counts ?? {}
  lines.push(`  计数：entries=${c.entries ?? plan.entries.length} excluded=${c.excluded ?? plan.excluded.length} omitted=${c.omitted ?? plan.omitted.length}`)
  lines.push('  ★ 可移植格式才算"导出"：`sqlite`/`db`/二进制是**备份**格式，不进"会进包"那一栏')
  lines.push(...findingLines(plan.findings))
  return lines
}

/** 保留计划的正文。 */
function renderRetention(plan) {
  const lines = [`保留计划（策略：模块默认 ${Object.keys(DEFAULT_RETENTION).join('/')}）`]
  bullet(lines, plan.delete.map((x) => `[${x.classId}] ${x.path}（${x.why ?? '过龄/超额'}）`), '★ 会被清')
  bullet(lines, plan.keep.map((x) => `[${x.classId}] ${x.path}（${x.why ?? '在界内'}）`), '会留')
  const usage = plan.usageByClass ?? {}
  const cap = plan.capByClass ?? {}
  const rows = Object.keys(usage).map((k) => `${k}: ${usage[k]} / ${cap[k] ?? '（无上限）'}`)
  lines.push(`  用量 / 上限：${rows.length === 0 ? '（无）' : rows.join(' · ')}`)
  lines.push('  ★ `/ 无上限` 是**显式写着 `null` 的不设上限**，不是"忘了配"（见 `retention.mjs:65`）')
  lines.push(...findingLines(plan.findings))
  return lines
}

/**
 * 认识哪几份计划。
 *
 * ★ 这张表**只有一个所有者**：要加一种就加一行，`--help` 与错误信息都从它派生。
 *   （第一刀加 `--report` 时已经踩过一次"硬编码的旗标清单与实现不一致"。）
 */
export const PLAN_KINDS = Object.freeze([
  Object.freeze({
    kind: 'uninstall',
    flag: '--uninstall-plan=<mode>',
    what: '卸载计划（PRT-908）：按模式算出会删什么、会留什么、**拒绝**什么',
    needsMode: true,
    run: ({ stores, layout, mode }) => planUninstall({ stores, mode, layout }),
    render: renderUninstall,
    /** 这一份计划是不是"整份不可用"（模式不认识 ⇒ 什么都没删）。 */
    // ★ 只看**具名拒绝**，不看 `plan.mode`：`planUninstall` 对未知模式回的是
    //   **调用方给的那个字符串**（`mode: mode ?? null`），不是 `null`——照 `mode` 判会漏。
    unusable: (plan) => (plan.findings ?? []).some((f) => f.code === 'uninstall-mode-unknown'),
  }),
  Object.freeze({
    kind: 'export',
    flag: '--export-plan',
    what: '数据导出计划（PRT-905）：会进包什么、按台账排除什么、哪些**落不下来**',
    needsMode: false,
    run: ({ stores }) => planExport({ stores }),
    render: renderExport,
    unusable: () => false,
  }),
  Object.freeze({
    kind: 'retention',
    flag: '--retention-plan',
    what: '保留计划（PRT-904）：按策略会清什么、每类用量与上限是多少',
    needsMode: false,
    run: ({ stores, nowMs }) => planRetention({
      nowMs,
      entries: stores.map((s) => ({
        id: s.path, classId: s.classId, path: s.path, bytes: s.bytes, atMs: s.atMs,
      })),
    }),
    render: renderRetention,
    unusable: () => false,
  }),
])

/** 认识的那几份计划，按表的顺序。 */
export function planKindIds() {
  return PLAN_KINDS.map((k) => k.kind)
}

/** `--help` 那一行要用的说明（从同一张表派生）。 */
export function planKindDoc() {
  return PLAN_KINDS.map((k) => `${k.kind}（${k.what}）`).join(' / ')
}

/**
 * 打一份计划。
 *
 * ★ **永不抛**（与 `report-cli.mjs` 同一条口径）：把异常折成具名结果码，
 *   否则 `--uninstall-plan` 在坏配置上会变成一段栈回溯，而那时用户正需要看到清单。
 *
 * @param {string} kind
 * @param {object} [args]
 * @param {object} [args.layout] `resolveLayout` 的 layout（根的**唯一**来源）
 * @param {string|null} [args.mode] `--uninstall-plan=<mode>` 的那个模式
 * @param {number} [args.nowMs] 保留计划里的"现在"（用例注入；默认调用时刻）
 * @param {boolean} [args.json]
 * @param {ReadonlyArray<object>} [args.plans] 注入用（用例）
 * @param {Function} [args.scan] 注入用（用例）
 * @returns {{ok: boolean, kind: string, code: string|null, message: string|null,
 *            data: object|null, text: string|undefined}}
 */
export function renderPlan(kind, {
  layout = {}, mode = null, nowMs = Date.now(), json = false,
  plans = PLAN_KINDS, scan = scanStores, maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const spec = plans.find((k) => k.kind === kind)
  if (spec === undefined) {
    return {
      ok: false,
      kind: String(kind),
      code: PLAN_CLI_CODES.UNKNOWN_KIND,
      message: `不认识的计划 ${JSON.stringify(kind)}（可选项：${plans.map((k) => k.kind).join(' / ')}）`
        + '——不回落成第一份：那会让人拿着别的计划去核对删什么',
      data: null,
      text: undefined,
    }
  }

  let built = null
  let scanned = null
  let text = null
  try {
    scanned = scan({ roots: layoutRoots(layout), layout, maxEntries })
    const plan = spec.run({ stores: scanned.stores, layout, mode, nowMs })
    const rendered = spec.render(plan)
    // ★ 空白判在这里，而不是判整个正文：正文的外框（标题/扫描段/收尾那两句）**永远是满的**，
    //   拿它判，这条守卫就永远不会红 —— 一个恒绿的守卫与没有守卫是同一个东西。
    if (!Array.isArray(rendered) || rendered.join('').trim() === '') {
      return {
        ok: false, kind: spec.kind, code: PLAN_CLI_CODES.NOT_TEXT,
        message: `「${spec.kind}」这份计划自己没有说出任何内容 —— `
          + '一份空白的计划与一份"没什么要删的"计划必须分开',
        data: null, text: undefined,
      }
    }
    const body = [
      `── ${spec.what} ──────────────────────────────`,
      ...scanLines(scanned),
      ...rendered,
      '',
      '★ 这是一份**计划**：本入口零副作用 —— 没有删除、没有写出任何文件、没有改配置。',
      `★ "现在"取的是调用时刻：${new Date(nowMs).toISOString()}（保留计划按它算"多久以前"）。`,
    ]
    text = body.join('\n')
    built = { plan, scanned }
  } catch (err) {
    return {
      ok: false,
      kind: spec.kind,
      code: PLAN_CLI_CODES.RENDER_FAILED,
      message: `算这份计划时抛了（${String(err?.message ?? err)}）——`
        + '具名拒绝而不是栈回溯：那时用户正需要看到清单',
      data: null,
      text: undefined,
    }
  }

  if (typeof text !== 'string' || text.trim() === '') {
    return {
      ok: false, kind: spec.kind, code: PLAN_CLI_CODES.NOT_TEXT,
      message: '渲染出空白 —— 一份空白计划与一份"没什么要删的"计划必须分开',
      data: null, text: undefined,
    }
  }

  const unusable = spec.unusable(built.plan) === true
  const data = {
    kind: spec.kind,
    mode: spec.needsMode ? (mode ?? null) : null,
    nowMs,
    ok: built.plan.ok ?? ((built.plan.findings ?? []).length === 0),
    roots: built.scanned.roots,
    scanned: built.scanned.scanned,
    stores: built.scanned.stores.length,
    truncated: built.scanned.truncated,
    scanFindings: built.scanned.findings,
    plan: built.plan,
  }

  // `--json` 打结构化那份；默认打给人读的那份。★ 两者来自**同一次**计算。
  const asJson = JSON.stringify(data, null, 2)
  return {
    ok: unusable !== true,
    kind: spec.kind,
    code: unusable === true ? PLAN_CLI_CODES.MODE_UNKNOWN : null,
    message: unusable === true
      ? '卸载模式不认识 —— 计划整份不可用（`planUninstall` 对未知模式什么都不删，不猜）'
      : null,
    data,
    text: json ? asJson : text,
  }
}
