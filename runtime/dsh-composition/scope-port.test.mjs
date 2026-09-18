// runtime/dsh-composition/scope-port.test.mjs
// ============================================================================
// 「范围表 → 执行面端口」那一截的判据。
//
// 重心不是"我造出了一个函数"，而是：
//   ① 这个端口交到**真的** `createEnforcementBridge` 手上，越界调用真的被拒；
//   ② 缺席**如实**是 `absent`，而且它落到执行面就是**放行**（那是我们要堵的洞）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SCOPE_PORT_CODES,
  SCOPE_PORT_ENV_KEY,
  SCOPE_PORT_STATES,
  createFsResolver,
  createScopePort,
  scopePortFromEnv,
} from './scope-port.mjs'
import { createEnforcementBridge } from './tool-request.mjs'
import { PATH_SCOPE_VERSION } from './path-scope.mjs'

const CTX = Object.freeze({
  scope: 'legion', actor: 'e-1', action: 'file.write', taskId: 't-1',
  cwd: '/work', platform: 'linux',
})

const TABLE = Object.freeze({
  version: PATH_SCOPE_VERSION, platform: 'linux', read: ['/work'], write: ['/work/out'],
})

/** 内存解析器：目标原样，`exists` 恒真。够用来问"判定有没有被用上"。 */
const identity = {
  realpath: (p) => p,
  exists: () => true,
}

/** 一份投影，字段与 `projectToolRequest()` 的产物同名同义。 */
const proj = (canonicalTarget, direction) => ({ canonicalTarget, direction })

