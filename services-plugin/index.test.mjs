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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildTeamHubEnv, buildWorkbenchEnv, deriveDshModelsBaseUrl } from './index.js'

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.js'), 'utf8')

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

// ── ★ 一条**反向**护栏：本插件的硬依赖只有 `webServer` ──────────────────────────
// 这里曾经因为「铸宿主操作员登录 URL」而需要 `connection`，我第一版把它写进了 `inject`——
// 那是个会**停服**的错误：Cordis 的 `inject` 是硬依赖，名字在而组合里没有 ⇒ 整个插件 pending ⇒
// **team-hub 与指挥台都不会启动**。那条能力后来连方向一起拆了（见
// docs/DECISION-legion-owns-model-config.md），但这条护栏留着：
// **凡是"锦上添花"的宿主服务，一律 `ctx.get(...)` 软取，绝不进 inject。**
// DSH 自己的 `web-app` 就是这么分的：`inject = ['webServer']`（硬）+ 软取 connection。
test('★ 硬依赖只有 webServer；别的宿主服务一律软取（硬依赖会让整个插件 pending ⇒ 两个服务都起不来）', () => {
  const injectLine = /export const inject = (\[[^\]]*\])/.exec(SRC)?.[1] ?? ''
  assert.ok(injectLine.length > 0, '找不到 inject 声明')
  assert.equal(injectLine.includes("'webServer'"), true, 'webServer 是硬依赖（宿主端口来自它）')
  assert.equal(injectLine.includes("'connection'"), false, 'connection 不许进 inject')
  // 这一步的 P1/P3 还要用到 ctx.settings / ctx.credentials / ctx.llm —— 同样必须是软取。
  for (const svc of ['settings', 'credentials', 'llm']) {
    assert.equal(injectLine.includes(`'${svc}'`), false,
      `${svc} 不许进 inject：物化是增强能力，缺了它服务仍须启动`)
  }
})

// ── ★ 产品目录的**事实**必须由启动方传给 team-hub（2026-10-09 实测缺陷）──────────────
// 不传的后果实测过：团队中枢解析不出安装目录 ⇒ 密钥库落点校验过不去（INSTALL_DIR_UNRESOLVED）
// ⇒ **用户在面板里填密钥永远存不进去**，而报错只提"产品目录布局未确定"。
// `product/paths.mjs` 那条诊断的原话就是"请设置 LEGION_INSTALL_DIR **或由 Launcher 传入**"，
// 而本插件正是这台机器上的启动方。
test('★ team-hub 环境里必须带 LEGION_INSTALL_DIR（启动方的责任，漏了密钥就存不进）', () => {
  const env = buildTeamHubEnv({ baseEnv: {}, port: 8787, host: '127.0.0.1', token: '', installDir: 'D:/project/DSH/legion' })
  assert.equal(env.LEGION_INSTALL_DIR, 'D:/project/DSH/legion')
  // 没有安装目录时**不注入**（而不是注入空串）：空串会让下游以为"给了但为空"，
  // 而两者在下游是同一句 `INSTALL_DIR_UNRESOLVED`，可读性却完全不同。
  const without = buildTeamHubEnv({ baseEnv: {}, port: 8787, host: '127.0.0.1', token: '', installDir: '' })
  assert.equal('LEGION_INSTALL_DIR' in without, false)
})

test('★ 工作区只透传、绝不编默认值（规范：工作区是用户授权的项目目录）', () => {
  const none = buildTeamHubEnv({ baseEnv: {}, port: 8787, host: 'h', token: '', installDir: 'I' })
  assert.equal('LEGION_WORKSPACE_DIR' in none, false, '没给工作区就不许注入 —— 编一个会让"用户授权"失去意义')
  const given = buildTeamHubEnv({ baseEnv: {}, port: 8787, host: 'h', token: '', installDir: 'I', workspaceDir: 'D:/work' })
  assert.equal(given.LEGION_WORKSPACE_DIR, 'D:/work')
})

test('★ 原有注入一项不少（端口/地址/令牌/环境透传）', () => {
  const env = buildTeamHubEnv({
    baseEnv: { PATH: '/usr/bin', LEGION_WORKSPACE_DIR: 'D:/from-env' },
    port: 9000, host: '0.0.0.0', token: 'T', installDir: 'I',
  })
  assert.equal(env.TEAM_HUB_PORT, '9000')
  assert.equal(env.TEAM_HUB_HOST, '0.0.0.0')
  assert.equal(env.TEAM_HUB_TOKEN, 'T')
  assert.equal(env.PATH, '/usr/bin', 'baseEnv 要透传（子进程继承整个环境）')
  assert.equal(env.LEGION_WORKSPACE_DIR, 'D:/from-env', '环境里已有的工作区要跟着走（baseEnv 在前）')
})

test('★ **接线处**真的把 legionDir 当成安装目录传下去了（不是只写了助手函数）', () => {
  // ★ 这条是补出来的：上面那些用例验的是 `buildTeamHubEnv` 的行为，
  //   而用户遇到的那次失败断在**接线处** —— 助手函数写得再对，
  //   `env:` 里不传 `installDir` 就一样是"密钥存不进去"。
  //   实测：把接线处的 `installDir: legionDir` 去掉，只验助手函数的用例**全绿**。
  //
  //   > 一个"助手函数被验过"的读数，
  //   > 与一个"这个助手函数真的被接线处用上了"的读数，
  //   > 在两者都绿的时候是同一个东西 —— 差别只在接线处被改动的那一次。
  const wiring = /env: buildTeamHubEnv\(\{([\s\S]*?)\}\),/.exec(SRC)?.[1] ?? ''
  assert.ok(wiring.length > 0, '找不到 team-hub 的 env 接线')
  assert.match(wiring, /installDir:\s*legionDir/, '接线处必须把 legionDir 作为安装目录传下去')
  assert.match(wiring, /workspaceDir\b/, '工作区也要一起传（哪怕它常常是空的）')
})
