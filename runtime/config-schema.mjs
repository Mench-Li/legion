// runtime/config-schema.mjs
// ============================================================================
// runtime（Runtime 执行引擎 / DSH 组合层）的配置面声明（PRT-254 起）
//
// ## 这个文件补的是哪一截
//
// `runtime/` 是 `product/process-manifest.mjs` 的 `PROCESS_SPECS` **已经声明**的进程
//（清单里 orchestrator 的 `dependsOn: [team-hub, runtime]` 指的就是它），却一直不在
// `scripts/config/scan.mjs` 的 `PROCESSES` 里——也就是说，这份门禁对 `runtime/`
// **从来没有读过一行**：74 个源文件、285 个疑似字面量，全部落在所有 schema 之外。
//
//   > 一个"被声明为进程、却没有任何配置面门禁"的目录，
//   > 与一个"没有配置面"的目录，在门禁的输出里是同一个读数。
//
// 登记分两半：扫描范围在 `scan.mjs` 的 `PROCESSES`，权威声明在本文件
//（进程 → schema 的映射只有一份，见 `scripts/config/check.mjs` 的 `SCHEMA_FILES`）。
//
// ## 为什么用 `defineSchema`，不手写对象
//
// `scan.mjs` 调的是 `SCHEMA.envNames()`。手写对象漏了它时，门禁要到 CI 才报
// `envNames is not a function`，而这件事本该在**导入时**就失败——与
// `orchestrator/config-schema.mjs` 同一条理由。
//
// ## ★ ENV_NAMES 为什么**不**是空的（与第一次估算相反）
//
// 第一次估算说"runtime 的真实 env 读取点是 0"。那个数字只数了**直接**读法
//（`process.env.X` / 解构 / 别名 `env.X`）——而 runtime 的读取面恰好全在
// **下标读取**上，扫描器的字面量规则一条都看不见：
//
//   · `runtime/dsh-composition/plugins/root-row.mjs` 的 `env[k]`
//     （`apply` 期读 `process.env`，k 取自同文件的 `DECIDE_ENV_KEYS`）
//     → LEGION_APPROVAL_POLICY / LEGION_ATTENDED / LEGION_PERMISSION_PRESET；
//   · `runtime/dsh-composition/root.mjs` 的 `readString(source, keys)`
//     （source 由调用方注入；生产接线注入的就是 `process.env`）
//     → TEAM_HUB_URL / TEAM_HUB_TOKEN / LEGION_ACTOR / LEGION_SCOPE /
//       LEGION_ENFORCEMENT_ACTION / LEGION_CWD / LEGION_TASK_ID。
//
// 十个键逐条登记在下面 `fields` 里，两处下标读取登记进 `dynamicEnvReads`。
// 把它们的字面量塞进 `nonEnvLiterals` 会让门禁变绿——而且**绿得像个正确答案**：
// 那十个键明明是环境变量，把它们登记成"不是环境变量"就是让这份声明开始说谎。
//
// ## nonEnvLiterals 是怎么来的
//
// 剩下 250 条是错误码 / 契约字符串 / 动作名 / Node 系统错误码，**逐条由脚本用
// `scan.mjs` 自己的 `extractEnvReads` 从源码重新推出**（不手抄、不写第二份实现），
// 每条后面挂着它来自哪个文件。`config.test.mjs` 断言它与 `scanProcess('runtime')`
// 的 suspicious 集合逐条对得上（不多一条、不少一条）。
// ⚠️ 不要手写这份名单：源码改动后重跑生成脚本，并按 diff 复核。
// ============================================================================
import { defineSchema } from '../packages/shared/src/config.mjs'

/** 本进程从进程环境读取的键（**读取声明**）。
 *  ⚠️ 门禁读的不是这一份：`scan.mjs` 走 `SCHEMA.envNames()`，而那是从 `fields` 推出来的。
 *  两份都要登记（与 orchestrator 的 ENV_NAMES 同一条纪律）。 */
export const ENV_NAMES = Object.freeze([
  'LEGION_APPROVAL_POLICY',
  'LEGION_ATTENDED',
  'LEGION_PERMISSION_PRESET',
  'TEAM_HUB_URL',
  'TEAM_HUB_TOKEN',
  'LEGION_ACTOR',
  'LEGION_SCOPE',
  'LEGION_ENFORCEMENT_ACTION',
  'LEGION_CWD',
  'LEGION_TASK_ID',
])

