#!/usr/bin/env node
// product/launcher/cli.mjs
// ============================================================================
// Legion Launcher 命令行入口（PRT-251）
//
//   node product/launcher/cli.mjs --check          # 只体检，不启动任何进程
//   node product/launcher/cli.mjs                  # 按波次启动，Ctrl+C 优雅停止
//   node product/launcher/cli.mjs --include=team-hub,workbench --json
//
// ## 为什么 `--check` 是一个**独立且优先**的用法
//
// Launcher 的失败模式大多是「起了一半」：team-hub 好了、workbench 没起来，
// 界面能开、数据是空的。这种状态产生副作用（占了端口、建了库、留下半启动进程），
// 而排查它比排查「完全起不来」贵得多。`--check` 把「确定性的错误」提前到
// 不产生任何副作用的阶段回答：端口、入口、依赖环、目录边界。
//
// ## 环境变量的可见性
//
// 本文件**逐字读取**每一个它支持的 LEGION_* 变量（`process.env.LEGION_HOME` 这种写法），
// 而不是 `env[LEGION_ENV.HOME]` 这样的计算访问——因为 `scripts/config/scan.mjs` 只能
// 看见字面访问，计算访问会让这些读取点**完全不出现在配置面扫描结果里**。
// `product/paths.mjs` 内部用的正是计算访问（那样才不会有拼写漂移），
// 所以「让读取点可见」这件事必须在调用方做到。
// 读取点与注入点一并声明在 `product/config-schema.mjs`。
// ============================================================================

import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

import { LEGION_ENV, resolveLayout } from '../paths.mjs'
import { DSH_CREDENTIALS_FILENAME } from '../../security/secrets/index.mjs'
import { launcherInputFromConfig, loadProductConfig } from '../config.mjs'
import { AUTO_EXPORT_DEFAULTS, runAutoExport } from '../diagnostics/auto-export.mjs'
import { initializeProductDir, isInitialized } from '../init.mjs'
import { createLauncher, PRODUCT_STATE_TEXT } from './launcher.mjs'
import { DEFAULT_BACKOFF } from './supervisor.mjs'

/**
 * 安装目录的默认值：**Launcher 自己所在的那棵树**。
 *
 * 这是 Launcher 唯一比别人多知道的一件事——它就在安装目录里。
 * 若要求用户必须显式设置 `LEGION_INSTALL_DIR`，则「双击启动」这个最基本的用法
 * 会在第一步就报 `INSTALL_DIR_UNRESOLVED`（本条注释的上一版就是这样，实测出来的）。
 * 优先级仍是 显式 CLI > 环境变量 > 本默认值。
 */
export function defaultInstallDir(moduleUrl = import.meta.url) {
  // product/launcher/cli.mjs → product/launcher → product → 安装根
  return fileURLToPath(new URL('../../', moduleUrl)).replace(/[\\/]+$/, '')
}

/** 支持的 CLI 参数（也是 `--help` 的唯一来源）。 */
export const CLI_FLAGS = Object.freeze([
  { name: '--check', kind: 'boolean', doc: '只做启动前体检（端口/入口/依赖/目录边界），不启动任何进程' },
  { name: '--init', kind: 'boolean', doc: '首次运行初始化：建目录、写默认产品配置与产品元数据，然后退出（不启动进程）' },
  { name: '--dry-run', kind: 'boolean', doc: '与 --init 同用：只报告将会创建什么，不落盘' },
  { name: '--no-config', kind: 'boolean', doc: '忽略产品配置文件（只用内置默认值 + env + CLI）' },
  { name: '--no-dsh-credentials', kind: 'boolean', doc: '不把 DSH 的 $DSH_HOME/.credentials.yaml 当作**只读**回退来源（PRT-509 路线 A′）。' +
    '**默认是读的**（当 DSH_HOME 已设时）：只有 Legion 自己的密钥库里**没有这条**才会去读它，' +
    '结果里带出处；Legion 的库仍然是唯一的权威写入路径。' +
    '给这一条留一个显式退出，是因为"读一个属于另一个程序的、里面全是明文的文件"应当可以被拒绝' },
  { name: '--json', kind: 'boolean', doc: '以 JSON 输出结果（供脚本与验收使用）' },
  { name: '--install-dir=<path>', kind: 'value', doc: `安装目录；等价于 ${LEGION_ENV.INSTALL_DIR}` },
  { name: '--data-dir=<path>', kind: 'value', doc: `数据目录；等价于 ${LEGION_ENV.DATA_DIR}` },
  { name: '--workspace=<path>', kind: 'value', doc: `工作区目录；等价于 ${LEGION_ENV.WORKSPACE_DIR}` },
  { name: '--port.<进程>=<n>', kind: 'value', doc: '覆盖某进程端口，如 --port.team-hub=9000' },
  { name: '--include=<a,b>', kind: 'value', doc: '只启动列出的进程（受限范围；产品状态不会被报成「已就绪」）' },
  { name: '--runtime-command=<cmd>', kind: 'value', doc: 'DSH Runtime 的启动命令行（PRT-011 路线 C：Launcher 把 npm 包装进 DataDir）' },
  { name: '--allow-port-in-use=<a,b>', kind: 'value', doc: '允许复用已在监听的端口的进程（显式决定，不是默认行为）' },
  { name: '--diagnostics=<dir>', kind: 'value', doc: '导出脱敏诊断包到指定目录（PRT-710）。' +
    '**这是唯一在体检/配置/布局出问题时仍然可用的入口**：诊断包最需要在产品坏掉的时候拿到' },
  { name: '--no-auto-diagnostics', kind: 'boolean', doc: '关掉「启动失败时自动留诊断包」（PRT-710）。' +
    '**默认是开的**：诊断包只写在本机 `<产品家目录>/diagnostics/`，不外发，' +
    '而它的全部价值就在于"用户没想起来的时候它也在"。给这一条留一个显式退出' },
  { name: '--auto-diagnostics-keep=<n>', kind: 'value', doc: '自动导出的保留份数（默认 3，最小 1）。' +
    '自动写盘意味着**失败循环里自动写盘**，这个数字就是磁盘上界' },
  { name: '--heartbeat-consent=<who>', kind: 'value', doc: '记录"谁同意了发送健康心跳"（PRT-713）。' +
    '**这是产品里唯一能产生同意这个值的入口**；同意写在本机 `<产品家目录>/heartbeat-consent.json`，' +
    '**不放在配置文件里**——跟着配置走的同意会被复制到别的机器上，而那里没人同意过' },
  { name: '--heartbeat-revoke-consent', kind: 'boolean', doc: '撤回心跳同意（与 --heartbeat-consent=<who> 同用）。' +
    '撤回**不删记录**，而是写下一条撤回：一份被删掉的同意与一份从来没有过的同意，事后是同一个东西' },
  { name: '--log-policy', kind: 'boolean', doc: '打印当前生效的日志策略（PRT-709）。' +
    '每个值都带**来源**——"值是多少"与"这个值是谁给的"必须一起说，' +
    '否则「我改了但没生效」是一个无法回答的问题' },
  { name: '--set-log-policy=<k=v,...>', kind: 'value', doc: '改日志策略并写入产品配置文件（PRT-709）。' +
    '键：maxFileBytes / maxTotalBytes / keepFiles / minFreeBytes。' +
    '**先校验再写**；配置坏了则拒绝改写（那会把用户原来的内容永久弄没）' },
  { name: '--wizard', kind: 'boolean', doc: '跑一次首次运行向导（PRT-707）：环境 → 目录 → 启动 → 配模型 → 实测 →（可选）心跳 → 完成。' +
    '**只有实测通过才报完成**；最后一步「健康心跳」是**可选项**，不回答也照样走完' },
  { name: '--wizard-consent=<who>', kind: 'value', doc: '（PRT-707）在向导里**预先**回答「愿意发送健康心跳」，署名为 <who>。' +
    '不给这个参数 = 没有回答这一项 = 心跳保持关闭，且**不会写下任何同意记录**' },
  { name: '--wizard-reset', kind: 'boolean', doc: '（PRT-707）丢掉向导的断点进度，从头开始。**不删除任何产品数据**。' +
    '结论（"某一步已经过了"）本来就不会被恢复，重置的只是位置' },
  { name: '--sweep-orphans', kind: 'boolean', doc: '启动前清理上一次运行留下的进程（PRT-705）。' +
    '**默认只报告不清理**：杀进程不可撤销。清理前会核对映像名，对不上的一律不动' },
  { name: '--allow-unverified-sweep', kind: 'boolean', doc: '与 --sweep-orphans 同用：' +
    '连映像名读不出来的那些也清理。**不建议**——那正是「按号码杀」的那条路' },
  { name: '--help', kind: 'boolean', doc: '打印本说明' },
])

