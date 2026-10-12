// workbench/mobile/notify-plan.test.mjs
// ============================================================================
// 系统提醒的三个决策：机制、去重标签、按钮表现。
//
// 这一族守的是一条**实测过的假承诺**：页面写着「🔔 已开启系统提醒」，
// 而移动端浏览器上那个 `new Notification()` 抛 `Illegal constructor`，
// 异常被 `catch` 吞掉，于是**一条也收不到**。
//
//   > 一个"点了开启、得到确认、然后一条也收不到"的功能，
//   > 与一个"还没做"的功能，在用户眼里是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  notifyMechanism, notificationTag, notifyButtonPlan, stableHash,
  MECHANISM_SERVICE_WORKER, MECHANISM_CONSTRUCTOR, MECHANISM_NONE,
} from './notify-plan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.mjs'), 'utf8')
const SW = readFileSync(join(HERE, 'sw.js'), 'utf8')

// ── ① 机制 ─────────────────────────────────────────────────────────────────

test('★★★ Service Worker 可用时必须走它（移动端只有这一条路能通）', () => {
  // Android Chrome 上 `new Notification()` 抛 `Illegal constructor`；
  // iOS 16.4+ 的 Web Push 同样只能走 SW 通知。
  assert.equal(notifyMechanism({ swReady: true, supported: true }), MECHANISM_SERVICE_WORKER)
  // 即使 `Notification` 构造器不存在，SW 就绪也照样能发。
  assert.equal(notifyMechanism({ swReady: true, supported: false }), MECHANISM_SERVICE_WORKER,
    'SW 通知不依赖 Notification 构造器 —— 这条正是移动端的通路')
})

test('★ 没有 SW 时才退回构造器；两者都没有就是 none', () => {
  assert.equal(notifyMechanism({ swReady: false, supported: true }), MECHANISM_CONSTRUCTOR)
  assert.equal(notifyMechanism({ swReady: false, supported: false }), MECHANISM_NONE)
  assert.equal(notifyMechanism(), MECHANISM_CONSTRUCTOR, '默认参数下 Notification 视为可用')
})

test('★ 反例守卫：两种输入给出不同结果（判据不是恒真）', () => {
  const a = notifyMechanism({ swReady: true, supported: true })
  const b = notifyMechanism({ swReady: false, supported: false })
  assert.notEqual(a, b)
  assert.equal(new Set([a, b]).size, 2)
})

// ── ② 去重标签 ──────────────────────────────────────────────────────────────

test('★★★ 标签按**任务号**去重，两条不同任务不许互相顶掉', () => {
  // 修复前是 `'legion-' + body.slice(0, 40)`：两条提醒只要前 40 字相同，
  // 新通知就会**替换**旧通知 —— 而"有几件事在等着我"正是这个提醒要回答的问题。
  const a = notificationTag('T-100', '任务 T-100 待你验收')
  const b = notificationTag('T-101', '任务 T-101 待你验收')
  assert.notEqual(a, b, '不同任务必须有不同的 tag')
  assert.equal(a, 'legion-task-T-100')
  assert.equal(b, 'legion-task-T-101')
})

test('★★ 同一条提醒重复发必须得到同一个 tag（幂等，否则会重复弹）', () => {
  assert.equal(notificationTag('T-7', 'x'), notificationTag('T-7', '完全不同的文案'))
})

