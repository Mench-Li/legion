// runtime/dsh-composition/repair.mjs
// ============================================================================
// PRT-257 的「修复入口」后半：**让修复计划真的被行使**
//
// `repairPlanFor()`（`bootstrap.mjs`）把自检的失败项翻成
// `{check, action, label, why, reasons}` —— 一份**计划**。而在本模块之前，
// 那份计划的全部消费者是"打印给人看"：没有任何代码执行过其中任何一个动作。
//
//   > 一个功能没有入口，与这个功能不存在，对用户来说是同一件事。
//
// 更具体地说：一个**只有计划没有执行**的修复入口，与一个"请重装产品"的提示
// 没有区别——用户拿到的是同一件事（一句他早就知道的话）。
//
// ---------------------------------------------------------------------------
// ## 一、哪些动作**不许**被自动执行
//
// 这是本模块最重要的判断，而且它是一条**反直觉**的判断：
//
// `reapply-composition-patch` 是唯一一个"我们明明有能力自动做"的动作
// （`render.mjs` 能生成 `legion-host.patch.yml`），却**必须**要求显式批准。
// 理由是 `index.mjs` 顶部那段说明：DSH 的用户 profile 是
// `patchReload: 'live'`——**组合改动热生效，不需要重启**。于是往运行中的
// profile 写入这一层会**立刻改变正在跑的 harness 的强制面**，
// 包括发起这次修复的那个进程自己。
//
// 把它做成"自检没过就自动重写"的顺手行为，等于给一次误调用准备了
// 「把当前进程的沙箱降级」的能力。所以：
//
//   · 本模块**不含**任何写 profile 的代码（applier 一律注入）；
//   · `reapply-composition-patch` 只有出现在 `approved` 里才会被执行；
//   · 没批准时它不是"跳过"，而是一条**具名的待办**（`needs-approval`）。
//
// ---------------------------------------------------------------------------
// ## 二、判据是**重新自检**，不是 applier 的返回值
//
// 执行完动作之后，本模块**重新跑一次自检**，并从**新结论**里读出每一项的判决。
// applier 说自己成功了，只被记进 `applierSaid`（诊断用），**从不作为判据**。
//
// 这条纪律在本仓库里出现过很多次（"命令返回 0 不等于加固完成"、
// "注册成功不等于端口可用"），但它在**修复**这个场景上格外要紧：
//
//   修复是唯一一种"做错了反而更糟"的操作——一个把自检结果从"没过"
//   改成"不报了"的实现，会让用户以为问题解决了，而强制面依然不在。
//   一个**静默地什么都没修**的修复入口，比没有修复入口坏得多。
//
// 因此还多一条：新结论里**找不到**对应的检查项时，判决是 `unverified`，
// **不是** `fixed`——"查不出来"与"查出来是好的"绝不同形。
// ============================================================================

import { REPAIR_ACTIONS } from './bootstrap.mjs'

/** 本模块的具名码。 */
export const REPAIR_CODES = Object.freeze({
  /** 计划形状不对：没有 items 数组。 */
  BAD_PLAN: 'REPAIR_BAD_PLAN',
  /** 复核本身失败（抛出或形状不对）。**不是**"全部修好"。 */
  RECHECK_FAILED: 'REPAIR_RECHECK_FAILED',
  /** 还有未解决的项。**具体**判决在 `outcomes` 里，这里只表示"没收尾"。 */
  STILL_OUTSTANDING: 'REPAIR_STILL_OUTSTANDING',
  /** recheck 不是函数：没有复核手段时"修好了没有"无从判定。 */
  BAD_RECHECK: 'REPAIR_BAD_RECHECK',
  /** 声明为可执行、但调用方没有提供 applier——接线缺一截。 */
  NO_APPLIER: 'REPAIR_NO_APPLIER',
})

/**
 * 每一项判决。**这张表是总的**：没有第五条。
 *
 *   · `fixed`           — 复核确认这一项现在过了
 *   · `still-failing`   — 动作跑了（或没必要跑），复核说这一项还是没过
 *   · `unverified`      — **没法判定**（复核失败、新结论里根本没有这一项）
 *   · `needs-approval`  — 有动作可执行，但**没有**被显式批准
 *   · `manual`          — 没有可自动执行的动作，只能人工处理
 *   · `applier-threw`   — 动作自己抛了
 */
export const REPAIR_VERDICTS = Object.freeze([
  'fixed', 'still-failing', 'unverified', 'needs-approval', 'manual', 'applier-threw',
])

/**
 * 动作 → 该怎么处理它。
 *
 * `via: 'applier'` 表示"存在一个可执行的实现，需要调用方注入"；
 * `via: 'manual'` 表示"本产品做不了这件事"——**如实说做不了，
 * 好过给一个假装能做、实际什么也没改的按钮**。
 */
