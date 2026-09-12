// runtime/dsh-composition/tool-args.test.mjs
// ============================================================================
// PRT-613 的判据：审批、UI、审计与执行看到**同一份**不可变工具参数
//
// spec §6.5 line 468：「审批绑定不可变 ToolExecution 参数的 canonical operation 哈希；
//   DSH `tools/pre-execute` **不允许改写工具参数**，因为审计、UI 和实际执行必须看到
//   相同输入。Legion 如需改变参数，只能**拒绝当前调用**并要求模型或工具定义产生
//   一个新的 Tool Call，**不能在审批后静默改写**。」
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ARG_FREEZE_CODES,
  MAX_ARG_DEPTH,
  OBSERVATION_SURFACES,
  TOOL_ARGS_CHECKED,
  TOOL_ARGS_VERSION,
  assertDeepFrozen,
  assertIdentityIsCarried,
  assertNotBoundToSummary,
  assertNotRewritten,
  assertObservationFaithful,
  assertSameAcrossSurfaces,
  deepFreeze,
  freezeToolArguments,
  hashToolArguments,
  observe,
  resolvePreExecuteResult,
  serializeObservation,
} from './tool-args.mjs'

const ARGS = { path: '/w/a.txt', mode: 'w', nested: { deep: { value: 1 } } }
const frozenOf = (over = {}) => freezeToolArguments({ toolName: 'file_write', args: structuredClone(ARGS), summary: '写入 a.txt', ...over })

// ------------------------------------------------------------- ① 深冻结

test('① ★★ 冻结是**递归**的：第二层的值改不动', () => {
  // 只冻一层时 `Object.isFrozen(body)` 是 `true`，看起来"不可变"——
  // 而 `body.arguments.path = '/etc/passwd'` 照样成功，且"哪个文件被写"恰恰在第二层。
  //
  //   > 一个只冻结了最外层的"不可变"参数，
  //   > 与一个「内层随时可以被悄悄改掉」的参数，是同一个东西——
  //   > 只不过前者会通过 `Object.isFrozen()` 的检查。
  const f = frozenOf()
  assert.equal(Object.isFrozen(f.arguments), true)
  assert.equal(Object.isFrozen(f.arguments.nested), true, '第二层没有冻结')
  assert.equal(Object.isFrozen(f.arguments.nested.deep), true, '第三层没有冻结')
  assert.throws(() => { f.arguments.path = '/etc/passwd' }, TypeError)
  assert.throws(() => { f.arguments.nested.deep.value = 999 }, TypeError)
  assert.equal(f.arguments.nested.deep.value, 1, '第三层被改掉了')
  assert.equal(f.arguments.path, '/w/a.txt')
})

test('① ★★ 冻结体与调用方传进来的对象**不是同一个引用**（否则调用方还能改它）', () => {
  const mine = structuredClone(ARGS)
  const f = freezeToolArguments({ toolName: 'file_write', args: mine })
  assert.notEqual(f.arguments, mine, '冻结体直接持有了调用方的对象')
  mine.path = '/etc/passwd'
  assert.equal(f.arguments.path, '/w/a.txt', '改了调用方的对象，冻结体跟着变了')
  assert.equal(hashToolArguments({ toolName: f.toolName, args: f.arguments }).canonicalHash, f.canonicalHash)
})

test('① ★★ 自检是**逐层**的，不是只看最外层', () => {
  // 证据必须是**算出来的路径列表**，否则"深冻结"与"浅冻结"给出同样的读数。
  assert.deepEqual(TOOL_ARGS_CHECKED.sampleFrozenPaths, ['path', 'mode', 'nested.deep.value'])
  assert.ok(TOOL_ARGS_CHECKED.sampleFrozenPaths.some((p) => p.includes('.')), '证据里没有嵌套路径——浅冻结也能通过')

  // 造一个"外层冻结、内层没冻结"的参数：这正是浅冻结的样子
  const shallow = Object.freeze({ path: '/w/a.txt', nested: { deep: { value: 1 } } })
  assert.equal(Object.isFrozen(shallow), true)
  assert.equal(Object.isFrozen(shallow.nested), false)
  assert.throws(() => assertDeepFrozen(shallow), /没有被冻结/, '浅冻结没有被识别出来')
  assert.throws(() => assertDeepFrozen(shallow), /哪个文件被写/)
})

