// workbench/src/waitingOnUser.ts
// ============================================================================
// 「待用户决定」的唯一判据（T2.3）。
//
// ## 为什么不新增一个状态
//
// 设计原则 4 说"不建立第二套任务状态机"，而 `tasks.status` 的取值是封闭的
// （`todo / in_progress / in_review / done / blocked / canceled`）。"需要用户拍板"
// 今天是**表达在 `blocked` 之上的一个标记**：守护把问题写成一条以 `❓` 开头的
// 评论，将军答复后这个标记自然消失（`plugins/src/stateMachine.ts` 的同一口径）。
//
// 所以它不该被建模成第七个状态——那会让"受阻"与"等人"在数据面上分家，
// 而这正是本仓反复避免的第二份真相。
//
// ## 为什么要把判据抽出来
//
// 在此之前，同一段逻辑在 UI 里**写了两遍**（任务详情 `pendingAskOf` 与
// 任务中心 `askOpen`），没有单测。两处只要有一处改了（比如改成"最后一条
// 非空评论"或"任意一条 ❓"），看板与详情就会对同一张卡给出不同结论，
// 而那种不一致只会表现为"用户觉得界面在说两件事"。
// ============================================================================

/** 判据需要的最小形状：只读 `comments`，不依赖整个 HubTask。 */
export interface WaitingOnUserInput {
  comments?: Array<{ text?: string | null }> | null
}

/** 评论是否是一条"待确认"标记（以 ❓ 开头，允许前导空白）。 */
export function isAskMarker(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trimStart().startsWith('❓')
}

/**
 * 这张任务是否正在等用户决定。
 *
 * 只看**最后一条**评论：守护每次提问都追加在末尾，将军的答复跟在它后面，
 * 于是"末尾是不是 ❓"这一个判断同时表达了"在问"与"已回答"。
 *
 * ★ 不做"任意一条 ❓"的判断：那会让一张早就答完的老任务永远挂在待确认里，
 *   而用户完全看不出它在等什么。
 */
export function isWaitingOnUser(task: WaitingOnUserInput | null | undefined): boolean {
  const comments = task?.comments ?? []
  if (comments.length === 0) return false
  return isAskMarker(comments[comments.length - 1]?.text ?? '')
}

/**
 * 待确认那条评论本身（供详情弹窗渲染就地答复框）；不在等用户时为 `null`。
 */
export function pendingAskComment<T extends { text?: string | null }>(task: { comments?: T[] | null } | null | undefined): T | null {
  const comments = task?.comments ?? []
  if (comments.length === 0) return null
  const last = comments[comments.length - 1]
  return isAskMarker(last?.text ?? '') ? last : null
}

/** 一条提问里逐条「❓」的点数（供答复框提示"含 N 个待确认点"）。 */
export function askPointCount(text: string | null | undefined): number {
  if (typeof text !== 'string' || text === '') return 0
  return text.split('\n').filter((line) => line.trimStart().startsWith('❓')).length
}
