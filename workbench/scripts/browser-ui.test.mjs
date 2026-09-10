// P2-8 浏览器助手前端纯函数（browserUi.ts）：① 缓存/质量徽标 ② 抽取质量文案 ③ 截图状态 ④ 配额读数
//
// 这一层是「后端加了码、前端还是笼统提示」的防线：每个后端错误码/状态都要有可区分的界面文案。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheBadge, errorText, historyItemView, historyStatsText, isErrorResult, normalizeUrl,
  qualityBadges, quotaText, quotaTone, relativeTime, retryAfterText, shotButtonView,
  shotResultText, shotStatusText, shortUrlText,
} from '../src/browserUi.ts'

describe('P2-8④ 限流文案（每个码都要可行动，不混淆）', () => {
  test('三种限流/配额码文案可区分，且带等待提示', () => {
    const rate = errorText({ code: 'rate_limited', error: '空间「x」每分钟抓取次数超限（30/min）', retryAfterSec: 12 })
    const conc = errorText({ code: 'concurrency_limited', error: '同时进行的抓取已达上限（3）', retryAfterSec: 2 })
    const quota = errorText({ code: 'daily_quota_exceeded', error: '今日抓取流量配额已用完（200 MB）' })
    assert.match(rate, /抓取过于频繁/)
    assert.match(rate, /约 12 秒后可重试/)
    assert.match(conc, /同时进行的抓取太多/)
    assert.match(conc, /约 2 秒后可重试/)
    assert.match(quota, /今日抓取流量已用完/)
    assert.equal(new Set([rate, conc, quota]).size, 3, '三种成因文案互不相同')
  })

  test('retryAfterText：秒/分钟换算与缺失时的兜底（不臆造时长）', () => {
    assert.equal(retryAfterText(30), '约 30 秒后可重试')
    assert.equal(retryAfterText(90), '约 2 分钟后可重试')
    assert.equal(retryAfterText(0), '请稍后重试')
    assert.equal(retryAfterText(undefined), '请稍后重试')
    assert.equal(retryAfterText(NaN), '请稍后重试')
  })

  test('限流结果按错误视图渲染（不会落进正文分支）', () => {
    assert.equal(isErrorResult({ ok: false, code: 'rate_limited' }), true)
    assert.equal(isErrorResult({ ok: false, code: 'concurrency_limited' }), true)
    assert.equal(isErrorResult({ ok: false, code: 'daily_quota_exceeded' }), true)
    assert.equal(isErrorResult({ ok: true, code: 'empty_content' }), false, 'empty_content 仍走正文分支提示')
  })

  test('既有错误码文案不回归（S7 契约）', () => {
    assert.match(errorText({ code: 'ssrf_blocked' }), /禁止访问内网地址/)
    assert.match(errorText({ code: 'timeout' }), /抓取超时/)
    assert.match(errorText({ code: 'too_many_redirects', error: '超过 5 跳' }), /重定向次数过多/)
    assert.match(errorText({ code: 'http_404', error: '上游返回 http_404' }), /目标返回错误/)
    assert.match(errorText({ code: 'empty_content' }), /SPA/)
    assert.match(errorText({ code: 'unsupported' }), /不是可读网页/)
  })
})

