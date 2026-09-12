// product/release/checklist.mjs
// ============================================================================
// PRT-909：产品发布检查清单。
//
// spec §10 line 992；完成标准在 line 995：
//   「商业 Alpha 安装、使用、升级、恢复、诊断和卸载流程均有**可重复验收证据**。」
//
// ## 与 PRT-614 的关系
//
// PRT-614 建的是**执行路径**的就绪门禁（组合补丁层、沙箱级别、legacy 高风险……）。
// PRT-909 建的是**产品生命周期**的发布清单（上面那六条流程）。
// 两者的纪律是同一条，来自 PRT-614：
//
//   > 门禁**先于数字**检查。
//
// 在 PRT-614 那里它是"未批准的写操作数为 0"不能替代"门禁已满足"；
// 在这里它是"清单上每一项都打了勾"不能替代"每一项都有**这一次**的证据"。
//
// ## ★ 三个会安静出错的坑
//
// ### ① 证据缺失被当成通过
//
// 一份清单最容易写成的样子是一列布尔：要么真要么假。而"我们**从来没有跑过**
// 这条流程"与"我们跑过、它通过了"在那一列里是**同一个值**。
//
//   > 一个「证据缺失时默认算过」的发布清单，
//   > 与一个「所有项都过」的清单，在报表上是同一个东西。
//
// 所以判定是**四值**的：`pass` / `fail` / `no-evidence` / `stale`。
// 缺失与过期都**阻止发布**，且各自留下可读的理由。
//
// ### ② 过期的证据
//
// "可重复验收证据"（line 995）里的"可重复"是关键词。三个月前那次发布会话里
// 递过来的一份 JSON，与这次发布什么都没跑，在"这次发布验证了什么"上完全等价。
//
//   > 一个「三个月前那次发布会话里递过来的证据」的清单，
//   > 与一个「这次发布什么都没跑」的清单，是同一个东西——
//   > 只不过前者有一个看起来有效的时间戳。
//
// ### ③ 每一项都指向一个不存在的证据来源
//
// 清单上写"检查 SBOM 是否覆盖全部第三方组件"，而生成 SBOM 的那个模块
// 已经被删了/改名了——这一项于是**永远拿不到证据**，而它读起来还是一条检查。
//
//   > 一个「指向一份不存在的东西」的检查项，
//   > 与一个「永远不会被跑」的检查项，是同一个东西——
//   > 只不过前者在清单上看起来是被覆盖的。
//
// 所以每一项都带 `evidenceFrom`（一份真实路径），装载期会去**核对它存在**。
// ============================================================================

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

/** 清单版本。 */
export const CHECKLIST_VERSION = 'legion/release-checklist@1'

/**
 * 六条流程。**直接来自 spec line 995 的措辞**：
 * 「安装、使用、升级、恢复、诊断和卸载」。
 */
export const ALPHA_FLOWS = Object.freeze([
  Object.freeze({ id: 'install', label: '安装' }),
  Object.freeze({ id: 'use', label: '使用' }),
  Object.freeze({ id: 'upgrade', label: '升级' }),
  Object.freeze({ id: 'restore', label: '恢复' }),
  Object.freeze({ id: 'diagnose', label: '诊断' }),
  Object.freeze({ id: 'uninstall', label: '卸载' }),
])

export const ALPHA_FLOW_IDS = Object.freeze(ALPHA_FLOWS.map((f) => f.id))

/**
 * 判定是**四值**的。
 *
 * ★ `no-evidence` 与 `stale` 都**阻止发布**。把它们折叠成"通过"是本模块
 *   存在的全部理由；折叠成"失败"则会让人以为"跑一遍就好了"，而真相是
 *   "上一次的证据不能算数"。
 */
export const EVIDENCE_VERDICTS = Object.freeze(['pass', 'fail', 'no-evidence', 'stale'])

/** 哪些判定算"通过"。只有 `pass`。 */
export const PASSING_VERDICTS = Object.freeze(['pass'])