test('① ★ 嵌套过深直接抛，不猜它的身份', () => {
  let deep = { leaf: 1 }
  for (let i = 0; i < MAX_ARG_DEPTH + 2; i++) deep = { next: deep }
  assert.throws(() => deepFreeze(deep), /嵌套超过/)
})

// ------------------------------------------------- ② 身份必须"随体携带"

test('② ★★ 四个面看到的是**同一份**参数（同一个引用），不是四份内容相同的副本', () => {
  const f = frozenOf()
  const v = assertSameAcrossSurfaces({ frozen: f })
  assert.equal(v.sameReference, true)
  assert.deepEqual(v.surfaces, [...OBSERVATION_SURFACES])
  assert.equal(v.canonicalHash, f.canonicalHash)
  for (const s of OBSERVATION_SURFACES) {
    assert.equal(observe({ frozen: f, surface: s }).arguments, f.arguments, `${s} 拿到的不是同一份`)
  }
})

test('② ★★ 观察面报出的是**携带的**哈希，不是各面重算的', () => {
  //   > 一个「每个观察面各自按自己的副本重算哈希、再比哈希」的校验，
  //   > 与一个「从不校验」的校验，在「pre-execute 到底能不能改写参数」上是同一个东西——
  //   > 只不过前者会打印一行"四个面一致"。
  const e = TOOL_ARGS_CHECKED
  assert.deepEqual(e.inconsistentSurfaces, [], '有观察面报出的哈希与冻结体不一致')
  assert.equal(e.perSurface.length, OBSERVATION_SURFACES.length)
  for (const p of e.perSurface) {
    assert.equal(p.carried, e.frozenHash, `${p.surface} 报出的不是冻结体携带的哈希`)
    assert.equal(p.carriedMatchesOwnCopy, true)
  }
})

test('② ★★ 自检**真的会拦**"各面按自己的副本重算"', () => {
  // 构造一个"重算式"的 observe：它按调用方给的（已被改过的）副本重算哈希。
  // 正确实现下 `inconsistentSurfaces` 恒为空，所以这条分支永远不触发——
  //
  //   > 一段永远不会触发的断言，与一段不存在的断言，
  //   > 在「它到底拦不拦得住」上是同一个东西。
  //
  // 注入一个重算式的 observeOf，就能验那道比较是活的。
  const f = frozenOf()
  const rewritten = structuredClone(ARGS)
  rewritten.path = '/etc/passwd'
  const recomputing = ({ frozen, surface }) => ({
    surface,
    arguments: rewritten,
    canonicalText: hashToolArguments({ toolName: frozen.toolName, args: rewritten }).canonicalText,
    canonicalHash: hashToolArguments({ toolName: frozen.toolName, args: rewritten }).canonicalHash,
    summary: frozen.summary,
  })
  const evidence = assertIdentityIsCarried({ frozen: f, observeOf: recomputing })
  assert.deepEqual(evidence.inconsistentSurfaces, [...OBSERVATION_SURFACES], '重算式的 observe 没有被识别出来')
  assert.notEqual(evidence.frozenHash, hashToolArguments({ toolName: f.toolName, args: rewritten }).canonicalHash)
})

test('② ★ 未知观察面要抛，不能静默当成某一个面', () => {
  const f = frozenOf()
  assert.throws(() => observe({ frozen: f, surface: 'sandbox' }), /未知的观察面/)
  assert.throws(() => observe({ frozen: f, surface: undefined }), /未知的观察面/)
})

test('② ★★ 观察面拿到**各自的拷贝**时必须被拒（"同一份"不是"内容相同"）', () => {
  // 破坏性验证发现：`assertSameAcrossSurfaces` 把 `sameReference` 硬写成 `true` 时
  // 用例不红——因为用例只断言了 `v.sameReference === true`。
  //
  //   > 一个「只断言那个布尔值是 true」的用例，
  //   > 与一个「从没验过它为假时会怎样」的用例，在「它到底拦不拦得住」上是同一个东西。
  //
  // 所以要**构造**"四个面各拿一份拷贝"的情形，验它真的会抛。
  const f = frozenOf()
  const copying = ({ frozen, surface }) => ({
    surface,
    arguments: structuredClone(frozen.arguments), // 内容相同，引用不同
    canonicalText: frozen.canonicalText,
    canonicalHash: frozen.canonicalHash,
    summary: frozen.summary,
  })
  assert.throws(
    () => assertSameAcrossSurfaces({ frozen: f, observeOf: copying }),
    /不是同一份/,
    '四个面各拿一份拷贝却没有被发现',
  )
  assert.throws(() => assertSameAcrossSurfaces({ frozen: f, observeOf: copying }), /同一引用=false/)
  // 真实实现安静通过，且读数正确
  assert.equal(assertSameAcrossSurfaces({ frozen: f }).sameReference, true)
})

