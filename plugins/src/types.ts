// plugins/src/types.ts
// ============================================================================
// PRT-315（第 1 个切片）：**跨模块共享的领域类型**
//
// ## 这个文件为什么先于切片出现
//
// 要按「交接边界」把 `index.ts` 里的合入调解拆出去，那个模块就必须知道
// `Task` 与 `StageDef` 长什么样——而它们此前是 `index.ts` 的**私有** interface。
//
// 有三条路，只有一条不是错的：
//
//   ① 让 `mediation.ts` 从 `index.ts` 里 `import type` —— 于是两个模块有了
//      一条**互相**依赖的边。`import type` 会被抹掉、运行时确实不成环，
//      但"谁依赖谁"这件事从此说不清：下一个人再看依赖图，会以为
//      `index.ts` 与 `mediation.ts` 是一体的。
//   ② 在 `mediation.ts` 里再抄一份结构相同的 interface —— 抄的那一份
//      会在 `Task` 加字段的那天开始漂移，而漂移的表现是
//      "调解员看不到某个新字段"，不报错。
//   ③ 把这两个类型放到它们自己的模块里，两边都从那里拿。
//
//   > 一个"两边各自声明一份、今天恰好一致"的类型，
//   > 与一个"两边真的共用同一个类型"，在类型检查器那里是同一个东西——
//   > 只不过前者会在某次加字段之后，让其中一边悄悄看不见它。
//
// ## 为什么只搬这两个，不搬 `GoalCtx` / `PipelineDef` / `Config`
//
// 「每次只迁移一个切片」（spec §阶段 3 PRT-315）。这一批的切片是**合入调解**，
// 它需要的最小类型集合恰好是 `Task` + `StageDef`。多搬的每一个类型都会
// 扩大这次改动的面积，而**这次改动的全部意义是"行为零变化"**——
// 面积越大，能证明的越少。其余 interface 留给它们自己的切片。
// ============================================================================

/** 任务记录（taskctl 输出的字段子集，按需扩展）。 */
export interface Task {
  id: string
  title: string
  description: string
  acceptance: string[]
  /** 边界（做什么/不做什么，team-hub 生成任务时自动注入；file 模式可能缺失）。 */
  boundary?: { do: string[]; dont: string[] }
  priority: string
  status: string
  version: number
  soldier: string | null
  claimedAt: string | null
  parent: string | null
  role: string | null
  scope?: string
  /** 将军逐任务拦截（hold=true 时本守护不得自动认领/执行）。 */
  hold?: boolean
  blockedBy: string[]
  comments: Array<{ by: string; at: string; text: string }>
  /** 证据登记（与 comments 同构，separate 字段；hub 任务表 evidence JSON 列）。 */
  evidence?: Array<{ by: string; at: string; text: string }> | null
  /** 产物登记（html/file/url；契约文档自动登记 = kind=file + 仓库相对路径 + digest）。 */
  artifacts?: Array<{ by: string; at: string; kind: string; path: string; title?: string; digest?: string }>
  /** 切片流水线归属键（v3 slice 模式）：coder/tester = `${tdId}:S${n}`；devops 尾 = tdId。 */
  slice?: string | null
  /** 切片序号（1 基）。 */
  sliceIdx?: number | null
  /** 修复任务的回炉源：指向失败的那个 tester 任务 id（语义见 ORCHESTRATION-V3 §3.2 修订）。 */
  fixOf?: string | null
  /** tester 的已回炉轮数（服务端记录；守护用「同 fixOf 非取消 fix 任务数」推导）。 */
  fixCount?: number
  /** tester 结构化报告（D7' 机器闸门输入）：{passed, failures[], summary, at, by}。 */
  testReport?: { passed: boolean; failures?: Array<{ name: string; log: string; repro: string }>; summary?: string; at?: string; by?: string } | null
  /** 所属目标（多目标并发归属）：chain/slice 链任务与 fix 回炉/守护补建任务都挂（goal 表 id，如 G-xxx）。 */
  goalId?: string | null
  /** 切片文件域声明（JSON 数组，相对仓库根的路径/目录前缀）：merge/promote 前越域机器校验用；无声明 = 不限制。 */
  fileDomain?: string[] | null
  /** 文档同步标记（R-4/F1）：用户可见行为变更（feature/docSync）任务为 true；纯重构/测试不设。守护据其在契约路径追加 docs/FEATURES.md + README.md 并注入同步提示词（D2/D3）。 */
  docSync?: boolean | null
}

/** 多角色流水线中的一个阶段（角色）。 */
export interface StageDef {
  role: string
  label: string
  prompt: string
  next: string | null
  /** 人工闸门：完成并合入后停在 in_review，等将军验收 done 才流转下一角色（如方案搜索）。 */
  gate?: boolean
  /** 该阶段要求交付到 worktree 的产物文档（相对仓库根），闸门验收前必须存在。 */
  artifact?: string
  /** 岗位文档契约（R-1，S1）：该阶段产出文档的相对路径模板数组，支持 {taskId} 占位（reviewer 等按任务动态命名）；
   *  缺省回退 artifact 单值语义。守护在 done 结算时按此逐条自动登记到任务 artifacts，详情视图据此直达预览。 */
  docs?: string[]
}

/** 需求讨论配置：哪些角色参与群聊 + 最多讨论几轮。
 *  ★ PRT-1007 片 1 搬来这里（原 `index.ts:182` 的私有 interface）：`docContract.ts` 的
 *  `resolveDiscussion` 要按它定签名，而"从 index.ts `import type`"会让两个模块多一条
 *  **互相**依赖的边 —— 理由与 `types.ts:10-23` 里那三条路是同一套。 */
export interface DiscussionDef {
  maxRounds: number
  roles: string[]
}
