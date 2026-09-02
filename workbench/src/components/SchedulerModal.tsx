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

  const reject = async (id: string): Promise<void> => {
    const reason = window.prompt(`打回 ${id} 的原因`)
    if (reason === null) return
    setBusyId(id)
    await act(
      () => rejectTask({ id, by: 'general', reason: reason.trim() || '打回重做' }),
      `${id} 已打回，worktree 已回滚并归还待办`,
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
                        <button className="btn mini" disabled={busyId === card.id} onClick={() => void reject(card.id)}>
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
