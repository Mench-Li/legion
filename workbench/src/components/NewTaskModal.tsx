import { useState } from 'react'
import { createHubTask, createTask, getToken } from '../api'
import { toast } from './Toast'

interface NewTaskModalProps {
  onClose: () => void
  scope: string | null
  hubMode: boolean
}

export function NewTaskModal({ onClose, scope, hubMode }: NewTaskModalProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [priority, setPriority] = useState('medium')
  const [token, setToken] = useState(getToken())
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (!title.trim()) {
      toast('err', '请填写任务标题')
      return
    }
    setBusy(true)
    try {
      const input = {
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(acceptance.trim()
          ? { acceptance: acceptance.split('\n').map(s => s.trim()).filter(Boolean) }
          : {}),
        priority,
      }
      if (hubMode) {
        await createHubTask(input, scope)
        toast('ok', `任务已创建到分区「${scope ?? 'default'}」，等待将军批准后守护自动认领`)
      } else {
        await createTask(input)
        toast('ok', '任务已创建，等待将军批准后守护自动认领')
      }
      onClose()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('401') ? '令牌无效或缺失：请在右上角「🔑 令牌」设置 --token 值' : `创建失败：${msg}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          ＋ 新建任务
          <span className="x" onClick={onClose}>
            ✕
          </span>
        </div>
        <div className="modal-body">
          {hubMode && (
            <div style={{ padding: '8px 10px', marginBottom: 10, borderRadius: 6, background: 'rgba(64,255,160,.08)', border: '1px solid rgba(64,255,160,.25)', fontSize: 11, color: 'var(--green)' }}>
              🧭 中枢模式：任务将写入 team-hub v2 分区「{scope ?? 'default'}」，只在该空间的当前任务集可见。
            </div>
          )}
          <div className="field">
            <label>标题 *</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="例如：实现登录页倒计时组件"
              autoFocus
            />
          </div>
          <div className="field">
            <label>描述</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="背景、范围、约束…"
            />
          </div>
          <div className="field">
            <label>验收标准（每行一条）</label>
            <textarea
              value={acceptance}
              onChange={e => setAcceptance(e.target.value)}
              placeholder={'npm run build 通过\n页面可正常交互'}
            />
          </div>
          <div className="field">
            <label>优先级</label>
            <select value={priority} onChange={e => setPriority(e.target.value)}>
              <option value="high">high · 高</option>
              <option value="medium">medium · 中</option>
              <option value="low">low · 低</option>
            </select>
          </div>
          <div className="field">
            <label>写操作令牌（已保存则留空）</label>
            <input
              value={token}
              onChange={e => {
                setToken(e.target.value)
                localStorage.setItem('legion.workbench.token', e.target.value.trim())
              }}
              placeholder="serve.mjs 的 --token 值"
            />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '提交中…' : '创建任务'}
          </button>
        </div>
      </div>
    </div>
  )
}