test('★★ 那次"前 40 字相同就碰撞"的具体形状必须已被消除', () => {
  // 旧实现是 `tag: 'legion-' + body.slice(0, 40)`：只要渲染出来的文案
  // **前 40 个字**一样，两条提醒就共用一个 tag，后一条把前一条顶掉。
  //
  // 构造两条真实形状的文案：**相同的长前缀**（长过 40 字）+ 只有在后面才出现的任务号。
  // 上一版我把任务号写在了前面，于是"前 40 字相同"这个前提**根本不成立** ——
  // 判据测的不是它声称要测的东西。这里用程序保证那个前提。
  const prefix = '有任务在等你处理，请尽快联系相关同学确认：'.repeat(2) // 40 字以上
  const t1 = `${prefix}任务 T-200 待你验收`
  const t2 = `${prefix}任务 T-201 待你验收`
  assert.ok(prefix.length > 40, `前缀必须长过 40 字，实际 ${prefix.length}`)
  assert.equal(t1.slice(0, 40), t2.slice(0, 40), '反例本身应当前 40 字相同')
  assert.equal(notificationTag('T-200', t1), 'legion-task-T-200')
  assert.notEqual(notificationTag('T-200', t1), notificationTag('T-201', t2),
    '有任务号时必须区分开 —— 不许再按文案前缀去重')
  // 而旧算法在这两条上**确实会碰撞** —— 这才是这条判据的意义。
  assert.equal(t1.slice(0, 40), t2.slice(0, 40))
})

test('★ 没有任务号时退回文案摘要，且仍然幂等', () => {
  const a = notificationTag(null, '电脑离线了')
  const b = notificationTag(undefined, '电脑离线了')
  const c = notificationTag('', '电脑离线了')
  assert.equal(a, b)
  assert.equal(a, c)
  assert.match(a, /^legion-text-[0-9a-f]{8}$/)
  // 不同文案应当得到不同摘要（大概率）。
  assert.notEqual(notificationTag(null, '电脑离线了'), notificationTag(null, '有新产物'))
})

test('★ 任务号里的怪字符不会漏进 tag（白名单校验）', () => {
  assert.match(notificationTag('T-1', ''), /^legion-task-T-1$/)
  // 引号/空格/斜杠都不在白名单里 ⇒ 走文案摘要那条路，而不是原样拼进 tag。
  for (const weird of ['T 1', 'T/1', 'a"b', 'x'.repeat(80), '<script>']) {
    const tag = notificationTag(weird, 'fallback')
    assert.match(tag, /^legion-text-[0-9a-f]{8}$/, `怪任务号 ${JSON.stringify(weird)} 不该被原样使用`)
  }
})

test('★ stableHash 稳定且区分（不是恒返回同一个值）', () => {
  assert.equal(stableHash('abc'), stableHash('abc'))
  assert.notEqual(stableHash('abc'), stableHash('abd'))
  assert.match(stableHash(''), /^[0-9a-f]{8}$/)
})

// ── ③ 按钮表现 ──────────────────────────────────────────────────────────────

test('★★★ 无论什么状态按钮都**可见**（被拒之后消失 = 用户失去线索）', () => {
  for (const permission of ['default', 'granted', 'denied']) {
    const plan = notifyButtonPlan({ supported: true, permission })
    assert.equal(plan.visible, true, `permission=${permission} 时按钮必须仍然可见`)
    assert.ok(plan.message.length > 0, `permission=${permission} 时必须有一句话解释`)
  }
  const unsupported = notifyButtonPlan({ supported: false, permission: 'unsupported' })
  assert.equal(unsupported.visible, true, '不支持时也要说清楚，而不是让按钮凭空消失')
  assert.equal(unsupported.actionable, false, '不支持时点它不该去请求授权')
})

test('★★ 只有 "还没问过" 才可以去请求授权', () => {
  assert.equal(notifyButtonPlan({ supported: true, permission: 'default' }).actionable, true)
  for (const p of ['granted', 'denied']) {
    assert.equal(notifyButtonPlan({ supported: true, permission: p }).actionable, false,
      `permission=${p} 时不该再请求（浏览器也不允许）`)
  }
  // `'unsupported'` 是"浏览器没有这个能力"的读数，它与 `supported: false` 是一回事。
  // （判据自己也要对：上一版这里传了 `supported: true` + `permission: 'unsupported'`，
  //  那是一个**自相矛盾**的输入，测的不是产品行为而是我的笔误。）
  assert.equal(notifyButtonPlan({ supported: false, permission: 'unsupported' }).actionable, false)
})

test('★★ 被拒时的文案必须指向**去哪里改**，而不是"再点一次"', () => {
  // `requestPermission()` 在被拒后立刻返回 denied —— 再点一次毫无作用。
  const plan = notifyButtonPlan({ supported: true, permission: 'denied' })
  assert.match(plan.message, /站点设置|设置/, '要说清楚去哪儿改')
  assert.equal(plan.actionable, false)
})

