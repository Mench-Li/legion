// product/support/runbook.mjs
// ============================================================================
// PRT-907：支持诊断与故障处置手册。
//
// spec §10 line 990。
//
// ## 为什么手册必须是**可执行校验**的
//
// 手写手册最常见的失效方式与隐私说明一样，只是更致命：**它写在最需要它的
// 那一刻之前**，而命令行、错误码、目录布局都会变。
//
//   > 一个「写着运行 `legion --doctor`」的手册，
//   > 与一个「支持人员在客户现场发现这个开关不存在」的手册，是同一个东西——
//   > 只不过前者在文档评审里看起来是完备的。
//
// 所以本模块把手册**挂在代码自己的开关表上**：`diagnose` 里每一个引用到的
// 命令行开关，装载期都拿去与 `product/launcher/cli.mjs` 的 `CLI_FLAGS` 核对。
// **CLI 一改，手册就红**——这份手册不可能悄悄过期。
//
// ## ★ 四个会安静出错的坑
//
// ### ① 症状不可观测
//
// "用户说很慢"、"装不上"不是症状。可观测的症状是一个**状态名或错误码**：
// `runtime-state` 报 `degraded`、退出码 4、`HEARTBEAT_NO_ENDPOINT`。
// 不可观测的症状无法被下一次遇到它的人对上号。
//
// ### ② 没有"这步没用怎么办"
//
// 一条只有一个动作的处置是**死胡同**。支持人员照着做完，问题还在，手册没话说了
// ——而他此时比没有手册时更确信自己漏了什么。
//
//   > 一个「只在第一步有效时才完整」的手册，
//   > 与一个「照着做完仍然卡住、然后不知道去哪」的手册，是同一个东西——
//   > 只不过前者在步骤清单上是完整的。
//
// ### ③ 诊断步骤本身依赖一个健康的产品
//
// 最需要诊断的时候正是产品坏掉的时候。一条"先打开设置页看配置"的步骤，
// 在产品起不来时不可用。（PRT-710 的教训：诊断入口必须在坏掉时仍可用。）
// 所以每条处置都要**声明**它在产品坏掉时是否可用；声明为不可用的，
// 必须写明该先做什么。
//
// ### ④ 全部处置都指向同一个动作
//
// 十条处置都写"导出诊断包并联系支持"，等于只有一条处置。
//   · 每一类故障必须至少有一条**自己特有**的处置。
// ============================================================================

import { CLI_FLAGS, EXIT_CODES } from '../launcher/cli.mjs'
// ★ 权威的**具名错误码**表。手册里提到的错误码必须真的在它里面——
//   与 `EXIT_CODES` 的交叉核对是同一条纪律。
import { ERROR_CODES, isKnownErrorCode } from '../../runtime/contracts/errors.mjs'

/** 手册版本。 */
export const RUNBOOK_VERSION = 'legion/support-runbook@1'

/**
 * 故障分类。每一类都必须至少有**一条自己特有的**处置。
 */
export const FAULT_CLASSES = Object.freeze([
  Object.freeze({ id: 'install', label: '装不上 / 首次运行' }),
  Object.freeze({ id: 'config', label: '配置不对 / 起不来' }),
  Object.freeze({ id: 'startup', label: '进程起不来 / 端口占用' }),
  Object.freeze({ id: 'runtime', label: '运行状态不对 / 任务卡住' }),
  Object.freeze({ id: 'model', label: '模型不可用 / 调用失败' }),
  Object.freeze({ id: 'budget', label: '预算与配额' }),
  Object.freeze({ id: 'approval', label: '审批不出现 / 审批卡住' }),
  Object.freeze({ id: 'upgrade', label: '升级失败 / 回滚' }),
  Object.freeze({ id: 'data', label: '数据丢失 / 恢复' }),
  Object.freeze({ id: 'perf', label: '慢 / 磁盘占用' }),
])

export const FAULT_CLASS_IDS = Object.freeze(FAULT_CLASSES.map((c) => c.id))

/**
 * 可观测的形态。
 *
 * ★ "可观测"必须是**结构化的**——第一版把它做成一句自由文本，然后用正则去猜
 *   它"够不够具体"，结果是正则在一堆真实但措辞不同的读数上误报
 *   （"lease 过期但 attempt 没有推进"被判成不可观测）。
 *
 *   > 一个「靠形容词判断够不够具体」的检查，
 *   > 与一个「取决于正则作者当时想到哪些词」的检查，是同一个东西——
 *   > 只不过前者在"我核对过了"这句话上看起来是有依据的。
 *
 *   所以改成 kind + ref：kind 是闭集，ref 是文字。
 *   `exit-code` 这一档还会与**真实的 `EXIT_CODES` 表交叉核对**——
 *   手册里写一个代码里不存在的退出码，这里就会红。
 */
export const OBSERVABLE_KINDS = Object.freeze([
  'exit-code',   // 退出码（与 EXIT_CODES 交叉核对）
  'error-code',  // 具名错误码
  'state',       // 状态名（runtime-state / 审计 verdict / 账本状态）
  'metric',      // 一个可读的读数（metrics 字段、队列深度、租约数）
  'artifact',    // 一个可以去查的文件 / 报告
])

