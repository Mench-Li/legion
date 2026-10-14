// workbench/scripts/native-capabilities.test.mjs
// 运行：node --experimental-strip-types workbench/scripts/native-capabilities.test.mjs
//
// ============================================================================
// DSH 能力位的**推导**判据。
//
// 守的是一处"发布成功、派工必失败"的缺陷：`outputSchema` 此前硬编码 `true`，
// 而 provider 真的不支持它时用户既看不到也改不了 —— 发布成功，然后每次派工都抛错。
//
// 分歧点只有一个，但必须钉死：
//
//     **读数缺席（不知道）** 与 **读数说 false（知道不行）** 是两件事。
//     前者不拦发布（自检有 10 分钟 TTL、旧守护根本不上报），后者必须拦
//     （因为派工真的会抛错）。把它们合成一个"不 ready"会导出两种相反的错：
//     拦了刚装好的人，或放行一个必然失败的配置。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ASSUMED_KEYS,
  ASSUMED_REASONS,
  DERIVED_KEYS,
  declaredFor,
  deriveNativeCapabilities,
  isUsableReading,
  readinessStateOf,
} from '../src/nativeCapabilities.ts'

/** 三项都能读到的读数。 */
const READING = Object.freeze({ outputSchema: true, toolFilter: true, cancellation: true })
/** 读数说"不支持结构化输出"。 */
const NO_STRUCTURED = Object.freeze({ outputSchema: false, toolFilter: true, cancellation: true })

const USER = Object.freeze({ toolFilter: true, localAgent: true, cancellation: true })

