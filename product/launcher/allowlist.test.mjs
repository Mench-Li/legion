// product/launcher/env.test.mjs
// ============================================================================
// PRT-251 / spec §10「环境变量……遵循最小权限」的判据。
//
// 这一组守的是一条**静默越权**路径：`{ ...process.env, ...覆盖 }` 不会报错，
// 只会让 Launcher 进程里出现过的每一个凭证进入每个子进程。
// 后果不会立刻显现——它显现的时机是「白板进程的崩溃转储被附进诊断包」。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { OS_ESSENTIAL_ENV, buildChildEnv, isSecretLikeKey, secretSurfaceOf } from './allowlist.mjs'
import { PROCESS_SPECS, specFor } from '../process-manifest.mjs'

const HUB = specFor('team-hub')

test('buildChildEnv：只放行声明过的键与平台必需键，其余一律丢弃', () => {
  const baseEnv = {
    SystemRoot: 'C:\\Windows',
    PATH: 'C:\\Windows\\System32',
    TEAM_HUB_PORT: '8787',
    TEAM_HUB_TOKEN: 'hub-token',
    // 下面这些是「宿主进程里恰好存在」的东西，不该进子进程
    SOME_OTHER_TOOL_API_KEY: 'sk-should-not-leak',
    CI_JOB_JWT: 'eyJhbGciOi',
    NPM_TOKEN: 'npm_x',
    RANDOM_SETTING: 'x',
  }
  const { env, dropped } = buildChildEnv({ spec: HUB, baseEnv })
  assert.equal(env.SystemRoot, 'C:\\Windows', '平台必需键必须放行，否则连 Node 都起不来')
  assert.equal(env.PATH, 'C:\\Windows\\System32')
  assert.equal(env.TEAM_HUB_PORT, '8787')
  assert.equal(env.TEAM_HUB_TOKEN, 'hub-token')
  assert.equal('SOME_OTHER_TOOL_API_KEY' in env, false)
  assert.equal('CI_JOB_JWT' in env, false)
  assert.equal('NPM_TOKEN' in env, false)
  assert.equal('RANDOM_SETTING' in env, false)
  // dropped 只给键名不给值 —— 「为什么这个变量没传下去」应当可被回答
  assert.deepEqual([...dropped].sort(), ['CI_JOB_JWT', 'NPM_TOKEN', 'RANDOM_SETTING', 'SOME_OTHER_TOOL_API_KEY'])
  assert.equal(JSON.stringify(dropped).includes('sk-should-not-leak'), false)
})

test('buildChildEnv：平台必需键里不得藏凭证键（否则白名单本身就是一条越权通道）', () => {
  for (const key of OS_ESSENTIAL_ENV) {
    assert.equal(isSecretLikeKey(key), false, `${key} 像凭证载体，不得出现在平台必需键里`)
  }
})

test('buildChildEnv：写入未声明的键必须抛错（漏声明 = 清单与实现不一致）', () => {
  assert.throws(
    () => buildChildEnv({ spec: HUB, baseEnv: {}, values: { TEAM_HUB_GIZMO: '1' } }),
    /未在进程 team-hub 的 envNames 中声明/,
  )
  // 已声明的可以写
  const ok = buildChildEnv({ spec: HUB, baseEnv: {}, values: { TEAM_HUB_PORT: '1' } })
  assert.equal(ok.env.TEAM_HUB_PORT, '1')
  // extraAllowed 是显式的逃生口，必须由调用方写明
  const extra = buildChildEnv({ spec: HUB, baseEnv: {}, values: { LEGION_EXTRA: 'x' }, extraAllowed: ['LEGION_EXTRA'] })
  assert.equal(extra.env.LEGION_EXTRA, 'x')
})

test('buildChildEnv：undefined 值不写入（不能把 undefined 变成 "undefined" 字符串）', () => {
  const { env } = buildChildEnv({ spec: HUB, baseEnv: { TEAM_HUB_PORT: undefined, PATH: '/usr/bin' } })
  assert.equal('TEAM_HUB_PORT' in env, false)
  assert.equal(env.PATH, '/usr/bin')
})

test('secretSurfaceOf：能回答「哪几个进程拿得到凭证键」', () => {
  const surface = secretSurfaceOf(PROCESS_SPECS)
  const byProcess = Object.fromEntries(surface.map((r) => [r.process, r.keys]))
  assert.deepEqual(byProcess['team-hub'], ['TEAM_HUB_TOKEN'])
  assert.deepEqual(byProcess.workbench, ['TEAM_HUB_TOKEN', 'DSH_WORKBENCH_TOKEN'])
  assert.deepEqual(byProcess.whiteboard, ['WHITEBOARD_TOKEN'])
  // ★ PRT-253 续批四**改掉了这一条的前提**，理由必须写在这里而不是只写在别处。
  //
  //   原文（本批之前）是：`assert.equal('runtime' in byProcess, false)`，
  //   理由是「模型密钥走 secretRef 解析，不走环境变量」。那个理由**仍然成立**
  //   ——runtime 依旧拿不到模型密钥。
  //
  //   但 `LEGION_RUNTIME_TOKEN` 不是模型密钥：它是 Runtime Contract 的
  //   **服务端凭证**，由 Launcher 每次启动生成一份，只注入 runtime 与
  //   orchestrator 两个进程。服务端要拿它去比对 worker 出示的那一份，
  //   因此它**必须**在 runtime 进程里；而它不能经发布文件/状态文件传递
  //   （那些是**落盘**的，凭证落盘是被禁止的），环境变量是唯一既不落盘、
  //   又只在该进程内可见的通道。三条纪律写在
  //   `runtime-contract-endpoint.mjs` 的 `generateRuntimeToken` 上。
  //
  //   ⚠️ 口径仍然是**逐字列举**（deepEqual），不是"表里没有它"：
  //   后者会让"有人又给 runtime 加了一个 *_TOKEN"在断言层面看不出来。
  //   这正是这条用例原本要保住的性质，本批没有把它放松。
  assert.deepEqual(byProcess.runtime, ['LEGION_RUNTIME_TOKEN'],
    'runtime 只应当持有契约服务端那一份凭证；模型密钥仍然走 secretRef 解析，不得出现')
  // orchestrator 需要 hub 访问令牌才能认领任务，另加与 runtime 同一份的契约凭证；
  // 这两条是它唯一应当持有的凭证。
  assert.deepEqual(byProcess.orchestrator, ['TEAM_HUB_TOKEN', 'LEGION_RUNTIME_TOKEN'])
  // 反向锚：契约凭证**只**进了这两个进程，别的进程一个字节都拿不到。
  for (const proc of ['team-hub', 'workbench', 'whiteboard']) {
    assert.equal((byProcess[proc] ?? []).includes('LEGION_RUNTIME_TOKEN'), false,
      `进程 ${proc} 拿到了契约凭证——它不该拿（spec §6.7 密钥只注入需要它的进程）`)
  }
})