export const RUNBOOK_CODES = Object.freeze({
  /** 处置引用了一个**不存在**的命令行开关。 */
  UNKNOWN_FLAG: 'runbook-unknown-flag',
  /** 症状不可观测（没有状态名或错误码）。 */
  NO_OBSERVABLE: 'runbook-no-observable',
  /** 一条只有一个动作的处置——死胡同。 */
  DEAD_END: 'runbook-dead-end',
  /** 没说"这步没用之后找谁/做什么"。 */
  NO_ESCALATION: 'runbook-no-escalation',
  /** 诊断步骤在产品坏掉时不可用，却没写明要先做什么。 */
  BROKEN_CAVEAT_MISSING: 'runbook-broken-caveat-missing',
  /** 故障分类认不出来。 */
  CLASS_UNKNOWN: 'runbook-class-unknown',
  /** 某一类故障一条处置都没有。 */
  CLASS_UNCOVERED: 'runbook-class-uncovered',
  /** 某一类故障的处置**全部**与别的类重复（等于那一类没有自己的处置）。 */
  CLASS_NOT_DISTINCTIVE: 'runbook-class-not-distinctive',
  /** 没有处置——空手册。 */
  EMPTY: 'runbook-empty',
  /** 处置没有说明它对应什么症状之外的东西（缺 why）。 */
  UNJUSTIFIED: 'runbook-unjustified',
  /** 可观测的形态不在闭集里。 */
  OBSERVABLE_KIND_UNKNOWN: 'runbook-observable-kind-unknown',
  /** `exit-code` 档引用了 `EXIT_CODES` 里不存在的退出码。 */
  EXIT_CODE_UNKNOWN: 'runbook-exit-code-unknown',
  /** `error-code` 档引用了产品**不存在**的具名错误码。 */
  ERROR_CODE_UNKNOWN: 'runbook-error-code-unknown',
  /** 声明是可观测的码/读数，但内容看不出是一个标识符。 */
  OBSERVABLE_NOT_AN_IDENTIFIER: 'runbook-observable-not-an-identifier',
})

/**
 * 命令行的引用写法：`--flag`、`--flag=<x>`、`--port.team-hub=9000`。
 *
 * ★ 这个正则**故意宽松**——它只负责把"看起来像开关"的片段切出来，
 *   判断它是否真实存在是下一步的事。
 *
 *   第一版把它写紧了（只认 `--port.<进程>=<n>` 这种**带尖括号**的写法），
 *   于是手册里那句 `--port.team-hub=9000` 被切成了 `--port`，
 *   而 `--port` 不在开关表里 → 报"引用了不存在的开关"。
 *
 *   > 一个「只认文档里那种写法」的检查，
 *   > 与一个「不认用户实际会写的那种写法」的检查，是同一个东西——
 *   > 只不过前者在"我核对过了"这句话上看起来是有依据的。
 *
 *   真实存在的判断交给 `matchFlag`：它把开关表里的 `<...>` 占位符
 *   展开成正则，所以 `--port.<进程>=<n>` 能匹配 `--port.team-hub=9000`。
 */
const FLAG_PATTERN = /--[A-Za-z][A-Za-z0-9._-]*(?:=[^\s\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]+)?/g

/** 从一段文本里抽出它引用到的开关写法（**不判断真伪**）。 */
export function referencedFlags(text) {
  if (typeof text !== 'string') return []
  return [...new Set(text.match(FLAG_PATTERN) ?? [])]
}

/**
 * 把开关表编译成一组"能匹配实际写法"的正则。
 *
 * `--port.<进程>=<n>` → `/^--port\..+=.+$/`，于是 `--port.team-hub=9000` 命中。
 *
 * ★ 同时给出 `baseName`：取值开关在**散文里被bare名字提到**时也必须算命中。
 *
 *   手册里会写「**不要**直接加 `--allow-port-in-use`」——那是在提这个名字，
 *   不是在给一个可执行的命令行。第一版只认带值的写法，于是这句被报成
 *   "引用了不存在的开关"。
 *
 *   > 一个「对真实存在的开关喊狼来了」的检查，
 *   > 与一个「支持人员学会了忽略它的输出」的检查，是同一个东西——
 *   > 只不过前者在"我核对过了"这句话上看起来是有依据的。
 *
 *   两个方向都要放行：**带具体值的引用**与**只提名字的引用**。
 *   真实不存在的名字（`--doctor`）仍然会被抓住。
 */