export const CHECKLIST_CODES = Object.freeze({
  /** 某一项没有证据（从没跑过）。 */
  ITEM_NO_EVIDENCE: 'release-checklist-item-no-evidence',
  /** 某一项的证据过期（跑过，但不是这一次）。 */
  ITEM_STALE: 'release-checklist-item-stale',
  /** 某一项明确失败。 */
  ITEM_FAILED: 'release-checklist-item-failed',
  /** 某个流程一条检查项都没有——空集合会让"这个流程已验证"变成一句空话。 */
  FLOW_UNCOVERED: 'release-checklist-flow-uncovered',
  /** 检查项指向的证据来源不存在。 */
  EVIDENCE_SOURCE_MISSING: 'release-checklist-evidence-source-missing',
  /** 检查项没有说明"为什么需要它"。 */
  ITEM_UNJUSTIFIED: 'release-checklist-item-unjustified',
  /** 证据的判定值不在四值之内。 */
  VERDICT_UNKNOWN: 'release-checklist-verdict-unknown',
  /** 证据没有时间戳——没有时间戳的证据无法判断它是哪一次的。 */
  EVIDENCE_UNDATED: 'release-checklist-evidence-undated',
})

/** 证据的有效期：**一次发布周期**。超过就必须重跑，而不是"参考一下"。 */
export const DEFAULT_MAX_EVIDENCE_AGE_MS = 14 * 24 * 60 * 60 * 1000

/**
 * 检查项。
 *
 * 每一项必须：
 *   · 属于**一条**流程（`flow`）；
 *   · 说得出**为什么**（`why`）——*一条说不出理由的检查，下一个人会以为它多余而删掉*；
 *   · 指向一份**真实存在**的证据来源（`evidenceFrom`），装载期会核对。
 */
export const CHECKLIST_ITEMS = Object.freeze([
  Object.freeze({
    id: 'install-privacy-notice',
    flow: 'install',
    label: '安装后隐私与模型调用说明对用户可见',
    evidenceFrom: 'product/release/privacy.mjs',
    why: '说明在安装时不可见，等于用户是在不知道数据去哪里的情况下开始用的',
  }),
  Object.freeze({
    id: 'install-secrets-separate',
    flow: 'install',
    label: '凭据库落在数据目录之外',
    evidenceFrom: 'product/lifecycle/uninstall.mjs',
    why: '凭据与业务数据混在一个目录时，"保留数据"会静默地连凭据一起保留',
  }),
  Object.freeze({
    id: 'use-execution-gate',
    flow: 'use',
    label: '执行路径就绪门禁满足',
    evidenceFrom: 'runtime/dsh-composition/release-gate.mjs',
    why: 'PRT-614：补丁层未生效时强制面不在，而配置看起来完全正常',
  }),
  Object.freeze({
    id: 'use-sbom-complete',
    flow: 'use',
    label: '第三方组件清单覆盖全部来源',
    evidenceFrom: 'product/compliance/inventory.mjs',
    why: 'PRT-901：只覆盖"恰好带清单的那些"第三方代码，会让 SBOM 看起来是完整的',
  }),
  Object.freeze({
    id: 'upgrade-preflight',
    flow: 'upgrade',
    label: '升级前兼容性 / 磁盘 / 在途任务检查',
    evidenceFrom: 'product/upgrade/preflight.mjs',
    why: '没有预检的升级在磁盘满或在途任务时会把一个可用安装变成不可用安装',
  }),
  Object.freeze({
    id: 'upgrade-atomic-switch',
    flow: 'upgrade',
    label: '原子程序切换与升级后健康检查',
    evidenceFrom: 'product/upgrade/switchover.mjs',
    why: '非原子的切换在断电/崩溃时留下一个既不是旧版也不是新版的目录',
  }),
  Object.freeze({
    id: 'restore-backup-entry',
    flow: 'restore',
    label: '备份与恢复入口可用',
    evidenceFrom: 'product/upgrade/backup.mjs',
    why: 'line 995 把"恢复"与"安装"并列——一个不能恢复的安装不是可发布的安装',
  }),
  Object.freeze({
    id: 'restore-retention-bounded',
    flow: 'restore',
    label: '保留策略对每类数据都有界',
    evidenceFrom: 'product/lifecycle/retention.mjs',
    why: 'PRT-904：只对一个类做容量核算却当成总用量，会让另外两类没有上限',
  }),
  Object.freeze({
    id: 'diagnose-redaction',
    flow: 'diagnose',
    label: '诊断包默认脱敏且由用户主动生成',
    evidenceFrom: 'product/diagnostics/redact-package.mjs',
    why: 'spec line 747；一个不脱敏的诊断包会把密钥带到支持工单里',
  }),
  Object.freeze({
    id: 'diagnose-crash-consent',
    flow: 'diagnose',
    label: '崩溃报告有事先授权与撤销后的待处理清单',
    evidenceFrom: 'product/diagnostics/crash-report.mjs',
    why: 'PRT-906：崩溃时没人在场可以问，所以同意必须事先取得',
  }),
  Object.freeze({
    id: 'uninstall-plan',
    flow: 'uninstall',
    label: '卸载给出数据去留选择并产出计划',
    evidenceFrom: 'product/lifecycle/uninstall.mjs',
    why: 'spec line 749；"保留数据"与"彻底删除"必须是两个真的不同的结果',
  }),
  Object.freeze({
    id: 'uninstall-audit-trail',
    flow: 'uninstall',
    label: '卸载与升级动作留有审计记录',
    evidenceFrom: 'product/upgrade/audit.mjs',
    why: '没有审计的卸载，事后无法回答"那些数据是被删了还是从来没写进去过"',
  }),
])

