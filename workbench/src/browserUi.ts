/**
 * 浏览器助手（P2-8）的**纯判定层**：不碰 DOM、不碰网络，只做判定与文案。
 *
 * 为什么单独成模块：错误码文案、缓存/质量徽标、配额读数、截图可用性、历史条目呈现
 * 这些判断最容易出现「后端加了码、前端还是笼统提示」，抽出来后可用 node --test 直接钉住。
 * 组件只负责渲染返回值（**每个导出都有生产调用点**，不做「测试绿但线上未用」的假接线）。
 *
 * 权威在后端：错误码、配额限额、截图可用性状态全部来自 serve.mjs /api/web/*。
 */
import type { WebFetchResult, WebHistoryItem, WebHistoryStats, WebQuotaSnapshot, WebShotStatus, WebExtractQuality } from './types.ts'
import { sizeText } from './filesUi.ts'

// ───────────────────────── 输入归一与错误呈现（自 BrowserView 迁出，便于单测）─────────────────────────

/** 无 scheme 输入归一：example.com → https://example.com（TC-S7-08①）；明显非法 → null。 */
export function normalizeUrl(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (/^(https?:|ftp:|file:|data:|javascript:)/i.test(s)) return s
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)([:/]|$)/.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?($|\/)/.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?($|\/)/.test(s)) {
    return 'https://' + s
  }
  return null
}

/** 限流等待文案（后端给出秒数；缺失时不臆造具体时长）。 */
export function retryAfterText(sec?: number | null): string {
  if (!Number.isFinite(Number(sec)) || Number(sec) <= 0) return '请稍后重试'
  const s = Math.ceil(Number(sec))
  if (s < 60) return `约 ${s} 秒后可重试`
  return `约 ${Math.ceil(s / 60)} 分钟后可重试`
}

/**
 * S7 AC3 + P2-8：服务端 webFetch 错误码 → 界面文案映射（各错误可区分、不混淆）。
 * P2-8 新增限流三态与截图四态：都要给出**可行动**指引，而不是「失败了」。
 */
export function errorText(r: { code?: string; error?: string; retryAfterSec?: number }): string {
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
  // P2-8④ 限流与配额：区分三种成因，各自给可行动指引
  if (code === 'rate_limited') return '🚦 抓取过于频繁：' + (r.error ?? '已触发每分钟限流') + `（${retryAfterText(r.retryAfterSec)}）`
  if (code === 'concurrency_limited') return '⏳ 同时进行的抓取太多：' + (r.error ?? '请等前一个抓取结束') + `（${retryAfterText(r.retryAfterSec)}）`
  if (code === 'daily_quota_exceeded') return '📊 今日抓取流量已用完：' + (r.error ?? '明日自动重置')
  // P2-8③ 截图：三态都可行动
  if (code === 'shot_disabled') return '📷 截图未启用：' + (r.error ?? '需以 DSH_WEB_SHOT_ENABLE=1 启动 serve.mjs')
  if (code === 'shot_unavailable') return '📷 截图不可用：' + (r.error ?? '未找到 Edge/Chrome')
  if (code === 'shot_busy') return '📷 截图忙碌：' + (r.error ?? '请稍后重试')
  if (code === 'shot_failed') return '📷 截图失败：' + (r.error ?? '浏览器未产出图片')
  return r.error ?? '抓取失败，请重试'
}

/** S7 AC5 请求态 / AC3 错误呈现：判定该结果是否按「错误」视图渲染（否则按正文渲染）。 */
export function isErrorResult(r: WebFetchResult): boolean {
  const code = r.code ?? ''
  if (!r.ok && !code) return true
  if (code.startsWith('http_')) return true
  return code === 'ssrf_blocked' || code === 'protocol_blocked' || code === 'timeout' || code === 'too_large'
    || code === 'too_many_redirects' || code === 'web_error' || code === 'dns_error' || code === 'invalid_url'
    || code === 'fetch_error' || code === 'rate_limited' || code === 'concurrency_limited' || code === 'daily_quota_exceeded'
}

// ───────────────────────── ① 缓存与正文质量徽标 ─────────────────────────

