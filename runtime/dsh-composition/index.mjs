// runtime/dsh-composition/index.mjs
// ============================================================================
// Legion DSH 组合补丁层唯一出口（PRT-212 ~ PRT-215）。
//
// 下游（Runtime Manager、Launcher、DshRuntimeAdapter）一律从这里取符号，
// 不直接深入子模块 —— 与 `runtime/contracts/index.mjs` 同一约定。
//
// 目录职责：
//   patch-layer.mjs  声明「这一层由哪些行组成、判据是什么」（PRT-214）
//   enforcement.mjs  三个强制点原语 + canonical operation 哈希（PRT-212）
//   selfcheck.mjs    沙箱实际管制探测 + 启动自检（PRT-213 / PRT-215）
//   bootstrap.mjs    **装配入口**：自检 + 注册宿主端口（PRT-215 落地 / PRT-257）
//
// ## 本目录**刻意**不含「把补丁层写进 profile」的代码
//
// DSH 的用户 profile 层是 `patchReload: 'live'` 的——**组合改动热生效，不需要重启**。
// 也就是说，往运行中的 profile 写入这一层会**立刻改变正在跑的 harness 的强制面**，
// 包括本会话自己。把它做成一个随手可调的函数，等于给一次误调用准备了
// 「把当前进程的沙箱降级」的能力。
//
// 因此本批次交付的是**声明 + 原语 + 自检**这三件可独立审阅的东西，
// 落盘与应用留给一个需要显式决策的独立步骤（见 docs/PRT-212-evidence/）。
// ============================================================================

export {
  DSH_COMPOSITION_PATCH_VERSION,
  DSH_DEFAULT_PRESETS,
  EMPLOYEE_PRESET_CONTRACT,
  LEGION_PERMISSION_PRESETS,
  LEGION_ROW_PREFIX,
  PATCH_LAYER_ROWS,
  reconcilePatchLayer,
} from './patch-layer.mjs'

export {
  APPROVAL_OUTCOMES,
  CANONICAL_OP_DOMAIN,
  CANONICAL_OP_KEYS,
  CANONICAL_OP_SCHEMA_VERSION,
  DEFAULT_HARD_FLOOR,
  ENFORCEMENT_SOURCES,
  PRE_DECISIONS,
  canonicalJson,
  canonicalOperationHash,
  canonicalScalar,
  canonicalizePath,
  createAllowOnceStore,
  createApprovalAnswerer,
  createHardFloorGuard,
  createPreExecutePolicy,
  nfc,
} from './enforcement.mjs'

export { PROBE_ARGV, SELFCHECK_STATES, probeSandbox, startupSelfCheck } from './selfcheck.mjs'

// 装配入口（PRT-215 落地 / PRT-257）。
//
// 在这一批之前，`startupSelfCheck` / `probeSandbox` / `bindDshRuntime`
// 三件东西**都只在自己的模块里存在，没有任何调用者**，于是
// 「强制面未生效时禁止自动执行」这条保证**从未被行使过**。
//
//   > 一个宣言从没被行使过，与这个宣言不存在，在行为上完全一样。
//
// 需要说明的是：**本出口被调用，仍然不等于它在真实部署里被调用了。**
// 真正的调用点在「往运行中的 profile 写入这一层」那个
// 需要显式决策的独立步骤里（见上面那段说明），而那个步骤是 PRT-257
// 「一键启动」的一部分，**本批没有交付**。
// 本批交付的是：那个步骤一旦发生，它**有东西可调**，且调用的后果被用例钉住了。
export {
  BOOTSTRAP_CODES,
  REPAIR_ACTIONS,
  bootstrapDshRuntime,
  repairPlanFor,
} from './bootstrap.mjs'