export const CHECKLIST_ITEM_IDS = Object.freeze(CHECKLIST_ITEMS.map((i) => i.id))

/**
 * 判定一个证据条目。
 *
 * @param {object} item 检查项
 * @param {object|undefined} evidence 该项的证据
 * @param {{nowMs: number, maxAgeMs: number}} clock
 * @returns {{verdict: string, reason: string, code: string|null}}
 */
function judge(item, evidence, clock) {
  if (evidence === undefined || evidence === null) {
    return {
      verdict: 'no-evidence',
      code: CHECKLIST_CODES.ITEM_NO_EVIDENCE,
      reason: `${item.label}：这次发布没有任何证据（不是"通过"，是"没跑过"）`,
    }
  }
  // 没有时间戳的证据无法判断它是哪一次的——按无证据处理，**不按通过**。
  if (!Number.isFinite(evidence.atMs)) {
    return {
      verdict: 'no-evidence',
      code: CHECKLIST_CODES.EVIDENCE_UNDATED,
      reason: `${item.label}：证据没有时间戳，无法判断是哪一次跑的——按"没跑过"处理`,
    }
  }
  if (!EVIDENCE_VERDICTS.includes(evidence.verdict)) {
    return {
      verdict: 'no-evidence',
      code: CHECKLIST_CODES.VERDICT_UNKNOWN,
      reason: `${item.label}：证据的判定值 ${JSON.stringify(evidence.verdict)} 不在 ${EVIDENCE_VERDICTS.join(' / ')} 之内——按"没跑过"处理`,
    }
  }
  const age = clock.nowMs - evidence.atMs
  if (age > clock.maxAgeMs) {
    return {
      verdict: 'stale',
      code: CHECKLIST_CODES.ITEM_STALE,
      reason: `${item.label}：证据是 ${Math.round(age / 86400000)} 天前的，超过 ${Math.round(clock.maxAgeMs / 86400000)} 天有效期——"可重复验收证据"要的是这一次的`,
    }
  }
  if (evidence.verdict === 'fail') {
    return {
      verdict: 'fail',
      code: CHECKLIST_CODES.ITEM_FAILED,
      reason: `${item.label}：${evidence.detail ?? '证据本身判定为失败'}`,
    }
  }
  if (evidence.verdict !== 'pass') {
    // 证据自己就是 no-evidence / stale —— 原样传递，不升级成 pass。
    return {
      verdict: evidence.verdict,
      code: evidence.verdict === 'stale' ? CHECKLIST_CODES.ITEM_STALE : CHECKLIST_CODES.ITEM_NO_EVIDENCE,
      reason: `${item.label}：证据自称 ${evidence.verdict}`,
    }
  }
  return { verdict: 'pass', code: null, reason: `${item.label}：通过` }
}

