#!/usr/bin/env node
/**
 * s7-notify-logic.mjs — 切片 S7 通知中心白名单/已读游标逻辑探针（tester T-090，只测不修）。
 *
 * 被测代码 = 真实 workbench/src/api.ts（HEAD 5813ae5）经仓库自身工具链 tsc 5.9.3 编译的 ESM
 * （编译命令见 s7-README.md；out/api.js 与源码同源，仅转译、无任何改动）。
 * 导入并实测：isNotifyAction / notifyReadSeq / setNotifyReadSeq / countNotifyUnread（NotifyView 与侧栏
 * badge 共用口径，api.ts:616-636）。localStorage 以内存 stub 注入（api.ts 只经 localStorage 读写游标，
 * TC-S7-05：已读纯本地、绝不写服务端 —— 本探针同时用 fetch 间谍断言游标操作期间零网络调用）。
 *
 * 断言对照 TEST_CASES TC-S7-02/03/04/05 的白名单与游标语义；输出 PASS/FAIL；失败退出码非 0。
 * 运行：node docs/T090-evidence/s7-notify-logic.mjs <out/api.js 绝对路径>
 */
import { readFileSync, existsSync } from 'node:fs'

const apiJs = process.argv[2]
if (!apiJs || !existsSync(apiJs)) {
  console.error('用法：node s7-notify-logic.mjs <api.js 绝对路径>（tsc 编译产物）')
  process.exit(2)
}

const results = []
const check = (name, cond, extra = '') => {
  results.push({ name, ok: !!cond })
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''))
}

// ── localStorage 内存 stub（带写日志，供「只写本 scope 游标键」断言）──
const store = new Map()
const writtenKeys = []
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); writtenKeys.push(String(k)) },
  removeItem: (k) => { store.delete(k) },
}

// ── fetch 间谍：断言已读游标路径零网络（TC-S7-05 反向：已读不写 audit）──
let fetchCalls = 0
const realFetch = globalThis.fetch
globalThis.fetch = (...args) => { fetchCalls += 1; return realFetch ? realFetch(...args) : Promise.resolve(new Response(null, { status: 404 })) }

const api = await import('file:///' + apiJs.split('\\').join('/').replace(/^([A-Za-z]):/, '$1:') + '?t=' + Date.now())
const { isNotifyAction, notifyReadSeq, setNotifyReadSeq, countNotifyUnread } = api

// ── 1) 白名单全集（TC-S7-02/03 / R-15 收窄集合）──
const EXPECTED_IN = [
  'create', 'claim', 'transition', 'advance', 'reassign', 'hold', 'unhold',
  'patch', 'evidence', 'artifact', 'review-note', 'test-report',
  'goal:publish', 'goal:slices',
  'space:create', 'space:update', 'space:delete', 'space:add-agents',
  'model:set', 'model:clear',
  'skill:submit', 'skill:review', 'skill:grant',
]
const missing = EXPECTED_IN.filter((a) => !isNotifyAction(a))
check('TC-S7-02/03 白名单正向：文档列出的任务/目标/空间/模型/技能类 action 全部入列（共 ' + EXPECTED_IN.length + ' 项）',
  missing.length === 0, missing.length ? '缺: ' + missing.join(',') : '')
const EXPECTED_OUT = [
  'chat:create', 'chat:message', 'chat:foo', 'comment', 'progress',
  'release-stale', 'exec:toggle', 'exec:request', 'calendar:create', 'calendar:delete',
  'agent:create', 'agent:update', 'web', '', null, undefined, 42, {}, [], 'transition2',
]
const leaked = EXPECTED_OUT.filter((a) => isNotifyAction(a))
check('TC-S7-03 白名单反向：chat:*（防刷屏）、comment、progress、calendar:*、exec:*、agent:*、非串/空/非字符串一律排除',
  leaked.length === 0, leaked.length ? '泄漏: ' + JSON.stringify(leaked) : '')

