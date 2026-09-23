// product/report-cli.mjs
// ============================================================================
// 第 16 条（业主 2026-09-23 裁决：**做**）：阶段 9 产品动作的 **CLI 面** —— 第一刀
//
// ## 那条裁决问的是什么
//
// 它问的不是"要不要写这些模块"（模块与用例早就齐备），而是
// **"这些产品级动作由谁触发"**：`legion` 的子命令？一个独立的发布/运维 CLI？
// 还是只作为发布流程里人工跑的一次性脚本？
//
// 本仓**已经有**这个问题的一份答案，而且不止一处：
//
//   · `--log-policy`（PRT-709）—— 打印当前生效的日志策略；
//   · `--runtime-install-plan`（PRT-257）—— 打印安装计划，**零副作用**；
//   · `--diagnostics=<dir>`（PRT-710）—— 在产品**坏掉**时也能用。
//
// ⇒ 三处都是"**`legion` 的子命令/旗标**"，所以这一刀沿用它，
//   而不是新造一个 `legion-release` 之类的第二个入口。
//
// ## 为什么第一刀只切三份**只读报告**
//
// 第 16 条下面挂着 **11 个** `[gap]` 模块（见接管队列 §5.1）。它们不是同一类：
//
//   · `checklist` / `privacy` / `runbook` —— 自带**无参** `render*()`，纯读数；
//   · `data-export` / `retention` / `uninstall` —— 要目录、要模式，**碰数据**；
//   · `metrics-*` / `crash-report` —— 要库连接、要同意记录。
//
// 先切第一类，理由是**可逆性**：一个只打印的报告，最坏的结果是"打出来没人看"；
// 而一个"计划对了但手一抖执行了"的卸载入口，最坏的结果是用户的数据没了。
// 后两类各自需要自己的那一次裁决（输入从哪来、要不要真的动手），
// **不在这一刀里顺手做掉**。
//
// ## 三条纪律
//
// ① **只读。** 这个文件里**没有**任何写文件、起进程、改配置的分支——
//    它可以被打印一百遍而产品状态不变。
// ② **不发明默认值**（PRT-253 §3）。三份报告的入参**都是模块自己的默认**
//    （`renderChecklist()` / `renderPrivacyNotice()` / `renderRunbook()`），
//    这一层一个默认值都不加。★ 特别是 `runbook` 的 `knownFlags`：
//    这里**不替它**把 CLI 的旗标表传进去（那会形成 `cli.mjs` ↔ 本文件的循环），
//    用的是模块自己的默认；那条更强的检查由 `support-runbook` 那套用例跑。
// ③ **不认识的 kind 是具名拒绝**，不是"回落到第一项"。
//
//   > 一个"参数写错了就打印第一份报告"的入口，
//   > 与一个"参数写错了就打印你想要的报告"的入口，在用户眼里是同一个东西——
//   > 只不过他会拿着**别的**那份报告去核对发布条件。
// ============================================================================

import { evaluateChecklist, renderChecklist } from './release/checklist.mjs'
import { privacyReport, renderPrivacyNotice } from './release/privacy.mjs'
import { checkRunbook, renderRunbook } from './support/runbook.mjs'

/** 结果码。★ 具名，不靠"字符串里有没有那个词"。 */
export const REPORT_CLI_CODES = Object.freeze({
  /** `--report=` 里那个 kind 不认识。 */
  UNKNOWN_KIND: 'REPORT_CLI_UNKNOWN_KIND',
  /** 渲染返回的不是一段非空文字。 */
  NOT_TEXT: 'REPORT_CLI_NOT_TEXT',
  /** 渲染过程抛了。 */
  RENDER_FAILED: 'REPORT_CLI_RENDER_FAILED',
})

/**
 * 认识哪几份报告。
 *
 * ★ 这张表**只有一个所有者**：要加一种就加一行，`--help` 与错误信息都从它派生
 *   （硬编码的"支持 checklist/privacy/runbook"已经有过一次与实现不一致的历史）。
 *
 * ★ `data` 与 `render` 分开：`--json` 打的是**结构化那份**（供脚本与验收），
 *   而默认打的是给人读的那份。两者来自**同一次**判定的输入形状，
 *   但这一层不保证"文字里出现的数字一定等于 json 里那个"——那是各模块自己的套件管的事。
 */
export const REPORT_KINDS = Object.freeze([
  Object.freeze({
    kind: 'checklist',
    what: '商业 Alpha 的六条发布流程检查清单（PRT-909）',
    render: () => renderChecklist(),
    data: () => evaluateChecklist(),
  }),
  Object.freeze({
    kind: 'privacy',
    what: '隐私说明与**外发面**清单（PRT-903/906）',
    render: () => renderPrivacyNotice(),
    data: () => privacyReport(),
  }),
  Object.freeze({
    kind: 'runbook',
    what: '支持手册：可观测症状、死胡同、坏掉时的可用性（PRT-907）',
    render: () => renderRunbook(),
    data: () => checkRunbook(),
  }),
])

/** 认识的那几个 kind，按表的顺序。 */
export function reportKindIds() {
  return REPORT_KINDS.map((k) => k.kind)
}

/**
 * 渲染一份报告。**不抛**：所有失败都以 `{ok:false, code}` 回来。
 *
 * ★ `kinds` 可注入 —— 与 `boundary-facts.mjs` 把目标读取注入进来是同一条理由：
 *   不注入的话，"渲染返回空串要报 NOT_TEXT"与"渲染抛了要报 RENDER_FAILED"
 *   这两条守卫**永远没有输入能触发它们**，于是它们是不是真的在守，没人知道。
 *
 * @param {string} kind
 * @param {{json?: boolean, kinds?: ReadonlyArray<object>}} [opts]
 * @returns {{ok: boolean, kind?: string, code?: string, message?: string, text?: string, data?: object}}
 */
export function renderReport(kind, { json = false, kinds = REPORT_KINDS } = {}) {
  const entry = kinds.find((k) => k.kind === kind)
  if (entry === undefined) {
    return {
      ok: false,
      code: REPORT_CLI_CODES.UNKNOWN_KIND,
      message: `没有这种报告「${String(kind)}」：可选的只有 ${kinds.map((k) => k.kind).join(' / ')}`,
    }
  }
  let data
  try {
    data = entry.data()
  } catch (e) {
    return {
      ok: false,
      kind: entry.kind,
      code: REPORT_CLI_CODES.RENDER_FAILED,
      message: `「${entry.kind}」判定失败：${e?.message ?? String(e)}`,
    }
  }
  if (json === true) {
    return { ok: true, kind: entry.kind, data, text: JSON.stringify(data, null, 2) }
  }
  let text
  try {
    text = entry.render()
  } catch (e) {
    return {
      ok: false,
      kind: entry.kind,
      code: REPORT_CLI_CODES.RENDER_FAILED,
      message: `「${entry.kind}」渲染失败：${e?.message ?? String(e)}`,
    }
  }
  if (typeof text !== 'string' || text.trim() === '') {
    return {
      ok: false,
      kind: entry.kind,
      code: REPORT_CLI_CODES.NOT_TEXT,
      message: `「${entry.kind}」渲染出来的不是一段非空文字`,
    }
  }
  return { ok: true, kind: entry.kind, data, text }
}
