// workbench/mobile/screen-plan.test.mjs
// ============================================================================
// 首屏：登录表单不许闪、进主界面之后不许是一片空白。
//
// 修复前两件事同时存在：
//   ① 模板里 `#screen-login` **没有** `hidden`，于是已经登录的人每次打开都先看到
//      一整张登录表单、几百毫秒后被抽走；
//   ② `enterApp()` 先亮 `#main`、**然后**才 await 六个串行请求，那段时间内容区
//      是空的 —— 弱网下看起来就是卡死。
//
//   > 一个"先让你以为自己被登出了、再把你放进去"的首屏，
//   > 与一个"直接进去"的首屏，在功能上完全一样 ——
//   > 只不过前者每次打开都让人心里一沉。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { SCREENS, isScreen, screenAfterProbe, SKELETON_ROWS } from './screen-plan.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.mjs'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')

/** 取一个顶层函数的函数体（先配平参数表的圆括号，再去掉注释）。 */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `app.mjs 里找不到 function ${name}(`)
  const paren = src.indexOf('(', start)
  let pd = 0
  let i = paren
  for (; i < src.length; i += 1) {
    if (src[i] === '(') pd += 1
    else if (src[i] === ')') { pd -= 1; if (pd === 0) break }
  }
  const open = src.indexOf('{', i)
  let depth = 0
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') {
      depth -= 1
      if (depth === 0) {
        return src.slice(open, j + 1)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      }
    }
  }
  throw new Error(`${name} 的花括号没配平`)
}

// ── ① 纯决策 ────────────────────────────────────────────────────────────────

test('★★★ 有会话就落主界面，没会话才落登录屏', () => {
  assert.equal(screenAfterProbe({ signedIn: true }), 'app')
  assert.equal(screenAfterProbe({ signedIn: false }), 'login')
  // 缺省不是 app：默认放进去等于把登录门拆了。
  assert.equal(screenAfterProbe({}), 'login')
  assert.equal(screenAfterProbe(), 'login')
})

test('★ 反例守卫：两种输入给出不同结果（判据不是恒真）', () => {
  const seen = new Set([screenAfterProbe({ signedIn: true }), screenAfterProbe({ signedIn: false })])
  assert.equal(seen.size, 2)
})

test('★★ `isScreen` 只认三块屏（写错值会让三块都不显示）', () => {
  for (const s of SCREENS) assert.equal(isScreen(s), true)
  for (const bad of ['', 'Boot', 'app ', 'loginx', null, undefined, 0, {}, ['app']]) {
    assert.equal(isScreen(bad), false, `${JSON.stringify(bad)} 不该被判为合法屏`)
  }
  assert.equal(SCREENS.length, 3)
})

test('★ 骨架行是常量且形状合理', () => {
  assert.ok(SKELETON_ROWS.length >= 3, '骨架至少要几行才看起来像在加载')
  for (const w of SKELETON_ROWS) {
    assert.ok(Number.isFinite(w) && w > 0 && w <= 100, `行宽 ${w} 应当是 0–100 的百分比`)
  }
})

// ── ② 模板：起始状态必须是"启动屏"，且三块屏不靠 .hidden ────────────────────

test('★★★ 登录屏在模板里**不许**是初始可见的（否则每次打开都闪一下）', () => {
  // 判据不是"有没有 hidden 这个 class"，而是"在 data-screen 还没设时它显示不显示"。
  // 三块屏的可见性**只**由 `body[data-screen=…]` 决定，所以模板里不该再带
  // `.hidden`（它是 `!important`，会盖过那些规则）。
  const loginTag = /<section id="screen-login"([^>]*)>/.exec(HTML)?.[1] ?? ''
  assert.equal(loginTag.includes('hidden'), false,
    '#screen-login 不该用 .hidden —— 可见性只由 data-screen 决定')
  const mainTag = /<main id="main"([^>]*)>/.exec(HTML)?.[1] ?? ''
  assert.equal(mainTag.includes('hidden'), false, '#main 同理')
  const composerTag = /<footer id="composer"([^>]*)>/.exec(HTML)?.[1] ?? ''
  assert.equal(composerTag.includes('hidden'), false, '#composer 同理')
})

