// services-plugin/index.test.mjs
// ============================================================================
// Bug #1「供应商与模型无法读取」的守门测试。
//
// 事故形状：指挥台把 DSH 宿主地址写死成 3080，而 Desktop 部署的宿主在 19387
// ⇒ `llm/listConfigurableProviders` / `settings/describe` / `session/modelCatalog`
// 三个读取全部连不上，「供应商与模型」整页读不出来，界面只拿到一句 `fetch failed`。
//
// 这里守的是**修法**本身：宿主地址必须由启动方按 `ctx.webServer.port` 派生并注入，
// 而且"取不到"必须是**不注入**（调用方据此在日志里说清楚），不许编一个默认值——
// 编出来的默认值会得到"看起来配了、其实指向没人监听的端口"，那正是这次事故的形状。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildWorkbenchEnv, deriveDshModelsBaseUrl, deriveDshModelsLoginUrl } from './index.js'

test('★ 宿主端口就是本次启动的那个：Desktop 实测 19387，不是 3080', () => {
  assert.equal(deriveDshModelsBaseUrl({ webServerPort: 19387 }), 'http://127.0.0.1:19387')
  // 反向锚：写死 3080 的实现会在这里返回 3080 —— 那正是 Bug #1
  assert.notEqual(deriveDshModelsBaseUrl({ webServerPort: 19387 }), 'http://127.0.0.1:3080')
})

test('优先级：composition 显式配置 > 宿主端口 > 宿主的 DSH_WEB_URL', () => {
  assert.equal(
    deriveDshModelsBaseUrl({ configured: 'http://127.0.0.1:9001', webServerPort: 19387, env: { DSH_WEB_URL: 'http://127.0.0.1:1' } }),
    'http://127.0.0.1:9001')
  assert.equal(
    deriveDshModelsBaseUrl({ webServerPort: 19387, env: { DSH_WEB_URL: 'http://127.0.0.1:1' } }),
    'http://127.0.0.1:19387')
  assert.equal(deriveDshModelsBaseUrl({ env: { DSH_WEB_URL: 'http://127.0.0.1:19387' } }), 'http://127.0.0.1:19387')
  assert.equal(deriveDshModelsBaseUrl({ env: { DSH_WEB_URL: 'http://127.0.0.1:19387/?token=x#frag' } }), 'http://127.0.0.1:19387')
})

test('取不到就返回空：**不编**默认值（编了就是"指向没人监听的端口"）', () => {
  for (const input of [
    {},
    { webServerPort: null },
    { webServerPort: 0 },        // 端口 0 = 还没绑（或绑定失败），不是"用 0 号端口"
    { webServerPort: -1 },
    { webServerPort: 70000 },
    { webServerPort: 'abc' },
    { env: {} },
    { env: { DSH_WEB_URL: '' } },
    { env: { DSH_WEB_URL: 'not a url' } },
    { env: { DSH_WEB_URL: 'file:///tmp/x' } },
    { env: { DSH_WEB_URL: 'ftp://host' } },
  ]) {
    assert.equal(deriveDshModelsBaseUrl(input), '', `${JSON.stringify(input)} 应当明确返回空，而不是猜一个地址`)
  }
  // 「空」与「回落一个看起来能用的值」是两件事：空 ⇒ 不注入 ⇒ 由 workbench 自己说清楚
  assert.equal(deriveDshModelsBaseUrl({ webServerPort: 0 }).includes('3080'), false)
})

test('显式配置的尾斜杠被吃掉：不拼出 `//api/...`', () => {
  assert.equal(deriveDshModelsBaseUrl({ configured: 'http://127.0.0.1:9001/' }), 'http://127.0.0.1:9001')
  assert.equal(deriveDshModelsBaseUrl({ configured: '  http://127.0.0.1:9001//  ' }), 'http://127.0.0.1:9001')
})

test('★ 派生的地址真的进了 workbench 子进程环境，且原有注入一项不少', () => {
  const env = buildWorkbenchEnv({
    baseEnv: { PATH: 'x', LEGION_DESKTOP_MODE: '1' },
    hubUpstream: 'http://127.0.0.1:8787',
    teamHubToken: 'tok',
    dshModelsBaseUrl: 'http://127.0.0.1:19387',
  })
  assert.equal(env.DSH_MODELS_BASE_URL, 'http://127.0.0.1:19387')
  assert.equal(env.DSH_HUB_UPSTREAM, 'http://127.0.0.1:8787')
  assert.equal(env.TEAM_HUB_TOKEN, 'tok')
  assert.equal(env.PATH, 'x', '未被覆盖的环境变量必须照常透传')
  assert.equal(env.LEGION_DESKTOP_MODE, '1')
})

