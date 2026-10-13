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