export function compileFlagPatterns(knownFlags) {
  return knownFlags.map((name) => {
    const body = name
      .split(/(<[^>]+>)/)
      .map((part) => (part.startsWith('<') && part.endsWith('>')
        ? '.+'
        : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('')
    // 第一个占位符或等号之前的部分，去掉尾部的 `.` / `-`。
    const baseName = name.split(/[<=]/)[0].replace(/[.-]+$/, '')
    return { name, baseName, re: new RegExp(`^${body}$`) }
  })
}

/** 一个写法是否命中开关表里的某一条（返回命中的那条名字，或 null）。 */
export function matchFlag(written, knownFlags) {
  for (const { name, baseName, re } of compileFlagPatterns(knownFlags)) {
    if (re.test(written)) return name
    if (written === baseName) return name
  }
  return null
}

/**
 * 处置清单。
 *
 * 每条必须：
 *   · 属于一个真实分类；
 *   · 有**可观测**的症状（`observable` 是一个状态名或错误码）；
 *   · 有 `diagnose`（怎么确认是这一条）；
 *   · 有 `action`（怎么处置）；
 *   · 有 `ifNotHelped`（**这步没用怎么办**）；
 *   · 有 `escalate`（找谁 / 交什么）；
 *   · 声明 `worksWhenBroken`，为假时必须有 `caveat`。
 */
export const RUNBOOK_ENTRIES = Object.freeze([
  Object.freeze({
    id: 'rb-install-layout',
    faultClass: 'install',
    symptom: '首次运行直接退出，什么都没建',
    observable: Object.freeze({ kind: 'exit-code', ref: '3 (layout) / 7 (init)' }),
    diagnose: 'legion --init --dry-run --json 看它打算建什么；`legion --check --json` 看体检结果',
    action: '按 --check 报出的项逐个补齐：目录可写、端口可用、依赖入口存在',
    ifNotHelped: '用 --no-config 再跑一次：配置层坏掉时体检仍会报出布局问题',
    escalate: '把 --check --json 的完整输出交给支持；它不含密钥',
    worksWhenBroken: true,
    why: '这一条覆盖"产品根本还没起来"，所以它的诊断路径必须是只读且不依赖配置的',
  }),
  Object.freeze({
    id: 'rb-config-badjson',
    faultClass: 'config',
    symptom: '改过产品配置之后进程起不来',
    observable: Object.freeze({ kind: 'exit-code', ref: '6 (config)' }),
    diagnose: 'legion --no-config --check --json：绕过配置看布局是否仍然正常',
    action: '如果 --no-config 能过，坏的就是配置本身：把 product.config.json 备份后删掉，让它重建',
    ifNotHelped: '用 --diagnostics=<dir> 在坏配置下导包——诊断入口不依赖配置能解析',
    escalate: '附上 product.config.json 的副本；**先自己删掉其中的 apiKey/secretRef 字段**',
    worksWhenBroken: true,
    why: '坏 JSON 是最常见的"起不来"，而它的处置必须能在配置坏掉时执行',
  }),
  Object.freeze({
    id: 'rb-startup-port-in-use',
    faultClass: 'startup',
    symptom: '启动时报端口被占用',
    observable: Object.freeze({ kind: 'exit-code', ref: '5 (start)' }),
    diagnose: 'legion --check --json 看是哪个进程的哪个端口',
    action: '换端口（--port.team-hub=9000）或先停掉占用者。**不要**直接加 --allow-port-in-use',
    ifNotHelped: '用 --sweep-orphans（默认只报告）确认是不是上一次运行留下的子进程',
    escalate: '把 --check --json 与 --sweep-orphans 的报告一起交给支持',
    worksWhenBroken: true,
    why: '端口占用有两条完全不同的成因（别人占着 / 自己的孤儿进程），处置不同',
  }),
  Object.freeze({
    id: 'rb-startup-orphans',
    faultClass: 'startup',
    symptom: '反复提示端口占用，但看不出谁在用',
    observable: Object.freeze({ kind: 'artifact', ref: '--sweep-orphans 报出的候选进程清单（含映像名与 PID）' }),
    diagnose: 'legion --sweep-orphans（**不加** --allow-unverified-sweep）',
    action: '确认报告里的映像名是自己产品的之后，再让它清理',
    ifNotHelped: '映像名对不上说明它动了别的程序——不要用 --allow-unverified-sweep，改为手工排查',
    escalate: '把 --sweep-orphans 的完整报告交给支持，注明哪几个 PID 的映像名对不上',
    worksWhenBroken: true,
    why: '孤儿进程清理是不可撤销的，所以默认只报告；这一条明确写了"什么时候不该清理"',
  }),
  Object.freeze({
    id: 'rb-runtime-degraded',
    faultClass: 'runtime',
    symptom: '界面上说产品状态不是 ready',
    observable: Object.freeze({ kind: 'state', ref: 'runtime-state 六态里的 degraded / unknown' }),
    diagnose: '打开 metrics 与 runtime-state 读六态与九个指标；dead-letter 单独看',
    action: '先看 dead-letter：有一条就说明某个任务超过重试额度了，处置它而不是重启',
    ifNotHelped: '导出诊断包；重启**不会**清掉 dead-letter，它落库了',
    escalate: '附诊断包与 dead-letter 的任务 id',
    worksWhenBroken: false,
    caveat: '这两块读数在界面可用时才看得到；界面起不来时先走 rb-install-layout 与配置那两条',
    why: 'degraded 的成因几乎总是 dead-letter，而重启是最常见也最无效的第一反应',
  }),
  Object.freeze({
    id: 'rb-runtime-stuck-task',
    faultClass: 'runtime',
    symptom: '一个任务长时间停在运行中',
    observable: Object.freeze({ kind: 'metric', ref: 'oldest-pending-age-ms 持续增大；活动租约数与 attempt 不推进' }),
    diagnose: '看 oldest-pending-age-ms 与活动租约数；确认是"没有 worker 领"还是"领了没结束"',
    action: '没有 worker 领 → 看启动波次；领了没结束 → 看该 attempt 的工作区与日志',
    ifNotHelped: '强杀之后不要手工改库：把死信与 attempt 一起留证据再升级',
    escalate: '附 attempt id、工作区路径与日志片段',
    worksWhenBroken: false,
    caveat: '需要运行面 HTTP 可用；不可用时改用 --diagnostics 拿日志',
    why: '"卡住"至少有四种成因，先分清"没被领"与"领了没结束"能省掉大半排查',
  }),
  Object.freeze({
    id: 'rb-model-unavailable',
    faultClass: 'model',
    symptom: '任务失败，说模型不可用',
    observable: Object.freeze({ kind: 'error-code', ref: 'AUTH_FAILED / SECRET_UNAVAILABLE' }),
    diagnose: '看模型档案的探测结论与分类码——**这两个码的处置完全不同**',
    action: 'AUTH_FAILED → 换密钥；SECRET_UNAVAILABLE → 补密钥库，不要怀疑密钥本身',
    ifNotHelped: '确认绑定链：主档案不可用时产品**不会**降级到备用，这是刻意的',
    escalate: '附探测分类码与模型档案 id；**不要**附密钥',
    worksWhenBroken: false,
    caveat: '模型档案页在产品可打开时才有；产品起不来时先解决启动问题',
    why: '把 AUTH_FAILED 与 SECRET_UNAVAILABLE 混为一谈会让人反复换一把好钥匙',
  }),
  Object.freeze({
    id: 'rb-model-secret-missing',
    faultClass: 'model',
    symptom: '刚配好的模型一探测就说密钥不可用',
    observable: Object.freeze({ kind: 'error-code', ref: 'SECRET_UNAVAILABLE' }),
    diagnose: '确认密钥库**不在数据目录内**，且后端不是明文',
    action: '把密钥写进产品密钥库（productHome/.secrets/），而不是产品配置或环境变量',
    ifNotHelped: '检查文件访问控制：查不出 ACL 时必须当成不安全，不能当成安全',
    escalate: '附密钥库路径与 ACL 读取结论；**不要**附密钥内容',
    worksWhenBroken: true,
    why: '"刚配好就不可用"几乎总是位置或后端问题，而不是密钥本身错了',
  }),
  Object.freeze({
    id: 'rb-budget-exceeded',
    faultClass: 'budget',
    symptom: '任务被拒绝，说预算不够',
    observable: Object.freeze({ kind: 'state', ref: '预算账本该 scope 已用额度触到上限，或存在 locked 条目' }),
    diagnose: '看预算账本的预留/结算记录与是否有 locked 条目',
    action: 'locked 条目要**人工处置**——产品不会自动裁剪，也不会自动释放未知结果',
    ifNotHelped: '上调上限之后重新提交；已有 locked 条目仍然要处置',
    escalate: '附账本里 locked 条目的 id 与对应 attempt',
    worksWhenBroken: false,
    caveat: '预算界面在产品可用时才有；不可用时从诊断包里读账本导出',
    why: 'locked 是"结果未知"，与"超支"是两件事，处置也不同',
  }),
  Object.freeze({
    id: 'rb-approval-not-appearing',
    faultClass: 'approval',
    symptom: '工具调用一直等着，界面上没有审批请求',
    observable: Object.freeze({ kind: 'metric', ref: 'tool_calls 里 pending 且 decisionSource 为空；审批可用性读数' }),
    diagnose: '看 tool_calls 的 decisionSource 与 enforcement 的可用性读数',
    action: '若应答者不可达，产品会**失败关闭**而不是等：确认它是不是被当成"还在等"了',
    ifNotHelped: '检查审批入口能否打开——不可达时不应产生"待审批"，那是线路故障不是决定',
    escalate: '附 tool_calls 行的 id 与 enforcement 可用性读数（含阶段）',
    worksWhenBroken: false,
    caveat: '需要 team-hub 可用才能读审批箱；不可用时用诊断包里的日志',
    why: '把"线路故障"读成"用户还没批"会让任务无声地永远等下去',
  }),
  Object.freeze({
    id: 'rb-approval-stuck-run',
    faultClass: 'approval',
    symptom: '改了审批策略，正在跑的任务行为没变',
    observable: Object.freeze({ kind: 'state', ref: '该 Run 的旋钮快照与现场配置不一致' }),
    diagnose: '看这个 Run 的旋钮快照与现场配置的区别',
    action: '这是**预期行为**：Run 期间生效的旋钮只来自创建时的快照',
    ifNotHelped: '要让新策略立即生效，需要结束并重开这个 Run；改写旋钮会留下审计记录',
    escalate: '附 Run id 与漂移读数（如果确实需要改）',
    worksWhenBroken: false,
    caveat: '需要运行面可读；不可用时从诊断包读快照记录',
    why: '把"Run 期间冻结"当成 bug 会让人反复改配置而看不到任何变化',
  }),
  Object.freeze({
    id: 'rb-upgrade-failed',
    faultClass: 'upgrade',
    symptom: '升级之后产品打不开，或升级过程报错',
    observable: Object.freeze({ kind: 'state', ref: '升级审计 verdict 不是 committed；活动指针的实际内容' }),
    diagnose: '看升级审计的 reachedStage 与活动指针的实际内容',
    action: '按审计里的落点处置：rolled-back 说明已退回；forward-fix-required 说明**不能**只换指针',
    ifNotHelped: '从升级前备份恢复数据库——注意它会丢掉备份之后的写入',
    escalate: '附升级审计记录与活动指针内容',
    worksWhenBroken: true,
    why: 'forward-fix-required 与 rolled-back 的下一步完全不同，混淆会丢数据',
  }),
  Object.freeze({
    id: 'rb-upgrade-rollback-data',
    faultClass: 'data',
    symptom: '恢复备份之后发现最近的改动没了',
    observable: Object.freeze({ kind: 'error-code', ref: 'upgrade-data-restored-from-backup' }),
    diagnose: '看恢复报告里的备份时刻与业务数据完整性读数',
    action: '这是设计如此：恢复到备份时刻**必然**丢掉备份之后的写入',
    ifNotHelped: '在删除任何东西之前先把当前目录整份留档，再决定要不要继续',
    escalate: '附备份时刻、恢复时刻与"备份之后有哪些写入"的说明',
    worksWhenBroken: true,
    why: '"恢复"与"不丢数据"是两个目标；把恢复当回退会让人以为数据回来了',
  }),
  Object.freeze({
    id: 'rb-data-wal-sidecar',
    faultClass: 'data',
    symptom: '恢复之后数据库里出现了"不该有"的行',
    observable: Object.freeze({ kind: 'artifact', ref: '恢复目录下残留的 -wal / -shm 文件' }),
    diagnose: '恢复完成后检查同目录下的 -wal 与 -shm 是否已被删除',
    action: '不删这两个文件等于把**两个时刻**的库合并，而且合并后的库能正常打开',
    ifNotHelped: '从备份重新恢复一次，并确认恢复报告里列出了删除的旁文件',
    escalate: '附恢复报告与目录清单',
    worksWhenBroken: true,
    why: '合并后的库能打开，所以这个错误不会以"打不开"的形式暴露',
  }),
  Object.freeze({
    id: 'rb-perf-disk',
    faultClass: 'perf',
    symptom: '磁盘越用越满',
    observable: Object.freeze({ kind: 'state', ref: '保留策略用量合计持续上升，且 unbounded 列表非空' }),
    diagnose: '看保留策略对每一类的上限读数，以及用量合计里的 unbounded 列表',
    action: '先确认**每一类**都有上限；只有一类有上限的策略会把另外两类放养',
    ifNotHelped: '检查保留策略有没有执行者——纯判据不会自己删东西',
    escalate: '附用量合计与各类上限读数',
    worksWhenBroken: true,
    why: '只对一个类做容量核算却当成总用量，会让另外两类没有上限',
  }),
  Object.freeze({
    id: 'rb-perf-slow',
    faultClass: 'perf',
    symptom: '整体变慢',
    observable: Object.freeze({ kind: 'metric', ref: 'queue-depth / active-leases / attempt-retry-rate 同时偏高' }),
    diagnose: 'legion --check --json 看体检；再看 metrics 的九项读数',
    action: '先看是不是 dead-letter 在堆积（任务反复重试会拖慢一切）',
    ifNotHelped: '用 --diagnostics=<dir> 导包；它包含队列与租约读数',
    escalate: '附诊断包；**先确认包里没有密钥**（包会自带泄漏复检结论）',
    worksWhenBroken: false,
    caveat: 'metrics 需要运行面可用；不可用时以诊断包里的日志为准',
    why: '"慢"最常见的真实成因是重试风暴，而不是资源不足',
  }),
])

export const RUNBOOK_ENTRY_IDS = Object.freeze(RUNBOOK_ENTRIES.map((e) => e.id))

/**
 * 核对一份手册能不能被支持人员真的用。
 *
 * @param {object} [deps]
 * @param {ReadonlyArray<object>} [deps.entries]
 * @param {ReadonlyArray<string>} [deps.knownFlags] 真实存在的命令行开关（默认读 `CLI_FLAGS`）
 * @param {(t: string) => ReadonlyArray<string>} [deps.extractFlags]
 * @returns {object}
 */
export function checkRunbook({ entries = RUNBOOK_ENTRIES, knownFlags = null, extractFlags = referencedFlags } = {}) {
  // ★ 默认真读 `CLI_FLAGS`——手册里提到的开关必须真的存在。
  const flags = knownFlags ?? CLI_FLAGS.map((f) => f.name)
  const flagSet = new Set(flags)
  const findings = []

  if (!Array.isArray(entries) || entries.length === 0) {
    findings.push(Object.freeze({
      code: RUNBOOK_CODES.EMPTY,
      detail: '手册里一条处置都没有——一份空手册与没有手册，在故障现场是同一个东西',
    }))
  }

  const checkable = []
  for (const e of entries) {
    // 分类必须真实
    if (!FAULT_CLASS_IDS.includes(e.faultClass)) {
      findings.push(Object.freeze({
        code: RUNBOOK_CODES.CLASS_UNKNOWN, entry: e.id, faultClass: e.faultClass,
        detail: `处置 ${e.id} 的分类 ${JSON.stringify(e.faultClass)} 不在分类表里`,
      }))
    }
    // ★ ① 可观测：**结构化**，不是一句形容词
    const obs = e.observable
    if (obs === null || typeof obs !== 'object' || typeof obs.ref !== 'string' || obs.ref.trim() === '') {
      findings.push(Object.freeze({
        code: RUNBOOK_CODES.NO_OBSERVABLE, entry: e.id,
        detail: `处置 ${e.id} 没有可观测的症状——"用户说不好用"无法被下一个遇到它的人对上号`,
      }))
    } else if (!OBSERVABLE_KINDS.includes(obs.kind)) {
      findings.push(Object.freeze({
        code: RUNBOOK_CODES.OBSERVABLE_KIND_UNKNOWN, entry: e.id, kind: obs.kind ?? null,
        detail: `处置 ${e.id} 的可观测形态 ${JSON.stringify(obs.kind ?? null)} 不在闭集里（${OBSERVABLE_KINDS.join(' / ')}）`,
      }))
    } else {
      // ★ 与**真实的退出码表**交叉核对：手册里写一个代码里没有的退出码，这里就红。
      if (obs.kind === 'exit-code') {
        const realExit = new Set(Object.values(EXIT_CODES))
        const written = [...obs.ref.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1]))
        for (const n of written) {
          if (!realExit.has(n)) {
            findings.push(Object.freeze({
              code: RUNBOOK_CODES.EXIT_CODE_UNKNOWN, entry: e.id, exitCode: n,
              detail: `处置 ${e.id} 引用了退出码 ${n}，而代码里没有这个退出码（真实值：${[...realExit].sort((a, b) => a - b).join(' / ')}）`,
            }))
          }
        }
      }
      // ★ 与**真实的具名错误码表**交叉核对：手册里写一个产品不产生的码，这里就红。
      if (obs.kind === 'error-code') {
        // 抽出所有"看起来像具名码"的片段（全大写 + 下划线）。
        for (const m of obs.ref.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) {
          if (!isKnownErrorCode(m[0])) {
            findings.push(Object.freeze({
              code: RUNBOOK_CODES.ERROR_CODE_UNKNOWN, entry: e.id, errorCode: m[0],
              detail: `处置 ${e.id} 引用了错误码 ${m[0]}，而产品的具名错误码表里没有它` +
                `（表里共 ${ERROR_CODES.length} 个）——手册会让支持人员去找一个不会出现的码`,
            }))
          }
        }
      }
      // 码与读数必须真的是个标识符，否则它还是一句形容词。
      if (obs.kind === 'error-code' || obs.kind === 'metric') {
        const hasIdent = /([A-Z][A-Z0-9_]{3,})|([a-z][a-z0-9]*(?:[-_][a-z0-9]+)+)/.test(obs.ref)
        if (!hasIdent) {
          findings.push(Object.freeze({
            code: RUNBOOK_CODES.OBSERVABLE_NOT_AN_IDENTIFIER, entry: e.id, kind: obs.kind,
            detail: `处置 ${e.id} 声明可观测形态是 ${obs.kind}，但 ${JSON.stringify(obs.ref)} 里没有一个标识符（码名或字段名）——那它还是一句形容词`,
          }))
        }
      }
    }
    // 说得出为什么需要这一条
    if (typeof e.why !== 'string' || e.why === '') {
      findings.push(Object.freeze({
        code: RUNBOOK_CODES.UNJUSTIFIED, entry: e.id,
        detail: `处置 ${e.id} 没有说明为什么需要它——一条说不出理由的处置会被下一个人合并掉`,
      }))
    }
    // ★ ② 死胡同
    if (typeof e.ifNotHelped !== 'string' || e.ifNotHelped.trim() === '') {
      findings.push(Object.freeze({
        code: RUNBOOK_CODES.DEAD_END, entry: e.id,
        detail: `处置 ${e.id} 没有"这步没用怎么办"——照着做完仍然卡住的人此时比没有手册时更困惑`,
      }))
    }
    // ★ ③ 升级路径
    if (typeof e.escalate !== 'string' || e.escalate.trim() === '') {
      findings.push(Object.freeze({
        code: RUNBOOK_CODES.NO_ESCALATION, entry: e.id,
        detail: `处置 ${e.id} 没说交给谁、交什么`,
      }))
    }
    // ★ ④ 坏掉时不可用就必须声明
    if (e.worksWhenBroken !== true && (typeof e.caveat !== 'string' || e.caveat.trim() === '')) {
      findings.push(Object.freeze({
        code: RUNBOOK_CODES.BROKEN_CAVEAT_MISSING, entry: e.id,
        detail: `处置 ${e.id} 声明在产品坏掉时不可用，却没写"那时候先做什么"——` +
          '而最需要它的时候正是产品坏掉的时候',
      }))
    }
    // ★ ⑤ 引用的开关必须真实存在（占位符写法要能匹配实际写法）。
    for (const field of ['diagnose', 'action', 'ifNotHelped', 'escalate']) {
      for (const f of extractFlags(e[field])) {
        if (matchFlag(f, flags) === null) {
          findings.push(Object.freeze({
            code: RUNBOOK_CODES.UNKNOWN_FLAG, entry: e.id, field, flag: f,
            detail: `处置 ${e.id} 的 ${field} 引用了不存在的开关 ${f}——` +
              '支持人员会在客户现场才发现这一行是假的',
          }))
        }
      }
    }
    checkable.push(e)
  }

  // ★ ⑥ 每一类都要有处置，且要有**自己特有**的。
  const byClass = {}
  for (const id of FAULT_CLASS_IDS) byClass[id] = checkable.filter((e) => e.faultClass === id)
  for (const id of FAULT_CLASS_IDS) {
    if (byClass[id].length === 0) {
      findings.push(Object.freeze({
        code: RUNBOOK_CODES.CLASS_UNCOVERED, faultClass: id,
        detail: `故障分类 ${id} 一条处置都没有`,
      }))
      continue
    }
    // "自己特有" = 它的 (symptom, action) 组合不在别的分类里出现过。
    const mine = new Set(byClass[id].map((e) => `${e.symptom}|${e.action}`))
    const others = new Set(
      FAULT_CLASS_IDS.filter((x) => x !== id)
        .flatMap((x) => byClass[x].map((e) => `${e.symptom}|${e.action}`)),
    )
    const distinctive = [...mine].filter((k) => !others.has(k))
    if (distinctive.length === 0) {
      findings.push(Object.freeze({
        code: RUNBOOK_CODES.CLASS_NOT_DISTINCTIVE, faultClass: id,
        detail: `分类 ${id} 的处置与别的分类完全重复——` +
          '十条处置都写"导包并联系支持"，等于只有一条处置',
      }))
    }
  }

  return Object.freeze({
    version: RUNBOOK_VERSION,
    entryCount: checkable.length,
    flags: Object.freeze([...flags]),
    exitCodes: Object.freeze({ ...EXIT_CODES }),
    byClass: Object.freeze(Object.fromEntries(FAULT_CLASS_IDS.map((id) => [id, byClass[id].length]))),
    classesCovered: Object.freeze(FAULT_CLASS_IDS.filter((id) => byClass[id].length > 0)),
    findings: Object.freeze(findings),
    ok: findings.length === 0,
  })
}

