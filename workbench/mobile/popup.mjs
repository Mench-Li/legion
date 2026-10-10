// workbench/mobile/popup.mjs
// ============================================================================
// 手机端的提醒弹框（BUG-021 的手机一半）
//
// ## 为什么手机端也要
//
// 这条缺陷在手机上**更严重**：手机正是"人不在电脑前"时唯一的窗口。
// 电脑端改好之后，手机端仍然只显示一个"待我决定"的数字徽标——而徽标要人主动去看。
//
//   > 一个"任务页签上有个小红点"的手机端，
//   > 与一个"到点了会在你手机上弹一条"的手机端，
//   > 在用户把手机放在桌上没看的时候，是两个东西。
//
// ## 为什么这份是纯 JS、不是从 `src/notify.ts` 引一份
//
// 手机端**零构建**（见 app.mjs 开头：刻意不用 React/打包器，首屏要快），
// 所以它不能 import 一个 `.ts`。于是判据在这里重写一遍——重写就会漂移，
// 所以有一条**对等判据**直接跑两边、逐个断言结果相同
// （`workbench/mobile/popup.test.mjs`，与「看板视角」那条对等判据同一个做法）。
//
// 这条纪律值得写下来：
//   > 一份"两端各自实现、靠人记得同步"的规则，
//   > 与一份"两端实现不同、但每次改动都被一条判据顶住"的规则，
//   > 在没人记得同步的那天之前，是一模一样的。
// ============================================================================

/** 状态中文。与 `src/notify.ts` 的 `NOTIFY_STATUS_LABEL` 逐字一致（对等判据盯着）。 */
export const POPUP_STATUS_LABEL = Object.freeze({
  backlog: '待规划',
  todo: '待处理',
  in_progress: '进行中',
  in_review: '待你验收',
  blocked: '受阻（等你处理）',
  done: '已完成',
  canceled: '已取消',
})

/**
 * 高优先级动作（**就是要弹框的那些**）。与 `src/notify.ts` 的 `HIGH_ACTIONS` 同一个集合。
 *
 * 弹框是**打扰**，所以门槛必须比"进徽标"更高：开工、产物登记、进度、评论都不弹。
 * 一个什么都弹的提醒，等于没有提醒。
 */
const HIGH_ACTIONS = Object.freeze(['hold', 'reassign', 'test-report', 'goal:publish', 'goal:done', 'goal:cancel'])

/** `transition` 落到这两个状态视为"需要你动手"。与桌面端 `HIGH_TRANSITION_STATES` 同集合。 */
const HIGH_TRANSITION_STATES = Object.freeze(['blocked', 'in_review'])

/** 动作 → 中文（只覆盖会弹的那些；桌面端那张大表里有更多，但那些不弹）。 */
const ACTION_LABEL = Object.freeze({
  hold: '🖐 拦截自动',
  unhold: '🚀 放行自动',
  reassign: '🔁 转派',
  'test-report': '🧪 测试报告',
  transition: '🔄 状态变更',
})

/** 有效任务号（`*` 是占位、空值不算）。与桌面端 `validTaskId` 同口径。 */
export function validTaskId(taskId) {
  return typeof taskId === 'string' && taskId.length > 0 && taskId !== '*' ? taskId : null
}

/**
 * 这一条该不该弹。
 *
 * 入参是**审计行**（`/api/activity` 与 SSE 帧形状相同：`{action, detail, taskId, ...}`），
 * 不是桌面端的 `NotifyItem`——手机端不做那一层归一化，直接吃原始行更省。
 * 对等判据保证这两种写法在**该弹/不该弹**上给出同一个答案。
 */
export function shouldPopup(row) {
  const action = typeof row?.action === 'string' ? row.action : ''
  if (HIGH_ACTIONS.includes(action)) return true
  if (action === 'transition') {
    const to = row?.detail !== null && typeof row?.detail === 'object' ? row.detail.to : null
    return typeof to === 'string' && HIGH_TRANSITION_STATES.includes(to)
  }
  return false
}