/** 不是本进程读取的环境变量、但写法上形如 env 键的字面量（错误码 / 契约字符串 / 动作名）。 */
export const NON_ENV_LITERALS = Object.freeze([
  // ── runtime/adapters/dsh/errors.mjs（14 条）
  'AUTH_FAILED', // runtime/adapters/dsh/errors.mjs 等 5 个文件
  'BUDGET_EXCEEDED', // runtime/adapters/dsh/errors.mjs 等 4 个文件
  'CANCELLED', // runtime/adapters/dsh/errors.mjs 等 5 个文件
  'CONTEXT_TOO_LARGE', // runtime/adapters/dsh/errors.mjs 等 5 个文件
  'INVALID_RESULT', // runtime/adapters/dsh/errors.mjs 等 5 个文件
  'MODEL_UNAVAILABLE', // runtime/adapters/dsh/errors.mjs 等 4 个文件
  'RATE_LIMITED', // runtime/adapters/dsh/errors.mjs 等 5 个文件
  'RUNTIME_CRASHED', // runtime/adapters/dsh/errors.mjs 等 4 个文件
  'RUNTIME_UNAVAILABLE', // runtime/adapters/dsh/errors.mjs 等 3 个文件
  'SCHEMA_MIGRATION_FAILED', // runtime/adapters/dsh/errors.mjs、runtime/contracts/index.d.mts
  'SECRET_UNAVAILABLE', // runtime/adapters/dsh/errors.mjs 等 6 个文件
  'TIMEOUT', // runtime/adapters/dsh/errors.mjs 等 6 个文件
  'TOOL_DENIED', // runtime/adapters/dsh/errors.mjs、runtime/contracts/index.d.mts
  'UNSUPPORTED_CAPABILITY', // runtime/adapters/dsh/errors.mjs 等 6 个文件
  // ── runtime/adapters/dsh/events.mjs（1 条）
  'OUTCOME_UNKNOWN', // runtime/adapters/dsh/events.mjs 等 5 个文件
  // ── runtime/adapters/dsh/index.mjs（1 条）
  'RUNTIME_NOT_READY', // runtime/adapters/dsh/index.mjs、runtime/contracts/index.d.mts
  // ── runtime/adapters/dsh/session-boundary.mjs（10 条）
  'CHILD_POLICY_NOT_INHERITED', // runtime/adapters/dsh/session-boundary.mjs
  'LIVE_REGISTRY_ONLY', // runtime/adapters/dsh/session-boundary.mjs
  'NOT_LIVE_SO_UNANSWERABLE', // runtime/adapters/dsh/session-boundary.mjs
  'ORCHESTRATOR_DUTY_IN_ADAPTER', // runtime/adapters/dsh/session-boundary.mjs
  'OWNERSHIP_BY_REFERENCE_NOT_BY_ID', // runtime/adapters/dsh/session-boundary.mjs
  'OWNERSHIP_IS_LIVE_ONLY', // runtime/adapters/dsh/session-boundary.mjs
  'POLICY_CHANGE_ALWAYS_SAYS_USER', // runtime/adapters/dsh/session-boundary.mjs
  'SENDER_MUST_BE_LIVE_TARGET_NEED_NOT_BE', // runtime/adapters/dsh/session-boundary.mjs
  'SET_POLICY_MAY_WRITE_NOTHING', // runtime/adapters/dsh/session-boundary.mjs
  'UNHONORED_SESSION_RESUME', // runtime/adapters/dsh/session-boundary.mjs
  // ── runtime/context/assembler.mjs（3 条）
  'BAD_BUDGET', // runtime/context/assembler.mjs
  'BAD_CANDIDATE', // runtime/context/assembler.mjs
  'TOKENIZER_REQUIRED', // runtime/context/assembler.mjs
  // ── runtime/context/sources.mjs（2 条）
  'SOURCE_BAD_INPUT', // runtime/context/sources.mjs
  'SOURCE_BAD_KEY_ORDER', // runtime/context/sources.mjs
  // ── runtime/context/tokenizer-registry.mjs（3 条）
  'TOKENIZER_BAD_ARTIFACT', // runtime/context/tokenizer-registry.mjs
  'TOKENIZER_BAD_JSON', // runtime/context/tokenizer-registry.mjs
  'TOKENIZER_DUPLICATE_MODEL', // runtime/context/tokenizer-registry.mjs
  // ── runtime/contracts/config-bundle.mjs（15 条）
  'ACTOR_REQUIRED', // runtime/contracts/config-bundle.mjs
  'BUNDLE_BINDING_INVALID', // runtime/contracts/config-bundle.mjs
  'BUNDLE_BINDINGS_NOT_ARRAY', // runtime/contracts/config-bundle.mjs
  'BUNDLE_CONTAINS_SECRET', // runtime/contracts/config-bundle.mjs
  'BUNDLE_KIND_INVALID', // runtime/contracts/config-bundle.mjs
  'BUNDLE_NOT_OBJECT', // runtime/contracts/config-bundle.mjs
  'BUNDLE_PROFILE_INVALID', // runtime/contracts/config-bundle.mjs
  'BUNDLE_PROFILES_NOT_ARRAY', // runtime/contracts/config-bundle.mjs
  'BUNDLE_SECRET_REF_PRESENT', // runtime/contracts/config-bundle.mjs
  'BUNDLE_UNKNOWN_FIELD', // runtime/contracts/config-bundle.mjs
  'BUNDLE_VERSION_UNSUPPORTED', // runtime/contracts/config-bundle.mjs
  'CONFLICT_POLICY_INVALID', // runtime/contracts/config-bundle.mjs
  'IMPORT_DANGLING_PROFILE_REF', // runtime/contracts/config-bundle.mjs
  'IMPORT_HAS_CONFLICTS', // runtime/contracts/config-bundle.mjs
  'PLAN_INVALID', // runtime/contracts/config-bundle.mjs
  // ── runtime/contracts/index.d.mts（11 条）
  'BAD_RESPONSE', // runtime/contracts/index.d.mts、runtime/contracts/model-probe.mjs
  'CAPABILITY_MISSING', // runtime/contracts/index.d.mts、runtime/contracts/model-probe.mjs
  'CONDITIONAL', // runtime/contracts/index.d.mts
  'ENDPOINT_UNREACHABLE', // runtime/contracts/index.d.mts、runtime/contracts/model-probe.mjs
  'MANUAL', // runtime/contracts/index.d.mts
  'MODEL_NOT_FOUND', // runtime/contracts/index.d.mts、runtime/contracts/model-probe.mjs
  'NOTICE', // runtime/contracts/index.d.mts
  'PROVIDER_ERROR', // runtime/contracts/index.d.mts、runtime/contracts/model-probe.mjs
  'SECRET_REF_MISSING', // runtime/contracts/index.d.mts、runtime/contracts/model-probe.mjs
  'TLS_FAILED', // runtime/contracts/index.d.mts、runtime/contracts/model-probe.mjs
  'UNCLASSIFIED', // runtime/contracts/index.d.mts 等 3 个文件
  // ── runtime/contracts/model-config.mjs（8 条）
  'MODEL_CONFIG_CANNOT_VALIDATE', // runtime/contracts/model-config.mjs
  'MODEL_CONFIG_EMPTY_SELECTION', // runtime/contracts/model-config.mjs
  'MODEL_CONFIG_NO_CREDENTIAL', // runtime/contracts/model-config.mjs
  'MODEL_CONFIG_NO_PROFILES', // runtime/contracts/model-config.mjs
  'MODEL_CONFIG_OK', // runtime/contracts/model-config.mjs
  'MODEL_CONFIG_PROFILE_DISABLED', // runtime/contracts/model-config.mjs
  'MODEL_CONFIG_UNKNOWN_MODEL', // runtime/contracts/model-config.mjs
  'MODEL_CONFIG_UNKNOWN_PROVIDER', // runtime/contracts/model-config.mjs
  // ── runtime/contracts/price-table.mjs（14 条）
  'APPROVED', // runtime/contracts/price-table.mjs
  'BILLING_UNIT_REQUIRED', // runtime/contracts/price-table.mjs
  'CURRENCY_MISMATCH', // runtime/contracts/price-table.mjs
  'CURRENCY_REQUIRED', // runtime/contracts/price-table.mjs
  'EFFECTIVE_AT_REQUIRED', // runtime/contracts/price-table.mjs
  'MODEL_ENTRY_INVALID', // runtime/contracts/price-table.mjs
  'MODEL_NOT_PRICED', // runtime/contracts/price-table.mjs
  'MODELS_NOT_OBJECT', // runtime/contracts/price-table.mjs
  'MORE_EXPENSIVE_NEEDS_APPROVAL', // runtime/contracts/price-table.mjs
  'NOT_MORE_EXPENSIVE', // runtime/contracts/price-table.mjs
  'PRICE_UNKNOWN', // runtime/contracts/price-table.mjs
  'TABLE_INVALID', // runtime/contracts/price-table.mjs
  'TOKENS_UNKNOWN', // runtime/contracts/price-table.mjs
  'VERSION_REQUIRED', // runtime/contracts/price-table.mjs
  // ── runtime/contracts/wire.mjs（16 条）
  'RUNTIME_CONTRACT_ADAPTER_SHAPE_INVALID', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_ADAPTER_THREW', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_BAD_REQUEST', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_BAD_RESPONSE', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_BAD_WIRING', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_BODY_TOO_LARGE', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_ENFORCEMENT_UNAVAILABLE', // runtime/contracts/wire.mjs、runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  'RUNTIME_CONTRACT_METHOD_NOT_ALLOWED', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_NO_TOKEN', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_STREAM_AFTER_TERMINAL', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_STREAM_BROKEN', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_STREAM_MALFORMED', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_STREAM_NO_TERMINAL', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_UNAUTHORIZED', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_UNKNOWN_ROUTE', // runtime/contracts/wire.mjs
  'RUNTIME_CONTRACT_UNREACHABLE', // runtime/contracts/wire.mjs
  // ── runtime/dsh-composition/assemble.mjs（3 条）
  'ASSEMBLE_NO_APPROVAL_PORT', // runtime/dsh-composition/assemble.mjs
  'ASSEMBLE_NO_CONTEXT', // runtime/dsh-composition/assemble.mjs
  'ASSEMBLE_NO_DECIDE', // runtime/dsh-composition/assemble.mjs
  // ── runtime/dsh-composition/bootstrap.mjs（6 条）
  'BOOTSTRAP_ALREADY_BOUND', // runtime/dsh-composition/bootstrap.mjs
  'BOOTSTRAP_BAD_WIRING', // runtime/dsh-composition/bootstrap.mjs
  'BOOTSTRAP_COMPOSITION_UNOBSERVED', // runtime/dsh-composition/bootstrap.mjs
  'BOOTSTRAP_PORT_INCOMPLETE', // runtime/dsh-composition/bootstrap.mjs
  'BOOTSTRAP_RUNTIME_PROBE_FAILED', // runtime/dsh-composition/bootstrap.mjs
  'BOOTSTRAP_SELF_CHECK_INCOMPATIBLE', // runtime/dsh-composition/bootstrap.mjs
  // ── runtime/dsh-composition/employee-preset.mjs（7 条）
  'EMPLOYEE_PRESET_BAD_ID', // runtime/dsh-composition/employee-preset.mjs
  'EMPLOYEE_PRESET_ENFORCEMENT_ON_AGENT_PLANE', // runtime/dsh-composition/employee-preset.mjs
  'EMPLOYEE_PRESET_NO_MANIFEST', // runtime/dsh-composition/employee-preset.mjs
  'EMPLOYEE_PRESET_NO_ROOT', // runtime/dsh-composition/employee-preset.mjs
  'EMPLOYEE_PRESET_SERVICE_WITHOUT_REALM', // runtime/dsh-composition/employee-preset.mjs
  'EMPLOYEE_PRESET_SHIPPED_ID_COLLISION', // runtime/dsh-composition/employee-preset.mjs
  'EMPLOYEE_PRESET_TOOL_UNCOVERED', // runtime/dsh-composition/employee-preset.mjs
  // ── runtime/dsh-composition/enforcement.mjs（1 条）
  'ECONNREFUSED', // runtime/dsh-composition/enforcement.mjs、runtime/probe/index.mjs
  // ── runtime/dsh-composition/external-api-scope.mjs（4 条）
  'DELETE', // runtime/dsh-composition/external-api-scope.mjs
  'FROBNICATE', // runtime/dsh-composition/external-api-scope.mjs
  'REPORT', // runtime/dsh-composition/external-api-scope.mjs
  'UPLOAD', // runtime/dsh-composition/external-api-scope.mjs
  // ── runtime/dsh-composition/patch-format.mjs（10 条）
  'PATCH_DOCUMENT_CONFIG_NOT_OBJECT', // runtime/dsh-composition/patch-format.mjs
  'PATCH_DOCUMENT_ENTRY_NOT_OBJECT', // runtime/dsh-composition/patch-format.mjs
  'PATCH_DOCUMENT_INSERT_ENTRY_NO_NAME', // runtime/dsh-composition/patch-format.mjs
  'PATCH_DOCUMENT_INSERT_ENTRY_NOT_OBJECT', // runtime/dsh-composition/patch-format.mjs
  'PATCH_DOCUMENT_INSERT_NOT_ARRAY', // runtime/dsh-composition/patch-format.mjs
  'PATCH_DOCUMENT_INSERT_WITH_TARGET_ID', // runtime/dsh-composition/patch-format.mjs
  'PATCH_DOCUMENT_NOT_AN_ARRAY', // runtime/dsh-composition/patch-format.mjs
  'PATCH_DOCUMENT_PATCH_OVER_WITH_MODULE', // runtime/dsh-composition/patch-format.mjs
  'PATCH_DOCUMENT_ROW_MODULE_MISSING', // runtime/dsh-composition/patch-format.mjs
  'PATCH_DOCUMENT_UNKNOWN_KEY', // runtime/dsh-composition/patch-format.mjs
  // ── runtime/dsh-composition/patch-layer.mjs（4 条）
  'PRESETS_NOT_OVERRIDDEN', // runtime/dsh-composition/patch-layer.mjs
  'PRESETS_UNOBSERVED', // runtime/dsh-composition/patch-layer.mjs
  'ROW_MISSING', // runtime/dsh-composition/patch-layer.mjs
  'ROW_NOT_ACTIVATED', // runtime/dsh-composition/patch-layer.mjs
  // ── runtime/dsh-composition/plugins/approval-answerer-row.mjs（4 条）
  'APPROVAL_ANSWERER_ROW_COMPOSITION_ROOT_REFUSED', // runtime/dsh-composition/plugins/approval-answerer-row.mjs
  'APPROVAL_ANSWERER_ROW_NO_ASSEMBLED_ROW', // runtime/dsh-composition/plugins/approval-answerer-row.mjs
  'APPROVAL_ANSWERER_ROW_NO_COMPOSITION_ROOT', // runtime/dsh-composition/plugins/approval-answerer-row.mjs
  'APPROVAL_ANSWERER_ROW_NO_CONTEXT', // runtime/dsh-composition/plugins/approval-answerer-row.mjs
  // ── runtime/dsh-composition/plugins/approval-answerer.mjs（3 条）
  'APPROVAL_ANSWERER_NEEDS_RUNTIME_CONFIG', // runtime/dsh-composition/plugins/approval-answerer.mjs
  'APPROVAL_ANSWERER_NO_EVENT_SEAM', // runtime/dsh-composition/plugins/approval-answerer.mjs
  'APPROVAL_ANSWERER_NO_PORT', // runtime/dsh-composition/plugins/approval-answerer.mjs
  // ── runtime/dsh-composition/plugins/hard-floor.mjs（2 条）
  'HARD_FLOOR_BAD_FLOOR', // runtime/dsh-composition/plugins/hard-floor.mjs
  'HARD_FLOOR_NO_GUARD_SEAM', // runtime/dsh-composition/plugins/hard-floor.mjs
  // ── runtime/dsh-composition/plugins/pre-execute-row.mjs（4 条）
  'PRE_EXECUTE_ROW_COMPOSITION_ROOT_REFUSED', // runtime/dsh-composition/plugins/pre-execute-row.mjs
  'PRE_EXECUTE_ROW_NO_ASSEMBLED_ROW', // runtime/dsh-composition/plugins/pre-execute-row.mjs
  'PRE_EXECUTE_ROW_NO_COMPOSITION_ROOT', // runtime/dsh-composition/plugins/pre-execute-row.mjs
  'PRE_EXECUTE_ROW_NO_CONTEXT', // runtime/dsh-composition/plugins/pre-execute-row.mjs
  // ── runtime/dsh-composition/plugins/pre-execute.mjs（3 条）
  'PRE_EXECUTE_NEEDS_RUNTIME_CONFIG', // runtime/dsh-composition/plugins/pre-execute.mjs
  'PRE_EXECUTE_NO_BRIDGE', // runtime/dsh-composition/plugins/pre-execute.mjs
  'PRE_EXECUTE_NO_EVENT_SEAM', // runtime/dsh-composition/plugins/pre-execute.mjs
  // ── runtime/dsh-composition/plugins/root-row.mjs（8 条）
  'ENFORCEMENT_ROOT_ROW_APPROVAL_PORT_UNUSABLE', // runtime/dsh-composition/plugins/root-row.mjs
  'ENFORCEMENT_ROOT_ROW_CONFIG_UNRESOLVED', // runtime/dsh-composition/plugins/root-row.mjs
  'ENFORCEMENT_ROOT_ROW_DECIDE_INPUT_MISSING', // runtime/dsh-composition/plugins/root-row.mjs
  'ENFORCEMENT_ROOT_ROW_IS_A_COMPOSITION_ROW', // runtime/dsh-composition/plugins/root-row.mjs
  'ENFORCEMENT_ROOT_ROW_NO_APPROVAL_PORT_FACTORY', // runtime/dsh-composition/plugins/root-row.mjs
  'ENFORCEMENT_ROOT_ROW_NO_CONTEXT', // runtime/dsh-composition/plugins/root-row.mjs
  'ENFORCEMENT_ROOT_ROW_NO_ENV', // runtime/dsh-composition/plugins/root-row.mjs
  'ENFORCEMENT_ROOT_ROW_NONE_SHORTCUT_DRIFTED', // runtime/dsh-composition/plugins/root-row.mjs
  // ── runtime/dsh-composition/plugins/runtime-contract-server-row.mjs（11 条）
  'RUNTIME_CONTRACT_ROW_ADAPTER_CREATE_FAILED', // runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  'RUNTIME_CONTRACT_ROW_ADAPTER_SHAPE_INVALID', // runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  'RUNTIME_CONTRACT_ROW_INPUTS_FACTORY_THREW', // runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  'RUNTIME_CONTRACT_ROW_LISTEN_FAILED', // runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  'RUNTIME_CONTRACT_ROW_NO_BIND_PORT', // runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  'RUNTIME_CONTRACT_ROW_NO_CONTEXT', // runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  'RUNTIME_CONTRACT_ROW_NO_HOST_PORT', // runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  'RUNTIME_CONTRACT_ROW_NO_INPUTS_FACTORY', // runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  'RUNTIME_CONTRACT_ROW_NO_PUBLICATION_DIR', // runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  'RUNTIME_CONTRACT_ROW_NO_TOKEN', // runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  'RUNTIME_CONTRACT_ROW_PUBLICATION_FAILED', // runtime/dsh-composition/plugins/runtime-contract-server-row.mjs
  // ── runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs（18 条）
  'RUNTIME_HOST_REGISTRAR_CAPABILITY_CANCEL_NOT_GUARANTEED_BY_ENGINE', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_CAPABILITY_ENFORCEMENT_PLANE_MEASURED_ELSEWHERE', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_LACKS_OUTPUT_SCHEMA', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_REGISTRY_ABSENT', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_REGISTRY_AMBIGUOUS', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_REGISTRY_CONFIRMS', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_CAPABILITY_RESULT_CONTRACT_HAS_NO_USAGE', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_CAPABILITY_TABLE_MISMATCH', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_DSH_VERSION_MALFORMED', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_DSH_VERSION_NOT_FOUND', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_DSH_VERSION_READ', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_READ', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_RESULT_MALFORMED', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_SERVICE_ABSENT', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_MODEL_SELECTION_SERVICE_MALFORMED', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_NO_CONTEXT', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  'RUNTIME_HOST_REGISTRAR_NO_SUBAGENTS_PORT', // runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
  // ── runtime/dsh-composition/plugins/runtime-host-row.mjs（12 条）
  // `SELF_CHECK_INCOMPATIBLE`：spec `line 854` 要的「按 `incompatible` 处理并禁止自动执行」。
  // 与 `BIND_REFUSED` 分开：那一条是"我们自己的接线错了"（当场响），
  // 这一条是"强制面没生效"（进程活着、端口不注册、状态是 incompatible）。
  'RUNTIME_HOST_ROW_SELF_CHECK_INCOMPATIBLE', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  'RUNTIME_HOST_ROW_BIND_REFUSED', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  'RUNTIME_HOST_ROW_ENFORCEMENT_ROOT_REFUSED', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  'RUNTIME_HOST_ROW_INPUTS_FACTORY_THREW', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  'RUNTIME_HOST_ROW_NO_CAN_READ', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  'RUNTIME_HOST_ROW_NO_COMPOSITION', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  'RUNTIME_HOST_ROW_NO_CONTEXT', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  'RUNTIME_HOST_ROW_NO_ENFORCEMENT_ROOT', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  'RUNTIME_HOST_ROW_NO_HOST_PORT', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  'RUNTIME_HOST_ROW_NO_INPUTS_FACTORY', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  'RUNTIME_HOST_ROW_NO_SANDBOX_PORT', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  'RUNTIME_HOST_ROW_ROOT_SHAPE_INVALID', // runtime/dsh-composition/plugins/runtime-host-row.mjs
  // ── runtime/dsh-composition/repair.mjs（5 条）
  'REPAIR_BAD_PLAN', // runtime/dsh-composition/repair.mjs
  'REPAIR_BAD_RECHECK', // runtime/dsh-composition/repair.mjs
  'REPAIR_NO_APPLIER', // runtime/dsh-composition/repair.mjs
  'REPAIR_RECHECK_FAILED', // runtime/dsh-composition/repair.mjs
  'REPAIR_STILL_OUTSTANDING', // runtime/dsh-composition/repair.mjs
  // ── runtime/dsh-composition/root.mjs（13 条）
  'ENFORCEMENT_ROOT_ALREADY_INSTALLED', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_ASSEMBLY_FAILED', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_BAD_WIRING', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_CONFIG_EMPTY', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_CONFIG_MISSING', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_CONFIG_UNREADABLE', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_NO_ACTION', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_NO_ACTOR', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_NO_APPROVAL_PORT', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_NO_CWD', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_NO_DECIDE_PORT', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_NO_HUB_URL', // runtime/dsh-composition/root.mjs
  'ENFORCEMENT_ROOT_NO_SCOPE', // runtime/dsh-composition/root.mjs
  // ── runtime/dsh-composition/runtime-contract-publication.mjs（5 条）
  'ENOENT', // runtime/dsh-composition/runtime-contract-publication.mjs
  'RUNTIME_CONTRACT_PUBLICATION_CLEAR_FAILED', // runtime/dsh-composition/runtime-contract-publication.mjs
  'RUNTIME_CONTRACT_PUBLICATION_INVALID_ADDRESS', // runtime/dsh-composition/runtime-contract-publication.mjs
  'RUNTIME_CONTRACT_PUBLICATION_NO_DATA_DIR', // runtime/dsh-composition/runtime-contract-publication.mjs
  'RUNTIME_CONTRACT_PUBLICATION_WRITE_FAILED', // runtime/dsh-composition/runtime-contract-publication.mjs
  // ── runtime/dsh-composition/runtime-contract-server.mjs（4 条）
  'RUNTIME_CONTRACT_SERVER_BAD_ADAPTER', // runtime/dsh-composition/runtime-contract-server.mjs
  'RUNTIME_CONTRACT_SERVER_LISTEN_FAILED', // runtime/dsh-composition/runtime-contract-server.mjs
  'RUNTIME_CONTRACT_SERVER_NO_ADAPTER', // runtime/dsh-composition/runtime-contract-server.mjs
  'RUNTIME_CONTRACT_SERVER_NO_BIND_PORT', // runtime/dsh-composition/runtime-contract-server.mjs
  // ── runtime/dsh-composition/tool-capability.mjs（5 条）
  'CAPABILITY_BAD_DECLARED_RISK', // runtime/dsh-composition/tool-capability.mjs
  'CAPABILITY_BAD_NAME', // runtime/dsh-composition/tool-capability.mjs
  'CAPABILITY_NONE_DECLARED', // runtime/dsh-composition/tool-capability.mjs
  'CAPABILITY_UNKNOWN_KIND', // runtime/dsh-composition/tool-capability.mjs
  'CAPABILITY_UNKNOWN_RISK', // runtime/dsh-composition/tool-capability.mjs
  // ── runtime/probe/index.mjs（16 条）
  'CERT_HAS_EXPIRED', // runtime/probe/index.mjs
  'DEPTH_ZERO_SELF_SIGNED_CERT', // runtime/probe/index.mjs
  'EAI_AGAIN', // runtime/probe/index.mjs
  'ECONNRESET', // runtime/probe/index.mjs
  'EHOSTUNREACH', // runtime/probe/index.mjs
  'ENETUNREACH', // runtime/probe/index.mjs
  'ENOTFOUND', // runtime/probe/index.mjs
  'ERR_TLS_CERT_ALTNAME_INVALID', // runtime/probe/index.mjs
  'ETIMEDOUT', // runtime/probe/index.mjs
  'RESOLVER_INVALID', // runtime/probe/index.mjs
  'SELF_SIGNED_CERT_IN_CHAIN', // runtime/probe/index.mjs
  'TRANSPORT_INVALID', // runtime/probe/index.mjs
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', // runtime/probe/index.mjs
  'UND_ERR_BODY_TIMEOUT', // runtime/probe/index.mjs
  'UND_ERR_CONNECT_TIMEOUT', // runtime/probe/index.mjs
  'UND_ERR_HEADERS_TIMEOUT', // runtime/probe/index.mjs
  // ── runtime/probe/secret-resolver.mjs（5 条）
  'SECRET_FALLBACK_INVALID', // runtime/probe/secret-resolver.mjs
  'SECRET_NOT_FOUND', // runtime/probe/secret-resolver.mjs
  'SECRET_STORE_MISSING', // runtime/probe/secret-resolver.mjs
  'SECRET_STORE_UNPROTECTED', // runtime/probe/secret-resolver.mjs
  'SECRET_STORE_UNREADABLE', // runtime/probe/secret-resolver.mjs
])

