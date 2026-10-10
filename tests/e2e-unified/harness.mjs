/**
 * harness.mjs — 三端统一 E2E 的共用夹具（T-195）。
 *
 * ## 为什么三个端要共用一份夹具
 *
 * 用户要的是「**统一**测试」。三端各写一套自己的夹具，加起来只是三堆测试：
 * 它们各自都能绿，却回答不了*"同一个用户动作在三个端上是不是同一件事"*。
 * 共用一个 Hub、一份种子、一条时间线，才让「三端」这个说法有意义。
 *
 *   > 三套各自起自己那个世界、各自断言的测试，
 *   > 与一套"三端说的是同一个世界"的测试，在覆盖面上看起来一样——
 *   > 只不过前者的"一致"从来没有被任何断言检查过。
 *
 * ## 起的是真 Hub，不是替身
 *
 * `startHub()` 导入真实的 `team-hub/server.mjs`，用临时库、临时端口。
 * 这是本仓库既有的本地起服手法（`team-hub/mobile-api-contract.test.mjs:30-38`），
 * 不是本夹具发明的。
 *
 * ⚠️ `server.mjs` 在**模块求值期**就读配置并开库，所以环境变量必须在 `import` **之前**设好。
 * 这也是 `startHub()` 需要 `await import()` 而不能静态 import 的原因。
 */
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { browserProbe, launchBrowser } from '../../scripts/e2e/cdp.mjs'

/** 仓库根（本文件在 tests/e2e-unified/ 下）。 */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 新建一个用完即删的临时目录。 */
export function tempDir(prefix = 'legion-e2e-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * 起一个**隔离的真 Hub**。
 *
 * 隔离的三件事（缺一个就会污染开发者的真实环境）：
 *   · 独立的 SQLite 库文件（临时目录）；
 *   · 独立的端口（`listen(0)` 由 OS 分配，避免撞上正在跑的 :8787）；
 *   · 独立的身份密钥与远端鉴权开关。
 *
 * @param {{ releasesDir?: string|null, remoteAuth?: boolean, token?: string, extras?: Record<string,string> }} [opts]
 * @returns {Promise<{ base: string, token: string, mod: object, db: object, close: () => Promise<void> }>}
 */
export async function startHub({
  releasesDir = null,
  remoteAuth = true,
  token = 'e2e-hub-token',
  extras = {},
} = {}) {
  const dir = tempDir('legion-e2e-hub-')
  process.env.TEAM_HUB_DB = join(dir, 'team.db')
  process.env.TEAM_HUB_HOST = '127.0.0.1'
  process.env.TEAM_HUB_TOKEN = token
  process.env.LEGION_IDENTITY_KEY = 'e2e-identity-key-0123456789abcdef'
  if (remoteAuth) process.env.LEGION_REMOTE_AUTH = '1'
  else delete process.env.LEGION_REMOTE_AUTH
  if (releasesDir) process.env.LEGION_RELEASES_DIR = releasesDir
  else delete process.env.LEGION_RELEASES_DIR
  for (const [k, v] of Object.entries(extras)) process.env[k] = v

  const mod = await import(new URL('../../team-hub/server.mjs', import.meta.url).href)
  await new Promise((resolve) => mod.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${mod.server.address().port}`

  return {
    base,
    token,
    dir,
    mod,
    db: mod.db,
    async close() {
      try { mod.nodeGateway?.close?.() } catch { /* 已关 */ }
      try { mod.server.closeAllConnections?.() } catch { /* 无连接 */ }
      try { mod.server.close() } catch { /* 已关 */ }
      try { mod.db.close() } catch { /* 已关 */ }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 对 Hub 发一次请求；返回 `{status, json, text, headers}`。 */
export async function call(base, method, path, { body, token, headers: extra } = {}) {
  const headers = { ...extra }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON（静态资源） */ }
  return { status: res.status, json, text, headers: res.headers }
}

/**
 * 给 Hub 种一个「有用户、有空间角色、有 Agent」的可用世界。
 *
 * 每一步都是必需品，缺一个后面的动作会以**看不出真因**的方式失败：
 *   · 不 bootstrap → 登录 401，而手机端只会停在登录页；
 *   · 不给空间角色 → `/api/agents` 403，前端落到"没有 Agent"；
 *   · 不同步 roster → Agent 列表为空，派单没有目标。
 */
export async function seedWorld(hub, { scope = 'default', password = 'e2e-password-1' } = {}) {
  const NAME = 'e2e-user'

  await call(hub.base, 'POST', '/api/identity/bootstrap', {
    body: { name: NAME, password }, token: hub.token,
  })
  const login = await call(hub.base, 'POST', '/api/identity/login', {
    body: { name: NAME, password, label: 'e2e' },
  })
  if (login.status !== 200) throw new Error(`种子登录失败：${login.status} ${login.text}`)
  const access = login.json.accessToken
  const userId = login.json.userId

  // 空间角色：授权看的就是它（不是系统角色）。
  hub.db.prepare('INSERT OR REPLACE INTO hub_space_roles VALUES (?,?,?,?,?)')
    .run(userId, scope, 'member', 'system', Date.now())

  // Agent 来自 roster 同步——手机端"派单给谁"读的就是它。
  const ins = hub.db.prepare('INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?,?,?,?,?,?)')
  ins.run(scope, 'general', '总指挥', 'agent', '🤖', 1)
  ins.run(scope, 'coder', '编码兵', 'agent', '🤖', 2)
  hub.mod.agentConversations.syncRoster()

  return { access, userId, refresh: login.json.refreshToken, scope, name: NAME, password }
}

/** 探测浏览器；不可用时返回 null（由调用方显式 SKIP，不伪造通过）。 */
export function probeBrowser() {
  const probe = browserProbe()
  return probe.available ? probe : null
}

/**
 * 起一个**移动仿真**浏览器页。
 * 找不到浏览器时返回 `null` —— 调用方必须显式 SKIP（`docs/E2E.md` §3 的纪律）。
 */
export async function openMobilePage({ mobile = true, width, height } = {}) {
  if (!probeBrowser()) return null
  const browser = await launchBrowser({ mobile, headless: true, width, height })
  const page = await browser.newPage()
  return { browser, page, close: async () => { await page.close(); await browser.close() } }
}

/** 把一段内容写进临时目录下的某个相对路径（必要时建父目录）。 */
export function writeTempFile(dir, name, contents) {
  const p = join(dir, name)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, contents)
  return p
}

export { once }
