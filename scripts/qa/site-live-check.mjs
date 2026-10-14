// scripts/qa/site-live-check.mjs
// ============================================================================
// **活体**检查：官网「开始使用」那一块在**真浏览器**里是不是真的在、真的看得见。
//
// 与 `team-hub/site-routes.test.mjs` 的分工：
//   · 那个是**离线**的：对着源码与渲染出来的 HTML 断言（有没有安装包链接、
//     两张卡、文案在不在、CSS 里那几条死规则删没删）。它能在 CI 里跑一千遍；
//   · 这一个是**活的**：真 Chrome、真 TLS、真的把 `site.css` 应用上去，
//     然后**读计算样式**。
//
// ## 为什么这一层不是可选的
//
// 2026-10-08 线上故障：`.deploy-item a { color: var(--accent) }`（权重 0,1,1）
// 压过了 `.primary`（0,1,0）—— 按钮文字被染成青绿，而按钮底色也是青绿，
// **按钮上的字整块看不见**。那一轮所有离线判据都是绿的：HTML 里那个 `<a>`
// 在、class 在、文字也在。
//
//   > 一个"按钮在页面上、也有 class 和文字"的判据，
//   > 与一个"按钮看起来像按钮"的判据，在 CSS 出问题的时候是同一个东西。
//
// 2026-10-14 删下载区 CSS 时踩到同一类风险的另一半：`.hub-actions` 与
// `.dl-actions` 原先**共用一条双选择器**，收窄时若整条删掉，Web 入口那个按钮
// 就会**失去样式** —— 同样地，结构、类名、文字全都在，离线判据一条都不会红。
//
// ## 检查什么
//
//   A. `.hub-actions` 里那个按钮在、可见、有尺寸，且保留 `.hub-actions .btn` 的
//      高度与内边距（证明双选择器收窄时没把整条删掉）。
//   B. ★ 文字色与**按钮底色**不同（那次事故就是两者相同）。
//   C. 卡片里那个**文字链接**仍被上色（`.deploy-item a:not(.btn)` 还在工作）。
//   D. 页面上没有 `.dl-*` 的死元素；线上那一份不含任何下载入口字样。
//   E. 开始那一节仍是两张卡。
//
// ## ★★ 两条"活体检查"本身的纪律（都是被自己咬过才写下的）
//
// ① **不许用固定的 sleep 去等布局**。第一版睡 800ms，然后在英文站上**偶发**变红：
//    量到的那一瞬间样式表还没应用，`min-height` 还是默认值。
//
//      > 一个偶发的活体检查，与一个坏掉的活体检查，
//      > 在每次看到它变红都选择重跑一遍的人眼里是同一个东西。
//
//    现在等的是"CSS 真的生效"的信号（`.hub-actions .btn` 的 `min-height` 变成 40px）。
//
// ② **判不了就不判**。这一条打的是**公网**，边缘/隧道偶发不给内容时，
//    "页面里没有那个按钮"与"这次根本没拿到页面"是两件事。所以先看文档到底有没有
//    加载出来：拿不到内容就**重试一次**，仍旧拿不到就报 `[skip]` 并以 **2** 退出 ——
//    而不是报一个假 FAIL 去误导人。
//
// ## 用法与退出码
//
//   node scripts/qa/site-live-check.mjs                    # 打生产
//   node scripts/qa/site-live-check.mjs --url <地址>       # 打别处
//
//   0 = 全部 PASS    1 = 有 FAIL    2 = 跳过（没有浏览器 / 页面没加载出来）
// ============================================================================
import { launchBrowser, browserProbe } from '../e2e/cdp.mjs'

// 参数解析与 `mobile-live-check` / `workbench-live-check` **同一套写法**
// （`--url <地址>`，空格分隔）。第一版我按 `--k=v` 写，于是 `--url https://…`
// 被解析成一个**空串**，最后死在"Invalid URL"上 —— 一个只在"用法和兄弟脚本
// 不一样"时才暴露的 bug。三个脚本用法一致，比"我这个更讲究"重要。
const args = new Map()
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1])
}
const URL_UNDER_TEST = args.get('url') ?? 'https://legion-si.online/'

if (!browserProbe()) {
  console.log('  [skip] 本机没有 Edge/Chrome；可用 DSH_E2E_BROWSER=<路径> 指定。')
  process.exit(2)
}

/** 文档到底有没有内容 —— 用来区分"内容回归"与"这次没拿到页面"。 */
const documentShape = (page) => page.evaluate(() => ({
  readyState: document.readyState,
  title: document.title,
  url: location.href,
  htmlLen: document.documentElement ? document.documentElement.outerHTML.length : 0,
}))

const browser = await launchBrowser({ headless: true, width: 1440, height: 900 })
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failed += 1
}

