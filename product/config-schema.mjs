// product/config-schema.mjs — 产品层（Launcher 与目录布局）的配置声明（PRT-251）
//
// 与 `services-plugin/config-schema.mjs` 的关系是**替代关系**，且方向相反：
//
//   services-plugin：把 `{ ...process.env }` 整份交给子进程，然后**覆盖**少数几项。
//                    它声明的是「我注入了什么」，因为「我没注入什么」无法声明。
//   product（本文件）：把子进程的环境限制成**白名单**（见 product/launcher/allowlist.mjs），
//                    因此「子进程拿到什么」是一个有限、可枚举、可审阅的集合。
//
// 本 schema 声明三类事实：
//   ① Launcher **读取**的 env（LEGION_* 目录布局七项 + 就绪超时）；
//   ② Launcher **注入**各子进程的 env 与 CLI（含**派生**值：workbench 的 hub 上游）；
//   ③ 子进程**从进程环境读取**的键名（`childEnvNames`）——
//      它们是注入目标的变量名，不是本进程的读取点，必须显式排除，
//      否则 `scan --check` 会把它们当成未声明读取点。
import { defineSchema } from '../packages/shared/src/config.mjs'

/** 目录布局七项（spec §6.11 的「受控环境变量」层）。 */
export const LAYOUT_ENV_NAMES = Object.freeze([
  'LEGION_HOME',
  'LEGION_INSTALL_DIR',
  'LEGION_DATA_DIR',
  'LEGION_WORKSPACE_DIR',
  'LEGION_CACHE_DIR',
  'LEGION_LOG_DIR',
  'LEGION_PRODUCT_CONFIG',
  'LEGION_SECRETS_FILE',
])

/** Launcher 自己的可调项。 */
export const LAUNCHER_ENV_NAMES = Object.freeze(['LEGION_READINESS_TIMEOUT_MS'])

/**
 * 子进程**从环境读取**的键名（`product/process-manifest.mjs` 的 `envNames` 并集）。
 * 它们是「注入目标的变量名」，对本进程而言只是字符串字面量。
 */
export const CHILD_ENV_NAMES = Object.freeze([
  'TEAM_HUB_PORT', 'TEAM_HUB_HOST', 'TEAM_HUB_TOKEN', 'TEAM_HUB_DB', 'TEAM_HUB_URL',
  'DSH_HUB_UPSTREAM', 'DSH_WORKBENCH_TOKEN',
  'DSH_HOME', 'LEGION_DATA_DIR', 'LEGION_LOG_DIR',
  'WHITEBOARD_TOKEN', 'PORT', 'HOST', 'DB_PATH', 'WB_ROOMS_DIR', 'WB_AUDIT_DIR', 'WB_IN_MEMORY',
])

/** Launcher 从环境读取、但**不属于**产品配置面的键（操作系统必需键，见 allowlist.mjs）。 */
export const OS_ONLY_ENV_NAMES = Object.freeze([
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  'OS', 'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'CommonProgramFiles', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH',
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'SHELL', 'TERM',
  'NODE_OPTIONS', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS',
])