export interface Badge { label: string; tone: 'ok' | 'info' | 'warn' | 'muted'; title: string }

/** 缓存状态徽标：命中 / 条件请求复用 / 实时抓取（把「为什么这么快」说清楚，避免用户以为抓取没生效）。 */
export function cacheBadge(r: { cached?: boolean; revalidated?: boolean; cacheAgeMs?: number }): Badge {
  if (r.revalidated) return { label: '缓存已确认未变', tone: 'ok', title: '带 ETag/Last-Modified 重新验证，目标返回 304 → 复用缓存内容，未重新传输正文' }
  if (r.cached) return { label: `缓存命中${Number.isFinite(Number(r.cacheAgeMs)) ? '（' + relativeAge(Number(r.cacheAgeMs)) + '前）' : ''}`, tone: 'info', title: '同一空间内该地址在缓存有效期内，未重新请求目标站点' }
  return { label: '实时抓取', tone: 'muted', title: '本次为真实网络请求' }
}

function relativeAge(ms: number): string {
  if (ms < 60_000) return Math.max(1, Math.round(ms / 1000)) + ' 秒'
  return Math.round(ms / 60_000) + ' 分钟'
}

/** 抽取质量徽标：把「抽得怎么样」明示（策略/字数/标题数/剔除块数/链接密度），而非让用户猜。 */
export function qualityBadges(q?: WebExtractQuality): Badge[] {
  if (!q) return []
  const strategyText: Record<string, string> = {
    article: '正文容器（article）', main: '主内容区（main）', density: '密度评分容器', 'body-fallback': '整页回退',
  }
  const out: Badge[] = [
    { label: '抽取：' + (strategyText[q.strategy] ?? q.strategy), tone: q.strategy === 'body-fallback' ? 'warn' : 'info', title: '服务端选中的正文容器策略' },
    { label: `${q.chars} 字`, tone: 'muted', title: '抽取后的正文长度' },
  ]
  if (q.headings > 0) out.push({ label: `标题 ${q.headings}`, tone: 'muted', title: '保留的标题层级数（已转 Markdown # 前缀）' })
  if (q.listItems > 0) out.push({ label: `列表 ${q.listItems}`, tone: 'muted', title: '保留的列表项数' })
  if (q.droppedBlocks > 0) out.push({ label: `剔除样板 ${q.droppedBlocks}`, tone: 'muted', title: '被剔除的导航/页脚/表单等样板块数量' })
  if (q.linkDensity >= 0.5) out.push({ label: '链接密度偏高', tone: 'warn', title: '链接文本占比 ' + Math.round(q.linkDensity * 100) + '%：该页可能是目录/列表页，正文可能不完整' })
  if (q.truncated) out.push({ label: '正文已截断', tone: 'warn', title: '正文超过服务端上限已截断' })
  if (q.markdown) out.push({ label: '含结构化标记', tone: 'ok', title: '正文含标题/列表/代码块等 Markdown 结构信号' })
  return out
}

// ───────────────────────── ④ 配额读数 ─────────────────────────

/** 配额读数：剩余 RPM / 在途并发 / 今日字节；界面据此在接近上限时提前提示。 */
export function quotaText(s?: WebQuotaSnapshot | null): string {
  if (!s) return '配额不可用（需 serve.mjs 与空间绑定）'
  const b = s.dailyBytes
  return `本分钟 ${s.rpm.remaining}/${s.rpm.limit} 次 · 进行中 ${s.concurrency.inflight}/${s.concurrency.limit} · 今日 ${sizeText(b.used)}/${sizeText(b.limit)}`
}

/** 配额紧张度：用于把读数染成提醒色（<20% 剩余或并发占满 → 警告）。 */
export function quotaTone(s?: WebQuotaSnapshot | null): 'ok' | 'warn' | 'danger' | 'muted' {
  if (!s) return 'muted'
  if (s.concurrency.inflight >= s.concurrency.limit) return 'danger'
  if (s.dailyBytes.remaining <= 0) return 'danger'
  const rpmRatio = s.rpm.limit > 0 ? s.rpm.remaining / s.rpm.limit : 1
  const byteRatio = s.dailyBytes.limit > 0 ? s.dailyBytes.remaining / s.dailyBytes.limit : 1
  if (rpmRatio < 0.2 || byteRatio < 0.2) return 'warn'
  return 'ok'
}