// ── 2) 真实审计行 → 白名单过滤 + 未读计数（TC-S7-01/02/03 口径）──
const mkRow = (seq, scope, action, taskId = null) => ({ seq, ts: '2026-09-05T08:00:00.000Z', member: 'tester-s7', scope, action, taskId, detail: {} })
const softwareRows = [
  mkRow(1, 'software', 'create', 'T-101'),
  mkRow(2, 'software', 'claim', 'T-101'),
  mkRow(3, 'software', 'chat:create'),
  mkRow(4, 'software', 'chat:message'),
  mkRow(5, 'software', 'comment', 'T-101'),
  mkRow(6, 'software', 'transition', 'T-101'),
  mkRow(7, 'software', 'goal:publish'),
  mkRow(8, 'software', 'space:create'),
  mkRow(9, 'software', 'calendar:create'),
  mkRow(10, 'software', 'model:set'),
  mkRow(11, 'software', 'review-note', 'T-101'),
  mkRow(12, 'software', 'artifact', 'T-101'),
  mkRow(13, 'software', 'progress', 'T-101'),
  mkRow(14, 'software', 'skill:submit'),
]
const notifyRows = softwareRows.filter((r) => isNotifyAction(r.action))
check('TC-S7-03 语义：chat:create/message/comment/calendar:create/progress 全被白名单过滤（原始 14 行 → 通知 9 行）',
  notifyRows.length === 9 && notifyRows.every((r) => !r.action.startsWith('chat:') && !['comment', 'calendar:create', 'progress'].includes(r.action)),
  'notifyRows=' + notifyRows.map((r) => r.action).join(','))

// ── 3) 游标语义（TC-S7-04/05）──
const fresh = () => { store.clear(); writtenKeys.length = 0 }
fresh()
check('TC-S7-04 初始：无游标 → notifyReadSeq(software)=0 且全部 9 条未读',
  notifyReadSeq('software') === 0 && countNotifyUnread(notifyRows, 'software') === 9)

// 点击一条中段未读（seq=6）→ 游标推到 6 → 未读 = seq>6 的白名单行
setNotifyReadSeq('software', 6)
check('TC-S7-04 点击已读（seq=6）→ 游标=6，badge 未读由 9 减为 6（= seq>6 的 7/8/10/11/12/14）',
  notifyReadSeq('software') === 6 && countNotifyUnread(notifyRows, 'software') === 6,
  'unread=' + countNotifyUnread(notifyRows, 'software'))
check('TC-S7-04 点击后未读高亮的行 = seq>6（isUnread 判据同 NotifyView:274）',
  notifyRows.filter((r) => r.seq > notifyReadSeq('software')).map((r) => r.seq).join(',') === '7,8,10,11,12,14')

// 刷新保持：游标存 localStorage → 重新读同一值
check('TC-S7-04 刷新保持：notifyReadSeq 再次读取 = 6（localStorage per-scope 持久）', notifyReadSeq('software') === 6)
// 单调递增：再点更旧的 seq 不回落
setNotifyReadSeq('software', 3)
check('TC-S7-04 游标单调：已读 6 后再点 seq=3 → 游标不回落到 3', notifyReadSeq('software') === 6)
// per-scope：software 已读不影响 marketing
const marketingRows = [mkRow(1, 'marketing', 'create', 'M-1'), mkRow(2, 'marketing', 'claim', 'M-1')]
check('TC-S7-04 per-scope：software 已读后 marketing 游标仍 0、marketing 未读仍 2',
  notifyReadSeq('marketing') === 0 && countNotifyUnread(marketingRows, 'marketing') === 2)
// 只写本 scope 键
check('TC-S7-04 存储键隔离：仅写 legion.notify.read.software（无 marketing 键、无其它杂键）',
  writtenKeys.length === 1 && writtenKeys[0] === 'legion.notify.read.software', writtenKeys.join(','))
// 全部已读 → badge 0
setNotifyReadSeq('software', 14)
check('TC-S7-01/04 全部已读 → 未读 0（badge 不显示）', countNotifyUnread(notifyRows, 'software') === 0)
// 损坏值兜底
store.set('legion.notify.read.software', 'abc')
check('TC-S7-04 兜底：损坏游标值 → 视为 0 不崩溃', notifyReadSeq('software') === 0)
store.delete('legion.notify.read.software')
// null scope（未选空间时不显示 badge 口径）
check('TC-S7-01 空 scope 游标键独立（__all__）不参与空间计数', notifyReadSeq(null) === 0)

// ── 4) TC-S7-05：已读操作零网络（服务端零新行的代码侧证据）──
fetchCalls = 0
fresh()
setNotifyReadSeq('software', 6)
notifyReadSeq('software')
countNotifyUnread(notifyRows, 'software')
check('TC-S7-05 代码侧：游标推进/读取/未读计数全程 0 次 fetch（无任何 mark-read 写接口被调用，api.ts 亦无此类导出）',
  fetchCalls === 0, 'fetchCalls=' + fetchCalls)

const fails = results.filter((r) => !r.ok).length
console.log('\n==== S7 逻辑探针汇总：' + (results.length - fails) + '/' + results.length + ' 断言通过 ====')
process.exit(fails > 0 ? 1 : 0)