test('② ★★ 观察面的哈希集合不一致时被拒（有人报的是别的值）', () => {
  const f = frozenOf()
  const liar = ({ frozen, surface }) => ({
    surface,
    arguments: frozen.arguments,
    canonicalText: frozen.canonicalText,
    canonicalHash: surface === 'audit' ? 'sha256:forged' : frozen.canonicalHash,
    summary: frozen.summary,
  })
  assert.throws(() => assertSameAcrossSurfaces({ frozen: f, observeOf: liar }), /不是同一份/)
})

test('② ★ 不是冻结体的东西要抛（不能各面自己造一个"看起来像"的）', () => {
  assert.throws(() => observe({ frozen: { arguments: {} }, surface: 'ui' }), /这不是一个冻结体/)
  assert.throws(() => assertSameAcrossSurfaces({ frozen: null }), /这不是一个冻结体/)
})

// --------------------------------------------------- ③ 改写检测

test('③ ★★ 参数被改写时**必须抛**，且指向"拒绝当前调用"', () => {
  const f = frozenOf()
  assert.equal(assertNotRewritten({ frozen: f, candidate: structuredClone(ARGS) }).unchanged, true)
  assert.throws(
    () => assertNotRewritten({ frozen: f, candidate: { ...structuredClone(ARGS), path: '/etc/passwd' } }),
    /工具参数被改写了/,
    '参数被改写了却没有被发现',
  )
  // 错误里要给出方向（spec 说只能拒绝、不能静默改写）
  assert.throws(
    () => assertNotRewritten({ frozen: f, candidate: { ...structuredClone(ARGS), path: '/etc/passwd' } }),
    /拒绝当前调用/,
  )
  assert.throws(
    () => assertNotRewritten({ frozen: f, candidate: { ...structuredClone(ARGS), path: '/etc/passwd' } }),
    new RegExp(ARG_FREEZE_CODES.REWRITTEN),
  )
  // 第二层被改也要抓到
  const nested = structuredClone(ARGS)
  nested.nested.deep.value = 999
  assert.throws(() => assertNotRewritten({ frozen: f, candidate: nested }), /工具参数被改写了/)
})

test('③ ★★ 改写检测的方向是固定的（不能两边都从 candidate 算）', () => {
  //   > 一个「两边都按同一个副本算哈希」的改写检测，
  //   > 与一个「恒真」的改写检测，是同一个东西。
  //
  // 用一个**恒返回同一份身份**的 hashOf 把那个恒真实现真的构造出来：
  // 它无论拿到什么 candidate 都返回冻结体的那一对值，于是检测失效。
  const f = frozenOf()
  const alwaysTheFrozenBody = () => ({ canonicalText: f.canonicalText, canonicalHash: f.canonicalHash })
  assert.equal(
    assertNotRewritten({ frozen: f, candidate: { path: '/etc/passwd' }, hashOf: alwaysTheFrozenBody }).unchanged,
    true,
    '注入恒等 hashOf 之后检测本应失效（这证明差异来自携带值，而不是 candidate 自己）',
  )
  // 真实实现：同一个 candidate 被抓住
  assert.throws(() => assertNotRewritten({ frozen: f, candidate: { path: '/etc/passwd' } }), /工具参数被改写了/)
  // 而且真实实现拿到的是**冻结体的** toolName —— 换工具名也算改写
  assert.throws(
    () => assertNotRewritten({ frozen: f, candidate: structuredClone(ARGS), hashOf: ({ toolName, args }) => hashToolArguments({ toolName: 'file_delete', args }) }),
    /工具参数被改写了/,
  )
})

test('③ ★★ 哈希相同但 canonical 文本不同也要抛（规范化不稳定）', () => {
  const f = frozenOf()
  const liar = { canonicalHash: f.canonicalHash, canonicalText: 'not-the-same-text' }
  assert.throws(() => assertNotRewritten({ frozen: f, candidate: structuredClone(ARGS), hashOf: () => liar }), /canonical 文本被改写/)
})

