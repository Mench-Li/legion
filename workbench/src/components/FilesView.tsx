import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchGitDiff, fetchGitLog, fetchGitStatus, fileDownloadUrl, filesBatch, filesDelete, filesMkdir, filesRename,
  filesSearch, filesUpload, filesUploadAbort, filesUploadChunk, filesUploadComplete, filesUploadInit,
  fetchFileList, fetchFilePreview,
} from '../api'
import type { GitCommit, GitDiffResponse, GitStatusResponse, UploadStrategy } from '../api'
import type { FileEntry, FilePreview, SpaceInfo } from '../types'
import {
  UPLOAD_STRATEGIES, batchConfirmText, batchResultText, chunkCount, conflictPrompt, diffHeadText, diffLines,
  gitHeadText, gitMarkerFor, gitMarkerView, nextChunk, normalizeMoveTarget, normalizeStrategy, readStoredStrategy,
  repoPrefixOf, searchSummary, shouldUseChunked, sizeText, splitHighlight, strategyLabel, toggleInSet, uploadProgressText,
  uploadResultText, writeStoredStrategy,
} from '../filesUi'
import { toast } from './Toast'

interface FilesViewProps {
  scope: string | null
  hubMode: boolean
  spaces: SpaceInfo[]
  /** 打开某工作空间设置（引导绑定本地文件夹用，TC-S5-07）。 */
  onOpenSettings: (space: SpaceInfo) => void
}