export const REPAIR_MODES = Object.freeze({
  'reapply-composition-patch': Object.freeze({
    via: 'applier',
    needsApproval: true,
    why: 'DSH 的用户 profile 是 `patchReload: \'live\'`：往运行中的 profile 写入这一层会' +
      '**立刻改变正在跑的 harness 的强制面**，包括发起这次修复的那个进程自己。' +
      '所以它必须由人显式批准，而不是"自检没过就自动重写"',
  }),
  'install-supported-runtime': Object.freeze({
    via: 'manual',
    why: '要换的是 DSH 运行时本身，不在本产品能改的范围内',
  }),
  'fix-sandbox-backend': Object.freeze({
    via: 'manual',
    why: '沙箱后端是宿主的配置与运行环境，改它需要宿主侧的显式决策',
  }),
  'connect-composition-observer': Object.freeze({
    via: 'manual',
    why: '观察器是**注入**进装配调用的：接上它是改调用方的接线代码，不是改一个文件',
  }),
  'inspect-manually': Object.freeze({
    via: 'manual',
    why: '这一项没有预置修法，失败原因需要人工判断',
  }),
})

/** 未知动作的兜底：**不许**因为"没登记"就当作无事发生。 */
const UNKNOWN_MODE = Object.freeze({
  via: 'manual',
  why: '这个动作没有登记处理方式（可能是新增的修法没有同步登记）：' +
    '**不能**因为查不到就跳过它，它代表的失败项仍然在阻止执行',
})

function modeOf(action) {
  return REPAIR_MODES[action] ?? UNKNOWN_MODE
}

/**
 * 执行一份修复计划，并用**重新自检**确认结果。
 *
 * @param {object} deps
 * @param {object} deps.plan        `repairPlanFor()` 的产物（或任何 `{items}`）
 * @param {object} [deps.appliers]  `{ [action]: async (item) => unknown }`，注入
 * @param {string[]} [deps.approved] 显式批准执行的动作名
 * @param {Function} [deps.recheck] `async () => check`，跑一次与当初同一套自检
 * @returns {Promise<object>} 判决与剩余待办
 */
