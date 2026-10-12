// workbench/mobile/notice.test.mjs
// ============================================================================
// BUG 修复的判据：**登录之后发生的错误，用户看得见吗？**
//
// 这一支守的是一个实测过的形状：`#login-error` 住在 `#screen-login` 里，
// 而进主界面时登录页被整体 `hidden` —— 于是发消息失败、500、断网、
// 会话被撤销，全部写进 `display:none`，用户一条都看不到。
//
//   > 一个"把错误写进一个隐藏盒子"的界面，
//   > 与一个"什么都不报错"的界面，在用户眼里是同一个东西。
//
// 判据刻意落在**纯函数**上：`app.mjs` 在 Node 里不可 import（顶层读
// `sessionStorage`），所以把两个决策抽出来，让它们能被直接断言。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  pickNoticeHost, shouldClearSession, sessionExpiredMessage,
  HOST_INLINE, HOST_TOAST,
} from './notice.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(HERE, 'app.mjs'), 'utf8')
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8')

/**
 * 取出一个顶层函数的**函数体**。
 *
 * ★ 必须先配平**参数表的圆括号**再找函数体的 `{`：`showError(message, { retry = null } = {})`
 *   里第一个 `{` 是**参数解构**，直接当函数体起点会截出一个 `{ retry = null }` ——
 *   于是"这个函数里有没有某段代码"全部问错对象。
 *   （实测踩到：`showError` 被截成参数解构，判据反过来报"它没写 #login-error"。）
 *
 * 注释会被剥掉：注释里提到 `#login-error` 是**说明**，不是**写入**，
 * 而判据要问的是"这段代码碰不碰那个节点"。
 */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `app.mjs 里找不到 function ${name}(`)
  // ① 配平参数表：从参数表的 `(` 走到它配对的 `)`。
  const paren = src.indexOf('(', start)
  let pd = 0
  let i = paren
  for (; i < src.length; i += 1) {
    if (src[i] === '(') pd += 1
    else if (src[i] === ')') { pd -= 1; if (pd === 0) break }
  }
  // ② 函数体从参数表之后的第一个 `{` 开始，配平花括号。
  const open = src.indexOf('{', i)
  let depth = 0
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') {
      depth -= 1
      if (depth === 0) return stripComments(src.slice(open, j + 1))
    }
  }
  throw new Error(`${name} 的花括号没配平`)
}

