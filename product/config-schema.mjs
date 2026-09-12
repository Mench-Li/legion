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
      key: 'readinessTimeoutMs', env: 'LEGION_READINESS_TIMEOUT_MS', type: 'int', default: 30000, min: 1,
      doc: '单进程就绪判据超时（ms）。判据本身在进程清单里，这里只覆盖超时',
    },
  ],
  // 子进程的 env 键名 + 平台必需键名：都是「变量名」，不是本进程的读取点。
  // 不显式列出的话 `scan --check` 会要求把它们登记为读取点（P3-4 遇到过同类问题）。
  nonEnvLiterals: [
    ...CHILD_ENV_NAMES,
    ...OS_ONLY_ENV_NAMES,
    // 诊断码、errno、信号名：都是**输出**用的大写字面量，不是配置键。
    // 它们被规则 ③（`'[A-Z][A-Z0-9_]{3,}'`）误认成疑似 env 键。
    // 逐个列出而不是加一个通配前缀：前缀会让这个清单失去「哪些疑似项已被审阅」的意义。
    'CONFIG_FILE_INSIDE_INSTALL_DIR', 'DEPENDENCY_CYCLE', 'ENTRY_MISSING', 'ENTRY_NOT_VERIFIED',
    'ENTRY_UNRESOLVED', 'ENV_UNDECLARED', 'INSTALL_DIR_UNRESOLVED', 'NON_LOOPBACK_BIND',
    'PATH_NOT_ABSOLUTE', 'PORT_CONFLICT', 'PORT_OUT_OF_RANGE', 'PRODUCT_HOME_INSIDE_INSTALL_DIR',
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
    '`LEGION_*` 七项属于 spec §6.11 的「受控环境变量」层，优先级最高，会覆盖显式传入的参数。',
    // 上面那句省掉了模块扩展名，原因是一条**真实的扫描器假阳性**，不是文风偏好：
    // rule ② 把「任意标识符 + `.env.` + 名字」都读成 env 读取点，因此 `./env.mjs` 里的
    // import 会被读成一个未声明 env 键 `mjs`（且它落在「直接读取」集合里，无法用
    // nonEnvLiterals 豁免）。实测这条曾让 scan --check 报出 `未声明 env 键（1）：mjs`。
    // 规避方式是**给模块改名**（allowlist.mjs 不含 `env.` 形态），而不是给扫描器开豁免。
    // 假阳性本身记在此处，供后续修扫描器的人取证。
  ],
})

export default SCHEMA