// ───────────────────────── ① 抓取历史条目 ─────────────────────────

/** 历史条目文案：标题缺失时退回 URL；失败条目显示错误短码（历史里保留失败也是信息）。 */
export function historyItemView(it: WebHistoryItem): { title: string; subtitle: string; tone: 'ok' | 'err'; meta: string } {
  const title = (it.title && it.title.trim()) || shortUrlText(it.url)
  const bits: string[] = []
  if (typeof it.status === 'number') bits.push(String(it.status))
  if (it.cached) bits.push('缓存')
  if (typeof it.bytes === 'number' && it.bytes > 0) bits.push(sizeText(it.bytes))
  if (typeof it.ms === 'number') bits.push(it.ms + 'ms')
  if (it.hits > 1) bits.push(`抓过 ${it.hits} 次`)
  return {
    title,
    subtitle: it.excerpt?.trim() || shortUrlText(it.url),
    tone: it.errorCode ? 'err' : 'ok',
    meta: it.errorCode ? `${it.errorCode}${bits.length ? ' · ' + bits.join(' · ') : ''}` : bits.join(' · '),
  }
}

/** 历史统计文案（空历史也要有明确文案，不显示空白区）。 */
export function historyStatsText(stats?: WebHistoryStats | null): string {
  if (!stats || stats.total === 0) return '本空间还没有抓取记录'
  const bits = [`共 ${stats.total} 个地址`]
  if (stats.failed > 0) bits.push(`失败 ${stats.failed}`)
  if (stats.bytes > 0) bits.push(`累计 ${sizeText(stats.bytes)}`)
  return bits.join(' · ')
}

/** 相对时间（历史列表用；now 可注入便于单测）。 */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const d = now - t
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前'
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前'
  return Math.floor(d / 86_400_000) + ' 天前'
}

export function shortUrlText(u: string): string {
  try { const x = new URL(u); return x.host + (x.pathname === '/' ? '' : x.pathname.slice(0, 40)) } catch { return String(u).slice(0, 60) }
}

// ───────────────────────── ③ 截图能力状态 ─────────────────────────

/** 截图按钮文案与可用性：未启用/未找到浏览器时按钮禁用并说明原因（不让人点了才知道）。 */
export function shotButtonView(st?: WebShotStatus | null): { label: string; disabled: boolean; hint: string; tone: 'ok' | 'warn' | 'muted' } {
  if (!st) return { label: '📷 截图', disabled: true, hint: '截图能力状态未知（serve.mjs 未响应 /api/web/meta）', tone: 'muted' }
  if (!st.enabled) return { label: '📷 截图（未启用）', disabled: true, hint: st.hint || '需以 DSH_WEB_SHOT_ENABLE=1 启动 serve.mjs', tone: 'muted' }
  if (!st.available) return { label: '📷 截图（无浏览器）', disabled: true, hint: st.hint || '未找到 Edge/Chrome', tone: 'warn' }
  return { label: '📷 截图', disabled: false, hint: `将用本机 ${st.browser ?? '浏览器'} 以 headless 方式截图（会真实启动浏览器进程）`, tone: 'ok' }
}

/** 截图能力状态一句话（面板头部展示）。 */
export function shotStatusText(st?: WebShotStatus | null): string {
  if (!st) return '截图状态未知'
  if (!st.enabled) return '截图：未启用（默认关闭）'
  if (!st.available) return '截图：已开启但未找到浏览器'
  return `截图：可用（${st.browser}）`
}

/** 截图结果文案（含文件与大小）。 */
export function shotResultText(r: { bytes?: number; browser?: string; ms?: number }): string {
  const bits = [sizeText(r.bytes ?? 0)]
  if (r.browser) bits.push(r.browser)
  if (Number.isFinite(Number(r.ms))) bits.push(r.ms + 'ms')
  return '已截图 · ' + bits.join(' · ')
}
