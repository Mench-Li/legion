// runtime/packs/authority.mjs
// ============================================================================
// PRT-1005：验证能力包**不能携带密钥、不能扩大权限、不能绕过 DSH 强制面**。
//
// spec §6.13 line 570：
//   「能力包不得携带密钥，不得绕过 ToolGuard、权限预设和审批，
//     也不得把 Git 文件变成运行状态事实源。」
// spec 阶段 10 完成标准 line 1006：
//   「不兼容、缺依赖、哈希错误或**越权**包在**创建目标前**失败。」
//
// 这是阶段 10 的安全核心，所以下面每一条判据都要回答同一个问题：
// **它拦住的到底是什么，以及一个"看起来实现了"的写法会怎样让它失效。**
//
// ---------------------------------------------------------------------------
// ① 权限必须对着**宿主的强制面**查，不能对着包自己的声明查
//
// 最自然的写法是：包声明 `requestedPermissions`，然后检查"这些权限彼此不矛盾"
// （比如能力与工具对得上、风险等级与能力相符）。它全部通过，而且**全是自说自话**：
//
//   > 一个「拿包声明的权限去和包声明的另一部分比」的越权检查，
//   > 与一个「让包自己说'我没有越权'」的越权检查，是同一个东西——
//   > 只不过前者有一个看起来像校验的循环。
//
// 所以基线必须是**注入的**：`hostEnforcementSurface()` 从 `LEGION_PERMISSION_PRESETS`
// （host 组合里真正生效的那张表）读出沙箱与审批档，从宿主给的 `grant` 读出这个包
// 至多能拿到什么。判定方向是固定的：**包 ⊆ 宿主**。
//
// 装载自检把这两种基线**并排算一次**并留下两个读数
// （`samples.naiveBaseline`），因为"方向"这件事只有并排摆出来才是可见的。
//
// ---------------------------------------------------------------------------
// ② 「不能携带密钥」查的是**内容**，不是 manifest 里的一个字段
//
// manifest 里有 `containsSecrets`。一个只读它的实现，在这件事上恒真：
//
//   > 一个「信 `containsSecrets: false`」的密钥检查，
//   > 与一个「包里真的躺着一个 `sk-...` 而检查通过了」的密钥检查，是同一个东西——
//   > 只不过前者在安装报表上写着一句"已声明不含密钥"。
//
// 所以真正的判据是**扫描载荷**（`scanForSecrets`），而 `containsSecrets` 只被用来
// 要求作者**必须声明**：没写这个字段 = 拒绝（"没声明"不是"没有"）；
// 写 `true` = 也拒绝（一个承认自己带密钥的包）。
//
// 扫两件事，缺一不可：
//   · 值的形态（`SECRET_VALUE_PATTERNS`：供应商前缀、Bearer、私钥块、URL 内嵌凭证）；
//   · **敏感键名下的字面量值**（`apiKey: "hunter2"` 不匹配任何一种供应商前缀）。
//
// 第二件是必需的：
//   > 一个「只认供应商前缀」的密钥扫描，
//   > 与一个「`apiKey: "hunter2"` 照样通过」的密钥扫描，是同一个东西。
//
// 而"引用"是允许的（spec §7 有 `secret_refs` 表，存引用不存密文）：
// `env:OPENAI_API_KEY` 是引用，它必须在包里，否则没人知道该去哪个环境变量取。
//
// ---------------------------------------------------------------------------
// ③ 包里的**员工清单**也要查，而且查的是"员工 ≤ 包"这个方向
//
// 只查 manifest 里那一份 `requestedPermissions` 是不够的：包内容里有员工清单，
// 而员工清单**自己**申请工具与能力。
//
//   > 一个「只检查包清单里那份权限声明」的预检，
//   > 与一个「包里某个员工申请得比包声明得多、而没人发现」的预检，是同一个东西。
//
// 所以每个员工过两道：先过 PRT-603 的 `narrowToGrant`（⊆ 宿主授予），
// 再过一次"⊆ 包声明"。第二道是本模块自己的方向，不能委托出去。
//
// ---------------------------------------------------------------------------
// ④ "在创建目标前失败"断言的是**顺序**，不是判决
//
// 一个返回 `{ok: false}` 的预检，如果调用方先建目标再看判决，那条完成标准就没成立。
// 所以这里提供唯一一个把两者串起来的地方：`runPreflightThenCreateTarget`。
// 它返回 `sequence`，而用例**另外**用一个计数器钉住 `createTarget` 被调了几次——
// 因为 `sequence` 是这个函数自己报的，一个"报着 preflight、其实已经建了目标"的
// 实现必须能被抓住。
//
// ---------------------------------------------------------------------------
// ⑤ 未知与缺字段一律 fail closed，而且要说清是往哪一边倒
//
// 缺 `requestedPermissions` 时，两种读法都"不报错"：读成"什么也不要"，
// 于是它通过；读成"没被限制"，于是它什么都能做。同一个字段在两处被读成
// 相反的意思，正是"缺字段"这类缺陷的形态。这里统一为**拒绝**：
//
//   > 一个「没声明权限就当成没申请权限」的预检，
//   > 与一个「没声明权限就当成没有限制」的预检，是同一个东西——
//   > 只不过前者在预检这一层通过、后者在派活那一层生效。
// ============================================================================

import { RISK_RANK } from '../dsh-composition/tool-capability.mjs'
import { CAPABILITY_IDS, KNOWN_TOOL_NAMES, resolveTool } from '../dsh-composition/tool-capability.mjs'
import { FORBIDDEN_MANIFEST_FIELDS, narrowToGrant, normalizeManifest } from '../dsh-composition/employee-manifest.mjs'
import { DSH_DEFAULT_PRESETS, LEGION_PERMISSION_PRESETS, PATCH_LAYER_ROWS } from '../dsh-composition/patch-layer.mjs'
import { ENFORCEMENT_PORT_MAP } from '../dsh-composition/tool-request.mjs'
import { AUTHORITY_BEARING_KEYS, CONTEXT_SOURCE_TYPES } from '../contracts/context.mjs'
import { SENSITIVE_KEY_RE, SECRET_VALUE_PATTERNS } from '../contracts/redact-patterns.mjs'
import {
  MANIFEST_CODES,
  PACK_PROTOCOL_VERSION,
  contentHashOfEntries,
  normalizePackManifest,
  normalizePayload,
  preflightManifest,
  readPackTeam,
} from './manifest.mjs'
import { SAMPLE_TEAM, sampleTeamPack, sampleTeamPackWith } from './compiled-plan.mjs'

/**
 * 强制面基线的来源标记。
 *
 * 它参与 `assertHostSurfaceUsable` 的判据：**没有来源标记的基线不能用**。
 * 一个"查不到出处的权限上限"与"没有上限"在越权判定上是同一个东西——
 * 都拦不住任何包，而报表上都不知道该去找谁问。
 */
export const HOST_SURFACE_ORIGIN = 'legion/host-enforcement-surface'

export const PACK_AUTHORITY_CODES = Object.freeze({
  /** 调用方没给强制面基线。 */
  HOST_SURFACE_UNRESOLVED: 'pack-authority-host-surface-unresolved',
  /** 基线本身不成形状（缺字段、认不出的能力名、来源不明）。 */
  HOST_SURFACE_INCOMPLETE: 'pack-authority-host-surface-incomplete',
  /** 基线声称的沙箱/审批档正是 DSH 默认表里那一对（含 `danger-full-access`）。 */
  HOST_SURFACE_DANGER: 'pack-authority-host-surface-danger-mode',
  /** 包没有声明权限。 */
  PERMISSION_UNDECLARED: 'pack-authority-permission-undeclared',
  /** 权限声明不成形状。 */
  PERMISSION_MALFORMED: 'pack-authority-permission-malformed',
  /** 声明了不存在的能力名。 */
  CAPABILITY_UNKNOWN: 'pack-authority-capability-unknown',
  /** 能力超出宿主强制面。 */
  CAPABILITY_WIDENS_HOST: 'pack-authority-capability-widens-host',
  /** 声明了不在登记表里的工具。 */
  TOOL_UNKNOWN: 'pack-authority-tool-unknown',
  /** 工具名里带通配符。 */
  TOOL_WILDCARD: 'pack-authority-tool-wildcard',
  /** 工具超出宿主强制面。 */
  TOOL_WIDENS_HOST: 'pack-authority-tool-widens-host',
  /** 风险上限高于宿主强制面的上限。 */
  RISK_ABOVE_HOST_CEILING: 'pack-authority-risk-above-host-ceiling',
  /** 工作目录不在宿主强制面的工作目录之内。 */
  OUT_OF_WORKSPACE: 'pack-authority-out-of-workspace',
  /** 团队包但拿不到员工清单——查不了就不算过。 */
  EMPLOYEES_UNDECLARED: 'pack-authority-employees-undeclared',
  /** 员工清单本身不合法。 */
  EMPLOYEE_MALFORMED: 'pack-authority-employee-malformed',
  /** 员工超出宿主授予（PRT-603 的 `narrowToGrant` 拒绝）。 */
  EMPLOYEE_WIDENS_HOST: 'pack-authority-employee-widens-host',
  /** 员工超出**包自己声明**的权限。 */
  EMPLOYEE_WIDENS_PACK: 'pack-authority-employee-widens-pack',
  /** 载荷里扫到了密钥。 */
  SECRET_IN_CONTENT: 'pack-authority-secret-in-content',
  /** 包声明自己携带密钥。 */
  SECRET_DECLARED: 'pack-authority-secret-declared',
  /** 包没有声明 `containsSecrets`。 */
  SECRET_DECLARATION_MISSING: 'pack-authority-secret-declaration-missing',
  /** 数据依赖要的是密钥。 */
  SECRET_DEPENDENCY: 'pack-authority-secret-dependency',
  /** 没有声明数据依赖。 */
  DATA_DEPENDENCY_UNDECLARED: 'pack-authority-data-dependency-undeclared',
  /** 数据依赖条目不成形状。 */
  DATA_DEPENDENCY_MALFORMED: 'pack-authority-data-dependency-malformed',
  /** 数据依赖的种类不认识。 */
  DATA_DEPENDENCY_UNKNOWN_KIND: 'pack-authority-data-dependency-unknown-kind',
  /** 权限声明里出现强制面字段。 */
  ENFORCEMENT_FIELD: 'pack-authority-enforcement-field',
  /** 载荷里出现强制面记号（端口 / 补丁行 / 危险沙箱档 / 策略字段）。 */
  ENFORCEMENT_BYPASS_IN_CONTENT: 'pack-authority-enforcement-bypass-in-content',
  /** 顺序闸门没有拿到建目标的回调。 */
  TARGET_CREATE_MISSING: 'pack-authority-target-create-missing',
})