describe('P2-8① 缓存徽标与历史条目', () => {
  test('实时抓取 / 缓存命中（带年龄）/ 条件请求复用 三态可区分', () => {
    assert.equal(cacheBadge({}).label, '实时抓取')
    const hit = cacheBadge({ cached: true, cacheAgeMs: 45_000 })
    assert.match(hit.label, /缓存命中/)
    assert.match(hit.label, /45 秒/)
    assert.equal(hit.tone, 'info')
    const reval = cacheBadge({ cached: true, revalidated: true })
    assert.equal(reval.label, '缓存已确认未变')
    assert.equal(reval.tone, 'ok')
    assert.match(reval.title, /304/)
    // 缓存年龄缺失时不显示括号内容（不显示 undefined 秒）
    assert.ok(!cacheBadge({ cached: true }).label.includes('undefined'))
  })

  test('历史条目：标题缺失退回 URL，失败条目显示错误码，hits>1 显示抓取次数', () => {
    const base = { id: 1, scope: 's', url: 'https://example.com/a/b', finalUrl: null, host: 'example.com', title: null, excerpt: null, status: 200, bytes: 2048, ms: 120, errorCode: null, cached: false, hits: 3, createdAt: '', updatedAt: '' }
    const v = historyItemView(base)
    assert.equal(v.title, 'example.com/a/b', '标题缺失退回 URL 显示')
    assert.equal(v.tone, 'ok')
    assert.match(v.meta, /200/)
    assert.match(v.meta, /抓过 3 次/)
    assert.ok(!v.meta.includes('缓存'), '未命中缓存不显示缓存标记')
    const failed = historyItemView({ ...base, errorCode: 'timeout', status: null, bytes: null, ms: 10000, hits: 1 })
    assert.equal(failed.tone, 'err')
    assert.match(failed.meta, /timeout/)
    const withTitle = historyItemView({ ...base, title: '  标题  ', excerpt: '摘要', cached: true })
    assert.equal(withTitle.title, '标题')
    assert.equal(withTitle.subtitle, '摘要')
    assert.match(withTitle.meta, /缓存/)
  })

  test('历史统计文案：空历史有明确文案，失败与流量按需出现', () => {
    assert.equal(historyStatsText(null), '本空间还没有抓取记录')
    assert.equal(historyStatsText({ total: 0, failed: 0, bytes: 0, shown: 0 }), '本空间还没有抓取记录')
    const t = historyStatsText({ total: 5, failed: 2, bytes: 4096, shown: 5 })
    assert.match(t, /共 5 个地址/)
    assert.match(t, /失败 2/)
    assert.match(t, /4\.0 KB/)
  })

  test('relativeTime 分档（可注入 now）', () => {
    const now = Date.UTC(2025, 0, 2, 12, 0, 0)
    assert.equal(relativeTime(new Date(now - 30_000).toISOString(), now), '刚刚')
    assert.equal(relativeTime(new Date(now - 5 * 60_000).toISOString(), now), '5 分钟前')
    assert.equal(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now), '3 小时前')
    assert.equal(relativeTime(new Date(now - 2 * 86_400_000).toISOString(), now), '2 天前')
    assert.equal(relativeTime('not-a-date', now), '')
  })

  test('shortUrlText 与原组件行为一致（host + 截断 path）', () => {
    assert.equal(shortUrlText('https://example.com/a/b'), 'example.com/a/b')
    assert.equal(shortUrlText('https://example.com/'), 'example.com')
    assert.equal(shortUrlText('not a url'), 'not a url')
  })
})

describe('P2-8② 抽取质量徽标', () => {
  test('无 quality → 无徽标（老结果不显示空徽标）', () => {
    assert.deepEqual(qualityBadges(undefined), [])
  })

  test('策略中文化与字数/标题/列表/剔除样板徽标', () => {
    const badges = qualityBadges({ strategy: 'article', score: 100, chars: 880, headings: 3, paragraphs: 6, listItems: 4, linkDensity: 0.05, candidates: 2, droppedBlocks: 4, markdown: true, truncated: false })
    const labels = badges.map(b => b.label)
    assert.ok(labels.some(l => l.includes('正文容器（article）')), '策略显示为中文：' + labels.join('|'))
    assert.ok(labels.includes('880 字'))
    assert.ok(labels.includes('标题 3'))
    assert.ok(labels.includes('列表 4'))
    assert.ok(labels.includes('剔除样板 4'))
    assert.ok(labels.includes('含结构化标记'))
    assert.ok(!labels.some(l => l.includes('截断')), '未截断不显示截断徽标')
  })

  test('回退策略与高链接密度给出警告色（明示「这次抽得可能不好」）', () => {
    const badges = qualityBadges({ strategy: 'body-fallback', score: 0, chars: 120, headings: 0, paragraphs: 1, listItems: 0, linkDensity: 0.8, candidates: 0, droppedBlocks: 0, markdown: false, truncated: true })
    const fb = badges.find(b => b.label.includes('整页回退'))
    assert.equal(fb?.tone, 'warn')
    const dense = badges.find(b => b.label.includes('链接密度偏高'))
    assert.equal(dense?.tone, 'warn')
    assert.match(dense?.title ?? '', /80%/, '标题里给出具体比例')
    assert.ok(badges.some(b => b.label === '正文已截断'))
    // 未知策略不崩、原样显示
    const unknown = qualityBadges({ strategy: 'future-x', score: 0, chars: 10, headings: 0, paragraphs: 0, listItems: 0, linkDensity: 0, candidates: 0, droppedBlocks: 0, markdown: false, truncated: false })
    assert.ok(unknown.some(b => b.label.includes('future-x')))
  })
})

