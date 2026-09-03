import { useCallback, useEffect, useState } from 'react'
import { fileDownloadUrl, filesDelete, filesMkdir, filesRename, filesUpload, fetchFileList, fetchFilePreview } from '../api'
import type { FileEntry, FilePreview, SpaceInfo } from '../types'
import { toast } from './Toast'

interface FilesPanelProps {
  scope: string | null
  hubMode: boolean
  spaces: SpaceInfo[]
  /** 打开某工作空间设置（引导绑定本地文件夹用，TC-S5-07）。 */
  onOpenSettings: (space: SpaceInfo) => void
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function mtimeText(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/**
 * 文件中心（S5）。数据源 = serve.mjs /api/files（scope → 空间 local_dir；仅回环 + 写需 token）。
 * 渲染安全（I5 / TC-S5-08）：文件名/预览内容一律 React 文本节点，无 dangerouslySetInnerHTML。
 */
export function FilesPanel({ scope, hubMode, spaces, onOpenSettings }: FilesPanelProps): React.JSX.Element {
  const [dir, setDir] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const fileRef = { current: null as HTMLInputElement | null }

  const space = scope ? spaces.find(s => s.id === scope) ?? null : null
  const spaceName = space?.name ?? scope ?? ''

  const load = useCallback(async (pathValue: string): Promise<void> => {
    if (!scope) return
    setLoading(true)
    setError('')
    try {
      const resp = await fetchFileList(scope, pathValue)
      setEntries(resp.entries)
    } catch (e) {
      setEntries([])
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [scope])

  useEffect(() => {
    setDir('')
    setPreview(null)
    if (scope) void load('')
    else { setEntries([]); setError('') }
  }, [scope, load])

  if (!hubMode) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span style={{ color: 'var(--yellow)' }}>📁 文件中心需要 team-hub v2（中枢）</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            空间 local_dir 映射来自中枢 /api/spaces。启动 <code>node team-hub/server.mjs</code>（:8787）后可用
          </span>
        </div>
      </div>
    )
  }

  if (!scope) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span style={{ color: 'var(--yellow)' }}>📁 请先选择具体工作空间</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            文件根 = 该空间绑定的本地文件夹。在左侧选择一个已绑定的空间（「全部空间」无单一文件根）
          </span>
        </div>
      </div>
    )
  }