/**
 * `runtime/dsh-composition/execution-scope.mjs` 的 `DANGEROUS_ENV_KEYS`：
 * **别的程序**的环境变量名。
 *
 * 本进程从不读取它们的值——它只用这份名单做**名字比对**：授权里给了这些变量，
 * 就等于给了绕过沙箱的通道（`LD_PRELOAD` / `NODE_OPTIONS` / `GIT_SSH_COMMAND`…）。
 *
 *   > 一个"能设 `LD_PRELOAD`"的权限，
 *   > 与一个"可以执行任意代码"的权限，是同一个东西——只不过前者看起来像配置。
 *
 * 登记在 `foreignEnv` 而不是 `fields`：它们不是本进程的配置面；
 * 登记在 `nonEnvLiterals` 也不对：它们**真的是**环境变量名，只是不属于本进程。
 */
export const FOREIGN_ENV_NAMES = Object.freeze([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'PERL5LIB',
  'PERL5OPT',
  'RUBYOPT',
  'RUBYLIB',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'IFS',
  'PROMPT_COMMAND',
])

const FOREIGN_ENV_OWNER = '子进程 / 操作系统（不属于本进程的配置面）'
const FOREIGN_ENV_REASON = 'DANGEROUS_ENV_KEYS：只用于按名字比对，拒绝把会改变后续程序行为的变量交给子进程；本进程不读取它的值'

