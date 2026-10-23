// workbench/mobile/interaction.mjs
// ============================================================================
// 手机端的**交互决策**：看板状态列分页、横向手势判定、以及对话滚动位置。
//
// 这个模块存在的理由与 `outbox.mjs` / `read-cache.mjs` 相同：把这些判断从
// `app.mjs` 里**拿出来**，它们才能在 Node 里被直接跑、被逐条钉住 ——
// 而 `app.mjs` 顶层读 `sessionStorage`，在 Node 里 import 就抛。
//
// ## 为什么"卡片滑动式"是**状态列分页**，不是卡片横滑
//
// 看板要回答的是"这个空间里有什么事、卡在哪"。手机上一屏一条状态列，
// 左右滑切列 —— 用户的手指在**状态**之间移动，而不是在**单条任务**之间移动。
// 每列内部纵向滚动，于是"找状态"与"看这一列的全部"是同一个动作。
// （需求文档 A1 的主口径；平铺列表里的卡片左滑是 P1，见 R-13。）
//
// ## 手势的三条硬纪律（都是实测踩出来的形态）
//
//   · **起点在控件上不接**：用户在按钮/输入框上的横向拖动是控件自己的事，
//     抢过来的结果是"点不动"；
//   · **屏幕左右边缘 20px 不接**：那是系统返回手势的区域，抢过来用户就退不出页面；
//   · **纵向优先**：先超过 8px 的位移决定轴，一旦纵向占优就彻底放弃切列 ——
//     否则一段斜着滑的列表会同时滚一下、翻一页。
//
//   > 一个"偶尔会翻页"的滚动，与一个"偶尔会滚动"的翻页，
//   > 在用户手上都是"这个页面不听话"。而这类错误不会报错。
//
// ## 每列独立滚动位置
//
// 切走再切回要回到该列上次的位置（同一会话内）。位置**只影响滚动**，
// 不影响数据 —— 所以这里只提供夹取与"该不该跟到底"的判断，不存任何东西。
// ============================================================================

import { boardColumns } from './board.mjs'

/** 横向提交的最小水平位移（CSS px）。低于它的横向滑动视为"没滑"。 */
export const SWIPE_MIN_DX = 48
/** 屏幕左右边缘的保护带：起点落在里面就不接手势（让系统返回手势通过）。 */
export const SWIPE_EDGE_GUARD = 20
/** 轴锁定阈值：先超过它的那个方向决定这次手势的轴。 */
export const SWIPE_AXIS_SLOP = 8
/** 切页动画时长（毫秒）。要求 180–250ms；CSS 里用同一个数。 */
export const SWIPE_ANIM_MS = 220
/** 用户距底部在这个像素数以内，就算"正在看最新"。 */
export const READ_BOTTOM_PX = 40
/** 未识别状态的页 id（单独一页，原文标注不丢）。 */
export const UNKNOWN_PAGE_ID = 'unknown'

/** 非空状态列的页标题（与 `board.mjs` 的列标题同一口径）。 */
export const UNKNOWN_PAGE_TITLE = '未识别的状态'

/**
 * 这次位移属于哪条轴。
 *
 * @returns {'undecided'|'horizontal'|'vertical'}
 */
export function gestureAxis({ dx = 0, dy = 0, slop = SWIPE_AXIS_SLOP } = {}) {
  const ax = Math.abs(Number(dx) || 0)
  const ay = Math.abs(Number(dy) || 0)
  if (ax < slop && ay < slop) return 'undecided'
  // 平局算纵向：滚动是更常见、也更不该被抢的动作。
  return ax > ay ? 'horizontal' : 'vertical'
}

/**
 * 看板 → **分页**（一屏一列）。
 *
 * 规则与"空列不显示"一致：`count === 0` 的列不生成页 —— 一个空白页会让
 * 用户以为滑到了尽头。未知状态**单独成页**并保留原文标注：悄悄丢掉的后果是
 * "状态机加了一个状态、手机上少了任务"。
 *
 * @param {Array<object>} tasks 当前视角下的任务（`applyView` 的结果）
 * @returns {ReadonlyArray<{id:string,title:string,tone:string,tasks:ReadonlyArray<object>,count:number,unknown:boolean}>}
 */
