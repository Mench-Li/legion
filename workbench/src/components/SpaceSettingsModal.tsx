import { useState } from 'react'
import { deleteSpace, fetchSpaceImpact, updateSpaceConfig } from '../api'
import type { SpaceDeleteImpact } from '../api'
import type { SpaceInfo } from '../types'
import { toast } from './Toast'
import { FolderPickerField } from './FolderPickerField'

interface SpaceSettingsModalProps {
  space: SpaceInfo
  onClose: () => void
  onSaved: (updated: SpaceInfo) => void
  /** R-3/S8：删除成功后回调（App 关闭弹窗 + 重拉列表；删的是当前空间则切回全部空间，TC-S8-06）。 */
  onDeleted?: (deletedId: string) => void
}

const PROTECTED_SPACES = ['software', 'default']

export function SpaceSettingsModal({ space, onClose, onSaved, onDeleted }: SpaceSettingsModalProps): React.JSX.Element {
  const [name, setName] = useState(space.name)
  const [local, setLocal] = useState(space.private === true)
  const [localDir, setLocalDir] = useState(space.localDir ?? '')
  const [remoteUrl, setRemoteUrl] = useState(space.remoteUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [dangerOpen, setDangerOpen] = useState(false)
  const [impact, setImpact] = useState<SpaceDeleteImpact | null>(null)
  const [impactLoading, setImpactLoading] = useState(false)
  const [impactError, setImpactError] = useState('')
  const [confirmInput, setConfirmInput] = useState('')
  const [deleting, setDeleting] = useState(false)

  const protectedSpace = PROTECTED_SPACES.includes(space.id)
  const confirmOk = confirmInput === `delete-space:${space.id}`

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      toast('err', '空间名称不能为空')
      return
    }
    setBusy(true)
    try {
      await updateSpaceConfig({
        id: space.id,
        name: name.trim(),
        private: local,
        localDir: localDir.trim(),
        remoteUrl: remoteUrl.trim(),
      })
      toast('ok', `空间「${name.trim()}」配置已保存`)
      onSaved({ ...space, name: name.trim(), private: local, localDir: localDir.trim(), remoteUrl: remoteUrl.trim() })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('401') ? '令牌无效或缺失：请在右上角「🔑 令牌」设置' : `保存失败：${msg}`)
    } finally {
      setBusy(false)
    }
  }

  const openDanger = async (): Promise<void> => {
    const next = !dangerOpen
    setDangerOpen(next)
    setImpactError('')
    if (!next) return
    setImpactLoading(true)
    try {
      const data = await fetchSpaceImpact(space.id)
      setImpact(data)
    } catch (e) {
      setImpact(null)
      setImpactError(e instanceof Error ? e.message : String(e))
    } finally {
      setImpactLoading(false)
    }
  }

  const doDelete = async (): Promise<void> => {
    if (!confirmOk) return
    setDeleting(true)
    try {
      await deleteSpace(space.id)
      toast('ok', `空间「${space.id}」已删除（数据级联清除；磁盘残留请按运维指引清理）`)
      onDeleted?.(space.id)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('401') ? '令牌无效或缺失：请在右上角「🔑 令牌」设置' : `删除失败：${msg}`)
    } finally {
      setDeleting(false)
    }
  }

  const impactRows: Array<[string, number]> = impact
    ? [
        ['任务', impact.counts.tasks],
        ['编队（roster）', impact.counts.roster],
        ['模型配置', impact.counts.agentModels],
        ['执行请求', impact.counts.execRequests],
        ['技能', impact.counts.skills],
        ['空间目标', impact.counts.goal],
        ['编排状态', impact.counts.execState],
        ['会话', impact.counts.conversations],
        ['消息', impact.counts.messages],
        ['日程事件', impact.counts.calendarEvents],
        ['成员', impact.counts.members],
      ]
    : []
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-narrow" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          ⚙ 工作空间设置 · {space.id}
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>空间 id（唯一，不可改）</label>
            <input value={space.id} disabled />
          </div>
          <div className="field">
            <label>空间名称</label>
            <input value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <label className="local-toggle">
            <input type="checkbox" checked={local} onChange={e => setLocal(e.target.checked)} />
            <span>🏠 本地/私有空间（仅在本机操作，不进共享 git 仓库）</span>
          </label>
          <FolderPickerField
            value={localDir}
            onChange={(path, hint) => {
              setLocalDir(path)
              if (hint?.remoteUrl && !remoteUrl.trim()) setRemoteUrl(hint.remoteUrl)
            }}
            onClear={() => {
              setLocalDir('')
              setRemoteUrl('')
            }}
          />
          <div className="field">
            <label>远程仓库 URL（git 远程地址；默认从所选仓库的 origin/首个 remote 自动填入，留空 = 仅本地 / 不进共享仓库）</label>
            <input value={remoteUrl} onChange={e => setRemoteUrl(e.target.value)} placeholder="例如：https://github.com/you/repo.git（或留空）" />
          </div>
          <div className="space-repo-hint">
            📦 当前绑定：
            {space.localDir && <div>本地文件夹：<code>{space.localDir}</code></div>}
            {space.remoteUrl && <div>远程仓库：<code>{space.remoteUrl}</code></div>}
            {!space.localDir && !space.remoteUrl && <div>未绑定（沿用平台默认仓库）。个人空间可绑定自己的本地目录并留空远程，避免业务内容进共享仓库。</div>}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存配置'}
          </button>
        </div>

        <div className="danger-zone">
          <div className="danger-zone-head" onClick={() => void openDanger()}>
            <span>🗑 危险区：删除工作空间「{space.id}」</span>
            <span className="x" style={{ position: 'static' }}>{dangerOpen ? '▾' : '▸'}</span>
          </div>
          {dangerOpen && (
            <div className="danger-zone-body">
              {protectedSpace ? (
                <div style={{ color: 'var(--yellow)', fontSize: 12 }}>
                  🛡 「{space.id}」为受保护空间（platform），不允许删除。
                </div>
              ) : (
                <>
                  {impactLoading ? (
                    <div style={{ fontSize: 12, color: 'var(--muted-2)', padding: '8px 0' }}>⏳ 正在预检删除影响（只读，不产生审计）…</div>
                  ) : impactError ? (
                    <div style={{ fontSize: 12, color: '#ff8f8f', padding: '8px 0' }}>影响预检失败：{impactError}（删除不会执行）</div>
                  ) : impact ? (
                    <div>
                      <div style={{ fontSize: 12 }}>将级联删除（11 类数据表 + 空间行）：</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '2px 16px', fontSize: 12, padding: '6px 0' }}>
                        {impactRows.map(([k, v]) => (
                          <div key={k}><span style={{ color: 'var(--muted-2)' }}>{k}：</span><b>{v}</b></div>
                        ))}
                      </div>
                      {impact.running.tasks.length > 0 && (
                        <div style={{ fontSize: 12, color: 'var(--yellow)', padding: '4px 0' }}>
                          ⚠ 在办/审阅/受阻任务 {impact.running.tasks.length} 条：
                          {impact.running.tasks.map(t => (`${t.id}「${t.title}」[${t.status}]`)).join('；')}
                        </div>
                      )}
                    </div>
                  ) : null}
                  <div className="field" style={{ marginTop: 8 }}>
                    <label>请输入 <code>delete-space:{space.id}</code> 以确认（type-to-confirm，防误删）</label>
                    <input
                      value={confirmInput}
                      placeholder={`delete-space:${space.id}`}
                      onChange={e => setConfirmInput(e.target.value)}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', paddingTop: 8 }}>
                    <span style={{ fontSize: 10, color: 'var(--muted-2)', marginRight: 'auto' }}>
                      此操作不可撤销；审计保留 space:delete 历史。磁盘残留（本地文件）由运维按提示清理
                    </span>
                    <button className="btn danger" disabled={!confirmOk || deleting} onClick={() => void doDelete()}>
                      {deleting ? '删除中…' : '确认删除该空间'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
