#!/usr/bin/env node
/**
 * s3-static-review.mjs — T-082 切片 S3 静态评审断言（TC-S3-01 / TC-S3-06 / TC-S3-08 的评审/grep 面）。
 * 只读 ChatView.tsx 与 workbench/src，按行号/文本断言守卫语义；不改任何被测代码。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const file = join(ROOT, 'workbench', 'src', 'components', 'ChatView.tsx')
const src = readFileSync(file, 'utf8').split('\n')
const at = (i) => src[i - 1] || ''
const idxOf = (text, from = 0) => { const i = src.slice(from).findIndex(l => l.includes(text)); return i < 0 ? -1 : i + from + 1 }
const results = []
function check(name, cond, extra = '') { results.push({ name, ok: !!cond }); console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')) }

// TC-S3-01/06 核心：identityStale 守卫定义
const iDef = idxOf('function identityStale(')
check('identityStale 守卫函数存在（TC-S3-01/06 判据核心）', iDef > 0, '行 ' + iDef)
check('守卫比对 (scope,convId) 二元组（跨空间撞号防护）', at(iDef + 1).includes('scopeAtCall !== scopeNow || convAtCall !== convNow'))
const iScopeRef = idxOf('const scopeRef = useRef')
const iMirror = idxOf('scopeRef.current = scope')
check('scopeRef 声明并随每次 render 同步 scope', iScopeRef > 0 && iMirror > iScopeRef, 'ref@' + iScopeRef + ' mirror@' + iMirror)

// send()：快照 < 守卫 < 清草稿/合并；finally 复位 sending；stale 时失败 toast 抑制
const iSendSnap = idxOf('const scopeAtCall = scope // 发起时身份快照（R-A5 / TC-S3-01/03/04）')
const iSendGuard = idxOf('if (identityStale(scopeAtCall, convAtCall, scopeRef.current, activeRef.current)) return', iSendSnap)
const iSetDraft = idxOf("setDraft('') // 成功后清草稿")
const iSendMerge = idxOf('setMsgs(prev => mergeById(prev, [msg]))')
const iSendSendingTrue = idxOf('setSending(true)')
const iSendSendingFalse = idxOf('setSending(false)')
const iSendToast = idxOf('发送失败：')
check('TC-S3-01 send：发起时快照先于请求标志', iSendSnap > 0 && iSendSnap < iSendSendingTrue, 'snap@' + iSendSnap)
check('TC-S3-01 send：identityStale 守卫位于清草稿/合并写回之前', iSendGuard > 0 && iSendGuard < iSetDraft && iSendGuard < iSendMerge, 'guard@' + iSendGuard + ' < setDraft@' + iSetDraft + ' < setMsgs@' + iSendMerge)
check('TC-S3-01 send：快照与守卫之间无任何 setMsgs/setDraft 写回', !src.slice(iSendSnap - 1, iSendGuard - 1).some(l => l.includes('setMsgs(') || l.includes('setDraft(')))
check('TC-S3-01 send：finally 无条件复位 sending（stale 不卡发送按钮）', iSendSendingFalse > iSendGuard, 'sending(false)@' + iSendSendingFalse)
check('TC-S3-01 send：失败 toast 仅在非 stale 时发出', src.slice(iSendToast - 4, iSendToast).join('\n').includes('!identityStale(scopeAtCall'))

// loadOlder()：快照 < 守卫 < 合并；finally 复位 loadingOlder
const iLoSnap = idxOf('const scopeAtCall = scope // 发起时身份快照（R-A5 / TC-S3-02/04）')
const iLoGuard = idxOf('if (identityStale(scopeAtCall, convAtCall, scopeRef.current, activeRef.current)) return', iLoSnap)
const iLoMerge = idxOf('setMsgs(prev => mergeById(older, prev))')
const iLoReset = idxOf('setLoadingOlder(false)')
check('TC-S3-01 loadOlder：快照 < 守卫 < 合并（stale 丢弃不写 msgs/hasOlder）', iLoSnap > 0 && iLoGuard > 0 && iLoGuard < iLoMerge, 'snap@' + iLoSnap + ' guard@' + iLoGuard + ' < merge@' + iLoMerge)
check('TC-S3-01 loadOlder：finally 复位 loadingOlder', iLoReset > iLoMerge, 'reset@' + iLoReset)
check('TC-S3-01 loadOlder：函数体内无 setDraft', !src.slice(iLoSnap - 1, iLoReset).some(l => l.includes('setDraft(')))

// TC-S3-06 mergeNewest：无参数；函数内先取快照再 await；返回后守卫再合并
const iMnDef = idxOf('const mergeNewest = useCallback(async (): Promise<void>')
const iMnSnap = idxOf('const scopeAtCall = scopeRef.current', iMnDef)
const iMnGuard = idxOf('if (identityStale(scopeAtCall, convAtCall, scopeRef.current, activeRef.current)) return', iMnSnap)
const iMnMerge = idxOf('const newer = list.filter')
check('TC-S3-06 mergeNewest：无参签名、先取 (scope,conv) 快照再 await', iMnDef > 0 && iMnSnap > iMnDef, 'def@' + iMnDef + ' snap@' + iMnSnap)
check('TC-S3-06 mergeNewest：fetch 返回后、setMsgs 前有守卫', iMnGuard > iMnSnap && iMnGuard < iMnMerge, 'guard@' + iMnGuard + ' < merge@' + iMnMerge)
const noArgCalls = src.filter(l => l.includes('void mergeNewest()')).length
check('TC-S3-06 mergeNewest：SSE/poll 调用点无参', noArgCalls >= 2 && !src.some(l => /mergeNewest\(\d/.test(l)), noArgCalls + ' 处无参调用')

// SSE 空间过滤 + 单源订阅
const iSseScope = idxOf('if (ev.scope !== scope) return')
check('TC-S3-06 SSE：按 ev.scope 过滤（只响应当前空间事件）', iSseScope > 0, '行 ' + iSseScope)
check('TC-S3-06 SSE：chat:message 且 conv==active 才 merge；15000ms 轮询兜底', src.some(l => l.includes('Number(conv) === n')) && src.some(l => l.includes('}, 15000)')))
check('TC-S3-06 单一 EventSource：ChatView 仅 1 处 subscribeHubAudit（I-8）', src.filter(l => l.includes('subscribeHubAudit(')).length === 1)

// 空间切换守卫
const scGuard = src.filter(l => l.includes('if (scopeAtCall !== scopeRef.current) return')).length
check('TC-S3-04 空间守卫：loadConvs 与 doCreate 均比对 scope 快照', scGuard >= 2, scGuard + ' 处')
check('TC-S3-04 scope 变化即清空旧空间状态（convs/msgs/activeId）', src.filter(l => l.includes('setConvs([])')).length >= 2 && src.filter(l => l.includes('setMsgs([])')).length >= 2 && src.filter(l => l.includes('setActiveId(null)')).length >= 2)

// 无残留：所有异步 setMsgs/setDraft 写回必须处于 守卫 或 effect-cancelled 保护下
const writes = []
src.forEach((l, i) => { if (l.includes('setMsgs(') || l.includes('setDraft(')) writes.push({ line: i + 1, text: l.trim() }) })
const unguarded = writes.filter(w => {
  const t = w.text
  if (t.includes('setMsgs([])')) return false
  if (t.includes('setDraft(e.target.value)')) return false // 同步输入
  const ctx = src.slice(Math.max(0, w.line - 7), w.line).join('\n')
  return !(ctx.includes('identityStale(') || ctx.includes('if (cancelled) return'))
})
check('TC-S3-01 无残留：setMsgs 异步写回均在 identityStale 或 cancelled 保护下', unguarded.length === 0, JSON.stringify(unguarded.map(w => w.line + ':' + w.text)).slice(0, 400))

// TC-S3-08 渲染安全
check('TC-S3-08 ChatView.tsx 无 dangerouslySetInnerHTML 实际使用（仅注释提及 = 0 命中）', !src.some(l => l.includes('dangerouslySetInnerHTML={')))
check('TC-S3-08 正文走 React 文本节点 {m.body}', src.some(l => l.includes('{m.body}')))
function walk(dir, out) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(tsx?|js)$/.test(e.name)) out.push(p) } return out }
const srcFiles = walk(join(ROOT, 'workbench', 'src'), [])
const hits = srcFiles.filter(p => readFileSync(p, 'utf8').includes('dangerouslySetInnerHTML={'))
check('TC-S3-08 workbench/src 全目录 0 处 dangerouslySetInnerHTML 实际使用（I-5）', hits.length === 0, hits.join(', ') || '0 命中（仅注释提及防直插纪律）')

const fails = results.filter(r => !r.ok)
console.log('\n==== S3 静态评审汇总：' + (results.length - fails.length) + '/' + results.length + ' 通过 ====')
process.exit(fails.length === 0 ? 0 : 1)