test('③ ★★ pre-execute 返回新参数时**抛**，而不是"用新参数自动重走审批"', () => {
  // spec：只能拒绝当前调用并要求模型产生一个新的 Tool Call。
  // "自动用新参数重新走一遍审批"与静默改写在"用户批的是不是被执行的那次"上同形。
  const f = frozenOf()
  const ok = resolvePreExecuteResult({ frozen: f })
  assert.equal(ok.kind, 'unchanged')
  assert.equal(ok.arguments, f.arguments)
  // 同值但不同引用 → 放行（一次 JSON 往返就会换掉引用，不能靠引用判等）
  const same = resolvePreExecuteResult({ frozen: f, proposed: structuredClone(ARGS) })
  assert.equal(same.kind, 'unchanged')
  assert.equal(same.arguments, f.arguments, '返回的应当是冻结体那一份，不是 proposed')
  assert.notEqual(same.arguments, undefined)
  // 真的改了 → 抛
  assert.throws(
    () => resolvePreExecuteResult({ frozen: f, proposed: { ...structuredClone(ARGS), mode: 'a' } }),
    /工具参数被改写了/,
    'pre-execute 改写了参数却被放行',
  )
})

// --------------------------------------------- ④ UI 摘要不参与身份

test('④ ★★ UI 摘要不参与身份：摘要变了，哈希不变', () => {
  const a = frozenOf({ summary: '写入 a.txt' })
  const b = frozenOf({ summary: '完全另一句话，甚至更长' })
  assert.equal(a.canonicalHash, b.canonicalHash, 'UI 摘要参与了身份')
  assert.equal(a.summary !== b.summary, true)
  assert.equal(observe({ frozen: a, surface: 'ui' }).summary, '写入 a.txt')
  // 四个面里只有 ui 需要摘要，但它照样不参与身份
  assert.equal(assertSameAcrossSurfaces({ frozen: a }).canonicalHash, assertSameAcrossSurfaces({ frozen: b }).canonicalHash)
})

test('④ ★★ 审批**不能**绑定到 UI 文案上', () => {
  //   > 一个「绑定到 UI 文案」的审批，与一个「绑定到参数摘要」的审批，
  //   > 是同一个东西——只不过前者让参数在文案相同的所有位置自由变化。
  const f = frozenOf({ summary: '写入 a.txt' })
  assert.equal(assertNotBoundToSummary({ frozen: f }).ok, true)
  // 绑定值就是参数哈希 → 合法
  assert.equal(assertNotBoundToSummary({ frozen: f, boundHash: f.canonicalHash }).ok, true)
  // 绑定值不是参数哈希 → 抛
  assert.throws(() => assertNotBoundToSummary({ frozen: f, boundHash: 'sha256:something-else' }), /绑定的不是参数身份/)
  // 绑定文本恰好是那句摘要 → 抛
  assert.throws(
    () => assertNotBoundToSummary({ frozen: f, boundText: '写入 a.txt' }),
    /绑定的是一句 UI 文案/,
    '审批绑定到了 UI 文案上',
  )
  // 绑定到摘要的哈希 → 抛（且必须是**具体**那条诊断，不是通用的"不是参数身份"）
  const summaryHash = `sha256:${'f'.repeat(64)}`
  assert.throws(() => assertNotBoundToSummary({ frozen: f, boundHash: summaryHash, summaryHash }), /摘要的哈希/)
  // 用一个"真的由摘要算出来"的哈希，形状更接近真实误用
  const realSummaryHash = hashToolArguments({ toolName: 'ui-summary', args: { text: f.summary } }).canonicalHash
  assert.throws(
    () => assertNotBoundToSummary({ frozen: f, boundHash: realSummaryHash, summaryHash: realSummaryHash }),
    /摘要的哈希/,
  )
})

test('④ ★ 两句话相同但参数不同 → 哈希必须不同（摘要替代不了参数）', () => {
  const a = freezeToolArguments({ toolName: 'file_write', args: { path: '/w/a.txt', mode: 'w' }, summary: '写文件' })
  const b = freezeToolArguments({ toolName: 'file_write', args: { path: '/w/b.txt', mode: 'w' }, summary: '写文件' })
  assert.equal(a.summary, b.summary)
  assert.notEqual(a.canonicalHash, b.canonicalHash, '摘要相同的两次不同调用拿到了同一个身份')
})

// ---------------------------------------------------- ⑤ 规范化与边界