test('★ 取不到宿主时**不注入** DSH_MODELS_BASE_URL，而不是注入一个默认地址', () => {
  const env = buildWorkbenchEnv({ baseEnv: {}, hubUpstream: 'http://127.0.0.1:8787', teamHubToken: '', dshModelsBaseUrl: '' })
  assert.equal('DSH_MODELS_BASE_URL' in env, false,
    '注入了空值/默认值会让 workbench 拿到一个"看起来配了"的地址 —— 那正是 Bug #1 的形状')
  assert.equal(JSON.stringify(env).includes('3080'), false, '宿主地址取不到时，环境里不许凭空出现 3080')
})

// ── BUG-014 第二层（凭证）：宿主操作员登录 URL ─────────────────────────────────
// 地址修对之后，面板拿到的是 401 —— 因为宿主 `/api/*` 只认它**自己的浏览器会话**。
// 解药是让用户浏览器登一次；这条 URL 就是登的东西，由本插件从 `ctx.connection` 铸出。

test('★ 登录 URL 必须真的带 token：没有令牌的地址只会把浏览器送到宿主的 401 页', () => {
  const ok = { authenticatedUrl: (b) => `${b.replace(/\/$/, '')}/?token=T0K3N` }
  assert.equal(deriveDshModelsLoginUrl({ connection: ok, webServerPort: 19387 }), 'http://127.0.0.1:19387/?token=T0K3N')
  // 反向：返回了地址但**没有** token ⇒ 视为拿不到（"看起来配了、其实没配"是同一族的错）
  const noToken = { authenticatedUrl: (b) => b }
  assert.equal(deriveDshModelsLoginUrl({ connection: noToken, webServerPort: 19387 }), '',
    '没有 token 的 URL 必须被判成空 —— 否则界面会显示"已连接"而实际还是 401')
})

test('★ 取不到就返回空（与宿主地址同一条纪律：不编一个值）', () => {
  const ok = { authenticatedUrl: () => 'http://127.0.0.1:19387/?token=T' }
  for (const input of [
    {},
    { connection: ok },                                   // 没有端口
    { connection: ok, webServerPort: 0 },                 // 端口 0 = 还没绑
    { connection: ok, webServerPort: 70000 },
    { connection: null, webServerPort: 19387 },           // 宿主没暴露 connection 服务
    { webServerPort: 19387 },                             // 同上（字段缺省）
    { connection: {}, webServerPort: 19387 },             // 有服务但没这个方法
  ]) {
    assert.equal(deriveDshModelsLoginUrl(input), '', `${JSON.stringify(input)} 应当明确返回空`)
  }
})

test('★ authenticatedUrl 抛错时返回空，而不是把异常带进启动流程', () => {
  const boom = { authenticatedUrl: () => { throw new Error('connection 还没就绪') } }
  assert.equal(deriveDshModelsLoginUrl({ connection: boom, webServerPort: 19387 }), '')
})

test('★ 登录 URL 只在拿得到时注入 workbench 环境（空 ⇒ 不注入）', () => {
  const withUrl = buildWorkbenchEnv({ baseEnv: {}, hubUpstream: 'h', dshModelsLoginUrl: 'http://127.0.0.1:19387/?token=T' })
  assert.equal(withUrl.DSH_MODELS_LOGIN_URL, 'http://127.0.0.1:19387/?token=T')
  const without = buildWorkbenchEnv({ baseEnv: {}, hubUpstream: 'h' })
  assert.equal('DSH_MODELS_LOGIN_URL' in without, false,
    '注入空值会让指挥台把"宿主没给登录地址"读成"给了个空地址"，两者的修法不同')
})

test('★ 注入项之间互不影响：给了登录 URL 不会挤掉宿主地址（反之亦然）', () => {
  const both = buildWorkbenchEnv({
    baseEnv: {}, hubUpstream: 'h', dshModelsBaseUrl: 'http://127.0.0.1:19387',
    dshModelsLoginUrl: 'http://127.0.0.1:19387/?token=T',
  })
  assert.equal(both.DSH_MODELS_BASE_URL, 'http://127.0.0.1:19387')
  assert.equal(both.DSH_MODELS_LOGIN_URL, 'http://127.0.0.1:19387/?token=T')
})