// 修复入口的**执行**一半（PRT-257）。
//
// `repairPlanFor()` 给出计划，本出口让计划真的被行使。在它之前，那份计划的
// 全部消费者是"打印给人看"——而**一个只有计划没有执行的修复入口，
// 与一句"请重装产品"没有区别**：用户拿到的是同一件事。
//
// 两条纪律写在 `repair.mjs` 里：
//   · `reapply-composition-patch` 明明能自动做，却**必须**显式批准——
//     因为 DSH 的用户 profile 是 `patchReload: 'live'`，往运行中的 profile
//     写入这一层会立刻改掉**正在跑的 harness 的强制面，包括发起修复的进程自己**
//     （所以本模块**不含**任何写 profile 的代码，applier 一律注入）；
//   · 判决来自**重新自检**，applier 的返回值只进 `applierSaid`。
//     修复是唯一一种"做错了反而更糟"的操作：一个静默地什么都没修的修复入口，
//     比没有修复入口坏得多。
export {
  REPAIR_CODES,
  REPAIR_MODES,
  REPAIR_VERDICTS,
  approvableActions,
  repairActionsOf,
  repairRuntime,
} from './repair.mjs'

export { PATCH_YAML_PATH, renderPatchYaml } from './render.mjs'

// PRT-607：审批策略与无人值守判定。
//
// 补上一次遗漏：本文件自称"下游一律从这里取符号，不直接深入子模块"，
// 而 PRT-607 交付时没有把它加进来——于是"唯一的出口"少了一个模块，
// 下游要么绕过去直接 import，要么以为它不存在。
//
//   > 一个「声称是唯一出口、但少了一个模块」的出口，
//   > 与一条写着"请勿直接 import 子模块"的注释，是同一个东西——
//   > 只不过后者看起来像一条已经生效的约定。
export {
  APPROVAL_DECISIONS,
  APPROVAL_POLICIES,
  APPROVAL_POLICY_CHECKED,
  APPROVAL_POLICY_VERSION,
  HUMAN_REQUIREMENTS,
  POLICY_CODES,
  SANDBOX_MODES,
  applyApprovalOutcome,
  approvalOutcomeSet,
  assertKnobsFrozenDuringRun,
  assertKnobsUnchanged,
  assertLegionPresetsDoNotDowngradeSandbox,
  assertNeverNeverAllows,
  assertOnlyAllowedOnceGrants,
  assertOutcomeCannotOverrideADenial,
  assertPolicy,
  assertPreset,
  assertUnattendedHoldsRatherThanDenies,
  assertUnknownInputsFailClosed,
  decideApproval,
} from './approval-policy.mjs'

// PRT-612：Legion 权限语义 → DSH 强制面的**固定映射**（spec §6.6 line 445–454）。
//
// 与 `enforcement.mjs` 的分工：那边是**原语**（guard / pre-execute / answerer 各自怎么判），
// 这边是**这张表**（五种模式分别落到哪几个点、由谁定案）。
//
// 它同时是 PRT-607 那个判定函数唯一的**生产调用方**：`mapPermissionMode` 把
// "ask / allow-once 的结局"整体委托给 `decideApproval`，不自己再判一遍——
//
//   > 一个「在映射层自己再写一遍'无人值守怎么办'」的实现，
//   > 与一个「两处对无人值守的判断迟早不一样」的实现，是同一个东西。
//
// 落点函数返回的 `answererInvoked` 是 spec line 452 那个"在 waterfall **前**拒绝"
// 的落地：只有判定结果是 `ask` 时才把请求送进 answerer。
export {
  DSH_ENFORCEMENT_POINTS,
  ENFORCEMENT_MAPPING,
  ENFORCEMENT_MAPPING_CHECKED,
  ENFORCEMENT_MAPPING_VERSION,
  LEGION_MODES,
  LEGION_NON_MODE_SEMANTICS,
  MAPPING_CODES,
  MODE_ROUTING,
  assertMappingConsistent,
  authorizationKeys,
  configPoints,
  decisionPoints,
  enforcementPathOf,
  mapPermissionMode,
  presetBinding,
  routeForMode,
} from './enforcement-mapping.mjs'
