// runtime/dsh-composition/scope-table-binding.test.mjs
// ============================================================================
// 「部署配置的范围表 → 执行面 pathScope 端口」装配点的判据。
//
// 重心不是"正常路径能跑"，而是**三条装配期拒绝** + 一条**往返**：
// 拒绝它们，才能防止"没配上"被读成"这次没有东西要限制"（= 放行一切）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SCOPE_TABLE_CODES, bindScopeTable } from './scope-table-binding.mjs'
// ★ 跨到真正的读者：装配产物到底能不能用，只有它说了算。
import { checkPathScope, narrowScopeToWorkspace } from './path-scope.mjs'

const V = 'legion/path-scope@1'
/** 一份合法的部署声明。 */
const decl = (over = {}) => ({
  version: V,
  platform: 'linux',
  read: ['/work'],
  write: ['/work/sub'],
  ...over,
})

/** 收一个具名错误。 */
function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`)
  return err
}

// ---------------------------------------------------------------------------
// ① ★★★ 往返：产物必须能被**真的** `checkPathScope` 直接吃下去
// ---------------------------------------------------------------------------

test('① ★★★ 装配产物交给**真** `checkPathScope` 能用（不是只长得像一张范围表）', () => {
  // ★ 这一条抓过我自己的一个真错：我第一版多带了一个 `bindingVersion` 字段，
  //   而 `checkPathScope` 内部**总是** `normalizeScope(scope)`（闭合字段校验）
  //   ⇒ 产物一交给真读者就抛 `path-scope-malformed`。
  //   而"只看产物自己字段清单"的断言当时是**绿的**（那个字段就在清单里，看着合理）。
  //
  //   > 一个"多带一个字段"的装配产物，与一个能用的装配产物，
  //   > 在它自己的字段清单上长得一样——只不过前者在**下一个**读它的人那里才炸。
  const scope = bindScopeTable({ declaration: decl(), workspaceRoot: '/work' })

  const inside = checkPathScope({
    target: '/work/a.txt', scope, direction: 'read', realpath: (p) => p, exists: () => true,
  })
  assert.equal(inside.allowed, true, inside.reason ?? '')

  // 反向对照：工作区**外**的读也要真的走判定，而不是被这条断言放过。
  // （读根允许在工作区外，见 ⑥；这里用一个连读根都不在的目标。）
  const outsideRoots = checkPathScope({
    target: '/etc/passwd', scope, direction: 'read', realpath: (p) => p, exists: () => true,
  })
  assert.equal(outsideRoots.allowed, false)
})

test('① ★★ 写范围被真的收窄到工作区（对着真函数核，不抄我的期望值）', () => {
  const scope = bindScopeTable({
    declaration: decl({ read: ['/a', '/work'], write: ['/work'] }),
    workspaceRoot: '/work/sub',
  })
  const expected = narrowScopeToWorkspace({
    scope: { version: V, platform: 'linux', read: ['/a', '/work'], write: ['/work'] },
    workspaceRoot: '/work/sub',
  })
  assert.deepEqual([...scope.write], [...expected.write])
  // 而且它**真的**比声明更深（否则上面那条比对可能只是"两边都没收窄"）。
  assert.deepEqual([...scope.write], ['/work/sub'])
  assert.equal(scope.cwd, '/work/sub')
})

// ---------------------------------------------------------------------------
// ② 没有表
// ---------------------------------------------------------------------------

test('② ★★★ 没有表 ⇒ 具名拒绝，**不是**"没有范围表"（那等于放行一切）', () => {
  for (const missing of [undefined, null]) {
    const err = throwsCode(
      () => bindScopeTable({ declaration: missing, workspaceRoot: '/work' }),
      SCOPE_TABLE_CODES.TABLE_MISSING,
    )
    // ★ 消息必须说清后果，否则读的人会把它当成一句形式检查。
    assert.match(err.message, /放行一切/)
  }
  // 具名拒绝：非对象也不算"有表"。
  throwsCode(() => bindScopeTable({ declaration: 'nope', workspaceRoot: '/work' }), SCOPE_TABLE_CODES.BAD_INPUT)
  throwsCode(() => bindScopeTable({ declaration: ['x'], workspaceRoot: '/work' }), SCOPE_TABLE_CODES.BAD_INPUT)
})

test('② ★★★ 拒绝的理由是**真的**：null 端口在 `tool-request` 那一侧就是放行', () => {
  // 这条把 ② 的"为什么"钉在**行为**上，而不是钉在我的说法上。
  // `tool-request.mjs:731` 的形状是 `if (pathScope === null) return undefined`（放行）。
  // 这里用**同一个形状**复现它：证明"送出 null"确实等于"什么都不限制"。
  const decisionWith = (pathScope) => {
    if (pathScope === null) return 'allow'          // ← 生产里那一行的形状
    return pathScope({ target: '/etc/passwd' }).allowed ? 'allow' : 'deny'
  }
  assert.equal(decisionWith(null), 'allow', '前提变了：null 不再等于放行，请重写本节')
  const scope = bindScopeTable({ declaration: decl(), workspaceRoot: '/work' })
  assert.equal(
    decisionWith(() => checkPathScope({ target: '/etc/passwd', scope, direction: 'read', realpath: (p) => p, exists: () => true })),
    'deny',
  )
})

// ---------------------------------------------------------------------------
// ③ 有表但没有读根
// ---------------------------------------------------------------------------

test('③ ★★★ 有表但一条读根都没有 ⇒ 装配期就说配置错，不留到每次调用', () => {
  const err = throwsCode(
    () => bindScopeTable({ declaration: decl({ read: [], write: [] }), workspaceRoot: '/work' }),
    SCOPE_TABLE_CODES.TABLE_EMPTY,
  )
  assert.match(err.message, /配置错误/)
  // ★ 如实：它不是安全漏洞。`checkPathScope` 在无读根时本来就 fail closed。
  //   拒绝它的理由是"把配置错误表现成工具坏了"。
  assert.equal(
    checkPathScope({ target: '/work/a', scope: { version: V, platform: 'linux', read: [], write: [] }, direction: 'read', realpath: (p) => p, exists: () => true }).allowed,
    false,
    '前提变了：无读根不再 fail closed，请重写本节',
  )
})

// ---------------------------------------------------------------------------
// ④ 有写根却没给工作区根
// ---------------------------------------------------------------------------

test('④ ★★★ 有写根但没工作区根 ⇒ 拒绝（那条边界会**静默消失**）', () => {
  for (const ws of [undefined, null, '', '   ']) {
    throwsCode(
      () => bindScopeTable({ declaration: decl(), workspaceRoot: ws }),
      SCOPE_TABLE_CODES.WORKSPACE_MISSING,
    )
  }
})

test('④ ★★★ 拒绝的理由是**真的**：不给工作区根时收窄不会发生（边界真的消失）', () => {
  // ★ 写根必须 ⊆ 读根（`normalizeScope` 的不变量），所以 `/elsewhere` 也要在读根里。
  const wide = decl({ read: ['/elsewhere', '/work'], write: ['/elsewhere'] })
  // 对照：真函数在 workspaceRoot 为空时**原样返回**。
  const unNarrowed = narrowScopeToWorkspace({ scope: wide, workspaceRoot: null })
  assert.deepEqual([...unNarrowed.write], ['/elsewhere'], '前提变了：不收窄不再保留写根，请重写本节')
  // ⇒ 于是"写被限制在工作区内"这条边界不见了，而字段与判定函数一如既往。
  // 有工作区根时它才真的收窄（或按 OUT_OF_SCOPE 具名拒绝）。
  throwsCode(
    () => bindScopeTable({ declaration: wide, workspaceRoot: '/work' }),
    'path-scope-out-of-scope',
  )
})

test('④ ★★ 只读岗位（写根为空）**不**需要工作区根——别把正当声明判成非法', () => {
  const scope = bindScopeTable({ declaration: decl({ read: ['/work'], write: [] }), workspaceRoot: null })
  assert.deepEqual([...scope.write], [])
  assert.deepEqual([...scope.read], ['/work'])
})

// ---------------------------------------------------------------------------
// ⑤ 读根允许在工作区外（不许自造约束）
// ---------------------------------------------------------------------------

test('⑤ ★★★ 读根**允许**在工作区之外——这是既有设计，不是漏检', () => {
  // 我第一版加过一条"读根必须在工作区内"，用真函数一跑就发现
  // `narrowScopeToWorkspace` **只收窄 write**、`read` 原样保留。
  // 那条检查是自造的、与实现不符的约束，会把一个正当声明判成非法。
  const scope = bindScopeTable({
    declaration: decl({ read: ['/shared/refs', '/work'], write: ['/work'] }),
    workspaceRoot: '/work',
  })
  assert.deepEqual([...scope.read], ['/shared/refs', '/work'])
  const v = checkPathScope({
    target: '/shared/refs/doc.md', scope, direction: 'read', realpath: (p) => p, exists: () => true,
  })
  assert.equal(v.allowed, true, v.reason ?? '')
  // 反向对照：写**仍然**只限工作区内。
  const w = checkPathScope({
    target: '/shared/refs/doc.md', scope, direction: 'write', realpath: (p) => p, exists: () => true,
  })
  assert.equal(w.allowed, false)
})

// ---------------------------------------------------------------------------
// ⑥ 形状类错误原样上抛
// ---------------------------------------------------------------------------

test('⑥ ★★ 范围表自身的具名错误**原样上抛**，不被包成装配失败', () => {
  // ★ 理由与 executor.mjs 那条注释同源：把它们压成"装配失败"会让排障指向本文件，
  //   而真正的修法在范围表的内容里。
  //   一个"下游所有的失败都变成同一个码"的包装，与一个"排障永远指向错地方"的包装，
  //   是同一个东西。
  const cases = [
    // 不认识的字段 ⇒ path-scope-malformed（闭合校验）
    [{ version: V, platform: 'linux', read: ['/work'], write: [], extra: 1 }, 'path-scope-malformed'],
    // 写范围不是读范围的子集 ⇒ write-not-in-read
    [{ version: V, platform: 'linux', read: ['/work'], write: ['/elsewhere/x'] }, 'path-scope-write-not-in-read'],
    // 平台不给 ⇒ 大小写规则未知，不给默认值
    [{ version: V, read: ['/work'], write: [] }, 'path-scope-case-rule-missing'],
  ]
  for (const [bad, code] of cases) {
    const err = throwsCode(() => bindScopeTable({ declaration: bad, workspaceRoot: null }), code)
    assert.notEqual(err.code, SCOPE_TABLE_CODES.BAD_INPUT, '不许把它压成装配层自己的码')
  }
})

test('⑥ ★ 大小写规则跟着**部署声明**的平台走，不跟着本机', () => {
  // win32 折叠大小写 ⇒ 归一化会把根折成小写。这是"表里写的平台"决定的，
  // 不是 "跑测试的这台机器"决定的。
  const win = bindScopeTable({ declaration: decl({ platform: 'win32', read: ['C:/WS'], write: [] }), workspaceRoot: null })
  assert.deepEqual([...win.read], ['c:/ws'])
  const lin = bindScopeTable({ declaration: decl({ platform: 'linux', read: ['/srv/WS'], write: [] }), workspaceRoot: null })
  assert.deepEqual([...lin.read], ['/srv/WS'])
})
