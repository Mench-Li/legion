// workbench/scripts/agent-workflow-defaults.test.mjs — 「Agent 工作流」面板的默认值。
// 运行：node --experimental-strip-types workbench/scripts/agent-workflow-defaults.test.mjs
//
// ## 这份用例守的是哪次事故
//
// 用户的原话：**「我看到工作流配置，相当茫然，完全不知道怎么配置」**。
//
// 实测（2026-10-13）那台环境的真实状态：
//
//     工作流定义 0 个 ｜ 工具配置 0 个 ｜ 执行节点 0 个
//     pipeline.workflow = null ｜ 8 个流水线阶段的 agentToolConfig 全为空
//
// 而面板一点开就替用户选好了 **Claude Code + Codex**（两个根本没装的外部产品），
// 接着弹两条"没有就绪心跳"告警、给一条 `dsh plugin add …` 命令，
// 并留下一个**查不到、又是必填**的"provider 注册名"（发布时直接抛错）。
//
//   > 一组"看起来已经替你配好了"的默认值，与一组"配好了、但按下去必然失败"的默认值，
//   > 在**还没按下去**的时候长得一模一样。
//
// 所以这份用例钉住的三条是**默认值的资格**，不是"默认值长什么样"：
//   ① 默认状态必须可发布（不能一打开就缺必填项）；
//   ② 默认值不得预设用户没装的东西；
//   ③ 只有用户真的选了外部工具，才提示外部依赖缺失。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_NATIVE_PROVIDER,
  NATIVE_TOOL_DEFAULTS,
  PREFERRED_ROLES,
  defaultRoleFor,
  externalToolsChosen,
  nativeProviderCandidates,
  providerChoiceValidation,
  providerChoices,
  readinessSummary,
  scopeReadiness,
} from '../src/agentWorkflowDefaults.ts'

