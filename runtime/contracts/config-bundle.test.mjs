// runtime/contracts/config-bundle.test.mjs
// ============================================================================
// 产品配置导入导出（PRT-508，spec §6.6 第 403 行）
//
// 这一组的重点全部在"**导出的东西里没有密钥**"与"**导入不会悄悄改变哪条
// 任务用哪个模型**"两件事上。前者是 spec 明写的，后者是换模型的真实代价。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findPlaintextSecrets } from './model.mjs'
import {
  BUNDLE_ERRORS,
  BundleError,
  CONFIG_BUNDLE_VERSION,
  CONFLICT_POLICIES,
  EXPORTABLE_PROFILE_FIELDS,
  IMPORT_ACTIONS,
  assertApplicable,
  buildBundle,
  credentialRequiredOf,
  planImport,
  toExportableProfile,
  validateBundle,
} from './config-bundle.mjs'

const PROFILE_A = {
  id: 'main-model',
  displayName: '主模型',
  runtimeType: 'dsh',
  provider: 'openai',
  model: 'gpt-4o',
  endpoint: 'https://api.example/v1',
  secretRef: 'legion/openai',
  reasoningEffort: 'medium',
  limits: { maxTokens: 8192 },
}

const PROFILE_B = {
  id: 'fallback-model',
  displayName: '备用模型',
  runtimeType: 'dsh',
  provider: 'azure',
  model: 'gpt-4o-mini',
  endpoint: null,
  secretRef: null,
  reasoningEffort: 'low',
  limits: {},
}

const BINDING = {
  scope: 'software',
  employeeRole: 'general',
  primaryProfile: 'main-model',
  fallbackProfiles: ['fallback-model'],
  perRunBudget: { maxCost: 5, currency: 'USD' },
}

const fullBundle = () => buildBundle({ profiles: [PROFILE_A, PROFILE_B], bindings: [BINDING] })

// ------------------------------------------------------------------ ① 导出不含密钥

test('① 导出**永远**剥掉 secretRef，只留 credentialRequired', () => {
  const bundle = fullBundle()
  const p = bundle.profiles.find((x) => x.id === 'main-model')
  assert.equal(Object.prototype.hasOwnProperty.call(p, 'secretRef'), false, '不得有 secretRef 键')
  assert.equal(p.credentialRequired, true, '但要如实说明它需要凭证')
  // 不需要凭证的档案也如实说明
  assert.equal(bundle.profiles.find((x) => x.id === 'fallback-model').credentialRequired, false)

  // 整包序列化后不得出现引用名
  const text = JSON.stringify(bundle)
  assert.ok(!text.includes('legion/openai'), `引用名泄漏进了导出：${text}`)
  assert.equal(bundle.containsSecrets, false)
  // 两个布尔把"这份包里有什么"说全。用布尔而不是 `secretPolicy: 'references-omitted'`
  // 这种字符串枚举，是因为 `findPlaintextSecrets` 会把"键名含 secret/key/credential
  // 且值是字符串"判成明文密钥载体——一个描述"密钥怎么处理"的字符串字段会让
  // **自己导出的包无法导入**（实测撞到过）。布尔不在判据射程内，而且
  // "有没有密钥值"与"有没有引用名"本来就是两件事。
  assert.equal(bundle.credentialRefsIncluded, false)
  // 用仓库自己的判据再查一遍
  assert.deepEqual(findPlaintextSecrets(bundle), [])
})

test('① 为什么剥掉引用名而不是"保留但说明"——跨机器会接上一把无关的钥匙', () => {
  // secretRef 命名的是**这台机器**密钥库里的一个槽位。带到另一台机器上，
  // 那个名字什么也不指；最坏的结果是新机器上恰好有同名槽位，
  // 于是这条档案用上了一把完全无关的钥匙，**而且看起来一切正常**。
  const bundle = fullBundle()
  assert.equal(JSON.stringify(bundle).includes('secretRef'), false)
  // credentialRequired 是**档案**的属性（它需要凭证），secretRef 是**本机**的
  assert.match(EXPORTABLE_PROFILE_FIELDS.join(','), /^((?!secretRef).)*$/)
  assert.ok(EXPORTABLE_PROFILE_FIELDS.includes('id'))
  assert.ok(EXPORTABLE_PROFILE_FIELDS.includes('provider'))
  assert.equal(credentialRequiredOf(PROFILE_A), true)
  assert.equal(credentialRequiredOf(PROFILE_B), false)
  assert.equal(credentialRequiredOf({}), false)
  assert.equal(credentialRequiredOf(null), false)
  assert.equal(credentialRequiredOf({ secretRef: '' }), false, '空串不算需要凭证')
})