/**
 * 渲染成人看的手册。
 */
export function renderRunbook(report = checkRunbook(), { entries = RUNBOOK_ENTRIES } = {}) {
  const lines = []
  lines.push(`支持诊断与故障处置手册　${report.version}`)
  lines.push(`处置 ${report.entryCount} 条，覆盖 ${report.classesCovered.length}/${FAULT_CLASS_IDS.length} 类故障`)
  lines.push('')
  for (const cls of FAULT_CLASSES) {
    const items = entries.filter((e) => e.faultClass === cls.id)
    if (items.length === 0) continue
    lines.push(`【${cls.label}】`)
    for (const e of items) {
      lines.push(`  · ${e.symptom}`)
      lines.push(`      怎么认：${e.observable.kind} — ${e.observable.ref}`)
      lines.push(`      查一下：${e.diagnose}`)
      lines.push(`      怎么做：${e.action}`)
      lines.push(`      没用的话：${e.ifNotHelped}`)
      lines.push(`      找支持：${e.escalate}`)
      if (e.worksWhenBroken !== true) lines.push(`      ⚠️ ${e.caveat}`)
    }
    lines.push('')
  }
  if (report.findings.length > 0) {
    lines.push('⚠️ 这份手册自身有问题：')
    for (const f of report.findings) lines.push(`  [${f.code}] ${f.detail}`)
  } else {
    lines.push('✔ 每条处置都引用了真实存在的开关，且都有"没用怎么办"与升级路径。')
  }
  return lines.join('\n')
}