// 两份名单**从 `CLI_FLAGS` 派生**，不再手工维护。
//
// 原来这里是 `const BOOLEAN_FLAGS = [...]` 加 `parseArgs` 里一个独立的
// `known` 数组。那份注释甚至写着：
//
//   「列在这里而不是散在 if 里：新开关漏加会让它被当成未知参数。」
//
// 而 PRT-705 加 `--sweep-orphans` 时**照样漏了**——注释警告的正是这件事，
// 写注释的人自己也踩了。这不是记性问题，是结构问题：
// 一份要写两处的名单，第二处总有一天会忘。
//
//   > 一个必须靠人记得去同步的名单，与一个迟早会不同步的名单，
//   > 在"新加的开关能不能用"上是同一个东西。
//
// 现在加一个开关只需要动 `CLI_FLAGS` 一处；它还同时是 `--help` 的正文，
// 所以"能用的"与"文档里写的"不会再分成两件事。
const BOOLEAN_FLAGS = Object.freeze(CLI_FLAGS
  .filter((f) => f.kind === 'boolean' && !f.name.includes('='))
  .map((f) => f.name.replace(/^--/, '')))

/** 取值开关的键名（`--install-dir=<path>` → `install-dir`）。同样派生。 */
const VALUE_FLAG_KEYS = Object.freeze(CLI_FLAGS
  .filter((f) => f.kind === 'value' && f.name.includes('='))
  .map((f) => f.name.replace(/^--/, '').split('=')[0])
  .filter((k) => k !== 'port' && !k.startsWith('port.')))

/**
 * 解析 argv。**只接受 `--k=v` 与布尔开关**，不接受位置参数：
 * 位置参数的含义随「第几个」变化，是脚本化调用最容易出错的地方。
 */
export function parseArgs(argv) {
  const out = { ports: {}, flags: {}, errors: [] }
  for (const raw of argv) {
    if (raw.startsWith('--') && BOOLEAN_FLAGS.includes(raw.slice(2))) {
      out.flags[raw.slice(2)] = true
      continue
    }
    const eq = raw.indexOf('=')
    if (!raw.startsWith('--') || eq < 0) {
      // 报错信息从名单生成：硬编码的"支持 --check/--json/--help"已经有过一次
      // 与真实名单不一致的历史，而那句话是用户唯一能看到的线索。
      out.errors.push(`无法识别的参数「${raw}」：本 CLI 只接受 --key=value 形式与 `
        + BOOLEAN_FLAGS.map((f) => `--${f}`).join('/'))
      continue
    }
    const key = raw.slice(2, eq)
    const value = raw.slice(eq + 1)
    if (key.startsWith('port.')) {
      const proc = key.slice('port.'.length)
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        out.errors.push(`--port.${proc}=${value} 不是合法端口（0..65535）`)
        continue
      }
      out.ports[proc] = port
      continue
    }
    if (!VALUE_FLAG_KEYS.includes(key)) {
      out.errors.push(`未知参数「--${key}」：用 --help 查看支持的参数`)
      continue
    }
    out.flags[key] = value
  }
  return out
}

/**
 * 从环境变量读取 Launcher 自己的配置。
 *
 * 每个键**逐字**出现一次。这样做有一个副作用是好的：`scan --check` 能列出
 * 这个进程到底读哪些变量，而「Launcher 会读哪些环境变量」正是运维最需要知道的清单。
 */
export function readEnv(env = {}) {
  return {
    [LEGION_ENV.HOME]: env.LEGION_HOME,
    [LEGION_ENV.INSTALL_DIR]: env.LEGION_INSTALL_DIR,
    [LEGION_ENV.DATA_DIR]: env.LEGION_DATA_DIR,
    [LEGION_ENV.WORKSPACE_DIR]: env.LEGION_WORKSPACE_DIR,
    [LEGION_ENV.CACHE_DIR]: env.LEGION_CACHE_DIR,
    [LEGION_ENV.LOG_DIR]: env.LEGION_LOG_DIR,
    [LEGION_ENV.PRODUCT_CONFIG]: env.LEGION_PRODUCT_CONFIG,
  }
}