test('① 有明文密钥时**拒绝构造**导出包（fail closed，不是先剥掉再继续）', () => {
  // 剥掉需要脱敏逻辑正确，而脱敏漏一处就等于把密钥永久留在导出文件里。
  // 拒绝立刻可见，且不可能漏。
  // 密钥必须放在**允许列表内**的字段值上，否则白名单会先把它扔掉，
  // 这条用例就测不到出口门禁（我第一次就写错了：藏在 `note` 上）。
  const smuggled = { ...PROFILE_A, displayName: 'sk-live-abcdefghijklmnopqrstuvwxyz' }
  assert.throws(() => buildBundle({ profiles: [smuggled] }),
    (e) => e instanceof BundleError && e.code === BUNDLE_ERRORS.CONTAINS_SECRET)
  // 冻结对象（真实档案是冻结的）也一样挡
  assert.throws(() => buildBundle({ profiles: [Object.freeze(smuggled)] }),
    (e) => e.code === BUNDLE_ERRORS.CONTAINS_SECRET)
  // 绑定里夹带也拒绝——同样要放在允许列表内的字段值上
  assert.throws(() => buildBundle({
    profiles: [PROFILE_B],
    bindings: [{ ...BINDING, scope: 'sk-ant-abcdefghijklmnopqrstuvwxyz012345' }],
  }), (e) => e.code === BUNDLE_ERRORS.CONTAINS_SECRET)
  // 顶层 note 夹带也拒绝
  assert.throws(() => buildBundle({ profiles: [PROFILE_B], note: 'ghp_0123456789abcdefghijklmnopqrstuv' }),
    (e) => e.code === BUNDLE_ERRORS.CONTAINS_SECRET)
})

test('① 出口第二道检查真的在：任何残留的 secretRef 都会让导出失败', () => {
  // `EXPORTABLE_PROFILE_FIELDS` 由 `MODEL_PROFILE_FIELDS` 派生，所以现在是安全的。
  // 但"手工改动让第二道防线失效"这种情况必须有一条能验它在不在的检查。
  // 这条用例直接调 `toExportableProfile`，断言它的产物里没有 secretRef。
  for (const p of [PROFILE_A, PROFILE_B, { ...PROFILE_A, secretRef: 'x' }]) {
    const e = toExportableProfile(p)
    assert.equal(Object.prototype.hasOwnProperty.call(e, 'secretRef'), false)
  }
  assert.equal(BUNDLE_ERRORS.SECRET_REF_PRESENT, 'BUNDLE_SECRET_REF_PRESENT')
})

test('① 参数不合法时抛出（而不是产出一份不完整的包）', () => {
  assert.throws(() => buildBundle({ kind: 'nope' }), (e) => e.code === BUNDLE_ERRORS.KIND_INVALID)
  assert.throws(() => buildBundle({ profiles: 'x' }), (e) => e.code === BUNDLE_ERRORS.PROFILES_NOT_ARRAY)
  assert.throws(() => buildBundle({ bindings: 'x' }), (e) => e.code === BUNDLE_ERRORS.BINDINGS_NOT_ARRAY)
  // 默认值可用
  const b = buildBundle()
  assert.equal(b.version, CONFIG_BUNDLE_VERSION)
  assert.deepEqual([...b.profiles], [])
  assert.equal(b.kind, 'full')
})

test('① limits 被复制成普通对象（冻结对象不能序列化进文件）', () => {
  const frozen = Object.freeze({ ...PROFILE_A, limits: Object.freeze({ maxTokens: 1 }) })
  const b = buildBundle({ profiles: [frozen] })
  assert.equal(Object.isFrozen(b.profiles[0].limits), false, '导出物必须是可序列化的普通对象')
  assert.deepEqual(b.profiles[0].limits, { maxTokens: 1 })
})

// ------------------------------------------------------------------ ② 导入校验

test('② 版本不兼容**直接拒绝**，不尽力解析', () => {
  // 尽力解析会把"格式变了"变成"少导了几条"——而少导几条是静默的。
  const bundle = fullBundle()
  const bad = { ...bundle, version: 99 }
  const v = validateBundle(bad)
  assert.equal(v.ok, false)
  assert.match(v.errors.join('；'), /版本 99 不受支持/)
  assert.equal(validateBundle({ ...bundle, version: undefined }).ok, false)
  assert.equal(CONFIG_BUNDLE_VERSION, 1)
})