function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err?.code}：${err?.message}`)
  return err
}

// ---------------------------------------------------------------------------
// ① 端口真的能用：落到真桥上
// ---------------------------------------------------------------------------

test('① ★★★ 端口交到**真** `createEnforcementBridge` 上：越界写被 preExecute 与 guard 双双拒绝', async () => {
  const pathScope = createScopePort({ table: TABLE, ...identity })
  const bridge = createEnforcementBridge({
    context: CTX, pathScope, decide: () => ({ kind: 'allow' }),
  })
  // 强制面读数翻成 true —— 这就是 `production-scope-wiring` ① 里那个 false 的反面。
  assert.equal(bridge.enforcementSurfaces().pathScope, true)

  const execution = { name: 'write-file', callId: 'c1', arguments: { target: '/etc/passwd' } }
  const pre = await bridge.preExecute(execution)
  assert.equal(pre.kind, 'deny', `越界写竟然放行：${JSON.stringify(pre)}`)
  assert.match(pre.reason, /path-scope-outside-write/)
  // ★ 两个强制点都要拒绝（spec §6.6：pre-execute 提前拒，guard 最终复核）。
  assert.ok(typeof bridge.guard(execution) === 'string', 'guard 没有复核路径范围')
})

test('① ★★ 范围内的写**不被**这个端口拦（反向对照：证明它是判定，不是恒拒）', () => {
  const pathScope = createScopePort({ table: TABLE, ...identity })
  const inside = pathScope(proj('/work/out/a.txt', 'write'))
  assert.equal(inside.allowed, true, JSON.stringify(inside))
  const outside = pathScope(proj('/work/a.txt', 'write'))
  assert.equal(outside.allowed, false, '写在 /work 但不在 /work/out，应当被拒')
  assert.equal(outside.code, 'path-scope-outside-write')
})

test('① ★★ 读与写用**不同**的根：同一个目标在读范围里放行、在写范围里拒绝', () => {
  const pathScope = createScopePort({ table: TABLE, ...identity })
  // `/work/note.txt` 在 read 里，不在 write 里。
  assert.equal(pathScope(proj('/work/note.txt', 'read')).allowed, true)
  assert.equal(pathScope(proj('/work/note.txt', 'write')).allowed, false)
})

// ---------------------------------------------------------------------------
// ② 三个 fail-closed 决定
// ---------------------------------------------------------------------------

test('② ★★★ 方向未知 ⇒ 按 `write` 判（不是按 read，也不是放行）', () => {
  const pathScope = createScopePort({ table: TABLE, ...identity })
  // `/work/note.txt`：读得到、写不到。方向未知必须落到**写**那一边。
  const v = pathScope(proj('/work/note.txt', null))
  assert.equal(v.allowed, false, '方向未知竟然按 read 判了——那会让未登记工具绕过写范围')
  assert.equal(v.code, 'path-scope-outside-write')
  // ★ 与投影自己的口径同源（`tool-request.mjs:365`）：`unknown` 的方向是 write。
  assert.equal(pathScope(proj('/work/note.txt', 'nonsense')).direction, 'write')
})

test('② ★★★ 目标缺失 ⇒ 拒绝（"证明不了它在范围内"不是"它在范围内"）', () => {
  const pathScope = createScopePort({ table: TABLE, ...identity })
  for (const bad of [undefined, null, '', '   ', 42]) {
    const v = pathScope(proj(bad, 'read'))
    assert.equal(v.allowed, false, `目标 ${JSON.stringify(bad)} 竟然放行`)
    assert.equal(v.code, SCOPE_PORT_CODES.NO_TARGET)
  }
  // 投影本身不是对象 ⇒ 也拒绝，不抛。
  assert.equal(pathScope(null).allowed, false)
  assert.equal(pathScope('x').allowed, false)
})

test('② ★★ 装配期就校验：坏表**现在**抛，不留到第一次工具调用', () => {
  // 写范围不在读范围内 —— `path-scope.mjs` 的不变量。
  throwsCode(
    () => createScopePort({ table: { ...TABLE, read: ['/work'], write: ['/elsewhere'] }, ...identity }),
    'path-scope-write-not-in-read',
  )
  // 不认识的字段（`checkPathScope` 总会归一化 ⇒ 闭合字段校验）。
  throwsCode(
    () => createScopePort({ table: { ...TABLE, extra: 1 }, ...identity }),
    'path-scope-malformed',
  )
  throwsCode(() => createScopePort({ table: null, ...identity }), SCOPE_PORT_CODES.BAD_INPUT)
})

test('② ★★★ 不给解析器就不给默认值（否则"全拒"看起来像"范围表很严"）', () => {
  throwsCode(() => createScopePort({ table: TABLE }), SCOPE_PORT_CODES.BAD_INPUT)
  throwsCode(() => createScopePort({ table: TABLE, realpath: (p) => p }), SCOPE_PORT_CODES.BAD_INPUT)
})

test('② ★★ 解析器抛错 ⇒ 拒绝并带码，**不**把强制面炸掉', () => {
  const pathScope = createScopePort({
    table: TABLE,
    realpath: () => { const e = new Error('boom'); e.code = 'path-scope-symlink-escape'; throw e },
    exists: () => true,
  })
  const v = pathScope(proj('/work/a.txt', 'read'))
  assert.equal(v.allowed, false)
  // 归因到**真**的那个码，而不是一个笼统的"检查失败"。
  assert.equal(v.code, 'path-scope-symlink-escape')
})

// ---------------------------------------------------------------------------
// ③ 从环境来：缺席如实，坏文本具名
// ---------------------------------------------------------------------------

test('③ ★★★ 环境里没有那个键 ⇒ `absent` + `port: null`（不是"接了个空的"）', () => {
  const r = scopePortFromEnv({ env: {} })
  assert.equal(r.state, SCOPE_PORT_STATES.ABSENT)
  assert.equal(r.port, null)
  assert.equal(r.table, null)
  assert.match(r.reason, /不是/)
  // 空串与空白同等对待——"填了个空"与"没填"是同一个读数。
  assert.equal(scopePortFromEnv({ env: { [SCOPE_PORT_ENV_KEY]: '  ' } }).state, SCOPE_PORT_STATES.ABSENT)
})

test('③ ★★★ 缺席落到**真**桥上就是放行：这就是要堵的那个洞', async () => {
  // 用生产今天的形状（`pathScope: null`）装一条桥，越界调用**放行**。
  const absent = scopePortFromEnv({ env: {} })
  const bridge = createEnforcementBridge({
    context: CTX, pathScope: absent.port, decide: () => ({ kind: 'allow' }),
  })
  assert.equal(bridge.enforcementSurfaces().pathScope, false, 'absent 竟然报成已接入')
  const execution = { name: 'write-file', callId: 'c9', arguments: { target: '/etc/passwd' } }
  const pre = await bridge.preExecute(execution)
  assert.equal(pre.kind, 'allow',
    '缺席时竟然拒绝了——那"没接"就是 fail closed 的，本节的结论要改（那会是个好消息）')

  // 同一路调用，配上表（`LEGION_CWD` 收窄写范围）之后被拒。
  const present = scopePortFromEnv({
    env: {
      [SCOPE_PORT_ENV_KEY]: JSON.stringify({ platform: 'linux', read: ['/work'], write: ['/work/out'] }),
      LEGION_CWD: '/work',
    },
  })
  assert.equal(present.state, SCOPE_PORT_STATES.CONFIGURED)
  const wired = createEnforcementBridge({
    context: CTX, pathScope: present.port, decide: () => ({ kind: 'allow' }),
  })
  const denied = await wired.preExecute({ name: 'write-file', callId: 'c10', arguments: { target: '/etc/passwd' } })
  assert.equal(denied.kind, 'deny', '配了表之后同一路调用仍然放行')
})

test('③ ★★★ 环境里那份文本不是 JSON ⇒ 具名拒绝，不许静默当成"没配"', () => {
  // ★ 这一条是本模块最容易写错的地方：`JSON.parse` 失败若被吞掉，
  //   表现就是"这个部署好像没配范围表"——与"确实没配"同形。
  throwsCode(
    () => scopePortFromEnv({ env: { [SCOPE_PORT_ENV_KEY]: 'not json{' } }),
    SCOPE_PORT_CODES.BAD_TABLE_TEXT,
  )
})

test('③ ★★ 环境里是对象（而不是 JSON 文本）也接受', () => {
  const r = scopePortFromEnv({
    env: { [SCOPE_PORT_ENV_KEY]: { platform: 'linux', read: ['/work'], write: [] }, LEGION_CWD: '/work' },
  })
  assert.equal(r.state, SCOPE_PORT_STATES.CONFIGURED)
  assert.deepEqual([...r.table.read], ['/work'])
})

test('③ ★★★ 有写根却没有工作区根 ⇒ 具名拒绝（收窄这条边界不许静默消失）', () => {
  // ★ 复用 `scope-table-binding.mjs` 的第三条拒绝——本模块**不**第二次实现它。
  throwsCode(
    () => scopePortFromEnv({
      env: { [SCOPE_PORT_ENV_KEY]: JSON.stringify({ platform: 'linux', read: ['/work'], write: ['/work/out'] }) },
    }),
    'scope-table-workspace-missing',
  )
  // 反向对照：写根为空时**不需要**工作区根，同一份环境就通了 ⇒
  // 上一条拒绝的理由确实是"有写根却没根"，不是"这份配置有问题"。
  const ok = scopePortFromEnv({
    env: { [SCOPE_PORT_ENV_KEY]: JSON.stringify({ platform: 'linux', read: ['/work'], write: [] }) },
  })
  assert.equal(ok.state, SCOPE_PORT_STATES.CONFIGURED)
})

// ---------------------------------------------------------------------------
// ④ 真文件系统解析器：链接逃逸
// ---------------------------------------------------------------------------

test('④ ★★★ `createFsResolver()` 接的是**真**文件系统：范围外拒绝、范围内放行', () => {
  const base = mkdtempSync(join(tmpdir(), 'scope-port-'))
  const work = join(base, 'work')
  const outside = join(base, 'outside')
  mkdirSync(join(work, 'out'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  const platform = process.platform
  const table = { version: PATH_SCOPE_VERSION, platform, read: [work], write: [join(work, 'out')] }
  const pathScope = createScopePort({ table, ...createFsResolver() })

  // 尚未创建的文件（写范围之内）⇒ 放行（`createsNew` 那条路，且真 fs 真的被问了）。
  const fresh = pathScope(proj(join(work, 'out', 'brand-new.txt'), 'write'))
  assert.equal(fresh.allowed, true, `范围内新建竟然被拒：${JSON.stringify(fresh)}`)
  // 范围外（真实存在的目录）⇒ 拒绝。
  const out = pathScope(proj(join(outside, 'x.txt'), 'write'))
  assert.equal(out.allowed, false, '真实范围外竟然放行')
  // 读范围之内、写范围之外的**真实存在**文件 ⇒ 读放行、写拒绝。
  writeFileSync(join(work, 'note.txt'), 'n')
  assert.equal(pathScope(proj(join(work, 'note.txt'), 'read')).allowed, true)
  assert.equal(pathScope(proj(join(work, 'note.txt'), 'write')).allowed, false)
})

test('④ ★★★ 链接逃逸：链接指向范围外 ⇒ 拒绝（确定性，不依赖平台能建链接）', () => {
  // ★ 这条**故意用注入式解析器 + POSIX 路径**，不走真 fs：
  //   Windows 上 `symlinkSync` 常以 EPERM 失败，而"建不了链接 ⇒ 提前 return"
  //   会让这条判据在摘要里显示为"通过"——本仓反复记账的那个陷阱。
  //   实测还发现：`checkPathScope` **只在 `exists` 报真时才调 `realpath`**，
  //   所以这里 `exists = () => true` 是必须的（否则解析器根本不被调用）。
  const work = '/base/work'
  const outDir = '/base/work/out'
  const outside = '/base/outside'
  const linkPath = '/base/work/out/link'
  const secret = '/base/work/out/link/secret.txt'
  const table = { version: PATH_SCOPE_VERSION, platform: 'linux', read: [work], write: [outDir] }

  const expand = (p) => (String(p) === linkPath || String(p).startsWith(`${linkPath}/`)
    ? outside + String(p).slice(linkPath.length)
    : p)

  const pathScope = createScopePort({ table, realpath: expand, exists: () => true })
  // 直接写在范围内 ⇒ 放行（反向对照：不是恒拒）。
  assert.equal(pathScope(proj(`${outDir}/a.txt`, 'write')).allowed, true)
  // 经链接写到范围外 ⇒ 拒绝。
  const escaped = pathScope(proj(secret, 'write'))
  assert.equal(escaped.allowed, false, '经符号链接写到范围外竟然放行')
  assert.equal(escaped.code, 'path-scope-symlink-escape')

  // ★ 反向对照：同一个目标，解析器**不展开**时是放行的。
  //   少了这一条，"拒绝"可能只是"这个目标本来就该拒绝"。
  const noExpand = createScopePort({ table, realpath: (p) => p, exists: () => true })
  assert.equal(noExpand(proj(secret, 'write')).allowed, true,
    '解析器不展开时竟然也拒绝——那上面那条拒绝证明不了"是链接导致它出界"')
})

test('④ ★★ 真 fs 那条线：链接能建就顺带验一次（建不了则**如实**记下，不冒充通过）', () => {
  const base = mkdtempSync(join(tmpdir(), 'scope-port-link-'))
  const work = join(base, 'work')
  const outDir = join(work, 'out')
  const outside = join(base, 'outside')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'x')
  const linkPath = join(outDir, 'link')
  try {
    symlinkSync(outside, linkPath, 'dir')
  } catch (err) {
    // 建不了链接不是"判据通过"，是一个**有名字的平台事实**。
    // 本平台（Windows 非开发者模式）实测 EPERM ⇒ 这一条只报告，不假装验过。
    assert.ok(['EPERM', 'EACCES', 'UNKNOWN', 'ENOTSUP'].includes(err.code),
      `建链接失败的原因不是权限/不支持（${err.code}）——先查清楚，别把它当成"平台就这样"`)
    console.log(`  ⚠ 本平台建不了目录链接（${err.code}）⇒ 真 fs 的链接逃逸未验证；`
      + '逃逸判定由上一节的确定性用例覆盖，不靠这一条')
    return
  }
  const platform = process.platform
  const table = { version: PATH_SCOPE_VERSION, platform, read: [work], write: [outDir] }
  const pathScope = createScopePort({ table, ...createFsResolver() })
  const escaped = pathScope(proj(join(linkPath, 'secret.txt'), 'write'))
  assert.equal(escaped.allowed, false, '经真符号链接写到范围外竟然放行')
  assert.equal(escaped.code, 'path-scope-symlink-escape')
})