export const SCHEMA = defineSchema({
  process: 'product',
  title: 'Legion 产品层（Launcher：进程清单、白名单注入、就绪判据、监督与退避）',
  prefixes: [],
  fields: [
    {
      key: 'home', env: 'LEGION_HOME', type: 'path', default: '',
      doc: '产品主目录（安装/数据/缓存/日志的默认父目录）。优先级：本环境变量 > 调用方显式传入 > 平台默认（~/.legion）',
    },
    {
      key: 'installDir', env: 'LEGION_INSTALL_DIR', type: 'path', default: '',
      doc: '安装目录（只读；升级时被整体替换）。**任何写入都不允许落在它内部**',
    },
    {
      key: 'dataDir', env: 'LEGION_DATA_DIR', type: 'path', default: '',
      doc: '数据目录（SQLite、房间、审计、密钥库元数据）。缺省 <LEGION_HOME>/data',
    },
    {
      key: 'workspaceDir', env: 'LEGION_WORKSPACE_DIR', type: 'path', default: '',
      doc: '用户工作区（Launcher 不创建默认值：工作区是用户授权的项目目录，不是产品自留地）',
    },
    {
      key: 'cacheDir', env: 'LEGION_CACHE_DIR', type: 'path', default: '',
      doc: '缓存目录（可安全删除）。缺省 <LEGION_HOME>/cache',
    },
    {
      key: 'logDir', env: 'LEGION_LOG_DIR', type: 'path', default: '',
      doc: '日志目录。缺省 <LEGION_HOME>/log',
    },
    {
      key: 'productConfigPath', env: 'LEGION_PRODUCT_CONFIG', type: 'path', default: '',
      doc: '产品配置文件路径。缺省 <DataDir>/product.config.json',
    },
    {
      key: 'secretsFile', env: 'LEGION_SECRETS_FILE', type: 'path', default: '',
      doc: '受保护密钥库文件路径（DPAPI 保护，机器与账户绑定）。' +
        '缺省 <LEGION_HOME>/secrets/credentials.json——**刻意不在 DataDir 内**：' +
        '数据目录是备份、恢复与诊断包导出的对象，密钥库落在里面会被任何「打包 DataDir」的操作顺手带走',
    },
    {
      key: 'readinessTimeoutMs', env: 'LEGION_READINESS_TIMEOUT_MS', type: 'int', default: 30000, min: 1,
      doc: '单进程就绪判据超时（ms）。判据本身在进程清单里，这里只覆盖超时',
    },
  ],
  // 子进程的 env 键名 + 平台必需键名：都是「变量名」，不是本进程的读取点。
  // 不显式列出的话 `scan --check` 会要求把它们登记为读取点（P3-4 遇到过同类问题）。
  //
  // ── OS 家目录事实（PRT-255）────────────────────────────────────────
  //
  // `product/launcher/cli.mjs` 的 `osHomeFacts()` 读这三个变量来推出
  // 「产品家目录在哪」。它们**属于操作系统/用户会话**，不属于 Legion：
  // 产品只是读它们，不定义它们，也不该把它们当自己的配置项。
  //
  // 为什么必须读：`resolveLayout` 的 `homeDir`/`appDataDir` 两个入参原先
  // **没有任何生产调用方传过**，于是产品家目录恒为 null、`secretsFile` 恒为 null，
  // 每一次启动都被 `SECRETS_PLACEMENT_INVALID` 拒绝——用文档上的开关装完之后
  // 产品根本起不来。PRT-255 的隔离空间验证抓到了这一条。
  foreignEnv: [
    { name: 'LOCALAPPDATA', owner: '操作系统（Windows）', reason: 'Windows 上 %LOCALAPPDATA%\\Legion 是产品家目录的默认位置；读它才能在不设 LEGION_HOME 时定出家目录' },
    { name: 'USERPROFILE', owner: '操作系统（Windows）', reason: '没有 %LOCALAPPDATA% 时用它推出 AppData\\Local；仅作为回退' },
    { name: 'HOME', owner: '操作系统（POSIX）', reason: 'POSIX 上 ~/.legion 是产品家目录的默认位置；名称与其他进程共用，故逐个登记' },
  ],
  nonEnvLiterals: [

    // ── PRT-257 DSH 强制面覆盖层的诊断码 ────────────────────────────────
    //
    // 它们是 `product/launcher/dsh-overlay.mjs` 的 `DSH_OVERLAY_CODES` 的值，
    // 不是配置键：进程不"读"它们，而是把它们放进诊断给用户看。
    //
    // ★ 与 PRT-907 那两个不同，这一组**没有**第二道交叉核对
    //   （runbook 那种"登记表里的码还存不存在"的检查）。所以它们只能靠这里，
    //   而"漏登记"正是 scan 存在的唯一理由——这四条是被 scan 抓出来的，
    //   不是我事先想到的。
    'DSH_OVERLAY_PATCH_FILE_MISSING',
    'DSH_OVERLAY_PATCH_FILE_NOT_A_FILE',
    'DSH_OVERLAY_NO_INSTALL_DIR',
    'DSH_OVERLAY_DISABLED_BY_CONFIG',

    // ── PRT-707 首次运行向导**接线层**的诊断码 ──────────────────────────
    //
    // `product/launcher/first-run.mjs` 的 `FIRST_RUN_CODES` 的值。名字是
    // SCREAMING_SNAKE，所以 scan 会怀疑它们是环境变量——它们不是：
    // 进程不"读"它们，而是把它们放进诊断给用户看。
    //
    // ★ 这里**只有四条**，而第一版我写了八条。被 scan 抓出来之后去数了一遍
    //   引用：另外四条（`NO_LAYOUT`/`NO_HUB`/`BAD_MODEL_INPUT`/
    //   `NO_ENVIRONMENT_PROBE`）**一次都没被引用过**——前提不成立走的是
    //   `firstRunPreconditions` 的 `key`，输入非法走的是 `message`。
    //   处置是**删掉那四条**，不是把它们也登记进来：
    //   一个导出但永远不会产生的码，与"这条路径已经覆盖了"的宣告，
    //   在读代码时是同一个东西——只不过运维会照着它去 grep，然后什么也找不到。
    'FIRST_RUN_SECRETS_UNAVAILABLE',
    'FIRST_RUN_SECRET_WRITE_FAILED',
    'FIRST_RUN_PROFILE_WRITE_FAILED',
    'FIRST_RUN_BINDING_WRITE_FAILED',

    // ★ PRT-402 的那 8 个码**不在这里**——它们在 `team-hub/config-schema.mjs`。
    //   第一版我按"是诊断码就放这儿"的思路加进来了，scan 当场报同样 8 项未处理：
    //
    //   > 一个"把所有诊断码都堆在同一个 schema 里"的登记方式，
    //   > 与一个"按进程分开放"的登记方式，在只有一个进程的时候是同一个东西——
    //   > 只不过前者会让一条 `team-hub` 的码看起来像 `product` 读的配置，
    //   > 而 scan 的整条判据正是"这个字面量属于**哪个进程**"。
    //
    //   码住在哪个目录，就登记在哪个进程的 schema 里。

    // ── PRT-907 支持手册引用的**具名错误码** ────────────────────────────
    //
    // `product/support/runbook.mjs` 的手册正文里引用了这两个错误码，用来把
    // "钥匙不对"（AUTH_FAILED）与"本机取不到钥匙"（SECRET_UNAVAILABLE）分开——
    // spec §6.7 第 423 行明确要求两者不得混为一类，手册的处置也完全不同。
    //
    // 它们是 `runtime/contracts/errors.mjs` 里的**具名错误码**，不是本进程的配置键，
    // 所以列在这里而不是 `fields`。★ 而且 runbook.mjs 在**装载期**拿这两个字面量去
    // 与 `ERROR_CODES` 交叉核对（`isKnownErrorCode`）——`scan` 抓的是"有没有登记"，
    // runbook 抓的是"登的码还存不存在"，两者互补：漏登记这里红，码被删掉 runbook 红。
    'AUTH_FAILED',
    'SECRET_UNAVAILABLE',

    // ── PRT-709 日志轮转与磁盘保护 ──────────────────────────────────────
    //
    // 下面是**诊断码**，不是配置键：它们出现在 `LOG_CODES` / `SINK_CODES`、
    // 轮转的 note、以及 launcher `logStatus()` 收上来的诊断里。
    // 进程不"读"它们，所以列在这里而不是 `fields`。
    'LOG_BAD_POLICY',
    'LOG_ROTATE_FILE_IN_USE',
    'LOG_ROTATE_FAILED',
    'LOG_PRUNE_FAILED',
    'LOG_STILL_OVER_BUDGET',
    'LOG_DISK_PRESSURE',
    'LOG_UNREADABLE',
    'LOG_SINK_WRITE_FAILED',
    'LOG_SINK_REDACT_FAILED',
    'LOG_SINK_LINE_TOO_LONG',
    'LOG_SINK_BAD_POLICY',
    'LOG_SINK_UNAVAILABLE',

    // ── PRT-705 孤儿进程清理 ────────────────────────────────────────────
    //
    // 同样都是诊断码，不是配置键。`RUN_RECORD_*` 描述"记录本身出了什么事"，
    // `ORPHANS_FOUND` / `PID_RECYCLED` / `SWEEP_*` 描述"判成了什么、动手了没有"。
    'RUN_RECORD_UNREADABLE',
    'RUN_RECORD_CORRUPT',
    'RUN_RECORD_WRITE_FAILED',
    'ORPHANS_FOUND',
    'PID_RECYCLED',
    'SWEEP_REFUSED',
    'SWEEP_FAILED',
    // 分类结论。它们既是 `orphanStatus()` 的输出值，也出现在诊断文案里。
    'verified',
    'recycled',
    'unknown',
    // 拒绝清理的两个理由
    'pid-recycled',
    'identity-unknown',
    // 探针里用到的系统命令与 CSV 解析（非 Windows 分支）
    'tasklist',
    'ps',
    // 进程探针比较的错误码：`ESRCH` = 不在了；其余（含 `EPERM`）算"在"
    'ESRCH',
    'EPERM',

    // ── PRT-711 Runtime 状态 → 产品状态 → Orchestrator 行为 ──────────────
    //
    // `RUNTIME_STATES` 的六个值同时也是 `productStateOf` 的输出与界面文案的键，
    // 所以它们既是状态名也是字面量。前四个已经在别处出现过，这里补齐后两个
    // 与三档认领范围——它们会被写进状态文件与界面。
    'incompatible',
    'upgrading',
    'required-capabilities-only',
    'recovery-judgement',
    'drain',
    'unchanged',

    // ── PRT-712 系统指标 ────────────────────────────────────────────────
    //
    // 九个指标键（spec §6.6 的顺序）、三种"读不出来"的原因码、
    // 以及类别值（升级结果）与仪表盘的显示占位符。
    // 那个占位符也是一个字面量：它出现在界面与导出里，不是随手打的字符。
    'metric-no-data',
    'metric-read-failed',
    'metric-not-applicable',
    'metric-no-observations',
    'metric-bad-window',
    'queue-depth',
    'oldest-pending-age-ms',
    'active-leases',
    'lease-expiry-rate',
    'attempt-retry-rate',
    'dead-letter-count',
    'runtime-availability',
    'model-error-rate',
    'upgrade-result',
    'rolled-back',
    'never-run',
    'queue-empty',
    '—',

    // ── PRT-713 健康心跳 ────────────────────────────────────────────────
    //
    // 六个诊断码（关闭 / 没端点 / 策略不合法 / 代际不符 / 没同意 /
    // 端点非法 / 发送失败——发送失败与端点非法各算一条）、
    // 协议版本号，以及一条历史上被手动传入的同意者标识。
    'HEARTBEAT_SEND_FAILED',
    'HEARTBEAT_DISABLED',
    'HEARTBEAT_NO_ENDPOINT',
    'HEARTBEAT_BAD_POLICY',
    'HEARTBEAT_DROPPED_GENERATION',
    'HEARTBEAT_NOT_OPTED_IN',
    'HEARTBEAT_INVALID_ENDPOINT',
    'HEARTBEAT_PAYLOAD_REJECTED',
    'HEARTBEAT_STOPPED',
    'legion/heartbeat@1',
    'already-running',
    'user',
    'win32',
    'darwin',
    'linux',
    'freebsd',
    'openbsd',
    'sunos',
    'aix',

    // ── PRT-707 首次运行向导 ────────────────────────────────────────────
    //
    // 八个诊断码 + 进度文件名 + 进度格式版本号 + 六个步骤 id。
    // 步骤 id 同时是界面上的锚点与进度文件里的值，所以它们也是字面量。
    'WIZARD_STEP_FAILED',
    'WIZARD_NEEDS_INPUT',
    'WIZARD_PRECONDITION_UNMET',
    'WIZARD_ALREADY_DONE',
    'WIZARD_BAD_INPUT',
    'WIZARD_NOT_OBSERVED',
    'WIZARD_STATE_UNREADABLE',
    'WIZARD_STATE_WRITE_FAILED',
    'WIZARD_UNKNOWN_STEP',
    'first-run-wizard.json',
    'legion/first-run-wizard@1',
    'configure-model',
    'environment',
    'initialize',
    'automatic',
    'no-state-file',
    'done',

    // ── PRT-708 系统托盘 ────────────────────────────────────────────────
    //
    // 八个诊断码 + 五个动作 id + `status` 这个动作名。
    // 动作 id 同时是菜单的键与界面上的锚点，所以它们也是字面量。
    'TRAY_UNKNOWN_ACTION',
    'TRAY_ACTION_FAILED',
    'TRAY_QUIT_UNCONFIRMED',
    'TRAY_WORKBENCH_NOT_READY',
    'TRAY_OBSERVE_FAILED',
    'TRAY_OPEN_FAILED',
    'TRAY_BUSY',
    'TRAY_NOT_SUPPORTED',
    'open-workbench',
    'status',
    'start',
    'stop',
    'quit',
    'degraded',
    'upgrading',
    'starting',
    'ready',
    'unavailable',
    // 轮转 note 的具名码（不是 `LOG_CODES` 的成员，但同样只用于说明）
    'FOREIGN_FILES',
    'PROTECTED_GEN1',
    'FREE_SPACE_UNKNOWN',
    // `ETXTBSY` 是 `isInUseError` 判定"文件被占着"时比较的错误码之一
    // （Windows 上是 EPERM/EBUSY，POSIX 上可能是 ETXTBSY）。
    'ETXTBSY',

    // PRT-710 脱敏诊断包（product/diagnostics/redact-package.mjs）的具名码：
    //   DIAG_NO_LAYOUT     — 布局/目标目录未给出。**不猜默认位置**：
    //                        诊断包会离开这台机器，写到哪里必须由调用方决定；
    //   DIAG_PACKAGE_EXISTS— 目标目录已存在，**不覆盖**（诊断包的价值在于它是当时的证据）；
    //   DIAG_LEAK_DETECTED — 落盘后复检发现残留密钥，包已**作废并删除**；
    //   DIAG_WRITE_FAILED  — 写不进 / 无法读回复检；
    //   DIAG_EMPTY_PACKAGE — 一个候选都没有：空包与"没什么好收的"长得一样，
    //                        所以不生成空包而是如实报错。
    'DIAG_NO_LAYOUT', 'DIAG_PACKAGE_EXISTS', 'DIAG_LEAK_DETECTED',
    'DIAG_WRITE_FAILED', 'DIAG_EMPTY_PACKAGE',
    // PRT-710 收尾：**启动失败时自动出诊断包**
    // （product/diagnostics/auto-export.mjs）的具名码。
    // 与上面那组一样是**输出**用的码，不是配置键：
    //   AUTO_NO_BASE_DIR    — 布局里没有产品家目录，**不猜**位置；
    //   AUTO_DISABLED       — 显式关掉了（`--no-auto-diagnostics`）；
    //   AUTO_BASE_DIR_FAILED— 读不到 `diagnostics/` 目录。
    //                         与"目录是空的"必须分开：后者会静默跳过清理，
    //                         于是一个塞满的目录永远不被收缩；
    //   AUTO_EXPORT_FAILED  — 导出本身失败（含"导出抛错"）。
    //                         调用方必须**原样保留**启动失败的原因，
    //                         不能把它换成这条。
    'AUTO_NO_BASE_DIR', 'AUTO_DISABLED', 'AUTO_BASE_DIR_FAILED', 'AUTO_EXPORT_FAILED',
    // PRT-713 收尾：**同意记录**（product/heartbeat-consent.mjs）的具名码。
    // 同样是**输出**用的码。它们要分开的原因是本条任务的要点：
    // 从未同意 / 撤回了 / 读不出来 / 不合法，**四种处置完全不同**
    // （要问用户 / 记着别烦他 / 查记录损坏 / 查记录格式）。
    'CONSENT_NEVER', 'CONSENT_REVOKED', 'CONSENT_UNREADABLE', 'CONSENT_INVALID',
    // 撤回也要署名：一条没有署名的撤回，与一次误删文件在记录上无法区分。
    'CONSENT_NEEDS_WHO',
    // PRT-713 收尾：**心跳接线**（product/launcher/heartbeat-wiring.mjs）的具名码。
    // DISABLED 是默认路径（**不是错误**），其余每一条都对应一种
    // "配置说开着、但它其实没发出去"的具体原因——必须能被区分出来，
    // 否则用户只会看到"心跳开着却没动静"。
    'HEARTBEAT_WIRING_DISABLED', 'HEARTBEAT_WIRING_NO_CONSENT',
    'HEARTBEAT_WIRING_CONSENT_REVOKED', 'HEARTBEAT_WIRING_CONSENT_UNREADABLE',
    'HEARTBEAT_WIRING_BAD_POLICY', 'HEARTBEAT_WIRING_BAD_ENDPOINT',
    'HEARTBEAT_WIRING_FAILED', 'HEARTBEAT_WIRING_READY',
    // 心跳开始/停止的**信息级**码：它们是运行状态读数，不是配置键。
    'HEARTBEAT_WIRING_STARTED', 'HEARTBEAT_WIRING_STOPPED',
    // 逐候选的去向（诊断包清单的契约，四种，没有第五种）：
    'included', 'excluded', 'skipped', 'oversized',
    // 结构性排除规则的 id。它们是**排除理由的分类名**，不是配置键；
    // 每个 id 都必须在清单里可读地说明白"为什么排除"，否则收件人会当成漏收。
    'secret-store', 'credentials-yaml', 'raw-key', 'auth-json', 'business-db', 'env-file',
    // 清单 schema 名与复检方法名。写进包里的契约标识，同样不是配置键。
    'legion.diagnostic-package/1', 'read-back-after-write',    ...CHILD_ENV_NAMES,
    ...OS_ONLY_ENV_NAMES,
    // 诊断码、errno、信号名：都是**输出**用的大写字面量，不是配置键。
    // 它们被规则 ③（`'[A-Z][A-Z0-9_]{3,}'`）误认成疑似 env 键。
    // 逐个列出而不是加一个通配前缀：前缀会让这个清单失去「哪些疑似项已被审阅」的意义。
    'CONFIG_FILE_INSIDE_INSTALL_DIR', 'DEPENDENCY_CYCLE', 'ENTRY_MISSING', 'ENTRY_NOT_VERIFIED',
    'ENTRY_UNRESOLVED', 'ENV_UNDECLARED', 'INSTALL_DIR_UNRESOLVED', 'NON_LOOPBACK_BIND',
    'PATH_NOT_ABSOLUTE', 'PORT_CONFLICT', 'PORT_OUT_OF_RANGE', 'PRODUCT_HOME_INSIDE_INSTALL_DIR',
    // PRT-255：产品家目录解析不出来时的根因诊断。
    // 这一条是补的缺口——原先 `productHomeSource` 被记成 'unresolved' 却没有任何
    // 诊断把它说出来，于是 `secretsFile` 静悄悄变成 null，用户看到的唯一线索是
    // 「SECRETS_PLACEMENT_INVALID：请先解析产品目录布局」——而布局是解析过的。
    'PRODUCT_HOME_UNRESOLVED',
    'READINESS_MISSING', 'ROLE_DIRS_OVERLAP', 'UNKNOWN_DEPENDENCY', 'WORKSPACE_NOT_CONFIGURED',
    'WRITABLE_DIR_INSIDE_INSTALL_DIR', 'WRITES_INSTALL_DIR',
    'PORT_CHECK_FAILED', 'PORT_CHECK_TIMEOUT', 'PORT_CLAIMED_TWICE', 'PORT_IN_USE', 'PORT_PRIVILEGED',
    'PROCESS_CIRCUIT_OPEN', 'PROCESS_EXCLUDED_BY_SCOPE', 'PROCESS_EXITED_BEFORE_READY', 'PROCESS_FAILED',
    'READINESS_FAILED', 'READINESS_IDENTITY_MISMATCH', 'READINESS_TIMEOUT', 'READINESS_VERIFIED',
    'SPAWN_REFUSED',
    // PRT-706（产品配置读取 + 首次运行初始化）新增的诊断码。
    // 每一个都对应一种**静默失败**：坏配置退回默认值、不可写目录、初始化被拒绝。
    // 它们是输出文案的一部分，因此必须与读取点区分开。
    'CONFIG_INVALID_JSON', 'CONFIG_LAYER_PATH_UNRESOLVED', 'CONFIG_MERGE_FAILED', 'CONFIG_NOT_OBJECT',
    'CONFIG_PLAINTEXT_SECRET', 'CONFIG_TYPE_MISMATCH', 'CONFIG_UNKNOWN_KEY', 'CONFIG_UNREADABLE',
    'DIR_NOT_WRITABLE', 'INIT_CONFIG_WRITE_FAILED', 'INIT_META_WRITE_FAILED', 'INIT_MKDIR_FAILED',
    'INIT_REFUSED_INSTALL_DIR', 'INIT_WORKSPACE_MISSING',
    // PRT-254（Secret Store 最小闭环）新增的字面量。
    //
    // `LEGION_SECRETS_FILE` 是**读取点**（在 product/paths.mjs 里按 LEGION_ENV 表读），
    // 之所以也列在这里，是因为扫描器把它当成了"疑似 env 字面量"而非读取点——
    // 它与 `LEGION_DATA_DIR` 走的是同一条取值路径（`pick(explicit, envKey)`），
    // 因此两条声明的形态必须一致，否则下一次改动会让其中一个悄悄失去声明。
    //
    // 其余是密钥库自检的诊断码：同样是**输出**用的大写字面量，不是配置键。
    // 它们回答的是「这台机器上的密钥库能不能用、文件权限有没有被验证过」，
    // 而这两个答案都必须能显示给人看。
    'LEGION_SECRETS_FILE',
    'SECRETS_ACL_TOO_PERMISSIVE', 'SECRETS_ACL_UNVERIFIABLE', 'SECRETS_INSIDE_CACHE_DIR',
    'SECRETS_INSIDE_DATA_DIR', 'SECRETS_INSIDE_INSTALL_DIR', 'SECRETS_LAYOUT_BLOCKED',
    'SECRETS_OK', 'SECRETS_STORE_OPEN_FAILED', 'SECRETS_STORE_UNPROTECTED',
    'SECRETS_STORE_UNSUPPORTED_PLATFORM',
    // PRT-254/257 把自检接进启动流程时新增的三个字面量。
    //
    // `SECRETS_PLACEMENT_INVALID` / `SECRETS_CHECK_FAILED` 是启动诊断码
    // （前者回答"该不该阻止启动"，后者是自检自己崩了时的降级码）；
    // `ACL_TOO_PERMISSIVE` 被 `product/launcher/secrets-check.mjs` 用来**区分**
    // 「查了，太宽」与「没查出来」——这两个必须保持不同的码，把前者塌成后者
    // 会让"已经确认的危险"看起来像"这次没查到"。
    'SECRETS_PLACEMENT_INVALID', 'SECRETS_CHECK_FAILED', 'ACL_TOO_PERMISSIVE',
    // `ACL_NOT_CREATED`：密钥库文件**还没被创建**。它与 `ACL_UNVERIFIABLE`
    // 是不同的事实，必须分开——新装机器上每次启动都会碰到它，若归成"未验证"，
    // 那条告警会每次都出现而每次都说得不对（没有文件就没有暴露面）。
    'ACL_NOT_CREATED',
    // 密钥库内部码（security/secrets/errors.mjs）经 product/secrets.mjs 转成自检码时被引用。
    'SECRET_STORE_UNPROTECTED', 'SECRET_STORE_UNSUPPORTED_PLATFORM',
    'EACCES', 'EADDRINUSE', 'ECONNREFUSED',
    'SIGINT', 'SIGKILL', 'SIGTERM',
  ],
  injects: [
    { target: 'team-hub', env: 'TEAM_HUB_PORT', via: 'env', from: 'ports.team-hub', note: '端口由 Launcher 决定，不由各进程的代码默认值决定' },
    { target: 'team-hub', env: 'TEAM_HUB_HOST', via: 'env', value: '127.0.0.1', note: '§10：默认仅监听回环，非回环绑定在校验阶段报错' },
    { target: 'team-hub', env: 'TEAM_HUB_DB', via: 'env', from: 'dataDir/team-hub/team.db', note: '关闭 PRT-003 实测的越界写入：默认值原在安装目录内' },
    { target: 'workbench', env: 'DSH_HUB_UPSTREAM', via: 'env', from: 'ports.team-hub', note: '**派生值**：workbench 必须指到本次启动的 hub，而不是默认 8787' },
    { target: 'workbench', via: 'cli', cli: '--port', from: 'ports.workbench', note: '端口经 argv 注入（该进程的端口来自 CLI）' },
    { target: 'whiteboard', env: 'PORT', via: 'env', from: 'ports.whiteboard', note: '白板的端口变量名是通用名 PORT，只注入不回落到宿主环境' },
    { target: 'whiteboard', env: 'DB_PATH', via: 'env', from: 'dataDir/whiteboard/whiteboard.db', note: '关闭 PRT-003 实测的越界写入' },
    { target: 'whiteboard', env: 'WB_ROOMS_DIR', via: 'env', from: 'dataDir/whiteboard/rooms', note: '同上' },
    { target: 'whiteboard', env: 'WB_AUDIT_DIR', via: 'env', from: 'dataDir/whiteboard/audit', note: '同上' },
    { target: 'orchestrator', env: 'TEAM_HUB_URL', via: 'env', from: 'ports.team-hub', note: 'worker 经 HTTP 访问 hub（里程碑 PRT-301）' },
  ],
  notes: [
    '子进程环境**不继承**宿主进程：只放行进程清单声明的键、平台必需键与 Launcher 显式给定的值（环境白名单模块 product/launcher/allowlist）。',
    '这与 services-plugin 的做法（`{ ...process.env }` 打底）相反，是 spec §6.7「密钥只注入需要它的进程」在实现层唯一能成立的形态。',
    '`LEGION_*` 八项属于 spec §6.11 的「受控环境变量」层，优先级最高，会覆盖显式传入的参数。' +
    '（第八项 `LEGION_SECRETS_FILE` 是 PRT-254 加入的密钥库路径，与其余七项走同一条取值路径。）',
    // 上面那句省掉了模块扩展名，原因是一条**真实的扫描器假阳性**，不是文风偏好：
    // rule ② 把「任意标识符 + `.env.` + 名字」都读成 env 读取点，因此 `./env.mjs` 里的
    // import 会被读成一个未声明 env 键 `mjs`（且它落在「直接读取」集合里，无法用
    // nonEnvLiterals 豁免）。实测这条曾让 scan --check 报出 `未声明 env 键（1）：mjs`。
    // 规避方式是**给模块改名**（allowlist.mjs 不含 `env.` 形态），而不是给扫描器开豁免。
    // 假阳性本身记在此处，供后续修扫描器的人取证。
  ],
})

export default SCHEMA