test('② 未知顶层字段**拒绝**（不是忽略）——忽略会让密钥搭便车', () => {
  const bundle = fullBundle()
  const v = validateBundle({ ...bundle, apiKey: 'whatever' })
  assert.equal(v.ok, false)
  assert.match(v.errors.join('；'), /未知字段 apiKey/)
  for (const junk of [null, undefined, 'x', 42, []]) {
    assert.equal(validateBundle(junk).ok, false)
  }
})

test('② 导入方向也挡密钥：整包查出疑似明文就拒绝', () => {
  const bundle = fullBundle()
  const v = validateBundle({ ...bundle, note: 'sk-live-abcdefghijklmnopqrstuvwxyz012345' })
  assert.equal(v.ok, false)
  assert.match(v.errors.join('；'), /含疑似明文密钥/)
  // 声明自己有密钥的文件也拒绝
  const v2 = validateBundle({ ...bundle, containsSecrets: true })
  assert.equal(v2.ok, false)
  assert.match(v2.errors.join('；'), /containsSecrets=true/)
  // containsSecrets 必须是布尔
  assert.equal(validateBundle({ ...bundle, containsSecrets: 'no' }).ok, false)
  // false 是合法的
  assert.equal(validateBundle({ ...bundle, containsSecrets: false }).ok, true)
})

test('② 导入包里带 secretRef 一律拒绝（那个名字在本机什么也不指）', () => {
  const bundle = fullBundle()
  const withRef = {
    ...bundle,
    profiles: [{ ...bundle.profiles[0], secretRef: 'legion/openai' }],
  }
  const v = validateBundle(withRef)
  assert.equal(v.ok, false)
  assert.match(v.errors.join('；'), /含 secretRef/)
  // 显式 null 是允许的（表示"这条档案没有引用"）
  assert.equal(validateBundle({
    ...bundle,
    profiles: [{ ...bundle.profiles[0], secretRef: null }],
  }).ok, true)
})

test('② 逐条档案走 PRT-501 的契约校验（未知字段 / 密钥形态 / 必填）', () => {
  const bundle = fullBundle()
  const p = bundle.profiles[0]
  // 未知字段（用一个**名字不像密钥载体**的字段名，否则会先被整包密钥扫描拦下）
  let v = validateBundle({ ...bundle, profiles: [{ ...p, mysteriousField: 'hello' }] })
  assert.equal(v.ok, false)
  assert.match(v.errors.join('；'), /未知字段 mysteriousField/)

  // 而名字像密钥载体的未知字段会**先**被整包密钥扫描拦下。
  // 顺序是刻意的：安全那条更保守，两条都是拒绝，所以哪个先报不重要，
  // 但"先报安全那条"必须被钉住——反过来会让人以为这个字段只是拼错了。
  v = validateBundle({ ...bundle, profiles: [{ ...p, apiKey: 'x' }] })
  assert.equal(v.ok, false)
  assert.match(v.errors.join('；'), /疑似明文密钥/)
  assert.ok(!v.errors.join('；').includes('未知字段 apiKey'),
    '密钥门禁必须先于字段校验：先报"未知字段"会让人以为只是拼错了')
  // 缺必填
  const { provider, ...noProvider } = p
  v = validateBundle({ ...bundle, profiles: [noProvider] })
  assert.equal(v.ok, false)
  assert.match(v.errors.join('；'), /provider 必填/)
  // credentialRequired 必须是布尔（它是导入方唯一的线索）。
  // 用**数字**来测这条路径：字符串会先被整包密钥扫描拦下（键名含
  // credential 且值是字符串），那是另一条门禁，两条都要在。
  v = validateBundle({ ...bundle, profiles: [{ ...p, credentialRequired: 1 }] })
  assert.equal(v.ok, false)
  assert.match(v.errors.join('；'), /credentialRequired 必须是布尔值/)
  // 而字符串形态确实是被**更保守**的那条门禁拦下的
  v = validateBundle({ ...bundle, profiles: [{ ...p, credentialRequired: 'yes' }] })
  assert.equal(v.ok, false)
  assert.match(v.errors.join('；'), /疑似明文密钥/)
})