test('★★★ 三块屏都由 `body[data-screen=…]` 驱动，且**默认**显示启动屏', () => {
  for (const screen of ['boot', 'login', 'app']) {
    assert.match(HTML, new RegExp(`body\\[data-screen="${screen}"\\]`),
      `CSS 里缺少 data-screen="${screen}" 那条规则 —— 那个状态会三块都不显示`)
  }
  // 脚本还没跑时（`data-screen` 未设）必须有一个默认可见的屏，
  // 否则用户看到的是一片纯白，而那不是"正在加载"。
  assert.match(HTML, /body:not\(\[data-screen\]\)\s*#boot/, 'data-screen 未设时必须默认显示 #boot')
})

test('★ 启动屏有骨架，且行宽与常量一致（一处真源）', () => {
  assert.match(HTML, /id="boot-skeleton"/, '启动屏要有骨架')
  const widths = [...HTML.matchAll(/class="sk-line" style="width:(\d+)%"/g)].map((m) => Number(m[1]))
  assert.deepEqual(widths, [...SKELETON_ROWS],
    '模板里的骨架行宽必须与 screen-plan.mjs 的 SKELETON_ROWS 一致 —— 两处各写一份必然漂移')
})

test('★ 骨架尊重"减少动态效果"（一条一直闪的占位在那个设置下是干扰）', () => {
  assert.match(HTML, /prefers-reduced-motion/, '要有 prefers-reduced-motion 分支')
})

// ── ③ 接线：app.mjs 真的这么做了 ────────────────────────────────────────────

test('★★★ 只有一个写入点：`setScreen`，而且它当场校验取值', () => {
  assert.match(APP, /function setScreen\(/, '要有 setScreen')
  const body = functionBody(APP, 'setScreen')
  assert.match(body, /isScreen\(/, 'setScreen 必须校验取值（写错值会让三块都不显示）')
  assert.match(body, /dataset\.screen/, 'setScreen 是唯一写 data-screen 的地方')
  // 三块屏的可见性不许再由 classList 直接操作 —— 那正是"漏一次就错"的来源。
  for (const id of ['screen-login', 'main', 'composer']) {
    assert.doesNotMatch(APP, new RegExp(`\\('${id}'\\)\\.classList`),
      `不该再直接 toggle #${id} 的 class —— 可见性只走 setScreen`)
  }
})

test('★★★ `main()` 的起点是启动屏，而且**任何**退出路径都不许留在启动屏上', () => {
  const body = functionBody(APP, 'main')
  assert.match(body, /setScreen\('boot'\)/, 'main() 必须以启动屏开始')
  // ★ 用 finally 而不是在末尾写一行：末尾那行会被将来任何一处 return 跳过。
  assert.match(body, /finally\s*\{/, 'main() 需要 finally 兜底')
  assert.match(body, /currentScreen\(\) === 'boot'[\s\S]{0,80}setScreen\(/,
    'finally 里必须在"还停在启动屏"时落一个真屏')
})

test('★★★ `enterApp` 必须等数据到了才落主界面（先亮主区再 await = 空白页）', () => {
  const body = functionBody(APP, 'enterApp')
  const awaitAt = body.indexOf('await refreshSpaces()')
  assert.notEqual(awaitAt, -1, '读不到 refreshSpaces 那一行 —— 它改名了，这条判据要跟着改')
  const setBefore = body.slice(0, awaitAt).includes("setScreen('app')")
  assert.equal(setBefore, false,
    "enterApp 不许在 await 之前就落主界面 —— 那六个串行请求期间内容区是空的")
  assert.match(body, /finally\s*\{[\s\S]{0,200}setScreen\('app'\)/,
    '无论成功失败都必须落主界面（停在骨架上一个错误都没有，更糟）')
})

test('★★ 切回登录屏也走 setScreen（会话中途失效那条路径）', () => {
  assert.match(functionBody(APP, 'showLoginScreen'), /setScreen\('login'\)/)
})

test('★★ 头部动作按屏收起，由 CSS 一条规则负责（不是第二份 JS 判据）', () => {
  // 曾经这里断言"app.mjs 必须用到 chromeVisible"，那逼出了一个**多余的真源**：
  // 三个控件的可见性由 `body:not([data-screen="app"]) …{display:none}` 负责，
  // 而那条规则在脚本跑起来**之前**就生效 —— 那正是它该在的层。
  // 再写一个 JS 判据就是同一件事的第二份真源。
  assert.match(HTML, /body:not\(\[data-screen="app"\]\)\s*#tabs/,
    'CSS 里要按 data-screen 收起页签')
  assert.match(HTML, /body:not\(\[data-screen="app"\]\)\s*#btn-logout/,
    '退出按钮同理')
  // 而 `chromeVisible` 不该再存在（删掉它是对的，不是遗漏）。
  assert.doesNotMatch(APP, /chromeVisible/, 'chromeVisible 已删除 —— 不该有人再引用它')
})

test('★★★ 🔔 按钮**不**按屏收起（授权要在用户手势里、越早越好）', () => {
  // ★ 本任务里我曾把 🔔 改成"只在主界面出现"，去给 chromeVisible 找调用者 ——
  //   那是**越界改动**，而且被第 211 轮的活体检查当场抓住：
  //   `#btn-notify` 在登录页上消失了。
  //
  //   正确的理由：授权**必须**在用户手势里请求。收起它只是把这件事推后，
  //   并让用户在登录后多一步 —— 而第 211 轮的判据明写着
  //   "被拒之后就消失 = 用户失去线索"。
  const body = functionBody(APP, 'renderNotifyButton')
  assert.doesNotMatch(body, /chromeVisible|currentScreen\(\)/,
    'renderNotifyButton 不许按屏收起 —— 那是越界，也让第 211 轮的判据失效')
})