describe('能力位推导', () => {
  test('★ 有读数 ⇒ 三项**取自读数**，两位留给用户声明', () => {
    const d = deriveNativeCapabilities(READING, USER)
    assert.deepEqual(d.derived, [...DERIVED_KEYS])
    assert.deepEqual(d.assumed, [...ASSUMED_KEYS])
    assert.equal(d.capabilities.outputSchema, true)
    assert.equal(d.capabilities.toolFilter, true)
    assert.equal(d.capabilities.cancellation, true)
    assert.equal(d.capabilities.localAgent, USER.localAgent)
    assert.equal(d.capabilities.sessionResume, false, '不再由用户设置 ⇒ 恒 false')
    // 完整声明必须含 hub 要求的全部 7 个键（缺一个 hub 会拒）
    assert.deepEqual(Object.keys(d.capabilities).sort(),
      ['cancellation', 'localAgent', 'outputSchema', 'sessionResume', 'textInput', 'textOutput', 'toolFilter'])
    assert.equal(d.blockers.length, 0)
    assert.equal(d.warnings.length, 0, '有读数且满足要求时不该有告警')
  })

  test('★★ 读数说 outputSchema=false ⇒ **拦下发布**（这是本次修的那处缺陷）', () => {
    const d = deriveNativeCapabilities(NO_STRUCTURED, USER)
    assert.equal(d.blockers.length, 1)
    assert.match(d.blockers[0], /结构化输出/)
    assert.equal(d.capabilities.outputSchema, false, '声明要如实反映读数，而不是硬编码 true')
    // 拦下来的理由必须说清"为什么"和"下一步做什么"
    assert.match(d.blockers[0], /每一次派工都会失败/, '要说清后果')
    assert.match(d.blockers[0], /换一个/, '要给下一步')
  })

  test('★★ 读数缺席 ⇒ **不拦**，但必须警告（自检有 TTL，拦了会挡住刚装好的人）', () => {
    for (const absent of [null, undefined]) {
      const d = deriveNativeCapabilities(absent, USER)
      assert.equal(d.blockers.length, 0, '"没读到"不是"不行"，不许拦发布')
      assert.equal(d.warnings.length, 1)
      assert.match(d.warnings[0], /还没有上报/)
      assert.match(d.warnings[0], /只是声明/, '必须说清这几个值只是声明')
    }
  })

  test('★ 读数缺席 ⇒ 三项退回用户声明（保持既有行为，不悄悄改语义）', () => {
    const d = deriveNativeCapabilities(null, { toolFilter: false, localAgent: false, cancellation: false })
    assert.equal(d.capabilities.toolFilter, false, '用户声明的 false 要生效（旧行为）')
    assert.equal(d.capabilities.cancellation, false)
    assert.equal(d.capabilities.outputSchema, true, '读数缺席时维持此前的默认 true')
    assert.deepEqual(d.assumed, [...ASSUMED_KEYS, ...DERIVED_KEYS], '缺席时三项也要如实标成"声明"')
  })

  test('★ 半截读数（缺位）算**没读到**，不算"false"', () => {
    // 缺位若被读成 false，会把"版本不一致"伪装成"能力不支持"，导出一次错误的硬拦。
    for (const partial of [
      { outputSchema: true, toolFilter: true },
      { outputSchema: true },
      { outputSchema: true, toolFilter: true, cancellation: 'yes' },
      { outputSchema: true, toolFilter: true, cancellation: null },
    ]) {
      assert.equal(isUsableReading(partial), false, JSON.stringify(partial) + ' 不该算读到')
      const d = deriveNativeCapabilities(partial, USER)
      assert.equal(d.blockers.length, 0, '半截读数不该拦发布')
      assert.equal(d.warnings.length, 1)
    }
    assert.equal(isUsableReading(READING), true)
    assert.equal(isUsableReading(null), false)
    assert.equal(isUsableReading(undefined), false)
  })

  test('★ 读数里的 false 如实透传（toolFilter/cancellation 也一样，不是只有 outputSchema）', () => {
    const d = deriveNativeCapabilities({ outputSchema: true, toolFilter: false, cancellation: false }, USER)
    assert.equal(d.capabilities.toolFilter, false)
    assert.equal(d.capabilities.cancellation, false)
    assert.equal(d.blockers.length, 0, '这两位不满足不拦（派工时会按各自条件核对）')
  })

  test('textInput/textOutput 恒为 true（hub 硬要求，且不是本机读数能决定的事）', () => {
    for (const declared of [null, READING, NO_STRUCTURED]) {
      const d = deriveNativeCapabilities(declared, USER)
      assert.equal(d.capabilities.textInput, true)
      assert.equal(d.capabilities.textOutput, true)
    }
  })

  test('"推不出来"的那一位必须带**原因**（界面直接显示，不许留空）', () => {
    for (const key of ASSUMED_KEYS) {
      assert.ok(typeof ASSUMED_REASONS[key] === 'string' && ASSUMED_REASONS[key].length > 10,
        key + ' 必须说明为什么本机读不出来')
    }
    assert.match(ASSUMED_REASONS.localAgent, /本地 Agent/)
  })

  test('★★★ `sessionResume` 不再问用户 —— 写死 false，且传什么都一样', () => {
    // 2026-10-13：它**没有消费方**（全仓检索只有声明点），于是不再放进 ASSUMED_KEYS。
    //
    //   > 一个"问了但没人用"的选项，与一个"根本没问"的选项，
    //   > 在**用户点它的时候**看起来一样 —— 区别只在他以为自己的选择起了作用。
    //
    // ★ 但它在**数据模型里仍然存在**：`team-hub/harness-store.mjs` 的 allowed 要求
    //   每个键都被显式声明成布尔，所以派生结果里必须有这个键。
    assert.ok(!ASSUMED_KEYS.includes('sessionResume'), 'sessionResume 不该再出现在"需用户确认"的名单里')
    assert.equal(ASSUMED_REASONS.sessionResume, undefined, '它不该再有界面原因文案')

    for (const declared of [null, READING]) {
      const d = deriveNativeCapabilities(declared, { toolFilter: true, localAgent: true, cancellation: true })
      assert.equal(d.capabilities.sessionResume, false, '无论读数在不在，都是写死的 false')
      assert.ok('sessionResume' in d.capabilities, '★ 键必须仍在（否则 hub 的 schema 会拒）')
    }
  })

  test('★★ `localAgent` **不许**一起删掉 —— 它在集成模式下真的会拦人', () => {
    // 这条是防止"顺手把两个都删了"：`plugins/src/index.ts` 里有真实分支读它
    // （集成模式要求本地 Agent 拦截）。sessionResume 可以删，它不行。
    assert.ok(ASSUMED_KEYS.includes('localAgent'))
    const off = deriveNativeCapabilities(READING, { toolFilter: true, localAgent: false, cancellation: true })
    assert.equal(off.capabilities.localAgent, false, '用户声明的值必须生效')
    const on = deriveNativeCapabilities(READING, { toolFilter: true, localAgent: true, cancellation: true })
    assert.equal(on.capabilities.localAgent, true)
  })
})

