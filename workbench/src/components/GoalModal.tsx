import { useState } from 'react'

interface GoalModalProps {
  scope: string
  spaceName: string
  current?: string | null
  onClose: () => void
  onPublish: (scope: string, objective: string) => Promise<void>
}

export function GoalModal({ scope, spaceName, current, onClose, onPublish }: GoalModalProps): React.JSX.Element {
  const [objective, setObjective] = useState(current ?? '')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    const text = objective.trim()
    if (!text) return
    setBusy(true)
    try {
      await onPublish(scope, text)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          🎯 发布目标 · {spaceName}
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>目标文案 *（该空间任务集围绕此目标推进）</label>
            <textarea
              value={objective}
              onChange={e => setObjective(e.target.value)}
              rows={4}
              placeholder="例如：完成 Shop 跨境电商总项目首周上架与合规验收"
              autoFocus
            />
          </div>
          <div className="field">
            <label>
              <span style={{ color: 'var(--muted-2)', fontSize: 10 }}>发布后会写入 team-hub（按空间存储），该空间的智能体据此分工。</span>
            </label>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy || !objective.trim()}>
            {busy ? '发布中…' : '🚀 发布目标'}
          </button>
        </div>
      </div>
    </div>
  )
}