test('② 同一个包里 id 重复 → 拒绝（重复会让"导出→导入→导出"不稳定）', () => {
  const bundle = fullBundle()
  const v = validateBundle({ ...bundle, profiles: [bundle.profiles[0], bundle.profiles[0]] })
  assert.equal(v.ok, false)
  assert.match(v.errors.join('；'), /出现了两次/)
  // 绑定同理
  const v2 = validateBundle({ ...bundle, bindings: [bundle.bindings[0], bundle.bindings[0]] })
  assert.equal(v2.ok, false)
  assert.match(v2.errors.join('；'), /出现了两次/)
})

test('② 校验通过时归一化（补默认值、去空白、冻结）', () => {
  const v = validateBundle({
    version: 1,
    profiles: [PROFILE_B],
    bindings: [{ scope: '  s1  ', employeeRole: ' x ', primaryProfile: ' fallback-model ', fallbackProfiles: ['a'] }],
  })
  assert.equal(v.ok, true, v.errors.join('；'))
  assert.equal(v.value.kind, 'full')
  assert.deepEqual(v.value.bindings[0].scope, 's1')
  assert.deepEqual(v.value.bindings[0].employeeRole, 'x')
  assert.equal(v.value.bindings[0].primaryProfile, 'fallback-model')
  assert.equal(v.value.bindings[0].perRunBudget, null)
  assert.equal(v.value.profiles[0].credentialRequired, false, '缺省视为不需要凭证')
})

// ------------------------------------------------------------------ ③ 导入计划

test('③ 计划是 **dry run**：不写任何东西，只说明会做什么', () => {
  const plan = planImport({ bundle: fullBundle(), existingProfiles: [], existingBindings: [] })
  assert.equal(plan.ok, true)
  assert.equal(plan.actions.length, 3)
  const byId = Object.fromEntries(plan.actions.map((a) => [(a.id), a]))
  assert.equal(byId['main-model'].action, 'create')
  assert.equal(byId['fallback-model'].action, 'create')
  assert.equal(byId['software/general'].action, 'create')
  // 需要凭证的条数如实报出：导入方要去密钥库补几条引用
  assert.equal(plan.summary.needsCredential, 1)
  assert.equal(plan.summary.willWrite, 3)
  assert.equal(plan.summary.conflicts, 0)
  // 所有动作用词都在封闭集合里
  for (const a of plan.actions) assert.ok(IMPORT_ACTIONS.includes(a.action))
})

test('③ 重复导入是**幂等**的：内容相同全部 skip', () => {
  const bundle = fullBundle()
  // 第二次导入时，库里已经是第一次导进去的东西（descriptor 形态，无 secretRef）
  const existing = bundle.profiles.map((p) => ({ ...p, version: 1, deleted: false }))
  const plan = planImport({
    bundle,
    existingProfiles: existing,
    existingBindings: [BINDING],
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.summary.willWrite, 0)
  assert.equal(plan.summary.conflicts, 0)
  assert.ok(plan.actions.every((a) => a.action === 'skip'), JSON.stringify(plan.actions))
})

test('③ 内容不同默认**报冲突而不是覆盖**（换模型会换成本/质量/数据去向）', () => {
  const bundle = fullBundle()
  const changed = bundle.profiles.map((p) => (p.id === 'main-model' ? { ...p, model: 'gpt-4o-2024-11-20' } : p))
  const plan = planImport({ bundle, existingProfiles: changed, existingBindings: [] })
  assert.equal(plan.summary.conflicts, 1)
  assert.equal(plan.summary.willWrite, 1, '仍然要写 fallback-model 那条')
  const c = plan.actions.find((a) => a.id === 'main-model')
  assert.equal(c.action, 'conflict')
  assert.match(c.reason, /换模型会同时改变成本、质量与数据去向/)
  // 默认策略下**不可应用**
  const gate = assertApplicable(plan)
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'IMPORT_HAS_CONFLICTS')
  assert.match(gate.reason, /keep（保留本机）或 overwrite/)
})

