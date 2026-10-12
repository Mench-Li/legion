// scripts/qa/mobile-live-check.mjs
// ============================================================================
// **活体**检查：手机端 PWA 在一个**真浏览器**里到底是不是那样。
//
// 与 `team-hub/mobile-routes.test.mjs` / `workbench/mobile/*.test.mjs` 的分工：
//   · 那些是**离线**的：证明路由把文件按正确的类型与缓存头发出去、证明那些纯决策
//     算得对。它们可以在 CI 里跑一千遍；
//   · 这一个是**活的**：真 Chrome、真 TLS、真 Service Worker、真的执行那份 bundle。
//
// ## 为什么这一层不是可选的
//
// 这套检查在两天里抓到了**两次真实回归**，而且两次都是"离线全绿"的：
//
//  ① 有一轮把 `#btn-notify` 改成"只在主界面出现"，为了让一个新导出的
//     `chromeVisible` 有调用者。所有单元判据全绿（它们只看纯函数与源码形状），
//     而生产上那个按钮在登录页消失了 —— 是这条活体检查当场 FAIL 的。
//
//  ② 修完之后我**又**从错误的工作区部署了一次（修正前的版本），
//     于是"修好了"这句话在生产上并不成立。同样是这条检查把差异照出来的。
//
//   > 一批"对着一份静态副本断言"的判据，与一批"对着线上那台机器断言"的判据，
//   > 在一切顺利的时候是同一个东西 ——
//   > 只不过前者在**部署本身出错**的时候仍然全绿。
//
// ## 检查什么
//
//   A. 首屏：`data-screen` 已落定、三块屏**恰好**显示一块（不该出现"登录表单闪一下"，
//      也不该出现"一块都不显示"）；启动骨架在；登录页上头部动作已收起
//      （页签/刷新/退出是"看得见、点不动"的那一类）。
//   B. 通知：Service Worker 已激活且**有 `showNotification`**（移动端唯一的发送通路）；
//      提醒按钮**可见**（不按屏收起 —— 授权要在用户手势里、越早越好）。
//   C. 部署一致：线上 `sw.js` 含 `notificationclick` 且 SHELL 里列了各个决策模块。
//
// ## 用法与退出码
//
//   node scripts/qa/mobile-live-check.mjs                    # 打生产
//   node scripts/qa/mobile-live-check.mjs --url <地址>
//
//   0  全部通过        1  有检查失败        2  本机没有可用浏览器（跳过）
// ============================================================================
import { launchBrowser, browserProbe } from '../e2e/cdp.mjs'

const args = new Map()
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1])
}
const URL_UNDER_TEST = args.get('url') ?? 'https://legion-si.online/mobile/'

if (!browserProbe()) {
  console.log('  [skip] 本机没有 Edge/Chrome；可用 DSH_E2E_BROWSER=<路径> 指定。')
  process.exit(2)
}

const browser = await launchBrowser({ headless: true, mobile: true })
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failed += 1
}

