// runtime/contracts/run-floor.test.mjs
// ============================================================================
// PRT-214 缺口①的**搬运形状**：一次 Run 的静态 hard floor 在契约上长什么样，
// 以及"没有给"「给清楚了」「解释不了」三者为什么必须互相可分。
//
// ## 这一套件要回答的唯一问题
//
//   > 一份 `derived:false, floor:null` 的载荷，与一份 `derived:true, floor:{denyTools:[]}`
//   > 的载荷，在"能不能过契约"这件事上是不是同一个东西？
//
// 答案必须是否。前者是**派生失败**（强制面整段不在，而且没人会收到告警），
// 后者是**一次成功的派生，而这次确实没有东西该被禁止**。
//
//   > 一个"把派生失败静默读成空下限"的解析器，
//   > 与一个"把这次没有东西要禁止读成空下限"的解析器，在解析结果上是同一个东西——
//   > 只不过前者的空数组是一次**故障**的产物，而它长得和一次合法的"没有"一模一样。
//
// 所以本套件的承重断言不是"坏了会拒"，而是**拒的码不同、状态不同**：
// `absent` / `installed` / `refused` 三个状态各有一个用例，
// 而每一对之间都有一条"它们的读数必须不同"的断言。
//
// ## 为什么这一层要能脱离执行引擎被穷举
//
// `readRunFloor` 是纯函数、零 IO、零 Cordis/DSH 依赖——与 `validateRunRequest` 同一条纪律。
// 代价是它**不能**用 `canonicalizePath`（那在执行面），所以"前缀规范化是否幂等"
// 不在这里查（见模块里那段注释）。这是边界，不是遗漏。
// ============================================================================

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  RUN_FLOOR_CONTRACT_CHECKED,
  RUN_FLOOR_CODES,
  RUN_FLOOR_FLOOR_KEYS,
  RUN_FLOOR_PAYLOAD_KEYS,
  RUN_FLOOR_PORT_STATES,
  RUN_FLOOR_STATES,
  RUN_FLOOR_WIRE_FIELD,
  RUN_FLOOR_WIRE_VERSION,
  readRunFloor,
} from './run-floor.mjs'
import { RUN_REQUEST_REQUIRED, validateRunRequest } from './run.mjs'

const LEGAL_FLOOR = Object.freeze({ denyTools: [], denyPathPrefixes: [], platform: 'linux' })
const installed = (over = {}) => ({ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { ...LEGAL_FLOOR, ...over } })