test('⑤ ★★ 键序、NFC、-0 都不改变身份（canonical 规范的直接读法）', () => {
  const a = freezeToolArguments({ toolName: 't', args: { path: '/w/a.txt', mode: 'w' } })
  const reordered = freezeToolArguments({ toolName: 't', args: { mode: 'w', path: '/w/a.txt' } })
  assert.equal(a.canonicalHash, reordered.canonicalHash, '键序改变了参数身份')
  const nfc1 = freezeToolArguments({ toolName: 't', args: { name: 'cafe\u0301' } })
  const nfc2 = freezeToolArguments({ toolName: 't', args: { name: 'caf\u00e9' } })
  assert.equal(nfc1.canonicalHash, nfc2.canonicalHash, 'NFC 没有生效')
  const neg = freezeToolArguments({ toolName: 't', args: { n: -0 } })
  const pos = freezeToolArguments({ toolName: 't', args: { n: 0 } })
  assert.equal(neg.canonicalHash, pos.canonicalHash, '-0 与 0 应当是同一个身份')
  // 但**内容**不同就是不同（否则上面三条是空的）
  assert.notEqual(a.canonicalHash, freezeToolArguments({ toolName: 't', args: { path: '/w/a.txt', mode: 'a' } }).canonicalHash)
})

test('⑤ ★ 不同 toolName 是不同身份（工具名也是参数身份的一部分）', () => {
  const a = freezeToolArguments({ toolName: 'file_write', args: structuredClone(ARGS) })
  const b = freezeToolArguments({ toolName: 'file_delete', args: structuredClone(ARGS) })
  assert.notEqual(a.canonicalHash, b.canonicalHash)
})

test('⑤ ★ 参数不是对象、toolName 为空 → 抛（不猜）', () => {
  // 这里要断言**具体那句**。断言 `/非空 toolName/` 是不够的：
  // 移除 freeze 这一层的守卫后，控制权会落到 `hashToolArguments`，
  // 它抛的是"需要非空 toolName（工具名是参数身份的一部分）"——同一个正则照样匹配。
  //
  //   > 一个「只断言'抛了个包含 toolName 的错'」的用例，
  //   > 与一个「从没验过是哪一层抛的」的用例，在「这道守卫还在不在」上是同一个东西。
  //
  // 破坏性验证实测踩到过这一点（㊱㉔ 不红）。
  assert.throws(() => freezeToolArguments({ toolName: '', args: {} }), /freezeToolArguments 需要非空 toolName/)
  assert.throws(() => freezeToolArguments({ toolName: '   ', args: {} }), /freezeToolArguments 需要非空 toolName/)
  assert.throws(() => freezeToolArguments({ toolName: 't', args: null }), /需要 args/)
  assert.throws(() => freezeToolArguments({ toolName: 't', args: [1, 2] }), /需要 args/)
})

test('⑤ ★★ `hashToolArguments` 缺 toolName 时**必须**抛（工具名是身份的一部分）', () => {
  // 破坏性验证发现这条分支没有用例覆盖：把抛出删掉，一处都没红。
  // 而它一旦被删，`hashToolArguments({args})` 就会算出一个"没有工具名"的身份——
  // 那正是 ㊱① 那个"写文件的批准覆盖删文件"的另一条入口。
  for (const bad of [undefined, null, '', '   ', {}]) {
    assert.throws(() => hashToolArguments(bad), /需要非空 toolName/, JSON.stringify(bad))
  }
  assert.throws(() => hashToolArguments({ args: {} }), /需要非空 toolName/)
})

test('⑤ ★★ toolName 过 NFC 与 trim（同一个工具名两种写法是同一个身份）', () => {
  // 破坏性验证发现这条也没有用例覆盖。工具名不做 NFC 时，
  // 一个组合字符写法与预组合字符写法会得到两个身份，表现为"明明批准了却还是被拒"。
  const a = hashToolArguments({ toolName: 'cafe\u0301_write', args: { p: 1 } })
  const b = hashToolArguments({ toolName: 'caf\u00e9_write', args: { p: 1 } })
  assert.equal(a.canonicalHash, b.canonicalHash, '工具名的 NFC 没有生效')
  const c = hashToolArguments({ toolName: '  file_write  ', args: { p: 1 } })
  const d = hashToolArguments({ toolName: 'file_write', args: { p: 1 } })
  assert.equal(c.canonicalHash, d.canonicalHash, '工具名的空白没有 trim')
  // 而不同的工具名必须不同（否则上面两条是空的）
  assert.notEqual(a.canonicalHash, hashToolArguments({ toolName: 'other', args: { p: 1 } }).canonicalHash)
})