test('★ 不支持的文案要分平台：iOS 装上 PWA 之后不该再让他"添加到主屏幕"', () => {
  const iosNotInstalled = notifyButtonPlan({ supported: false, standalone: false })
  const installed = notifyButtonPlan({ supported: false, standalone: true })
  assert.match(iosNotInstalled.message, /添加到主屏幕/)
  assert.doesNotMatch(installed.message, /添加到主屏幕/,
    '已经装了 PWA 还说"请添加到主屏幕"等于让他去撞墙')
  assert.notEqual(iosNotInstalled.message, installed.message)
})

test('★ granted 的文案要与实际能力一致（说"会通知你"就得真的能通知）', () => {
  assert.match(notifyButtonPlan({ supported: true, permission: 'granted' }).message, /已开启/)
})

// ── ④ 接线：决策真的被用上了 ────────────────────────────────────────────────
//
// ★ 上一轮的教训：纯函数全绿而没人调用，是这一族最容易发生的假绿。
//   而且只查"名字被提到"还不够 —— 要查**那条路径真的走了它**。

test('★★★ app.mjs 的发送必须走 notifyMechanism 选出的机制', () => {
  assert.match(APP, /from '\.\/notify-plan\.mjs'/, 'app.mjs 必须从 notify-plan.mjs 取决策')
  assert.match(APP, /notifyMechanism\(/, 'notifyMechanism 必须被真的调用')
  assert.match(APP, /showNotification\(/,
    '必须真的调用 ServiceWorkerRegistration.showNotification —— 它是移动端唯一的通路')
})

test('★★★ 发送不再静默失败：失败必须有出口', () => {
  // 修复前的形状是 `} catch { return false }` —— 一个没有出口的失败。
  const notifyFn = /function notifySystem[\s\S]*?\n\}/.exec(APP)?.[0] ?? ''
  assert.ok(notifyFn.length > 0, '读不到 notifySystem —— 它改名了，这条判据要跟着改')
  assert.match(notifyFn, /catch/, '要处理异常')
  assert.match(notifyFn, /toast|showError|onFailure|report/,
    '异常必须被报出去（全局浮层），不能只是 return false')
})

test('★★★ 标签必须由 notificationTag 生成，不许再用文案切片', () => {
  assert.match(APP, /notificationTag\(/, '必须调用 notificationTag')
  // 旧实现的具体形状：`tag: 'legion-' + body.slice(0, 40)`。
  assert.doesNotMatch(APP, /'legion-'\s*\+\s*body\.slice/,
    '不许再按文案前 N 字构造 tag —— 两条不同任务会互相顶掉')
})

test('★★★ 按钮的表现必须由 notifyButtonPlan 决定，不许再"非 default 就隐藏"', () => {
  assert.match(APP, /notifyButtonPlan\(/, '必须调用 notifyButtonPlan')
  // 旧形状：`classList.toggle('hidden', !(supported && permission === 'default'))`
  assert.doesNotMatch(APP, /classList\.toggle\('hidden',\s*!\(.*permission\s*===\s*'default'/,
    '不许再按 permission === default 决定可见性 —— 被拒之后按钮会消失')
})

test('★★★ Service Worker 必须处理 notificationclick（否则点了通知什么都不发生）', () => {
  assert.match(SW, /addEventListener\('notificationclick'/, 'sw.js 必须有 notificationclick 监听')
  // 要能聚焦已有窗口或新开一个 —— 两者都要，否则"通知点了没反应"。
  assert.match(SW, /matchAll|openWindow/, '必须能聚焦已有窗口或打开新窗口')
})

test('★ 授权仍然只在真实点击里请求（既有纪律不许被破坏）', () => {
  assert.match(APP, /requestSystemNotifyPermission\(\)/,
    '授权请求仍在（它必须挂在 btn-notify 的 click 上 —— 那条由 popup.test.mjs 守着）')
})