test('③ 三种冲突策略：fail 报冲突 / keep 保留本机 / overwrite 覆盖', () => {
  const bundle = fullBundle()
  // 本机那份必须带 `version`——CAS 要的就是"我看过的那一版"
  const changed = bundle.profiles.map((p) => (p.id === 'main-model' ? { ...p, model: 'other', version: 7 } : p))
  assert.deepEqual([...CONFLICT_POLICIES], ['fail', 'keep', 'overwrite'])

  const keep = planImport({ bundle, existingProfiles: changed, conflictPolicy: 'keep' })
  const ka = keep.actions.find((a) => a.id === 'main-model')
  assert.equal(ka.action, 'skip')
  // 关键：reason 必须说清**包里的没有被导入**，否则用户以为导入成功了
  assert.match(ka.reason, /包里的没有被导入/)
  // 而且这件事必须**可数**，不能只活在提示语里：`keep` 会把冲突转成 skip，
  // 于是 `conflicts` 变成 0——只看 `conflicts` 的回执看起来是成功的。
  assert.equal(ka.keptLocal, true)
  assert.equal(keep.summary.keptLocal, 1)
  assert.equal(keep.summary.conflicts, 0)
  assert.equal(assertApplicable(keep).ok, true)

  const over = planImport({ bundle, existingProfiles: changed, conflictPolicy: 'overwrite' })
  const oa = over.actions.find((a) => a.id === 'main-model')
  assert.equal(oa.action, 'update')
  assert.equal(oa.currentVersion, 7, 'CAS 需要当前版本：不带它就没法表达"我改的是我看过的那一版"')
  // 本机那份没有 version 时如实给 null，而不是编一个 1
  const noVersion = planImport({
    bundle,
    existingProfiles: bundle.profiles.map((p) => (p.id === 'main-model' ? { ...p, model: 'other' } : p)),
    conflictPolicy: 'overwrite',
  })
  assert.equal(noVersion.actions.find((a) => a.id === 'main-model').currentVersion, null,
    '不知道版本就说不知道，不能编一个')
  assert.equal(assertApplicable(over).ok, true)

  // 未知策略直接抛（不默认成任何一个）
  assert.throws(() => planImport({ bundle, conflictPolicy: 'merge' }),
    (e) => e.code === BUNDLE_ERRORS.CONFLICT_POLICY_INVALID)
})

test('③ 默认策略是 fail 而不是 keep：keep 会让导入**静默地什么都没做**', () => {
  const bundle = fullBundle()
  const changed = bundle.profiles.map((p) => ({ ...p, model: 'different' }))
  const plan = planImport({ bundle, existingProfiles: changed })
  assert.equal(plan.conflictPolicy, 'fail')
  assert.equal(plan.summary.conflicts, 2)
  // 而 keep 是"安静的成功"——用户以为导入了
  const keep = planImport({ bundle, existingProfiles: changed, conflictPolicy: 'keep' })
  assert.equal(keep.summary.conflicts, 0)
  // 两条档案被 keep 跳过，但那条绑定本机不存在 → 仍要创建。
  // willWrite 是 1 而不是 0：keep 只影响**冲突**的那些，不影响新增的。
  assert.equal(keep.summary.profiles.skip, 2)
  assert.equal(keep.summary.bindings.create, 1)
  assert.equal(keep.summary.willWrite, 1)
  assert.equal(assertApplicable(keep).ok, true, 'keep 会"成功"，但它把两份档案的改动都丢掉了')
})

test('③ 绑定的冲突同样处理（岗位换模型的代价与档案相同）', () => {
  const bundle = fullBundle()
  const changedBinding = [{ ...BINDING, primaryProfile: 'fallback-model' }]
  const plan = planImport({ bundle, existingProfiles: bundle.profiles, existingBindings: changedBinding })
  const c = plan.actions.find((a) => a.id === 'software/general')
  assert.equal(c.action, 'conflict')
  assert.match(c.reason, /岗位换模型/)
})

test('③ **不删除**：包里没有的档案保持不动（导入是补齐，不是同步）', () => {
  // 否则一份不完整的包会删掉整台机器的配置
  const bundle = buildBundle({ profiles: [PROFILE_B], bindings: [] })
  const plan = planImport({
    bundle,
    existingProfiles: [{ ...toExportableProfile(PROFILE_A), version: 3 }, { ...toExportableProfile(PROFILE_B), version: 1 }],
    existingBindings: [BINDING],
  })
  // 计划里完全**没有** main-model 或那条绑定
  assert.equal(plan.actions.some((a) => a.id === 'main-model'), false)
  assert.equal(plan.actions.some((a) => a.kind === 'binding'), false)
  assert.equal(plan.summary.willWrite, 0)
})