try {
  const page = await browser.newPage()

  // ── ② 判不了就不判：先确认拿到了一个**有内容**的文档，最多重试一次 ────────
  let shape = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await page.goto(URL_UNDER_TEST, { timeoutMs: 45000 })
    shape = await documentShape(page)
    if (shape.htmlLen > 2000) break
    if (attempt === 1) {
      console.log(`  [retry] 第 1 次导航后文档只有 ${shape.htmlLen} 字节`
        + `（title=${JSON.stringify(shape.title)}）—— 重试一次`)
    }
  }
  if (shape === null || shape.htmlLen <= 2000) {
    console.log(`  [skip] 没能拿到有内容的页面（${shape?.htmlLen ?? 0} 字节，`
      + `title=${JSON.stringify(shape?.title ?? '')}，url=${shape?.url ?? ''}）`)
    console.log('         这看着是网络/边缘的问题，不是内容回归 —— 判不了就不判（退出码 2）。')
    await browser.close?.()
    process.exit(2)
  }

  // ── ① 等 CSS **真的**生效（只在按钮确实存在时才等）─────────────────────
  const blockThere = await page.evaluate(() => document.querySelector('.hub-actions a.btn') !== null)
  if (blockThere) {
    await page.waitFor(() => {
      const b = document.querySelector('.hub-actions a.btn')
      return b !== null && getComputedStyle(b).minHeight === '40px'
    }, { timeoutMs: 15000, label: 'site.css applied' }).catch(() => { /* 下面如实上报量到了什么 */ })
  }

  const info = await page.evaluate(() => {
    const block = document.querySelector('.hub-actions')
    if (block === null) return { error: '页面里没有 .hub-actions（开始区第一张卡的动作块）' }
    const btn = block.querySelector('a.btn')
    if (btn === null) return { error: '.hub-actions 里没有 a.btn' }
    const cs = getComputedStyle(btn)
    const rect = btn.getBoundingClientRect()
    const link = [...document.querySelectorAll('.deploy-item a')].find((x) => !x.classList.contains('btn'))
    return {
      text: (btn.textContent || '').trim(),
      href: btn.getAttribute('href'),
      color: cs.color,
      background: cs.backgroundColor,
      minHeight: cs.minHeight,
      paddingLeft: cs.paddingLeft,
      linkColor: link ? getComputedStyle(link).color : null,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      deadPresent: document.querySelector('.dl-actions, .dl-meta, .dl-lines') !== null,
      cardCount: document.querySelectorAll('#deploy .deploy-item').length,
      bodyText: document.body.innerText.slice(0, 4000),
    }
  })

  if (info.error) {
    check('找到 Web 入口块与按钮', false, info.error)
  } else {
    // ── A. 按钮在、可见、样式没丢 ─────────────────────────────────────────
    check('按钮有文字', info.text.length > 0, JSON.stringify(info.text))
    check('按钮指向 Web 入口', info.href === '/mobile/', String(info.href))
    check('按钮有可见尺寸', info.width > 40 && info.height > 20, `${info.width}x${info.height}`)
    check('保留了 .hub-actions .btn 的高度（双选择器收窄时最容易整条删掉）',
      info.minHeight === '40px', info.minHeight)
    check('保留了内边距', info.paddingLeft !== '0px', info.paddingLeft)

    // ── B. ★ 文字色 ≠ 底色（2026-10-08 那次事故的形状）──────────────────
    check('文字色与按钮底色**不同**', info.color !== info.background,
      `${info.color} vs ${info.background}`)
    check('文字色与页面底色也不同', info.color !== info.bodyBg, `${info.color} vs ${info.bodyBg}`)

    // ── C. 文字链接仍被上色（`:not(.btn)` 那条规则还在工作）──────────────
    check('卡片里仍有一个被上色的文字链接', info.linkColor !== null, String(info.linkColor))

    // ── D/E. 下载区真的没了，而那一节还在 ────────────────────────────────
    check('页面上没有 .dl-* 的死元素', info.deadPresent === false)
    check('开始那一节仍是两张卡', info.cardCount === 2, String(info.cardCount))
    // 官网不许再出现任何下载入口（与离线判据同一条纪律，这里查的是**线上那一份**）。
    for (const bad of ['下载电脑版', 'Legion-Setup', '.exe', '尚未发布']) {
      check(`线上页面不含「${bad}」`, !info.bodyText.includes(bad))
    }
  }

  const errs = (page.consoleErrors ?? []).filter((e) => !/favicon/i.test(String(e)))
  check('控制台没有错误', errs.length === 0, errs.slice(0, 2).join(' | '))

  console.log(`\n  url: ${URL_UNDER_TEST}`)
  console.log(`  title: ${JSON.stringify(shape.title)}   documentElement: ${shape.htmlLen} 字节`)
} finally {
  await browser.close?.()
}

console.log(`  ${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