/**
 * 评估清单。
 *
 * @param {object} [deps]
 * @param {Record<string, {verdict: string, atMs: number, detail?: string}>} [deps.evidence] 按检查项 id 给证据
 * @param {ReadonlyArray<object>} [deps.items] 检查项（默认用本模块自己的，**可注入**）
 * @param {number} [deps.nowMs]
 * @param {number} [deps.maxAgeMs]
 * @param {(p: string) => boolean} [deps.sourceExists] 核对证据来源是否存在（可注入）
 * @returns {object}
 */
export function evaluateChecklist(deps = {}) {
  const items = deps.items ?? CHECKLIST_ITEMS
  const evidence = deps.evidence ?? {}
  const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now()
  const maxAgeMs = Number.isFinite(deps.maxAgeMs) ? deps.maxAgeMs : DEFAULT_MAX_EVIDENCE_AGE_MS
  const sourceExists = deps.sourceExists ?? ((p) => existsSync(join(REPO, p)))
  const clock = { nowMs, maxAgeMs }

  const findings = []
  const results = []

  for (const item of items) {
    // ★ 检查项自己得先站得住：说得出理由、指向一份真实存在的证据来源。
    if (typeof item.why !== 'string' || item.why === '') {
      findings.push(Object.freeze({
        code: CHECKLIST_CODES.ITEM_UNJUSTIFIED,
        item: item.id,
        detail: `检查项 ${item.id} 没有说明为什么需要它——一条说不出理由的检查，下一个人会以为它多余而删掉`,
      }))
    }
    if (typeof item.evidenceFrom !== 'string' || item.evidenceFrom === '' || !sourceExists(item.evidenceFrom)) {
      findings.push(Object.freeze({
        code: CHECKLIST_CODES.EVIDENCE_SOURCE_MISSING,
        item: item.id,
        source: item.evidenceFrom ?? null,
        detail: `检查项 ${item.id} 指向的证据来源 ${JSON.stringify(item.evidenceFrom ?? null)} 不存在——` +
          '这一项于是永远拿不到证据，而它读起来还是一条检查',
      }))
    }
    const j = judge(item, evidence[item.id], clock)
    results.push(Object.freeze({
      id: item.id, flow: item.flow, label: item.label,
      evidenceFrom: item.evidenceFrom,
      verdict: j.verdict, reason: j.reason, code: j.code,
      evidenceAtMs: evidence[item.id]?.atMs ?? null,
    }))
    if (j.code !== null) findings.push(Object.freeze({ code: j.code, item: item.id, detail: j.reason }))
  }

  // 每条流程都要有检查项——空集合会让"这个流程已验证"变成一句空话。
  const byFlow = {}
  for (const flow of ALPHA_FLOW_IDS) {
    byFlow[flow] = results.filter((r) => r.flow === flow)
    if (byFlow[flow].length === 0) {
      findings.push(Object.freeze({
        code: CHECKLIST_CODES.FLOW_UNCOVERED,
        flow,
        detail: `流程 ${flow} 一条检查项都没有——空集合会让"这条流程已验证"变成一句空话`,
      }))
    }
  }

  const counts = Object.fromEntries(EVIDENCE_VERDICTS.map((v) => [v, results.filter((r) => r.verdict === v).length]))
  // ★ 只有全部 `pass` 才算就绪。`no-evidence` 与 `stale` **都**阻止发布。
  const notReady = results.filter((r) => !PASSING_VERDICTS.includes(r.verdict))

  return Object.freeze({
    version: CHECKLIST_VERSION,
    evaluatedAtMs: nowMs,
    maxAgeMs,
    items: Object.freeze(results),
    byFlow: Object.freeze(Object.fromEntries(ALPHA_FLOW_IDS.map((f) => [f, Object.freeze(byFlow[f])]))),
    counts: Object.freeze(counts),
    flowsCovered: Object.freeze(ALPHA_FLOW_IDS.filter((f) => byFlow[f].length > 0)),
    notReady: Object.freeze(notReady.map((r) => Object.freeze({ id: r.id, flow: r.flow, verdict: r.verdict }))),
    findings: Object.freeze(findings),
    // ★ 就绪 = 每一项都 `pass`。没有任何一条"缺失算过"的缝。
    ready: notReady.length === 0,
  })
}

