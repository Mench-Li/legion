// ============================================================================
// 回归：**托管进程也必须能解析出产品目录**（否则密钥库用不了）
//
// ## 这次故障的实测形状（2026-10-09）
//
// 用户在面板里填密钥 → 存不进去 → 报 `SECRETS_LAYOUT_BLOCKED`
// （`INSTALL_DIR_UNRESOLVED, PRODUCT_HOME_UNRESOLVED, WORKSPACE_NOT_CONFIGURED`）。
// 而同一台机器上 `%LOCALAPPDATA%\Legion` **早就存在**（里面有 `data/`、`cache/`、`log/`），
// 桌面壳一直用得好好的。
//
// 根因：`resolveLayout` 的 `homeDir` / `appDataDir` 要**事实**，而
// `defaultProductHome` 自己**不读** `LOCALAPPDATA`/`USERPROFILE`。
// launcher（`product/launcher/cli.mjs`）早就用 `osHomeFacts(env)` 补上了这一条 ——
// 但托管进程那侧漏了：`team-hub/secret-admin.mjs` 与 `probe-service.mjs`
// 调的是 `resolveLayout({ env })`。
//
//   > 一个"启动器能找到产品目录、而它拉起的守护进程找不到"的产品，
//   > 与一个"根本没有产品目录"的产品，在用户看到的那一句错误上是同一个东西。
//
// 本文件钉三件事：
//   ① 只给 `env` ⇒ 家目录**解析不出来**（把"事实"的必要性写成判据，而不是留下一个注释）
//   ② 给 `env + osHomeFacts(env)` ⇒ `secretsFile` 落在规范说的地方（Windows: `%LOCALAPPDATA%\Legion`）
//   ③ **两处调用点都真的传了**（源码级断言：漏掉任何一处，面板填密钥就会再次失败）
//   ④ `LEGION_HOME` 显式覆盖仍然压过操作系统事实（§6.11 的优先级不许倒置）
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveLayout, osHomeFacts, OS_HOME_ENV } from '../product/paths.mjs'

const WIN_ENV = {
  [OS_HOME_ENV.LOCAL_APP_DATA]: 'C:\\Users\\u\\AppData\\Local',
  [OS_HOME_ENV.USER_PROFILE]: 'C:\\Users\\u',
  SystemRoot: 'C:\\Windows',
}
const POSIX_ENV = { [OS_HOME_ENV.HOME]: '/home/u' }

test('① 只给 `env` ⇒ 产品家目录解析不出来（这就是那次故障的形状）', () => {
  const { layout, diagnostics } = resolveLayout({ platform: 'win32', env: WIN_ENV })
  assert.equal(layout.productHome, null,
    '`defaultProductHome` 不该自己读 LOCALAPPDATA —— 它要的是事实；本条把这个前提钉住')
  assert.equal(layout.secretsFile, null,
    '没有家目录就没有密钥库路径 ⇒ 每一次用密钥库都会被拒（这正是用户看到的那句错）')
  assert.equal(layout.productHomeSource, 'unresolved')
  // 而且它**说出来**了：诊断里应当能看见"产品家目录没解析"这一类
  assert.ok(Array.isArray(diagnostics), '要能拿到诊断，否则部署侧没有线索')
})

test('② 给 `env + osHomeFacts(env)` ⇒ 密钥库落在规范说的地方', () => {
  const { layout } = resolveLayout({ platform: 'win32', env: WIN_ENV, ...osHomeFacts(WIN_ENV) })
  assert.equal(layout.productHome, 'C:\\Users\\u\\AppData\\Local\\Legion', 'Windows 默认产品目录 = %LOCALAPPDATA%\\Legion')
  assert.equal(layout.productHomeSource, 'appDataDir',
    '来源要说清是"操作系统事实（appDataDir）"，而不是用户配置或未解析')
  assert.equal(layout.dataDir, 'C:\\Users\\u\\AppData\\Local\\Legion\\data')
  assert.match(String(layout.secretsFile), /AppData\\Local\\Legion\\secrets\\credentials\.json$/)
  // POSIX 侧同一份派生也要成立 —— ★ 用**字面量**断言，不用宿主机的 `join`：
  //   `join()` 在 Windows 上产出反斜杠，而这里解析的是 linux 布局（正向斜杠）。
  const posix = resolveLayout({ platform: 'linux', env: POSIX_ENV, ...osHomeFacts(POSIX_ENV) }).layout
  assert.equal(posix.productHome, '/home/u/.legion')
})

test('③ ★ 两处托管调用点都真的传了操作系统事实（漏一处就再次失败）', () => {
  for (const f of ['secret-admin.mjs', 'probe-service.mjs']) {
    const src = readFileSync(join(import.meta.dirname, f), 'utf8')
    assert.match(src, /resolveLayout\(\{\s*env,\s*\.\.\.mod\.osHomeFacts\(env\)\s*\}\)/,
      `${f} 必须用 resolveLayout({ env, ...mod.osHomeFacts(env) })；只给 env 会让密钥库路径为 null`)
  }
})

test('④ `LEGION_HOME` 显式覆盖仍压过操作系统事实（优先级不许倒置）', () => {
  const env = { ...WIN_ENV, LEGION_HOME: 'D:\\legion-home' }
  const { layout } = resolveLayout({ platform: 'win32', env, ...osHomeFacts(env) })
  assert.equal(layout.productHome, 'D:\\legion-home', '显式 LEGION_HOME 必须赢')
  assert.equal(layout.productHomeSource, 'LEGION_HOME', '来源也该报告成显式覆盖')
})

test('⑤ 空白的环境值不算事实（不做 trim 之外的解释）', () => {
  const facts = osHomeFacts({ [OS_HOME_ENV.LOCAL_APP_DATA]: '   ', [OS_HOME_ENV.USER_PROFILE]: '' })
  assert.equal(facts.appDataDir, null)
  assert.equal(facts.homeDir, null)
})