/**
 * 造一个**按构造**不在 `knownFlags` 里的开关名。
 *
 * 自检需要一个"引用了不存在的开关"的条目来证明检查器咬得住。那个名字**不能**
 * 写成字面量：产品随时可能真的加上它，而那一刻这条自检的前提就无声地失效了
 * ——`--doctor` 已经这么发生过一次（PRT-257 把它加成了真开关，于是
 * "抓住假开关"这条自检开始报自己没问题、而用例报红）。
 *
 *   > 一个"用真实名字当假数据"的夹具，
 *   > 与一个"永远为真"的夹具，在被观察到的那一天之前是同一个东西。
 *
 * 做法：从一个显然不是开关的基名开始，**核对**它不在表里；在就接一段再核。
 * 于是返回值与表的关系是"核对过"的，不是"但愿如此"。
 *
 * @param {ReadonlyArray<string>} knownFlags
 * @returns {string} 一个保证不在 `knownFlags` 里的开关名
 */
export function uniqueUnknownFlag(knownFlags = []) {
  let candidate = '--ghost-flag-for-runbook-selfcheck'
  const has = (x) => knownFlags.some((f) => String(f).split('=')[0] === x)
  while (has(candidate)) candidate += '-x'
  return candidate
}

/**
 * 装载期自检：把六条核心判据各真的跑一遍，留下算出来的值。
 */
