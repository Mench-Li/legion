// scripts/qa/workbench-live-check.mjs
// ============================================================================
// **活体**检查：部署出去的工作台，在一个**真浏览器**里到底跑不跑得起来。
//
// 与 `team-hub/workbench-routes.test.mjs` 的分工：
//   · 那一个是**离线**的：它证明路由族把文件按正确的类型与缓存头发出去，
//     可以在 CI 里跑一千遍；
//   · 这一个是**活的**：真 Chrome、真 TLS、真 Cloudflare、真的执行那份 bundle。
//
// ## 为什么必须有这一层
//
// "每个资源都返回 200"与"应用能用"是两件事：
//   · 一份 bundle 可以加载成功、然后在启动时抛异常 → 页面永远空白；
//   · 登录门可以**该出现却卡住**（探测点不可达时界面停在"连接中"），
//     也可以**不该出现却放行**（远程部署少了一道门）——两者都是 200；
//   · 入口的资源引用一旦从相对变成绝对，挂在中枢 `/workbench/` 下就会全 404，
//     而本机挂在 `/` 的 `serve.mjs` 仍然一切正常。
//
//   > 一个"资源都取到了"的部署，
//   > 与一个"打开就能用"的部署，在 HTTP 状态码上是同一个东西。
//
// 实测（2026-10-12，首次把工作台交给中枢托管）：全部 7 项通过 —— 标题
// `Legion 协作台`、`#root` 有渲染、登录门出现且表单可交互、样式已应用、
// 入口脚本是相对路径、无未捕获异常、无 4xx/5xx。
//
// ## 用法
//
//   node scripts/qa/workbench-live-check.mjs                       # 打生产
//   node scripts/qa/workbench-live-check.mjs --url <地址>          # 打别处
//
// ## 退出码
//
//   0  全部通过        1  有检查失败        2  本机没有可用浏览器（跳过）
// ============================================================================
import { launchBrowser, browserProbe } from '../e2e/cdp.mjs'

const args = new Map()
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) args.set(argv[i].slice(2), argv[i + 1])
}
const URL_UNDER_TEST = args.get('url') ?? 'https://legion-si.online/workbench/'

if (!browserProbe()) {
  console.log('  [skip] 本机没有 Edge/Chrome；可用 DSH_E2E_BROWSER=<路径> 指定。')
  process.exit(2)
}

const browser = await launchBrowser({ headless: true, width: 1280, height: 900 })
let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`)
  if (!ok) failed += 1
}

try {
  const page = await browser.newPage()
  const responses = []
  // 网络读数用可选调用：不同版本助手暴露的事件面不完全一样，
  // 少了它就少一条判据，而不是让整支检查崩掉。
  page.on?.('Network.responseReceived', (p) => responses.push(p))

  await page.goto(URL_UNDER_TEST, { timeoutMs: 45000 })

  // 登录门是在探测 `/api/identity/status` **之后**才渲染的，
  // 所以这里等的是"应用真的走完了启动流程"，而不是"文档加载完了"。
  let gateUp = false
  try {
    await page.waitFor(
      () => document.body.innerText.includes('口令') || document.body.innerText.includes('登录'),
      { timeoutMs: 25000, label: 'login gate' },
    )
    gateUp = true
  } catch { /* 下面按失败上报 */ }

  const info = await page.evaluate(() => ({
    title: document.title,
    rootChildren: document.getElementById('root')?.children.length ?? -1,
    bodyText: (document.body.innerText || '').slice(0, 400),
    scriptSrc: document.querySelector('script[type=module]')?.getAttribute('src') ?? null,
    stylesheets: document.querySelectorAll('link[rel=stylesheet]').length,
    hasInputs: document.querySelectorAll('input').length > 0,
  }))

  console.log(`  url: ${URL_UNDER_TEST}`)
  console.log(`  title: ${info.title}`)
  console.log(`  #root children: ${info.rootChildren}   stylesheets: ${info.stylesheets}   inputs: ${info.hasInputs}`)
  console.log(`  script src: ${info.scriptSrc}`)
  console.log(`  body text: ${info.bodyText.replace(/\s+/g, ' ').slice(0, 220)}`)

  check('应用真的渲染了（#root 有子节点）', info.rootChildren > 0, `children=${info.rootChildren}`)
  check('登录门出现（远程部署要求登录）', gateUp)
  check('登录表单可交互（有输入框）', info.hasInputs)
  check('样式表已应用', info.stylesheets > 0)
  // 这一条守的是"一份产物两个宿主"：一旦构建改回绝对 base，
  // 中枢挂载点会全 404，而本机 serve.mjs 仍然正常。
  check('入口脚本是相对路径', info.scriptSrc?.startsWith('./') === true, `src=${info.scriptSrc}`)
  check('无未捕获异常 / console.error', (page.consoleErrors ?? []).length === 0,
    (page.consoleErrors ?? []).slice(0, 3).join(' | '))
  if (responses.length > 0) {
    const bad = responses.filter((r) => r?.response?.status >= 400)
    check('没有 4xx/5xx 资源请求', bad.length === 0,
      bad.slice(0, 5).map((r) => `${r.response.status} ${r.response.url}`).join(' | '))
  } else {
    console.log('  [note] 未取到网络读数（助手未暴露该事件）—— 已跳过状态码那条')
  }
} finally {
  await browser.close?.()
}

console.log(`\n  ${failed === 0 ? 'ALL CHECKS PASSED' : failed + ' CHECK(S) FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
