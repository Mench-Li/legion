// scripts/qa/mobile-logged-in-check.mjs
// ============================================================================
// **登录之后**的活体检查：接口说有任务，界面就必须把任务画出来。
//
// 与 `mobile-live-check.mjs` 的关系：那一条**从不登录**（它只看登录屏、静态模块、
// Service Worker 的形状），所以它能 40 条全绿 —— 而手机端的「任务」页签**一张卡
// 都画不出来**，用户看到的是「这个空间还没有任务」。
//
// ★★★ 这条检查是 2026-10-14 一次真实事故换来的：
//
//   `taskCard` 的形参曾经叫 `t`，而 `t` 是模块里的 i18n 翻译函数。于是
//   `t(taskLine(t))` 变成**把任务对象当函数调用** ⇒ `TypeError: t is not a function`
//   ⇒ `renderBoard` 整个中断 ⇒ 看板永远停在空态。这个 bug 从 2026-10-06
//   （`3244deb9`）活到 2026-10-14，**8 天**，期间：
//     · 单元判据全绿（它们测的是**投影层** `taskLine` / `taskMeta` / `boardColumns`）；
//     · `mobile-live-check` 40 条全绿（它不登录）；
//     · 界面上什么都不说，错误只在 console 里。
//
//   修好之后同一条走查在同一位置读到 **14 张任务卡**（修之前是 0）。
//
// ## 它盯的核心判据
//
//   **`/api/board` 说有 N 条任务 ⟺ 页面上有 N 个 `.task` 元素。**
//
// 这一条恰好是"接口对了、渲染死了"唯一藏不住的地方 —— 只看接口会绿，
// 只看页面会以为"本来就没任务"。
//
//   > 一个"接口有数据"的读数，与一个"界面画出来了"的读数，
//   > 在只看其中一个的时候都像"一切正常" ——
//   > 只不过前者在渲染挂掉时照样绿。
//
// ## 用法与退出码
//
//   LEGION_PROBE_USER=<用户名> LEGION_PROBE_PASS=<口令> \
//     node scripts/qa/mobile-logged-in-check.mjs [--url <手机端地址>]
//
//   0 = 通过    1 = 有 FAIL    2 = 跳过（没有浏览器 / 没给凭证）
//
// ★ 凭证要用**一次性探针账号**，不要用真实账号：这条检查会登录、会读看板。
//   建与删的做法见 `docs/DEPLOY.md` §19.3（建完记得删干净 —— 它落在
//   `hub_users` / `hub_space_roles` / `hub_registrations` / `hub_user_sessions` /
//   `hub_event_tickets` / `audit` 六处）。
// ============================================================================
import { launchBrowser, browserProbe } from '../e2e/cdp.mjs'

const args = new Map()
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1])
}
const URL_UNDER_TEST = args.get('url') ?? 'https://legion-si.online/mobile/'
const USER = args.get('user') ?? process.env.LEGION_PROBE_USER ?? null
const PASS = args.get('pass') ?? process.env.LEGION_PROBE_PASS ?? null

if (!browserProbe()) {
  console.log('  [skip] 本机没有 Edge/Chrome；可用 DSH_E2E_BROWSER=<路径> 指定。')
  process.exit(2)
}
if (USER === null || PASS === null) {
  console.log('  [skip] 没给探针凭证。用法：')
  console.log('    LEGION_PROBE_USER=<用户> LEGION_PROBE_PASS=<口令> node scripts/qa/mobile-logged-in-check.mjs')
  console.log('  ★ 用**一次性探针账号**，别用真实账号（这条检查会登录、会读看板）。')
  process.exit(2)
}

const browser = await launchBrowser({ mobile: true, headless: true })
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failed += 1
}

