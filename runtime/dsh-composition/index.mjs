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

export { PATCH_YAML_PATH, renderPatchYaml } from './render.mjs'