export function boardPages(tasks = []) {
  const { columns, unknown } = boardColumns(tasks)
  const pages = []
  for (const col of columns) {
    if (col.count === 0) continue
    pages.push(Object.freeze({
      id: col.id, title: col.title, tone: col.tone,
      tasks: col.tasks, count: col.count, unknown: false,
    }))
  }
  if (unknown.length > 0) {
    pages.push(Object.freeze({
      id: UNKNOWN_PAGE_ID, title: UNKNOWN_PAGE_TITLE, tone: 'muted',
      tasks: Object.freeze(unknown), count: unknown.length, unknown: true,
    }))
  }
  return Object.freeze(pages)
}

/**
 * 把页索引夹进合法范围。
 *
 * 列集合会因为刷新/筛选/切空间变化（这一列刚被清空），而 `state.boardPage`
 * 还是旧值 —— 不夹的话用户会停在一张**空白页**上，而它看起来像"任务没了"。
 * 没有页时返回 0（渲染层据此显示"还没有任务"）。
 */
export function clampPageIndex(index, pageCount) {
  const count = Math.max(0, Math.trunc(Number(pageCount) || 0))
  if (count === 0) return 0
  const i = Math.trunc(Number(index) || 0)
  return Math.min(Math.max(0, i), count - 1)
}

/**
 * 一次横向手势的结论（**纯决策**，不碰 DOM）。
 *
 * 判定顺序是刻意的：控件 → 边缘 → 轴 → 阈值 → 边界。
 * 把"阈值"放在"边界"前面，是为了让"到最后一页还继续滑"的情形统一落到
 * `below-threshold`/边界两种**无副作用**的结论上 —— 回弹，不循环。
 *
 * @param {{dx?:number, dy?:number, startX?:number, viewportWidth?:number,
 *          targetInteractive?:boolean, pageIndex?:number, pageCount?:number}} input
 * @returns {{action:'none'|'prev'|'next', pageIndex:number, reason:string}}
 */
export function decideSwipe({
  dx = 0, dy = 0, startX = null, viewportWidth = null,
  targetInteractive = false, pageIndex = 0, pageCount = 0,
} = {}) {
  const current = clampPageIndex(pageIndex, pageCount)
  const none = (reason) => ({ action: 'none', pageIndex: current, reason })
  if (!Number.isFinite(Number(dx)) || !Number.isFinite(Number(dy))) return none('invalid')
  if (targetInteractive === true) return none('interactive')
  if (Number.isFinite(Number(startX)) && Number.isFinite(Number(viewportWidth))) {
    const x = Number(startX)
    const w = Number(viewportWidth)
    if (x < SWIPE_EDGE_GUARD || x > w - SWIPE_EDGE_GUARD) return none('edge')
  }
  const axis = gestureAxis({ dx, dy })
  if (axis === 'vertical') return none('vertical')
  if (axis === 'undecided') return none('undecided')
  const ax = Math.abs(Number(dx))
  const ay = Math.abs(Number(dy))
  // 水平必须**明显**占优：1.2 倍是留给人手抖动的余量（需求 R-05 的验收口径）。
  if (ax < SWIPE_MIN_DX || ax < 1.2 * ay) return none('below-threshold')
  const direction = Number(dx) < 0 ? 1 : -1
  const target = current + direction
  if (direction === 1) return target <= pageCount - 1 ? { action: 'next', pageIndex: target, reason: 'ok' } : none('last-page')
  return target >= 0 ? { action: 'prev', pageIndex: target, reason: 'ok' } : none('first-page')
}