function auditRunbook() {
  const problems = []
  const exists = () => true
  const mkEntry = (patch = {}) => ({
    id: 'probe', faultClass: 'install', symptom: '症状', observable: Object.freeze({ kind: 'exit-code', ref: '3 (layout)' }),
    diagnose: 'legion --check --json', action: '做点什么', ifNotHelped: '再做点别的',
    escalate: '找支持', worksWhenBroken: true, why: '因为要探', ...patch,
  })
  // 覆盖全部分类的一组"好"条目，否则分类覆盖会掩盖单条缺陷。
  const allClasses = () => FAULT_CLASS_IDS.map((id, i) => mkEntry({
    id: `p${i}`, faultClass: id, symptom: `症状 ${id}`, action: `动作 ${id}`,
  }))

  // ① ★ 引用不存在的开关必须被抓住（本模块存在的理由）。
  //
  // ★★ 那个"不存在的开关"必须**按构造**不存在，不能写一个"现在恰好不存在"的字面量。
  //
  //   这条自检原来写的是 `legion --doctor`，而 `--doctor` 当时确实不在开关表里。
  //   后来 PRT-257 给 CLI **加上了** `--doctor`——于是这条自检的**前提**（"这是个
  //   假开关"）无声地失效了：检查器现在正确地认为它存在，而这条断言期望它被抓住。
  //
  //     > 一个"用真实名字当假数据"的夹具，
  //     > 与一个"永远为真"的夹具，在被观察的那一天之前是同一个东西——
  //     > 只不过前者的绿是**开关表当时没有那个名字**换来的。
  //
  //   用一个不可能撞上的名字（连字符重复 + "ghost" 前缀）是必要的，但还不够：
  //   真正的保证是**事后核对**它确实不在表里，不在就往下接一段。
  const ghostFlag = uniqueUnknownFlag(['--check'])
  const ghost = checkRunbook({ entries: [mkEntry({ diagnose: `legion ${ghostFlag}` })], knownFlags: ['--check'] })
  if (!ghost.findings.some((f) => f.code === RUNBOOK_CODES.UNKNOWN_FLAG)) {
    problems.push('引用不存在的开关没有被抓住——支持人员会在客户现场才发现手册是假的')
  }
  // 反向控制：把开关改对，那条 finding 必须消失。
  const fixed = checkRunbook({ entries: [mkEntry({ diagnose: 'legion --check --json' })], knownFlags: ['--check', '--json'] })
  if (fixed.findings.some((f) => f.code === RUNBOOK_CODES.UNKNOWN_FLAG)) {
    problems.push('修好后的引用仍报未知开关——那条判据是无差别报警')
  }
  // ② 不可观测的症状
  const vague = checkRunbook({ entries: [mkEntry({ observable: Object.freeze({ kind: 'exit-code', ref: '  ' }) })], knownFlags: ['--check', '--json'] })
  if (!vague.findings.some((f) => f.code === RUNBOOK_CODES.NO_OBSERVABLE)) problems.push('不可观测的症状没有被抓住')
  // ③ 死胡同
  const dead = checkRunbook({ entries: [mkEntry({ ifNotHelped: '' })], knownFlags: ['--check', '--json'] })
  if (!dead.findings.some((f) => f.code === RUNBOOK_CODES.DEAD_END)) problems.push('死胡同没有被抓住')
  // ④ 坏掉时不可用却没 caveat
  const noCaveat = checkRunbook({
    entries: [mkEntry({ worksWhenBroken: false })], knownFlags: ['--check', '--json'],
  })
  if (!noCaveat.findings.some((f) => f.code === RUNBOOK_CODES.BROKEN_CAVEAT_MISSING)) {
    problems.push('声明坏掉时不可用却没写先做什么，没有被抓住')
  }
  // ⑤ 空手册
  const empty = checkRunbook({ entries: [], knownFlags: [] })
  if (!empty.findings.some((f) => f.code === RUNBOOK_CODES.EMPTY)) problems.push('空手册没有被抓住')
  // ⑥ ★★ 与真实退出码表交叉核对：写一个不存在的退出码必须被抓住。
  const badExit = checkRunbook({
    entries: [mkEntry({ observable: Object.freeze({ kind: 'exit-code', ref: '99 (不存在)' }) })],
    knownFlags: ['--check', '--json'],
  })
  if (!badExit.findings.some((f) => f.code === RUNBOOK_CODES.EXIT_CODE_UNKNOWN)) {
    problems.push('引用了不存在的退出码没有被抓住——手册与代码会各说各的')
  }
  // 反向控制：真实的退出码必须放行（否则是无差别报警）。
  const goodExit = checkRunbook({
    entries: [mkEntry({ observable: Object.freeze({ kind: 'exit-code', ref: '3 (layout) / 7 (init)' }) })],
    knownFlags: ['--check', '--json'],
  })
  if (goodExit.findings.some((f) => f.code === RUNBOOK_CODES.EXIT_CODE_UNKNOWN)) {
    problems.push('真实退出码被判成不存在——那条判据是无差别报警')
  }
  // ⑦ 声明是码/读数，却给了一句形容词 —— 必须被抓住。
  const wordy = checkRunbook({
    entries: [mkEntry({ observable: Object.freeze({ kind: 'metric', ref: '感觉有点慢' }) })],
    knownFlags: ['--check', '--json'],
  })
  if (!wordy.findings.some((f) => f.code === RUNBOOK_CODES.OBSERVABLE_NOT_AN_IDENTIFIER)) {
    problems.push('"感觉有点慢"被当成了可观测的读数')
  }

  // ⑧ ★★ 错误码交叉核对：写一个产品不产生的码必须被抓住。
  const badErrCode = checkRunbook({
    entries: [mkEntry({ observable: Object.freeze({ kind: 'error-code', ref: ['NOT', 'A', 'REAL', 'CODE'].join('_') }) })],
    knownFlags: ['--check', '--json'],
  })
  if (!badErrCode.findings.some((f) => f.code === RUNBOOK_CODES.ERROR_CODE_UNKNOWN)) {
    problems.push('引用产品不产生的错误码没有被抓住——手册会让支持人员去找一个不会出现的码')
  }
  // 反向控制：真实的错误码必须放行（否则是无差别报警）。
  const goodErrCode = checkRunbook({
    entries: [mkEntry({ observable: Object.freeze({ kind: 'error-code', ref: 'SECRET_UNAVAILABLE' }) })],
    knownFlags: ['--check', '--json'],
  })
  if (goodErrCode.findings.some((f) => f.code === RUNBOOK_CODES.ERROR_CODE_UNKNOWN)) {
    problems.push('真实错误码被判成不存在——那条判据是无差别报警')
  }

  // ⑧ 分类不可区分：全都重复
  const dup = checkRunbook({
    entries: FAULT_CLASS_IDS.map((id, i) => mkEntry({ id: `d${i}`, faultClass: id, symptom: '都一样', action: '都一样' })),
    knownFlags: ['--check', '--json'],
  })
  if (!dup.findings.some((f) => f.code === RUNBOOK_CODES.CLASS_NOT_DISTINCTIVE)) {
    problems.push('所有分类的处置完全重复，没有被抓住——那等于只有一条处置')
  }

  // ⑦ ★★ 真实手册必须过：**所有的开关都真的存在**。
  //    这一条是本模块的核心价值——CLI 一改，这里就红。
  const real = checkRunbook()
  if (!real.ok) {
    problems.push(`真实手册有问题：${real.findings.map((f) => `${f.code}(${f.entry ?? f.faultClass ?? ''})`).join(', ')}`)
  }

  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    version: RUNBOOK_VERSION,
    // 留下的都是**算出来的值**，不是布尔。
    checkedFlags: Object.freeze(CLI_FLAGS.map((f) => f.name)),
    faultClasses: FAULT_CLASS_IDS,
    samples: Object.freeze({
      ghostFlagCaught: ghost.findings.filter((f) => f.code === RUNBOOK_CODES.UNKNOWN_FLAG).map((f) => f.flag),
    // 那个"按构造不存在"的开关名本身也留出来：用例要能核对
    // "被抓住的正是我造的那一个"，而不是又去硬编一个字面量。
    ghostFlag,
      fixedFlagClean: !fixed.findings.some((f) => f.code === RUNBOOK_CODES.UNKNOWN_FLAG),
      vagueCaught: vague.findings.map((f) => f.code),
      deadEndCaught: dead.findings.map((f) => f.code),
      noCaveatCaught: noCaveat.findings.map((f) => f.code),
      duplicateClassCaught: dup.findings.filter((f) => f.code === RUNBOOK_CODES.CLASS_NOT_DISTINCTIVE).length,
      badExitCaught: badExit.findings.filter((f) => f.code === RUNBOOK_CODES.EXIT_CODE_UNKNOWN).map((f) => f.exitCode),
      goodExitClean: !goodExit.findings.some((f) => f.code === RUNBOOK_CODES.EXIT_CODE_UNKNOWN),
      wordyCaught: wordy.findings.map((f) => f.code),
      observableKindsUsed: [...new Set(RUNBOOK_ENTRIES.map((e) => e.observable.kind))].sort(),
      // 与 EXIT_CODES 交叉核对过的真实退出码集合。
      realExitCodes: [...new Set(Object.values(EXIT_CODES))].sort((a, b) => a - b),
      badErrorCodeCaught: badErrCode.findings.filter((f) => f.code === RUNBOOK_CODES.ERROR_CODE_UNKNOWN).map((f) => f.errorCode),
      goodErrorCodeClean: !goodErrCode.findings.some((f) => f.code === RUNBOOK_CODES.ERROR_CODE_UNKNOWN),
      // 与真实具名错误码表交叉核对过的码集合（来自代码，不是抄的）。
      realErrorCodes: Object.freeze([...ERROR_CODES]),
      errorCodesReferenced: RUNBOOK_ENTRIES
        .filter((e) => e.observable.kind === 'error-code')
        .flatMap((e) => [...e.observable.ref.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)].map((m) => m[0])),
      realEntryCount: real.entryCount,
      realClassesCovered: real.classesCovered,
      realOk: real.ok,
      // 真实手册里"坏掉时仍可用"的处置占比——这是一个有意义的健康读数。
      worksWhenBrokenCount: RUNBOOK_ENTRIES.filter((e) => e.worksWhenBroken === true).length,
    }),
  })
}

export const RUNBOOK_CHECKED = auditRunbook()