/** 去掉行注释与块注释 —— 只留代码。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// ── ① 分流：登录页可见时内联，不可见时必须是浮层 ────────────────────────────

test('★★★ 登录页不可见时，提示必须走浮层（这正是那个 bug）', () => {
  assert.equal(pickNoticeHost({ loginScreenVisible: false }), HOST_TOAST,
    '登录页被 hidden 之后，写进 #login-error 等于写进一个看不见的盒子')
})

test('★ 登录页可见时走内联（它就在用户眼前，不必另开浮层）', () => {
  assert.equal(pickNoticeHost({ loginScreenVisible: true }), HOST_INLINE)
})

test('★ 非布尔输入当场抛，而不是静默当成 false', () => {
  // 静默当成 false 的后果是"永远走浮层"或"永远走内联"，
  // 而两种都会在某一半场景里把提示藏起来 —— 那正是要修的东西。
  for (const bad of [undefined, null, 0, 1, 'false', '', {}]) {
    assert.throws(() => pickNoticeHost({ loginScreenVisible: bad }), TypeError,
      `loginScreenVisible=${JSON.stringify(bad)} 应当当场抛`)
  }
  assert.throws(() => pickNoticeHost({}), TypeError)
})

test('★ 反例守卫：判据不是恒真（两种输入给出两个不同结果）', () => {
  const seen = new Set([
    pickNoticeHost({ loginScreenVisible: true }),
    pickNoticeHost({ loginScreenVisible: false }),
  ])
  assert.equal(seen.size, 2, '一条恒返回同一个值的判据什么都没在测')
})

// ── ② 会话：只有"Hub 答复了但拒绝"才清 ──────────────────────────────────────

test('★★★ 网络失败**不清**会话（断网重开不该逼用户重打口令）', () => {
  const offline = new Error('无法连接 Hub：Failed to fetch')
  // 关键：没有 status —— 这正是 app.mjs 的 api() 在网络失败时抛的形状。
  assert.equal(shouldClearSession(offline), false, '连不上 ≠ 被登出')

  for (const noStatus of [undefined, null, {}, { status: undefined }, { status: null }, { status: '401' }]) {
    assert.equal(shouldClearSession(noStatus), false,
      `${JSON.stringify(noStatus)} 没有数字 status，不该被当成会话失效`)
  }
})

test('★★ Hub 答复了并拒绝（401/403/500）才清会话', () => {
  for (const status of [401, 403, 500, 404]) {
    const err = Object.assign(new Error(`HTTP ${status}`), { status })
    assert.equal(shouldClearSession(err), true, `HTTP ${status} 是 Hub 的答复，会话确实没了`)
  }
})

test('★ 反例守卫：真错误与网络错误能被分开（否则这条判据是恒真的）', () => {
  const net = new Error('offline')
  const denied = Object.assign(new Error('HTTP 401'), { status: 401 })
  assert.notEqual(shouldClearSession(net), shouldClearSession(denied),
    '如果两者结果相同，这个分流就没有意义')
})

test('★ 会话过期的文案只有一份', () => {
  const msg = sessionExpiredMessage()
  assert.equal(typeof msg, 'string')
  assert.ok(msg.length > 0)
  assert.equal(msg, sessionExpiredMessage(), '同一状态必须说同一句话')
})

// ── ③ 接线：那两个决策**真的被 app.mjs 用上了** ──────────────────────────────
//
// 纯函数全绿而没人调用，是这一族最容易发生的假绿。所以下面几条读源码，
// 钉住"决策被接在了哪里"。

test('★★★ app.mjs 必须 import 并使用 pickNoticeHost / shouldClearSession', () => {
  assert.match(APP, /from '\.\/notice\.mjs'/, 'app.mjs 必须从 notice.mjs 取这两个决策')
  assert.match(APP, /pickNoticeHost\(/, 'pickNoticeHost 必须被真的调用')
  assert.match(APP, /shouldClearSession\(/, 'shouldClearSession 必须被真的调用')
})

test('★★★ showLoginError 必须**委托**给统一判据，不许自己写 #login-error', () => {
  // ★ 这一条是被破坏性验证逼出来的：只查"`showError` 存在、`pickNoticeHost` 被调用"
  //   是不够的 —— 把 `showLoginError` 改回**有 bug 的那个版本**（无条件写
  //   `#login-error`）时，那些判据**全绿**。因为发送失败那条路径走的是
  //   `showLoginError`，而它已经绕开了统一判据。
  //
  //   > 一支"函数存在、名字被提到"的判据，
  //   > 与一支"这条路径真的走了那个判据"的判据，
  //   > 在没人故意退回去的时候是同一个东西。
  const body = functionBody(APP, 'showLoginError')
  assert.match(body, /showError\(/, 'showLoginError 必须把消息交给 showError')
  assert.doesNotMatch(body, /login-error/,
    'showLoginError 自己不许再碰 #login-error —— 登录后那个盒子是 display:none')
})

test('★★★ #login-error 只允许 showError 的内联分支写', () => {
  const showErr = functionBody(APP, 'showError')
  assert.match(showErr, /login-error/, 'showError 的内联分支要写它')
  assert.match(showErr, /pickNoticeHost\(/, '而且必须先问"登录页看不看得见"')

  // 全文里提到 `login-error` 的函数，只允许这几种角色：
  //   showError    —— 内联分支（唯一真正写内容的地方）
  //   bind         —— 切注册/登录模式时清场
  //   renderAuth   —— 渲染时清场
  // 任何**别的**函数碰它，都是绕过统一判据的一条旁路。
  const allowed = new Set(['showError', 'bind', 'renderAuth'])
  const offenders = []
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(/g
  let m
  while ((m = re.exec(APP)) !== null) {
    const name = m[1]
    const body = functionBody(APP, name)
    if (/login-error/.test(body) && !allowed.has(name)) offenders.push(name)
  }
  assert.deepEqual(offenders, [],
    `这些函数绕过了 showError 直接写 #login-error：${offenders.join(', ')}`)
})

test('★★★ 发送失败那条路径必须真的走得到统一判据', () => {
  // 直接钉住用户可见的那次失败：`send()` 里发消息失败时调用的函数。
  const send = functionBody(APP, 'send')
  assert.match(send, /showLoginError\(|showError\(/,
    'send() 的失败分支必须走统一判据，否则"消息没发出去"用户看不见')
})

test('★★★ 登录页是否可见必须**真的从 DOM 读**，不能写死', () => {
  // 写死 true ⇒ 登录后的错误又回到隐藏盒子里；写死 false ⇒ 登录失败时
  // 不看眼前的内联盒子。两种写死都能让上面那些纯函数判据全绿。
  const body = functionBody(APP, 'loginScreenVisible')
  assert.match(body, /classList\.contains\('hidden'\)/,
    '判据必须是 screen-login 上真实的 hidden 类，而不是别的近似')
  assert.match(body, /\$\('screen-login'\)/, '必须读的就是登录页那个节点')
})

test('★★ 全局浮层宿主必须存在，且**不在** #screen-login 里面', () => {
  const i = HTML.indexOf('id="toast-host"')
  assert.notEqual(i, -1, 'index.html 必须有 #toast-host')

  const loginStart = HTML.indexOf('id="screen-login"')
  const loginEnd = HTML.indexOf('</section>', loginStart)
  assert.notEqual(loginStart, -1)
  assert.ok(i > loginEnd,
    '#toast-host 必须在 #screen-login **之外** —— 在里面就等于又造了一个看不见的盒子')

  assert.match(HTML, /role="alert"/, '错误要立刻被读屏播报（role=alert）')
  assert.match(HTML, /aria-live="assertive"/, '断言式播报，与 #popup-host 的 polite 区分开')
})

test('★★ 登录后的错误提示不能再只有一个去处', () => {
  // app.mjs 里 #login-error 与 #login-notice 必须**同时**有内联与浮层两条路。
  // 数一数：这两个 id 只应出现在"内联分支"里，而浮层 host 必须另有出现。
  assert.match(APP, /toast-host/, 'app.mjs 必须知道浮层宿主')
  assert.match(APP, /function showError\(|function showLoginError\(/)
})

test('★★ 401 且刷新失败必须回登录屏，而不是留在原地静默 401', () => {
  assert.match(APP, /sessionExpiredMessage\(\)/,
    '会话过期要用那唯一一份文案')
  assert.match(APP, /function showLoginScreen\(|function logoutToLogin\(/,
    '需要一个"切回登录屏"的动作，否则界面停在旧状态')
})

test('★ 反例守卫：把可见性判据写死会让上面那条"从 DOM 读"失败', () => {
  // 证明那条正则不是恒真 —— 它必须能区分"读 DOM"与"写死"。
  const written = 'function loginScreenVisible() { return true }'
  assert.doesNotMatch(written, /classList\.contains\('hidden'\)/,
    '一个写死返回值的实现不该通过"必须从 DOM 读"那条判据')
  assert.match(APP, /classList\.contains\('hidden'\)/, '而真实实现必须通过')
})