/**
 * 渲染成人看的发布清单。
 */
export function renderChecklist(report = evaluateChecklist()) {
  const lines = []
  lines.push(`商业 Alpha 发布检查清单　${report.version}`)
  lines.push(`评估时间：${new Date(report.evaluatedAtMs).toISOString()}　证据有效期：${Math.round(report.maxAgeMs / 86400000)} 天`)
  lines.push('')
  const mark = { pass: '✔', fail: '✖', 'no-evidence': '－', stale: '⏳' }
  for (const flow of ALPHA_FLOWS) {
    const items = report.byFlow[flow.id] ?? []
    lines.push(`【${flow.label}】`)
    for (const it of items) lines.push(`  ${mark[it.verdict] ?? '?'} ${it.label}　(${it.verdict})`)
    if (items.length === 0) lines.push('  ⚠️ 这条流程没有任何检查项')
    lines.push('')
  }
  lines.push(`判定合计：pass ${report.counts.pass ?? 0} / fail ${report.counts.fail ?? 0} / ` +
    `no-evidence ${report.counts['no-evidence'] ?? 0} / stale ${report.counts.stale ?? 0}`)
  lines.push('')
  if (report.ready) {
    lines.push('✔ 可以发布：每一项都有本次发布的通过证据。')
  } else {
    lines.push(`✖ 不可发布：${report.notReady.length} 项没有本次发布的通过证据。`)
    // ★ 这一段必须分开写。"没跑过"与"跑了没过"是两种不同的下一步。
    const noEv = report.items.filter((r) => r.verdict === 'no-evidence')
    const stale = report.items.filter((r) => r.verdict === 'stale')
    const failed = report.items.filter((r) => r.verdict === 'fail')
    if (noEv.length) {
      lines.push('')
      lines.push(`  · 从没跑过（${noEv.length} 项）——下一步是**去跑**，不是去改：`)
      for (const r of noEv) lines.push(`      ${r.label}`)
    }
    if (stale.length) {
      lines.push('')
      lines.push(`  · 证据过期（${stale.length} 项）——下一步是**重跑**，不是去改：`)
      for (const r of stale) lines.push(`      ${r.label}`)
    }
    if (failed.length) {
      lines.push('')
      lines.push(`  · 跑了没过（${failed.length} 项）——下一步是去修：`)
      for (const r of failed) lines.push(`      ${r.label}　${r.reason}`)
    }
  }
  if (report.findings.length > 0) {
    lines.push('')
    lines.push('清单自身的问题：')
    for (const f of report.findings) lines.push(`  [${f.code}] ${f.detail}`)
  }
  return lines.join('\n')
}

/**
 * 装载期自检：把三条核心判据各真的跑一遍，留下算出来的值。
 */
