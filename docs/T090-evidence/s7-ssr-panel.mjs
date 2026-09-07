#!/usr/bin/env node
/**
 * s7-ssr-panel.mjs — 真实 NotifyView 组件（tsc 编译自 HEAD 源码）的 Node SSR 渲染探针。
 * 编译方法见 s7-README.md（tsc 5.9.3 + react 19.2.8，产物仅转译零改动；相对导入已补 .js 后缀）。
 * 用途：在无浏览器沙箱内获得「真实面板渲染」的可执行证据 —— 面板结构/引导文案/scope 文本 HTML 转义。
 * 用法：node s7-ssr-panel.mjs <out 目录>  （react/react-dom 经该目录上层 junction node_modules 解析）
 */
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'

const outDir = process.argv[2]
if (!outDir) { console.error('用法：node s7-ssr-panel.mjs <out目录>'); process.exit(2) }

// ── 浏览器环境 stub（api.ts 仅在调用时引用 window/localStorage；SSR 渲染 hubBase() 需要）──
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => { store.delete(k) },
}
globalThis.window = { location: { search: '' }, setInterval: () => 0, clearInterval: () => {} }
globalThis.fetch = async () => { throw new Error('SSR 不应发起网络请求') }

const { NotifyView } = await import('file:///' + outDir.split('\\').join('/').replace(/^([A-Za-z]):/, '$1:') + '/components/NotifyView.js')

const results = []
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond })
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''))
}
const props = { scope: null, hubMode: false, onUnreadChange: () => {}, onGoHome: () => {} }
const fileUrl = 'file:///' + outDir.split('\\').join('/').replace(/^([A-Za-z]):/, '$1:')

// ① 无中枢（hubMode=false）：真实面板引导（TC-S7-01「非 toast 占位」的反向锚：面板存在且有引导）
let html = renderToString(createElement(NotifyView, { ...props }))
check('SSR-① 无中枢 → 渲染真实面板引导「通知中心需要 team-hub v2（中枢）」且不抛错',
  html.includes('通知中心需要 team-hub v2') && html.includes('审计派生'), html.slice(0, 200))

// ② 有中枢但未选空间：引导（TC-S7-01/面板语义）
html = renderToString(createElement(NotifyView, { ...props, hubMode: true }))
check('SSR-② hubMode 未选空间 → 「请先选择具体工作空间」引导',
  html.includes('请先选择具体工作空间') && html.includes('通知按空间隔离'), html.slice(0, 220))

// ③ hubMode + 具体空间：面板壳（标题/scope/数据源 URL/刷新/空态文案/未读 chip）
html = renderToString(createElement(NotifyView, { ...props, hubMode: true, scope: 'software' }))
check('SSR-③ 面板壳：标题「通知中心」+ scope + audit 派生 + 数据源 team-hub(/hub)',
  html.includes('通知中心') && html.includes('software') && html.includes('audit 派生') &&
  html.includes('/hub') && html.includes('↻ 刷新') && html.includes('暂无通知') && html.includes('全部已读'),
  (html.match(/class="[^"]*"/g) || []).slice(0, 4).join(' '))

// ④ scope 恶意字符串 → React 文本节点 HTML 转义（I-5 渲染安全在本组件上的可执行锚）
const evil = '<b>软件部</b><img src=x onerror=window.__x=1>'
html = renderToString(createElement(NotifyView, { ...props, hubMode: true, scope: evil }))
check('SSR-④ 恶意 scope 文本按文本节点转义（&lt;b&gt;/&lt;img 出现、无真实 <img 元素/属性注入）',
  html.includes('&lt;b&gt;') && html.includes('&lt;img') && !/<img[^>]*onerror=/i.test(html) && (html.match(/<img\b/g) || []).length === 0,
  '转义样本出现=' + html.includes('&lt;img'))

// ⑤ 渲染面没有 dangerouslySetInnerHTML 属性出现
check('SSR-⑤ 产物 HTML 无 dangerouslySetInnerHTML 直插特征', !html.includes('dangerouslySetInnerHTML'))

const fails = results.filter((r) => !r.ok).length
console.log('\n==== S7 SSR 面板渲染汇总：' + (results.length - fails) + '/' + results.length + ' 断言通过 ====')
process.exit(fails > 0 ? 1 : 0)
