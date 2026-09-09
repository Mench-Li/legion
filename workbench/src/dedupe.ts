/**
 * 前端去重/合并纯函数（P2-3 S6）。
 *
 * 这些函数原先以组件私有函数形式散在 NotifyView.tsx / ChatView.tsx / App.tsx，
 * 没有自动化测试（docs/review/T-100-REVIEW.md O5）。P2-3 统一 SSE 去重口径：
 * 抽成无副作用纯函数，node:test 可直接 import 本 .ts（无 JSX/tsx 依赖），
 * 组件改为复用，保证「SSE 回放/轮询合并/乱序帧」三种来源同一去重语义。
 */

/** 按 seq 去重并按 seq 降序（v2 审计事件：服务端查询降序；SSE 回放/轮询合并时兜底排序）。 */
export function dedupeSeqDesc<T extends { seq: number }>(rows: T[]): T[] {
  const seen = new Set<number>()
  const out: T[] = []
  for (const r of rows) {
    if (seen.has(r.seq)) continue
    seen.add(r.seq)
    out.push(r)
  }
  out.sort((a, b) => b.seq - a.seq)
  return out
}

/** 按 id 合并两批消息并保序升序（同 id 后者覆盖；live 合并/加载更早/发送追加共用）。 */
export function mergeById<T extends { id: number }>(a: T[], b: T[]): T[] {
  const map = new Map<number, T>()
  for (const m of a) map.set(m.id, m)
  for (const m of b) map.set(m.id, m)
  return [...map.values()].sort((x, y) => x.id - y.id)
}

/** v1 activity 事件内容指纹（App.tsx seenEvents 口径：断线重连/轮询重复帧去重）。 */
export function activityFingerprint(a: { ts?: unknown; kind?: unknown; taskId?: unknown; text?: unknown }): string {
  return [a.ts, a.kind, a.taskId, a.text].map((x) => String(x ?? '')).join('|')
}

/** 按内容指纹去重（保序）；返回去重后数组 + 新增指纹 Set（供调用方播种/更新 seen 集）。 */
export function dedupeByFingerprint<T extends { ts?: unknown; kind?: unknown; taskId?: unknown; text?: unknown }>(
  rows: T[],
  seen: Set<string> = new Set(),
): { rows: T[]; seen: Set<string> } {
  const out: T[] = []
  for (const r of rows) {
    const key = activityFingerprint(r)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return { rows: out, seen }
}
