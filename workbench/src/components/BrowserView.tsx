import { useCallback, useEffect, useState } from 'react'
import { webFetchPage } from '../api'
import type { WebFetchResult } from '../types'
import { toast } from './Toast'

const HISTORY_KEY = 'legion.browser.history'
const MAX_HISTORY = 8

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

/** 无 scheme 输入归一：example.com → https://example.com（TC-S7-08①）；明显非法 → null。 */
function normalizeUrl(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (/^(https?:|ftp:|file:|data:|javascript:)/i.test(s)) return s
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)([:/]|$)/.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?($|\/)/.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?($|\/)/.test(s)) {
    return 'https://' + s
  }
  return null
}

/** S7 AC3：服务端 webFetch 错误码 → 界面文案映射（TC-S7-04/05 要求各错误可区分、不混淆）。 */
function errorText(r: WebFetchResult): string {
  const code = r.code ?? ''
  if (code === 'ssrf_blocked') return '🛡 已拦截：禁止访问内网地址（SSRF 防护）'
  if (code === 'protocol_blocked') return '🛡 协议白名单外：' + (r.error ?? code)
  if (code === 'timeout') return '⏱ 抓取超时：目标响应太慢或已断开（可重试）'
  if (code === 'too_large') return '📦 页面过大：' + (r.error ?? '超过大小上限')
  if (code === 'too_many_redirects') return '🔁 重定向次数过多：' + (r.error ?? '目标页跳转超过上限，已停止')
  if (code === 'web_error') return '🔌 请求失败：' + (r.error ?? '未知错误')
  if (code === 'dns_error') return '🌐 域名解析失败：' + (r.error ?? '')
  if (code === 'invalid_url') return '⚠ URL 无效：' + (r.error ?? '')
  if (code === 'fetch_error') return '🔌 网络错误：' + (r.error ?? '') + '（请确认 serve.mjs 与目标可达）'
  if (code && code.startsWith('http_')) return '⚠ 目标返回错误：' + (r.error ?? code)
  if (code === 'unsupported') return '📄 目标不是可读网页（pdf/图片/压缩包等），仅显示结构化信息'
  if (code === 'empty_content') return '🧩 页面为 SPA/纯 JS 渲染，服务端无法抽取正文（v1 边界）'
  return r.error ?? '抓取失败，请重试'
}

/** S7 AC5 请求态 / AC3 错误呈现：判定该结果是否按「错误」视图渲染（否则按正文渲染）。
 *  基线 BrowserPanel 的 errFlag 漏列 too_many_redirects/web_error，此类非 2xx 结果会落入正文分支；S7 收口修正。 */
function isErrorResult(r: WebFetchResult): boolean {
  const code = r.code ?? ''
  if (!r.ok && !code) return true
  if (code.startsWith('http_')) return true
  return code === 'ssrf_blocked' || code === 'protocol_blocked' || code === 'timeout' || code === 'too_large'
    || code === 'too_many_redirects' || code === 'web_error' || code === 'dns_error' || code === 'invalid_url'
    || code === 'fetch_error'
}

export function BrowserView(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [history, setHistory] = useState<string[]>(() => loadHistory())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<WebFetchResult | null>(null)
  const [statusText, setStatusText] = useState('')
  const [lastUrl, setLastUrl] = useState('')

  useEffect(() => {
    const el = document.getElementById('browser-url-input') as HTMLInputElement | null
    el?.focus() // TC-S7-06：进入面板即聚焦地址栏
  }, [])

  const fetchUrl = useCallback(async (raw: string): Promise<void> => {
    const norm = normalizeUrl(raw)
    if (norm === null) {
      toast('err', 'URL 无法解析：请检查格式（例：https://example.com）')
      return
    }
    setUrl(norm)
    setBusy(true)
    setStatusText('⏳ 正在抓取…')
    try {
      const res = await webFetchPage({ url: norm })
      setResult(res)
      setLastUrl(norm)
      setStatusText('')
      if (res.ok && res.code) {
        toast('info', res.code === 'empty_content' ? '已抓取，但页面无可抽取正文' : errorText(res))
      } else if (!res.ok) {
        toast('err', errorText(res))
      }
      if (res.ok) pushHistory(norm)
      setHistory(loadHistory())
    } catch (e) {
      setResult(null)
      setStatusText('')
      toast('err', '浏览器助手请求失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [])

  const submit = (): void => {
    if (!url.trim()) { toast('err', '请输入要浏览的网址'); return }
    void fetchUrl(url)
  }

  const code = result?.code ?? ''
  const errFlag = result ? isErrorResult(result) : false

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

      {busy && <div className="panel browser-loading">⏳ 正在连接并解析目标页…</div>}
      {statusText && !busy && <div className="panel browser-loading">{statusText}</div>}

      {result && (
        <div className="panel browser-result">
          <div className="browser-meta">
            <span className="chip">{result.status ?? '?'}</span>
            <span className="chip">{result.contentType?.split(';')[0] ?? ''}</span>
            <span className="chip" title={result.finalUrl}>{shortUrl(result.finalUrl ?? lastUrl)}</span>
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
    </div>
  )
}

function shortUrl(u: string): string {
  try { const x = new URL(u); return x.host + x.pathname.slice(0, 40) } catch { return u.slice(0, 60) }
}