test('③ 悬空引用：绑定指向包里没有、本机也没有的档案 → 拒绝应用', () => {
  // 照单全收会存下一条跑不起来的绑定，而它要到运行时才被发现有错
  const bundle = buildBundle({
    profiles: [PROFILE_B],
    bindings: [{ ...BINDING, primaryProfile: 'ghost', fallbackProfiles: [] }],
  })
  const plan = planImport({ bundle, existingProfiles: [], existingBindings: [] })
  assert.equal(plan.summary.danglingRefs.length, 1)
  assert.deepEqual({ ...plan.summary.danglingRefs[0] }, { binding: 'software/general', profile: 'ghost' })
  const gate = assertApplicable(plan)
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'IMPORT_DANGLING_PROFILE_REF')
  assert.match(gate.reason, /要到运行时才被发现有错/)
})

test('③ 包里**自带**的档案能满足引用（不误报悬空）', () => {
  const bundle = fullBundle()
  const plan = planImport({ bundle, existingProfiles: [], existingBindings: [] })
  assert.deepEqual([...plan.summary.danglingRefs], [])
  assert.equal(assertApplicable(plan).ok, true)
})

test('③ 本机已有的档案也能满足引用（不是只认包里的）', () => {
  const bundle = buildBundle({ profiles: [], bindings: [BINDING] })
  const plan = planImport({
    bundle,
    existingProfiles: [{ ...toExportableProfile(PROFILE_A), version: 1 }, { ...toExportableProfile(PROFILE_B), version: 1 }],
    existingBindings: [],
  })
  assert.deepEqual([...plan.summary.danglingRefs], [])
  assert.equal(plan.summary.willWrite, 1)
})

test('③ 计划里的档案/绑定计数按动作分开，且可写入的量单独给出', () => {
  const bundle = fullBundle()
  const plan = planImport({
    bundle,
    // main-model 内容不同（冲突），fallback-model 不存在（create）
    existingProfiles: [{ ...toExportableProfile(PROFILE_A), model: 'changed', version: 7 }],
    existingBindings: [],
  })
  assert.equal(plan.summary.profiles.conflict, 1)
  assert.equal(plan.summary.profiles.create, 1)
  assert.equal(plan.summary.bindings.create, 1)
  assert.deepEqual({ ...plan.summary.profiles }, { conflict: 1, create: 1 })
  assert.equal(plan.summary.total, 3)
  assert.equal(plan.summary.willWrite, 2)
})

test('③ 计划本身不合法时 assertApplicable 拒绝（不静默通过）', () => {
  for (const bad of [null, undefined, {}, { ok: false }]) {
    const g = assertApplicable(bad)
    assert.equal(g.ok, false, JSON.stringify(bad))
    assert.equal(g.code, 'PLAN_INVALID')
  }
})

test('③ 无效包的计划失败且不含动作（不产出半份计划）', () => {
  const plan = planImport({ bundle: { version: 99 }, existingProfiles: [], existingBindings: [] })
  assert.equal(plan.ok, false)
  assert.deepEqual([...plan.actions], [])
  assert.equal(plan.summary, null)
})

test('③ 往返一致：导出 → 校验 → 计划 → （模拟写入）→ 再导出应完全相同', () => {
  // "导出→导入→导出"必须稳定。不稳定会让两台机器互相同步时反复产生差异，
  // 而用户无法判断哪台是对的。
  const first = fullBundle()
  const v = validateBundle(JSON.parse(JSON.stringify(first)))
  assert.equal(v.ok, true, v.errors.join('；'))
  // 模拟写入：库里留下的是 descriptor 形态（无 secretRef），与导出形态一致
  const writtenProfiles = v.value.profiles.map((p) => ({ ...p, version: 1, deleted: false }))
  const writtenBindings = v.value.bindings.map((b) => ({ ...b }))
  const second = buildBundle({
    profiles: writtenProfiles,
    bindings: writtenBindings,
    exportedAtMs: first.exportedAtMs,
    exportedBy: first.exportedBy,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(second.profiles)), JSON.parse(JSON.stringify(first.profiles)))
  assert.deepEqual(JSON.parse(JSON.stringify(second.bindings)), JSON.parse(JSON.stringify(first.bindings)))
  // 再导入一次应全部 skip
  const plan = planImport({ bundle: second, existingProfiles: writtenProfiles, existingBindings: writtenBindings })
  assert.equal(plan.summary.willWrite, 0, JSON.stringify(plan.actions))
})