export const SCHEMA = defineSchema({
  process: 'runtime',
  title: 'Runtime 执行引擎/DSH 组合层（`runtime/`；清单第 3 个进程，PRT-254 起纳入扫描）',
  // 不声明 `prefixes: ['LEGION_']`：LEGION_* 是**共享命名空间**（orchestrator 也住在这里）。
  // 前缀机制的前提是"该前缀下的变量都属于我"；只拥有其中十个成员时这个前提不成立——
  // 声明它只会对别人的变量产出假告警，而假告警会让人习惯性忽略 warnings。
  // 理由与 orchestrator 不声明 TEAM_HUB_ 前缀完全相同。
  fields: [
    {
      key: 'hubUrl', env: 'TEAM_HUB_URL', type: 'string', default: '',
      doc: '强制面要打交道的 hub 地址（`ENFORCEMENT_CONFIG_FIELDS.hubUrl`）。' +
        '**没有默认值**：取不到就是 null，本行以 `ENFORCEMENT_ROOT_NO_HUB_URL` 具名拒绝装配——' +
        '猜一个地址会让"没配"与"配在另一个 hub 上"读起来一样，而这两者的修法相反',
    },
    {
      // 与 team-hub / workbench / orchestrator 是**同一个环境变量**：一次配置、多处生效。
      // sensitive：凭证绝不进任何摘要或 --json 输出（引擎统一脱敏）。
      key: 'hubToken', env: 'TEAM_HUB_TOKEN', type: 'string', default: '', sensitive: true,
      doc: 'hub 凭证。与 team-hub / workbench / orchestrator 共用同一个 TEAM_HUB_TOKEN',
    },
    {
      key: 'actor', env: 'LEGION_ACTOR', type: 'string', default: '',
      doc: '授权主体（谁在做事）。**没有默认值**：凭空来的 actor 会让审计里的授权主体' +
        '变成一个谁也不是的名字——那与"没有审计"是同一件事，只是看起来有',
    },
    {
      key: 'scope', env: 'LEGION_SCOPE', type: 'string', default: '',
      doc: '本次强制的空间/范围。**没有默认值**：猜一个 scope 会把写入落到错的房间里',
    },
    {
      key: 'action', env: 'LEGION_ENFORCEMENT_ACTION', type: 'string', default: '',
      doc: '本次要执行的动作类别（写入面判定的输入）。**没有默认值**',
    },
    {
      key: 'cwd', env: 'LEGION_CWD', type: 'path', default: '',
      doc: '执行的工作目录（授权与审计都要记录"在哪里做的"）。**没有默认值**',
    },
    {
      key: 'taskId', env: 'LEGION_TASK_ID', type: 'string', default: '',
      doc: '当前任务标识（把这次执行挂回任务）。**没有默认值**',
    },
    {
      key: 'approvalPolicy', env: 'LEGION_APPROVAL_POLICY', type: 'string', default: '',
      doc: '需要人时的审批策略，只接受 `APPROVAL_POLICIES` 里的值。取不到就是 null → 具名拒绝。' +
        '**不猜**：默认 ask 会让无人值守的进程去问一个不在场的人，' +
        '默认 never 会把"没配"静默变成"一律拒绝"',
    },
    {
      // type 故意是 string 而不是 bool：代码只认字面 'true' / 'false'，
      // '1' / 'yes' / 'on' 一律当**没说清**（fail closed）。引擎的 bool 会把它们判成合法，
      // 于是 schema 比代码更宽松——让声明说谎。
      key: 'attended', env: 'LEGION_ATTENDED', type: 'string', default: '',
      doc: '现场有没有人（只认字面 `\'true\'` / `\'false\'`；其余一律当"没说清"）。**没有默认值**：' +
        '一个"默认现场有人"的输入，与一个"去问一个不在场的人"的实现，是同一个东西',
    },
    {
      key: 'permissionPreset', env: 'LEGION_PERMISSION_PRESET', type: 'string', default: '',
      doc: '权限预设（`decide` 的第三个输入）。**没有默认值**',
    },
  ],
  foreignEnv: FOREIGN_ENV_NAMES.map((name) => ({ name, owner: FOREIGN_ENV_OWNER, reason: FOREIGN_ENV_REASON })),
  dynamicEnvReads: [
    {
      file: 'runtime/dsh-composition/plugins/root-row.mjs',
      expr: 'env[k]',
      reason: 'decideInputsFromEnv(env) 按 k 下标读取，k 取自同文件的 DECIDE_ENV_KEYS' +
        '（LEGION_APPROVAL_POLICY / LEGION_ATTENDED / LEGION_PERMISSION_PRESET，三个都已在上面 fields 声明）。' +
        '生产接线里 env 就是 process.env（同文件的 processEnv()，只在 apply 期读）。' +
        '⚠️ 扫描器对同一行会报**两次** env[k]：' +
        '`typeof env?.[k] === \'string\' && env[k].trim() !== \'\' ? env[k].trim() : null` 里有两处下标，' +
        '是同一行、同一个读法，不是两处不同的动态访问。',
    },
    {
      file: 'runtime/dsh-composition/root.mjs',
      expr: 'source[key]',
      reason: 'readString(source, keys) 按 ENFORCEMENT_CONFIG_FIELDS[].envKeys 逐个下标读取' +
        '（七个键都已在上面 fields 声明）。' +
        '⚠️ 扫描器看不见这一处：参数名是 source 而不是 env，动态规则不匹配——' +
        '所以这条登记是它唯一的机器可读记录。',
    },
  ],
  nonEnvLiterals: NON_ENV_LITERALS,
  notes: [
    '本 schema 的十个 env 键**全部**是下标读取（env[k] / source[key]）：扫描器的规则①②按字面量匹配，' +
      '一条都读不到。因此 dynamicEnvReads 与 fields 必须成对维护——只加一张键名表而不加 fields 条目时，' +
      '门禁**仍然是绿的**（它根本看不见），而那正是这个缺口当初的样子。' +
      'config.test.mjs 用 runtime 自己的两张键名表（DECIDE_ENV_KEYS / ENFORCEMENT_CONFIG_FIELDS）反查声明，两个方向都会红。',
    'TEAM_HUB_URL / TEAM_HUB_TOKEN 与 team-hub / workbench / orchestrator 是**同一个环境变量**：一次配置、多处生效。',
    '这十个键**都没有默认值**：取不到就是 null，调用方以具名码拒绝装配。schema 里的 `default: \'\'` ' +
      '只是"未设置"的表达，不是代码里的兜底值。',
    'foreignEnv 是 execution-scope.mjs 的 DANGEROUS_ENV_KEYS（30 个名字）：别的程序的环境变量，' +
      '本进程只按名字比对、不读值。',
  ],
})

export default SCHEMA