describe('工作流面板的默认值', () => {
  test('★ ① 默认工具**不得**预设外部产品：三个阶段都必须是本地执行服务', () => {
    for (const [key, tool] of Object.entries(NATIVE_TOOL_DEFAULTS)) {
      assert.equal(tool, 'dsh-native',
        `${key} 的默认工具是 ${tool}。默认值只能选"随 Legion 一起跑、不需要额外安装"的那一个；` +
        `预设外部产品会让没有它的用户一打开就去查那两个产品（这就是"茫然"的来源）。`)
    }
  })

  test('★ ② 默认 provider 非空且是 DSH 内置的那个（否则用户必须先读源码才能发布）', () => {
    assert.ok(typeof DEFAULT_NATIVE_PROVIDER === 'string' && DEFAULT_NATIVE_PROVIDER.trim().length > 0,
      '默认 provider 留空 + 发布时必填 = 用户必须去读 DSH 源码才知道填什么')
    assert.equal(DEFAULT_NATIVE_PROVIDER, 'spawn',
      '该值须与 plugins/src/index.ts 里 `provider: z.string().default(\'spawn\')` 一致；' +
      'DSH 改了默认值，这里要跟着改')
  })

  test('★ ③ 外部工具告警只在**用户真的选了**外部工具时才亮', () => {
    // 出厂默认（三个本地）⇒ 一条告警都不该有
    assert.equal(externalToolsChosen(Object.values(NATIVE_TOOL_DEFAULTS)), false,
      '默认状态下不该提示外部依赖缺失 —— 用户什么都还没选')
    // 用户显式选了 ⇒ 必须提示
    assert.equal(externalToolsChosen(['dsh-native', 'codex']), true)
    assert.equal(externalToolsChosen(['claude-code']), true)
    assert.equal(externalToolsChosen(['dsh-native', 'dsh-native']), false)
    assert.equal(externalToolsChosen([]), false, '空集合 = 还没得选，不该报')
    // 不认识的取值按"外部"处理（宁可多提示，不要静默漏掉）
    assert.equal(externalToolsChosen(['something-else']), true)
  })

  test('provider 候选：至少含默认值，且不把外部 adapter 混进"本地"候选', () => {
    const bare = nativeProviderCandidates([])
    assert.deepEqual(bare, [DEFAULT_NATIVE_PROVIDER], '没有任何节点时应当只给默认值')

    const withNodes = nativeProviderCandidates([
      { observedProviders: ['spawn', 'custom-native'] },
      { providerNames: ['codex', 'claude-code', 'another'] },
    ])
    assert.ok(withNodes.includes(DEFAULT_NATIVE_PROVIDER))
    assert.ok(withNodes.includes('custom-native'), '心跳上报的本地 provider 应当进候选')
    assert.ok(withNodes.includes('another'), 'providerNames 字段也要认（两种字段名都在用）')
    assert.ok(!withNodes.includes('codex'), 'codex 是外部 adapter，不该出现在"本地执行服务"候选里')
    assert.ok(!withNodes.includes('claude-code'), '同上')
    assert.equal(new Set(withNodes).size, withNodes.length, '候选不得重复')
    assert.deepEqual(withNodes, [...withNodes].sort(), '候选排序稳定（下拉顺序不该每次都变）')
  })

  test('provider 候选对脏数据不炸（null / 非数组 / 空串）', () => {
    assert.doesNotThrow(() => nativeProviderCandidates(null))
    assert.doesNotThrow(() => nativeProviderCandidates(undefined))
    assert.doesNotThrow(() => nativeProviderCandidates([{}]))
    assert.doesNotThrow(() => nativeProviderCandidates([{ observedProviders: ['', 'ok'] }]))
    assert.deepEqual(nativeProviderCandidates([{ observedProviders: ['', 'ok'] }]).sort(), ['ok', 'spawn'])
  })

  test('岗位默认：优先挑语义匹配的岗位，挑不到就退第一个已启用阶段', () => {
    const stages = [
      { role: 'requirement', enabled: true },
      { role: 'researcher', enabled: true },
      { role: 'coder', enabled: true },
      { role: 'reviewer', enabled: true },
      { role: 'devops', enabled: false },
    ]
    // ⚠ 语义是"按**流水线顺序**找第一个落在候选集合里的阶段"，**不是**按候选集合的优先级排。
    //    所以 designRole 在 requirement 与 researcher 都在时挑中 **requirement**。
    //    （这是从原 `defaultRole` 逐字搬过来的行为，本用例刻意把它钉住 ——
    //      如果哪天有人想改成"按优先级挑"，那是一次行为变更，应当让这条用例先红。）
    assert.deepEqual(PREFERRED_ROLES.designRole, ['designer', 'researcher', 'requirement'])
    assert.equal(defaultRoleFor(stages, 'designRole'), 'requirement', '按流水线顺序取第一个匹配项')
    assert.equal(defaultRoleFor(stages, 'implementationRole'), 'coder')
    assert.equal(defaultRoleFor(stages, 'reviewRole'), 'reviewer')
    assert.equal(defaultRoleFor(stages, 'designRole'), defaultRoleFor(stages, 'designRole'), '确定性')

    // 只有 requirement 时，三个阶段都退到它（而不是留空 —— 留空会让表单不可发布）
    const onlyOne = [{ role: 'requirement', enabled: true }]
    for (const key of Object.keys(PREFERRED_ROLES)) {
      assert.equal(defaultRoleFor(onlyOne, key), 'requirement', key + ' 应当退到第一个已启用阶段')
    }
    // 全都没启用 / 空列表 ⇒ 空串（调用方据此报"不足三个已启用阶段"）
    assert.equal(defaultRoleFor([], 'designRole'), '')
    assert.equal(defaultRoleFor([{ role: 'x', enabled: false }], 'designRole'), '', '未启用的阶段不算候选')
    assert.equal(defaultRoleFor(null, 'designRole'), '')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// provider 就绪度 → 候选（2026-10-13）
//
// 这一组守的是"相当茫然"那个问题的正面回答：不再要求用户**知道并填写** provider 名，
// 而是从守护的本机自检读数里派生候选。
//
// 核心分歧点只有两个，且都不是"列表长什么样"：
//   ① **"还没有读数" 不是 "不可用"** —— 两者会让用户做完全不同的事（等 vs 去修）；
//   ② **读数只用来说，不用来否决** —— 自检有 10 分钟 TTL，拿它拦发布等于"我刚修好却不让发"。
// ════════════════════════════════════════════════════════════════════════════

describe('provider 就绪度 → 候选', () => {
  const members = [
    { member: 'worker@A', scope: 'A', kind: 'worker', online: true, lastSeenAt: '2026-10-13T10:00:00Z',
      providers: { spawn: { state: 'ready' }, codex: { state: 'missing_cli', reason: 'PATH 上找不到 codex' } } },
    { member: 'exec@A', scope: 'A', kind: 'executor', online: true, lastSeenAt: '2026-10-13T11:00:00Z',
      providers: { spawn: { state: 'ready' }, 'other-thing': { state: 'ready' } } },
    { member: 'worker@B', scope: 'B', kind: 'worker', online: true, lastSeenAt: '2026-10-13T12:00:00Z',
      providers: { claude: { state: 'ready' } } },
    { member: 'old@A', scope: 'A', kind: 'worker', online: true, lastSeenAt: '2026-10-13T13:00:00Z', providers: null },
  ]

  test('★ 取**本空间**的读数，且优先 kind=worker（答"本机能不能跑"的是守护）', () => {
    const r = scopeReadiness(members, 'A')
    assert.equal(r.member, 'worker@A', '哪怕 executor 的 lastSeenAt 更新，也该取守护那条')
    assert.equal(r.providers.codex.state, 'missing_cli')
    assert.equal(scopeReadiness(members, 'B').member, 'worker@B')
  })

  test('★ 没有读数 ⇒ null（"还没上报"，**不是**"不可用"）', () => {
    assert.equal(scopeReadiness(members, 'C'), null, '没有该空间的成员')
    assert.equal(scopeReadiness([], 'A'), null)
    assert.equal(scopeReadiness(null, 'A'), null)
    // 只有 providers=null 的成员 ⇒ 仍是 null（那是"旧守护还没上报"）
    assert.equal(scopeReadiness([{ member: 'old@A', scope: 'A', kind: 'worker', providers: null }], 'A'), null)
  })

  test('★ 候选包含读数外的**已知默认值**（刚装好、还没轮到自检时也能选）', () => {
    const choices = providerChoices(scopeReadiness(members, 'A'))
    const names = choices.map(c => c.name)
    assert.ok(names.includes('codex'), '读数里的要在')
    assert.ok(names.includes(DEFAULT_NATIVE_PROVIDER), '默认值永远要在 —— 它不需要安装')
    assert.ok(!names.includes('other-thing'), '别的空间的读数不该混进来')
  })

  test('★ 没有读数时，候选至少给出默认值（不是空列表）', () => {
    const choices = providerChoices(null)
    assert.deepEqual(choices.map(c => c.name), [DEFAULT_NATIVE_PROVIDER])
    assert.equal(choices[0].state, null, 'state=null 表示还没读数')
    assert.equal(choices[0].ready, false, '没读数不等于就绪')
  })

  test('★ 排序稳定且"就绪"在前：就绪 → 有读数但不就绪 → 没读数', () => {
    const choices = providerChoices(scopeReadiness(members, 'A'))
    const groups = choices.map(c => (c.ready ? 0 : c.state === null ? 2 : 1))
    assert.deepEqual(groups, [...groups].sort((a, b) => a - b), '组序必须是就绪在前')
    // 同组内按名字，且重复调用结果一致（否则每次打开排列都变，等于没有顺序）
    assert.deepEqual(choices.map(c => c.name), providerChoices(scopeReadiness(members, 'A')).map(c => c.name))
  })

  test('★ 脏读数被规整：不认识的状态当成"没有读数"，不猜成 ready', () => {
    const choices = providerChoices({ providers: {
      a: { state: 'READY' },        // 大小写不对
      b: { state: 'ok' },           // 自造状态
      c: {},                        // 没有 state
      d: { state: 'ready' },
    } })
    const by = Object.fromEntries(choices.map(c => [c.name, c]))
    assert.equal(by.a.state, null); assert.equal(by.a.ready, false)
    assert.equal(by.b.state, null); assert.equal(by.b.ready, false)
    assert.equal(by.c.state, null); assert.equal(by.c.ready, false)
    assert.equal(by.d.state, 'ready'); assert.equal(by.d.ready, true)
  })

  test('★ 读数只用来说、不用来否决：不 ready 也**允许发布**，但给出提示', () => {
    const choices = providerChoices(scopeReadiness(members, 'A'))
    const v = providerChoiceValidation('codex', choices)
    assert.equal(v.ok, true, '读数不 ready 不该拦发布 —— 自检有 10 分钟 TTL，用户可能刚装好')
    assert.match(v.message, /missing_cli/, '但必须提示当前状态')
    assert.match(v.message, /PATH 上找不到 codex/, '提示里要带上修法（reason）')
  })

  test('空名字才拦发布，且提示里给出"不知道填什么就填什么"', () => {
    const v = providerChoiceValidation('   ', providerChoices(null))
    assert.equal(v.ok, false)
    assert.match(v.message, new RegExp(DEFAULT_NATIVE_PROVIDER), '必须点名默认值')
    // 认得的、就绪的、读不到的，都不提示
    assert.equal(providerChoiceValidation(DEFAULT_NATIVE_PROVIDER, providerChoices(null)).message, null)
    assert.equal(providerChoiceValidation('自由输入的名字', providerChoices(null)).message, null,
      '斜杠自造的名字也允许（datalist 不是 select），不提示')
  })

  test('摘要把"几个就绪"说清楚；没有读数时如实说没有', () => {
    assert.match(readinessSummary(scopeReadiness(members, 'A')), /worker@A/)
    assert.match(readinessSummary(scopeReadiness(members, 'A')), /1 个就绪/)
    assert.match(readinessSummary(null), /还没有上报/)
  })
})
