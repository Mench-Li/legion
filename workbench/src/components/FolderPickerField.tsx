import { useEffect, useState } from 'react'
import { inspectDirectory } from '../api'
import { FolderPickerModal } from './FolderPickerModal'

interface PickHint {
  isRepo?: boolean
  remoteUrl?: string
}

interface FolderPickerFieldProps {
  value: string
  /** 选中文件夹后回调；hint 带 git 探测结果（是否仓库 + 建议远程 URL，取 origin/首个 fetch remote）。 */
  onChange: (path: string, hint?: PickHint) => void
  onClear?: () => void
}

/**
 * 空间仓库绑定的「本地文件夹」字段：只通过「📂 选择文件夹」浏览本机目录选定，
 * 不手填路径（与 DSH 工作空间的选文件夹逻辑一致）。选定后自动做 git 探测：
 * 是代码仓库 → 显示分支/远程并给出建议 remoteUrl；不是仓库 → 提示仅本地使用。
 */
export function FolderPickerField({ value, onChange, onClear }: FolderPickerFieldProps): React.JSX.Element {
  const [showPicker, setShowPicker] = useState(false)
  const [info, setInfo] = useState<{ isRepo: boolean; root: string | null; branch: string | null; remotes: Array<{ name: string; url: string }> } | null>(null)

  // 当前值变化 → git 探测（展示仓库/远程识别结果）
  useEffect(() => {
    let alive = true
    if (!value) {
      setInfo(null)
      return () => { alive = false }
    }
    inspectDirectory(value)
      .then(r => { if (alive) setInfo({ isRepo: r.isRepo, root: r.root, branch: r.branch, remotes: r.remotes }) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [value])

  const pick = async (path: string): Promise<void> => {
    setShowPicker(false)
    let hint: PickHint | undefined
    try {
      const r = await inspectDirectory(path)
      const first = r.remotes.find(x => x.name === 'origin') ?? r.remotes[0]
      hint = r.isRepo ? { isRepo: true, remoteUrl: first?.url ?? '' } : { isRepo: false }
    } catch { /* 探测失败不阻塞选择 */ }
    onChange(path, hint)
  }

  return (
    <>
      <div className="field">
        <label>本地文件夹（该空间对应的代码仓库目录）——点「选择文件夹」浏览选定，不手填地址</label>
        <div className="dir-pick-row">
          <span className="dir-path" title={value}>{value || '（未选择——沿用平台默认仓库）'}</span>
          <button className="btn small" onClick={() => setShowPicker(true)}>📂 选择文件夹…</button>
          {value && (
            <button className="btn small ghost" onClick={() => onClear?.()}>✕ 清除</button>
          )}
        </div>
        {info && value && (
          <div className={`repo-detect${info.isRepo ? '' : ' warn'}`}>
            {info.isRepo
              ? `⛁ git 仓库${info.root ? `：${info.root}` : ''}${info.branch ? `（分支 ${info.branch}）` : ''}`
              : '⚠ 所选目录不是 git 仓库——仅本地使用（worktree 隔离不可用，须先 git init/clone）'}
            {info.isRepo && (
              info.remotes.length > 0
                ? <div>🔗 远程：{info.remotes.map(r => `${r.name} → ${r.url}`).join('；')}（已建议填入下方远程仓库）</div>
                : <div>🔗 该仓库没有配置远程（remote），远程仓库留空 = 仅本地/不进共享仓库</div>
            )}
          </div>
        )}
      </div>
      {showPicker && (
        <FolderPickerModal
          initialPath={value || undefined}
          onPick={(path) => void pick(path)}
          onClose={() => setShowPicker(false)}
        />
      )}
    </>
  )
}
