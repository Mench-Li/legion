import { useCallback, useEffect, useRef, useState } from 'react'
import { webFetchPage, webHistory, webHistoryClear, webMeta, webScreenshot, webShotUrl } from '../api'
import type { WebFetchResult, WebHistoryResponse, WebMetaResponse, WebShotResult } from '../types'
import {
  cacheBadge, errorText, historyItemView, historyStatsText, isErrorResult, normalizeUrl,
  qualityBadges, quotaText, quotaTone, relativeTime, shotButtonView, shotResultText, shotStatusText, shortUrlText,
} from '../browserUi'
import { toast } from './Toast'

const HISTORY_KEY = 'legion.browser.history'
const MAX_HISTORY = 8
const SCOPED_HISTORY_LIMIT = 30

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const arr = raw ? (JSON.parse(raw) as string[]) : []
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string').slice(0, MAX_HISTORY) : []
  } catch {
    return []
  }
}

function pushHistory(url: string): void {
  const arr = loadHistory().filter(u => u !== url)
  arr.unshift(url)
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, MAX_HISTORY))) } catch { /* 忽略配额 */ }
}

/** 浏览器助手（S6 抓取 + P2-8 增强）：服务端安全抓取；历史/缓存/配额/截图均以 serve.mjs + team-hub 为权威。 */
export function BrowserView({ scope = '' }: { scope?: string }): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [history, setHistory] = useState<string[]>(() => loadHistory())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<WebFetchResult | null>(null)
  const [statusText, setStatusText] = useState('')
  const [lastUrl, setLastUrl] = useState('')
  // P2-8：空间级历史（team-hub）/ 配额与截图状态（serve.mjs）/ 截图结果
  const [scoped, setScoped] = useState<WebHistoryResponse | null>(null)
  const [meta, setMeta] = useState<WebMetaResponse | null>(null)
  const [shot, setShot] = useState<WebShotResult | null>(null)
  const [shotBusy, setShotBusy] = useState(false)
  const [showScoped, setShowScoped] = useState(true)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const el = document.getElementById('browser-url-input') as HTMLInputElement | null
    el?.focus() // TC-S7-06：进入面板即聚焦地址栏
  }, [])

  /** 刷新空间历史与配额快照（被动读，不触发抓取）。 */
  const refreshSide = useCallback(async (): Promise<void> => {
    const [h, m] = await Promise.all([
      scope ? webHistory({ scope, limit: SCOPED_HISTORY_LIMIT }).catch(() => null) : Promise.resolve(null),
      webMeta(scope || undefined),
    ])
    if (!mounted.current) return
    setScoped(h)
    setMeta(m)
  }, [scope])

  useEffect(() => { void refreshSide() }, [refreshSide])

  const fetchUrl = useCallback(async (raw: string): Promise<void> => {
    const norm = normalizeUrl(raw)
    if (norm === null) {
      toast('err', 'URL 无法解析：请检查格式（例：https://example.com）')
      return
    }
    setUrl(norm)
    setBusy(true)
    setStatusText('⏳ 正在抓取…')
    setShot(null)
    try {
      // P2-8：带 scope → 服务端按空间缓存/限流/记账；不带 scope 走原有不限流路径
      const res = await webFetchPage({ url: norm, scope: scope || undefined })
      if (!mounted.current) return
      setResult(res)
      setLastUrl(norm)
      setStatusText('')
      if (res.ok && res.code) {
        toast('info', res.code === 'empty_content' ? '已抓取，但页面无可抽取正文' : errorText(res))
      } else if (!res.ok) {
        toast('err', errorText(res))
      } else if (res.cached) {
        toast('info', (res.revalidated ? '缓存已确认未变：' : '命中缓存：') + shortUrlText(res.finalUrl ?? norm))
      }
      if (res.ok) pushHistory(norm)
      setHistory(loadHistory())
    } catch (e) {
      if (mounted.current) {
        setResult(null)
        setStatusText('')
        toast('err', '浏览器助手请求失败：' + (e instanceof Error ? e.message : String(e)))
      }
    } finally {
      if (mounted.current) setBusy(false)
      void refreshSide() // 抓取后刷新历史与配额读数
    }
  }, [refreshSide, scope])

  const submit = (): void => {
    if (!url.trim()) { toast('err', '请输入要浏览的网址'); return }
    void fetchUrl(url)
  }

  /** P2-8③：截图当前页（默认关闭的能力；按钮在不可用时就已禁用并说明原因）。 */
  const takeShot = useCallback(async (): Promise<void> => {
    const target = result?.finalUrl ?? lastUrl
    if (!target) { toast('err', '请先抓取一个页面再截图'); return }
    setShotBusy(true)
    try {
      const r = await webScreenshot({ url: target, scope: scope || undefined })
      if (!mounted.current) return
      if (r.ok) { setShot(r); toast('info', '已生成截图：' + r.file) } else { setShot(null); toast('err', errorText(r)) }
    } catch (e) {
      if (mounted.current) { setShot(null); toast('err', '截图失败：' + (e instanceof Error ? e.message : String(e))) }
    } finally {
      if (mounted.current) setShotBusy(false)
      void refreshSide()
    }
  }, [lastUrl, refreshSide, result, scope])

  const clearScoped = useCallback(async (id?: number): Promise<void> => {
    if (!scope) { toast('err', '未绑定空间：空间历史需要工作台以空间模式运行'); return }
    const r = await webHistoryClear({ scope, id })
    if (r.ok) { toast('info', id ? '已删除该条记录' : '已清空本空间抓取历史'); void refreshSide() }
    else toast('err', '清空失败：' + (r.error ?? '未知原因'))
  }, [refreshSide, scope])

  const code = result?.code ?? ''
  const errFlag = result ? isErrorResult(result) : false
  const cache = result ? cacheBadge(result) : null
  const badges = result ? qualityBadges(result.quality) : []
  const shotView = shotButtonView(meta?.shot)

  return (
    <div className="center-col">
      <div className="panel goal-card browser-head">
        <span className="tag">🌐 浏览器助手</span>
        <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>服务端安全抓取（SSRF 防护）：不直连你浏览器的网络，正文为结构化文本返回</span>
      </div>

      <div className="panel browser-bar">
        <input
          id="browser-url-input"
          list="browser-history"
          value={url}
          placeholder="输入网址，如 example.com 或 https://example.com/page"
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit() }}
        />
        <datalist id="browser-history">
          {history.map(h => <option key={h} value={h} />)}
        </datalist>
        <button className="btn primary" disabled={busy || !url.trim()} onClick={submit}>
          {busy ? '抓取中…' : '▶ 抓取'}
        </button>
      </div>

      {/* P2-8④：配额读数（剩余次数/并发/当日流量）+ ③ 截图能力状态，接近上限时染色提醒 */}
      <div className="panel browser-side-row">
        <span className={'chip quota-' + quotaTone(meta?.quota)} title="按空间限流：每分钟请求数、并发抓取数、每日流量配额（超限返回 429）">
          {quotaText(meta?.quota)}
        </span>
        <span className="chip" title={shotView.hint}>{shotStatusText(meta?.shot)}</span>
        <span className="chip" style={{ marginLeft: 'auto' }}>
          <button
            className="btn small"
            disabled={shotView.disabled || shotBusy || busy || !(result?.ok || lastUrl)}
            title={shotView.hint}
            onClick={() => void takeShot()}
          >
            {shotBusy ? '截图…' : shotView.label}
          </button>
        </span>
      </div>

      {busy && <div className="panel browser-loading">⏳ 正在连接并解析目标页…</div>}
      {statusText && !busy && <div className="panel browser-loading">{statusText}</div>}

      {result && (
        <div className="panel browser-result">
          <div className="browser-meta">
            <span className="chip">{result.status ?? '?'}</span>
            <span className="chip">{result.contentType?.split(';')[0] ?? ''}</span>
            <span className="chip" title={result.finalUrl}>{shortUrlText(result.finalUrl ?? lastUrl)}</span>
            {/* P2-8①：把「为什么这么快 / 为什么是这个内容」说清楚 */}
            {cache && <span className={'chip badge-' + cache.tone} title={cache.title}>{cache.label}</span>}
            {/* P2-8②：抽取质量徽标 */}
            {badges.map(b => <span key={b.label} className={'chip badge-' + b.tone} title={b.title}>{b.label}</span>)}
          </div>
          {errFlag ? (
            <div className="browser-error">⚠ {errorText(result)}</div>
          ) : (
            <>
              {result.title && <h3 className="browser-title">{result.title}</h3>}
              {code === 'unsupported' ? (<div className="browser-error">📄 {errorText(result)}</div>)
                : code === 'empty_content' ? (<div className="browser-error">{errorText(result)}</div>)
                : result.text ? (<pre className="browser-text">{result.text}</pre>)
                : (<div className="chat-empty">（无可显示正文）</div>)
              }
              {result.links && result.links.length > 0 && (
                <div className="browser-links">
                  <div className="browser-links-title">页面链接（{result.links.length}）</div>
                  {result.links.map(l => <a key={l} href={l} target="_blank" rel="noopener noreferrer">{l}</a>)}
                </div>
              )}
            </>
          )}
          {result.ok && !errFlag && (
            <div className="browser-bar-foot">
              <button className="btn small" disabled={busy} onClick={() => void fetchUrl(lastUrl)}>↻ 重新抓取</button>
            </div>
          )}
          {errFlag && (
            <div className="browser-bar-foot">
              <button className="btn small primary" disabled={busy} onClick={() => void fetchUrl(url || lastUrl)}>↻ 重试</button>
            </div>
          )}
        </div>
      )}

      {/* P2-8③：截图结果（缩略图 + 元信息；读取端点仅回环 + 仅 .png） */}
      {shot?.ok && (
        <div className="panel browser-shot">
          <div className="browser-shot-head">
            <span className="chip badge-ok">{shotResultText(shot)}</span>
            <a className="btn small" href={webShotUrl(shot.scope, shot.file)} target="_blank" rel="noopener noreferrer">↗ 新窗口打开</a>
          </div>
          <img className="browser-shot-img" src={webShotUrl(shot.scope, shot.file)} alt="页面截图" />
        </div>
      )}

      {/* P2-8①：空间级抓取历史（team-hub 持久化；与本地地址栏历史互补） */}
      {scope && (
        <div className="panel browser-scoped">
          <div className="browser-scoped-head">
            <span className="tag">🗂 本空间抓取历史</span>
            <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>{scoped?.ok === false ? (scoped.error ?? '历史不可用') : historyStatsText(scoped?.stats)}</span>
            <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => setShowScoped(v => !v)}>{showScoped ? '收起' : '展开'}</button>
            <button
              className="btn small"
              disabled={!scoped?.items?.length}
              onClick={() => { if (window.confirm('清空本空间的全部抓取历史？')) void clearScoped() }}
            >清空</button>
          </div>
          {showScoped && scoped?.items && scoped.items.length > 0 && (
            <div className="browser-scoped-list">
              {scoped.items.map(it => {
                const v = historyItemView(it)
                return (
                  <div key={it.id} className={'browser-scoped-item tone-' + v.tone}>
                    <button className="browser-scoped-link" title={it.url} onClick={() => void fetchUrl(it.url)}>{v.title}</button>
                    <span className="browser-scoped-meta" title={v.meta}>{v.meta}</span>
                    <span className="browser-scoped-meta">{relativeTime(it.updatedAt)}</span>
                    <button className="btn small" title="删除该条记录" onClick={() => void clearScoped(it.id)}>✕</button>
                  </div>
                )
              })}
            </div>
          )}
          {showScoped && scoped?.ok === false && (
            <div className="browser-scoped-err">{scoped.error ?? '抓取历史不可用'}</div>
          )}
        </div>
      )}
    </div>
  )
}
