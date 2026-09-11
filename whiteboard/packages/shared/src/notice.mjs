// notice.mjs — 提示条的**优先级**规则（纯逻辑，无 DOM）。
//
// 为什么需要一条规则：界面上只有**一个**提示条（`#limit`）。P4-3 给「连接未就绪时的暂存」加了提示后
// 立刻踩到真实回归（被既有 e2e 限流用例抓到）：连接被限流关闭 → 后续绘制入队 → 队列提示把
// 「操作过于频繁」**顶掉了**，用户看到的是「已暂存 2 个操作」，而真正该看到的是「你发得太快了」。
//
// 规则：**治理类**提示（限流/只读/服务端关闭/房间非法/旧房间操作未发送）是「可行动的说明」，
// 优先级高于**连接状态类**（暂存中/已补发）。低优先级不得覆盖高优先级；显式清空（空文本）总是生效。

/** 治理类：可行动的说明，优先级高。 */
export const NOTICE_POLICY = 1;
/** 连接状态类：暂存中/已补发等过程性说明，优先级低。 */
export const NOTICE_CONN = 0;

/**
 * 计算下一个提示状态。
 * @param {{ text?: string, priority?: number }} current 当前状态（text 为空视为无提示）
 * @param {string} nextText 期望写入的文本
 * @param {number} [nextPriority]
 * @returns {{ text: string, priority: number, applied: boolean }} applied=false 表示被高优先级提示挡住
 */
export function resolveNotice(current, nextText, nextPriority = NOTICE_CONN) {
  const text = nextText || '';
  const curText = (current && current.text) || '';
  const curPriority = curText ? (current.priority ?? NOTICE_CONN) : 0;
  // 空文本 = 显式清空，总是生效（否则提示条会永远摘不掉）
  if (!text) return { text: '', priority: 0, applied: true };
  if (nextPriority < curPriority) return { text: curText, priority: curPriority, applied: false };
  return { text, priority: nextPriority, applied: true };
}
