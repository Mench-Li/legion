// product/execution-plane-config.test.mjs
// ============================================================================
// 「同一个部署配置读取点」的判据。
//
// 重心：把**"没配"与"配了但解释不通"分开**，并证明交出去的东西是**真的能用**的
// （落到真 `checkPathScope` 与真 `createRegistry` 上，而不是只看自己产出的对象）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXECUTION_PLANE_CONFIG_CODES,
  EXECUTION_PLANE_CONFIG_KEYS,
  EXECUTION_PLANE_STATES,
  joinExecutionPlane,
  readExecutionPlaneConfig,
} from './execution-plane-config.mjs'
import { KNOWN_CONFIG_KEYS, validateConfigValues } from './config.mjs'
// ★ 跨到真正的读者：产物到底能不能用，只有它们说了算。
import { checkPathScope } from '../runtime/dsh-composition/path-scope.mjs'
import { createRegistry } from '../runtime/connectors/registry.mjs'

const SCOPE_KEY = EXECUTION_PLANE_CONFIG_KEYS.PATH_SCOPE
const TARGETS_KEY = EXECUTION_PLANE_CONFIG_KEYS.CONNECTOR_TARGETS

const VALID_SCOPE = Object.freeze({
  version: 'legion/path-scope@1', platform: 'linux', read: ['/work'], write: ['/work/sub'],
})

/**
 * 一份合法的部署配置（两半都配了）。
 *
 * ★ 外面那层 `{ value }` **不是**装饰：`configValueAt()` 走的就是 `merged.value`
 *   （它收的是 `loadProductConfig()` 的产物）。我第一版夹具漏了这层，
 *   于是 6 条用例变红——而它们红得**对**，见 ③ 那条"传裸配置"的用例。
 */
const cfg = (runtime = {}) => ({ value: { runtime } })
const full = () => cfg({
  pathScope: { ...VALID_SCOPE },
  connectorTargets: { 'c-1': { transport: 'stdio', command: 'node', args: ['x.mjs'] } },
})

