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
  // PRT-214 续：注入 Runtime 子进程的 Legion 身份（组合根的六项输入 + 三项审批口径）。
  // 它们是注入目标的**变量名**，不是本进程的读取点——本进程从不读它们，
  // 只把值写进子进程的环境（见 product/launcher/enforcement-identity.mjs）。
  'LEGION_ACTOR', 'LEGION_SCOPE', 'LEGION_ENFORCEMENT_ACTION', 'LEGION_CWD', 'LEGION_TASK_ID',
  'LEGION_APPROVAL_POLICY', 'LEGION_ATTENDED', 'LEGION_PERMISSION_PRESET',
  'WHITEBOARD_TOKEN', 'PORT', 'HOST', 'DB_PATH', 'WB_ROOMS_DIR', 'WB_AUDIT_DIR', 'WB_IN_MEMORY',
  // PRT-253 续批四：Runtime Contract 的两个坐标。它们是**注入目标**的变量名
  // （`product/process-manifest.mjs` 里 runtime / orchestrator 的 `envNames`），
  // 本进程从不读它们——只把值写进那两个子进程的环境。
  //
  // ★ 它们**只**出现在那两个进程的 `envNames` 里。别的进程（hub / workbench /
  //   白板）即使宿主环境里有同名值也拿不到：`buildChildEnv()` 只放行目标进程
  //   声明过的键。这就是"凭证只注入需要它的进程"的判据本身。
  'LEGION_RUNTIME_URL', 'LEGION_RUNTIME_TOKEN',
  // ★★★ 2026-09-20：四道范围检查的**授权表**。
  //   它们此前只登记在 `runtime/config-schema.mjs` 的 `fields` 与四个
  //   `*PortFromEnv()` 装配点里，而 `product/process-manifest.mjs` 的 runtime
  //   `envNames` 没有它们 ⇒ `buildChildEnv()` 在 `baseEnv` 那一侧**静默丢掉**。
  //   本批两边一起补——本表与清单 `envNames` 的并集必须一致（`scan --check` 判）。
  'LEGION_PATH_SCOPE', 'LEGION_CONNECTOR_DECLARATIONS',
  'LEGION_EXECUTION_SCOPE', 'LEGION_EXTERNAL_API_SCOPE',
  // ★★★ 2026-09-21 第 112 轮（PRT-603）：**第五道**——岗位许可。
  //
  //   它把上面那条纪律又演示了一次，而且这次的代价是**当场可见的**：
  //   我只把它加进了 `runtime/config-schema.mjs` 的 `fields` 与 runtime 的
  //   `envNames`，**漏了本表** ⇒ `scan --check` 立刻报
  //   「未处理字面量（1）：LEGION_EMPLOYEE_PERMIT」。
  //
  //   > 一个「登记在 runtime 那一侧、而没登记在这里」的键，
  //   > 与一个「压根没接线」的键，在**运行期**是同一个东西——
  //   > 只不过前者的配置表上写着它可用，而子进程永远收不到它。
  //
  //   ★ 而这一次的红**不是**"少写一行"，是那份抄本要求的东西：
  //     本表声明的键必须**恰好等于**清单里两个进程 `envNames` 的并集。
  'LEGION_EMPLOYEE_PERMIT',
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
    // ── PRT-253 续批：`product/orchestrator/worker.mjs` 读的两个 hub 坐标 ──
    //
    // ★ 这两个键**不在产品配置面上**（它们的值由 Launcher 从 `ports.team-hub`
    //   派生后注入，见本文档 §processEnv），但 `scan --check` 的判据是
    //   `SCHEMA.envNames()`，而那是**从 `fields` 推出来的**——
    //   只写 `foreignEnv` 门禁照样红。实测过：先只加了 `foreignEnv`，
    //   `scan` 仍然报「未声明 env 键（2）」。
    //
    //   于是这里有两条登记说的是两件事，两条都必须真：
    //     · `fields`     —— 「本模块确实从环境读这个键」（门禁读这一条）
    //     · `foreignEnv` —— 「这个键归谁拥有、读错了会怎样」（人读这一条）
    //   把 ownership 理由塞进 `fields` 的 `doc` 会让两种信息混在一处，
    //   而它们的读者不同：前者是门禁，后者是下一个准备改这里的人。
    //
    // `default: ''` 且**不是**必填：空串是一个**合法取值**（未配鉴权的 hub、
    // 或没有 hub 可问的离线 worker）。把它做成必填会让无鉴权部署起不来，
    // 而"没配"与"配错了"是两件不同的事。
    {
      key: 'teamHubUrl', env: 'TEAM_HUB_URL', type: 'string', default: '',
      doc: '本进程要问的那个 team-hub 的基地址（由 Launcher 从 ports.team-hub 派生后注入）。'
        + '取值只在这里被 `product/orchestrator/worker.mjs` 读一次，用来建 `hubIo` 并解析岗位的模型绑定（PRT-502）。'
        + '空值 ⇒ **不建**那个端口，绝不猜一个默认 8787：猜出来的地址可能指向另一个 hub，'
        + '而那个 hub 上可能恰好有同名岗位——于是这次运行会用某个没人给这个岗位选过的模型花用户的钱',
    },
    // ★ `sensitive: true` **不是**装饰：不标它时 `config check --json` 会把这个值
    //   原样打进 `processes.product.values.teamHubToken`，而 `config.test.mjs`
    //   那条"JSON 不得泄漏明文 token"的用例当场抓到了
    //   （"JSON 泄漏明文 fixture-hub-token"）。
    //
    //   它此前不泄漏，只是因为 product 这一侧**从来没有声明过**这个键 ——
    //   `scan --check` 逼着声明之后，同一个值就多了一条出口。
    //   这正是「声明一个键」与「声明它的敏感级别」必须一起做的那件事：
    //   只声明键而不标级别，就是**给一个秘密开了一扇新窗**，而门禁只会因为
    //   键已声明而变绿。
    {
      key: 'teamHubToken', env: 'TEAM_HUB_TOKEN', type: 'string', default: '', sensitive: true,
      doc: '同一个 `hubIo` 的鉴权令牌（由 Launcher 注入）。空串是合法取值（hub 未开鉴权的部署），'
        + '所以判据在调用方而不是解析器里——把"没配 token"当成"配置错了"会让无鉴权部署起不来。'
        + '★ 必须以 `sensitive: true` 声明：否则 `config check --json` 会把值原样打进'
        + '产品进程的 `values` 里',
    },
  ],
  // ── 动态下标读取（本批起 `scan --check` 强制登记）────────────────────
  //
  // 这 6 处是**计算出来的键**：键名不写在字面量里，而是从**键名常量表**里取。
  // 扫描器的字面量规则一条都读不到它们——所以这 6 条登记是它们唯一的机器可读记录，
  // 而在这批之前 `--check` 只打印 `[动态]`、从不对照：product 一条都没有，门禁照样绿。
  //
  // 每一处读到的键都能在上面的 `fields` 或下面的 `foreignEnv` 里找到**同一条声明**
  // （三张表：LEGION_ENV 受控层 → fields；OS_HOME_ENV → foreignEnv 的 OS 三项；DSH_HOME_ENV → foreignEnv）。
  //
  // ★ 本进程另有 2 处 `env[key]`（product/launcher/allowlist.mjs）**不是读取**：
  //   `env[key] = String(value)` 是赋值左值（正在构造的子进程环境对象）。它们登记在
  //   `scan.mjs` 的 `FOREIGN_DYNAMIC_SUBSCRIPTS`（kind: write-target），**不写在这里**——
  //   把写目标写进 `dynamicEnvReads` 就是让这份声明说谎，而这份声明的价值全在它说的每句都真。
  dynamicEnvReads: [
    {
      file: 'product/launcher/cli.mjs',
      expr: 'env[OS_HOME_ENV.LOCAL_APP_DATA]',
      reason: 'osHomeFacts(env) 从 OS_HOME_ENV 键名表取 Windows 的 `%LOCALAPPDATA%`（表值 LOCALAPPDATA）。'
        + '键必须计算：那张表是「这三个名字属于操作系统、不属于 Legion 配置」的唯一住处，'
        + '三个名字逐条登记在本 schema 的 foreignEnv 里；在读取点写死字面量会让这条事实两处各说一半。',
    },
    {
      file: 'product/launcher/cli.mjs',
      expr: 'env[OS_HOME_ENV.USER_PROFILE]',
      reason: '同上（`nonEmpty(env[OS_HOME_ENV.USER_PROFILE]) ?? nonEmpty(env[OS_HOME_ENV.HOME])` 的第一顺位）：'
        + 'Windows 的家目录事实。名字来自同一张 OS_HOME_ENV 表，归属登记在 foreignEnv（USERPROFILE）。',
    },
    {
      file: 'product/launcher/cli.mjs',
      expr: 'env[OS_HOME_ENV.HOME]',
      reason: '同上：POSIX 家目录事实（表值 HOME），是上面那个 `??` 的第二顺位。'
        + 'HOME 与别的进程共用同一个名字，所以在 foreignEnv 里逐个登记归属（操作系统 POSIX），不靠前缀猜。',
    },
    {
      file: 'product/launcher/cli.mjs',
      expr: 'env[DSH_HOME_ENV]',
      reason: 'dshCredentialsFileFrom(env) 用 DSH_HOME_ENV 常量（值 DSH_HOME）定位 **DSH 自己的** .credentials.yaml。'
        + '键必须计算：那个常量名就是「DSH 用哪个变量」这个事实的唯一定义处（PRT-509 路线 A′）；'
        + 'DSH_HOME 在本 schema 的 foreignEnv 里登记为「DSH 拥有、Legion 只读该文件」。'
        + '（PRT-257 起同一个常量还被 `dshHomeFrom(env)` 读一次——那是同一个键、同一处定义，'
        + '所以这里仍然是这一条登记。）',
    },
    {
      file: 'product/paths.mjs',
      expr: 'env[LEGION_ENV.HOME]',
      reason: 'defaultProductHome 用 LEGION_ENV 表取受控环境变量 LEGION_HOME（spec §6.11 受控层，'
        + '优先级高于操作系统事实）。键必须计算：LEGION_ENV 是「本模块认的全部环境变量」的唯一登记处；'
        + 'LEGION_HOME 本身是上面 fields 里声明过的读取点。',
    },
    {
      file: 'product/paths.mjs',
      expr: 'env[envKey]',
      reason: 'resolveLayout 的通用取值器 `pick(explicit, envKey)`：envKey 由每个调用点从同一张 LEGION_ENV 表传入'
        + '（INSTALL_DIR / DATA_DIR / CACHE_DIR / LOG_DIR / WORKSPACE_DIR / PRODUCT_CONFIG / SECRETS_FILE —— '
        + '七个键全部是上面 fields 里声明的读取点）。它必须计算，否则七个键要写七份几乎相同的取值代码，'
        + '而「哪一层压过哪一层」（§6.11）会散成七处、只会在某一处被改错。',
    },
    // ── PRT-708 托盘图标宿主：解析"用哪个 PowerShell"要读的三个操作系统键 ──
    //
    // `product/launcher/tray-icon.mjs` 的 `candidateTrayShells()` 按
    // `%ProgramFiles%\PowerShell\7\pwsh.exe` → PATH 上的 `pwsh.exe` →
    // `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 解析一档 shell。
    //
    // 键必须**计算**：三个名字住在同一张 `SHELL_ENV` 表里，那张表是
    // 「这三个名字属于操作系统、不属于 Legion 配置」的唯一住处，
    // 归属逐条登记在上面的 `OS_ONLY_ENV_NAMES`（ProgramFiles / SystemRoot / PATH）。
    // 三个读取点各写一份字面量，会让"哪些键是操作系统的"这条事实散成三段，
    // 而解析顺序恰恰依赖它们三者的先后——散开之后，改顺序的人只需要漏改一处。
    //
    // ★ `PATH` 那一条是**同一处的两遍**（`×2`）：`candidateTrayShells` 里
    //   "切分 PATH 取出每个目录"与"去重后仍然按原顺序取第一个存在的"读的是同一个键，
    //   两遍都在这一个函数里、由同一条登记覆盖。
    {
      file: 'product/launcher/tray-icon.mjs',
      expr: 'env[SHELL_ENV.PROGRAM_FILES]',
      reason: '解析 PowerShell 7 的候选路径：`%ProgramFiles%\\PowerShell\\7\\pwsh.exe`。'
        + '键名来自 SHELL_ENV 表（值 ProgramFiles），归属登记在 OS_ONLY_ENV_NAMES。'
        + '顺序是第一档——装了 pwsh 7 的机器上应当用它，而不是退到 5.1。',
    },
    {
      file: 'product/launcher/tray-icon.mjs',
      expr: 'env[SHELL_ENV.SYSTEM_ROOT]',
      reason: '解析随 Windows 发货的那一档：`%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`。'
        + '键名来自 SHELL_ENV 表（值 SystemRoot），归属登记在 OS_ONLY_ENV_NAMES。'
        + '它是**最后一档**：这台机器上 pwsh 与 PATH 上的 pwsh 都不存在时，图标能不能画出来取决于它。',
    },
    {
      file: 'product/launcher/tray-icon.mjs',
      expr: 'env[SHELL_ENV.PATH]',
      reason: '解析 PATH 上的 `pwsh.exe`（剥掉引号、按大小写不敏感去重、保持原顺序）。'
        + '键名来自 SHELL_ENV 表（值 PATH），归属登记在 OS_ONLY_ENV_NAMES。'
        + '这一档在 Windows 上通常是空的（pwsh 装在 ProgramFiles 或 System32），'
        + '但用户自装的 pwsh 只在这一档里——不读它就会把一个能画图标的机器报成"不支持"。',
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
    // PRT-509 路线 A′：本进程**也**读它（`product/launcher/cli.mjs` 的
    // `dshCredentialsFileFrom`），不只是注入给 Runtime 子进程。
    //
    // 为什么必须登记在这里而不是只留在 `CHILD_ENV_NAMES` 里：那一份说的是
    // 「注入目标的变量名」，理由里写着"本进程从不读它们"。现在这句话不成立了，
    // 而 `scan --check` 只看字面量**有没有登记**、看不出理由漂了没有——
    // 登记理由要漂，只能靠人把它挪到看得见的地方。
    {
      name: 'DSH_HOME',
      owner: 'DeepSeek Harness（DSH）',
      reason: 'DSH 用它定位自己的 $DSH_HOME/.credentials.yaml。Legion **只读**该文件作为凭证回退来源（PRT-509 路线 A′），'
        + '只在 Legion 自己的密钥库里没有那条引用时才去读，结果里带出处；不写它、不迁移、不猜路径',
    },
    // PRT-253 续批：`product/orchestrator/worker.mjs` **也**读这两个键
    // （`workerHubUrl = process.env.TEAM_HUB_URL`、`hubIo({hubToken: process.env.TEAM_HUB_TOKEN})`），
    // 用来把"模型档案解析端口"接到真正的 hub 上。
    //
    // 为什么必须登记在这里，而不是只留在上面的 `CHILD_ENV_NAMES` 里：
    // 那一份说的是「注入目标的变量名」，注释里明写"本进程从不读它们"。
    // 现在这句话对**这个文件**不成立了——它虽然是被 Launcher 拉起来的子进程，
    // 但它属于 `product/`，于是它出现在 product 这一次扫描里。
    //
    //   > 一份"注入目标的名字清单"与一份"谁在读它"的清单，
    //   > 在只有一个读者、而且那个读者恰好就是注入方时是同一个东西。
    //
    // 归属写在 team-hub（`TEAM_HUB_URL` 由 Launcher 从 `ports.team-hub`
    // 派生后注入，见本文档的 processEnv 段），所以它归 `foreignEnv`
    // 而不是 `fields`——它不是**产品配置项**，而是"这次是哪个 hub"这个事实。
    {
      name: 'TEAM_HUB_URL',
      owner: 'team-hub（由 Launcher 从 ports.team-hub 派生后注入）',
      reason: '`product/orchestrator/worker.mjs` 用它建 `hubIo`，再据 (scope, role) 解析岗位的模型绑定（PRT-502/253）。'
        + '★ 没有它时**不建**那个端口（返回 `null`）而不是猜一个默认 8787：'
        + '猜出来的地址会把模型绑定解析接到**另一个** hub 上，而那个 hub 上可能恰好有同名岗位——'
        + '于是这次运行会用某个没人给这个岗位选过的模型花用户的钱',
    },
    {
      name: 'TEAM_HUB_TOKEN',
      owner: 'team-hub（由 Launcher 注入）',
      reason: '同一个 `hubIo` 的鉴权。空串是**合法**取值（hub 未开鉴权的部署），'
        + '所以读取点在调用方而不是解析器里——把"没配 token"当成"配置错了"会让无鉴权部署起不来',
    },
    // PRT-257：本进程**也**读它——`product/launcher/cli.mjs` 的
    // `underNodeTestRunner()`。
    //
    // 它不是产品配置面，而是"我们现在跑在哪"这个事实：`node --test` 会给每个
    // 测试子进程设它。那条判据守的是一条**结构性**保证——
    // `--runtime-install` 用默认运行器时，在测试进程里**构造不出**真实 npm
    // 运行器，于是"用例漏注入一次假运行器"不会变成一次真实联网安装。
    //
    // 归属写在这里而不是 `OS_ONLY_ENV_NAMES`：它不是操作系统必需键，
    // 而是**另一个程序**（Node 的测试运行器）设的，与 DSH_HOME 同一类。
    {
      name: 'NODE_TEST_CONTEXT',
      owner: 'Node.js 自带测试运行器（node:test）',
      reason: '`node --test` 在测试子进程里设它。Legion **只读**它来判断"这一跑是不是测试"，'
        + '并据此拒绝构造真实的 npm 运行器（用例必须注入运行器）——它不改变任何产品行为',
    },
  ],
  nonEnvLiterals: [

    // ── PRT-009 `peak-resource` 采不到时的具名码 ─────────────────────────
    //
    // 它们是 `product/launcher/peak-resource.mjs` 的 `PEAK_RESOURCE_CODES`
    // 的值，不是配置键：没有哪个进程"读"它们，它们是**采样失败的原因**。
    //
    // ★ 这一组与上面 DSH_OVERLAY 那四条是**同一条路径**来的——也是被
    //   `scan --check` 咬出来的（全大写下划线连写，形如 env 键）。而按本文件
    //   记下的那条纪律，登记之前先问了一句：**这几个码对不对？**
    //   对的，而且它们**必须**分开：把五种"采不到"归并成一个 `FAILED`，
    //   会让"进程已经没了"与"这个平台没实现"在读数上同形——前者一个字节
    //   都不用改，后者要新写一个平台的采样实现。
    'PEAK_RESOURCE_NO_PID',
    'PEAK_RESOURCE_PROCESS_GONE',
    'PEAK_RESOURCE_UNSUPPORTED_PLATFORM',
    'PEAK_RESOURCE_UNPARSEABLE',
    'PEAK_RESOURCE_SAMPLE_FAILED',

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

    // ── PRT-214 续 Legion 身份注入的诊断码 ──────────────────────────────
    //
    // `product/launcher/enforcement-identity.mjs` 的 `ENFORCEMENT_IDENTITY_CODES` 的值。
    // 同样是**输出**用的码，不是配置键。
    //
    // ★ 它必须与 `DSH_OVERLAY_DISABLED_BY_CONFIG` **分开**：那一条说"你故意关掉了"，
    //   这一条说"你要它、但它缺料"。合成一个的话，一个关掉了覆盖层、
    //   因而本来就不需要身份的正常部署，会被报成"身份缺失"。
    'ENFORCEMENT_IDENTITY_MISSING',

    // ── PRT-509 缺口 ① 凭证材料化接线的诊断码 ────────────────────────────
    //
    // `product/launcher/run-credential-materialization.mjs` 的
    // `RUN_CREDENTIAL_WIRING_CODES` 的值。名字是 SCREAMING_SNAKE，所以 scan
    // 会怀疑它们是环境变量——它们不是：进程不"读"它们，而是把它们放进诊断
    // 给用户看，并让调用方按码决定"阻止启动"还是"只提醒"。
    //
    // ★ 它们与材料化器自己的 20 条（`security/config-schema.mjs` 那份）**是
    //   两套**，刻意不合并：那 20 条说的是"这份凭证文档能不能写出去"，
    //   这 11 条说的是"有没有把那次写入接到生产的启动路径上、以及 DSH 会不会
    //   去读它"。合成一套的话，"接线没跑到"与"材料化被拒绝"在读数上会变成
    //   同一个东西——而它们的修法完全不同（一个要改接线，一个要改密钥）。
    'RUN_CREDENTIALS_NO_ALLOWED_ROOT',
    'RUN_CREDENTIALS_ALLOWED_ROOT_INVALID',
    'RUN_CREDENTIALS_TARGET_INSIDE_DATA_DIR',
    'RUN_CREDENTIALS_OPERATOR_HOME_REQUIRED',
    'RUN_CREDENTIALS_NO_REFS_DECLARED',
    'RUN_CREDENTIALS_DSH_DECLARATION_MISSING',
    'RUN_CREDENTIALS_DSH_DECLARATION_AMBIGUOUS',
    'RUN_CREDENTIALS_DSH_DECLARATION_UNLOCATABLE',
    'RUN_CREDENTIALS_HANDLE_FAILED',
    'RUN_CREDENTIALS_MATERIALIZE_REFUSED',
    'RUN_CREDENTIALS_OVERLAY_WRITE_FAILED',
    'RUN_CREDENTIALS_TARGET_DIR_UNCREATABLE',

    // ── PRT-707 首次运行向导**接线层**的诊断码（四个）**已随死的那份一起删掉** ──
    //
    // ★ 第 118 轮第九轮：业主在第 1 轮确认了第 17 条的裁决——**删掉死的那份
    //   `product/launcher/first-run.mjs`（636 行、零生产导入者），保留活的那份**
    //   （`cli.mjs` 的 `--wizard` 分支）。于是这里原来登记的四条
    //   （`FIRST_RUN_SECRETS_UNAVAILABLE` / `FIRST_RUN_SECRET_WRITE_FAILED` /
    //   `FIRST_RUN_PROFILE_WRITE_FAILED` / `FIRST_RUN_BINDING_WRITE_FAILED`）
    //   **一个都不再出现**——它们只活在那一份实现里。
    //
    //   ⚠️ 这里**不是**"这批码删了、判据松了"：scan 的判据是"源码里出现的
    //   SCREAMING_SNAKE 字面量要能说出属于哪个进程"。字面量随文件一起消失，
    //   登记项也就该跟着消失——**留着一个已无产地的登记项，与登记一个没有
    //   产地的码，是同一个东西**（都让"这批码有人管"看起来成立）。
    //
    //   活的那份（`cli.mjs --wizard`）用的是运行时物化的引用名
    //   （`model/api-key`，见 `run-credential-materialization.mjs`），
    //   它的漂移读数留在 `product/launcher/wizard-wiring.test.mjs`。

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
    // 第 40 轮：声明了一个进程字段却没人登记取法 ⇒ **具名上抛**（不静默丢掉）。
    // 它是一个诊断码，与上面三个同族——**不是**配置键。
    'RUN_RECORD_FIELD_NOT_WIRED',
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
    // `tray-wiring.mjs` 的四个具名拒绝。它们与上面那八个**不同层**：
    // 上面管"托盘自己怎么动作"，这四个管"这根线接不接得上、
    // 以及那次"打开浏览器"为什么不许发出去"。
    //
    //   *一个"接不上时报一句具体原因"的接线，与一个"接不上时安静地什么都不做"
    //   的接线，在装得上的那台机器上是同一个东西——只不过前者的失败可诊断。*
    'TRAY_WIRING_MISSING_LAUNCHER',
    'TRAY_WIRING_OPEN_UNSUPPORTED',
    'TRAY_WIRING_OPEN_BAD_URL',
    'TRAY_WIRING_FAILED',
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
    // PRT-709 收尾：**日志策略命令行**（product/launcher/log-policy-cli.mjs）的具名码。
    // 同样是**输出**用的码。`CONFIG_UNREADABLE` 与 `WRITE_FAILED` 必须分开：
    // 前者是"我们没有动你的文件，请你自己看一眼"，后者是"我们动了但没成功"——
    // 用户下一步要做的事完全不同。
    'LOGCLI_NO_CONFIG_PATH', 'LOGCLI_CONFIG_UNREADABLE', 'LOGCLI_BAD_VALUE',
    'LOGCLI_UNKNOWN_KEY', 'LOGCLI_WRITE_FAILED', 'LOGCLI_NOTHING_TO_SET',
    // 查看器里那条诊断的**兜底标签**：诊断一般自带 `code`（如 `CONFIG_INVALID_JSON`），
    // 万一没有就用它。不是配置键，也不是环境变量。
    'CONFIG_DIAGNOSTIC',
    // PRT-707 收尾：**向导的 CLI 层**（product/launcher/wizard-cli.mjs）的具名码。
    // 同样是**输出**用的码，且必须分开：
    // `NOT_INTERACTIVE`（读不到输入，停下来）与 `BAD_INPUT`（读到了但不合法）
    // 是两件不同的事——把它们合成一个，一个没有终端的运行会被报成"输入不合法"。
    'WIZARDCLI_NOT_INTERACTIVE', 'WIZARDCLI_BAD_INPUT', 'WIZARDCLI_STEP_FAILED',
    'WIZARDCLI_PRECONDITION_UNMET', 'WIZARDCLI_ALREADY_DONE',
    // 向导里"可选项没有被问到"这一条。**是 info 级，不是错误**：
    // 对可选功能来说"没回答"完全正常，而把正常的事报成错误
    // 会让用户以为自己做错了什么。
    'WIZARD_OPT_IN_UNANSWERED',
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
    // `PORT_RESERVED`：`EACCES` 的**第二种**成因。端口 ≥1024 时它表示"落在系统保留段里"
    // （Windows 上 Hyper-V/WSL/管理员保留段），处置是**换端口**而不是提权。
    // 与 `PORT_PRIVILEGED`（<1024，真的需要特权）分开，是因为两者指向**相反**的动作。
    'PORT_RESERVED',
    // PRT-257 修复入口（`product/launcher/doctor.mjs`）的**具名结论**。
    // 它们会被打印、也可能被脚本读，所以与"读取点"区分开。
    //
    // 四个值不是四个严重程度，而是**四种处境**，其中第三种最要紧：
    //   · `DOCTOR_CLEAN`       自检全过；
    //   · `DOCTOR_ACTIONABLE`  有待修项，逐项给了修法；
    //   · `DOCTOR_NO_PLAN`     知道它坏了（`incompatible`），却给不出修法 —— 产品侧缺口；
    //   · `DOCTOR_NO_DIAGNOSIS` 连诊断都没有（没做过自检 / 来源缺席 / 输入畸形）。
    // 后两者**共用退出码 3**，与 `DOCTOR_CLEAN` 的 0 严格分开：
    // 一个"读不到结论所以什么都没报"的体检，与一个"结论是一切正常"的体检，
    // 在退出码上是同一个东西——而前者会让一个已经坏掉的部署安静地通过门禁。
    'DOCTOR_CLEAN', 'DOCTOR_ACTIONABLE', 'DOCTOR_NO_PLAN', 'DOCTOR_NO_DIAGNOSIS',
    // PRT-708 单实例锁（`product/launcher/single-instance.mjs`）的**具名结论**。
    // 它们会被打印、也会被调用方按码分支，所以与"读取点"区分开。
    // 六种处境各自不同，尤其这三条不能混：
    //   · `ACQUIRED`    拿到了；
    //   · `RECLAIMED`   接手了一个**崩溃留下**的锁（持有者确定死了）；
    //   · `HELD`        有一个**活着的**实例；
    //   · `HOLDER_UNKNOWN` **判断不了**死活 —— 这一条与 `HELD` 分开是刻意的：
    //     两者的处置不同（前者要用户确认后删文件，后者只需去用那个实例），
    //     而把它们混成一个码会把"我判断不了"说成"确实有别人在跑"。
    // `EEXIST` 是 `open(..., 'wx')` 的返回码，这把锁的原子性就来自它。
    'EEXIST', 'INSTANCE_LOCK_ACQUIRED', 'INSTANCE_LOCK_STALE_RECLAIMED',
    'INSTANCE_ALREADY_RUNNING', 'INSTANCE_LOCK_HOLDER_UNKNOWN',
    'INSTANCE_LOCK_NOT_OURS', 'INSTANCE_LOCK_RELEASED',
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
    // PRT-509 路线 A′：DSH 只读回退来源的两条启动诊断码
    // （`product/launcher/secrets-check.mjs` 的 `fallbackDiagnostic`）。
    //
    // 两条而不是一条，理由与上面 `ACL_TOO_PERMISSIVE` / `ACL_UNVERIFIABLE`
    // 完全一样：**"看过了，它不在认识的子集里"与"根本没看到"** 是两条
    // 不同的信息，下一步动作也不同（前者去改文件写法，后者去改权限）。
    // 把前者塌成后者，用户会去查一个并不存在的权限问题。
    'SECRETS_DSH_CREDENTIALS_UNREADABLE', 'SECRETS_DSH_CREDENTIALS_UNRECOGNIZED',
    // `ACL_NOT_CREATED`：密钥库文件**还没被创建**。它与 `ACL_UNVERIFIABLE`
    // 是不同的事实，必须分开——新装机器上每次启动都会碰到它，若归成"未验证"，
    // 那条告警会每次都出现而每次都说得不对（没有文件就没有暴露面）。
    'ACL_NOT_CREATED',
    // PRT-509 缺口 B1：ACL 的 runner 与 owner 接上生产之后新增的一条诊断码。
    //
    // 它单独存在（而不是并进 `SECRETS_CHECK_FAILED`）的理由，正是那条缺口
    // 得以长期存活的原因：笼统的一句"密钥库自检未完成"会把两件完全不同的事
    // 说成同一件——
    //   · **问不出当前用户身份**（环境问题：`whoami` 不在 PATH、被策略拦住）
    //     → 修法是查环境，而文件其实**没有被加固**；
    //   · **加固真的失败了**（权限问题：`icacls` 返回非零）
    //     → 修法是看 icacls 的输出。
    // 读诊断的人靠这一行才知道该去看哪里。
    'SECRETS_ACL_OWNER_UNRESOLVED',
    // 密钥库内部码（security/secrets/errors.mjs）经 product/secrets.mjs 转成自检码时被引用。
    'SECRET_STORE_UNPROTECTED', 'SECRET_STORE_UNSUPPORTED_PLATFORM',
    'EACCES', 'EADDRINUSE', 'ECONNREFUSED',
    // PRT-253 续批四新增：`ENOENT` 是"端口发布文件不在"的判据
    // （`runtime-contract-endpoint.mjs` 用它把"没发布"与"读不了"分开）。
    // 与上面三个同一条：**Node 的 fs 错误码**，不是配置键，也不是环境变量名——
    // 只是名字长得像 SCREAMING_SNAKE，所以 scan 会怀疑它。
    'ENOENT',
    'SIGINT', 'SIGKILL', 'SIGTERM',

    // ── PRT-253 续批四 Runtime Contract 端点/凭证的具名码 ────────────────
    //
    // `product/launcher/runtime-contract-endpoint.mjs` 的
    // `RUNTIME_CONTRACT_ENDPOINT_CODES` 的值。它们是**给用户看的读数**，
    // 不是配置键：进程不"读"它们，而是把它们放进启动诊断。
    //
    // ★ 七条而不是一条，因为**下一步动作各不相同**：
    //   `TOKEN_GENERATION_FAILED` 去查随机源；`PATH_UNAVAILABLE` 去把 DataDir 交给
    //   Launcher；`ABSENT` 去看 Runtime 那一行挂没挂；`UNREADABLE` 去看盘/权限；
    //   `INVALID` 去看写侧版本；`STALE` 去看是不是有第二个进程在写同一个 DataDir；
    //   `CLEAR_FAILED` 是"上次的残留没清掉"（有 pid 兜底，所以只是 warn）。
    //   把它们压成一个"端点不可用"，运维只能靠文案猜。
    'RUNTIME_CONTRACT_TOKEN_GENERATION_FAILED',
    'RUNTIME_CONTRACT_PUBLICATION_PATH_UNAVAILABLE',
    'RUNTIME_CONTRACT_PUBLICATION_ABSENT',
    'RUNTIME_CONTRACT_PUBLICATION_UNREADABLE',
    'RUNTIME_CONTRACT_PUBLICATION_INVALID',
    'RUNTIME_CONTRACT_PUBLICATION_STALE',
    'RUNTIME_CONTRACT_PUBLICATION_CLEAR_FAILED',

    // ── PRT-257 DSH 运行时安装器的诊断码 ────────────────────────────────
    //
    // `product/launcher/runtime-install.mjs` 的 `RUNTIME_INSTALL_CODES` 的值。
    // 它们是**给用户看的读数**、也是调用方按码分支的依据，不是配置键：
    // 进程不"读"它们，而是把它们放进拒绝与结果里。名字是 SCREAMING_SNAKE，
    // 所以 scan 会把它们当成疑似环境变量——这正是它该做的事，由这里逐条否定。
    //
    // ★ 一条码对应一种**下一步动作不同**的处境，因此不许合并：例如
    //   `TARGET_INSIDE_DSH_HOME`（去换 DataDir）与 `TARGET_INSIDE_INSTALL_DIR`
    //   （去换安装布局）都是"不许装在那里"，但要看的是两份不同的配置；
    //   而 `PATCH_PAIR_UNVERIFIED`（去补绑定表）与 `PATCH_PAIR_MISMATCH`
    //   （去对齐清单声明）之间隔着一条"有没有查过"的界线。
    'RUNTIME_INSTALL_NO_DATA_DIR',
    'RUNTIME_INSTALL_DATA_DIR_NOT_ABSOLUTE',
    'RUNTIME_INSTALL_TARGET_INSIDE_DSH_HOME',
    'RUNTIME_INSTALL_TARGET_INSIDE_INSTALL_DIR',
    'RUNTIME_INSTALL_TARGET_OUTSIDE_ALLOWED_ROOT',
    'RUNTIME_INSTALL_VERSION_MALFORMED',
    'RUNTIME_INSTALL_RANGE_UNCHECKED',
    'RUNTIME_INSTALL_VERSION_OUT_OF_RANGE',
    'RUNTIME_INSTALL_PATCH_PAIR_MISMATCH',
    'RUNTIME_INSTALL_PATCH_PAIR_UNVERIFIED',
    'RUNTIME_INSTALL_LEGION_SOURCE_MISSING',
    'RUNTIME_INSTALL_TARGET_DIR_EXISTS',
    'RUNTIME_INSTALL_RUNNER_FAILED',
    'RUNTIME_INSTALL_VERIFY_FAILED',
    'RUNTIME_INSTALL_WRITE_REFUSED',
    'RUNTIME_INSTALL_POINTER_UNREADABLE',
    'RUNTIME_INSTALL_POINTER_SWITCH_FAILED',
    'RUNTIME_INSTALL_ACTIVE_RUNTIME_INCOMPLETE',
    'RUNTIME_INSTALL_ROLLBACK_UNAVAILABLE',
    'RUNTIME_INSTALL_ROLLBACK_TARGET_INCOMPLETE',
    'RUNTIME_INSTALL_UNEXPECTED',

    // ── PRT-257 npm 运行器自己的读数（`NPM_RUNNER_CODES`）───────────────
    //
    // `product/launcher/runtime-install.mjs` 的 `NPM_RUNNER_CODES` 的值。
    // 它只有一条，而那一条必须与"npm 跑了但失败了"分开：
    //
    //   > 一个"命令根本拼不出来"的失败，
    //   > 与一个"npm 起了、装到一半失败"的失败，在"指针动没动"上是同一个答案，
    //   > 但在"磁盘上多了什么"上是两个完全不同的现场。
    //
    // 所以它单独成码，而不是复用 `RUNTIME_INSTALL_RUNNER_FAILED`。
    'RUNTIME_NPM_INVOCATION_UNRESOLVED',

    // ── PRT-257 现役指针 → runtime 命令（`RUNTIME_RESOLVE_CODES`）────────
    //
    // `product/launcher/runtime-resolve.mjs` 的 `RUNTIME_RESOLVE_CODES` 的值。
    // 这一组是**六种处境、六个不同的下一步**，因此不许合并：
    //   · `NO_DATA_DIR`（去给数据目录）—— 且它**不阻塞**（另有更准确的诊断说话）；
    //   · `NOT_INSTALLED`（去装一次）—— 干净机器上的正常读数，也不阻塞；
    //   · `POINTER_UNREADABLE`（去看/清那个文件）—— 阻塞；
    //   · `POINTER_BROKEN`（去重装或回滚）—— 阻塞；
    //   · `ENTRY_MISMATCH`（指针被改过或被挪过）—— 阻塞，且**不挑一个用**；
    //   · `PROFILE_REQUIRED`（去给 profile）—— 阻塞，因为一条少了 `--profile`
    //     的命令是"每个字都对、但 DSH 会退出 1"的那种命令。
    'RUNTIME_RESOLVE_NO_DATA_DIR',
    'RUNTIME_RESOLVE_NOT_INSTALLED',
    'RUNTIME_RESOLVE_POINTER_UNREADABLE',
    'RUNTIME_RESOLVE_POINTER_BROKEN',
    'RUNTIME_RESOLVE_ENTRY_MISMATCH',
    'RUNTIME_RESOLVE_PROFILE_REQUIRED',
    // 启动期诊断（与上面的拒绝码分开：它们说的是"磁盘上那一份与这次要跑的那一份
    // 不是同一个"，而不是"命令拼不出来"）。两条都是 warn——它们**不**拦启动。
    'RUNTIME_RESOLVE_INSTALLED_UNUSED',
    'RUNTIME_RESOLVE_INSTALLED_BROKEN_UNUSED',

    // ── PRT-257 §9.1 清单的组装读数（`RUNTIME_MANIFEST_CODES`）───────────
    //
    // `product/launcher/runtime-manifest.mjs` 的 `RUNTIME_MANIFEST_CODES` 的值。
    // 三条对应三种不同的下一步：
    //   · `FIELD_UNDECIDED`（去把发布决定写进来）—— 缺的是**人**要到场的那几个字段；
    //   · `INVALID`（去修生成器）—— 生产校验器拒绝了生成器造出来的清单；
    //   · `PATCH_VERSION_MISMATCH`（去判哪一边对）—— 清单与仓库声明不一致，
    //     而本模块刻意**不替用户决定**哪一边是对的。
    'RUNTIME_MANIFEST_FIELD_UNDECIDED',
    'RUNTIME_MANIFEST_INVALID',
    'RUNTIME_MANIFEST_PATCH_VERSION_MISMATCH',

    // ── PRT-257 运行时安装入口（CLI 这一层）自己的拒绝码 ─────────────────
    //
    // `product/launcher/cli.mjs` 的 `RUNTIME_PLAN_CODES` 的值。与上面那组**分开**
    // 是有理由的：上面那组是**判据算出来之后**的结论（"算过了，答案是不行"），
    // 这一组是**判据根本没算成**（没有清单、清单不在、读不出来、不合法）——
    // 它在退出码上也是另一档（3，而拒绝是 1）。
    //
    // ★ 四条不许合并：对用户是四件不同的事，对下一步是四个不同的动作
    //   （补一个参数 / 看那个路径 / 修文件读权限或 JSON / 改清单字段）。
    //   合并成一条"清单有问题"会让其中三种处境的人去修另外两种东西。
    'RUNTIME_PLAN_NO_MANIFEST',
    'RUNTIME_PLAN_MANIFEST_NOT_FOUND',
    'RUNTIME_PLAN_MANIFEST_UNREADABLE',
    'RUNTIME_PLAN_MANIFEST_INVALID',

    // ── PRT-708 原生托盘图标宿主（`product/launcher/tray-icon.mjs`）的码 ────
    //
    // `TRAY_ICON_CODES` 的值。与上面每一组同类：它们是**输出**给用户看的码，
    // 不是配置键——进程不"读"它们。
    //
    // ★ 这一组里混着三种语义，合并任何两条都会让用户去修错的东西：
    //   · `UNSUPPORTED_PLATFORM` / `NO_SHELL` —— **这台机器**画不出来（修机器）；
    //   · `HOST_PENDING` / `HOST_READY` / `HOST_FAILED` / `HOST_NOT_READY` /
    //     `HOST_EXITED_BEFORE_READY` / `HOST_UNHEALTHY` —— 宿主**这一次**的读数
    //     （修环境或重试）；
    //   · `*_INSIDE_DSH_HOME` / `*_INSIDE_INSTALL_DIR` / `*_OUTSIDE_ALLOWED_ROOT` /
    //     `NO_DATA_DIR` / `DATA_DIR_NOT_ABSOLUTE` / `WRITE_REFUSED` —— **写在哪**
    //     被拒绝了（修调用方传进来的路径）。
    //
    //   `SHUTDOWN_TIMEOUT` 与 `SHUTDOWN_UNCLEAN` 刻意分开：前者是"它没说自己拆了图标"，
    //   后者是"它说自己拆了、但说没拆"。两者的下一步不同（前者去查进程，后者去查脚本）。
    //
    //   ★ `EXITED` 与 `NOT_STARTED` 也在列：它们让"干净退出"与"本来就没在跑"
    //     成为两个不同的读数——一个把两者合成"ok"的实现，会在宿主根本没起过的
    //     机器上把"没什么可收的"说成"收干净了"。
    'TRAY_ICON_ALREADY_STARTED',
    'TRAY_ICON_BUSY',
    'TRAY_ICON_DATA_DIR_NOT_ABSOLUTE',
    'TRAY_ICON_EXITED',
    'TRAY_ICON_HOST_EXITED_BEFORE_READY',
    'TRAY_ICON_HOST_FAILED',
    'TRAY_ICON_HOST_NOT_READY',
    'TRAY_ICON_HOST_PENDING',
    'TRAY_ICON_HOST_READY',
    'TRAY_ICON_HOST_UNHEALTHY',
    'TRAY_ICON_MENU_MALFORMED',
    'TRAY_ICON_MENU_REPUBLISH_FAILED',
    'TRAY_ICON_MENU_UNAVAILABLE',
    'TRAY_ICON_NOT_STARTED',
    'TRAY_ICON_NO_DATA_DIR',
    'TRAY_ICON_NO_SHELL',
    'TRAY_ICON_SHUTDOWN_TIMEOUT',
    'TRAY_ICON_SHUTDOWN_UNCLEAN',
    'TRAY_ICON_SPAWN_FAILED',
    'TRAY_ICON_TARGET_INSIDE_DSH_HOME',
    'TRAY_ICON_TARGET_INSIDE_INSTALL_DIR',
    'TRAY_ICON_TARGET_OUTSIDE_ALLOWED_ROOT',
    'TRAY_ICON_UNEXPECTED',
    'TRAY_ICON_UNKNOWN_ACTION',
    'TRAY_ICON_UNKNOWN_MESSAGE',
    'TRAY_ICON_UNSUPPORTED_PLATFORM',
    'TRAY_ICON_WRITE_REFUSED',
    // ── PRT-251 续 ④ 旧数据接管（安装目录 → DataDir）的**逐项**诊断码 ──────
    //
    // `product/launcher/legacy-data-adoption.mjs` 的 `ADOPTION_CODES` 的值。
    // 同样是**输出**用的码，不是配置键：进程不"读"它们，而是把逐项结论放进
    // `launcher.allDiagnostics()` 的 `adoptionDiagnostics` 给用户看。
    //
    // ★ 与下面那组 `LEGACY_ADOPTION*` **分开**：那两条是**一次启动一行**的结论，
    //   这七条是**逐项**的失败原因。合成一套的话，"四个落点里有几个没接成"
    //   要靠读那行汇总去猜，而"哪一项、为什么没接成"才是要照着修的东西。
    'ADOPTION_SOURCE_MISSING',
    'ADOPTION_TARGET_EXISTS',
    'ADOPTION_SOURCE_UNREADABLE',
    'ADOPTION_COPY_FAILED',
    'ADOPTION_VERIFY_FAILED',
    'ADOPTION_NO_DATA_DIR',
    'ADOPTION_TARGET_INSIDE_INSTALL',

    // ── PRT-251 续 ④ 接管**结论**（`launcher.adoptLegacyData()`）─────────
    //
    // `LEGACY_ADOPTION` 是一行汇总（运维最常问的是"这次启动有没有接管"，
    // 而它不该靠拼四条逐项记录才能答出来）；`LEGACY_ADOPTION_ITEM` 是**逐项**
    // 那几行回调的码。
    //
    // ★★ 这两个码**不是**一开始就长这样，那段历史必须留在这里，因为它是
    //    同一类错误的一个干净标本。最初的写法是：
    //
    //        code: `LEGACY_ADOPTION_${String(adoptionReading?.state ?? 'RUNNING').toUpperCase()}`
    //
    //    而那个回调是在 `runLegacyAdoption()` **运行期间**触发的——`adoptionReading`
    //    在那一刻**必然是 `undefined`**（它正是被这次调用的返回值赋值的）。
    //    于是逐项那几行**每一行**都叫 `LEGACY_ADOPTION_RUNNING`：一项明明接管成功、
    //    一项明明失败，码完全一样。
    //
    //    > 一个恒为 `RUNNING` 的码不是信息，是让人以为"这里能看出进度"的装饰。
    //
    //    这条缺口是被**门禁**咬出来的：`RUNNING` 这个名字以 `_RUNNING` 结尾、
    //    形如 env 键，于是 `scan --check` 报它未登记。如果当初照着报错把 `RUNNING`
    //    登记成一个"进度态"了事，那道门禁就从"发现了一个错误码"变成了"给这个错误
    //    盖章"——**登记一条字面量之前必须先问它是不是对的**。
    //    （本文件的第一版登记正是这么写的，已按事实改正。）
    'LEGACY_ADOPTION',
    'LEGACY_ADOPTION_ITEM',

    // ── PRT-251 续：`ports.runtime` 的**权威冲突**（阻塞启动）─────────────
    //
    // `product/process-manifest.mjs` 在 `runtime.command` 自带的 argv 里已经含
    // `--port` 时产出它。名字是 SCREAMING_SNAKE，但它不是 env 键：
    // 它是一条 **error 级诊断**的码，产品靠它决定"这次启动不许继续"。
    'PORT_AUTHORITY_CONFLICT',

    // ── PRT-251 续批：**同一个形状的另一面**——`--host` ────────────────────
    //
    // 与 `PORT_AUTHORITY_CONFLICT` 逐字同理：`runtime.command` 自带 `--host`
    // 而清单也声明了 `host` 时，两个值来源 ⇒ 「实际生效的是哪一个」取决于
    // argv 先后。它比端口那一面更隐蔽一点：宿主探测（`ports.mjs` 的 `canBind`）
    // 按**清单**的 host 走，于是「探测说 127.0.0.1 可用、而进程其实绑在别处」
    // 是可能的，且外部看不出差别。
    //
    // ⚠️ 注意这里**没有** `NO_OPEN_..._CONFLICT` 这种码，而且不该有：
    // `--no-open` 是**开关**，用户自己那条命令里已经有它时我们**跳过**、
    // **不报错**（重复一个开关不是两个答案，是同一个断言说了两遍）。
    // 把开关也按值旗标处理，会因为用户写了一句"不要开浏览器"就拒绝启动。
    'HOST_AUTHORITY_CONFLICT',

    // `product/launcher/tray-wiring.mjs` 的 `iconNoticeOf()` 在一份探测读数
    // 连 `code` 都没有时的兜底文案。它不是诊断码，是一个**占位**——
    // 一个说不出是哪种原因的读数也必须能印出来，而不是印出 `undefined`。
    'UNKNOWN',
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
    // ── PRT-214 续：Legion 身份注入 Runtime（组合根的生产调用方的输入）──────
    //
    // 组合根（`runtime/dsh-composition/root.mjs`）**只从进程环境读**这几项，
    // 不读配置文件、不给默认值。Launcher 是唯一知道前两项的进程。
    { target: 'runtime', env: 'TEAM_HUB_URL', via: 'env', from: 'ports.team-hub', note: '**派生值**：强制面必须指向本次启动的 hub，而不是某个默认 8787' },
    { target: 'runtime', env: 'LEGION_CWD', via: 'env', from: 'process-manifest 的 runtime.cwd', note: '**派生值**：就是 supervisor spawn 时用的工作目录——工具调用投影出的路径按它展开，覆盖会让授权路径与执行路径落在两个根上' },
    { target: 'runtime', env: 'LEGION_ACTOR', via: 'env', from: 'runtime.env', note: '授权主体。本批次没有别的权威来源，**不编默认值**：一个默认 actor 会让审计里的主体变成谁也不是的名字' },
    { target: 'runtime', env: 'LEGION_SCOPE', via: 'env', from: 'runtime.env', note: '同上：授权空间' },
    { target: 'runtime', env: 'LEGION_ENFORCEMENT_ACTION', via: 'env', from: 'runtime.env', note: '同上：本次执行的行动名。它进 canonical 授权哈希' },
    { target: 'runtime', env: 'LEGION_TASK_ID', via: 'env', from: 'runtime.env', note: '可选。组合根允许它是 null（进程级装配时常常还没有任务）' },
    { target: 'runtime', env: 'LEGION_APPROVAL_POLICY', via: 'env', from: 'runtime.env', note: '可选。session 级审批策略（ask / never）；缺了由 decide 在判定期 fail closed，不影响只读调用' },
    { target: 'runtime', env: 'LEGION_ATTENDED', via: 'env', from: 'runtime.env', note: '可选。现场有没有人可问；**刻意不给默认值**——默认"有人"会去问一个不在场的人' },
    { target: 'runtime', env: 'LEGION_PERMISSION_PRESET', via: 'env', from: 'runtime.env', note: '可选。权限档位名，给了就一起校验' },
    // ── PRT-253 续批四：Runtime Contract 的端点与凭证 ─────────────────────
    //
    // 这三条与上面那一组**不是同一类**：上面几项由 `runtime.env`（产品配置）
    // 提供，而下面这几项的来源是 **Launcher 自己**或**另一个子进程**——
    // 配置里给不出它们，也不该给得出（一个写进配置文件的凭证就不再是"每次启动一份"）。
    { target: 'runtime', env: 'LEGION_DATA_DIR', via: 'env', from: 'layout.dataDir', note: '**派生值**：契约端口发布写在它下面（`runtime/runtime-contract.json`）。写路径由冻结的目录布局决定，不由进程自己的默认值决定' },
    { target: 'runtime', env: 'LEGION_RUNTIME_TOKEN', via: 'env', from: 'Launcher 每次启动生成（node:crypto，32 字节 base64url）', note: '契约服务端的凭证。**每次启动一份**、**只注入 runtime 与 orchestrator**、**不落盘/不打印/不进状态文件**；生成失败就不注入（对端以 NO_TOKEN 拒绝），绝不注入空串或默认值' },
    { target: 'orchestrator', env: 'LEGION_DATA_DIR', via: 'env', from: 'layout.dataDir', note: '**派生值**：worker 的状态文件与端口发布的读取都以它为锚' },
    { target: 'orchestrator', env: 'LEGION_RUNTIME_URL', via: 'env', from: 'Runtime 进程发布的实际临时端口', note: '**派生值**（读回来、不是猜出来）：读端口发布并用**本次那个 runtime 子进程的 pid** 校验；读不到/对不上就**不注入**并记具名诊断——绝不回落成默认端口' },
    { target: 'orchestrator', env: 'LEGION_RUNTIME_TOKEN', via: 'env', from: 'Launcher 每次启动生成（与 runtime 同一份）', note: '与 runtime 进程逐字相同的凭证。**只**注入这两个进程' },
    // ── 第 118 轮第七轮：收账侧宿主的**目录锚**（与上面那组同一来源，不是猜的）──
    //
    // ★ hub 与 runtime/orchestrator 是**同一份进程清单里的兄弟进程**，用的是同一个
    //   冻结目录布局（`layout.dataDir`）⇒ 这一行是**派生值**，与 :1057 / :1059 同源。
    // ★ 但**只给目录、不给凭证**：hub 的活是收账（把执行面写下的 spool 收进
    //   `tool_calls`），它不执行任何工具。凭证那一行的理由是 spec §6.7
    //   「密钥只注入需要它的执行进程」，hub 不在其中。
    { target: 'team-hub', env: 'LEGION_DATA_DIR', via: 'env', from: 'layout.dataDir', note: '**派生值**：收账侧（`team-hub/toolcall-sweep.mjs`）按它找 `toolcall-spool/`。★ 库的位置（`TEAM_HUB_DB`）与车道的位置是**两个锚** —— 刻意**不从库的位置派生**：那种隐式耦合断了只会表现为一条"空读数"（空目录是合法局面，收账会"成功地"什么也没收）' },
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
    // ★ PRT-253 续批四：`LEGION_RUNTIME_TOKEN` 是**唯一**一条由本进程生成、
    //   并且只注入两个子进程的凭证。它的三条纪律写在
    //   `product/launcher/runtime-contract-endpoint.mjs` 的
    //   `generateRuntimeToken` 上：每次启动一份 / 失败就不注入 / 值不进任何可读输出。
    //
    //   为什么"端口"没有对应的环境变量：监听器绑的是**临时端口**，
    //   所以没有任何一侧能在 spawn 之前知道它——端口走"Runtime 进程发布
    //   → Launcher 读回并校验 pid"，不走进"Launcher 派生一个值写进环境"。
    //   两条路的取舍写在
    //   `runtime/dsh-composition/runtime-contract-publication.mjs` 的文件头。
  ],
})

export default SCHEMA