describe('PRT-214 run-floor 契约（搬运形状）', () => {
  test('★ 三个状态各有名字，且 `absent` 与"空下限"是**两个**状态', () => {
    const absent = readRunFloor(undefined)
    const empty = readRunFloor(installed())

    assert.equal(absent.state, RUN_FLOOR_STATES.ABSENT)
    assert.equal(empty.state, RUN_FLOOR_STATES.INSTALLED)
    assert.notEqual(absent.state, empty.state,
      '缺席与空下限同态 ⇒ "没人给我下限"与"这次没有东西该禁止"在第一天就分不开了')
    // 归因也不同：缺席是一个**状态码**（要被日志检索得到），不是一个错误
    assert.equal(absent.code, RUN_FLOOR_CODES.NOT_SUPPLIED)
    assert.deepEqual([...absent.errors], [], '缺席不是载荷的错误——它不该出现在 errors 里')
    assert.equal(empty.code, null)
    assert.deepEqual([...empty.errors], [])
    assert.deepEqual({ ...empty.floor }, { denyTools: [], denyPathPrefixes: [], cwd: undefined, platform: 'linux' })
  })

  test('★★ 派生失败（`derived:false` / `floor:null`）是**拒绝**，不是"没有给"', () => {
    // 生产侧在派生不出来时给的正是这一份形状：`derived:false` 且 `floor:null`。
    for (const payload of [
      { version: RUN_FLOOR_WIRE_VERSION, derived: false, floor: null },
      { version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: null },
      { version: RUN_FLOOR_WIRE_VERSION, floor: { ...LEGAL_FLOOR } },
      null,
    ]) {
      const r = readRunFloor(payload)
      assert.equal(r.state, RUN_FLOOR_STATES.REFUSED,
        `${JSON.stringify(payload)} 被读成了 ${r.state} —— 一次派生失败被洗成一次缺席`)
      assert.notEqual(r.state, RUN_FLOOR_STATES.ABSENT)
      assert.equal(r.floor, null)
      assert.equal(r.errors.length, 1, '拒绝必须留下一条能被日志检索的理由')
    }
    // 两种成因的码不同：一个是"没派生出来"，一个是"根本不是对象"。
    assert.equal(readRunFloor({ version: RUN_FLOOR_WIRE_VERSION, derived: false, floor: null }).code,
      RUN_FLOOR_CODES.NOT_DERIVED)
    assert.equal(readRunFloor(null).code, RUN_FLOOR_CODES.NOT_OBJECT)
  })

  test('★★ 九种拒绝各有各的码（修法不同 ⇒ 归因必须不同）', () => {
    const cases = [
      [null, RUN_FLOOR_CODES.NOT_OBJECT],
      [[], RUN_FLOOR_CODES.NOT_OBJECT],
      ['x', RUN_FLOOR_CODES.NOT_OBJECT],
      [42, RUN_FLOOR_CODES.NOT_OBJECT],
      [{ version: 99, derived: true, floor: { ...LEGAL_FLOOR } }, RUN_FLOOR_CODES.VERSION_UNSUPPORTED],
      [{ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { ...LEGAL_FLOOR }, nope: 1 }, RUN_FLOOR_CODES.UNKNOWN_KEY],
      [{ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { ...LEGAL_FLOOR, nope: 1 } }, RUN_FLOOR_CODES.UNKNOWN_KEY],
      [{ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: [] }, RUN_FLOOR_CODES.BAD_SHAPE],
      [{ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { ...LEGAL_FLOOR, denyTools: 'rm' } }, RUN_FLOOR_CODES.BAD_SHAPE],
      [{ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { ...LEGAL_FLOOR, denyTools: [''] } }, RUN_FLOOR_CODES.BAD_TOOL_NAME],
      [{ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { ...LEGAL_FLOOR, denyTools: [7] } }, RUN_FLOOR_CODES.BAD_TOOL_NAME],
      [{ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { ...LEGAL_FLOOR, denyPathPrefixes: [''] } }, RUN_FLOOR_CODES.BAD_PATH_PREFIX],
      [{ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { ...LEGAL_FLOOR, cwd: 7 } }, RUN_FLOOR_CODES.BAD_SHAPE],
      [{ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { denyTools: [], denyPathPrefixes: [] } }, RUN_FLOOR_CODES.BAD_SHAPE],
    ]
    const seen = new Set()
    for (const [payload, code] of cases) {
      const r = readRunFloor(payload)
      assert.equal(r.state, RUN_FLOOR_STATES.REFUSED, `${JSON.stringify(payload)} 没有被拒`)
      assert.equal(r.code, code, `${JSON.stringify(payload)} 的码应当是 ${code}`)
      seen.add(code)
    }
    assert.equal(seen.size, 6, `这组用例覆盖了 ${seen.size} 个不同的码`)
    // 闭集里除了 NOT_SUPPLIED（状态码）之外，每一个都必须有产生者。
    const producible = new Set([...seen, RUN_FLOOR_CODES.NOT_DERIVED, RUN_FLOOR_CODES.NOT_SUPPLIED])
    for (const code of Object.values(RUN_FLOOR_CODES)) {
      assert.ok(producible.has(code), `拒绝码 ${code} 在这个闭集里，却没有任何一条用例能产生它`)
    }
  })

  test('★★ `platform` 必须显式给：缺席不许由运行时自己补', () => {
    // 它决定路径匹配是否做大小写归并。缺席时补一个 `process.platform` 看着无害
    // （两个进程在同一台机器上），但那时"控制面说了"与"我们猜的一样"成了同一个读数。
    const r = readRunFloor({ version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { denyTools: [], denyPathPrefixes: [] } })
    assert.equal(r.state, RUN_FLOOR_STATES.REFUSED)
    assert.equal(r.code, RUN_FLOOR_CODES.BAD_SHAPE)
    assert.match(r.message, /platform/)
    // `cwd` 相反：它**可以**缺席（全部前缀都是绝对路径，cwd 只在相对路径上被用到）。
    const withCwdAbsent = readRunFloor(installed())
    assert.equal(withCwdAbsent.state, RUN_FLOOR_STATES.INSTALLED)
    assert.equal('cwd' in withCwdAbsent.floor, true, '键在场、值是 undefined —— 与"忘了写"分得开')
    assert.equal(withCwdAbsent.floor.cwd, undefined)
  })

  test('★ 名单被复制并去重，且结果是冻结的（调用方改不动它）', () => {
    const r = readRunFloor(installed({ denyTools: ['rm_rf', 'rm_rf', 'drop_db'], denyPathPrefixes: ['/a'] }))
    assert.deepEqual([...r.floor.denyTools], ['rm_rf', 'drop_db'])
    assert.deepEqual([...r.floor.denyPathPrefixes], ['/a'])
    assert.equal(Object.isFrozen(r.floor), true)
    assert.equal(Object.isFrozen(r.floor.denyTools), true)
    // 原载荷不被改写（它是调用方的东西）。
    const source = installed({ denyTools: ['rm_rf', 'rm_rf'] })
    readRunFloor(source)
    assert.deepEqual(source.floor.denyTools, ['rm_rf', 'rm_rf'])
  })

  test('★ `runId` 会被带出来（但缺席时是 `null`，不编一个）', () => {
    assert.equal(readRunFloor(installed({ })).runId, null)
    assert.equal(readRunFloor({ ...installed(), runId: 'run-7' }).runId, 'run-7')
  })

  test('★ 装载期自检读的是**算出来的产物**，不是一个布尔', () => {
    assert.equal(RUN_FLOOR_CONTRACT_CHECKED.version, RUN_FLOOR_WIRE_VERSION)
    assert.equal(RUN_FLOOR_CONTRACT_CHECKED.absentState, RUN_FLOOR_STATES.ABSENT)
    assert.equal(RUN_FLOOR_CONTRACT_CHECKED.emptyFloorState, RUN_FLOOR_STATES.INSTALLED)
    assert.equal(RUN_FLOOR_CONTRACT_CHECKED.nullRefusedWith, RUN_FLOOR_CODES.NOT_OBJECT)
    assert.equal(RUN_FLOOR_CONTRACT_CHECKED.unknownKeyRefusedWith, RUN_FLOOR_CODES.UNKNOWN_KEY)
    assert.equal(RUN_FLOOR_CONTRACT_CHECKED.notDerivedRefusedWith, RUN_FLOOR_CODES.NOT_DERIVED)
  })

  test('★ 字段名与端口状态是**同一处**定义（服务端、适配器、安装点不各写一遍）', () => {
    assert.equal(RUN_FLOOR_WIRE_FIELD, 'enforcementFloor')
    assert.deepEqual([...RUN_FLOOR_PAYLOAD_KEYS], ['version', 'derived', 'floor', 'runId', 'refusals'])
    assert.deepEqual([...RUN_FLOOR_FLOOR_KEYS], ['denyTools', 'denyPathPrefixes', 'cwd', 'platform'])
    assert.deepEqual(Object.values(RUN_FLOOR_PORT_STATES).sort(), ['absent', 'installed'])
    // `refused` **不**在端口状态里：它的处置是拒收这次 Run，根本走不到端口。
    assert.equal(Object.values(RUN_FLOOR_PORT_STATES).includes('refused'), false)
  })
})

