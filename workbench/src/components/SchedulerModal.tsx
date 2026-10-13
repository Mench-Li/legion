import { useState } from 'react'
import { commentTask, rejectTask, transitionTask } from '../api'
import { inflightTasks } from '../missions'
import type { BoardData, CardStatus } from '../types'
import { toast } from './Toast'

interface SchedulerModalProps {
  board: BoardData
  labels: Record<string, string>
  onClose: () => void
}

const GROUP_LABEL: Record<CardStatus, string> = {
  in_progress: '进行中',
  in_review: '待验收',
  blocked: '受阻',
  todo: '待认领',
  backlog: '待批准',
  done: '已完成',
  canceled: '已取消',
}

const GROUP_ORDER: CardStatus[] = ['in_review', 'in_progress', 'blocked', 'todo', 'backlog']

export function SchedulerModal({ board, labels, onClose }: SchedulerModalProps): React.JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null)

  const act = async (action: () => Promise<unknown>, okText: string): Promise<void> => {
    try {
      await action()
      toast('ok', okText)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('401') ? '令牌无效或缺失：请在右上角「🔑 令牌」设置' : `操作失败：${msg}`)
    }
  }

  const review = async (id: string, version: number): Promise<void> => {
    setBusyId(id)
    await act(() => transitionTask({ id, to: 'done', by: 'general', ifVersion: version }), `${id} 已验收通过`)
    setBusyId(null)
  }

  /**
   * 打回：评论 + 归还待办（`rejectTask` 里一起做）。
   *
   * ★ 这个弹窗在**中枢模式下也挂得出来**（`CommandBar` 的判据是
   *   `hubMode && scope ? HubSchedulerModal : board ? SchedulerModal`，
   *   所以「全部空间」—— `scope === null` —— 走的正是这一支）。
   *   而它从前调的 `rejectTask` 打的是 `/api/reject`：**那个端点已经没有任何服务端在实现**
   *   （v1 看板取消时跟着没了，v2 中枢从来没有），于是将军点「打回」拿到的是一句
   *   `POST /api/reject 404：{"error":"not found: ..."}` —— 读起来像路径拼错了。
   *
   * ★ 顺带修掉一句**假话**：原来的成功文案是「worktree 已回滚并归还待办」。
   *   v2 没有 `w/<id>` 分支纪律，也就没有"回滚"这件事（board-plugin 的 501 说明里
   *   逐字写着「v1 worktree 打回已退役」）。照实说，比说得好听重要。
   */
  const reject = async (id: string, version: number): Promise<void> => {
    const reason = window.prompt(`打回 ${id} 的原因`)
    if (reason === null) return
    setBusyId(id)
    await act(
      () => rejectTask({ id, by: 'general', reason: reason.trim(), ifVersion: version }),
      `${id} 已打回待办（原因已写进评论，执行者下一轮带着它重做）`,
    )
    setBusyId(null)
  }

  const returnTodo = async (id: string, version: number): Promise<void> => {
    setBusyId(id)
    await act(() => transitionTask({ id, to: 'todo', by: 'general', ifVersion: version }), `${id} 已归还待办`)
    setBusyId(null)
  }

  const unblock = async (id: string, version: number): Promise<void> => {
    setBusyId(id)
    await act(() => transitionTask({ id, to: 'todo', by: 'general', ifVersion: version, force: true }), `${id} 已解阻`)
    setBusyId(null)
  }

  const comment = async (id: string): Promise<void> => {
    const text = window.prompt(`给 ${id} 追加评论`)
    if (text === null || !text.trim()) return
    setBusyId(id)
    await act(() => commentTask({ id, by: 'general', text: text.trim() }), `${id} 评论已追加`)
    setBusyId(null)
  }

  const inflight = inflightTasks(board)
  const groups = GROUP_ORDER.map(status => ({
    status,
    items: inflight.filter(sc => sc.status === status),
  })).filter(g => g.items.length > 0)

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          🗓 任务调度 · 将军指挥
          <span className="x" onClick={onClose}>
            ✕
          </span>
        </div>
        <div className="modal-body">
          {groups.length === 0 && (
            <div style={{ color: 'var(--muted-2)', fontSize: 12 }}>当前没有进行中/待验收/受阻任务</div>
          )}
          {groups.map(g => (
            <div key={g.status} className="sched-group">
              <h5>
                {GROUP_LABEL[g.status]} <span style={{ color: 'var(--muted-2)' }}>({g.items.length})</span>
              </h5>
              {g.items.map(({ card }) => (
                <div key={card.id} className="sched-card">
                  <div className="t">
                    <div>
                      {card.id} · {card.title}
                    </div>
                    <div className="meta">
                      {labels[card.soldier ?? ''] ?? card.soldier ?? '未指派'} · v{card.version}
                    </div>
                  </div>
                  <div className="sched-actions">
                    {g.status === 'in_review' && (
                      <>
                        <button className="btn mini primary" disabled={busyId === card.id} onClick={() => void review(card.id, card.version)}>
                          验收通过
                        </button>
                        <button className="btn mini" disabled={busyId === card.id} onClick={() => void reject(card.id, card.version)}>
                          打回
                        </button>
                      </>
                    )}
                    {g.status === 'in_progress' && (
                      <button className="btn mini" disabled={busyId === card.id} onClick={() => void returnTodo(card.id, card.version)}>
                        归还待办
                      </button>
                    )}
                    {g.status === 'blocked' && (
                      <button className="btn mini" disabled={busyId === card.id} onClick={() => void unblock(card.id, card.version)}>
                        解阻
                      </button>
                    )}
                    <button className="btn mini ghost" disabled={busyId === card.id} onClick={() => void comment(card.id)}>
                      评论
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