/**
 * 从别的页签切回「任务」时该滚到哪。
 *
 * ★ 为什么不能只看 `columnScroll`：那个表只在**切列**时写入，当前列最近一次
 *   纵向滚动从来没同步过 —— 于是「看全部看板 → 切到对话 → 切回任务」会回到 0。
 *   修复前的实测：当前列滚到 360px，切回来是 0；若那列曾切走过，还会恢复到一个
 *   更旧的值（比"回到顶部"更难解释，因为它看起来像随机）。
 *
 * 判据：离开时记下的位置**只对同一列有效**；列已经换过（刷新把当前列清空导致
 * 页索引夹取）时，退回该列自己存的位置。两者都没有就回顶。
 *
 * @param {{savedTop?:number, savedPageId?:string|null, pageId?:string|null,
 *          columnTop?:number}} input
 * @returns {number} 非负滚动位置
 */
export function boardScrollRestore({
  savedTop = 0, savedPageId = null, pageId = null, columnTop = 0,
} = {}) {
  const top = Number(savedTop)
  const samePage = savedPageId !== null && pageId !== null && savedPageId === pageId
  if (samePage && Number.isFinite(top)) return Math.max(0, top)
  const column = Number(columnTop)
  return Number.isFinite(column) ? Math.max(0, column) : 0
}

/**
 * 页码指示的**键 + 变量**（不是拼好的句子）。
 *
 * ★ 拼好的句子永远查不到英文 —— 这条在本仓已经踩过两次（`outbox` 横幅、
 *   提醒弹框）。所以这里返回 key 与变量，由渲染处的 `t()` 拼。
 *
 * @param {{index:number, pageCount:number, title:string, count:number}} input
 * @returns {{key:string, vars:{index:string,pageCount:string,title:string,count:string}}}
 */
export function pageAnnouncement({ index = 0, pageCount = 0, title = '', count = 0 } = {}) {
  return {
    key: '第 {index}/{pageCount} 页 · {title} {count}',
    vars: {
      index: String(clampPageIndex(index, pageCount) + 1),
      pageCount: String(Math.max(0, Math.trunc(Number(pageCount) || 0))),
      title: String(title ?? ''),
      count: String(Math.max(0, Math.trunc(Number(count) || 0))),
    },
  }
}

/** 距底部还有多少像素（`NaN`/缺失一律当成"不在底部"，不去猜）。 */
export function distanceToBottom({ scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}) {
  const top = Number(scrollTop)
  const height = Number(scrollHeight)
  const client = Number(clientHeight)
  if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(client)) return Infinity
  // 视口高度为 0（元素被隐藏/还没布局）时判不出"离底部多远" ——
  // 这时候"假设在底部"会让隐藏的会话在下次显示时被拽到底，所以宁可当不知道。
  if (client <= 0) return Infinity
  return Math.max(0, height - top - client)
}

/** 用户是不是"正在看最新"（距底部 ≤ 40px，允许 ±4px 抖动的等价口径）。 */
export function nearBottom(input = {}) {
  return distanceToBottom(input) <= READ_BOTTOM_PX
}

/**
 * 一次重渲染之后该怎么处理滚动位置。
 *
 * ★ 为什么需要它：修复前每次渲染都无条件 `scrollTop = scrollHeight` ——
 *   用户向上翻历史时，任何一次 SSE/刷新都会把他拽到底部，于是长对话**读不了**。
 *   这条判据把"跟到底"变成**有条件的**：只在用户本来就在底部、或刚发了消息时。
 *
 * @param {{scrollTop?:number, scrollHeight?:number, clientHeight?:number,
 *          incoming?:number, forceFollow?:boolean}} input
 * @returns {{follow:boolean, pending:number}} `pending` = 不在底部时累计的新消息数
 */
export function timelineScrollPlan({
  scrollTop = 0, scrollHeight = 0, clientHeight = 0, incoming = 0, forceFollow = false,
} = {}) {
  const added = Math.max(0, Math.trunc(Number(incoming) || 0))
  const follow = forceFollow === true || nearBottom({ scrollTop, scrollHeight, clientHeight })
  if (follow) return { follow: true, pending: 0 }
  return { follow: false, pending: added }
}
