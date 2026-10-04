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

import { buildWorkbenchEnv, deriveDshModelsBaseUrl } from './index.js'

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