/** 就绪超时可由环境覆盖（它是配置项，不是硬编码；spec §6.4）。 */
export function readReadinessTimeoutMs(env = {}) {
  const raw = env.LEGION_READINESS_TIMEOUT_MS
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

export const LEGION_READINESS_TIMEOUT_ENV = 'LEGION_READINESS_TIMEOUT_MS'

/**
 * 操作系统级的家目录事实（不是 Legion 的配置，是它必须读的环境）。
 *
 * 这三个变量属于**操作系统/用户会话**，不属于 Legion —— 因此它们是
 * `foreignEnv`（登记在 `product/config-schema.mjs`），不是本进程的配置项。
 */
export const OS_HOME_ENV = Object.freeze({
  LOCAL_APP_DATA: 'LOCALAPPDATA',
  USER_PROFILE: 'USERPROFILE',
  HOME: 'HOME',
})

/**
 * 从**进程环境**推出家目录事实，交给 `resolveLayout`。
 *
 * ## 为什么这件事必须在这里做（PRT-255 实测抓到的缺陷）
 *
 * `resolveLayout` 的签名里一直有 `homeDir` / `appDataDir` 两个入参，
 * 而 `defaultProductHome` 在拿不到它们时会返回 `root: null`。可是**唯一的生产
 * 调用方从来没有传过它们**——于是产品家目录永远是 null，`secretsFile` 永远是
 * null，接着每一次启动都被 `SECRETS_PLACEMENT_INVALID` 拒绝。
 *
 * 实测形态：用文档上的那几个开关（`--install-dir` / `--data-dir` / `--workspace`）
 * 装完之后，`--init` 成功、诊断包能导出，**而产品根本起不来**：
 *
 *   > 一个「装得上、也导得出诊断包」的产品，
 *   > 与一个「装完起不来」的产品，是同一个东西——
 *   > 只不过前者在"安装成功"这个返回值上是完全正确的。
 *
 * ## 优先级
 *
 * `LEGION_HOME`（受控环境变量，显式覆盖）> 操作系统事实 > 未解析。
 * 显式覆盖这一条不受本函数影响：它由 `resolveLayout` 内部的 `defaultProductHome`
 * 先判，所以"部署时设的 LEGION_HOME 不生效"这种倒置不会发生。
 */
export function osHomeFacts(env = {}) {
  const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)
  return {
    appDataDir: nonEmpty(env[OS_HOME_ENV.LOCAL_APP_DATA]),
    // POSIX 上是 HOME，Windows 上是 USERPROFILE；两者都给，由
    // `defaultProductHome` 按 platform 决定怎么用。
    homeDir: nonEmpty(env[OS_HOME_ENV.USER_PROFILE]) ?? nonEmpty(env[OS_HOME_ENV.HOME]),
  }
}

/**
 * DSH 的家目录变量名。**DSH 自己**用它定位 `.credentials.yaml`。
 *
 * 它登记在 `product/config-schema.mjs` 的 `CHILD_ENV_NAMES` 里——原本只是
 * 「注入给 Runtime 子进程的变量名」。PRT-509 路线 A′ 之后它**也**是本进程的
 * 读取点，所以那份登记的理由跟着改了一句（`scan --check` 只看字面量是否
 * 登记过，有没有被读它管不着——登记理由漂了它不会报，只能靠这句话守着）。
 */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * 从进程环境推出**DSH 凭证文件的路径**（PRT-509 路线 A′）。
 *
 * ## 为什么只有一句 `join`，却值得单独一个函数
 *
 * 因为"要不要读一个**别人**拥有的、里面全是明文的文件"是一个**决策**，
 * 而决策必须有唯一一个能被引用、被测试、被讨论的位置。散落在两个
 * `openProductSecrets` 调用点里的路径拼接，事后没人说得清"产品到底会不会
 * 去读 DSH 的文件"。
 *
 * ## 三条边界
 *
 *   ① **只认 `DSH_HOME`**，不猜路径。用户为 DSH 设了哪个目录，就读那个目录
 *      ——不去翻 `%USERPROFILE%\.dsh` 之类的候选位置。猜路径会读到
 *      "另一个账户留下的、当前用户并不知道存在的"凭证文件。
 *   ② **`DSH_HOME` 没设就没有回退来源**（返回 `null`）。这与"设了但文件不在"
 *      是两个不同的读数，由读取器自己的 `inspect()` 分开报。
 *   ③ **它只给出路径**，读取与拒绝全在 `security/secrets/dsh-credentials.mjs`。
 *      这一层不解析、不校验、不碰文件内容。
 *
 * @param {object} env 进程环境。
 * @returns {string|null} `.credentials.yaml` 的绝对路径；`DSH_HOME` 未设时为 `null`。
 */
export function dshCredentialsFileFrom(env = {}) {
  const home = env[DSH_HOME_ENV]
  if (typeof home !== 'string' || home.trim() === '') return null
  return join(home, DSH_CREDENTIALS_FILENAME)
}

/**
 * 组装 Launcher 选项（把 CLI、环境与产品配置文件合成**一份显式输入**）。
 *
 * ## 优先级（spec §6.11 + CLI 的位置）
 *
 * ```
 * 内置默认值 < 产品配置 < 工作空间配置 < 用户设置 < 受控环境变量 < 命令行
 * ```
 *
 * 前三层与 env 的次序就是 spec 定的（`mergeConfigLayers` 只认这一种次序）。
 * **命令行排在最后**是这里的补充：`--port.team-hub=9000` 是「就这一次，用 9000」，
 * 若被配置文件里的值压过去，用户没有任何办法临时改一次——只能去编辑文件再改回来。
 *
 * ## 为什么把配置文件诊断一起返回
 *
 * 配置文件的失败几乎全是静默的（键名写错、JSON 多一个逗号）。它们必须在
 * **创建 Launcher 之前**被看见并阻塞：带着半份配置启动的结果是「用户以为设置生效了」。
 */
