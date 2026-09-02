import { useState } from 'react'
import { updateSpaceConfig } from '../api'
import type { SpaceInfo } from '../types'
import { toast } from './Toast'
import { FolderPickerField } from './FolderPickerField'

interface SpaceSettingsModalProps {
  space: SpaceInfo
  onClose: () => void
  onSaved: (updated: SpaceInfo) => void
}

/**
 * 工作空间设置：编辑显示名 / 本地·私有标记 / 仓库绑定（本地文件夹 + 远程仓库 URL）。
 * 不同工作空间可绑定不同的「本地文件夹 + 远程仓库」组合（如 legion 主仓 vs 业务私有空间）。
 * 本地文件夹通过「📂 选择文件夹」浏览选定（与 DSH 工作空间选目录一致），选中目录即该空间的代码仓库。
 */
export function SpaceSettingsModal({ space, onClose, onSaved }: SpaceSettingsModalProps): React.JSX.Element {
  const [name, setName] = useState(space.name)
  const [local, setLocal] = useState(space.private === true)
  const [localDir, setLocalDir] = useState(space.localDir ?? '')
  const [remoteUrl, setRemoteUrl] = useState(space.remoteUrl ?? '')
  const [busy, setBusy] = useState(false)

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
      </div>
    </div>
  )
}