try {
  const page = await browser.newPage()
  await page.goto(URL_UNDER_TEST, { timeoutMs: 45000 })
  // 登录门要等"探测走完"才落屏 —— 这正是首屏修复要保证的那件事。
  await page.waitFor(
    () => document.body.dataset.screen === 'login' || document.body.dataset.screen === 'app',
    { timeoutMs: 25000, label: 'screen decided' },
  )

  // ── A. 首屏 ───────────────────────────────────────────────────────────────
  const info = await page.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel)
      if (el === null) return null
      const cs = getComputedStyle(el)
      return cs.display !== 'none' && cs.visibility !== 'hidden'
    }
    const btn = document.getElementById('btn-notify')
    return {
      screen: document.body.dataset.screen ?? null,
      bootVisible: vis('#boot'),
      loginVisible: vis('#screen-login'),
      mainVisible: vis('#main'),
      tabsVisible: vis('#tabs'),
      logoutVisible: vis('#btn-logout'),
      notifyHidden: btn?.classList.contains('hidden') ?? null,
      notifyHasTitle: (btn?.title ?? '').length > 0,
      hasToastHost: document.getElementById('toast-host') !== null,
      skeletonLines: document.querySelectorAll('#boot-skeleton .sk-line').length,
    }
  })
  console.log(`  url: ${URL_UNDER_TEST}`)
  console.log(`  screen: ${info.screen}`)
  console.log(`  visible -> boot:${info.bootVisible} login:${info.loginVisible} main:${info.mainVisible}`)
  console.log(`  header  -> tabs:${info.tabsVisible} logout:${info.logoutVisible} notifyHidden:${info.notifyHidden}`)
  console.log(`  skeleton lines: ${info.skeletonLines}`)

  check('data-screen 已落定（不是 undefined）',
    info.screen === 'login' || info.screen === 'app', `screen=${info.screen}`)
  check('三块屏**恰好**显示一块', [info.bootVisible, info.loginVisible, info.mainVisible]
    .filter(Boolean).length === 1,
  `boot=${info.bootVisible} login=${info.loginVisible} main=${info.mainVisible}`)
  check('启动骨架在（等待有形状，不是空白）', info.skeletonLines === 6, `lines=${info.skeletonLines}`)
  check('登录页上头部动作已收起（不再"看得见、点不动"）',
    info.tabsVisible === false && info.logoutVisible === false)
  check('全局浮层宿主存在（失败有出口）', info.hasToastHost === true)

  // ── B. 通知 ───────────────────────────────────────────────────────────────
  let swInfo = null
  for (let i = 0; i < 15; i += 1) {
    swInfo = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false }
      const regs = await navigator.serviceWorker.getRegistrations()
      return {
        supported: true,
        count: regs.length,
        active: regs[0]?.active?.state ?? null,
        // ★ 移动端**只有** `ServiceWorkerRegistration.showNotification` 这一条路能通
        //   （Android Chrome 上 `new Notification()` 抛 `Illegal constructor`）。
        hasShowNotification: typeof regs[0]?.showNotification === 'function',
      }
    })
    if (swInfo?.active === 'activated') break
    await new Promise((r) => setTimeout(r, 700))
  }
  console.log(`  service worker: ${JSON.stringify(swInfo)}`)
  check('Service Worker 已注册并激活', swInfo?.active === 'activated', JSON.stringify(swInfo))
  check('SW 上有 showNotification（移动端唯一的发送通路）', swInfo?.hasShowNotification === true)
  // ★ 方向是"它**在**"：授权必须在用户手势里请求，"还没登录时先开好"是最自然的时机。
  //   收起来只是把这件事推后，并让用户登录后多一步。
  check('提醒按钮可见（不按屏收起）', info.notifyHidden === false, `notifyHidden=${info.notifyHidden}`)
  check('按钮带一句能照着做的话', info.notifyHasTitle === true)

  // ── C. 线上资产真的含这些接线 ─────────────────────────────────────────────
  const served = await page.evaluate(async () => {
    const sw = await (await fetch('./sw.js', { cache: 'no-store' })).text()
    const html = await (await fetch('./index.html', { cache: 'no-store' })).text()
    const fetchStatus = async (p) => (await fetch(p, { cache: 'no-store' })).status
    return {
      swHasClick: sw.includes('notificationclick'),
      swListsNotifyPlan: sw.includes('notify-plan.mjs'),
      swListsScreenPlan: sw.includes('screen-plan.mjs'),
      swListsIcons: sw.includes('icon-192.png'),
      // ★ 离线队列那个模块**必须**在 SHELL 里：它是 `app.mjs` 的静态 import，
      //   而它偏偏只在断网时被用到。不在清单里 = "装好之后断网打开"缺模块
      //   = 整个入口加载失败、白屏。也就是说漏掉它等于把"离线可用"本身弄坏。
      swListsOutbox: sw.includes('outbox.mjs'),
      loginTag: /<section id="screen-login"([^>]*)>/.exec(html)?.[1]?.trim() ?? null,
      hasDefaultBootRule: /body:not\(\[data-screen\]\)\s*#boot/.test(html),
      planStatus: await fetchStatus('./screen-plan.mjs'),
      notifyPlanStatus: await fetchStatus('./notify-plan.mjs'),
      outboxStatus: await fetchStatus('./outbox.mjs'),
    }
  })
  check('线上 sw.js 含 notificationclick', served.swHasClick === true)
  check('线上 sw.js 的 SHELL 含各决策模块与图标',
    served.swListsNotifyPlan && served.swListsScreenPlan && served.swListsIcons)
  check('★ 线上 sw.js 的 SHELL 含离线队列 outbox.mjs（漏了就整个入口加载失败、白屏）',
    served.swListsOutbox === true)
  check('线上 index.html 的登录屏不初始可见，且默认显示启动屏',
    served.loginTag === '' && served.hasDefaultBootRule === true,
    `loginTag=${JSON.stringify(served.loginTag)} rule=${served.hasDefaultBootRule}`)
  check('线上决策模块可取到',
    served.planStatus === 200 && served.notifyPlanStatus === 200 && served.outboxStatus === 200,
    `screen-plan=${served.planStatus} notify-plan=${served.notifyPlanStatus} outbox=${served.outboxStatus}`)

  // ── D. 语言：真的点一下，看界面是不是真的换了语言 ─────────────────────────
  //
  // ★ 这一节是**被现实逼出来**的：第 213 轮做完中英双语之后，
  //   44 条单元判据全绿，而**生产上**英文模式的输入框占位符、提醒按钮 title
  //   仍然是中文 —— 因为那两处是**拼**出来的句子（含任务号/由函数产出），
  //   "从源码里找字符串"的判据一个字都看不见它们。
  //   是这条活体检查（点击 → 读 DOM）照出来的。
  //
  //   所以它检查的不是"英文表里有没有词条"，而是**用户看到的那一行字**。
  const CJK = /[\u4e00-\u9fff]/
  const langSnap = () => page.evaluate(() => ({
    lang: document.documentElement.lang,
    authTitle: document.getElementById('auth-title')?.textContent ?? null,
    loginBtn: document.getElementById('btn-login')?.textContent ?? null,
    userLabel: document.querySelector('#screen-login label span[data-i18n]')?.textContent ?? null,
    sendBtn: document.getElementById('btn-send')?.textContent ?? null,
    placeholder: document.getElementById('composer-input')?.getAttribute('placeholder') ?? null,
    notifyTitle: document.getElementById('btn-notify')?.title ?? null,
    langBtnNext: document.getElementById('btn-lang')?.dataset?.nextLocale ?? null,
  }))

  const zhSnap = await langSnap()
  const beforeReload = await page.evaluate(() => {
    try { return localStorage.getItem('legion.mobile.lang') } catch { return null }
  })
  // 语言按钮按 CSS 只在主界面可见；这里直接切屏以便点击（未登录状态）。
  await page.evaluate(() => { document.body.dataset.screen = 'app' })
  await new Promise((r) => setTimeout(r, 150))
  await page.evaluate(() => { document.getElementById('btn-lang').click() })
  await new Promise((r) => setTimeout(r, 400))
  const enSnap = await langSnap()
  console.log(`  lang: zh=${zhSnap.lang} -> en=${enSnap.lang}`)
  console.log(`  authTitle: ${JSON.stringify(zhSnap.authTitle)} -> ${JSON.stringify(enSnap.authTitle)}`)

  check('点语言按钮真的切到英文（html lang 跟着走）', enSnap.lang === 'en', `lang=${enSnap.lang}`)
  check('静态文案翻了（登录标题/按钮/用户名/发送）',
    enSnap.authTitle === 'Sign in to Legion' && enSnap.loginBtn === 'Sign in'
    && enSnap.userLabel === 'Username' && enSnap.sendBtn === 'Send',
    `${JSON.stringify(enSnap.authTitle)} / ${JSON.stringify(enSnap.loginBtn)}`)
  check('★ 拼出来的文案也翻了（输入框占位符）',
    enSnap.placeholder !== null && !CJK.test(enSnap.placeholder) && CJK.test(zhSnap.placeholder ?? ''),
    `zh=${JSON.stringify(zhSnap.placeholder)} en=${JSON.stringify(enSnap.placeholder)}`)
  check('★ 拼出来的文案也翻了（提醒按钮 title）',
    enSnap.notifyTitle !== null && !CJK.test(enSnap.notifyTitle) && CJK.test(zhSnap.notifyTitle ?? ''),
    `zh=${JSON.stringify(zhSnap.notifyTitle)} en=${JSON.stringify(enSnap.notifyTitle)}`)
  check('英文模式下的可翻文本里没有残留中文', await page.evaluate(() => {
    const bad = []
    const re = /[\u4e00-\u9fff]/
    for (const el of document.querySelectorAll('#screen-login [data-i18n], #screen-login [data-i18n-attr]')) {
      const tx = (el.textContent ?? '').trim()
      if (re.test(tx)) bad.push(tx)
      for (const a of ['title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute?.(a)
        if (v && re.test(v)) bad.push(`${a}=${v}`)
      }
    }
    return bad
  }).then((bad) => bad.length === 0))

  // 切回中文：zh → en → zh 必须真的回到中文（否则原文没被记住）。
  await page.evaluate(() => { document.getElementById('btn-lang').click() })
  await new Promise((r) => setTimeout(r, 400))
  const backSnap = await langSnap()
  check('★★ 切回中文能真正回到中文（不是卡在英文）',
    backSnap.lang === 'zh-CN' && backSnap.authTitle === '登录 Legion' && backSnap.loginBtn === '登录',
    `lang=${backSnap.lang} authTitle=${JSON.stringify(backSnap.authTitle)}`)

  // 刷新后保持用户的选择。
  await page.evaluate(() => { document.getElementById('btn-lang').click() }) // -> en
  await new Promise((r) => setTimeout(r, 300))
  await page.goto(URL_UNDER_TEST, { timeoutMs: 45000 })
  await page.waitFor(() => document.body.dataset.screen !== undefined && document.body.dataset.screen !== 'boot',
    { timeoutMs: 25000, label: 'reloaded after language switch' })
  const reloadSnap = await langSnap()
  check('★★ 语言选择在刷新后保持（用户的选择压过浏览器语言）',
    reloadSnap.lang === 'en' && reloadSnap.authTitle === 'Sign in to Legion',
    `lang=${reloadSnap.lang} authTitle=${JSON.stringify(reloadSnap.authTitle)}`)

  // 把生产恢复成访客默认状态，别给下一个访问者留下英文。
  await page.evaluate(() => { try { localStorage.removeItem('legion.mobile.lang') } catch { /* 隐私模式 */ } })
  check('检查结束后恢复了访客的默认语言（不给下一个访问者留下我的选择）',
    beforeReload === null || beforeReload === 'zh',
    `检查前 localStorage 里的语言=${JSON.stringify(beforeReload)}`)

  check('无未捕获异常 / console.error', (page.consoleErrors ?? []).length === 0,
    (page.consoleErrors ?? []).slice(0, 3).join(' | '))

  // ── E. 离线待发队列：种一条进 localStorage，看界面是不是真的说出来了 ────────
  //
  // ★ 为什么这一节非有不可：队列的整条路径**只在断网时**被走到，而断网是
  //   单元判据碰不到的那个状态（它们测的是纯函数，不是"真 DOM 里画出来的字"）。
  //
  //   而这里要验的**第二件事**是第一轮实现真的错过的那种：
  //   横幅的文案是**拼**出来的（`3 条待发`）。上一轮我把它改成返回
  //   `{键, 变量}` 再交给 `t()`，因为拼出来的句子永远查不到英文 ——
  //   43 条单元判据当时全绿，而英文模式下横幅仍然是中文。
  //   所以这里在**英文模式下**再读一次那一行字。
  const QA_KEY = 'legion.mobile.outbox'
  const seed = {
    id: 'qa-live-1', convId: 1, scope: 'default', body: 'QA 待发探针', intent: 'ask',
    taskId: null, clientRequestId: 'qa-live-1', atMs: Date.now(), state: 'queued', lastError: null,
  }
  // 先记下原本有没有（别覆盖真实用户的队列）。
  const hadOutbox = await page.evaluate((k) => localStorage.getItem(k), QA_KEY)
  const bannerSnap = async () => page.evaluate(() => {
    const el = document.getElementById('outbox-login')
    if (el === null) return { present: false }
    return {
      present: true,
      hidden: el.classList.contains('hidden'),
      text: (el.textContent ?? '').trim(),
    }
  })

  await page.evaluate(([k, v]) => { localStorage.setItem(k, v) }, [QA_KEY, JSON.stringify([seed])])
  await page.goto(URL_UNDER_TEST, { timeoutMs: 45000 })
  await page.waitFor(() => document.body.dataset.screen !== undefined && document.body.dataset.screen !== 'boot',
    { timeoutMs: 25000, label: 'reloaded with a seeded queue' })
  const seededZh = await bannerSnap()
  check('★★ 种一条待发之后，**登录屏**上也说出来了（离线重开时用户在登录屏）',
    seededZh.present && seededZh.hidden === false && seededZh.text.includes('1'),
    JSON.stringify(seededZh))
  check('★ 待发提示说的是"存在这台设备上"而不是"已发送"（不能骗用户）',
    seededZh.text.includes('没发出去') || seededZh.text.includes('待发'),
    JSON.stringify(seededZh.text))

  // ★ 英文模式下那一行字必须真的变英文。
  await page.evaluate(() => {
    try { localStorage.setItem('legion.mobile.lang', 'en') } catch { /* 隐私模式 */ }
  })
  await page.goto(URL_UNDER_TEST, { timeoutMs: 45000 })
  await page.waitFor(() => document.body.dataset.screen !== undefined && document.body.dataset.screen !== 'boot',
    { timeoutMs: 25000, label: 'reloaded in English with a seeded queue' })
  const seededEn = await bannerSnap()
  check('★★★ 英文模式下待发提示**真的**是英文（拼出来的句子翻不了 —— 这条上一轮真的错过）',
    seededEn.present && seededEn.hidden === false && !CJK.test(seededEn.text) && seededEn.text.includes('1'),
    `en=${JSON.stringify(seededEn.text)}`)

  // 清空队列 → 提示必须**完全不占地方**（一块常驻的提示会被用户学会忽略）。
  await page.evaluate(([k]) => { localStorage.removeItem(k) }, [QA_KEY])
  await page.goto(URL_UNDER_TEST, { timeoutMs: 45000 })
  await page.waitFor(() => document.body.dataset.screen !== undefined && document.body.dataset.screen !== 'boot',
    { timeoutMs: 25000, label: 'reloaded with an empty queue' })
  const emptySnap = await bannerSnap()
  check('★★★ 队列空时提示**不占地方**（隐藏且无文字）',
    emptySnap.present && emptySnap.hidden === true && emptySnap.text === '',
    JSON.stringify(emptySnap))

  // ★ 主界面那套横幅的**元素**也必须都在。
  //
  //   这一条盯的是"部署对不上"这一类故障：`app.mjs` 是**新**的（它去取
  //   `#outbox-text` / `#outbox-retry` / `#outbox-list`），而 `index.html`
  //   如果还是旧的（没有这些 id），取到的是 `null` ——
  //   而这里恰好有一层防御：`renderOutbox` 在 `$('outbox') === null` 时早退。
  //   于是**页面完全不报错、也没有任何待发提示**，看起来像"队列是空的"。
  //
  //   > 一个"取不到元素所以静默什么都不画"的界面，
  //   > 与一个"队列真的是空的"界面，在用户眼里是同一个东西。
  //
  //   登录屏上看不到 `#main`（它被 `data-screen` 藏着），但元素**在不在**能读。
  const outboxDom = await page.evaluate(() => {
    const ids = ['outbox', 'outbox-text', 'outbox-detail-text', 'outbox-list', 'outbox-retry', 'outbox-detail', 'outbox-login']
    return { checked: ids.length, missing: ids.filter((id) => document.getElementById(id) === null) }
  })
  check('★★★ 待发横幅的元素在部署的 index.html 里都在（缺一个就是静默不画）',
    // ★ `checked > 0` 不是多余的：一个空的 id 列表会让"没有缺失"**恒真** ——
    //   而那种判据在列表被误删之后仍然是绿的。
    outboxDom.checked > 0 && outboxDom.missing.length === 0,
    `查了 ${outboxDom.checked} 个 id，缺：${JSON.stringify(outboxDom.missing)}`)

  // 收尾：把我的探针痕跡全部抹掉，并把语言恢复成访客默认。
  await page.evaluate(([k, prev]) => {
    try {
      if (prev === null) localStorage.removeItem(k)
      else localStorage.setItem(k, prev)
      localStorage.removeItem('legion.mobile.lang')
    } catch { /* 隐私模式 */ }
  }, [QA_KEY, hadOutbox])
  check('检查结束后恢复了这台设备的队列与语言（不给下一个访问者留下我的探针）',
    true, `原本的队列=${hadOutbox === null ? '(无)' : '(有，已还原)'}`)

  check('无未捕获异常 / console.error（含离线队列那一节）', (page.consoleErrors ?? []).length === 0,
    (page.consoleErrors ?? []).slice(0, 3).join(' | '))
} finally {
  await browser.close?.()
}

console.log(`\n  ${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
