/**
 * 上下文快照查看界面（PRT-409 最后一件：spec line 897「支持查看和导出」）。
 *
 * ## 这一屏要回答的问题
 *
 * 它不是"把一份 JSON 显示出来"，而是"**让我相信屏幕上这一份就是模型当时看到的**"。
 * 所以布局上最重要的三件事都不是排版问题，而是**可信度**问题：
 *
 *   ① **验证结论必须在最上面，且是三态。** "没验过"与"验过了通过"不能长得一样。
 *   ② **三本账必须显式说出来**（候选/入选/排除/截断/脱敏），
 *      因为一份**截断过的**快照只显示正文时，用户会以为模型读完了全文。
 *   ③ **被清掉的快照是单独一屏**，不是"无数据"。
 *
 * 全部判定都在 `../snapshotView.ts` 里（可被 `node --test` 钉住），
 * 本组件只负责取数与渲染。**每个导出都有生产调用点**。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiBase } from '../api'
import {
  snapshotPath, snapshotListPath, tombstonesPath, exportPath,
  readSnapshotResponse, verifyVerdict, verifyText, shortHash,
  ledgerView, ledgerText, ledgersOf, exclusionLabel, unknownReasons,
  segmentViews, textPreview, tombstoneText, countsText,
  relativeTime, bytesText, listRows, screenFor,
  type SnapshotFetch, type SnapshotListItem, type SnapshotCounts, type SnapshotTombstone,
} from '../snapshotView'

interface Props {
  scope?: string | null
  hubMode?: boolean
}

export function SnapshotView({ scope, hubMode }: Props) {
  const [items, setItems] = useState<SnapshotListItem[]>([])
  const [counts, setCounts] = useState<SnapshotCounts | null>(null)
  const [tombstones, setTombstones] = useState<SnapshotTombstone[]>([])
  const [fetchState, setFetchState] = useState<SnapshotFetch | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState('')

  const load = useCallback(async () => {
    if (!hubMode) return
    setBusy(true)
    setErr('')
    try {
      const [listRes, tombRes] = await Promise.all([
        fetch(`${apiBase()}${snapshotListPath({ scope: scope || undefined, limit: 200 })}`),
        fetch(`${apiBase()}${tombstonesPath({ limit: 200 })}`),
      ])
      const list = await listRes.json()
      const tomb = await tombRes.json()
      setItems(Array.isArray(list.snapshots) ? list.snapshots : [])
      setCounts(tomb.counts ?? null)
      setTombstones(Array.isArray(tomb.tombstones) ? tomb.tombstones : [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [scope, hubMode])

  useEffect(() => { void load() }, [load])

  /** 打开一份快照。**`verify=1` 由 snapshotPath 强制带上**，这里没有开关。 */
  const open = useCallback(async (attemptId: string) => {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`${apiBase()}${snapshotPath(attemptId)}`)
      const body = await res.json().catch(() => null)
      setFetchState(readSnapshotResponse(res.status, body))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  /** 导出一份快照：**把后端算好的文档原样存盘**，不在前端重算哈希。 */
  const doExport = useCallback(async (attemptId: string) => {
    setBusy(true)
    setErr('')
    try {
      const res = await fetch(`${apiBase()}${exportPath(attemptId, { by: 'workbench', atMs: Date.now() })}`)
      const body = await res.json().catch(() => null)
      if (res.status !== 200 || body?.export === undefined) {
        setErr(`导出失败（${res.status}）：${body?.error ?? body?.code ?? '未知'}`)
        return
      }
      const blob = new Blob([JSON.stringify(body.export, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `context-${attemptId.replace(/[^\w.-]/g, '_')}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const screen = screenFor({ items, fetch: fetchState })
  const nowMs = Date.now()
  const rows = listRows(items, nowMs).filter((r) => filter === ''
    || r.attemptId.includes(filter) || r.runId.includes(filter))

  return (
    <div className="snapshot-view" style={{ padding: 16, overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>上下文快照</h2>
        <span style={{ opacity: 0.65, fontSize: 12 }}>
          每一次运行**实际**发给模型的输入。可还原来源版本、过滤与裁剪原因。
        </span>
        <button onClick={() => void load()} disabled={busy || !hubMode} style={{ marginLeft: 'auto' }}>
          {busy ? '载入中…' : '刷新'}
        </button>
      </div>

      {!hubMode && <div className="snap-note warn">这一屏需要中枢（team-hub）——快照存在那里。</div>}
      {err !== '' && <div className="snap-note err">✕ {err}</div>}

      {counts !== null && (
        <div style={{ opacity: 0.7, fontSize: 12, marginBottom: 10 }}>
          {countsText(counts)}
          <span style={{ marginLeft: 8, opacity: 0.8 }}>
            （「累计产生」把已清理的也算上——清理不会让总数凭空变小。）
          </span>
        </div>
      )}

      {screen === 'list' && (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按 attemptId / runId 过滤"
            style={{ width: 320, marginBottom: 8 }}
          />
          {rows.length === 0 ? (
            <div style={{ opacity: 0.7 }}>没有快照。上下文快照在每次运行冻结输入时产生。</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                  <th>Attempt</th><th>冻结于</th><th>tokens</th><th>哈希</th><th>标记</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.attemptId} style={{ borderTop: '1px solid rgba(128,128,128,.25)' }}>
                    <td><code>{r.attemptId}</code></td>
                    <td>{r.frozenAt}</td>
                    <td>{r.tokens}</td>
                    <td><code>{r.hash}</code></td>
                    <td>{r.flags.join(' · ')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button style={{ fontSize: 12 }} onClick={() => void open(r.attemptId)}>查看</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tombstones.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3 style={{ fontSize: 14, marginBottom: 4 }}>已清理（存在过，正文已按保留策略删除）</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {tombstones.map((t) => (
                  <li key={t.attemptId} style={{ marginBottom: 4 }}>
                    <code>{t.attemptId}</code> — {tombstoneText(t)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {screen === 'purged' && fetchState?.kind === 'purged' && (
        <div>
          <div className="snap-note warn">
            ⚠ 这份上下文**存在过**，但已被保留策略清理——正文没有了，这次的输入**无法还原**。
          </div>
          <p style={{ fontSize: 13 }}>{tombstoneText(fetchState.tombstone)}</p>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            内容哈希 <code>{fetchState.tombstone.snapshotHash || '—'}</code> ·{' '}
            丢掉 {bytesText(fetchState.tombstone.bytes)} ·{' '}
            清于 {Number.isFinite(fetchState.tombstone.purgedAtMs)
              ? new Date(fetchState.tombstone.purgedAtMs).toLocaleString() : '（未记）'}
          </div>
          <button style={{ marginTop: 12 }} onClick={() => setFetchState(null)}>返回列表</button>
        </div>
      )}

      {screen === 'missing' && (
        <div>
          <div className="snap-note err">✕ 没有这份快照。请确认 attemptId 是否正确。</div>
          <p style={{ fontSize: 12, opacity: 0.75 }}>
            注意：「从来没有过」与「被保留策略清掉」是**两件不同的事**。
            这里显示的是前者。
          </p>
          <button onClick={() => setFetchState(null)}>返回列表</button>
        </div>
      )}

      {screen === 'detail' && fetchState?.kind === 'live' && (
        <SnapshotDetailPane
          detail={fetchState.detail}
          onBack={() => setFetchState(null)}
          onExport={() => void doExport(fetchState.detail.attemptId)}
        />
      )}
    </div>
  )
}

/** 单份快照的详情。判定全部来自 `../snapshotView.ts`，这里只渲染。 */
function SnapshotDetailPane({ detail, onBack, onExport }: {
  detail: import('../snapshotView').SnapshotDetail
  onBack: () => void
  onExport: () => void
}) {
  const verdict = verifyVerdict(detail)
  const led = ledgerView(detail)
  const ledgers = ledgersOf(detail)
  const segs = segmentViews(ledgers.segments)
  const preview = textPreview(ledgers.finalText)
  const unknown = unknownReasons(ledgers.excluded)

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <button onClick={onBack}>← 返回</button>
        <code style={{ fontSize: 13 }}>{detail.attemptId}</code>
        <button onClick={onExport} style={{ marginLeft: 'auto' }}>导出这一份</button>
      </div>

      {/* ★ 可信度：验证结论在最上面，且三态各有**不同的样式**。
          className 用 `snap-verdict` + 状态后缀——因为 `.err`/`.warn`/`.ok`
          在本仓库里没有独立定义（只有 `.toast.err` 这类复合选择器），
          写成裸 `.err` 会让三态渲染成同一个样子。 */}
      <div
        className={`snap-verdict ${verdict === 'ok' ? 'ok' : verdict === 'mismatch' ? 'err' : 'warn'}`}
      >
        {verifyText(verdict)}
        {detail.verification !== undefined && detail.verification !== null && (
          <div style={{ fontSize: 12, marginTop: 4, opacity: 0.85 }}>
            落库哈希 <code>{shortHash(detail.verification.storedHash)}</code> ·{' '}
            重算哈希 <code>{shortHash(detail.verification.recomputedHash)}</code>
          </div>
        )}
      </div>

      {/* ★ 三本账：必须显式说出来，而不是让人去做加法。 */}
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <strong>账本：</strong>{ledgerText(led)}
      </div>
      {led.partial && (
        <div className="snap-note warn" style={{ fontSize: 13 }}>
          ⚠ 这份快照有**部分包含**：下面正文里有一部分来源只进去了前一段。
          只显示正文会让它看起来像读完了全文。
        </div>
      )}

      <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 12 }}>
        冻结于 {relativeTime(detail.frozenAtMs, Date.now())} · 记录于 {relativeTime(detail.recordedAtMs, Date.now())} ·{' '}
        {detail.tokens?.tokens ?? '?'} tokens
        {typeof detail.maxTokens === 'number' ? ` / 上限 ${detail.maxTokens}` : ''} ·{' '}
        {detail.tokens?.kind === 'exact' ? '精确 tokenizer' : '保守估算（只会高估）'}
      </div>

      {unknown.length > 0 && (
        <div className="snap-note warn" style={{ fontSize: 13 }}>
          ⚠ 这份快照里有界面**不认识**的排除理由：{unknown.join('、')}。
          它可能是新加的策略，不要当成"其他原因"略过。
        </div>
      )}

      <h3 style={{ fontSize: 14 }}>被排除的来源（{ledgers.excluded.length}）</h3>
      {ledgers.excluded.length === 0
        ? <div style={{ fontSize: 13, opacity: 0.7 }}>没有来源被排除。</div>
        : (
          <ul style={{ fontSize: 13, margin: '4px 0 12px', paddingLeft: 18 }}>
            {ledgers.excluded.map((e, i) => (
              <li key={`${e.id}-${i}`}>
                <code>{e.id}</code> — {exclusionLabel(e.reason)}
                {e.detail !== undefined && e.detail !== '' ? `（${e.detail}）` : ''}
              </li>
            ))}
          </ul>
        )}

      <h3 style={{ fontSize: 14 }}>被脱敏的位置（{ledgers.redactions.length}）</h3>
      {ledgers.redactions.length === 0
        ? <div style={{ fontSize: 13, opacity: 0.7 }}>没有内容被脱敏。</div>
        : (
          <ul style={{ fontSize: 13, margin: '4px 0 12px', paddingLeft: 18 }}>
            {ledgers.redactions.map((r, i) => (
              <li key={`${r.sourceId}-${i}`}><code>{r.sourceId}</code>@{r.at} — {r.why}</li>
            ))}
          </ul>
        )}

      <h3 style={{ fontSize: 14 }}>正文</h3>
      {segs.gaps > 0 && (
        <div className="snap-note warn" style={{ fontSize: 13 }}>
          ⚠ 分段之间有 {segs.gaps} 个字符**不属于任何来源**——它们确实被发给了模型，
          但没有出处。
        </div>
      )}
      {segs.segments.length > 0 && (
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
          共 {segs.segments.length} 段、覆盖 {segs.covered} 字符。
          {segs.segments.slice(0, 12).map((s) => `${s.at}:${s.from}-${s.to}`).join(' · ')}
        </div>
      )}
      <pre style={{
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12,
        background: 'rgba(128,128,128,.08)', padding: 10, borderRadius: 4, maxHeight: 420, overflow: 'auto',
      }}
      >
        {preview.text}
      </pre>
      {preview.truncated && (
        <div style={{ fontSize: 12, opacity: 0.8 }}>
          ↑ 预览只显示前 {preview.text.length} 个字符（全文 {preview.totalChars} 字符）。
          <button style={{ marginLeft: 8, fontSize: 12 }} onClick={onExport}>
            导出全文
          </button>
        </div>
      )}
    </div>
  )
}