describe('PRT-214 run-floor 与 RunRequest 契约的接缝', () => {
  const base = {
    runId: 'run-1', attemptId: 'att-1', idempotencyKey: 'idem-1', workspaceId: 'ws-1',
    goalId: 'goal-1', taskId: 'T-1', employeeId: 'emp-1', teamPlanRef: 'tp-1',
    contextSnapshotRef: 'ctx-1', modelProfileRef: 'mp-1', budget: {}, timeoutMs: 5000,
    workdir: 'C:/tmp/ws',
    permissions: { preset: 'legion-attended', tools: ['read_file'] },
    expectedOutput: { schema: { type: 'object', properties: {}, additionalProperties: true }, acceptance: 'ok' },
  }

  test('★★ `enforcementFloor` **不在**必填清单里（缺席要如实保留为缺席）', () => {
    // 把它写成必填，每一个还没有接生产者的调用方都得编一份空下限才能过契约——
    // 而一份编出来的空下限，就是"这次没有东西要禁止"这个陈述本身。
    assert.equal(RUN_REQUEST_REQUIRED.includes(RUN_FLOOR_WIRE_FIELD), false)
    const r = validateRunRequest(base)
    assert.equal(r.ok, true, `不带下限的 RunRequest 被拒了：${r.errors.join('；')}`)
    assert.equal('enforcementFloor' in r.value, false, '缺席不许被补上一个键')
  })

  test('★★★ 带了坏下限 → 契约拒收，且理由是**这个字段**', () => {
    for (const bad of [
      { version: RUN_FLOOR_WIRE_VERSION, derived: false, floor: null },
      null,
      { version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { denyTools: [] } },
      { version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: { denyTools: [], denyPathPrefixes: [], platform: 'linux' }, extra: 1 },
    ]) {
      const r = validateRunRequest({ ...base, enforcementFloor: bad })
      assert.equal(r.ok, false, `${JSON.stringify(bad)} 过了契约 —— 它会在安装点才被拒，而那时 Run 已经起跑了`)
      assert.ok(r.errors.some((e) => e.includes(RUN_FLOOR_WIRE_FIELD) && e.includes('无法解释')),
        `拒绝理由必须点名字段与"无法解释"：${r.errors.join('；')}`)
    }
  })

  test('★ 带了合法下限 → 过契约，且**同一个函数**在服务端与适配器两侧都用得上', () => {
    const r = validateRunRequest({ ...base, enforcementFloor: installed({ denyTools: ['rm_rf'] }) })
    assert.equal(r.ok, true, r.errors.join('；'))
    // 契约这一层不解释、不裁剪、不搬运：形状判定只有一处实现（`readRunFloor`）。
    assert.deepEqual(r.value.enforcementFloor, installed({ denyTools: ['rm_rf'] }))
  })
})