function auditChecklist() {
  const problems = []
  const NOW = 1_700_000_000_000
  const mkItems = (patch = {}) => [{
    id: 'probe', flow: 'install', label: '探针项',
    evidenceFrom: 'product/release/privacy.mjs', why: '因为要探',
    ...patch,
  }]
  const exists = () => true

  // ① ★ 证据缺失 → no-evidence → 不就绪（**不是通过**）
  const missing = evaluateChecklist({ nowMs: NOW, items: mkItems(), evidence: {}, sourceExists: exists })
  if (missing.ready) problems.push('没有证据却报就绪——那缺失就被当成通过了')
  if (missing.counts['no-evidence'] !== 1) problems.push('缺失没有被记成 no-evidence')

  // ② ★ 过期证据 → stale → 同样不就绪
  const stale = evaluateChecklist({
    nowMs: NOW, items: mkItems(), sourceExists: exists,
    evidence: { probe: { verdict: 'pass', atMs: NOW - 30 * 86400000 } },
  })
  if (stale.ready) problems.push('过期证据却报就绪')
  if (stale.counts.stale !== 1) problems.push('过期没有被记成 stale')

  // ③ 本次的通过证据 → 就绪（否则这套判定是不可满足的）
  const fresh = evaluateChecklist({
    nowMs: NOW, items: mkItems(), sourceExists: exists,
    evidence: { probe: { verdict: 'pass', atMs: NOW - 86400000 } },
  })
  if (!fresh.ready) problems.push(`本次证据齐全却报不就绪：${JSON.stringify(fresh.findings.map((f) => f.code))}`)

  // ④ 没有时间戳的证据按"没跑过"处理，**不按通过**
  const undated = evaluateChecklist({
    nowMs: NOW, items: mkItems(), sourceExists: exists,
    evidence: { probe: { verdict: 'pass' } },
  })
  if (undated.ready) problems.push('没有时间戳的证据被当成了通过')
  if (!undated.findings.some((f) => f.code === CHECKLIST_CODES.EVIDENCE_UNDATED)) {
    problems.push('没有时间戳的证据没有被报出来')
  }

  // ⑤ ★ 指向不存在的证据来源必须被抓住（否则这一项永远拿不到证据而看起来被覆盖）
  const ghost = evaluateChecklist({ nowMs: NOW, items: mkItems(), evidence: {}, sourceExists: () => false })
  if (!ghost.findings.some((f) => f.code === CHECKLIST_CODES.EVIDENCE_SOURCE_MISSING)) {
    problems.push('指向不存在来源的检查项没有被抓住')
  }

  // ⑥ 空流程必须被抓住
  const empty = evaluateChecklist({ nowMs: NOW, items: [], evidence: {}, sourceExists: exists })
  if (empty.findings.filter((f) => f.code === CHECKLIST_CODES.FLOW_UNCOVERED).length !== ALPHA_FLOW_IDS.length) {
    problems.push('空流程没有被逐条报出来')
  }

  // ⑦ ★ 真实清单的每一条都必须指向一份**真实存在**的文件。
  //   这是本模块唯一能挡住"证据来源被删/改名而检查项还在"的判据。
  const real = evaluateChecklist({ nowMs: NOW, evidence: {} })
  const ghostItems = real.findings.filter((f) => f.code === CHECKLIST_CODES.EVIDENCE_SOURCE_MISSING)
  if (ghostItems.length > 0) {
    problems.push(`真实清单里有 ${ghostItems.length} 项指向不存在的来源：${ghostItems.map((f) => f.source).join(', ')}`)
  }
  // 每条流程都必须被真实清单覆盖
  if (real.flowsCovered.length !== ALPHA_FLOW_IDS.length) {
    problems.push(`真实清单只覆盖了 ${real.flowsCovered.length}/${ALPHA_FLOW_IDS.length} 条流程`)
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    version: CHECKLIST_VERSION,
    flows: ALPHA_FLOW_IDS,
    verdicts: EVIDENCE_VERDICTS,
    itemCount: CHECKLIST_ITEMS.length,
    samples: Object.freeze({
      missingReady: missing.ready,
      missingVerdicts: missing.items.map((i) => i.verdict),
      staleReady: stale.ready,
      freshReady: fresh.ready,
      undatedCaught: undated.findings.map((f) => f.code),
      ghostCaught: ghost.findings.map((f) => f.code),
      realItemCount: real.items.length,
      realFlowsCovered: real.flowsCovered,
      // ★ 当前仓库的真实读数：没有给任何证据，所以一定是"不就绪"。
      realReadyWithoutEvidence: real.ready,
    }),
  })
}

export const CHECKLIST_CHECKED = auditChecklist()