  if (!space?.localDir) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span style={{ color: 'var(--yellow)' }}>📁 空间「{spaceName}」尚未绑定本地文件夹</span>
          <span style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.8 }}>
            请先到空间设置里为它绑定一个本地目录作为文件根（文件中心将只读写该目录内部；.git 内部受保护）
          </span>
          <span>
            {space && <button className="btn primary" onClick={() => onOpenSettings(space)}>⚙ 打开空间设置</button>}
          </span>
        </div>
      </div>
    )
  }

  const enter = (name: string): void => {
    const next = joinRel(dir, name)
    setDir(next)
    setPreview(null)
    void load(next)
  }

  const goUp = (): void => {
    if (!dir) return
    const next = dir.split('/').slice(0, -1).join('/')
    setDir(next)
    setPreview(null)
    void load(next)
  }

  const openPreview = async (entry: FileEntry): Promise<void> => {
    if (entry.type === 'dir') { enter(entry.name); return }
    setPreview({ ok: false, name: entry.name, ext: '', binary: false } as FilePreview)
    try {
      const p = await fetchFilePreview(scope as string, joinRel(dir, entry.name))
      setPreview(p)
    } catch (e) {
      setPreview({ ok: false, name: entry.name, ext: '', binary: false, error: e instanceof Error ? e.message : String(e) } as FilePreview)
    }
  }

  const onUpload = (fileList: FileList | null): void => {
    const filesArr = fileList ? Array.from(fileList) : []
    if (filesArr.length === 0) return
    void (async () => {
      setBusy(true)
      try {
        for (const f of filesArr) {
          try {
            await filesUpload(scope as string, joinRel(dir, f.name), f, false)
            toast('ok', `已上传：${f.name}`)
          } catch (e) {
            const err = e as Error & { status?: number }
            if (err.status === 409) {
              const yes = window.confirm(`文件「${f.name}」已存在，是否覆盖？（原文件将被替换）`)
              if (yes) {
                await filesUpload(scope as string, joinRel(dir, f.name), f, true)
                toast('ok', `已覆盖：${f.name}`)
              } else {
                toast('info', `已取消上传：${f.name}`)
              }
            } else {
              toast('err', `上传 ${f.name} 失败：${err.message}`)
            }
          }
        }
        await load(dir)
      } finally {
        setBusy(false)
        if (fileRef.current) fileRef.current.value = ''
      }
    })()
  }

  const doMkdir = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) { toast('err', '请输入目录名'); return }
    setCreating(false)
    setNewName('')
    try {
      await filesMkdir(scope as string, joinRel(dir, name))
      toast('ok', `已创建目录：${name}`)
      await load(dir)
    } catch (e) {
      toast('err', `创建失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const doRename = async (entry: FileEntry): Promise<void> => {
    const target = renameTo.trim()
    setRenaming(null)
    if (!target || target === entry.name) return
    const targetPath = joinRel(dir, target)
    const sourcePath = joinRel(dir, entry.name)
    if (targetPath.includes('/') && target.split('/').length > 1) { toast('err', '重命名目标只允许同一目录内的新名字'); return }
    try {
      await filesRename(scope as string, sourcePath, joinRel(dir, target.split('/').pop() ?? target))
      toast('ok', `已重命名：${entry.name} → ${target}`)
      await load(dir)
    } catch (e) {
      toast('err', `重命名失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const doDelete = (entry: FileEntry): void => {
    const hint = entry.type === 'dir' ? `目录「${entry.name}」必须为空才能删除` : `文件「${entry.name}」将被永久删除`
    const yes = window.confirm(`${hint}\n\n输入确认后点击「确定」。此操作不可撤销（需 confirm=yes 二次确认）。`)
    if (!yes) { toast('info', '已取消删除'); return }
    void (async () => {
      setBusy(true)
      try {
        await filesDelete(scope as string, joinRel(dir, entry.name), 'yes')
        toast('ok', `已删除：${entry.name}`)
        if (preview?.name === entry.name) setPreview(null)
        await load(dir)
      } catch (e) {
        toast('err', `删除失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(false)
      }
    })()
  }

  const crumbs = dir.split('/').filter(Boolean)

  return (
    <div className="center-col">
      <div className="panel goal-card files-head">
        <span className="tag">📁 文件中心</span>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>
          {spaceName}
          <span style={{ color: 'var(--muted-2)', fontSize: 11 }}> · 根：{space.localDir}</span>
        </span>
        <span style={{ marginLeft: 'auto' }} className="files-actions">
          <button className="btn" disabled={!dir || busy} onClick={goUp}>⬆ 上级</button>
          <button className="btn" disabled={busy} onClick={() => { setCreating(true); setNewName('') }}>＋ 新建目录</button>
          <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>⇪ 上传</button>
          <input ref={el => { fileRef.current = el }} type="file" multiple style={{ display: 'none' }} onChange={e => onUpload(e.target.files)} />
          <button className="btn" onClick={() => void load(dir)} disabled={busy}>↻ 刷新</button>
        </span>
      </div>

      <div className="panel files-breadcrumb">
        <span className="crumb" onClick={() => { setDir(''); setPreview(null); void load('') }}>📁 根目录</span>
        {crumbs.map((c, i) => {
          const pathHere = crumbs.slice(0, i + 1).join('/')
          return (<span key={pathHere} className="crumb" onClick={() => { setDir(pathHere); setPreview(null); void load(pathHere) }}> / {c}</span>)
        })}
      </div>

      {error && <div className="files-error">⚠ {error}</div>}

      <div className="files-body">
        <div className="panel files-list-wrap">
          {loading && entries.length === 0 ? (<div className="chat-empty">⏳ 加载中…</div>)
            : entries.length === 0 ? (<div className="chat-empty">（空目录）</div>)
            : (
              <table className="files-table">
                <thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th style={{ width: 210 }}>操作</th></tr></thead>
                <tbody>
                  {entries.map(e => (
                    <tr key={e.name}>
                      <td>
                        <span className={`file-icon ${e.type}`} onClick={() => void openPreview(e)}>
                          {e.type === 'dir' ? '📂' : '📄'}{e.isRepo ? '（repo）' : ''} {e.name}
                        </span>
                      </td>
                      <td>{e.type === 'dir' ? '—' : sizeText(e.size)}</td>
                      <td>{mtimeText(e.mtime)}</td>
                      <td className="file-row-actions">
                        <button className="btn small" onClick={() => void openPreview(e)}>{e.type === 'dir' ? '打开' : '预览'}</button>
                        {e.type === 'file' && <a className="btn small" href={fileDownloadUrl(scope as string, joinRel(dir, e.name))} download>下载</a>}
                        <button className="btn small" disabled={busy} onClick={() => { setRenaming(e.name); setRenameTo(e.name) }}>重命名</button>
                        <button className="btn small danger" disabled={busy} onClick={() => doDelete(e)}>删除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

        <div className="panel files-preview">
          {preview === null ? (<div className="chat-empty">点文件预览其内容；二进制文件会提示不可预览</div>)
            : preview.error ? (<div className="files-error">⚠ {preview.error}</div>)
            : preview.binary ? (<div className="chat-empty">⛔ {preview.message ?? '二进制文件不可预览'}</div>)
            : (
              <>
                <div className="preview-head">
                  <span className="chip">{preview.name}</span>
                  <span className="chip">{sizeText(preview.totalBytes ?? 0)}</span>
                  {preview.truncated && <span className="chip yellow">已截断（前 {preview.content?.length ?? 0} 字符 / 共 {preview.lineCount ?? '?'} 行）</span>}
                  {!preview.truncated && <span className="chip">{preview.lineCount} 行</span>}
                </div>
                <pre className="preview-body">{preview.content ?? ''}</pre>
              </>
            )}
        </div>
      </div>

      {creating && (
        <div className="modal-mask" onClick={() => setCreating(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              ＋ 新建目录（{dir || '/'}）
              <span className="x" onClick={() => setCreating(false)}>✕</span>
            </div>
            <div className="modal-body">
              <div className="field"><label>目录名（可含 / 一次建多层）</label><input value={newName} onChange={e => setNewName(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') void doMkdir() }} /></div>
            </div>
            <div className="modal-foot"><button className="btn ghost" onClick={() => setCreating(false)}>取消</button><button className="btn primary" onClick={() => void doMkdir()}>创建</button></div>
          </div>
        </div>
      )}

      {renaming !== null && (
        <div className="modal-mask" onClick={() => setRenaming(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              ✎ 重命名「{renaming}」
              <span className="x" onClick={() => setRenaming(null)}>✕</span>
            </div>
            <div className="modal-body">
              <div className="field"><label>新名字（同一目录内）</label><input value={renameTo} onChange={e => setRenameTo(e.target.value)} autoFocus onKeyDown={e => { if (e.key === 'Enter') void doRename({ name: renaming, type: 'file' } as FileEntry) }} /></div>
            </div>
            <div className="modal-foot"><button className="btn ghost" onClick={() => setRenaming(null)}>取消</button><button className="btn primary" onClick={() => void doRename({ name: renaming, type: 'file' } as FileEntry)}>确认重命名</button></div>
          </div>
        </div>
      )}
    </div>
  )
}