test('⑤ ★ 冻结体本身也是冻结的（改不动它的身份字段）', () => {
  const f = frozenOf()
  assert.equal(Object.isFrozen(f), true)
  assert.throws(() => { f.canonicalHash = 'forged' }, TypeError)
  assert.throws(() => { f.arguments = {} }, TypeError)
})

// ------------------------------------ ⑥ 序列化边界（携带值真正起作用的地方）

test('⑥ ★★ 一次观察序列化之后，仍然能被复核出属于同一个冻结体', () => {
  const f = frozenOf()
  const wire = serializeObservation(observe({ frozen: f, surface: 'audit' }))
  // 序列化之后引用必然不同
  assert.notEqual(wire.arguments, f.arguments)
  assert.deepEqual(wire.arguments, f.arguments)
  const v = assertObservationFaithful({ frozen: f, observation: wire })
  assert.equal(v.faithful, true)
  assert.equal(v.surface, 'audit')
})

test('⑥ ★★ "哈希对、参数被换过"必须被拒（最坏的一种形状）', () => {
  // 一份观察把参数换成了另一份，却仍然带着原来的哈希。所有哈希比对都会通过——
  // 只有"用参数重算、再去比冻结体"这一步能抓住它。
  const f = frozenOf()
  const wire = serializeObservation(observe({ frozen: f, surface: 'execution' }))
  const tampered = { ...wire, arguments: { ...wire.arguments, path: '/etc/passwd' } }
  assert.equal(tampered.canonicalHash, f.canonicalHash, '夹具：携带的哈希没有被改动')
  assert.throws(
    () => assertObservationFaithful({ frozen: f, observation: tampered }),
    /携带的\*\*参数\*\*与冻结体不一致/,
    '"哈希对、参数被换过"没有被发现——所有哈希比对都会通过，而执行的是另一份参数',
  )
})

test('⑥ ★★ 复核必须拿**冻结体**当基准，不能拿被检查对象自己', () => {
  //   > 一个「用被检查对象自己的数据去证明被检查对象」的复核，
  //   > 与一个恒真的复核，是同一个东西。
  //
  // 构造"自证式"复核：它只比 observation 内部的字段（哈希 vs 文本），
  // 于是篡改过的观察照样通过。用它证明真实复核的方向是固定的。
  const f = frozenOf()
  const wire = serializeObservation(observe({ frozen: f, surface: 'ui' }))
  const selfProving = ({ observation }) => observation.canonicalHash === observation.canonicalHash
  assert.equal(selfProving({ observation: { ...wire, canonicalHash: 'sha256:forged' } }), true,
    '夹具：自证式复核对伪造的哈希也返回 true')
  assert.throws(
    () => assertObservationFaithful({ frozen: f, observation: { ...wire, canonicalHash: 'sha256:forged' } }),
    /携带的身份与冻结体不一致/,
  )
})

test('⑥ ★ 观察携带的 canonical 文本对不上 → 抛', () => {
  const f = frozenOf()
  const wire = serializeObservation(observe({ frozen: f, surface: 'approval' }))
  assert.throws(
    () => assertObservationFaithful({ frozen: f, observation: { ...wire, canonicalText: 'other' } }),
    /canonical 文本与冻结体不一致/,
  )
  assert.throws(() => serializeObservation({ surface: 'ui' }), /需要一次观察的结果/)
  assert.throws(() => assertObservationFaithful({ frozen: f, observation: null }), /需要一份观察/)
})

test('⑥ ★ 序列化会剥掉引用，但不会剥掉身份（四个面在线的两端对得上）', () => {
  const f = frozenOf()
  for (const s of OBSERVATION_SURFACES) {
    const wire = serializeObservation(observe({ frozen: f, surface: s }))
    assert.equal(wire.canonicalHash, f.canonicalHash, `${s} 在序列化后身份变了`)
    assert.equal(assertObservationFaithful({ frozen: f, observation: wire }).faithful, true, s)
  }
})

test('⑤ ★ 装载时自检留下的版本与面清单', () => {
  assert.equal(TOOL_ARGS_CHECKED.version, TOOL_ARGS_VERSION)
  assert.deepEqual([...TOOL_ARGS_CHECKED.surfaces], ['approval', 'ui', 'audit', 'execution'])
  assert.match(TOOL_ARGS_CHECKED.sampleFrozenHash, /^sha256:[0-9a-f]{64}$/)
})