describe('从心跳读数里取 declared', () => {
  const readiness = {
    providers: {
      spawn: { state: 'ready', declared: { outputSchema: true, toolFilter: true, cancellation: true, permissionMode: 'dsh-native:spawn' } },
      codex: { state: 'missing_cli' },
      half: { state: 'ready', declared: { outputSchema: true, toolFilter: true } },
      junk: { state: 'ready', declared: 'nope' },
    },
  }

  test('★ 读得到就返回三位 + 权限模式', () => {
    const d = declaredFor(readiness, 'spawn')
    assert.equal(d.outputSchema, true)
    assert.equal(d.toolFilter, true)
    assert.equal(d.cancellation, true)
    assert.equal(d.permissionMode, 'dsh-native:spawn')
  })

  test('★★ 没读到的三种形状都返回 null（**不是**"全 false"）', () => {
    // 返回一个"全 false"的读数会导出一次错误的硬拦 —— 这就是必须 null 的理由。
    assert.equal(declaredFor(readiness, 'codex'), null, '压根没有 declared 字段')
    assert.equal(declaredFor(readiness, 'half'), null, '缺位 ⇒ 没读到')
    assert.equal(declaredFor(readiness, 'junk'), null, '形状不对 ⇒ 没读到')
    assert.equal(declaredFor(readiness, 'not-there'), null)
    assert.equal(declaredFor(null, 'spawn'), null)
    assert.equal(declaredFor(undefined, 'spawn'), null)
  })

  test('不认识的字段被丢掉（不透传到 hub 的白名单之外）', () => {
    const d = declaredFor({ providers: { x: { declared: { outputSchema: true, toolFilter: true, cancellation: true, evil: 'x' } } } }, 'x')
    assert.equal(d.evil, undefined)
    assert.deepEqual(Object.keys(d).sort(), ['cancellation', 'outputSchema', 'toolFilter'])
  })

  test('就绪状态：读得到给字符串，读不到给 null', () => {
    assert.equal(readinessStateOf(readiness, 'spawn'), 'ready')
    assert.equal(readinessStateOf(readiness, 'codex'), 'missing_cli')
    assert.equal(readinessStateOf(readiness, 'nope'), null)
    assert.equal(readinessStateOf(null, 'spawn'), null)
  })

  test('★ 端到端：从读数一路推到"拦不拦发布"（这是本次修的整条链）', () => {
    const withFalse = { providers: { p: { declared: { outputSchema: false, toolFilter: false, cancellation: true } } } }
    const d1 = deriveNativeCapabilities(declaredFor(withFalse, 'p'), USER)
    assert.equal(d1.blockers.length, 1, '读数说 false ⇒ 拦')

    const withAbsent = { providers: { p: { state: 'unknown' } } }
    const d2 = deriveNativeCapabilities(declaredFor(withAbsent, 'p'), USER)
    assert.equal(d2.blockers.length, 0, '没读到 ⇒ 不拦')
    assert.equal(d2.warnings.length, 1)
  })
})