function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err?.code}：${err?.message}`)
  return err
}

// ---------------------------------------------------------------------------
// ① 配上了：产物必须真的能用
// ---------------------------------------------------------------------------

test('① ★★★ 范围表交出去后能被**真** `checkPathScope` 直接吃下去', () => {
  // ★ 这一条与 `scope-table-binding.test.mjs` ① 抓过的是同一个错：
  //   只看产物自己字段清单的断言抓不到"多带一个字段"——
  //   抓住它的只有把产物交给**真读者**跑一遍。
  const plane = readExecutionPlaneConfig({ merged: full(), workspaceRoot: '/work' })
  assert.equal(plane.pathScope.state, EXECUTION_PLANE_STATES.CONFIGURED)

  const inside = checkPathScope({
    target: '/work/a.txt', scope: plane.pathScope.value, direction: 'read', realpath: (p) => p, exists: () => true,
  })
  assert.equal(inside.allowed, true, inside.reason ?? '')
  const outside = checkPathScope({
    target: '/etc/passwd', scope: plane.pathScope.value, direction: 'read', realpath: (p) => p, exists: () => true,
  })
  assert.equal(outside.allowed, false)
})

test('① ★★★ 连接目标与控制面声明配对后，能落到**真** `createRegistry`', () => {
  const plane = readExecutionPlaneConfig({ merged: full(), workspaceRoot: '/work' })
  const joined = joinExecutionPlane({
    plane,
    connectorDeclarations: [{
      connectorId: 'c-1',
      transport: 'stdio',
      // ★ `policy` 是**词表里的字符串**（`CONNECTOR_DECISIONS`），不是对象：
      //   写 `{ approval: 'never' }` 会被 `connector-policy-unknown` 拒掉。
      policy: 'allow',
      // ★ 工具必须声明 capabilities：注册表的原话是
      //   "一个'没有能力'的工具与一个'能力未知'的工具在登记表上长得一样，
      //     而后者必须按最严处理"。
      tools: [{ name: 'read-file', capabilities: ['file:read'] }],
    }],
  })
  assert.deepEqual([...joined.refusals], [])
  // ★ 落到真的注册表上——否则这条只证明"我产出了一个对象"。
  //   `connectors` 是个**函数**（读回来的是注册表自己的视图，不是我的入参）。
  const reg = createRegistry({ connectors: [...joined.connectors.declarations] })
  assert.equal(reg.connectors().length, 1)
  assert.equal(reg.connectors()[0].connectorId, 'c-1')
  assert.equal(reg.connectors()[0].command, 'node')
})

test('① ★★ 配对不上的那一条进 `refusals`，**不是**被静默跳过', () => {
  const plane = readExecutionPlaneConfig({ merged: full(), workspaceRoot: '/work' })
  const joined = joinExecutionPlane({
    plane,
    connectorDeclarations: [
      { connectorId: 'c-1', transport: 'stdio' },
      { connectorId: 'c-MISSING', transport: 'stdio' },
    ],
  })
  // ★ 若它被跳过，"有一条没配上"与"本来就只有一条"在调用方眼里同形。
  assert.equal(joined.refusals.length, 1)
  assert.equal(joined.refusals[0].connectorId, 'c-MISSING')
  assert.equal(joined.refusals[0].code, 'connector-target-missing')
  assert.equal(joined.connectors.declarations.length, 1)
})

// ---------------------------------------------------------------------------
// ② 没配：如实记成 absent，**不是** null 的范围表
// ---------------------------------------------------------------------------

test('② ★★★ 范围表没配 ⇒ `state: "absent"`，而不是一个"没有范围表"', () => {
  const plane = readExecutionPlaneConfig({ merged: cfg({}), workspaceRoot: '/work' })
  assert.equal(plane.pathScope.state, EXECUTION_PLANE_STATES.ABSENT)
  assert.equal(plane.pathScope.value, null)
  assert.ok(plane.absentKeys.includes(SCOPE_KEY), '必须报出**是哪一个键**缺席')
  // ★ 消息必须说清"这既不是没有限制、也不是全部禁止"——否则读的人会二选一。
  assert.match(plane.pathScope.reason, /不是/)
})

test('② ★★★ 拒绝的理由是**真的**：null 传到执行面那一侧就是**放行一切**', () => {
  // 把 §9.3 那条要防范的形状复现出来：`tool-request.mjs:731` 的形状是
  //   `if (pathScope === null) return undefined`（放行）。
  const verdict = (pathScope) => {
    if (pathScope === null) return 'allow'          // ← 生产里那一行的形状
    return pathScope({ target: '/etc/passwd' }).allowed ? 'allow' : 'deny'
  }
  assert.equal(verdict(null), 'allow', '前提变了：null 不再等于放行，请重写本节')

  // ⇒ 所以"没配"绝不能以 null 的形式被消费掉：消费点拿到的是**状态**。
  const absent = readExecutionPlaneConfig({ merged: cfg({}), workspaceRoot: '/work' })
  assert.equal(absent.pathScope.value, null)
  assert.equal(absent.pathScope.state, EXECUTION_PLANE_STATES.ABSENT)
  // 一个只比较 value 的消费点看不出区别；比 state 才看得出。
  assert.notEqual(absent.pathScope.state, undefined)

  // 反向对照：配上了的那一份，同一段判定代码给的是 deny。
  const present = readExecutionPlaneConfig({ merged: full(), workspaceRoot: '/work' })
  assert.equal(present.pathScope.state, EXECUTION_PLANE_STATES.CONFIGURED)
  assert.equal(
    verdict(() => checkPathScope({
      target: '/etc/passwd', scope: present.pathScope.value, direction: 'read', realpath: (p) => p, exists: () => true,
    })),
    'deny',
  )
})

test('② ★★ 两个键都没配时，`absentKeys` 两个都报出来', () => {
  const plane = readExecutionPlaneConfig({ merged: cfg({}), workspaceRoot: '/work' })
  assert.deepEqual([...plane.absentKeys].sort(), [TARGETS_KEY, SCOPE_KEY].sort())
})

// ---------------------------------------------------------------------------
// ③ 配了但解释不通 / 传错形状：都具名上抛
// ---------------------------------------------------------------------------

test('③ ★★★ 范围表配了但解释不通 ⇒ 原样上抛 `path-scope-*`，不被压成读取失败', () => {
  const err = throwsCode(
    () => readExecutionPlaneConfig({
      // 写范围不在读范围内 —— `path-scope.mjs` 的不变量。
      merged: cfg({ pathScope: { version: 'legion/path-scope@1', platform: 'linux', read: ['/work'], write: ['/elsewhere'] } }),
      workspaceRoot: '/work',
    }),
    'path-scope-write-not-in-read',
  )
  // ★ 理由与 `executor.mjs` 那条注释同源：压成"读取失败"会让排障指向本文件，
  //   而真正的修法在配置的内容里。
  assert.notEqual(err.code, EXECUTION_PLANE_CONFIG_CODES.BAD_INPUT)
})

test('③ ★★★ 传一份**裸**配置（漏了外层 value）⇒ 具名拒绝，不许静默读成"两个都缺席"', () => {
  // ★ 这是我第一版的真错：只判 `isPlainObject(merged)` 时，
  //   裸配置会让 `configValueAt` 一路返回 undefined ⇒ 两半**都**读成 absent。
  //
  //   > 一个"传错了形状"的输入，与一个"这次部署确实没配"的输入，
  //   > 在 absent 上长得一样——只不过前者会安静地把执行面两半都判成缺席。
  const bare = { runtime: { pathScope: { ...VALID_SCOPE } } }
  throwsCode(() => readExecutionPlaneConfig({ merged: bare }), EXECUTION_PLANE_CONFIG_CODES.BAD_INPUT)
  // 反向对照：包上 value 之后**同一份内容**就正常了 ⇒ 拒绝的理由确实是那一层，
  // 不是"这份配置内容有问题"。
  // （这一条 `workspaceRoot` 不能省：那份表有写根，没有工作区根会被
  //   `scope-table-workspace-missing` 具名拒绝——而那是**另一条**正确的拒绝。）
  const ok = readExecutionPlaneConfig({ merged: { value: bare }, workspaceRoot: '/work' })
  assert.equal(ok.pathScope.state, EXECUTION_PLANE_STATES.CONFIGURED)
})

test('③ ★★ `merged` 不像配置对象 ⇒ 具名 `BAD_INPUT`（这一条才归读取点自己的码）', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    throwsCode(() => readExecutionPlaneConfig({ merged: bad }), EXECUTION_PLANE_CONFIG_CODES.BAD_INPUT)
  }
  throwsCode(() => joinExecutionPlane({ plane: null }), EXECUTION_PLANE_CONFIG_CODES.BAD_INPUT)
})

// ---------------------------------------------------------------------------
// ④⑤ 连接目标那一半的形状
// ---------------------------------------------------------------------------

test('④ ★★ 连接目标没配 ⇒ 同样如实 `absent`', () => {
  const plane = readExecutionPlaneConfig({ merged: cfg({ pathScope: { ...VALID_SCOPE } }), workspaceRoot: '/work' })
  assert.equal(plane.connectorTargets.state, EXECUTION_PLANE_STATES.ABSENT)
  assert.deepEqual([...plane.absentKeys], [TARGETS_KEY])
})

test('⑤ ★★ 连接目标形状不对 ⇒ 具名拒绝（数组不算对象、值是字符串不算目标、空键不算 id）', () => {
  const cases = {
    数组: [{ command: 'node' }],
    值是字符串: { 'c-1': 'node' },
    空键: { '': { command: 'node' } },
  }
  for (const [label, targets] of Object.entries(cases)) {
    const err = throwsCode(
      () => readExecutionPlaneConfig({ merged: cfg({ connectorTargets: targets }) }),
      EXECUTION_PLANE_CONFIG_CODES.TARGETS_MALFORMED,
    )
    assert.ok(err.message.length > 0, label)
  }
})

test('⑤ ★ 缺席的连接目标在 `joinExecutionPlane` 里按**空表**参与配对，于是配对失败可见', () => {
  // 缺席 ≠ 没有连接器：控制面声明了几条，就会得到几条 refusal。
  const plane = readExecutionPlaneConfig({ merged: cfg({}) })
  const joined = joinExecutionPlane({ plane, connectorDeclarations: [{ connectorId: 'c-1', transport: 'stdio' }] })
  assert.equal(joined.refusals.length, 1, '缺席被静默当成"没有连接器"了')
  assert.equal(joined.refusals[0].code, 'connector-target-missing')
})

test('⑤ ★★ `joinExecutionPlane` 把范围表的缺席**原样**传出去，不补默认值', () => {
  const plane = readExecutionPlaneConfig({ merged: cfg({}) })
  const joined = joinExecutionPlane({ plane, connectorDeclarations: [] })
  assert.equal(joined.pathScope, null)
  // 而状态还在 plane 上——消费点两边都拿得到。
  assert.equal(plane.pathScope.state, EXECUTION_PLANE_STATES.ABSENT)
})

// ---------------------------------------------------------------------------
// ⑥⑦ 键登记：这两个键必须被登记，且子键**不该**被各自登记
// ---------------------------------------------------------------------------

test('⑥ ★★ 两个键都已登记进 `KNOWN_CONFIG_KEYS`（否则它们是"改了没反应"）', () => {
  for (const key of [SCOPE_KEY, TARGETS_KEY]) {
    assert.ok(KNOWN_CONFIG_KEYS[key], `${key} 没有被登记进 KNOWN_CONFIG_KEYS`)
    assert.equal(KNOWN_CONFIG_KEYS[key].type, 'object', `${key} 的类型应当是 object`)
  }
})

test('⑥ ★★ 配了这两个键**不产生**任何 `CONFIG_UNKNOWN_KEY`', () => {
  const diags = validateConfigValues({
    runtime: {
      pathScope: { ...VALID_SCOPE },
      connectorTargets: { 'c-1': { transport: 'stdio', command: 'node' } },
    },
  })
  const unknown = diags.filter((d) => d.code === 'CONFIG_UNKNOWN_KEY')
  assert.deepEqual(unknown.map((d) => d.path), [], '这两个键被读成了未知键')
})

test('⑦ ★★★ 已登记的对象键**不被递归**：子键不报未知（实测机制，钉住它）', () => {
  // ★ 这不是巧合：`validateConfigValues` 的递归**只**发生在"键没登记"那一支。
  //   所以登记 `runtime.pathScope` 之后，它内部的 `platform` / `read` / `write`
  //   不会各自报未知。`runtime.secretRefs` 用的是同一个机制。
  //
  //   钉住它的理由：免得下一个人"顺手"把子键也登记一遍——
  //   那会得到**两份互相漂移的说明**，而漂移的那一天没有任何门禁会红。
  const diags = validateConfigValues({
    runtime: { pathScope: { ...VALID_SCOPE }, connectorTargets: { 'c-1': { command: 'node' } } },
  })
  const paths = diags.map((d) => d.path)
  for (const child of [
    'runtime.pathScope.platform', 'runtime.pathScope.read', 'runtime.pathScope.write',
    'runtime.connectorTargets.c-1',
  ]) {
    assert.ok(!paths.includes(child), `${child} 不该被单独登记/报警`)
  }
})

test('⑦ ★★ 反向对照：**未登记**的嵌套对象键仍然会递归报警（证明上一条不是"walker 不动嵌套"）', () => {
  const diags = validateConfigValues({ runtime: { notRegisteredAtAll: { a: 1, b: 'x' } } })
  const unknowns = diags.filter((d) => d.code === 'CONFIG_UNKNOWN_KEY').map((d) => d.path)
  assert.ok(unknowns.includes('runtime.notRegisteredAtAll.a'), `实际: ${unknowns.join(', ')}`)
  assert.ok(unknowns.includes('runtime.notRegisteredAtAll.b'))
})
