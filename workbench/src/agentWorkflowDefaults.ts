// workbench/src/agentWorkflowDefaults.ts
// ============================================================================
// 「Agent 工作流」面板的**默认值**与**提示门槛** —— 纯函数，可单测。
//
// ## 为什么要把它们抽出来（而不是留在组件里）
//
// 这个面板原来有三个硬编码默认值，它们共同造成了一次真实的"看不懂"：
//
//     const [tools, setTools] = useState({ designRole: 'claude-code',
//                                          implementationRole: 'dsh-native',
//                                          reviewRole: 'codex' })
//     const [dshProvider, setDshProvider] = useState('')   // 且发布时必填
//
// 实测这台环境（2026-10-13）：**0 个工作流定义 / 0 个工具配置 / 0 个执行节点**，
// `pipeline.workflow` 为 null，8 个流水线阶段的 `agentToolConfig` 全为空。
// 于是用户一点开这个面板，看到的是：
//
//   · 已经替你选好了 Claude Code 与 Codex（两个**根本没装**的外部产品）；
//   · 两条黄色告警说这两个 provider 没有就绪心跳；
//   · 一条 `dsh plugin --profile <profile> add @deepseek-ai/dsh-subagent-codex …` 命令；
//   · 一个"填写 ctx.subagents 中的 provider 名称"的**空必填项**（发布时抛错）。
//
// 用户的原话是**「相当茫然，完全不知道怎么配置」**。
//
//   > 一组"看起来已经替你配好了"的默认值，与一组"配好了、但按下去必然失败"的默认值，
//   > 在**还没按下去**的时候长得一模一样 ——
//   > 区别只在用户照做之后，而他照做的第一件事是去查那两个他从没听说过的产品。
//
// 所以默认值的判据不是"它看上去完整"，而是：
//
//   ① **默认状态必须是可发布的**（不能一打开就缺必填项）；
//   ② **默认值不得预设用户没装的东西**（外部 provider 只能由用户显式选择）；
//   ③ 只有用户**真的选了**外部工具，才提示外部依赖缺失。
//
// 抽成纯函数的理由与仓里 `deliveryBadge.ts` / `reworkPlan.ts` / `agentWorkflowView.ts`
// 一致：这类"默认值对不对"的判断必须能被判据钉住，而组件里的 `useState` 钉不住。
// ============================================================================

/** 工作流阶段的 Agent 工具。`dsh-native` = 本地执行服务（随 Legion 一起跑的那个）。 */
export type ToolChoice = 'claude-code' | 'dsh-native' | 'codex'

/** 闭环三阶段在界面上的角色键。 */
export type WorkflowRoleKey = 'designRole' | 'implementationRole' | 'reviewRole'

/**
 * DSH 上注册的**默认**子 Agent provider 名。
 *
 * 取值来自 `plugins/src/index.ts` 的配置 schema：`provider: z.string().default('spawn')`
 * ——也就是本仓守护在不额外配置时使用的那个 provider。把它写在这里而不是留空，
 * 是因为"留空 + 发布时必填"= 用户必须先去读 DSH 源码才能发布。
 *
 * ⚠ 若 DSH 改了那个默认值，这里要跟着改；判据 `agent-workflow-defaults.test.mjs`
 *   钉住"默认 provider 不得为空"，并把这句出处写进断言消息。
 */
export const DEFAULT_NATIVE_PROVIDER = 'spawn'

/**
 * 三个阶段的**出厂默认工具**：全部走本地执行服务。
 *
 * 为什么不学原来的 `claude-code / dsh-native / codex`：那三个名字代表"一台机器上
 * 同时装了三个外部产品"的一种**特定**部署形态，而它既不是默认、也不是多数。
 * 把它当默认的代价是每个新用户都要先排除一次"我是不是该去装那两个东西"。
 */
export const NATIVE_TOOL_DEFAULTS: Readonly<Record<WorkflowRoleKey, ToolChoice>> = Object.freeze({
  designRole: 'dsh-native',
  implementationRole: 'dsh-native',
  reviewRole: 'dsh-native',
})

/** 内置岗位 → 该岗位更适合哪一类阶段（用于从空间流水线猜默认岗位）。 */
export const PREFERRED_ROLES: Readonly<Record<WorkflowRoleKey, readonly string[]>> = Object.freeze({
  designRole: ['designer', 'researcher', 'requirement'],
  implementationRole: ['coder', 'implementer', 'developer'],
  reviewRole: ['reviewer', 'review'],
})

/**
 * 用户（或环境）**是否真的选了外部工具**。
 *
 * 这是外部依赖告警的**唯一**门槛：默认全是 `dsh-native` ⇒ 刚打开时一条告警都不该有。
 * 原来那个判据写在 JSX 里（`Object.values(tools).some(t => t !== 'dsh-native')`），
 * 配合硬编码的外部默认值，导致**首次打开就满屏告警** —— 而用户什么都还没选。
 */
export function externalToolsChosen(choices: Iterable<ToolChoice | string>): boolean {
  for (const choice of choices) if (choice !== 'dsh-native') return true
  return false
}

/** 节点心跳里一个 provider 的最小形状。 */
export interface ProviderObservation {
  readonly observedProviders?: readonly string[]
  /** 有些节点把它放在 `providerNames`。 */
  readonly providerNames?: readonly string[]
}

/**
 * 「本地执行服务 注册名」的候选值：**已知默认值** + **节点心跳实际上报的 provider**。
 *
 * 这个字段原本是一个纯文本输入框，提示语是"填写 ctx.subagents 中的 provider 名称" ——
 * 要求用户知道 DSH 的内部服务名，而界面上**没有任何地方能查到它**。
 * 改成下拉候选（仍保留自由输入）之后，"不知道填什么"这个问题从"去读源码"变成"选一个"。
 *
 * 过滤掉 `codex` / `claude-code`：它们是**外部** adapter，不该出现在本地 provider 的候选里
 * ——让它们出现会重新制造"本地还是外部"的混淆。
 */
export function nativeProviderCandidates(nodes: readonly ProviderObservation[] | null | undefined): string[] {
  const out = new Set<string>([DEFAULT_NATIVE_PROVIDER])
  for (const node of nodes ?? []) {
    for (const name of [...(node?.observedProviders ?? []), ...(node?.providerNames ?? [])]) {
      if (typeof name !== 'string' || name === '') continue
      if (name === 'codex' || name === 'claude-code') continue
      out.add(name)
    }
  }
  return [...out].sort()
}

/**
 * 从空间流水线的已启用阶段里挑一个合适的岗位；挑不到就给第一个已启用阶段。
 * （原实现内联在组件里，逻辑不变，只是搬出来好测。）
 */
export function defaultRoleFor(
  stages: ReadonlyArray<{ role: string; enabled?: boolean }> | null | undefined,
  key: WorkflowRoleKey,
): string {
  const list = stages ?? []
  const preferred = PREFERRED_ROLES[key]
  const hit = list.find(stage => preferred.includes(stage.role))
  if (hit) return hit.role
  return list.find(stage => stage.enabled)?.role ?? ''
}