/** `requestedPermissions` 允许出现的字段（闭合）。 */
export const PERMISSION_FIELDS = Object.freeze(['capabilities', 'tools', 'maxRisk', 'workspaceRoot'])

/** 数据依赖允许出现的字段。 */
export const DATA_DEPENDENCY_FIELDS = Object.freeze(['id', 'kind', 'scope'])

/** 数据依赖里那几种**明确指向密钥**的种类名。它们不在 `CONTEXT_SOURCE_TYPES` 里，这里点名是为了给出准确的拒绝理由。 */
export const SECRET_DEPENDENCY_KINDS = Object.freeze(['secret', 'credentials', 'credential', 'key', 'keys', 'token', 'tokens', 'password'])

/**
 * 包内容里**不允许**出现的键名。
 *
 * 这是 `FORBIDDEN_MANIFEST_FIELDS`（PRT-603 定下的强制面字段名单）与
 * `AUTHORITY_BEARING_KEYS`（PRT-404 定下的"能改变权限的字段名"）的并集。
 * 两块都是**复用**来的，不重抄：一份会漂移的名单等于没有名单。
 *
 * ⚠️ 唯一被排除的是 `allowedTools`。理由不是"它无害"，而是**员工清单本来就要写它**
 * （PRT-603 的字段就是这个名字）。把它算成越权记号，这条检查会在第一个真实包上
 * 就误报——而一条会误报的检查，最终的归宿是被整条关掉。
 * 它真正的风险由另一条**精确**的检查覆盖：员工申请的工具必须 ⊆ 包声明的工具
 * （`EMPLOYEE_WIDENS_PACK`）。用一条会误报的子串检查替代一条精确检查，
 * 是这里刻意避免的事。
 *
 * ⚠️ `Set` 去重不是洁癖：两张名单**有交集**（`approvalPolicy` / `sandbox` /
 * `permissionPreset` 同时在两边），不去重时同一个键会被扫出两条一模一样的命中。
 *
 *   > 一个「同一处越权报两条」的扫描，
 *   > 与一个「命中数这个数字没人能解释」的扫描，是同一个东西——
 *   > 只不过前者的报表看起来更"详细"。
 */
export const PACK_FORBIDDEN_CONTENT_KEYS = Object.freeze([...new Set([
  ...FORBIDDEN_MANIFEST_FIELDS,
  ...AUTHORITY_BEARING_KEYS.filter((k) => k !== 'allowedTools'),
])])

/**
 * 包内容里**不允许**出现的整串记号。
 *
 * 前缀是 PRT-602 的桥端口表（`ENFORCEMENT_PORT_MAP` 的键）、补丁层行 id
 * （`PATCH_LAYER_ROWS`）以及 DSH 默认行里的确切路径——
 * 一个包在内容里写着 `ctx.tools.guard`，就是它在试图自己挂一个强制点。
 *
 * 同样去重：`danger-full-access` 既在字面名单里、也是 DSH 默认表的键名之一。
 */
export const PACK_FORBIDDEN_CONTENT_TOKENS = Object.freeze([...new Set([
  ...Object.keys(ENFORCEMENT_PORT_MAP),
  ...PATCH_LAYER_ROWS.map((r) => r.id),
  // DSH 默认表里的危险沙箱档：`patch-layer.mjs` 的注释写明了 Legion **必须**覆盖它。
  // 包内容里出现它，意味着这个包在把沙箱往那一档降。
  // 另一个默认值 `workspace-write` 不进这张名单——那是 Legion 自己在用的档，
  // 文档里提到它（"在 workspace-write 下工作"）是正常表述，不是绕越。
  'danger-full-access',
  ...Object.keys(DSH_DEFAULT_PRESETS).filter((k) => k.includes('danger')),
])])

/** 允许被视为"引用而非密文"的值前缀（spec §7 的 `secret_refs` 存引用不存密文）。 */
export const SECRET_REFERENCE_PREFIXES = Object.freeze(['env:', 'secret:', 'vault:', 'ref:', 'secretref:', 'arn:', '${', '{{'])

/**
 * 明确不是密钥的占位值。
 *
 * 没有这张名单时，`{"token": "none"}` 会被判成"敏感键名 + 字面量值"。
 * 误报的代价在这条检查上特别高：一个真实包因为文档里写了 `token: "none"`
 * 而装不上，下一个人就会把整条检查关掉——那时真的密钥也跟着一起放过去了。
 */
export const SECRET_PLACEHOLDER_VALUES = Object.freeze([
  'none', 'null', 'nil', 'true', 'false', 'empty', 'unset', 'undefined',
  'n/a', 'na', 'change-me', 'changeme', 'placeholder', 'xxx', 'todo', 'redacted',
])

/** 键名里出现这些词即视为敏感（大小写与分隔符无关）。 */
export const SENSITIVE_KEY_WORDS = Object.freeze([
  'token', 'secret', 'password', 'passwd', 'pwd', 'apikey', 'authorization',
  'credential', 'cookie', 'privatekey', 'accesskey', 'clientsecret',
])

/**
 * 键值对扫描：`"apiKey": "..."` / `api_key: xxx` / `apiKey = xxx` 三种写法都认。
 *
 * 三支值：双引号内、单引号内、裸值。两支各有一个**最短长度**，
 * 而这是刻意的取舍：
 *
 *   · 裸值最短 8 —— 没有这条下限时，`"credential:read"` 这种**能力名**会被读成
 *     "键 `credential` 的值是 `read`"，于是每个声明了密钥类能力的包都被误报；
 *   · 引号内最短 6 —— 上面那种误读在引号内同样成立（`"credential:read"` 里
 *     `read` 后面就是闭引号）。
 *
 * 代价是**短的密钥会被漏掉**（`apiKey: "hunter2"`）。这个方向的选择与
 * `redaction.mjs` 一致但仍然要说清：这条检查的用途是"拦住夹带的凭据"，
 * 而误报的后果是"作者去改文档、或者把检查关掉"。真正的密钥几乎都是长的不透明串；
 * 短的、人写的值更可能是配置枚举。
 */