/**
 * 弹框文案：一句话说清"哪个任务、要你做什么"。
 *
 * `who` 可选（角色中文名，如「方案研究员」）。与桌面端 `popupText` 逐字一致。
 */
export function popupText(row, who = null) {
  const tid = validTaskId(row?.taskId)
  const head = tid === null ? '' : tid + ' '
  const tail = typeof who === 'string' && who.length > 0 ? `（${who}）` : ''
  const detail = row?.detail !== null && typeof row?.detail === 'object' ? row.detail : {}
  switch (row?.action) {
    case 'transition': {
      const to = typeof detail.to === 'string' ? detail.to : ''
      const state = POPUP_STATUS_LABEL[to] ?? (to.length > 0 ? to : '状态变更')
      const icon = to === 'in_review' ? '⏳' : to === 'blocked' ? '⛔' : '🔄'
      return `${icon} ${head}${state}${tail}`
    }
    case 'hold': return `🖐 ${head}被拦截：守护不再自动认领${tail}`
    case 'unhold': return `🚀 ${head}已放行：守护恢复自动认领${tail}`
    case 'reassign': return `🔁 ${head}被转派${tail}`
    case 'test-report': return `🧪 ${head}测试报告已提交${tail}`
    case 'evidence': return `📦 ${head}提交了证据${tail}`
    case 'goal:publish': return '🎯 目标已发布'
    case 'goal:done': return '✅ 目标已完成'
    case 'goal:cancel': return '✕ 目标已取消'
    case 'goal:pause': return '⏸ 目标已暂停'
    default: return `${ACTION_LABEL[row?.action] ?? ('⚡ ' + String(row?.action ?? ''))} ${head}${tail}`.trim()
  }
}

/**
 * 挑出这一轮该弹的。语义与桌面端 `popupBatch` **完全一致**（对等判据逐个断言）：
 *
 * - 只看 `seq > lastSeq`；
 * - 只弹 `shouldPopup`；
 * - **首次（无游标）只建立基线**，但补告最近 `replayWindowMs` 内的（见桌面端那段长注释：
 *   完全沉默会让"我装了提醒"与"可我还是不知道"同时成立）；
 * - 升序弹，超 `limit` 只留最新，游标仍推进到最新；
 * - 游标按**未过滤**的全量行推进（白名单外的 progress/release-stale 也在涨 seq）。
 */
export function popupBatch(rows, lastSeq, limit = 3, options = {}) {
  const safeLast = Number.isFinite(lastSeq) && lastSeq > 0 ? Math.floor(lastSeq) : 0
  let maxSeq = safeLast
  for (const r of rows ?? []) {
    const s = Number(r?.seq)
    if (Number.isFinite(s) && s > maxSeq) maxSeq = Math.floor(s)
  }
  const notable = (rows ?? []).filter(shouldPopup).slice().sort((a, b) => Number(a.seq) - Number(b.seq))

  const pick = (list) => (limit > 0 && list.length > limit ? list.slice(list.length - limit) : list)
  const shape = (list) => list.map((row) => ({
    id: `${String(row?.scope ?? '')}:${String(row?.seq ?? '')}`,
    seq: Number(row?.seq),
    text: popupText(row),
    row,
  }))

  if (safeLast <= 0) {
    const rawWindow = options.replayWindowMs
    const windowMs = typeof rawWindow === 'number' && Number.isFinite(rawWindow) ? Math.max(0, rawWindow) : 0
    const rawNow = options.nowMs
    const nowMs = typeof rawNow === 'number' && Number.isFinite(rawNow) ? rawNow : Date.now()
    const replay = windowMs === 0 ? [] : notable.filter((row) => {
      const ts = Date.parse(row?.ts)
      if (!Number.isFinite(ts)) return false
      const age = nowMs - ts
      return age >= 0 && age <= windowMs
    })
    return { popups: shape(pick(replay)), lastSeq: maxSeq }
  }
  return { popups: shape(pick(notable.filter((row) => Number(row?.seq) > safeLast))), lastSeq: maxSeq }
}