try {
  const page = await browser.newPage()
  const consoleMsgs = []
  const api = []
  page.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleMsgs.push('console.error: ' + (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200))
  })
  page.on('Runtime.exceptionThrown', (p) => {
    consoleMsgs.push('exception: ' + String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).slice(0, 200))
  })
  page.on('Network.responseReceived', (p) => { if (/\/api\//.test(p.response.url)) api.push(p.response.status) })
  await page.send('Runtime.enable').catch(() => {})
  await page.send('Network.enable').catch(() => {})

  await page.goto(URL_UNDER_TEST, { timeoutMs: 45000 })
  await page.waitFor(() => document.body?.dataset.screen === 'login', { timeoutMs: 20000, label: '登录屏' })
    .catch(() => {})

  await page.fill('#login-name', USER)
  await page.fill('#login-password', PASS)
  await page.click('#btn-login')

  let inApp = true
  try {
    await page.waitFor(() => document.body?.dataset.screen === 'app', { timeoutMs: 25000, label: '主界面' })
  } catch { inApp = false }
  check('登录后进入主界面', inApp, inApp ? '' : '停在登录屏（看下面 console 与接口读数）')
  await new Promise((r) => setTimeout(r, 2500))

  if (inApp) {
    // ★ 核心判据：接口说有 N 条 ⟺ 页面画了 N 张卡。
    //   令牌住在 `sessionStorage['legion.mobile.access']`（见 app.mjs 的 SS_ACCESS），
    //   所以这里用**页面自己的凭证**去问同一个接口 —— 与界面看到的是同一份数据。
    const probe = await page.evaluate(async () => {
      const token = sessionStorage.getItem('legion.mobile.access')
      const domCards = document.querySelectorAll('.task').length
      if (token === null) return { error: '会话里没有 access 令牌（键 legion.mobile.access）', domCards }
      const r = await fetch('/api/board?scope=default&compact=1', { headers: { authorization: 'Bearer ' + token } })
      let n = null
      try {
        const j = await r.json()
        n = Array.isArray(j) ? j.length : (Array.isArray(j?.tasks) ? j.tasks.length : null)
      } catch { /* 非 JSON */ }
      return {
        status: r.status, apiTasks: n, domCards,
        activeView: document.querySelector('#board-views button[aria-selected="true"]')?.textContent ?? null,
        views: [...document.querySelectorAll('#board-views button')].map((b) => b.textContent),
        bodyText: document.body.innerText.slice(0, 300),
      }
    })

    if (probe.error) {
      check('读到会话令牌', false, probe.error)
    } else {
      console.log(`  [读数] /api/board 状态=${probe.status}  任务数=${probe.apiTasks}  页面上的 .task=${probe.domCards}  当前视图=${probe.activeView}`)
      check('看板接口可读', probe.status === 200, 'HTTP ' + probe.status)
      check('接口返回的任务数与页面画出的卡片数一致',
        probe.apiTasks !== null && probe.apiTasks === probe.domCards,
        `接口 ${probe.apiTasks} vs 页面 ${probe.domCards}`
        + (probe.apiTasks > 0 && probe.domCards === 0
          ? '  ← 接口有任务而页面一张都没画（正是 2026-10-14 那个 bug 的形状：界面上只说"还没有任务"）'
          : ''))
      // 有任务时，页面上**不该**出现"空态"那句话。
      if (probe.apiTasks > 0) {
        check('有任务时页面上不出现空态文案 `这个空间还没有任务`',
          !String(probe.bodyText).includes('这个空间还没有任务'),
          '出现就说明渲染中断了、停在空态')
      }
    }

    const tasks = await page.evaluate(() => document.querySelectorAll('.task').length)
    check('至少画出一张任务卡（这个空间有任务）', tasks > 0, '画出 ' + tasks + ' 张')
  }

  const errs = [...new Set(consoleMsgs)]
  check('登录后没有 console 错误 / 未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '))
  const bad = api.filter((s) => s >= 400)
  check('登录后没有 4xx/5xx 接口响应', bad.length === 0, bad.length ? bad.join(',') : '')

  // 登出：应当回到登录屏（不是停在启动屏说"Hub 不可达"）。
  if (inApp) {
    await page.click('#btn-logout').catch(() => {})
    await new Promise((r) => setTimeout(r, 5000))
    const screen = await page.evaluate(() => document.body?.dataset.screen ?? '(body 不存在)')
    check('登出后回到登录屏', screen === 'login', 'data-screen=' + screen)
  }

  console.log(`\n  url: ${URL_UNDER_TEST}`)
  console.log(`  用户: ${USER}`)
} finally {
  await browser.close?.()
}

console.log(`  ${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