export function launcherOptionsFrom({ argv = [], env = {}, nodePath = process.execPath, configLoader = loadProductConfig, installDirDefault = defaultInstallDir } = {}) {
  const parsed = parseArgs(argv)
  const declared = readEnv(env)
  // ★ 把操作系统事实传进去（PRT-255 实测抓到的缺陷：这两个入参一直存在，
  //   而唯一的生产调用方从来没传过，于是产品家目录恒为 null → 起不来）。
  const osHome = osHomeFacts(env)
  const { layout, diagnostics } = resolveLayout({
    installDir: parsed.flags['install-dir'] ?? declared[LEGION_ENV.INSTALL_DIR] ?? installDirDefault(),
    dataDir: parsed.flags['data-dir'] ?? null,
    workspaceDir: parsed.flags.workspace ?? null,
    homeDir: osHome.homeDir,
    appDataDir: osHome.appDataDir,
    env: declared,
  })

  const config = parsed.flags['no-config'] === true
    ? { ok: true, merged: null, diagnostics: [], paths: {}, layers: [] }
    : configLoader(layout, { envValues: {} })
  const fromConfig = launcherInputFromConfig(config.merged ?? null)

  // ★ PRT-710 收尾：自动导出**默认开着**，`--no-auto-diagnostics` 是显式的退出。
  //
  //   为什么默认开：诊断包只写在本机 `<产品家目录>/diagnostics/`、不外发，
  //   而这一整条任务的定位是"最需要在产品坏掉的时候拿到"。默认关的话，
  //   它就退化成"用户可以手工敲 --diagnostics"，而这正是它要补上的那一步。
  //
  //   只留一个**关**的开关（不留"开"的开关）：一个已经是默认值的 `--auto-diagnostics`
  //   是一个**没有任何效果的参数**，而一个没有效果的参数比没有这个参数更坏——
  //   它会让读命令行的人以为"这件事是要显式打开的"。
  //
  //   ⚠️ 它必须定义在 `run()` 里，不是 `launcherOptionsFrom()` 里：
  //   第一版我按 `const fromConfig = ...` 定位、插错了函数，于是启动失败那条路
  //   报 `ReferenceError: autoDiagnostics is not defined`——**只在真的启动失败时才崩**。
  //   一个"只在出错路径上才崩"的变量引用，在跑得通的运行里与一个正确的实现同形。

  const include = parsed.flags.include === undefined
    ? null
    : String(parsed.flags.include).split(',').map((s) => s.trim()).filter(Boolean)
  const allowPortInUse = parsed.flags['allow-port-in-use'] === undefined
    ? []
    : String(parsed.flags['allow-port-in-use']).split(',').map((s) => s.trim()).filter(Boolean)
  const readinessTimeout = readReadinessTimeoutMs(env)

  // 命令行 > 配置文件。CLI 只覆盖它显式给出的键，其余仍由配置文件决定。
  const ports = { ...fromConfig.ports, ...parsed.ports }
  const runtimeCommand = parsed.flags['runtime-command'] ?? fromConfig.runtimeCommand ?? null

  return {
    parsed,
    layout,
    layoutDiagnostics: diagnostics,
    config,
    configDiagnostics: config.diagnostics ?? [],
    options: {
      layout,
      ports,
      include,
      allowPortInUse,
      runtimeCommand,
      nodePath,
      // 日志策略（PRT-709）来自产品配置文件的 `log.*` 键。
      // 缺省时是 `{}`，由 `validateLogPolicy` 落到 `DEFAULT_LOG_POLICY`。
      // **不在这里补默认值**：补一份就多一处会漂移的副本，而"哪一份生效"
      // 在排查时会成为一个必须回答的问题。
      logPolicy: fromConfig.logPolicy ?? {},
      // 健康心跳（PRT-713 收尾）来自产品配置文件的 `heartbeat.*` 键。
      // 缺省 `{}` → `enabled !== true` → **不装配、不建 transport、不发任何东西**。
      //
      // ★ 配置里**没有** `heartbeat.consent`：同意必须来自这台机器上的
      //   同意记录文件（见 `heartbeat-consent.mjs` 的文件头），
      //   由 Launcher 自己去读。配置文件里给不出一个可信的同意。
      heartbeatPolicy: fromConfig.heartbeatPolicy ?? {},
      // PRT-257：DSH 强制面覆盖层。`undefined` = 配置里没写 → 由
      // `resolveDshOverlay` 的默认参数落到 `true`（**默认装上**）。
      // 这里刻意写 `?? true` 而不是留 `undefined`：`createLauncher` 的默认值是
      // `true`，但把这份默认值显式写在一个地方，读代码的人不必去翻两层默认值。
      enforcementOverlay: fromConfig.enforcementOverlay ?? true,
      // PRT-214 续：注入 Runtime 子进程的 Legion 身份。取自产品配置键
      // `runtime.env`（既有键）。缺了必填项会由 `resolveEnforcementIdentity`
      // 报 `ENFORCEMENT_IDENTITY_MISSING` 并拦下启动——
      // **不在这一层补默认值**：一个默认 actor 会让审计里的主体变成谁也不是的名字。
      runtimeEnv: fromConfig.runtimeEnv ?? {},
      // PRT-705：清理**必须显式要求**，所以这里是 === true 而不是真值判断。
      // 一个"默认会杀进程"的启动路径，与一个会在用户没要求时动手的路径，
      // 在"用户能不能预料到发生了什么"上是同一个东西。
      sweepOrphansOnStart: parsed.flags['sweep-orphans'] === true,
      allowUnverifiedSweep: parsed.flags['allow-unverified-sweep'] === true,
      // Launcher 自己的环境只作为**白名单的读取来源**传入，不会被整份复制给子进程
      baseEnv: env,
      // PRT-509 路线 A′：**只读**回退来源的路径。`null` = 这次没接
      // （`DSH_HOME` 没设，或用 `--no-dsh-credentials` 显式关掉）。
      //
      // 与 `baseEnv` 一样，这里只**给出路径**：读取、子集判定与拒绝全在
      // `security/secrets/dsh-credentials.mjs`，这一层不碰文件内容。
      dshCredentialsFile: parsed.flags['no-dsh-credentials'] === true
        ? null
        : dshCredentialsFileFrom(env),
      readiness: readinessTimeout === null
        ? (fromConfig.readinessTimeoutMs === undefined ? {} : { timeoutMs: fromConfig.readinessTimeoutMs })
        : { timeoutMs: readinessTimeout },
    },
  }
}

function printDiagnostics(diagnostics, write = console.log) {
  for (const d of diagnostics) {
    const tag = d.severity === 'error' ? '✖' : '⚠'
    const proc = d.process === undefined || d.process === null ? '' : `[${d.process}] `
    write(`  ${tag} ${proc}${d.code}：${d.message}`)
  }
}

/** 向导写模型密钥用的引用名。**只有名字，没有值。** */
const MODEL_KEY_REF = 'model/api-key'
const MODEL_NAME_REF = 'model/name'