export async function repairRuntime(deps = {}) {
  const { plan, appliers = {}, approved = [], recheck } = deps

  const items = plan?.items
  if (!Array.isArray(items)) {
    return Object.freeze({
      ok: false, code: REPAIR_CODES.BAD_PLAN,
      message: '修复计划里没有 items 数组：没有可执行的东西时**不能**报成功' +
        '（一个空计划与一份"已经没有问题了"的计划在读数上完全一样）',
      outcomes: Object.freeze([]), outstanding: Object.freeze([]),
    })
  }

  const approvedSet = new Set(Array.isArray(approved) ? approved : [])
  const outcomes = []
  let attempted = 0

  // ── 阶段一：决定每一项要不要执行，并执行 ──
  for (const item of items) {
    const action = typeof item?.action === 'string' ? item.action : ''
    const check = typeof item?.check === 'string' ? item.check : ''
    const mode = modeOf(action)
    const base = {
      check, action,
      label: typeof item?.label === 'string' ? item.label : null,
      why: typeof item?.why === 'string' ? item.why : null,
      reasons: Object.freeze([...(item?.reasons ?? [])]),
      mode: mode.via,
    }

    if (mode.via !== 'applier') {
      outcomes.push(Object.freeze({ ...base, verdict: 'manual', detail: mode.why, ran: false, applierSaid: null }))
      continue
    }
    if (mode.needsApproval === true && !approvedSet.has(action)) {
      outcomes.push(Object.freeze({
        ...base, verdict: 'needs-approval', detail: mode.why, ran: false, applierSaid: null,
      }))
      continue
    }
    const apply = appliers[action]
    if (typeof apply !== 'function') {
      // 声明可执行、却没有实现 —— 接线缺一截。**不能**降级成 `manual`：
      // `manual` 说的是"本产品做不了"，而这句说的是"调用方少给了一个东西"。
      // 混成一个判决，排查方向会从"去人工修"开始，而真因是没人接 applier。
      outcomes.push(Object.freeze({
        ...base, verdict: 'manual', detail: null, ran: false, applierSaid: null,
        code: REPAIR_CODES.NO_APPLIER,
        notice: `「${action}」被登记为可执行，但没有注入对应的 applier：` +
          '这是接线缺一截（不是"本产品做不了"）。手动做也可以，但请知道这条是**可以自动化**的',
      }))
      continue
    }

    let said = null
    let threw = null
    try {
      said = await apply(item)
    } catch (e) {
      threw = e
    }
    attempted += 1
    outcomes.push(Object.freeze({
      ...base,
      // 判决**先占位**，阶段二用复核结果改写。applier 的返回值只进 `applierSaid`。
      verdict: threw === null ? 'still-failing' : 'applier-threw',
      detail: threw === null ? null : `动作抛错：${threw?.message ?? String(threw)}`,
      ran: true,
      // **仅诊断**。它说自己成了不算数——修复是"做错了反而更糟"的那类操作。
      applierSaid: said === undefined ? null : said,
    }))
  }

  // ── 阶段二：复核。只有真的跑过动作才值得复核 ──
  let recheckResult = null
  let recheckError = null
  if (attempted > 0) {
    if (typeof recheck !== 'function') {
      recheckError = 'recheck 不是函数'
    } else {
      try {
        recheckResult = await recheck()
      } catch (e) {
        recheckError = e?.message ?? String(e)
      }
    }
  }

  const verdictOf = new Map()
  let rechecked = false
  if (attempted > 0) {
    if (recheckError !== null || recheckResult === null || typeof recheckResult !== 'object' ||
        !Array.isArray(recheckResult.checks)) {
      // 复核失败 → 每一项都**不能**判成已修好。宁可说"没判定"，
      // 也不要给出一个用户会照着相信的"已修复"。
      for (const o of outcomes) {
        if (o.ran && o.verdict === 'still-failing') verdictOf.set(o.check, 'unverified')
      }
    } else {
      rechecked = true
      const byName = new Map(recheckResult.checks.map((c) => [String(c?.name ?? ''), c]))
      for (const o of outcomes) {
        if (!o.ran) continue
        const hit = byName.get(o.check)
        // 新结论里**没有这一项** → `unverified`。这不是"顺手当成通过"的地方：
        // 一项检查从报告里消失，比它报"没过"更值得警惕。
        verdictOf.set(o.check, hit === undefined ? 'unverified' : (hit.ok === true ? 'fixed' : 'still-failing'))
      }
    }
  }

  const final = outcomes.map((o) => {
    // **判决只在这里定。** 抛错的动作不参与复核改写：它没有成功执行过。
    //
    // 上面阶段二的循环里**刻意不再写一遍**同一个判断。曾经写过，而那是死的：
    // 写进 `verdictOf` 的条目永远不被读到，于是它看起来像一道防线、实际不影响
    // 任何输出——破验证 ⑰④ 第一轮瞄的正是它，没咬。
    //   > 一道守着另一个守卫的守卫，在观测上与不存在同形。
    if (!o.ran || o.verdict === 'applier-threw') return o
    const v = verdictOf.get(o.check) ?? 'unverified'
    let detail = o.detail
    if (v === 'fixed') detail = '复核确认这一项现在通过了'
    else if (v === 'still-failing') detail = '动作执行了，但复核说这一项仍然没过'
    else if (v === 'unverified') {
      detail = recheckError !== null
        ? `复核没能完成（${recheckError}），所以**无法判定**这一项修好了没有`
        : `复核的结论里没有 \`${o.check}\` 这一项：**无法判定**它修好了没有` +
          '（一项检查从报告里消失，比它报"没过"更值得警惕）'
    }
    return Object.freeze({ ...o, verdict: v, detail })
  })

  const outstanding = final.filter((o) => o.verdict !== 'fixed')
  const needsHuman = outstanding.some((o) => o.verdict !== 'unverified')

  // 顶层码只说**这一层自己**知道的事：
  //   · 全部解决           → `null`
  //   · 复核没跑成         → `RECHECK_FAILED`（"修好了没有"根本没被判定）
  //   · 还有未解决项       → `STILL_OUTSTANDING`（每项的**具体**判决在 outcomes 里）
  //
  // 不在顶层塞一个笼统的失败码：调用方要区分"没判定"与"判定为没好"，
  // 而这两件事的下一步动作完全不同（再查一次 vs 去解决那一项）。
  const code = outstanding.length === 0
    ? null
    : (recheckError !== null ? REPAIR_CODES.RECHECK_FAILED : REPAIR_CODES.STILL_OUTSTANDING)

  return Object.freeze({
    ok: outstanding.length === 0,
    code,
    message: outstanding.length === 0
      ? '复核确认全部失败项都已修复'
      : `${outstanding.length} 项仍未解决：` +
        outstanding.map((o) => `${o.check}（${o.verdict}）`).join('、'),
    outcomes: Object.freeze(final),
    outstanding: Object.freeze(outstanding),
    /** 复核是否真的跑过。没跑过时**所有 `fixed` 都不可能存在**（阶段二不会写）。 */
    rechecked,
    /** 是否还有需要人做的事。`unverified` 不算——它需要的是**再查一次**。 */
    needsHuman,
    attempted,
  })
}

/** 便于调用方把计划里的动作名逐个列出（含未登记的）。 */
export function repairActionsOf(plan) {
  const items = Array.isArray(plan?.items) ? plan.items : []
  return Object.freeze(items.map((i) => String(i?.action ?? '')))
}

/** 供调用方构造批准列表：**只有**登记为 `applier` 且需要批准的动作会被列出来。 */
export function approvableActions() {
  return Object.freeze(Object.entries(REPAIR_ACTIONS)
    .map(([, v]) => v.action)
    .filter((a) => modeOf(a).via === 'applier')
    .sort())
}