describe('P2-8③ 截图状态与结果', () => {
  test('未启用 / 无浏览器 / 可用 三态：按钮文案、禁用与提示', () => {
    const off = shotButtonView({ enabled: false, available: false, browser: null, dir: 'd', hint: '以 DSH_WEB_SHOT_ENABLE=1 启动 serve.mjs' })
    assert.equal(off.disabled, true)
    assert.match(off.label, /未启用/)
    assert.match(off.hint, /DSH_WEB_SHOT_ENABLE=1/)
    const nobrowser = shotButtonView({ enabled: true, available: false, browser: null, dir: 'd', hint: '未找到 Edge/Chrome；可用 DSH_WEB_SHOT_BROWSER 指定可执行文件路径' })
    assert.equal(nobrowser.disabled, true)
    assert.match(nobrowser.label, /无浏览器/)
    assert.equal(nobrowser.tone, 'warn')
    const ok = shotButtonView({ enabled: true, available: true, browser: 'msedge.exe', dir: 'd', hint: '' })
    assert.equal(ok.disabled, false)
    assert.equal(ok.label, '📷 截图')
    assert.match(ok.hint, /会真实启动浏览器进程/, '明确告知代价')
  })

  test('状态未知（serve 未响应）→ 禁用并说明', () => {
    const v = shotButtonView(null)
    assert.equal(v.disabled, true)
    assert.match(v.hint, /状态未知/)
    assert.equal(shotStatusText(null), '截图状态未知')
  })

  test('状态一句话与结果文案', () => {
    assert.equal(shotStatusText({ enabled: false, available: false, browser: null, dir: '', hint: '' }), '截图：未启用（默认关闭）')
    assert.equal(shotStatusText({ enabled: true, available: false, browser: null, dir: '', hint: '' }), '截图：已开启但未找到浏览器')
    assert.match(shotStatusText({ enabled: true, available: true, browser: 'chrome.exe', dir: '', hint: '' }), /可用（chrome\.exe）/)
    assert.match(shotResultText({ bytes: 2048, browser: 'msedge.exe', ms: 900 }), /2\.0 KB · msedge\.exe · 900ms/)
  })

  test('截图错误码 → 可行动文案', () => {
    assert.match(errorText({ code: 'shot_disabled', error: '截图能力未启用' }), /截图未启用/)
    assert.match(errorText({ code: 'shot_unavailable' }), /截图不可用/)
    assert.match(errorText({ code: 'shot_failed', error: '浏览器未产出图片' }), /截图失败.*未产出图片/)
  })
})

describe('P2-8④ 配额读数', () => {
  const snap = { scope: 's', rpm: { limit: 30, remaining: 25, resetInMs: 1000 }, concurrency: { limit: 3, inflight: 1 }, hostRpmLimit: 30, dailyBytes: { limit: 200 * 1024 * 1024, used: 10 * 1024 * 1024, remaining: 190 * 1024 * 1024, day: '2025-01-01' } }

  test('读数包含三类额度，缺数据时明说不可用', () => {
    const t = quotaText(snap)
    assert.match(t, /本分钟 25\/30 次/)
    assert.match(t, /进行中 1\/3/)
    assert.match(t, /今日 10\.0 MB\/200\.0 MB/)
    assert.match(quotaText(null), /配额不可用/)
  })

  test('紧张度：并发占满 → danger；剩余不足 20% → warn；正常 → ok', () => {
    assert.equal(quotaTone(snap), 'ok')
    assert.equal(quotaTone({ ...snap, concurrency: { limit: 3, inflight: 3 } }), 'danger')
    assert.equal(quotaTone({ ...snap, dailyBytes: { ...snap.dailyBytes, remaining: 0 } }), 'danger')
    assert.equal(quotaTone({ ...snap, rpm: { limit: 30, remaining: 3, resetInMs: 1000 } }), 'warn')
    assert.equal(quotaTone({ ...snap, dailyBytes: { ...snap.dailyBytes, remaining: 1024 } }), 'warn')
    assert.equal(quotaTone(null), 'muted')
  })
})

describe('URL 归一不回归（S7 TC-S7-08）', () => {
  test('无 scheme 补 https；非法返回 null', () => {
    assert.equal(normalizeUrl('example.com'), 'https://example.com')
    assert.equal(normalizeUrl('example.com/a?b=1'), 'https://example.com/a?b=1')
    assert.equal(normalizeUrl('localhost:5173'), 'https://localhost:5173')
    assert.equal(normalizeUrl('https://x.test'), 'https://x.test')
    assert.equal(normalizeUrl('  https://x.test  '), 'https://x.test')
    assert.equal(normalizeUrl(''), null)
    assert.equal(normalizeUrl('..'), null)
  })
})