/** 主流程。返回进程退出码（0 成功）。 */
export async function run({
  argv = process.argv.slice(2), env = process.env, write = console.log, waitForSignal = true,
  // ★ PRT-710 收尾：这两个是可注入的**接缝**，默认就是真实实现。
  //
  //   为什么需要它们：启动失败这条路要用例去走，而"让一次真实启动失败"
  //   意味着起真实子进程、等它就绪超时——慢、依赖机器状态，而且它的失败
  //   方式与产品是否正常无关。一个"只在机器恰好很慢时才走到"的分支，
  //   等于**没有被测**。
  //
  //     > 一个"靠构造真实故障才走得到"的分支，
  //     > 与一个"没有测试能走到"的分支，在覆盖率上看起来不一样——
  //     > 只不过前者的绿是**机器当时心情好**换来的。
  //
  //   注入的是"启动器工厂"而不是"启动结果"：这样 `start()` 的失败形状
  //   仍然由真实的 `createLauncher` 契约决定，测试只换掉**谁来起进程**。
  createLauncherFn = createLauncher,
  autoExportFn = runAutoExport,
} = {}) {
  if (argv.includes('--help')) {
    write('Legion Launcher（PRT-251）')
    write('')
    for (const f of CLI_FLAGS) write(`  ${f.name.padEnd(30)} ${f.doc}`)
    return 0
  }

  const { parsed, options, layoutDiagnostics, config, configDiagnostics } = launcherOptionsFrom({ argv, env })
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) write(`✖ ${e}`)
    return 2
  }

  const json = parsed.flags.json === true

  // ★ PRT-710 收尾：自动导出**默认开着**，`--no-auto-diagnostics` 是显式的退出。
  //
  //   为什么默认开：诊断包只写在本机 `<产品家目录>/diagnostics/`、不外发，
  //   而这一整条任务的定位是"最需要在产品坏掉的时候拿到"。默认关的话，
  //   它就退化成"用户可以手工敲 --diagnostics"，而这正是它要补上的那一步。
  //
  //   只留一个**关**的开关（不留"开"的开关）：一个已经是默认值的 `--auto-diagnostics`
  //   是一个**没有任何效果的参数**，而一个没有效果的参数比没有这个参数更坏——
  //   它会让读命令行的人以为"这件事是要显式打开的"。
  const autoDiagnostics = parsed.flags['no-auto-diagnostics'] !== true

  // ── 首次运行向导（PRT-707 收尾）──────────────────────────────────────
  //
  // 这一支存在的理由是 PRT-707 正文里那条**最大**的诚实边界：
  // 「向导是状态机……但**没有任何 UI 或 CLI 子命令在用它**」。
  //
  // 接上之后那句话要改写成："**CLI 是终端，所以"不打开终端"这个完成标准
  // 仍然没有达成**"——但"零调用方"这件事结束了。
  // 一个只有测试会调用的状态机，它的每一次改动都只能靠读代码来确认。
  //
  // ★ 密钥**不从 argv 读**。
  //   `--wizard-model-key=sk-xxx` 会进 shell 历史、会出现在 `ps` 的输出里、
  //   会被 CI 的日志系统抄走。所以只从 stdin 读，且**不提供** argv 变体——
  //   因为那种变体一定会被用，而用它的那一刻泄漏看起来像是用户自己选的。
  //
  // ★ `--wizard-consent=<who>` 是 argv 参数，这是**刻意**的：
  //   它是个署名（"张三"），不是秘密；而把它也塞进 stdin
  //   会让"我想开通心跳"这件事在脚本化时变得没法表达。
  if (parsed.flags.wizard === true) {
    const { runWizardCli, createStdinReader, heartbeatConsentAction, wizardOptionsFrom } =
      await import('./wizard-cli.mjs')
    const { createLauncher } = await import('./launcher.mjs')

    const consentWho = typeof parsed.flags['wizard-consent'] === 'string'
      ? parsed.flags['wizard-consent']
      : null
    const lines = []
    const writeLine = (m) => { lines.push(String(m)); if (!json) write(String(m)) }

    // 先把"预先回答"喂进那一步。**只有给了 `--wizard-consent` 才算回答过。**
    //
    //   这条区分是这一支最要紧的地方：不给参数**不等于**"用户选了不要"，
    //   它是"没有回答这一项"。两者都不写同意记录，但只有后者会被记成
    //   "问过了"——而"心跳没开"到底是"用户拒绝"还是"向导没问"，
    //   要修的地方完全不同。
    //
    //   ★ 翻译逻辑在 `wizardOptionsFrom` 里，且由用例**直接断言它的产出**。
    //     写在这里的话，用例只能拿正则匹配源码文本——而把整段删掉、
    //     只要那几个词还留在注释里，那种断言照样绿。
    const wizardOptions = wizardOptionsFrom({
      consentWho, flags: parsed.flags, layout: options.layout,
    })
    const stepActions = {
      'heartbeat-consent': heartbeatConsentAction({ layout: options.layout }),
    }

    let result = null
    try {
      result = await runWizardCli({
        layout: options.layout,
        write: writeLine,
        // 没有 tty 时 `readLine` 会返回 `null`（读不到），而不是空字符串。
        readLine: createStdinReader(),
        stepActions,
        askOptIn: wizardOptions.askOptIn,
        presetOptIn: wizardOptions.presetOptIn,
        reset: wizardOptions.reset,
        wizardDeps: {
          // 生产依赖：全部指向真实模块，界面不替它造默认值。
          checkEnvironment: async () => {
            const { layoutDiagnostics, hasBlockingDiagnostic } = await import('../paths.mjs')
            const diags = layoutDiagnostics(options.layout)
            return hasBlockingDiagnostic(diags) === true
              ? { ok: false, message: `目录布局不满足要求：${diags.filter((d) => d.severity === 'error').map((d) => d.message).join('；')}` }
              : { ok: true, message: '运行环境满足要求' }
          },
          initialize: async () => {
            // 目录由 `resolveLayout` 解析出来，实际创建由 Launcher 的启动路径负责；
            // 这一步只确认"写进去不会被拒"。
            const { assertLayoutUsable } = await import('../paths.mjs')
            try {
              assertLayoutUsable(options.layout)
              return { ok: true, message: '产品目录可用' }
            } catch (e) {
              return { ok: false, message: `产品目录不可用：${e instanceof Error ? e.message : e}` }
            }
          },
          start: async () => {
            const l = createLauncher(options)
            const r = await l.start()
            if (r?.ok !== true) {
              const codes = (r?.diagnostics ?? []).filter((d) => d.severity === 'error').map((d) => d.code)
              // ★ 不在这里加"启动没有成功：" 这句前缀——向导自己会加
              //   （`${def.title}没有成功：…`），加两次会变成
              //   "启动组件没有成功：启动没有成功：ENTRY_UNRESOLVED"。
              //   一句话里同一个意思出现两遍，读的人会以为发生了两件事。
              return { ok: false, message: codes.join('；') || '没有给出原因' }
            }
            return { ok: true, message: '组件已启动并就绪' }
          },
          // 模型密钥的落地：写进**密钥库**（不写配置文件）。
          submitModelConfig: async (v) => {
            if (typeof v?.apiKey !== 'string' || v.apiKey === '') {
              return { ok: false, message: '缺少模型密钥' }
            }
            const { openProductSecrets } = await import('../secrets.mjs')
            // ★ 向导里**必须**要求受保护后端：一个"配好了"却存在明文里的密钥，
            //   是这一整条流程最坏的结果——用户以为安全，而它只是没报错。
            //
            // 这里**刻意不传 `dshCredentialsFile`**：本函数要**写**，
            // 而路线 A′ 的回退来源是**只读**的，写路径永远只写 Legion 自己的库。
            // 传进来只会让"我写了，它去哪了"变成一个需要解释的问题。
            const opened = await openProductSecrets({ layout: options.layout, requireProtected: true })
            if (opened?.ok !== true) {
              return { ok: false, message: `密钥库不可用：${opened?.message ?? '未知原因'}` }
            }
            try {
              // 引用名不带任何供应商信息之外的东西；**值不进诊断**。
              await opened.store.put(MODEL_KEY_REF, v.apiKey, { purpose: 'model' })
              if (typeof v.model === 'string' && v.model !== '') {
                await opened.store.put(MODEL_NAME_REF, v.model, { purpose: 'model' })
              }
            } catch (e) {
              return { ok: false, message: `密钥没有写进密钥库：${e instanceof Error ? e.message : e}` }
            }
            return { ok: true, message: '模型密钥已存进密钥库（没有写进配置文件）' }
          },
          isModelConfigured: async () => {
            const { openProductSecrets } = await import('../secrets.mjs')
            let opened = null
            // 同理不传回退来源：这一条问的是 `store.has(...)`——
            // "Legion 自己的库里录过这个引用名吗"。它问的**不是**解析器，
            // 所以回退来源在这里既用不上、也不该被接上：
            // 一个从 DSH 文件读到的值**不构成**"向导配过模型"。
            try { opened = await openProductSecrets({ layout: options.layout, requireProtected: true }) } catch { return false }
            if (opened?.ok !== true) return false
            try { return opened.store.has(MODEL_KEY_REF) === true } catch { return false }
          },
        },
      })
    } catch (e) {
      writeLine(`✖ 向导抛错：${e instanceof Error ? e.message : e}`)
      return 9
    }

    if (json) {
      write(JSON.stringify({
        ok: result.ok === true, code: result.code ?? null,
        step: result.result?.blockedStep ?? result.result?.step ?? null,
        done: result.result?.done === true,
        message: result.result?.message ?? null,
        lines,
      }, null, 2))
    }
    return result.ok === true ? 0 : 9
  }

  // ── 日志策略：查看 / 修改（PRT-709 收尾）──────────────────────────────
  //
  // 位置与诊断包、同意同一条理由：**排在配置校验之前**。
  //
  // 这一条尤其要紧：一个"配置有问题"的产品，最需要用户能**看一眼现在的值**。
  // 把这两个入口挂在"配置能解析才往下走"的流程后面，等于
  // **恰恰在配置坏掉的时候**不让他看配置——而那时他唯一能做的补救
  // 就是猜。
  //
  //   > 一个只在配置正确时才可用的配置查看器，
  //   > 与一个不存在的配置查看器，在用户最需要它的那一刻是同一个东西。
  if (parsed.flags['log-policy'] === true || typeof parsed.flags['set-log-policy'] === 'string') {
    const { applyLogPolicy, describeLogPolicy, effectiveLogPolicy, LOG_CLI_CODES, parsePolicyAssignments } =
      await import('./log-policy-cli.mjs')
    const configPath = options.layout?.productConfigPath ?? null

    if (typeof parsed.flags['set-log-policy'] === 'string') {
      const parsedValues = parsePolicyAssignments(parsed.flags['set-log-policy'])
      if (parsedValues.ok !== true) {
        if (json) write(JSON.stringify({ ok: false, code: parsedValues.code, message: parsedValues.message }, null, 2))
        else write(`✖ ${parsedValues.message}`)
        return 2
      }
      const r = applyLogPolicy({ configPath, values: parsedValues.values })
      if (json) {
        write(JSON.stringify({ ok: r.ok, code: r.code ?? null, path: r.path, applied: r.applied ?? null, policy: r.policy ?? null, message: r.message }, null, 2))
      } else {
        write(r.ok === true ? `✔ ${r.message}` : `✖ ${r.message}`)
        if (r.ok === true) {
          write(`  ${r.path}`)
          // 改完必须把**生效值**再打一遍。只报"写成功"的话，
          // 用户仍然要自己去推"写进去的等价于生效的"——而这两件事
          // 在这一层是可以不一致的（后一层覆盖前一层）。
          if (r.kept.length > 0) write(`  （保留了 ${r.kept.length} 个别的顶层键：${r.kept.join('、')}）`)
        }
      }
      if (r.ok !== true) return r.code === LOG_CLI_CODES.BAD_VALUE ? 2 : 9
    }

    if (parsed.flags['log-policy'] === true) {
      // ★ 重新读一遍，而不是用 `options.logPolicy`。
      //
      //   `options` 是在 `run()` 开头算好的；而 `--set-log-policy` 刚刚
      //   改过配置文件。用旧的那份，"改完之后看一眼"会显示**改之前**的值——
      //   而这一幕会被读成"我的修改没生效"。
      //
      //     > 一个"在改完之后仍然显示旧值"的查看器，
      //     > 与一个"修改根本没生效"的产品，在用户下一步要做什么上是同一个读数。
      const cfg = loadProductConfig(options.layout, { envValues: {} })
      const derived = launcherInputFromConfig(cfg.merged ?? null)
      const diags = cfg.diagnostics ?? []
      const broken = cfg.ok !== true || diags.some((d) => d.severity === 'error')
      if (json) {
        write(JSON.stringify({
          ok: !broken, effective: effectiveLogPolicy(cfg.merged ?? null),
          provenance: derived.provenance ?? {}, path: configPath, diagnostics: diags,
        }, null, 2))
      } else {
        // ★ 必须把配置自己的诊断传进去。
        //
        //   第一版没传，于是坏 JSON 被渲染成"四项都是默认值"——
        //   一份看起来完全正常的输出。而真相是整份配置被忽略了。
        //   这正是本任务要消灭的「改了但没反应」，只是换了个位置发生。
        write(describeLogPolicy({
          merged: cfg.merged ?? null,
          provenance: derived.provenance ?? {},
          filePath: configPath,
          diagnostics: diags,
        }))
      }
      // 配置坏掉 ⇒ 退出码 6，与主流程里"产品配置有问题"那一条**同一个码**：
      // 同一件事不该有两个码，否则脚本要判两次。
      return broken ? 6 : 0
    }
    return 0
  }

  //
  // 这是产品里**唯一**一个能产生"同意"这个值的入口。在此之前 `consent`
  // 只有测试与假设能提供，于是"没有同意就不发"那道闸的实际效果是**永久关闭**
  // ——那恰好是安全的，所以没人会发现它是坏的。
  //
  //   > 一道"因为没有人能提供那个值、所以永远拦着"的闸，
  //   > 与一道"真的拦得住"的闸，在用例里是同一个读数——
  //   > 只不过前者会在有人**终于**接上同意流程的那一天，
  //   > 变成"接上就直接开始发"。
  //
  // 它排在布局校验**之前**：撤回同意是一个安全动作，而"配置坏了所以撤不回"
  // 会让用户被困在一个他不想继续的选择里。
  {
    const grant = parsed.flags['heartbeat-consent']
    const revoke = parsed.flags['heartbeat-revoke-consent']
    if (typeof grant === 'string' || revoke === true) {
      const { writeConsent, readConsent, CONSENT_CODES } = await import('../heartbeat-consent.mjs')
      if (revoke === true && typeof grant !== 'string') {
        // 撤回也要署名：一条没有署名的撤回，与一次误删文件在记录上无法区分。
        if (json) write(JSON.stringify({ ok: false, code: 'CONSENT_NEEDS_WHO' }, null, 2))
        else write('✖ 撤回同意也要说清是谁撤的：--heartbeat-revoke-consent --heartbeat-consent=<你的名字>')
        return 2
      }
      const r = writeConsent(options.layout, { who: grant, revoke: revoke === true })
      if (json) {
        write(JSON.stringify({ ok: r.ok, path: r.path ?? null, message: r.message, record: r.record ?? null }, null, 2))
      } else {
        write(r.ok === true ? `✔ ${r.message}` : `✖ ${r.message}`)
        if (r.ok === true && r.path !== null) write(`  ${r.path}`)
        // 撤回之后顺手把当前状态说一遍：用户刚做的事有没有生效，
        // 不该只能靠"没报错"来推断。
        const after = readConsent(options.layout)
        if (json !== true) write(`  当前同意状态：${after.consented === true ? '有效' : `无效（${after.code ?? '未知'}）`}——${after.message}`)
      }
      return r.ok === true ? 0 : 9
    }
  }

  // ── 诊断包导出（PRT-710）─────────────────────────────────────────────
  //
  // **位置是这段代码的全部要点**：它排在布局校验与配置校验**之前**。
  //
  // 诊断包最需要在什么时候拿到？**产品坏掉的时候。** 把它挂在一个"配置能解析、
  // 布局合法才往下走"的流程后面，等于在最需要它的时候恰好用不了：
  //
  //   > 一个只在产品健康时才可用的诊断入口，与一个不存在的诊断入口，
  //   > 在最需要它的那一刻是同一个东西。
  //
  // 所以这里**不**调 preflight、**不**创建 Launcher、**不**要求配置合法——
  // 它只要布局对象（拿得到目录在哪就够）与一个目标目录。
  if (typeof parsed.flags.diagnostics === 'string' && parsed.flags.diagnostics !== '') {
    const { exportDiagnosticPackage, DIAG_CODES } = await import('../diagnostics/redact-package.mjs')
    const r = await exportDiagnosticPackage({ layout: options.layout, outDir: parsed.flags.diagnostics })
    if (json) {
      write(JSON.stringify({ ok: r.ok, code: r.code ?? null, path: r.path ?? null, message: r.message, manifest: r.manifest ?? null, offenders: r.offenders ?? null }, null, 2))
    } else if (r.ok === true) {
      write(`✔ ${r.message}`)
      write(`  ${r.path}`)
      // 排除项**必须打出来**：一份说不清自己排除了什么的诊断包，
      // 与一份漏收了文件的诊断包，对排查者是同一个东西。
      for (const e of r.manifest.excluded) write(`  ⊘ 已排除 ${e.id}（${e.rule}）：${e.why}`)
      for (const x of r.manifest.skipped) write(`  · 未收 ${x.id}：${x.reason}`)
      for (const x of r.manifest.oversized) write(`  · 未收 ${x.id}：${x.why}`)
    } else {
      write(`✖ ${r.message}`)
    }
    // 退出码刻意把**泄漏**与**其它失败**分开：
    //   8 = 复检发现残留、包已作废（安全事件，必须一眼看得出与普通失败不同）；
    //   9 = 其它导出失败（包括"不覆盖已有目录"）。
    if (r.ok === true) return 0
    return r.code === DIAG_CODES.LEAK_DETECTED ? 8 : 9
  }

  // 目录布局诊断在**创建 Launcher 之前**就已经拿到（resolveLayout 的返回），
  // 而它在 createLauncher 内部还会再算一次。这里用它的原因是：
  // 「工作区未配置」这类问题必须在**任何进程启动之前**以用户能懂的话说出来。
  //
  // `--init` 例外：初始化**就是**来修「目录还没建好」的，因此它只要求布局
  // 没有 error（有 error 时 init 自己会拒绝并说明，一个目录都不建）。
  if (layoutDiagnostics.some((d) => d.severity === 'error') && parsed.flags.init !== true) {
    if (json) write(JSON.stringify({ ok: false, phase: 'layout', diagnostics: layoutDiagnostics }, null, 2))
    else {
      write('✖ Legion 无法启动：目录布局未确定')
      printDiagnostics(layoutDiagnostics, write)
    }
    return 3
  }

  // 配置文件的问题不得被静默跳过：坏 JSON 会让整份配置回到默认值，
  // 而用户以为自己的设置生效了。这是「配置没反应」最常见的真实原因。
  if (configDiagnostics.some((d) => d.severity === 'error')) {
    if (json) write(JSON.stringify({ ok: false, phase: 'config', diagnostics: configDiagnostics, paths: config.paths }, null, 2))
    else {
      write('✖ Legion 无法启动：产品配置有问题')
      printDiagnostics(configDiagnostics, write)
      write('  （配置文件必须能被完整读懂；否则所有值都会悄悄退回默认值）')
    }
    return 6
  }

  // 首次运行初始化（PRT-706）：建目录 → 写默认配置与元数据 → 退出。
  // 它**不启动任何进程**：初始化失败时启动会失败得更难懂（缺目录 → 各进程报自己的错）。
  if (parsed.flags.init === true) {
    const dryRun = parsed.flags['dry-run'] === true
    const init = initializeProductDir(options.layout, { dryRun })
    if (json) {
      write(JSON.stringify({ ok: init.ok, phase: init.phase, dryRun, created: init.created, skipped: init.skipped, files: init.files, diagnostics: init.diagnostics }, null, 2))
    } else {
      write(dryRun ? '（dry-run：以下内容不会被真正写入）' : 'Legion 首次运行初始化')
      for (const c of init.created) write(`  ＋ ${c.role.padEnd(12)} ${c.path}`)
      for (const f of init.files) write(`  ✎ ${f.role.padEnd(12)} ${f.path}`)
      for (const s of init.skipped.filter((x) => x.reason !== 'exists')) write(`  · ${s.role.padEnd(12)} ${s.path}（${s.reason}）`)
      printDiagnostics(init.diagnostics, write)
      write(init.ok ? `✔ 初始化完成（新建 ${init.created.length} 个目录、${init.files.length} 个文件）`
        : `✖ 初始化未完成：${init.diagnostics.filter((d) => d.severity === 'error').length} 个阻塞问题待解决`)
      if (init.ok && !dryRun && isInitialized(options.layout) !== true) write('  ⚠ 初始化后仍未达到「已初始化」判据，请查看上面的诊断')
    }
    return init.ok === true ? 0 : 7
  }

  const launcher = createLauncherFn(options)

  if (parsed.flags.check === true) {
    const pre = await launcher.preflight()
    if (json) {
      write(JSON.stringify({ ok: pre.ok, phase: pre.phase, diagnostics: pre.diagnostics }, null, 2))
    } else {
      write(pre.ok ? '✔ 启动前体检通过：端口、入口、依赖与目录边界均无阻塞问题' : `✖ 启动前体检未通过（阶段：${pre.phase}）`)
      printDiagnostics(pre.diagnostics, write)
      const warns = pre.diagnostics.filter((d) => d.severity !== 'error')
      if (warns.length > 0) write(`  （另有 ${warns.length} 条提醒）`)
    }
    return pre.ok === true ? 0 : 4
  }

  const result = await launcher.start()
  const status = launcher.status()

  if (json) {
    write(JSON.stringify({ ok: result.ok, phase: result.phase, failures: result.failures, state: status.state, scope: status.scope, processes: status.processes, diagnostics: launcher.allDiagnostics() }, null, 2))
  } else if (result.ok === true) {
    write(`✔ ${status.stateText}`)
    for (const p of status.processes) {
      write(`  ${p.state === 'ready' ? '●' : '○'} ${p.key.padEnd(13)} ${p.state.padEnd(9)} ${p.url ?? '(worker，无监听端口)'}`)
    }
    write('  （Ctrl+C 停止；进程状态与诊断可反复查询）')
  } else {
    write(`✖ 启动失败（阶段：${result.phase}）`)
    for (const f of result.failures) write(`  ✖ [${f.process}] ${f.code}：${f.detail ?? '无详情'}`)
    printDiagnostics(launcher.allDiagnostics(), write)

    // ── PRT-710 收尾：启动失败时**自动**留下诊断包 ──
    //
    // 为什么必须自动：`--diagnostics=<dir>` 要求用户在**产品已经坏掉之后**
    // 还想起来、并且能够，手工敲一条命令。而这一整条任务的定位就是
    // "诊断包最需要在产品坏掉的时候拿到"。
    //
    //   > 一个"坏掉之后可以手工导出"的诊断包，
    //   > 与一个"坏掉时会自动留下证据"的诊断包，
    //   > 在用户记得去敲那条命令的时候是同一个东西——
    //   > 只不过前者会在用户不记得、或者产品坏到连命令行都进不去的时候，
    //   > 恰好什么都不留下，而"这次没有证据"与"这次没什么可记的"长得一样。
    //
    // ★ 它在**打印完启动失败之后**才跑，且**不改变退出码**（仍是 5）。
    //
    //   自动导出失败时**绝不能**把已经说清的启动失败原因换掉：
    //
    //     > 一个"出不了诊断包于是报了个诊断包错误"的启动，
    //     > 与一个"真的就是诊断包坏了"的启动，
    //     > 在用户读到的第一行上是同一个东西——
    //     > 只不过前者会把一个**已经查明的**故障，换成一句**关于工具的**抱怨。
    if (autoDiagnostics === true) {
      const r = await autoExportFn({
        layout: options.layout,
        reason: `启动失败（阶段：${result.phase}）`,
        keep: parsed.flags['auto-diagnostics-keep'] === undefined
          ? AUTO_EXPORT_DEFAULTS.keep
          : Number(parsed.flags['auto-diagnostics-keep']),
      })
      write(r.ok === true ? `  ⤷ ${r.message}` : `  ⤷ 未留下诊断包：${r.message}`)
      if (json) write(JSON.stringify({ autoDiagnostics: { ok: r.ok, code: r.code ?? null, path: r.path ?? null, pruned: r.pruned } }))
    }
  }

  if (result.ok !== true) return 5

  if (waitForSignal) {
    await new Promise((resolve) => {
      const stop = () => resolve()
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    const stopped = await launcher.stop({ reason: '收到停止信号' })
    if (!json) write(`  ${PRODUCT_STATE_TEXT.unavailable}（已停止 ${stopped.results.length} 个进程）`)
  }
  return 0
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const code = await run()
  // 退出前不调用 process.exit()：让 stdout 自然刷出（管道被提前关闭时会截断输出）
  process.exitCode = code
}

// 退出码（脚本与验收依赖它们，因此是契约的一部分）：
//   0 = 成功；2 = 参数错误；3 = 目录布局未确定；4 = --check 未通过；
//   5 = 启动失败；6 = 产品配置文件有 error；7 = 初始化未完成。
export const EXIT_CODES = Object.freeze({
  ok: 0, args: 2, layout: 3, check: 4, start: 5, config: 6, init: 7,
})

export { DEFAULT_BACKOFF }