// ── 游标（per scope，localStorage）──────────────────────────────────────────
//
// 与"未读徽标"用的是**两把**游标，理由见桌面端 `notify.ts`：
// 已读/徽标是用户看出来的，拿它当"弹过了没有"会两头都错。
//
// 键名与桌面端**不同**（`legion.mobile.popupseq.` vs `legion.notify.popupseq.`）：
// 两端各自的页面消费各自的提醒，共用一个键会让"在电脑上看过"顺手把手机上的也吞掉。

export const popupSeqKey = (scope) => 'legion.mobile.popupseq.' + (scope ?? '__all__')

function store() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // 隐私模式等：读存储本身会抛
  }
}

/** 读游标（没有/损坏/负数 → 0 = 下次只建立基线，不炸）。 */
export function readPopupSeq(scope, storage = null) {
  const s = storage ?? store()
  if (s === null) return 0
  try {
    const raw = s.getItem(popupSeqKey(scope))
    const n = raw === null ? 0 : Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

/** 写游标：**只前进**（并发标签页里落后的一方不许把它推回去，否则会重弹）。 */
export function writePopupSeq(scope, seq, storage = null) {
  const s = storage ?? store()
  if (s === null) return
  if (!Number.isFinite(seq) || seq <= 0) return
  try {
    if (Math.floor(seq) <= readPopupSeq(scope, s)) return
    s.setItem(popupSeqKey(scope), String(Math.floor(seq)))
  } catch {
    /* 存储不可用不影响本次弹框 */
  }
}

// ── 系统通知的决策（页面不在前台时的那一半）────────────────────────────────
//
// ★ 放在这里而不是 app.mjs：app.mjs 顶层就读 `sessionStorage`/`localStorage`
//   （浏览器专有），在 Node 里 import 它会直接抛——于是放在那儿的纯函数**没办法被判据钉住**。
//   纯决策属于纯模块，这条分界顺便也是"哪些代码能被测"的分界。

/** 纯决策：现在该不该发系统通知。与桌面端 `desktopNotify.shouldUseSystemNotify` 同语义。 */
export function shouldUseSystemNotify({ hidden = false, permission = 'unsupported' } = {}) {
  return hidden === true && permission === 'granted'
}

/**
 * 从任务最新评论里抽一句"**为什么停在这**"（弹框补充说明）。
 *
 * 与桌面端 `src/notify.ts` 的 `popupReason` 逐字同语义（对等判据盯着）。
 * 起因是实测：T-199 弹出来只说「待你验收」，而它真实原因是
 * 「自动合入失败，等待人工处理」—— 一个是点验收，一个是解冲突，动作完全不同。
 *
 * 只认"**出了状况、要人介入**"的语气（失败/冲突/等待人工/拒绝/无法…）；纯进展播报与
 * 常规的"请将军人工验收"都返回 null（后者是闸门的日常，弹框主文案已经说了「待你验收」）。
 *
 * ★ 门槛宁可紧一点：漏掉一次补充说明，用户仍然会被弹框叫到；多糊一句，用户下次就不看了。
 */
export function popupReason(commentText, max = 64) {
  if (typeof commentText !== 'string') return null
  const first = commentText.split('\n').map((s) => s.trim()).find((s) => s.length > 0) ?? ''
  if (first.length === 0) return null
  if (!/失败|冲突|等待人工|需人工|待人工|拒绝|无法|错误|超时|受阻|人工核对|人工处理/.test(first)) return null
  return first.length > max ? first.slice(0, max - 1) + '…' : first
}

/** 任务对象 → 它"为什么停在这"（取**最新**一条评论；翻旧账会把已解决的又报一遍）。 */
export function reasonFromTask(task, max = 64) {
  const list = Array.isArray(task?.comments) ? task.comments : []
  const last = list[list.length - 1]
  return popupReason(last !== undefined && typeof last.text === 'string' ? last.text : null, max)
}
