import { useEffect, useState } from 'react'
import { fetchDirListing, fetchFsHome } from '../api'
import type { DirEntry } from '../types'

interface FolderPickerModalProps {
  initialPath?: string
  onPick: (path: string) => void
  onClose: () => void
}

/**
 * 选择文件夹（照搬 DSH 工作空间的选目录逻辑：导航浏览本机目录，而不是手填路径）。
 * 数据源 = workbench 自带 /api/fs（同源；仅回环地址可访问），列目录时标记 git 仓库（.git）。
 */
export function FolderPickerModal({ initialPath, onPick, onClose }: FolderPickerModalProps): React.JSX.Element {
  const [current, setCurrent] = useState('')
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [isRoot, setIsRoot] = useState(true)
  const [drives, setDrives] = useState<Array<{ name: string; path: string }>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = async (p: string): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const list = await fetchDirListing(p)
      setCurrent(list.path)
      setEntries(list.entries)
      setParent(list.parent)
      setIsRoot(list.isRoot)
      setDrives(list.drives)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let alive = true
    const boot = async (): Promise<void> => {
      try {
        if (initialPath && initialPath.length > 0) {
          await load(initialPath)
        } else {
          const home = await fetchFsHome()
          if (alive) await load(home.home)
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void boot()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-narrow folder-picker-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          📂 选择文件夹
          <span className="x" onClick={onClose}>✕</span>
        </div>
        <div className="modal-body">
          <div className="fs-path-bar">
            {!isRoot && (
              <button className="btn small ghost" disabled={loading} onClick={() => { if (parent) void load(parent) }}>⬆ 上级</button>
            )}
            <span className="fs-path" title={current}>{current || '…'}</span>
          </div>
          {error && <div className="fs-error">{error}</div>}
          <div className="fs-scroll">
            {isRoot && drives.length > 0 && (
              <div className="fs-drives">
                {drives.map(d => (
                  <div key={d.name} className="pick-row" onClick={() => void load(d.path)}>
                    <span>💽</span><span>{d.name}</span>
                  </div>
                ))}
              </div>
            )}
            {entries.length === 0 && !loading && <div className="fs-empty">（空目录，可点下方「选择此文件夹」）</div>}
            {entries.map(en => (
              <div key={en.path} className="pick-row" title={en.path} onClick={() => void load(en.path)}>
                <span>📁</span>
                <span className="pick-name">{en.name}</span>
                {en.isRepo && <span className="repo-chip" title="此目录是 git 代码仓库（含 .git）">⛁ 仓库</span>}
              </div>
            ))}
            {loading && <div className="fs-empty">读取中…</div>}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!current || loading} onClick={() => onPick(current)}>
            选择此文件夹
          </button>
        </div>
      </div>
    </div>
  )
}