const KEYED_VALUE_RE = /(?:^|[\s{,;])["']?([A-Za-z0-9_.-]{2,64})["']?\s*[:=]\s*(?:"([^"\n]{6,})"|'([^'\n]{6,})'|([^\s,;}\]#"']{8,}))/

/** 裸值的下限（引号内的下限写在正则里）。 */
export const MIN_BARE_SECRET_LENGTH = 8

function authorityError(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

function rankOf(risk) {
  const r = RISK_RANK[risk]
  return typeof r === 'number' ? r : null
}

// ---------------------------------------------------------------------------
// 宿主强制面
// ---------------------------------------------------------------------------

/**
 * 构造宿主强制面基线。**它是被注入的，不能从包推导出来。**
 *
 * @param {object} p
 * @param {string} [p.preset] Legion 自有 preset 名（`LEGION_PERMISSION_PRESETS` 的键）
 * @param {object} p.grant    宿主**显式**授予这个包的上限
 * @param {string} [p.origin] 基线来源标记（写进审计，回答"这个上限是谁定的"）
 */
export function hostEnforcementSurface({
  preset = 'legion-attended',
  grant = null,
  origin = HOST_SURFACE_ORIGIN,
  patchVersion = null,
} = {}) {
  const p = LEGION_PERMISSION_PRESETS[preset]
  if (p === undefined) {
    throw authorityError(
      PACK_AUTHORITY_CODES.HOST_SURFACE_UNRESOLVED,
      `未声明的 permission preset ${JSON.stringify(preset)}（已知：${Object.keys(LEGION_PERMISSION_PRESETS).join(' / ')}）。` +
      '基线必须来自 host 组合真正生效的那张表',
    )
  }
  if (grant === null || typeof grant !== 'object' || Array.isArray(grant)) {
    throw authorityError(
      PACK_AUTHORITY_CODES.HOST_SURFACE_UNRESOLVED,
      '宿主必须**显式**给出授予（grant）。' +
      '一个"没给授予就算没有限制"的基线，与一个"任何包都不越权"的基线，是同一个东西',
    )
  }
  return Object.freeze({
    origin: String(origin ?? ''),
    preset,
    sandbox: p.sandbox,
    approval: p.approval,
    patchVersion,
    allowedCapabilities: Object.freeze([...(grant.allowedCapabilities ?? [])]),
    allowedTools: Object.freeze([...(grant.allowedTools ?? [])]),
    riskCeiling: grant.maxRisk ?? null,
    workspaceRoot: grant.workspaceRoot ?? null,
  })
}

/**
 * 基线本身能不能用。
 *
 * 这一层存在的理由：越权判定是"包 ⊆ 基线"，所以基线的任何缺陷都会**直接变成放过**。
 * 一个空的 `allowedCapabilities` 是安全的（什么都 ⊆ 空集），但一个**认不出名字**的
 * 能力表不是——它多半意味着授权表写的是另一套名字，于是"包 ⊆ 基线"变成
 * "包里的名字都不在基线里"……那倒是会拒绝，可那时拒绝的理由是错的。
 * 更坏的是 `riskCeiling` 缺失：`rankOf(undefined)` 是 `null`，而 `null` 的比较
 * 需要显式处理，一不小心就成了"没有上限"。
 */
export function assertHostSurfaceUsable(surface) {
  const problems = []
  const fail = (code, field, message) => problems.push(Object.freeze({ code, field, message }))

  if (surface === null || surface === undefined || typeof surface !== 'object' || Array.isArray(surface)) {
    fail(
      PACK_AUTHORITY_CODES.HOST_SURFACE_UNRESOLVED,
      'hostSurface',
      '没有强制面基线。越权判定的方向是"包 ⊆ 宿主"，所以缺了宿主这一侧，' +
      '任何包都"不越权"——那与不做检查是同一个东西',
    )
    return Object.freeze({ ok: false, problems: Object.freeze(problems) })
  }

  const origin = String(surface.origin ?? '').trim()
  if (origin === '') {
    fail(
      PACK_AUTHORITY_CODES.HOST_SURFACE_INCOMPLETE,
      'origin',
      '基线没有来源标记——一个查不到出处的权限上限，与一个没有上限在越权判定上无法区分',
    )
  }

  const preset = LEGION_PERMISSION_PRESETS[surface.preset]
  if (preset === undefined) {
    fail(
      PACK_AUTHORITY_CODES.HOST_SURFACE_INCOMPLETE,
      'preset',
      `基线声称的 preset ${JSON.stringify(surface.preset)} 不在 ${JSON.stringify(Object.keys(LEGION_PERMISSION_PRESETS))} 里`,
    )
  } else if (preset.sandbox !== surface.sandbox || preset.approval !== surface.approval) {
    // ★ 沙箱与审批必须与**真正生效的那张 preset 表**一致。
    //   允许调用方随便填一对，等于允许它把基线说成一个更严的档而实际不生效。
    fail(
      PACK_AUTHORITY_CODES.HOST_SURFACE_INCOMPLETE,
      'sandbox',
      `基线声称 ${surface.sandbox}/${surface.approval}，而 ${surface.preset} 在 host 组合里是 ${preset.sandbox}/${preset.approval}`,
    )
  }
  if (surface.sandbox === 'danger-full-access') {
    fail(
      PACK_AUTHORITY_CODES.HOST_SURFACE_DANGER,
      'sandbox',
      '基线的沙箱档是 DSH 默认表里的 `danger-full-access`——' +
      '`patch-layer.mjs` 的注释写明了 Legion 为什么必须把它替换掉：按默认表实现"无人值守 = never"会**同时**把沙箱降级',
    )
  }
  if (Array.isArray(surface.allowedCapabilities)) {
    const bad = surface.allowedCapabilities.filter((c) => !CAPABILITY_IDS.includes(c))
    if (bad.length > 0) {
      fail(
        PACK_AUTHORITY_CODES.HOST_SURFACE_INCOMPLETE,
        'allowedCapabilities',
        `基线里有不认识的能力名 ${JSON.stringify(bad)}——认不出名字的基线无法判定"包 ⊆ 宿主"`,
      )
    }
  } else {
    fail(PACK_AUTHORITY_CODES.HOST_SURFACE_INCOMPLETE, 'allowedCapabilities', '基线的 allowedCapabilities 必须是数组')
  }
  if (!Array.isArray(surface.allowedTools)) {
    fail(PACK_AUTHORITY_CODES.HOST_SURFACE_INCOMPLETE, 'allowedTools', '基线的 allowedTools 必须是数组')
  }
  if (rankOf(surface.riskCeiling) === null) {
    fail(
      PACK_AUTHORITY_CODES.HOST_SURFACE_INCOMPLETE,
      'riskCeiling',
      `基线的风险上限是 ${JSON.stringify(surface.riskCeiling)}，不在 ${JSON.stringify(Object.keys(RISK_RANK))} 里。` +
      '缺一个合法的上限时，"包不超过上限"这句话就没有可比的两边',
    )
  }
  if (surface.workspaceRoot !== null && typeof surface.workspaceRoot !== 'string') {
    fail(PACK_AUTHORITY_CODES.HOST_SURFACE_INCOMPLETE, 'workspaceRoot', '基线的工作目录必须是字符串或 null')
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}

// ---------------------------------------------------------------------------
// 密钥扫描（查**内容**）
// ---------------------------------------------------------------------------

function keyLooksSensitive(key) {
  if (SENSITIVE_KEY_RE.test(String(key))) return true
  // 共享模式认的是 `_` / `-` 分隔的键名（`api_key`、`access-key`），
  // 而 JSON 里更常见的驼峰 `openaiApiKey` 在它那里**不命中**：`api` 前面
  // 既不是串首也不是分隔符。少这一条就是"敏感键名扫描漏掉最常见的那种写法"。
  const flat = String(key).toLowerCase().replace(/[^a-z0-9]/g, '')
  return SENSITIVE_KEY_WORDS.some((w) => flat.includes(w))
}

/** 这个值看起来是一个**引用**（允许）还是一个密文（不允许）。 */
export function looksLikeSecretReference(value) {
  const v = String(value ?? '').trim()
  if (v === '') return true
  const lower = v.toLowerCase()
  if (SECRET_PLACEHOLDER_VALUES.includes(lower)) return true
  return SECRET_REFERENCE_PREFIXES.some((p) => lower.startsWith(p))
}

/**
 * 扫一份载荷里的密钥。**两条判据都要**：值的形态、敏感键名下的字面量值。
 *
 * @returns {Array<{path: string, kind: string, why: string}>} 命中说明里**不含原值**
 */
export function scanForSecrets({ files } = {}) {
  const entries = normalizePayload(files)
  const hits = []
  for (const e of entries) {
    for (const p of SECRET_VALUE_PATTERNS) {
      p.re.lastIndex = 0
      if (p.re.test(e.text)) {
        p.re.lastIndex = 0
        hits.push(Object.freeze({ path: e.path, kind: 'value-pattern', why: p.why }))
      }
    }
    const re = new RegExp(KEYED_VALUE_RE.source, 'gm')
    let m
    while ((m = re.exec(e.text)) !== null) {
      const key = m[1]
      const value = m[2] ?? m[3] ?? m[4] ?? ''
      if (!keyLooksSensitive(key)) continue
      if (looksLikeSecretReference(value)) continue
      hits.push(Object.freeze({
        path: e.path,
        kind: 'keyed-value',
        why: `敏感键名 ${key} 下是一个字面量值（不是 env:/secret: 这类引用，也不是占位值）`,
      }))
    }
  }
  return Object.freeze(hits)
}

// ---------------------------------------------------------------------------
// 强制面绕越扫描（查**内容**）
// ---------------------------------------------------------------------------

/**
 * 扫一份载荷里有没有强制面记号。
 *
 * 两个方向都扫：**键名**（`"approvalPolicy": "never"`）与**整串记号**
 * （`ctx.tools.guard`、`legion-enforcement-pre-execute`、`danger-full-access`）。
 * 只扫键名会漏掉"在脚本里调用强制点"，只扫记号会漏掉"写一份策略配置文件"。
 */
export function scanForEnforcementBypass({ files } = {}) {
  const entries = normalizePayload(files)
  const hits = []
  for (const e of entries) {
    for (const token of PACK_FORBIDDEN_CONTENT_TOKENS) {
      const idx = e.text.indexOf(token)
      if (idx >= 0) {
        const around = e.text.slice(Math.max(0, idx - 24), idx + token.length + 24).replace(/\s+/g, ' ')
        hits.push(Object.freeze({ path: e.path, kind: 'token', token, around }))
      }
    }
    for (const key of PACK_FORBIDDEN_CONTENT_KEYS) {
      // 只认"这个键名被当成键来用"的写法（后面跟 `:` 或 `=`），
      // 不认散文里提到这个词——否则一句"审批由 host 负责"就会让检查误报。
      const re = new RegExp(`(?:^|[\\s{,;"'])["']?${key}["']?\\s*[:=]`, 'm')
      if (re.test(e.text)) {
        hits.push(Object.freeze({ path: e.path, kind: 'key', token: key, around: key }))
      }
    }
  }
  return Object.freeze(hits)
}

// ---------------------------------------------------------------------------
// 权限（包 ⊆ 宿主）
// ---------------------------------------------------------------------------

function sameOrInside(child, parent) {
  if (child === null || child === undefined) return true
  if (parent === null || parent === undefined) return false
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const root = norm(parent)
  const mine = norm(child)
  return mine === root || mine.startsWith(`${root}/`)
}

function checkPermissions({ manifest, hostSurface }) {
  const problems = []
  const fail = (code, field, message) => problems.push(Object.freeze({ code, field, message }))
  const raw = manifest.requestedPermissions

  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(
      PACK_AUTHORITY_CODES.PERMISSION_UNDECLARED,
      'requestedPermissions',
      '能力包没有声明请求的权限。**缺字段不是"不申请权限"**：' +
      '同一个"没写"在这道预检里会被读成"什么也不要"（于是通过），在派活那一层会被读成' +
      '"没有被限制"（于是什么都能做）。所以这里直接拒绝——没有权限就写空数组与 null',
    )
    return Object.freeze({ problems: Object.freeze(problems), declared: null })
  }

  const keys = Object.keys(raw)
  const forbidden = keys.filter((k) => FORBIDDEN_MANIFEST_FIELDS.includes(k))
  if (forbidden.length > 0) {
    fail(
      PACK_AUTHORITY_CODES.ENFORCEMENT_FIELD,
      'requestedPermissions',
      `权限声明里出现了强制面字段 ${JSON.stringify(forbidden)}。` +
      '强制面属于 host 组合（spec §6.9 line 488），一个能写这些字段的包就是一个能改审批策略、能给自己发权限的包',
    )
  }
  const unknown = keys.filter((k) => !PERMISSION_FIELDS.includes(k) && !forbidden.includes(k))
  if (unknown.length > 0) {
    fail(
      PACK_AUTHORITY_CODES.PERMISSION_MALFORMED,
      'requestedPermissions',
      `权限声明里出现了不认识的字段 ${JSON.stringify(unknown)}（合法字段：${PERMISSION_FIELDS.join(' / ')}）。不忽略`,
    )
  }
  const missing = PERMISSION_FIELDS.filter((k) => !Object.prototype.hasOwnProperty.call(raw, k))
  if (missing.length > 0) {
    fail(
      PACK_AUTHORITY_CODES.PERMISSION_MALFORMED,
      'requestedPermissions',
      `权限声明缺少字段 ${JSON.stringify(missing)}。` +
      '缺 `maxRisk` 尤其危险——"没有上限"与"上限写错了就用最宽松的"在判定上是同一个东西',
    )
    return Object.freeze({ problems: Object.freeze(problems), declared: null })
  }

  if (!Array.isArray(raw.capabilities) || raw.capabilities.some((c) => typeof c !== 'string')) {
    fail(PACK_AUTHORITY_CODES.PERMISSION_MALFORMED, 'requestedPermissions.capabilities', 'capabilities 必须是字符串数组')
    return Object.freeze({ problems: Object.freeze(problems), declared: null })
  }
  if (!Array.isArray(raw.tools) || raw.tools.some((t) => typeof t !== 'string')) {
    fail(PACK_AUTHORITY_CODES.PERMISSION_MALFORMED, 'requestedPermissions.tools', 'tools 必须是字符串数组')
    return Object.freeze({ problems: Object.freeze(problems), declared: null })
  }

  const unknownCaps = raw.capabilities.filter((c) => !CAPABILITY_IDS.includes(c))
  if (unknownCaps.length > 0) {
    fail(
      PACK_AUTHORITY_CODES.CAPABILITY_UNKNOWN,
      'requestedPermissions.capabilities',
      `声明了不存在的能力名 ${JSON.stringify(unknownCaps)}（合法值：${CAPABILITY_IDS.join(' / ')}）。` +
      '不把它当成"没有这个能力"——一个拼错的能力名会让这条限制**静默失效**',
    )
  }
  const hostCaps = new Set(hostSurface.allowedCapabilities)
  const wideCaps = raw.capabilities.filter((c) => CAPABILITY_IDS.includes(c) && !hostCaps.has(c))
  if (wideCaps.length > 0) {
    fail(
      PACK_AUTHORITY_CODES.CAPABILITY_WIDENS_HOST,
      'requestedPermissions.capabilities',
      `能力 ${JSON.stringify(wideCaps)} 不在宿主强制面之内（宿主有 ${JSON.stringify([...hostCaps])}）。` +
      '能力包只能**收窄**宿主已经授予的东西',
    )
  }

  const wildTools = raw.tools.filter((t) => t.includes('*') || t.includes('?') || t.trim() === '')
  if (wildTools.length > 0) {
    fail(
      PACK_AUTHORITY_CODES.TOOL_WILDCARD,
      'requestedPermissions.tools',
      `工具清单里出现了通配或空项 ${JSON.stringify(wildTools)}。` +
      '一个"支持通配 `*`"的白名单，与一个"所有工具都被允许"的白名单，是同一个东西',
    )
  }
  const knownToolSet = new Set(KNOWN_TOOL_NAMES)
  const unknownTools = raw.tools.filter((t) => !knownToolSet.has(t) && !wildTools.includes(t))
  if (unknownTools.length > 0) {
    const resolved = unknownTools.map((t) => resolveTool(t).risk)
    fail(
      PACK_AUTHORITY_CODES.TOOL_UNKNOWN,
      'requestedPermissions.tools',
      `声明了不在登记表里的工具 ${JSON.stringify(unknownTools)}（` +
      `它们在 PRT-601 里会被兜底成 ${JSON.stringify([...new Set(resolved)])} 风险）。` +
      '未知工具必须被**点名**，不能靠能力授权到达',
    )
  }
  const hostTools = new Set(hostSurface.allowedTools)
  const wideTools = raw.tools.filter((t) => knownToolSet.has(t) && !hostTools.has(t))
  if (wideTools.length > 0) {
    fail(
      PACK_AUTHORITY_CODES.TOOL_WIDENS_HOST,
      'requestedPermissions.tools',
      `工具 ${JSON.stringify(wideTools)} 不在宿主强制面之内（宿主有 ${JSON.stringify([...hostTools])}）`,
    )
  }

  const declaredRank = rankOf(raw.maxRisk)
  if (declaredRank === null) {
    fail(
      PACK_AUTHORITY_CODES.PERMISSION_MALFORMED,
      'requestedPermissions.maxRisk',
      `maxRisk 是 ${JSON.stringify(raw.maxRisk)}，不在 ${JSON.stringify(Object.keys(RISK_RANK))} 里`,
    )
    return Object.freeze({ problems: Object.freeze(problems), declared: null })
  }
  const ceilingRank = rankOf(hostSurface.riskCeiling)
  if (ceilingRank !== null && declaredRank > ceilingRank) {
    fail(
      PACK_AUTHORITY_CODES.RISK_ABOVE_HOST_CEILING,
      'requestedPermissions.maxRisk',
      `包的风险上限 ${raw.maxRisk} 高于宿主的 ${hostSurface.riskCeiling}`,
    )
  }

  if (raw.workspaceRoot !== null && !sameOrInside(raw.workspaceRoot, hostSurface.workspaceRoot)) {
    fail(
      PACK_AUTHORITY_CODES.OUT_OF_WORKSPACE,
      'requestedPermissions.workspaceRoot',
      `包的工作目录 ${JSON.stringify(raw.workspaceRoot)} 不在宿主强制面的 ${JSON.stringify(hostSurface.workspaceRoot)} 之内。` +
      '工作目录同样只能收窄——一个"能把自己的工作目录指到别处"的声明，' +
      '与一个"越界检查其实以包为准"的声明，是同一个东西',
    )
  }

  return Object.freeze({
    problems: Object.freeze(problems),
    declared: Object.freeze({
      capabilities: Object.freeze([...raw.capabilities]),
      tools: Object.freeze([...raw.tools]),
      maxRisk: raw.maxRisk,
      workspaceRoot: raw.workspaceRoot ?? null,
    }),
  })
}

function checkDataDependencies({ manifest }) {
  const problems = []
  const fail = (code, field, message) => problems.push(Object.freeze({ code, field, message }))
  const deps = manifest.dataDependencies
  if (deps === null || deps === undefined) {
    fail(
      PACK_AUTHORITY_CODES.DATA_DEPENDENCY_UNDECLARED,
      'dataDependencies',
      '能力包没有声明数据依赖。spec §6.13 line 567 要求"明确声明的 ... 数据依赖"——' +
      '缺字段不是"不依赖任何数据"：一个读工作区、读上游交付的团队包在声明里什么都不说，' +
      '与它真的什么都不读，是两件无法区分的事',
    )
    return Object.freeze({ problems: Object.freeze(problems), declared: Object.freeze([]) })
  }
  if (!Array.isArray(deps)) {
    fail(PACK_AUTHORITY_CODES.DATA_DEPENDENCY_MALFORMED, 'dataDependencies', 'dataDependencies 必须是数组')
    return Object.freeze({ problems: Object.freeze(problems), declared: Object.freeze([]) })
  }
  const declared = []
  for (const dep of deps) {
    if (dep === null || typeof dep !== 'object' || Array.isArray(dep)) {
      fail(PACK_AUTHORITY_CODES.DATA_DEPENDENCY_MALFORMED, 'dataDependencies', `每一项必须是对象：${JSON.stringify(dep)}`)
      continue
    }
    const keys = Object.keys(dep)
    const unknown = keys.filter((k) => !DATA_DEPENDENCY_FIELDS.includes(k))
    const missing = ['id', 'kind'].filter((k) => !keys.includes(k))
    if (unknown.length > 0 || missing.length > 0) {
      fail(
        PACK_AUTHORITY_CODES.DATA_DEPENDENCY_MALFORMED,
        'dataDependencies',
        `数据依赖字段必须恰好是 ${JSON.stringify(DATA_DEPENDENCY_FIELDS)}：缺 ${JSON.stringify(missing)}，多 ${JSON.stringify(unknown)}`,
      )
      continue
    }
    const kind = String(dep.kind).trim()
    if (SECRET_DEPENDENCY_KINDS.includes(kind.toLowerCase())) {
      fail(
        PACK_AUTHORITY_CODES.SECRET_DEPENDENCY,
        'dataDependencies',
        `数据依赖 ${JSON.stringify(dep.id)} 的种类是 ${JSON.stringify(kind)}——` +
        '能力包不得携带密钥，也不得声明它需要一个密钥。密钥只以**引用**（`secretRef`）出现在' +
        '模型配置与 `secret_refs` 里，由 host 持有',
      )
      continue
    }
    if (!CONTEXT_SOURCE_TYPES.includes(kind)) {
      fail(
        PACK_AUTHORITY_CODES.DATA_DEPENDENCY_UNKNOWN_KIND,
        'dataDependencies',
        `数据依赖 ${JSON.stringify(dep.id)} 的种类 ${JSON.stringify(kind)} 不在 ${JSON.stringify(CONTEXT_SOURCE_TYPES)} 里。` +
        '不认识就拒绝——一个"没见过的种类就当没有依赖"的判定，与一个"这一类依赖从不生效"的判定，是同一个东西',
      )
      continue
    }
    declared.push(Object.freeze({ id: String(dep.id), kind, scope: dep.scope ?? null }))
  }
  return Object.freeze({ problems: Object.freeze(problems), declared: Object.freeze(declared) })
}

function checkEmployees({ manifest, hostSurface, employees, permission }) {
  const problems = []
  const fail = (code, field, message) => problems.push(Object.freeze({ code, field, message }))
  const declared = permission?.declared ?? null

  if (manifest.packType !== 'team') {
    return Object.freeze({ problems: Object.freeze(problems), permits: Object.freeze([]) })
  }
  if (employees === null || employees === undefined) {
    fail(
      PACK_AUTHORITY_CODES.EMPLOYEES_UNDECLARED,
      'employees',
      `团队包 ${manifest.packId} 没有可检查的员工清单。` +
      '查不了就不算过——"员工清单拿不到"与"员工清单没有问题"在这道预检里必须是两件事',
    )
    return Object.freeze({ problems: Object.freeze(problems), permits: Object.freeze([]) })
  }
  if (!Array.isArray(employees)) {
    fail(PACK_AUTHORITY_CODES.EMPLOYEE_MALFORMED, 'employees', 'employees 必须是数组')
    return Object.freeze({ problems: Object.freeze(problems), permits: Object.freeze([]) })
  }

  const hostGrant = Object.freeze({
    allowedTools: hostSurface.allowedTools,
    allowedCapabilities: hostSurface.allowedCapabilities,
    maxRisk: hostSurface.riskCeiling,
    workspaceRoot: hostSurface.workspaceRoot,
  })
  const packCaps = declared === null ? null : new Set(declared.capabilities ?? [])
  const packTools = declared === null ? null : new Set(declared.tools ?? [])
  const packRank = declared === null ? null : rankOf(declared.maxRisk)

  const permits = []
  for (const raw of employees) {
    let normalized
    try {
      normalized = normalizeManifest(raw)
    } catch (err) {
      fail(PACK_AUTHORITY_CODES.EMPLOYEE_MALFORMED, 'employees', `员工清单不合法：${err?.message ?? String(err)}`)
      continue
    }
    let permit
    try {
      permit = narrowToGrant({ manifest: normalized, grant: hostGrant })
    } catch (err) {
      fail(
        PACK_AUTHORITY_CODES.EMPLOYEE_WIDENS_HOST,
        'employees',
        `员工 ${normalized.employeeId} 超出宿主授予：${err?.message ?? String(err)}`,
      )
      continue
    }
    // ★ 第二道方向：员工 ≤ **包自己声明**的权限。
    //   拿不到包声明时这里不能"就跳过"——那正是"包声明写得窄、员工偷偷写得宽"的入口。
    //
    //   唯一的例外是"包声明已经被 `checkPermissions` 拒绝过"这一种：
    //   那时判决已经是拒绝，再逐个员工报一遍只会让"问题数量"这个数字失去意义。
    //   这个例外被**条件**钉住了（`declared === null` **且** 那条检查确实报了问题）：
    //   如果哪一天 `checkPermissions` 改成"返回 null 却不报问题"，
    //   这里就会落到下面的 fail-closed 分支，而不是静默放过。
    if (declared === null || packCaps === null || packTools === null || packRank === null) {
      if (declared === null && permission !== null && permission.problems.length > 0) continue
      fail(
        PACK_AUTHORITY_CODES.PERMISSION_UNDECLARED,
        'requestedPermissions',
        `员工 ${normalized.employeeId} 无法与包声明的权限对照——包声明不可用，` +
        '而"对照不了"与"没有越权"在这道检查里必须是两件事',
      )
      continue
    }
    const overCaps = permit.allowedCapabilities.filter((c) => !packCaps.has(c))
    const overTools = permit.allowedTools.filter((t) => !packTools.has(t))
    const overRisk = rankOf(permit.maxRisk) > packRank
    if (overCaps.length > 0 || overTools.length > 0 || overRisk) {
      fail(
        PACK_AUTHORITY_CODES.EMPLOYEE_WIDENS_PACK,
        'employees',
        `员工 ${normalized.employeeId} 申请得比**包自己声明**得更多：` +
        `能力 ${JSON.stringify(overCaps)}，工具 ${JSON.stringify(overTools)}，风险上限更高=${overRisk}。` +
        '只查 manifest 里那一份权限声明是不够的——包内容里的员工清单自己也在申请权限',
      )
      continue
    }
    permits.push(Object.freeze({
      employeeId: permit.employeeId,
      role: permit.role,
      allowedTools: permit.allowedTools,
      allowedCapabilities: permit.allowedCapabilities,
      maxRisk: permit.maxRisk,
      workspaceRoot: permit.workspaceRoot,
    }))
  }
  return Object.freeze({ problems: Object.freeze(problems), permits: Object.freeze(permits) })
}

// ---------------------------------------------------------------------------
// 总检
// ---------------------------------------------------------------------------

/**
 * 一个能力包在**权限 / 密钥 / 强制面**三个方向上的越权检查。
 *
 * @param {object} p
 * @param {object} p.manifest 归一化前或后的 manifest
 * @param {Array<{path: string, text: string}>} p.files 载荷
 * @param {object} p.hostSurface `hostEnforcementSurface()` 的产物（**注入的基线**）
 * @param {Array<object>|null} [p.employees] 已解析出的员工清单（团队包必需）
 */
export function assertPackAuthority({ manifest, files, hostSurface, employees = null } = {}) {
  const problems = []
  const fail = (code, field, message) => problems.push(Object.freeze({ code, field, message }))

  const surfaceCheck = assertHostSurfaceUsable(hostSurface)
  if (!surfaceCheck.ok) {
    for (const p of surfaceCheck.problems) problems.push(p)
    // ★ 基线不可用时**不再往下判**。理由不是"省事"，而是下面每一条判据都是
    //   "包 ⊆ 基线"，基线不可用时它们会各自给出一个**看起来像结论**的东西。
    return Object.freeze({
      ok: false,
      code: problems[0].code,
      problems: Object.freeze(problems),
      computed: Object.freeze({ hostSurface: null, declared: null, secretHits: Object.freeze([]), bypassHits: Object.freeze([]), permits: Object.freeze([]) }),
    })
  }

  let m
  try {
    m = normalizePackManifest(manifest)
  } catch (err) {
    fail(err?.code ?? MANIFEST_CODES.BAD_MANIFEST, 'manifest', err?.message ?? String(err))
    return Object.freeze({
      ok: false,
      code: problems[0].code,
      problems: Object.freeze(problems),
      computed: Object.freeze({ hostSurface, declared: null, secretHits: Object.freeze([]), bypassHits: Object.freeze([]), permits: Object.freeze([]) }),
    })
  }

  // ① 密钥：声明必须**在**，且必须是否定；然后**扫内容**。
  const hasDeclaration = Object.prototype.hasOwnProperty.call(manifest ?? {}, 'containsSecrets')
    || Object.prototype.hasOwnProperty.call(m, 'containsSecrets')
  if (!hasDeclaration) {
    fail(
      PACK_AUTHORITY_CODES.SECRET_DECLARATION_MISSING,
      'containsSecrets',
      '能力包没有声明 `containsSecrets`。**没声明不是"没有"**——' +
      '一个"作者没写这一项就算没有密钥"的判定，与一个"所有没写这一项的包都不检查"的判定，是同一个东西',
    )
  } else if (m.containsSecrets !== false) {
    fail(
      PACK_AUTHORITY_CODES.SECRET_DECLARED,
      'containsSecrets',
      `能力包声明自己是 ${JSON.stringify(m.containsSecrets)}。能力包不得携带密钥（spec §6.13 line 570）——` +
      '一个承认带密钥的包同样要被拒：密钥只以引用出现在 host 侧',
    )
  }
  let secretHits = Object.freeze([])
  try {
    secretHits = scanForSecrets({ files })
  } catch (err) {
    fail(err?.code ?? MANIFEST_CODES.BAD_CONTENTS, 'files', err?.message ?? String(err))
  }
  if (secretHits.length > 0) {
    fail(
      PACK_AUTHORITY_CODES.SECRET_IN_CONTENT,
      'files',
      `载荷里扫到 ${secretHits.length} 处密钥材料：` +
      `${JSON.stringify(secretHits.map((h) => `${h.path}（${h.why}）`).slice(0, 6))}。` +
      '注意这一条查的是**内容**，与 manifest 里 `containsSecrets` 写了什么无关——' +
      '一个声明 `containsSecrets: false` 却夹带凭据的包，正是它要拦的那一种',
    )
  }

  // ② 强制面绕越：载荷内容 + 权限声明里的字段名。
  let bypassHits = Object.freeze([])
  try {
    bypassHits = scanForEnforcementBypass({ files })
  } catch (err) {
    fail(err?.code ?? MANIFEST_CODES.BAD_CONTENTS, 'files', err?.message ?? String(err))
  }
  if (bypassHits.length > 0) {
    fail(
      PACK_AUTHORITY_CODES.ENFORCEMENT_BYPASS_IN_CONTENT,
      'files',
      `载荷里出现强制面记号 ${JSON.stringify([...new Set(bypassHits.map((h) => h.token))].slice(0, 8))}` +
      `（例如 ${JSON.stringify(bypassHits[0].path)}）。` +
      '能力包不得绕过 ToolGuard、权限预设和审批（spec §6.13 line 570）——' +
      '强制面属于 host 组合，包只能在它之下运行',
    )
  }

  // ③ 权限：包 ⊆ 宿主。
  const perm = checkPermissions({ manifest: m, hostSurface })
  for (const p of perm.problems) problems.push(p)

  // ④ 数据依赖。
  const deps = checkDataDependencies({ manifest: m })
  for (const p of deps.problems) problems.push(p)

  // ⑤ 员工：⊆ 宿主，且 ⊆ 包声明。
  const emps = checkEmployees({ manifest: m, hostSurface, employees, permission: perm })
  for (const p of emps.problems) problems.push(p)
  // 包声明不可用时，员工这一道会给出一条 PERMISSION_UNDECLARED；上面 ③ 也会给一条。
  // 去重是必要的：同一条判据报两遍会让"问题数量"这个数字失去意义。
  const deduped = []
  const seen = new Set()
  for (const p of problems) {
    const k = `${p.code}|${p.field}|${p.message}`
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push(p)
  }

  return Object.freeze({
    ok: deduped.length === 0,
    code: deduped.length === 0 ? null : deduped[0].code,
    problems: Object.freeze(deduped),
    computed: Object.freeze({
      hostSurface: Object.freeze({
        origin: hostSurface.origin,
        preset: hostSurface.preset,
        sandbox: hostSurface.sandbox,
        approval: hostSurface.approval,
        riskCeiling: hostSurface.riskCeiling,
        allowedCapabilities: hostSurface.allowedCapabilities,
        allowedTools: hostSurface.allowedTools,
      }),
      declared: perm.declared,
      secretHits,
      bypassHits,
      dataDependencies: deps.declared,
      permits: emps.permits,
    }),
  })
}

// ---------------------------------------------------------------------------
// 完整预检（清单层 + 越权层）
// ---------------------------------------------------------------------------

/**
 * 安装前的完整预检。
 *
 * 顺序是固定的：**清单层**（结构 / 协议 / 内容哈希 / 来源 / 兼容 / 依赖）先跑，
 * 越权层后跑。理由不是审美：越权层需要一份**归一化过**的 manifest，
 * 而内容哈希必须先算出来，签名才有东西可验。
 */
export function preflightPack({
  manifest,
  files,
  host,
  hostSurface,
  installed = [],
  verifier = null,
  builtinPackIds = [],
} = {}) {
  const problems = []
  const manifestVerdict = preflightManifest({ manifest, files, host, installed, verifier, builtinPackIds })
  for (const p of manifestVerdict.problems) problems.push(p)

  // 员工清单从**载荷**里解析出来（不是从 manifest 的某个字段）。
  let employees = null
  let teamSource = null
  let normalized = null
  try {
    normalized = normalizePackManifest(manifest)
    if (normalized.packType === 'team') {
      teamSource = readPackTeam({ manifest: normalized, files })
      employees = teamSource.employees
    }
  } catch {
    // 解析不出来时 employees 保持 null：越权层会据此给出 EMPLOYEES_UNDECLARED，
    // 而清单层已经给出了具体原因（缺入口 / 入口不是 JSON / 不是团队包）。
    employees = null
  }

  const authority = assertPackAuthority({ manifest, files, hostSurface, employees })
  for (const p of authority.problems) problems.push(p)

  return Object.freeze({
    ok: problems.length === 0,
    code: problems.length === 0 ? null : problems[0].code,
    problems: Object.freeze(problems),
    computed: Object.freeze({
      ...manifestVerdict.computed,
      ...authority.computed,
      employees: employees === null ? null : employees.length,
    }),
  })
}

// ---------------------------------------------------------------------------
// 顺序闸门：预检**先于**创建目标
// ---------------------------------------------------------------------------

/**
 * 先预检，通过了才创建目标。
 *
 * ★ 返回的 `sequence` 是**自报**的，所以用例必须另外用一个计数器钉住
 *   `createTarget` 真的被调了几次。一个"报着 preflight、其实已经建了目标"的
 *   实现必须能被抓住——否则这段顺序证据就是它自己给自己出的证明。
 *
 * spec 阶段 10 完成标准 line 1006：「……在**创建目标前**失败。」
 * 那句话断言的是顺序，不是一个判决布尔。
 */
export function runPreflightThenCreateTarget({
  pack,
  host,
  hostSurface,
  installed = [],
  verifier = null,
  builtinPackIds = [],
  createTarget = null,
  onStep = null,
} = {}) {
  const sequence = []
  const step = (name) => {
    sequence.push(name)
    if (typeof onStep === 'function') onStep(name, sequence.length)
  }

  step('preflight')
  const verdict = preflightPack({
    manifest: pack?.manifest,
    files: pack?.files,
    host,
    hostSurface,
    installed,
    verifier,
    builtinPackIds,
  })

  if (verdict.ok !== true) {
    return Object.freeze({ created: false, target: null, code: verdict.code, verdict, sequence: Object.freeze([...sequence]) })
  }
  if (typeof createTarget !== 'function') {
    return Object.freeze({
      created: false,
      target: null,
      code: PACK_AUTHORITY_CODES.TARGET_CREATE_MISSING,
      verdict,
      sequence: Object.freeze([...sequence]),
    })
  }

  step('create-target')
  const target = createTarget(verdict)
  return Object.freeze({ created: true, target, code: null, verdict, sequence: Object.freeze([...sequence]) })
}

// ---------------------------------------------------------------------------
// 装载时自检
// ---------------------------------------------------------------------------

/** 自检 / 用例共用的"宿主真的授予了这个包"的基线。 */
export function sampleHostSurface({ preset = 'legion-attended', pack = sampleTeamPack(), patchVersion = 7 } = {}) {
  const decl = pack.manifest.requestedPermissions
  return hostEnforcementSurface({
    preset,
    patchVersion,
    grant: {
      allowedCapabilities: [...decl.capabilities],
      allowedTools: [...decl.tools],
      maxRisk: decl.maxRisk,
      workspaceRoot: decl.workspaceRoot,
    },
  })
}

/** 自检 / 用例共用的宿主版本三元组。 */
export function sampleAuthorityHost({ pack = sampleTeamPack() } = {}) {
  return Object.freeze({
    productVersion: '1.0.0',
    packProtocolVersion: PACK_PROTOCOL_VERSION,
    dshCompositionPatchVersion: 1,
    __packId: pack.manifest.packId,
  })
}

function repack(base, { employees, pipeline, extraFiles = [], manifestPatch = {}, dropManifestKeys = [] } = {}) {
  const src = sampleTeamPackWith({ employees, pipeline })
  const files = [...src.files, ...extraFiles]
  const entries = normalizePayload(files)
  const manifest = {
    ...src.manifest,
    ...manifestPatch,
    contents: entries.map((e) => ({ path: e.path, sha256: e.sha256, chars: e.chars })),
    contentHash: contentHashOfEntries(entries),
  }
  for (const k of dropManifestKeys) delete manifest[k]
  return Object.freeze({ manifest, files })
}

const BASE_EMPLOYEES = SAMPLE_TEAM.employees
const WIDER_EMPLOYEE = Object.freeze({
  ...SAMPLE_TEAM.employees[0],
  employeeId: 'sample-planner-wide',
  allowedCapabilities: Object.freeze([...SAMPLE_TEAM.employees[0].allowedCapabilities, 'file:delete']),
})

/**
 * 探针的通用入参：包 + **宿主强制面**（默认取"这个包被正常授予"的基线）+ 从载荷解析出的员工清单。
 *
 * 默认必须是**未被改坏的**那份基线，否则"能力超出宿主"这类探针会自己把基线
 * 一起放宽（`sampleHostSurface(pack)` 会照抄包声明），于是什么也证明不了。
 */
function probeArgs(pack, overrides = {}) {
  return Object.freeze({
    manifest: pack.manifest,
    files: pack.files,
    // ⚠️ 用 `=== undefined` 而不是 `??`：`null` 在这里是一个**有意义的值**
    //    （"没有基线"），而 `??` 会把它换回默认基线，于是
    //    `host-surface-unresolved` 这条探针永远打不中它要证明的那条判据。
    hostSurface: overrides.hostSurface === undefined ? sampleHostSurface() : overrides.hostSurface,
    employees: overrides.employees === undefined ? runEmployeeParse(pack) : overrides.employees,
  })
}

/**
 * 一条判据一条探针。
 *
 * 每一条都是在**一份本来会通过的包**上只改一处，所以"它被拒了"这句话才
 * 指向我们想证明的那一条——否则一条被别的原因顺带拦下的检查，
 * 与一条不存在的检查，在"它到底拦不拦得住"上是同一个东西。
 */
export const AUTHORITY_RULE_PROBES = Object.freeze([
  {
    id: 'host-surface-unresolved', expect: PACK_AUTHORITY_CODES.HOST_SURFACE_UNRESOLVED, call: 'authority',
    name: '没有强制面基线',
    build: () => probeArgs(sampleTeamPack(), { hostSurface: null }),
  },
  {
    id: 'host-surface-incomplete', expect: PACK_AUTHORITY_CODES.HOST_SURFACE_INCOMPLETE, call: 'authority',
    name: '基线里的能力名认不出来',
    build: () => probeArgs(sampleTeamPack(), {
      hostSurface: Object.freeze({ ...sampleHostSurface(), allowedCapabilities: Object.freeze(['file:reed']) }),
    }),
  },
  {
    id: 'host-surface-danger', expect: PACK_AUTHORITY_CODES.HOST_SURFACE_DANGER, call: 'authority',
    name: '基线的沙箱档是 DSH 默认的 danger-full-access',
    build: () => probeArgs(sampleTeamPack(), {
      hostSurface: Object.freeze({ ...sampleHostSurface(), sandbox: 'danger-full-access', approval: 'never' }),
    }),
  },
  {
    id: 'permission-undeclared', expect: PACK_AUTHORITY_CODES.PERMISSION_UNDECLARED, call: 'authority',
    name: '包没有声明权限',
    build: () => probeArgs(repack(null, { dropManifestKeys: ['requestedPermissions'] })),
  },
  {
    id: 'permission-malformed', expect: PACK_AUTHORITY_CODES.PERMISSION_MALFORMED, call: 'authority',
    name: '权限声明缺 maxRisk',
    build: () => probeArgs(repack(null, { manifestPatch: { requestedPermissions: { capabilities: [], tools: [], workspaceRoot: null } } })),
  },
  {
    id: 'capability-unknown', expect: PACK_AUTHORITY_CODES.CAPABILITY_UNKNOWN, call: 'authority',
    name: '能力名拼错',
    build: () => {
      const base = sampleTeamPack()
      return probeArgs(repack(null, {
        manifestPatch: { requestedPermissions: { ...base.manifest.requestedPermissions, capabilities: ['file:reed'] } },
      }))
    },
  },
  {
    id: 'capability-widens-host', expect: PACK_AUTHORITY_CODES.CAPABILITY_WIDENS_HOST, call: 'authority',
    name: '能力超出宿主强制面',
    build: () => {
      const base = sampleTeamPack()
      return probeArgs(repack(null, {
        manifestPatch: {
          requestedPermissions: {
            ...base.manifest.requestedPermissions,
            capabilities: [...base.manifest.requestedPermissions.capabilities, 'network:write'],
          },
        },
      }))
    },
  },
  {
    id: 'tool-unknown', expect: PACK_AUTHORITY_CODES.TOOL_UNKNOWN, call: 'authority',
    name: '工具不在登记表里',
    build: () => {
      const base = sampleTeamPack()
      return probeArgs(repack(null, {
        manifestPatch: {
          requestedPermissions: {
            ...base.manifest.requestedPermissions,
            tools: [...base.manifest.requestedPermissions.tools, 'delete-everything'],
          },
        },
      }))
    },
  },
  {
    id: 'tool-wildcard', expect: PACK_AUTHORITY_CODES.TOOL_WILDCARD, call: 'authority',
    name: '工具名里带通配符',
    build: () => {
      const base = sampleTeamPack()
      return probeArgs(repack(null, {
        manifestPatch: { requestedPermissions: { ...base.manifest.requestedPermissions, tools: ['*'] } },
      }))
    },
  },
  {
    id: 'tool-widens-host', expect: PACK_AUTHORITY_CODES.TOOL_WIDENS_HOST, call: 'authority',
    name: '工具超出宿主强制面',
    build: () => {
      const base = sampleTeamPack()
      return probeArgs(repack(null, {
        manifestPatch: {
          requestedPermissions: {
            ...base.manifest.requestedPermissions,
            tools: [...base.manifest.requestedPermissions.tools, 'delete-file'],
          },
        },
      }))
    },
  },
  {
    id: 'risk-above-ceiling', expect: PACK_AUTHORITY_CODES.RISK_ABOVE_HOST_CEILING, call: 'authority',
    name: '风险上限高于宿主上限',
    build: () => {
      const base = sampleTeamPack()
      return probeArgs(repack(null, {
        manifestPatch: { requestedPermissions: { ...base.manifest.requestedPermissions, maxRisk: 'critical' } },
      }))
    },
  },
  {
    id: 'out-of-workspace', expect: PACK_AUTHORITY_CODES.OUT_OF_WORKSPACE, call: 'authority',
    name: '工作目录不在宿主工作目录之内',
    build: () => {
      const base = sampleTeamPack()
      return probeArgs(repack(null, {
        manifestPatch: { requestedPermissions: { ...base.manifest.requestedPermissions, workspaceRoot: 'C:/elsewhere' } },
      }))
    },
  },
  {
    id: 'employees-undeclared', expect: PACK_AUTHORITY_CODES.EMPLOYEES_UNDECLARED, call: 'authority',
    name: '团队包拿不到员工清单',
    build: () => probeArgs(sampleTeamPack(), { employees: null }),
  },
  {
    id: 'employee-malformed', expect: PACK_AUTHORITY_CODES.EMPLOYEE_MALFORMED, call: 'authority',
    name: '员工清单本身不合法',
    build: () => probeArgs(repack(null, {
      employees: [{ ...BASE_EMPLOYEES[0], maxRisk: 'catastrophic' }, BASE_EMPLOYEES[1]],
    })),
  },
  {
    id: 'employee-widens-host', expect: PACK_AUTHORITY_CODES.EMPLOYEE_WIDENS_HOST, call: 'authority',
    name: '员工超出宿主授予',
    build: () => probeArgs(repack(null, {
      employees: [
        { ...BASE_EMPLOYEES[0], allowedCapabilities: [...BASE_EMPLOYEES[0].allowedCapabilities, 'credential:read'] },
        BASE_EMPLOYEES[1],
      ],
    })),
  },
  {
    id: 'employee-widens-pack', expect: PACK_AUTHORITY_CODES.EMPLOYEE_WIDENS_PACK, call: 'authority',
    name: '员工申请得比包声明的多',
    build: () => {
      const pack = repack(null, { employees: [WIDER_EMPLOYEE, BASE_EMPLOYEES[1]] })
      // 宿主授予得**更宽**（含 file:delete），所以越权点是"员工 > 包声明"而不是"员工 > 宿主"
      const hostSurface = hostEnforcementSurface({
        preset: 'legion-attended',
        patchVersion: 7,
        grant: {
          allowedCapabilities: [...pack.manifest.requestedPermissions.capabilities, 'file:delete'],
          allowedTools: pack.manifest.requestedPermissions.tools,
          maxRisk: pack.manifest.requestedPermissions.maxRisk,
          workspaceRoot: pack.manifest.requestedPermissions.workspaceRoot,
        },
      })
      return probeArgs(pack, { hostSurface })
    },
  },
  {
    id: 'secret-in-content', expect: PACK_AUTHORITY_CODES.SECRET_IN_CONTENT, call: 'authority',
    name: '★ 声明 containsSecrets:false 却夹带凭据',
    build: () => probeArgs(repack(null, {
      extraFiles: [{ path: 'rules/credentials.json', text: '{"apiKey": "hunter2swordfish"}\n' }],
    })),
  },
  {
    id: 'secret-declared', expect: PACK_AUTHORITY_CODES.SECRET_DECLARED, call: 'authority',
    name: '包声明自己携带密钥',
    build: () => probeArgs(repack(null, { manifestPatch: { containsSecrets: true } })),
  },
  {
    id: 'secret-declaration-missing', expect: PACK_AUTHORITY_CODES.SECRET_DECLARATION_MISSING, call: 'authority',
    name: '包没有声明 containsSecrets',
    build: () => probeArgs(repack(null, { dropManifestKeys: ['containsSecrets'] })),
  },
  {
    id: 'secret-dependency', expect: PACK_AUTHORITY_CODES.SECRET_DEPENDENCY, call: 'authority',
    name: '数据依赖要的是密钥',
    build: () => probeArgs(repack(null, { manifestPatch: { dataDependencies: [{ id: 'model-key', kind: 'secret' }] } })),
  },
  {
    id: 'data-dependency-undeclared', expect: PACK_AUTHORITY_CODES.DATA_DEPENDENCY_UNDECLARED, call: 'authority',
    name: '包没有声明数据依赖',
    build: () => probeArgs(repack(null, { dropManifestKeys: ['dataDependencies'] })),
  },
  {
    id: 'data-dependency-malformed', expect: PACK_AUTHORITY_CODES.DATA_DEPENDENCY_MALFORMED, call: 'authority',
    name: '数据依赖缺 kind',
    build: () => probeArgs(repack(null, { manifestPatch: { dataDependencies: [{ id: 'workspace' }] } })),
  },
  {
    id: 'data-dependency-unknown-kind', expect: PACK_AUTHORITY_CODES.DATA_DEPENDENCY_UNKNOWN_KIND, call: 'authority',
    name: '数据依赖的种类不认识',
    build: () => probeArgs(repack(null, { manifestPatch: { dataDependencies: [{ id: 'x', kind: 'quantum-telemetry' }] } })),
  },
  {
    id: 'enforcement-field', expect: PACK_AUTHORITY_CODES.ENFORCEMENT_FIELD, call: 'authority',
    name: '权限声明里出现强制面字段',
    build: () => {
      const base = sampleTeamPack()
      return probeArgs(repack(null, {
        manifestPatch: { requestedPermissions: { ...base.manifest.requestedPermissions, approvalPolicy: 'never' } },
      }))
    },
  },
  {
    id: 'enforcement-bypass-in-content', expect: PACK_AUTHORITY_CODES.ENFORCEMENT_BYPASS_IN_CONTENT, call: 'authority',
    name: '载荷里出现强制面记号',
    build: () => probeArgs(repack(null, {
      extraFiles: [{ path: 'rules/policy.json', text: '{"approvalPolicy": "never"}\n' }],
    })),
  },
  {
    id: 'target-create-missing', expect: PACK_AUTHORITY_CODES.TARGET_CREATE_MISSING, call: 'ordering',
    name: '顺序闸门没有拿到建目标的回调',
    build: () => {
      const pack = sampleTeamPack()
      return {
        pack,
        host: { productVersion: '1.0.0', packProtocolVersion: PACK_PROTOCOL_VERSION, dshCompositionPatchVersion: 1 },
        hostSurface: sampleHostSurface(),
        builtinPackIds: [pack.manifest.packId],
      }
    },
  },
])

/** 从一份"重新拼过"的包里解析员工清单（探针里要用到"真的从载荷读出来"的那一份）。 */
function runEmployeeParse(pack) {
  try {
    return readPackTeam({ manifest: normalizePackManifest(pack.manifest), files: pack.files }).employees
  } catch {
    return null
  }
}

function runProbe(probe) {
  const args = probe.build()
  if (probe.call === 'ordering') {
    const r = runPreflightThenCreateTarget({ ...args, createTarget: null })
    return Object.freeze({
      codes: Object.freeze([r.code]),
      created: r.created,
      sequence: r.sequence,
      targetCalls: 0,
    })
  }
  const verdict = probe.call === 'authority' ? assertPackAuthority(args) : preflightPack({ ...args, host: args.host })
  return Object.freeze({
    codes: Object.freeze(verdict.problems.map((p) => p.code)),
    created: null,
    sequence: null,
    targetCalls: null,
  })
}

/**
 * 每条判据都必须能被**真的触发**一次。
 *
 * `uncovered` 是从码表反推出来的，不是手写的清单：一条写在码表里、
 * 而没有任何输入能走到它的判据，与一条不存在的判据，
 * 在"它到底拦不拦得住"上是同一个东西。
 */
export function proveEveryAuthorityRuleFires() {
  const results = []
  for (const probe of AUTHORITY_RULE_PROBES) {
    let outcome
    try {
      outcome = runProbe(probe)
    } catch (err) {
      outcome = Object.freeze({ codes: Object.freeze([`threw:${err?.constructor?.name}`]), created: null, sequence: null, targetCalls: null })
    }
    results.push(Object.freeze({
      id: probe.id,
      name: probe.name,
      expect: probe.expect,
      fired: outcome.codes.includes(probe.expect),
      onlyExpected: outcome.codes.length === 1 && outcome.codes[0] === probe.expect,
      codes: outcome.codes,
    }))
  }
  const covered = new Set(results.filter((r) => r.fired).map((r) => r.expect))
  const uncovered = Object.values(PACK_AUTHORITY_CODES).filter((c) => !covered.has(c))
  return Object.freeze({ results: Object.freeze(results), covered: Object.freeze([...covered].sort()), uncovered: Object.freeze(uncovered) })
}

/** 顺序探针：不通过时**一次也不许**调 `createTarget`。 */
export function provePreflightOrdering() {
  const pack = sampleTeamPack()
  const host = { productVersion: '1.0.0', packProtocolVersion: PACK_PROTOCOL_VERSION, dshCompositionPatchVersion: 1 }
  const hostSurface = sampleHostSurface()
  let calls = 0
  const seen = []
  // 坏包：内容被改过（哈希错误），且没有声明 containsSecrets。
  const broken = {
    manifest: { ...pack.manifest, contentHash: `sha256:${'0'.repeat(64)}` },
    files: pack.files,
  }
  const bad = runPreflightThenCreateTarget({
    pack: broken,
    host,
    hostSurface,
    builtinPackIds: [pack.manifest.packId],
    createTarget: () => { calls += 1; return { targetId: 'should-not-exist' } },
    onStep: (name) => seen.push(name),
  })
  const callsAfterBad = calls
  const good = runPreflightThenCreateTarget({
    pack,
    host,
    hostSurface,
    builtinPackIds: [pack.manifest.packId],
    createTarget: () => { calls += 1; return { targetId: 'goal-ok' } },
  })
  return Object.freeze({
    badCreated: bad.created,
    badTarget: bad.target,
    badSequence: bad.sequence,
    badVerdictCode: bad.code,
    badCreateTargetCalls: callsAfterBad,
    badOnStepSequence: Object.freeze([...seen]),
    goodCreated: good.created,
    goodSequence: good.sequence,
    goodTarget: good.target,
    totalCreateTargetCalls: calls,
  })
}

/**
 * ★ 两种基线并排算一次。
 *
 * 这是"方向"这件事唯一能被看见的方式：**同一个包**，
 * 对着**它自己的声明**当基线时通过，对着**宿主强制面**时才被拦下。
 *
 * 包在这里只改了一处：`requestedPermissions.capabilities` 里多了一个
 * `network:write`（宿主没给）。一个把基线取成"包声明的权限"的实现，
 * 会得到一份**与包完全一致的**上限，于是这个包永远不越权——
 * 而报表上这条检查是绿色的。
 */
export function compareBaselines() {
  const base = sampleTeamPack()
  const widened = repack(null, {
    manifestPatch: {
      requestedPermissions: {
        ...base.manifest.requestedPermissions,
        capabilities: [...base.manifest.requestedPermissions.capabilities, 'network:write'],
      },
    },
  })
  const employees = runEmployeeParse(widened)
  const decl = widened.manifest.requestedPermissions
  const naiveSurface = hostEnforcementSurface({
    preset: 'legion-attended',
    patchVersion: 7,
    // ← 这份基线逐字来自**包自己的声明**（越权实现会这么做）
    grant: {
      allowedCapabilities: [...decl.capabilities],
      allowedTools: [...decl.tools],
      maxRisk: decl.maxRisk,
      workspaceRoot: decl.workspaceRoot,
    },
  })
  const hostSurface = sampleHostSurface()
  const againstSelf = assertPackAuthority({ manifest: widened.manifest, files: widened.files, hostSurface: naiveSurface, employees })
  const againstHost = assertPackAuthority({ manifest: widened.manifest, files: widened.files, hostSurface, employees })
  return Object.freeze({
    againstPackSelf: againstSelf.code,
    againstHost: againstHost.code,
    hostSurfaceOrigin: hostSurface.origin,
    hostSurfaceCapabilities: hostSurface.allowedCapabilities,
    naiveSurfaceCapabilities: naiveSurface.allowedCapabilities,
    note: '同一个包：以"包自己的声明"为基线时通过，以宿主强制面为基线时才被拦下',
  })
}

/**
 * 装载期自检。**不抛，留值。**
 */
export function assertAuthoritySemantics() {
  const problems = []
  const samples = {}

  const fired = proveEveryAuthorityRuleFires()
  samples.rulesFired = fired.results.length
  samples.rulesNotFired = Object.freeze(fired.results.filter((r) => !r.fired).map((r) => `${r.id}:${r.codes.join('+')}`))
  samples.rulesMultiCode = Object.freeze(fired.results.filter((r) => r.fired && !r.onlyExpected).map((r) => `${r.id}:${r.codes.join('+')}`))
  samples.coveredCodes = fired.covered
  samples.uncoveredCodes = fired.uncovered
  if (fired.uncovered.length > 0) problems.push(`有判据没有任何输入能触发：${JSON.stringify(fired.uncovered)}`)
  if (fired.results.some((r) => !r.fired)) problems.push('有探针没有打中它要证明的那条判据')

  samples.ordering = provePreflightOrdering()
  if (samples.ordering.badCreated !== false) problems.push('不通过的包仍然创建了目标')
  if (samples.ordering.badCreateTargetCalls !== 0) problems.push('不通过的包仍然调用了 createTarget')
  if (samples.ordering.badSequence.join('>') !== 'preflight') problems.push(`不通过时的步骤序列不是只有 preflight：${samples.ordering.badSequence.join('>')}`)
  if (samples.ordering.goodCreated !== true) problems.push('通过的包没有创建目标')
  if (samples.ordering.goodSequence.join('>') !== 'preflight>create-target') problems.push('通过的包步骤顺序不对')

  samples.naiveBaseline = compareBaselines()
  if (samples.naiveBaseline.againstPackSelf !== null) {
    problems.push('以包自己的声明为基线时竟然拦下了越权——那说明被拦下的原因是别的')
  }
  if (samples.naiveBaseline.againstHost !== PACK_AUTHORITY_CODES.CAPABILITY_WIDENS_HOST) {
    problems.push(`以宿主强制面为基线时没有拦下越权（${samples.naiveBaseline.againstHost}）`)
  }

  // 正例：一份合法的包必须**真的**通过（否则上面所有拒绝都可能只是"什么都拒"）
  const goodPack = sampleTeamPack()
  const employees = readPackTeam({ manifest: normalizePackManifest(goodPack.manifest), files: goodPack.files }).employees
  const goodSurface = sampleHostSurface(goodPack)
  const good = assertPackAuthority({ manifest: goodPack.manifest, files: goodPack.files, hostSurface: goodSurface, employees })
  samples.goodVerdictOk = good.ok
  samples.goodVerdictCodes = Object.freeze(good.problems.map((p) => p.code))
  samples.goodPermits = Object.freeze(good.computed.permits.map((p) => p.employeeId))
  if (good.ok !== true) problems.push(`样例包没有通过越权检查：${JSON.stringify(samples.goodVerdictCodes)}`)

  // 引用式密钥必须被允许（`env:` / `secret:`），否则这条检查会逼着作者把引用删掉
  samples.secretScan = Object.freeze({
    literal: scanForSecrets({ files: [{ path: 'a.json', text: '{"apiKey": "hunter2swordfish"}' }] }).length,
    reference: scanForSecrets({ files: [{ path: 'a.json', text: '{"apiKey": "env:OPENAI_API_KEY"}' }] }).length,
    vendorPrefix: scanForSecrets({ files: [{ path: 'a.json', text: 'key = "sk-abcdefghijklmnop"' }] }).length,
  })
  if (samples.secretScan.literal !== 1) problems.push('敏感键名下的字面量值没有被扫出来')
  if (samples.secretScan.reference !== 0) problems.push('引用式密钥被误判成密文')
  if (samples.secretScan.vendorPrefix !== 1) problems.push('供应商前缀密钥没有被扫出来')

  // ★ 两张禁用名单必须**没有重复项**。
  //
  //   不去重时同一个键会被扫出两条一模一样的命中（`approvalPolicy` 同时在
  //   PRT-603 与 PRT-404 的名单里），于是"命中数"这个数字变成没人能解释的东西。
  //   留的是**算出来的重复项**，不是一个"我检查过了"。
  samples.forbiddenKeyDuplicates = duplicatesOf(PACK_FORBIDDEN_CONTENT_KEYS)
  samples.forbiddenTokenDuplicates = duplicatesOf(PACK_FORBIDDEN_CONTENT_TOKENS)
  samples.forbiddenKeyCount = PACK_FORBIDDEN_CONTENT_KEYS.length
  samples.forbiddenTokenCount = PACK_FORBIDDEN_CONTENT_TOKENS.length
  if (samples.forbiddenKeyDuplicates.length > 0) {
    problems.push(`禁用键名表里有重复项：${JSON.stringify(samples.forbiddenKeyDuplicates)}`)
  }
  if (samples.forbiddenTokenDuplicates.length > 0) {
    problems.push(`禁用记号表里有重复项：${JSON.stringify(samples.forbiddenTokenDuplicates)}`)
  }
  // 同一处越权只该留一条命中
  samples.duplicateHitProbe = scanForEnforcementBypass({
    files: [{ path: 'x.json', text: '{"approvalPolicy": "never"}' }],
  }).length
  if (samples.duplicateHitProbe !== 1) {
    problems.push(`同一处越权被扫出 ${samples.duplicateHitProbe} 条命中，期望 1`)
  }

  return Object.freeze({ problems: Object.freeze(problems), samples: Object.freeze(samples) })
}

/** 一张名单里的重复项（算出来的，不是"我检查过了"）。 */
function duplicatesOf(list) {
  const seen = new Set()
  const dup = new Set()
  for (const x of list ?? []) {
    if (seen.has(x)) dup.add(x)
    seen.add(x)
  }
  return Object.freeze([...dup])
}

// 装载即执行。导出的是**每一条判据被触发时的具体码**与那一对基线读数，不是一个布尔 ok。
export const PACK_AUTHORITY_CHECKED = Object.freeze({
  environment: 'legion/pack-authority@1',
  hostSurfaceOrigin: HOST_SURFACE_ORIGIN,
  knownTools: KNOWN_TOOL_NAMES.length,
  knownCapabilities: CAPABILITY_IDS.length,
  forbiddenContentKeys: PACK_FORBIDDEN_CONTENT_KEYS,
  forbiddenContentTokens: PACK_FORBIDDEN_CONTENT_TOKENS,
  ...assertAuthoritySemantics(),
})