function mtimeText(ts: string): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** 浏览器本地设置读写（策略记忆；不可用时静默降级——filesUi 内部已 try/catch）。 */
function localStore(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | null {
  try { return window.localStorage } catch { return null }
}

/**
 * 文件中心（S5）。数据源 = serve.mjs /api/files（scope → 空间 local_dir；仅回环 + 写需 token）。
 * 渲染安全（I5 / TC-S5-08）：文件名/预览内容一律 React 文本节点，无 dangerouslySetInnerHTML。
 * 大文件 read 由后端截断（MAX_READ 256KB）并回行数/总长标注，前端保留 loading 态（TC-S5-10）。
 */
export function FilesView({ scope, hubMode, spaces, onOpenSettings }: FilesViewProps): React.JSX.Element {
  const [dir, setDir] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<FilePreview | null>(null)
  /** 预览请求在途（TC-S5-10：超大文件 read 期间 UI 可见 loading，不假死）。 */
  const [previewLoading, setPreviewLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const fileRef = { current: null as HTMLInputElement | null }

  // ── P2-7 ①：冲突策略（记忆在 localStorage；服务端为权威）──
  const [strategy, setStrategy] = useState<UploadStrategy>(() => readStoredStrategy(localStore()))
  // ── P2-7 ②：分片上传进度（仅大文件；串行，逐个文件上传）──
  const [progress, setProgress] = useState<{ name: string; received: number; total: number; chunkSize: number } | null>(null)
  const abortRef = useRef(false)
  // ── P2-7 ③：搜索与多选批量 ──
  const [query, setQuery] = useState('')
  const [recursive, setRecursive] = useState(false)
  const [hits, setHits] = useState<Array<{ name: string; path: string; type: 'dir' | 'file'; size: number; mtime: string | null }> | null>(null)
  const [hitsTruncated, setHitsTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [moving, setMoving] = useState(false)
  const [moveTo, setMoveTo] = useState('')
  // ── P2-7 ④：git 只读面板 ──
  const [git, setGit] = useState<GitStatusResponse | null>(null)
  const [gitDiff, setGitDiff] = useState<GitDiffResponse | null>(null)
  const [gitDiffPath, setGitDiffPath] = useState<string | null>(null)
  const [gitDiffStaged, setGitDiffStaged] = useState(false)
  const [gitLog, setGitLog] = useState<GitCommit[] | null>(null)
  const [showGitLog, setShowGitLog] = useState(false)

  const space = scope ? spaces.find(s => s.id === scope) ?? null : null
  const spaceName = space?.name ?? scope ?? ''
  /** 预览请求序号：目录切换/再点其他文件时作废在途响应，防乱序覆盖（陈旧内容串显）。 */
  const previewSeq = useRef(0)

  /** 清空预览并作废在途读取（目录切换/根回退/重挂时调用）。 */
  const clearPreview = useCallback((): void => {
    previewSeq.current += 1
    setPreviewLoading(false)
    setPreview(null)
  }, [])

  /** git 只读状态刷新（非仓库/失败都静默：文件中心不因 git 不可用而退化）。 */
  const loadGit = useCallback(async (pathValue: string): Promise<void> => {
    if (!scope) { setGit(null); return }
    try {
      const st = await fetchGitStatus(scope, pathValue)
      setGit(st.isRepo ? st : null)
    } catch {
      setGit(null)
    }
  }, [scope])

  const load = useCallback(async (pathValue: string): Promise<void> => {
    if (!scope) return
    setLoading(true)
    setError('')
    setSelected(new Set()) // 切换目录清空勾选（避免批量操作作用到看不见的旧条目）
    try {
      const resp = await fetchFileList(scope, pathValue)
      setEntries(resp.entries)
      void loadGit(pathValue)
    } catch (e) {
      setEntries([])
      setError(e instanceof Error ? e.message : String(e))
      setGit(null)
    } finally {
      setLoading(false)
    }
  }, [scope, loadGit])

  /** P2-7 ③：文件名搜索（结果替代列表展示；截断时显式提示）。 */
  const runSearch = useCallback(async (q: string, rec: boolean): Promise<void> => {
    if (!scope) return
    const key = q.trim()
    if (key.length === 0) { setHits(null); setHitsTruncated(false); return }
    setSearching(true)
    try {
      const resp = await filesSearch(scope, dir, key, rec)
      setHits(resp.results)
      setHitsTruncated(resp.truncated)
    } catch (e) {
      setHits([])
      toast('err', `搜索失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSearching(false)
    }
  }, [scope, dir])

  // scope / 绑定目录 / 目录切换 → 回到根并重拉最新列表；搜索与 git 视图一并复位
  // （TC-S5-07：在文件中心内经「打开空间设置」绑定目录后，关闭弹窗即自动列出根目录，无需切空间/手刷）
  useEffect(() => {
    previewSeq.current += 1
    setDir('')
    setPreview(null)
    setPreviewLoading(false)
    setQuery('')
    setHits(null)
    setHitsTruncated(false)
    setGitDiff(null)
    setGitDiffPath(null)
    setShowGitLog(false)
    if (scope && space?.localDir) void load('')
    else { setEntries([]); setError(''); setGit(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, load, space?.localDir])

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
    clearPreview()
    void load(next)
  }

  const goUp = (): void => {
    if (!dir) return
    const next = dir.split('/').slice(0, -1).join('/')
    setDir(next)
    clearPreview()
    void load(next)
  }

  const openPreview = async (entry: FileEntry): Promise<void> => {
    if (entry.type === 'dir') { enter(entry.name); return }
    const seq = previewSeq.current + 1
    previewSeq.current = seq
    setPreviewLoading(true)
    try {
      const p = await fetchFilePreview(scope as string, joinRel(dir, entry.name))
      if (previewSeq.current === seq) setPreview(p)
    } catch (e) {
      if (previewSeq.current === seq) {
        setPreview({ ok: false, name: entry.name, ext: '', binary: false, error: e instanceof Error ? e.message : String(e) } as FilePreview)
      }
    } finally {
      if (previewSeq.current === seq) setPreviewLoading(false)
    }
  }

  /** 选择策略：立即记忆（下次上传沿用），并即时生效于本次上传。 */
  const pickStrategy = (s: UploadStrategy): void => {
    setStrategy(s)
    writeStoredStrategy(localStore(), s)
  }

  /**
   * 单文件上传（P2-7 ①②）：
   *   - 小文件走单次 PUT（带策略）；大文件走**分片 + 断点续传**（init 返回 received>0 即从该处继续）；
   *   - ask 策略遇 409 → 询问；确认覆盖则带 overwrite 重试，取消则跳过（原文件保持不动）；
   *   - 分片中途失败：会话保留（服务端按磁盘 .part 记账），下次选同一文件即续传，不从头再传。
   */
  const uploadOne = async (scopeId: string, rel: string, f: File): Promise<string> => {
    if (shouldUseChunked(f.size)) {
      const init = await filesUploadInit(scopeId, rel, f.size, strategy)
      if (init.skipped) return uploadResultText(f.name, { skipped: true })
      if (!init.uploadId) throw new Error('分片上传会话创建失败（服务端未返回 uploadId）')
      let received = init.received
      const chunkSize = init.chunkSize
      setProgress({ name: f.name, received, total: f.size, chunkSize })
      if (received > 0) toast('info', `检测到未完成的上传，从 ${Math.round((received / f.size) * 100)}% 继续：${f.name}`)
      for (;;) {
        if (abortRef.current) { await filesUploadAbort(scopeId, init.uploadId); throw new Error('已取消上传') }
        const c = nextChunk(received, f.size, chunkSize)
        if (c === null) break
        const blob = f.slice(c.offset, c.offset + c.length)
        try {
          const r = await filesUploadChunk(scopeId, init.uploadId, c.offset, blob)
          received = r.received
        } catch (e) {
          // 409/400 带服务端真实进度 → 按其校正后继续（不重传已成功的片）
          const err = e as Error & { received?: number }
          if (typeof err.received === 'number' && err.received !== received) { received = err.received; continue }
          throw e
        }
        setProgress({ name: f.name, received, total: f.size, chunkSize })
      }
      const done = await filesUploadComplete(scopeId, init.uploadId)
      setProgress(null)
      return uploadResultText(f.name, done)
    }
    const res = await filesUpload(scopeId, rel, f, strategy)
    return uploadResultText(f.name, res)
  }

  const onUpload = (fileList: FileList | null): void => {
    const filesArr = fileList ? Array.from(fileList) : []
    if (filesArr.length === 0) return
    void (async () => {
      setBusy(true)
      abortRef.current = false
      const okList: string[] = []
      const failList: string[] = []
      try {
        for (const f of filesArr) {
          const rel = joinRel(dir, f.name)
          try {
            okList.push(await uploadOne(scope as string, rel, f))
          } catch (e) {
            const err = e as Error & { status?: number }
            // ask 策略：服务端 409 → 询问后以明确策略重试（避免"上传失败"这种无行动指引的提示）
            if (err.status === 409 && strategy === 'ask') {
              if (window.confirm(conflictPrompt(f.name))) {
                try {
                  okList.push(shouldUseChunked(f.size)
                    ? await (async () => {
                      const init = await filesUploadInit(scope as string, rel, f.size, 'overwrite')
                      let received = init.received
                      setProgress({ name: f.name, received, total: f.size, chunkSize: init.chunkSize })
                      for (;;) {
                        const c = nextChunk(received, f.size, init.chunkSize)
                        if (c === null) break
                        const r = await filesUploadChunk(scope as string, init.uploadId as string, c.offset, f.slice(c.offset, c.offset + c.length))
                        received = r.received
                        setProgress({ name: f.name, received, total: f.size, chunkSize: init.chunkSize })
                      }
                      const done = await filesUploadComplete(scope as string, init.uploadId as string)
                      setProgress(null)
                      return uploadResultText(f.name, { ...done, strategy: 'overwrite' })
                    })()
                    : await (async () => uploadResultText(f.name, await filesUpload(scope as string, rel, f, 'overwrite')))())
                } catch (e2) {
                  failList.push(`${f.name}（${e2 instanceof Error ? e2.message : String(e2)}）`)
                }
              } else {
                okList.push(uploadResultText(f.name, { skipped: true }))
              }
            } else {
              failList.push(`${f.name}（${err.message}）`)
            }
          } finally {
            setProgress(null)
          }
        }
        if (okList.length > 0) toast(failList.length > 0 ? 'info' : 'ok', okList.join('；'))
        if (failList.length > 0) toast('err', `失败 ${failList.length} 项：${failList.join('；')}`)
        await load(dir)
      } finally {
        setBusy(false)
        abortRef.current = false
        setProgress(null)
        if (fileRef.current) fileRef.current.value = ''
      }
    })()
  }

  /** P2-7 ③：批量删除 / 批量移动（逐项成败由服务端报告，前端只汇总展示）。 */
  const runBatch = async (action: 'delete' | 'move', paths: string[], toDir?: string): Promise<void> => {
    setBusy(true)
    try {
      const res = await filesBatch(scope as string, action, paths, toDir)
      if (res.failed > 0) toast('err', batchResultText(res))
      else toast('ok', batchResultText(res))
      setSelected(new Set())
      const removed = new Set(res.items.filter(i => i.ok).map(i => i.path))
      if (preview && removed.has(joinRel(dir, preview.name))) clearPreview()
      await load(dir)
    } catch (e) {
      toast('err', `批量操作失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const doBatch = (action: 'delete' | 'move', paths: string[], toDir?: string): void => {
    if (paths.length === 0) { toast('err', '请先勾选要操作的条目'); return }
    if (!window.confirm(batchConfirmText(action, paths.length, toDir))) { toast('info', '已取消'); return }
    void runBatch(action, paths, toDir)
  }

  /** 批量下载：逐个触发（后端支持单文件流式下载；不引入 zip 依赖）。 */
  const downloadSelected = (paths: string[]): void => {
    if (paths.length === 0) { toast('err', '请先勾选要下载的文件'); return }
    for (const p of paths) {
      const a = document.createElement('a')
      a.href = fileDownloadUrl(scope as string, p)
      a.download = ''
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    toast('info', `已触发 ${paths.length} 个下载（逐个下载，未打包）`)
  }

  /** P2-7 ④：打开单文件 diff（只读；staged 切换重取）。 */
  const openGitDiff = async (relPath: string, staged = gitDiffStaged): Promise<void> => {
    setGitDiffPath(relPath)
    setGitDiffStaged(staged)
    try {
      setGitDiff(await fetchGitDiff(scope as string, relPath, staged))
    } catch (e) {
      toast('err', `读取 diff 失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const toggleGitLog = async (): Promise<void> => {
    if (showGitLog) { setShowGitLog(false); return }
    setShowGitLog(true)
    if (gitLog === null) {
      try {
        const r = await fetchGitLog(scope as string, dir, 20)
        setGitLog(r.commits ?? [])
      } catch { setGitLog([]) }
    }
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
        if (preview?.name === entry.name) clearPreview()
        await load(dir)
      } catch (e) {
        toast('err', `删除失败：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(false)
      }
    })()
  }

  const crumbs = dir.split('/').filter(Boolean)
  const repoPrefix = git?.repoRoot && space?.localDir ? repoPrefixOf(space.localDir, git.repoRoot) : ''
  const gitFiles = git?.files ?? []
  /** 当前展示的条目路径（搜索结果模式下是结果路径，否则是当前目录下条目）——勾选/全选的唯一口径。 */
  const visiblePaths = hits !== null ? hits.map(h => h.path) : entries.map(e => joinRel(dir, e.name))
  const selectedList = [...selected]

  return (
    <div className="center-col">
      <div className="panel goal-card files-head">
        <span className="tag">📁 文件中心</span>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>
          {spaceName}
          <span style={{ color: 'var(--muted-2)', fontSize: 11 }}> · 根：{space.localDir}</span>
        </span>
        {git && (
          <span className="chip" title="git 只读：分支 / 领先落后 / 改动汇总（不做 stage/commit）" style={{ marginLeft: 6 }}>
            ⎇ {gitHeadText(git)}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }} className="files-actions">
          {busy && <span className="files-busy">⏳ 处理中…</span>}
          <label className="files-strategy" title="同名文件处理方式（记忆在本地设置；服务端为权威）">
            冲突：
            <select value={strategy} onChange={e => pickStrategy(normalizeStrategy(e.target.value))} disabled={busy}>
              {UPLOAD_STRATEGIES.map(s => (<option key={s} value={s}>{strategyLabel(s)}</option>))}
            </select>
          </label>
          <button className="btn" disabled={!dir || busy} onClick={goUp}>⬆ 上级</button>
          <button className="btn" disabled={busy} onClick={() => { setCreating(true); setNewName('') }}>＋ 新建目录</button>
          <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>⇪ 上传</button>
          <input ref={el => { fileRef.current = el }} type="file" multiple style={{ display: 'none' }} onChange={e => onUpload(e.target.files)} />
          <button className="btn" onClick={() => void load(dir)} disabled={busy}>↻ 刷新</button>
        </span>
      </div>

      {/* P2-7 ③：搜索（结果替代列表；递归开关 + 截断提示） */}
      <div className="panel files-search">
        <input
          className="files-search-input"
          placeholder={`在「${dir || '根目录'}」内按文件名搜索…`}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void runSearch(query, recursive) }}
        />
        <label className="chip" title="递归包含子目录">
          <input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} /> 含子目录
        </label>
        <button className="btn small" disabled={searching || busy} onClick={() => void runSearch(query, recursive)}>{searching ? '搜索中…' : '🔍 搜索'}</button>
        {hits !== null && (<button className="btn small ghost" onClick={() => { setHits(null); setQuery(''); setHitsTruncated(false) }}>✕ 退出搜索</button>)}
        {hits !== null && (<span style={{ fontSize: 11, color: hitsTruncated ? 'var(--yellow)' : 'var(--muted)' }}>{searchSummary(hits.length, hitsTruncated, recursive)}</span>)}
      </div>

      {/* P2-7 ②：分片上传进度（大文件；断点续传时显示「续传中」） */}
      {progress && (
        <div className="panel files-progress">
          <span style={{ fontSize: 12 }}>⇪ {progress.name}</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            {uploadProgressText(progress.received, progress.total)} · 共 {chunkCount(progress.total, progress.chunkSize)} 片
          </span>
          <span className="files-progress-bar"><i style={{ width: `${Math.max(1, Math.round((progress.received / Math.max(progress.total, 1)) * 100))}%` }} /></span>
          <button className="btn small danger" onClick={() => { abortRef.current = true }}>取消</button>
        </div>
      )}

      {/* P2-7 ③：批量操作栏（勾选后出现；移动目标由前端先校验相对路径） */}
      {selected.size > 0 && (
        <div className="panel files-batchbar">
          <span style={{ fontSize: 12 }}>已选 {selected.size} 项</span>
          <button className="btn small" disabled={busy} onClick={() => downloadSelected(selectedList.filter(p => !visiblePaths.includes(p) || entries.find(e => joinRel(dir, e.name) === p)?.type === 'file' || hits?.find(h => h.path === p)?.type === 'file'))}>⬇ 下载文件</button>
          <button className="btn small" disabled={busy} onClick={() => { setMoving(true); setMoveTo('') }}>➡ 移动到…</button>
          <button className="btn small danger" disabled={busy} onClick={() => doBatch('delete', selectedList)}>🗑 批量删除</button>
          <button className="btn small ghost" onClick={() => setSelected(new Set())}>取消选择</button>
        </div>
      )}

      <div className="panel files-breadcrumb">
        <span className="crumb" onClick={() => { setDir(''); clearPreview(); void load('') }}>📁 根目录</span>
        {crumbs.map((c, i) => {
          const pathHere = crumbs.slice(0, i + 1).join('/')
          return (<span key={pathHere} className="crumb" onClick={() => { setDir(pathHere); clearPreview(); void load(pathHere) }}> / {c}</span>)
        })}
        {git && (<span className="crumb" style={{ marginLeft: 'auto' }} onClick={() => void toggleGitLog()}>⎇ {showGitLog ? '收起最近提交' : '最近提交'}</span>)}
      </div>

      {showGitLog && (
        <div className="panel files-gitlog">
          {(gitLog ?? []).length === 0 ? (<div className="chat-empty">（无提交记录）</div>) : (gitLog ?? []).map(c => (
            <div key={c.hash} className="files-gitlog-row">
              <span className="chip">{c.short}</span>
              <span style={{ fontSize: 12 }}>{c.subject}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted-2)' }}>{c.author} · {mtimeText(c.date)}</span>
            </div>
          ))}
        </div>
      )}

      {error && <div className="files-error">⚠ {error}</div>}

      <div className="files-body">
        <div className="panel files-list-wrap">
          {hits !== null ? (
            hits.length === 0 ? (<div className="chat-empty">（无匹配结果）</div>) : (
              <table className="files-table">
                <thead><tr>
                  <th style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      aria-label="全选搜索结果"
                      checked={selected.size > 0 && selected.size === hits.length}
                      onChange={e => setSelected(e.target.checked ? new Set(hits.map(h => h.path)) : new Set())}
                    />
                  </th>
                  <th>路径</th><th>大小</th><th>修改时间</th><th style={{ width: 150 }}>操作</th>
                </tr></thead>
                <tbody>
                  {hits.map(h => (
                    <tr key={h.path}>
                      <td><input type="checkbox" aria-label={`选择 ${h.path}`} checked={selected.has(h.path)} onChange={e => setSelected(toggleInSet(selected, h.path, e.target.checked))} /></td>
                      <td>
                        <span className={`file-icon ${h.type}`} onClick={() => { if (h.type === 'dir') { setHits(null); setQuery(''); enter(h.path) } else { void openPreview({ name: h.name, type: 'file', size: h.size, mtime: h.mtime ?? '', isRepo: false, ext: '' } as FileEntry) } }}>
                          {h.type === 'dir' ? '📂' : '📄'} {splitHighlight(h.path, query).map((seg, i) => (seg.hit ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>))}
                        </span>
                      </td>
                      <td>{h.type === 'dir' ? '—' : sizeText(h.size)}</td>
                      <td>{mtimeText(h.mtime ?? '')}</td>
                      <td className="file-row-actions">
                        <button className="btn small" onClick={() => { setHits(null); setQuery(''); if (h.type === 'dir') enter(h.path); else { setDir(h.path.split('/').slice(0, -1).join('/')); void load(h.path.split('/').slice(0, -1).join('/')) } }}>定位</button>
                        {h.type === 'file' && <a className="btn small" href={fileDownloadUrl(scope as string, h.path)} download>下载</a>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : loading && entries.length === 0 ? (<div className="chat-empty">⏳ 加载中…</div>)
            : entries.length === 0 ? (<div className="chat-empty">（空目录）</div>)
            : (
              <table className="files-table">
                <thead><tr>
                  <th style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      aria-label="全选当前目录"
                      checked={selected.size > 0 && selected.size === entries.length}
                      onChange={e => setSelected(e.target.checked ? new Set(entries.map(x => joinRel(dir, x.name))) : new Set())}
                    />
                  </th>
                  <th>名称</th><th style={{ width: 70 }}>git</th><th>大小</th><th>修改时间</th><th style={{ width: 210 }}>操作</th>
                </tr></thead>
                <tbody>
                  {entries.map(e => {
                    const relPath = joinRel(dir, e.name)
                    // P2-7 ④：git 标记需把「仓库根相对路径」与「空间根相对路径」对齐后再查
                    const marker = gitMarkerFor(relPath, repoPrefix, gitFiles)
                    const mv = marker ? gitMarkerView(marker) : null
                    return (
                      <tr key={e.name}>
                        <td><input type="checkbox" aria-label={`选择 ${e.name}`} checked={selected.has(relPath)} onChange={ev => setSelected(toggleInSet(selected, relPath, ev.target.checked))} /></td>
                        <td>
                          <span className={`file-icon ${e.type}`} onClick={() => void openPreview(e)}>
                            {e.type === 'dir' ? '📂' : '📄'}{e.isRepo ? '（repo）' : ''} {e.name}
                          </span>
                        </td>
                        <td>
                          {mv && (
                            <span
                              className={`git-mark git-${mv.tone}`}
                              title={mv.title}
                              style={{ cursor: 'pointer' }}
                              onClick={() => void openGitDiff(relPath)}
                            >
                              {mv.code} {mv.label}
                            </span>
                          )}
                        </td>
                        <td>{e.type === 'dir' ? '—' : sizeText(e.size)}</td>
                        <td>{mtimeText(e.mtime)}</td>
                        <td className="file-row-actions">
                          <button className="btn small" onClick={() => void openPreview(e)}>{e.type === 'dir' ? '打开' : '预览'}</button>
                          {e.type === 'file' && <a className="btn small" href={fileDownloadUrl(scope as string, relPath)} download>下载</a>}
                          {mv && e.type === 'file' && <button className="btn small" title="查看该文件的 unified diff（只读）" onClick={() => void openGitDiff(relPath)}>差异</button>}
                          <button className="btn small" disabled={busy} onClick={() => { setRenaming(e.name); setRenameTo(e.name) }}>重命名</button>
                          <button className="btn small danger" disabled={busy} onClick={() => doDelete(e)}>删除</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
        </div>

        <div className="panel files-preview">
          {gitDiffPath !== null ? (
            <>
              <div className="preview-head">
                <span className="chip">⎇ {gitDiffPath}</span>
                <label className="chip" title="已暂存 = 索引 vs HEAD；未暂存 = 工作区 vs 索引">
                  <input type="checkbox" checked={gitDiffStaged} onChange={e => void openGitDiff(gitDiffPath, e.target.checked)} /> 已暂存
                </label>
                <span className="chip">{diffHeadText(gitDiff ?? {})}</span>
                <button className="btn small ghost" onClick={() => { setGitDiffPath(null); setGitDiff(null) }}>✕ 关闭差异</button>
              </div>
              {gitDiff?.note && (gitDiff.diff ?? '').length === 0 ? (<div className="chat-empty">{gitDiff.note}</div>) : (
                <pre className="preview-body diff-body">
                  {diffLines(gitDiff?.diff ?? '').map((l, i) => (<div key={i} className={`diff-line diff-${l.kind}`}>{l.text || ' '}</div>))}
                </pre>
              )}
            </>
          ) : previewLoading ? (<div className="chat-empty">⏳ 正在读取预览…</div>)
            : preview === null ? (<div className="chat-empty">点文件预览其内容；二进制文件会提示不可预览</div>)
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

      {moving && (
        <div className="modal-mask" onClick={() => setMoving(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              ➡ 移动 {selected.size} 项
              <span className="x" onClick={() => setMoving(false)}>✕</span>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>目标目录（相对空间根，须已存在；同名冲突的项会失败并保留原文件）</label>
                <input
                  value={moveTo}
                  onChange={e => setMoveTo(e.target.value)}
                  autoFocus
                  placeholder="archive/2026"
                  onKeyDown={e => {
                    if (e.key !== 'Enter') return
                    const t = normalizeMoveTarget(moveTo)
                    if (!t.ok) { toast('err', t.error); return }
                    setMoving(false)
                    doBatch('move', selectedList, t.value)
                  }}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setMoving(false)}>取消</button>
              <button
                className="btn primary"
                onClick={() => {
                  const t = normalizeMoveTarget(moveTo)
                  if (!t.ok) { toast('err', t.error); return }
                  setMoving(false)
                  doBatch('move', selectedList, t.value)
                }}
              >确认移动</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}