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
// `readJsonFile` 一起 import：清单是**配置面**的最后一个来源，它的读取规则
// （BOM、坏 JSON、顶层不是对象）应当只有一份实现——本文件不再写第二个 JSON 读取器。
import { launcherInputFromConfig, loadProductConfig, readJsonFile } from '../config.mjs'
import { AUTO_EXPORT_DEFAULTS, runAutoExport } from '../diagnostics/auto-export.mjs'
import { initializeProductDir, isInitialized } from '../init.mjs'
import { createLauncher, PRODUCT_STATE_TEXT } from './launcher.mjs'
import { DEFAULT_BACKOFF } from './supervisor.mjs'
// PRT-257 修复入口（spec `line 275`：「禁止自动执行，**提示修复或回滚**」）。
// 零 IO 的纯模块：它只把结论讲清楚，不碰磁盘、不改环境（理由见那个文件头）。
import { doctorReport, renderDoctor } from './doctor.mjs'
// PRT-257：**清单的形状与判据**的唯一住处（PRT-801/802）。
//
// 这里的接线守的是 spec §9.1 那句话本身：「客户**不能在产品内单独升级 DSH**。」
// 它的可执行形式只有一个：**要装哪一版，是清单说了算**。所以本文件里
// **不出现任何 DSH 版本号字面量**——写成 `targetVersion: '0.1.5-rc.2'` 的接线，
// 与一条"清单说 0.8.3、CLI 里写 0.1.5"的接线，在两者恰好一致的那些日子里
// 是同一个东西——只不过前者的漂移要等到装错版本那天才有人发现。
//
//   > 一个"版本号写在调用方"的安装器，
//   > 与一个"版本号写在清单里"的安装器，在它们碰巧一致的那些运行里是同一个东西。
import { createManifest, digestOf, validateManifest } from '../upgrade/manifest.mjs'

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
  { name: '--dry-run', kind: 'boolean', doc: '与 --init / --runtime-install 同用：只报告将会创建什么、将要跑哪条命令，**不落盘、不起 npm**' },
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
  { name: '--doctor', kind: 'boolean', doc: '（PRT-257）修复入口：读 stdin 上的一份自检结论/拒绝，' +
    '把「该修哪几项、或者回滚」讲清楚。**只提示、不自动改**。' +
    '退出码：0 全过 / 1 有待修项 / **3 拿不到诊断（不是 0）**' },
  // ── PRT-257：DSH 运行时安装的**生产调用方** ─────────────────────────────
  //
  // 在加这两条之前，`runtime-install.mjs` 的调用方只有它自己的用例：
  // 一个"判据齐全、用例全绿、而没有任何人能敲出来"的安装器，
  // 与一个不存在的安装器，在部署上是同一个东西——只不过前者的测试报告很好看。
  //
  // ★ 计划与应用**分成两条开关**，不是一个开关加 `--apply`：
  //   默认的那一边必须是**没有任何副作用**的那一边。
  { name: '--runtime-install-plan', kind: 'boolean', doc: '（PRT-257）把 DSH 运行时的**安装计划**打出来：' +
    '装哪一版、受支持区间、装到哪个目录、将要跑哪条命令。**零副作用**（不建目录、不起 npm；' +
    '只读清单与现役指针）。退出码：0 计划可执行 / 1 计划被拒绝（附修法）/ **3 算不出计划（缺清单，不是 0）**' },
  { name: '--runtime-install', kind: 'boolean', doc: '（PRT-257）**真的装**：先打上面那份计划，' +
    '再执行一次真实的 npm install（会联网、会写 DataDir）。**必须显式给出这一条**；' +
    '计划被拒绝时一次都不执行（退出 1）；`--dry-run` 时只打命令不起进程。' +
    '退出码：0 装好并切成现役 / **10 没装成（指针没动，不是 1）**' },
  { name: '--runtime-manifest=<path>', kind: 'value', doc: '（PRT-257）产品版本清单（spec §9.1）的路径。' +
    '**要装哪一版 DSH、受支持区间、补丁层版本全部只从它来**——本 CLI 里没有任何 DSH 版本号字面量' +
    '（§9.1：客户不能在产品内单独升级 DSH）。不给这条 ⇒ 算不出计划（退出 3），**不是**"计划通过"' },
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
  const home = dshHomeFrom(env)
  if (home === null) return null
  return join(home, DSH_CREDENTIALS_FILENAME)
}

/**
 * DSH 的家目录**本身**（不是它下面某个文件的路径）。
 *
 * 与 `dshCredentialsFileFrom` 同一个来源、同一个键、同一个"没设就是 `null`"。
 * 运行时安装器需要它，但理由**不是**"要去读它的东西"——恰恰相反：
 * 它是被拒绝写入的那棵树。`$DSH_HOME` 是**另一个程序**的地盘，
 * 它的 clean / 升级会把整棵树换掉，把 Legion 的运行时装进去等于把
 * 一个版本的字节放在别人随时会删的位置上（见 `runtime-install.mjs` 的
 * `TARGET_INSIDE_DSH_HOME`）。
 *
 * ★ 它**不猜路径**：没设 `DSH_HOME` 就是 `null`，不会去回落
 * `%USERPROFILE%\.dsh`。猜出来的家目录会把"守卫一个不存在的禁区"
 * 伪装成"守卫过了"。
 *
 * ★ 它也是**这一条唯一的读取点**：`dshCredentialsFileFrom` 反过来调它。
 *
 *   两个函数各自读一次 `env[DSH_HOME_ENV]` 也能跑，而且行为一模一样——
 *   差别在 `scan --check` 那边：动态下标是**按出现次数**逐处对账的
 *   （`scripts/config/config.test.mjs` 里"product 有几处动态下标"那条），
 *   于是同一次读取写成两处，会让那份对账必须跟着动一次。
 *   为了一次读取去改那份"重数一遍再改 schema"的对账，等于把守卫
 *   从一个稳定的数字变成了每次加一个调用方就要动的东西。
 */
export function dshHomeFrom(env = {}) {
  const home = env[DSH_HOME_ENV]
  return typeof home === 'string' && home.trim() !== '' ? home : null
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

// ============================================================================
// PRT-257：DSH 运行时安装的**生产调用方**（计划 + 应用）
//
// ## 这一段补的是哪一截
//
// `runtime-install.mjs` 把判断（纯）与效果（脏）分成了两半，写得很好——
// 而在此之前，它的调用方**只有它自己的用例**。一个"判据齐全、28 条用例全绿、
// 而没有任何一条命令行能走到"的安装器，与一个不存在的安装器，在部署上是
// 同一个东西：
//
//   > 一个"计划算得出来、但没有任何人能敲出来"的安装器，
//   > 与一个不存在的安装器，在用户手上是同一个东西——
//   > 只不过前者的测试报告是绿的。
//
// ## 为什么是"计划"和"应用"两条独立的开关
//
// 因为默认的那一边必须是**没有任何副作用**的那一边。一个"`--runtime-install`
// 加不加 `--apply` 都会装"的入口，在一个只想知道"会装什么"的人手上，
// 已经在一次真实的 npm install 之后了。
//
//   > 一个"看一眼计划"与一个"真的装"共用一条命令的入口，
//   > 在计划恰好没写任何东西的那些运行里是同一个读数——
//   > 只不过前者会在一次把 DataDir 建出来的"计划"上也照样是绿的。
//
// ## 三个读数必须分开（抄 `doctor.mjs` 的 0/1/3）
//
//   · `0` 计划可执行 —— 清单读到了、版本形状对、边界过、成对过；
//   · `1` 计划被拒绝 —— 判断**做出来了**，答案是"不行"，并逐条给出下一步；
//   · `3` **算不出计划** —— 清单没给、文件不在、读不出来、或者不是一份合法清单。
//
// `3` 与 `0` 分开是这一段最要紧的一条，理由与 `doctor.mjs` 里那句一字不差：
//
//   > 一个"因为没拿到结论所以什么都没报"的体检，
//   > 与一个"结论是一切正常"的体检，在退出码上是同一个东西——
//   > 只不过前者会让一个已经坏掉的部署安静地通过门禁。
//
// 所以"没有清单 ⇒ 退出 0"是**禁止**的。没有清单就没有结论，而没有结论
// 不等于"可以装"：本 CLI 里**没有任何 DSH 版本号字面量**可以回退——
// 那正是 spec §9.1「客户不能在产品内单独升级 DSH」的可执行形式。
//
// ## 这个入口**不**证明什么（诚实边界）
//
//   ① 它不证明产品里有一份清单：本仓库**没有**随产品发货任何一份 §9.1 清单
//      （`product/upgrade/manifest.mjs` 是"清单长什么样 + 怎么校验"，
//      不是一份清单）。要装哪一版必须由调用者用 `--runtime-manifest` 指出来。
//   ② 它不证明"补丁层与 DSH 真的配得上"：绑定表由**同一份清单**导出，
//      所以它只能证明"清单与自己一致"（PRT-801-813 §7.5：没有任何一张
//      真实的绑定表随产品发货）。计划输出里会写明这一点，不让它藏起来。
//   ③ 它不证明任何一次真实的 `npm install` 跑通过。
// ============================================================================

/**
 * 本 CLI 自己的拒绝码（模块的那些在 `runtime-install.mjs` 的 `RUNTIME_INSTALL_CODES` 里）。
 *
 * 它们说的是同一件事的三个不同理由，所以是三个码而不是一个：
 * "没给清单"、"给的路径下没有文件"、"文件在但不是一份合法清单"——
 * 对用户是三件不同的事，对下一步也是三个不同的动作。
 */
export const RUNTIME_PLAN_CODES = Object.freeze({
  /** 没给 `--runtime-manifest`（没有来源，也就没有结论）。 */
  NO_MANIFEST: 'RUNTIME_PLAN_NO_MANIFEST',
  /** 给了路径，那个路径下没有文件。 */
  MANIFEST_NOT_FOUND: 'RUNTIME_PLAN_MANIFEST_NOT_FOUND',
  /** 文件在，但读不出来或不是 JSON 对象。 */
  MANIFEST_UNREADABLE: 'RUNTIME_PLAN_MANIFEST_UNREADABLE',
  /** 读出来了，但 `validateManifest` 逐项判定它不是一份合法清单。 */
  MANIFEST_INVALID: 'RUNTIME_PLAN_MANIFEST_INVALID',
})

/**
 * `--runtime-install-plan` / `--runtime-install` 的退出码。**四档**，
 * 前三档与 `doctor.mjs` 的 `DOCTOR_EXIT` 同形、同理由（那是本仓库的既有约定，
 * 这里**抄**它而不是另立一套：同一个产品里两套"0/1/3"会让读的人以为
 * 3 在两处有不同含义）。
 *
 * 不复用 `EXIT_CODES` 的键：那是**启动流程**的码（布局/体检/启动/配置/初始化），
 * 而这几档说的是**安装**的读数。`REFUSED`（1）在本 CLI 里是全新的一个值，
 * 之前没有任何路径返回过 1——这正是"计划被拒绝"应当有的辨识度。
 *
 * ★ 第四档 `APPLY_FAILED`（10）与 `REFUSED`（1）**必须分开**：
 *
 *   > 一个"计划阶段就被拒绝、于是什么都没做"的读数，
 *   > 与一个"计划过了、真的动手了、但没装成"的读数，
 *   > 在"现在机器上是什么状态"上是同一件事吗？不是——
 *   > 前者一个字节都没写，后者可能在 versions/ 下留了一个没有完成标记的目录。
 *
 *   合成一个码的话，写脚本的人分不出"要不要去看一眼磁盘"。
 *   它也不取 1：那会把"没通过判据"和"动手之后失败"混成一个读数。
 *
 * ★ 为什么不取 9：`9` 在本 CLI 里**已经被 `--wizard` 占了**
 *   （向导自己抛错时 `return 9`，HEAD 起就是这样，只是从未写进下面那份契约）。
 *   同一个数字在两个子命令下说两件不同的事，正是这一整段要避免的读数混同；
 *   而顺手复用它会让人以为"9 = 运行时装不上"，同时把向导那条路也一起改了语义。
 *   所以取下一个没被占的 10，并把 9 的既有含义一并写进下面的退出码契约
 *   （它本来就在用，只是一直没登记）。
 */
export const RUNTIME_INSTALL_CLI_EXIT = Object.freeze({
  /** 计划可执行。 */
  PLANNED: 0,
  /** 计划被拒绝，且逐条给了下一步。**一个字节都没写。** */
  REFUSED: 1,
  /** 算不出计划（没有清单/读不到/清单不合法）。**不是 0**。 */
  UNDIAGNOSED: 3,
  /** 计划过了，但这一次没有装成（指针没动；可能留下一个未完成的版本目录）。 */
  APPLY_FAILED: 10,
})

/**
 * Node 自带测试运行器给测试子进程设的变量名。
 *
 * 与 `DSH_HOME_ENV` 同一做法：**名字住在这里**，于是"这一跑是不是测试"
 * 这个事实只有一处定义。
 */
export const NODE_TEST_CONTEXT_ENV = 'NODE_TEST_CONTEXT'

/**
 * 本进程是不是跑在 node 自带的测试运行器里（`node --test` 会给子进程设这个变量）。
 *
 * 它守的是任务书里那条硬规矩：「`--runtime-install` **never run in tests**」。
 * 靠"每个用例都记得注入假运行器"来守这条规矩，是一条**纪律**，不是一条**结构**：
 * 下一个写用例的人漏注入一次，跑的就是真的 `npm install`。
 *
 *   > 一条"用例都注入了假运行器所以没有联网"的保证，
 *   > 与一条"在测试进程里根本构造不出真运行器"的保证，
 *   > 在所有人都记得注入的那些日子是同一个东西。
 *
 * 所以真实运行器**在测试进程里构造不出来**：这条判据只作用于"用默认运行器"
 * 这一条路（注入进来的运行器不受影响——用例正是靠它跑完安装的）。
 *
 * ★ 判据是**这个变量在不在**，不是它的值。
 *
 *   Node 把值设成 `child-v8` 这类东西，那是**它的实现细节**；把 `'child-v8'`
 *   写进判据，等于把"这一跑是不是测试"绑在一个随时会改的字符串上——
 *   而它改的那天，这条守卫会静默失效（退出码、日志都还是绿的）。
 *   在不在则是一条稳定的信号：只有测试运行器会设它。
 *
 *   代价说清楚：谁的 shell 里恰好设了一个空的同名变量，真实的
 *   `--runtime-install` 也会被拒。**这个方向的误判是刻意选的**——
 *   "该装的时候没装"看得见、可以再敲一次；"测试里真的去装了一次"看不见。
 *
 * ★ 读法是 `Object.hasOwn(env, 名字)`，不是 `env[名字]`。
 *   后者在 `scan --check` 眼里是一处**动态下标 env 读取**，于是它必须进
 *   `product/config-schema.mjs` 的 `dynamicEnvReads`，而那份登记要与
 *   `scripts/config/config.test.mjs` 里"product 有几处动态下标"的逐条对账一起动——
 *   为了一个**只看键在不在**的判据去改那份对账，是把声明写成了它没有做的事。
 *   这里只问归属，字面量登记在 `foreignEnv` 里就够了。
 */
export function underNodeTestRunner(env = process.env) {
  return Object.hasOwn(env, NODE_TEST_CONTEXT_ENV)
}

/**
 * 读产品版本清单（spec §9.1）。
 *
 * `--runtime-manifest=<path>` 指到一个 JSON 文件；解析交给 `config.mjs` 的
 * `readJsonFile`（BOM、坏 JSON、顶层不是对象——只有一份实现），校验交给
 * `upgrade/manifest.mjs` 的 `createManifest` + `validateManifest`。
 * **本函数不自己看一眼版本号字符串**：形状判据住在那两个函数里，
 * 在这里再写一份 `split('.')` 会让"合法清单"有两处认知。
 *
 * @returns {{ok: boolean, code: string|null, path: string|null, manifest: object|null,
 *            problems: ReadonlyArray<object>, digest: string|null, message: string}}
 */
export function runtimeManifestFrom({ manifestPath = null, readFile = undefined, exists = undefined } = {}) {
  const path = typeof manifestPath === 'string' && manifestPath.trim() !== '' ? manifestPath.trim() : null
  if (path === null) {
    return Object.freeze({
      ok: false, code: RUNTIME_PLAN_CODES.NO_MANIFEST, path: null, manifest: null,
      problems: Object.freeze([]), digest: null,
      message: '没有给出产品版本清单（spec §9.1）：要装哪一版 DSH **只能**从清单来，'
        + '所以没有清单时算不出计划——这不是"计划通过"，也不是"计划被拒绝"。'
        + '本 CLI 里没有任何 DSH 版本号字面量可以回退，那正是 §9.1「客户不能在产品内单独升级 DSH」的可执行形式。',
    })
  }

  const read = readJsonFile(path, { readFile, exists })
  if (read.ok !== true) {
    return Object.freeze({
      ok: false, code: RUNTIME_PLAN_CODES.MANIFEST_UNREADABLE, path, manifest: null,
      problems: Object.freeze([]), digest: null,
      message: `${path} 读不出来或不是 JSON 对象：`
        + read.diagnostics.map((d) => d.message).join('；'),
    })
  }
  if (read.exists !== true) {
    return Object.freeze({
      ok: false, code: RUNTIME_PLAN_CODES.MANIFEST_NOT_FOUND, path, manifest: null,
      problems: Object.freeze([]), digest: null,
      message: `清单不在：${path}。一个"路径写错了于是当成没有清单"的读数，`
        + '与一个"这份清单不存在"的读数，在这里是同一个——所以它单独一个码。',
    })
  }

  const manifest = createManifest(read.values)
  const verdict = validateManifest(manifest)
  if (verdict.ok !== true) {
    return Object.freeze({
      ok: false, code: RUNTIME_PLAN_CODES.MANIFEST_INVALID, path, manifest,
      problems: verdict.problems, digest: null,
      message: `${path} 不是一份合法清单（${verdict.problems.length} 项）：`
        + verdict.problems.map((p) => `[${p.code}] ${p.field}：${p.message}`).join('；'),
    })
  }
  return Object.freeze({
    ok: true, code: null, path, manifest,
    problems: Object.freeze([]), digest: digestOf(manifest),
    message: `DSH ${manifest.dshVersion}　补丁层 v${manifest.dshCompositionPatchVersion}　`
      + `产品 ${manifest.productVersion}　通道 ${manifest.channel}`,
  })
}

/**
 * 组装 `planRuntimeInstall()` 的入参——**每一个都来自已经存在的地方**。
 *
 *   · 数据目录 / 安装目录 / 允许根 —— `launcherOptionsFrom()` 解析出来的布局；
 *   · `$DSH_HOME` / operator 家目录 —— `readEnv` 与 `osHomeFacts`（同一份来源）；
 *   · 目标版本 / 受支持区间 / 补丁层版本 —— **清单**（下面有为什么是精确锁定）。
 *
 * ## ★ 受支持区间：精确锁定（`=<version>`），不是 caret 区间
 *
 * 清单里能写的是**一个精确版本**：`upgrade/manifest.mjs` 的 `isExactVersion()`
 * 拒绝 `^` / `~` / `*` / `.x` / `latest`，`validateManifest()` 对带区间记号的
 * `dshVersion` 直接报 `VERSION_NOT_EXACT`（`manifest.mjs:86-92`、`:236-247`）。
 * 于是这里只有两条路：
 *
 *   ① 把声明的那一版**原样**当区间（`=x.y.z`，等价于 `satisfiesRange` 里
 *      不给算子时的默认 `=`，见 `runtime/packs/manifest.mjs:299`）；
 *   ② CLI 自己造一个 caret 上界（`^x.y.z` ⇒ `<x+1.0.0`）。
 *
 * 选 ①，理由是 ② 等于**在 CLI 里发明清单拒绝声明的策略**：
 *
 *   · spec `2026-09-11-legion-product-runtime-design.md:696`（§9.1）要求
 *     `dshVersion` 与 `dshCompositionPatchVersion` **成对验证**；
 *   · 同一节 `:698` 写下「客户**不能在产品内单独升级 DSH**。启动时发现实际
 *     版本与清单不一致，应停止自动执行并引导修复」；
 *   · 而 caret 区间**恰好允许装一个清单没有声明的版本**（清单说 0.8.3、
 *     `^0.8.3` 允许装 0.8.7）——那就是一次"在产品内单独升级 DSH"。
 *
 * `manifest.mjs:18-25` 把这件事讲得比我能讲的更直白：
 *
 *   > 一个写着 `"^0.8.3"` 的版本清单，
 *   > 与一个"清单说 0.8.3、机器上跑 0.9.0"的清单，在"出事时能不能复原现场"上
 *   > 是同一个东西——只不过前者看起来是钉住的。
 *
 * 代价说清楚：**精确锁定让"换一个版本"必须去改清单**（那是刻意的一次决定，
 * 而且会被 `digestOf()` 记下来）。一个"命令行上一个 `--version=` 就能换版"
 * 的入口，与一个"清单是唯一来源"的入口，在两者恰好一致的运行里是同一个东西——
 * 只不过前者的换版不会在清单摘要里留下任何痕迹。
 *
 * ## ★ `patchBindings`：由**同一份清单**导出（这条弱点写在脸上）
 *
 * `patchBindings` 要的是「已知可用的 (dshVersion, 补丁层版本) 组合表」。
 * PRT-801-813 的诚实边界第 5 条写着：**没有任何一张真实的绑定表随产品发货**。
 * 这里不假装有：表就是清单自己声明的那一对——清单是**不可变的产品版本声明**，
 * 它声明的两个字段就是这一版**一起发布**的那一对。
 *
 * 不接的话每一次调用都停在 `PATCH_PAIR_UNVERIFIED`，于是这个安装器
 * **一个东西都装不了**——那正是 `rangeSatisfied` 缺省写成 `null` 那一次的同一个坑。
 * 代价是这条检查在这里只能证明"清单与自己一致"；所以计划输出里
 * **明写** `patchPairSource: 'manifest-itself'`，让人看得见，而不是把它当成
 * "成对关系已验证"。
 *
 * ## 刻意不给 `shippedPresetRoot`
 *
 * `product/launcher/` 里没有任何东西知道 DSH 自带 preset 装在哪
 * （`dsh-overlay.mjs` 只用安装目录里的 `--patch` 文件）。猜一个路径比留空更坏：
 * 一个"守着一个猜出来的根"的守卫，与一个不守的守卫，在被保护的那棵树
 * 真被写到的那天是同一个东西。这**不影响**那一层保护——写入守卫的允许根是
 * DataDir，而计划本身已经在 `TARGET_INSIDE_INSTALL_DIR` / `TARGET_INSIDE_DSH_HOME`
 * 上拒绝"把运行时装进任何只读根"。
 */
export function runtimeInstallInputFrom({ layout = null, env = {}, manifest = null, active = null, platform = process.platform } = {}) {
  const osHome = osHomeFacts(env)
  const dataDir = layout?.dataDir ?? null
  return {
    dataDir,
    // PRT-011 §2.1：运行时**只**装在 DataDir 里。允许根就是数据目录本身——
    // 不是它的父目录、不是产品家目录。
    allowedRoot: dataDir,
    installDir: layout?.installDir ?? null,
    dshHome: dshHomeFrom(env),
    operatorHome: osHome.homeDir,
    shippedPresetRoot: null,
    targetVersion: manifest?.dshVersion ?? null,
    supportedRange: manifest === null ? null : `=${manifest.dshVersion}`,
    expectedPatchVersion: manifest?.dshCompositionPatchVersion ?? null,
    patchBindings: manifest === null ? null : Object.freeze([
      Object.freeze({
        dshVersion: manifest.dshVersion,
        compositionPatchVersion: manifest.dshCompositionPatchVersion,
      }),
    ]),
    // 现役读数（`readActiveRuntime` 的产物）：`relation` 靠它区分 fresh / upgrade /
    // downgrade。传 `null` 时安装器报 `fresh`——而"没读过"与"没装过"是两件事，
    // 所以调用方**必须**先读一次再传进来（`run()` 里就是这么做的）。
    installedVersion: active?.version ?? null,
    installedPatchVersion: active?.patchVersion ?? null,
    legionSourceRoot: layout?.installDir ?? null,
    platform,
  }
}

/**
 * 逐码的"下一步"。**拒绝必须可解**——这是 `doctor.mjs` 立的规矩
 * （「一份算出来了、也跟着拒绝走了、但没有任何人能照着做的修复计划，
 * 与一份不存在的修复计划，对用户是同一个东西」）。
 *
 * 模块的 `repair` 字段说的永远是同一件事（去跑 `--doctor`），而这里的每一条
 * 说的是"**这一次**为什么被拒、下一个动作是什么"。`--doctor` 那条仍然会
 * 追加在后面，所以这个入口与修复入口之间没有断头路。
 */
const RUNTIME_PLAN_NEXT_STEP = Object.freeze({
  RUNTIME_INSTALL_NO_DATA_DIR: '给出数据目录：--data-dir=<path> 或设置 LEGION_DATA_DIR（运行时只装在 DataDir 里）',
  RUNTIME_INSTALL_DATA_DIR_NOT_ABSOLUTE: '把数据目录换成**绝对路径**：相对路径的落点取决于当时的 cwd',
  RUNTIME_INSTALL_TARGET_INSIDE_DSH_HOME: '换一个数据目录：DSH 的家目录属于**另一个程序**，它的清理/升级会把整棵树换掉',
  RUNTIME_INSTALL_TARGET_INSIDE_INSTALL_DIR: '换一个数据目录：安装目录在升级时被整体替换，写进去的字节会随升级消失（PRT-011 §2.1）',
  RUNTIME_INSTALL_TARGET_OUTSIDE_ALLOWED_ROOT: '数据目录没解析对：--data-dir / LEGION_DATA_DIR 必须指向这次允许写入的那棵树',
  RUNTIME_INSTALL_VERSION_MALFORMED: '清单里的 dshVersion 不是完整三段版本号（major.minor.patch，可带 -预发布）：去改清单',
  RUNTIME_INSTALL_RANGE_UNCHECKED: '区间判据没接上，或清单没有声明 dshVersion：检查清单的 dshVersion 字段',
  RUNTIME_INSTALL_VERSION_OUT_OF_RANGE: '要装的版本与清单声明的不一致：**去改清单**（清单是版本的唯一来源，spec §9.1），不是在命令行上换一个版本',
  RUNTIME_INSTALL_PATCH_PAIR_UNVERIFIED: '成对关系没有验证过：清单必须同时给出 dshVersion 与 >=1 的 dshCompositionPatchVersion',
  RUNTIME_INSTALL_PATCH_PAIR_MISMATCH: '清单声明的 (dshVersion, 补丁层版本) 不是已知可用的一对：对齐声明之后重新验证补丁锚点',
})

/** 取一条拒绝的"下一步"。取不到时**不编**：如实说"这一步没有预置动作"。 */
export function runtimeInstallNextStepOf(code) {
  return RUNTIME_PLAN_NEXT_STEP[code] ?? null
}

/**
 * 人读的渲染。**先结论、再理由、最后下一步**——与 `renderDoctor` 同一顺序。
 *
 * `manifestRead.ok !== true` 走"算不出计划"那一支：它**不是**拒绝，
 * 所以措辞上也必须是"算不出"（否则退出 3 与退出 1 会在文案上混成同一件事）。
 */
export function renderRuntimePlan({ manifestRead, plan = null, applying = false, dryRun = false } = {}) {
  const L = []
  L.push('Legion DSH 运行时安装计划（PRT-257，spec §9.1）')

  if (manifestRead === undefined || manifestRead === null || manifestRead.ok !== true) {
    L.push('')
    L.push(`✖ 算不出计划（${manifestRead?.code ?? '（无读数）'}）`)
    L.push(`  ${manifestRead?.message ?? '没有清单读数'}`)
    L.push('')
    L.push('下一步：')
    L.push('  · 用 --runtime-manifest=<path> 指到一份产品版本清单（字段见 spec §9.1）')
    L.push('  · 清单随**产品版本**发布，不是本机生成的：本仓库当前没有发货任何一份')
    L.push('  · 想先看看当前部署哪里不对：node product/launcher/cli.mjs --doctor')
    L.push('')
    L.push('★ 这一条**不是**"计划通过"，也**不是**"计划被拒绝"：没有清单就没有结论。')
    return L.join('\n')
  }

  L.push('')
  L.push(`清单：${manifestRead.path}`)
  L.push(`  ${manifestRead.message}`)
  L.push(`  摘要：${manifestRead.digest}`)
  L.push('  受支持区间：清单只声明**一个精确版本**，因此这里是精确锁定（`=版本`，不是 caret 区间）')
  L.push('                ——caret 会允许装一个清单没声明的版本，而那正是 §9.1 禁止的"在产品内单独升级 DSH"')

  if (plan === null) return L.join('\n')

  if (plan.ok !== true) {
    L.push('')
    L.push(`✖ 计划被拒绝（${plan.code}）`)
    L.push(`  ${plan.message}`)
    L.push('')
    L.push('下一步（照着做就能往前走）：')
    const step = runtimeInstallNextStepOf(plan.code)
    if (step !== null) L.push(`  · ${step}`)
    const repair = plan.repair ?? null
    if (repair !== null) {
      L.push(`  · ${repair.command}`)
      if (typeof repair.why === 'string' && repair.why !== '') L.push(`    （${repair.why}）`)
    } else {
      L.push('  · 这一次没有预置修法：本入口拒绝编造一个没有代码会做的动作')
    }
    L.push('')
    L.push('★ 拒绝发生在**任何目录被创建之前**：这一次运行没有建过任何目录。')
    return L.join('\n')
  }

  L.push('')
  L.push(`✔ 计划可执行：装 DSH ${plan.targetVersion} 到 ${plan.versionDir}`)
  L.push(`  版本关系：${plan.relation}${plan.installedVersion === null ? '（当前没有现役运行时）' : `（现役 ${plan.installedVersion}）`}`)
  L.push(`  成对关系：${plan.patchPair.verdict}（补丁层 v${plan.expectedPatchVersion}）`)
  L.push('            绑定表来源：清单自证（patchPairSource=manifest-itself）——')
  L.push('            PRT-801-813 §7.5：没有任何一张真实的绑定表随产品发货；这条检查只能证明"清单与自己一致"')
  L.push(`  只读根：${plan.readOnlyRoots.length === 0 ? '（无）' : plan.readOnlyRoots.join('　')}`)
  L.push(`  将要执行：${plan.installCommand.file} ${plan.installCommand.args.join(' ')}`)
  L.push(`  Legion 包：${plan.legion.links.length} 个 ${plan.legion.links[0]?.linkType ?? '链接'}`
    + `（${plan.legion.links.map((l) => l.name).join('、')}）`)
  L.push(`            源目录 ${plan.legion.sourceRoot}（路线 ${plan.legion.route}）`)
  if (plan.diagnostics.length > 0) {
    L.push('  读数：')
    for (const d of plan.diagnostics) L.push(`  · [${d.code}] ${d.message}`)
  }
  L.push('')
  if (applying) {
    L.push(dryRun
      ? '⚠ --dry-run：上面那条命令**不会**被执行，也不会创建任何目录。'
      : '⚠ 接下来会**真的执行**上面那条命令（npm install，会联网、会写 DataDir）。')
  } else {
    L.push('★ 计划阶段零副作用：没有建过任何目录，也没有起过 npm（只读了清单与现役指针）。')
    L.push('  要真的装，请显式加 --runtime-install。')
  }
  return L.join('\n')
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
/**
 * 把 stdin 读干。**空输入返回空串**（不是异常、也不是 `null`）——
 * "没有管道"与"管道里是空"在这里是同一件事：没有诊断可读。
 * 那一件事由 `parseDiagnosisInput()` 翻成 `{}`，再落到 `NO_DIAGNOSIS`。
 */
async function readAllStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8')
}

/**
 * 解析 stdin 上的诊断输入。**畸形输入一律当"没有诊断"**，绝不猜。
 *
 * 为什么是"当没有"而不是"抛错"：调用方（`--doctor`）会把结果翻成
 * `NO_DIAGNOSIS`（退出 3），而**抛出**会退到 CLI 的一般错误路径。
 * 两条路看起来都是"非零退出"，但前者说得清"是没读到结论"，后者只说"命令挂了"。
 *
 * 接受的两种形状（都是生产里真实存在的那两种）：
 *   · `{refusal: …}` —— `bindDshRuntime()` 拒绝的形状（里面有 `repair`）；
 *   · `{plan: {ok, items}}` —— `repairPlanFor()` 的形状。
 * 也接受**直接把这两者之一**写在顶层（省掉一层包装）。
 */
function parseDiagnosisInput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return {}
  let value = null
  try { value = JSON.parse(text) } catch { return {} }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  // 顶层直接是计划：`{ok, items}`。
  if (Array.isArray(value.items)) return { plan: value }
  // 顶层直接是拒绝：带 `repair` 或带 `autoExecutionForbidden`。
  if (value.repair !== undefined || value.autoExecutionForbidden !== undefined) return { refusal: value }
  return value
}


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
  // ★ PRT-257 修复入口：stdin 读入是**可注入的接缝**。理由与上面那两个一样——
  //   让用例去接管真实 stdin 会把测试变成"看这一跑有没有人往管道里写东西"，
  //   而那条路在 CI 里根本不是确定的。默认就是真实现。
  readStdinFn = readAllStdin,
  // ★ PRT-257 运行时安装：两个接缝，各自守一件事。
  //
  //   ① `runtimeInstallModuleFn` —— "谁来算计划、谁来装"。默认是**动态**
  //      import 真模块：CLI 的普通启动（体检/启动/向导）不该把安装器与它
  //      拖着的 `runtime/packs/manifest.mjs` 一起加载进来。用例注入一个
  //      假模块，就能断言"没有 --runtime-install 时 installRuntime
  //      一次都没被调用"——**这是那句话唯一的证据**。
  //   ② `npmRunnerFn` —— "谁来跑那条 npm 命令"。默认 `null` 表示用模块自己的
  //      `createNpmRunner()`；只有给了这一条才会被调用。用例靠它把
  //      **真实的** `installRuntime` 跑完整一遍而不联网。
  runtimeInstallModuleFn = () => import('./runtime-install.mjs'),
  npmRunnerFn = null,
  // 与 `write` 同源的第二路输出。它**只有一个用途**：`--runtime-install --json`
  // 时把"即将执行什么"写出去——那条通知必须出现在动作**之前**，而 stdout
  // 上那一个 JSON 文档不能被它污染（脚本要能整份 `JSON.parse`）。
  writeErr = (m) => process.stderr.write(`${m}\n`),
} = {}) {
  /** 诊断来源自己要说的一句话（读 stdin 失败时用）。 */
  let diagNote = null
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

  // ── 修复入口（PRT-257 / spec `line 275`）───────────────────────────────
  //
  // `line 854` 要「按 `incompatible` 处理并禁止自动执行」，§6.3 表格要
  // 「禁止自动执行，**提示修复或回滚**」。`REPAIR_ACTIONS` 与 `repairPlanFor()`
  // 早就把修法算出来了，而 `product/launcher/` 里对它们的引用次数是 **0**——
  // *一份"算出来了、也跟着拒绝走了、但没有任何人能照着做"的修复计划，
  // 与一份不存在的修复计划，对用户是同一个东西。*
  //
  // ★ 结论**从 stdin 读**，不从 argv 读，也不在这里自己算：
  //
  //   自检结论住在那台 **DSH Runtime 进程**里（`startupSelfCheck` 的输出，
  //   以及它翻成的 `repair`）。Launcher 是一个**独立进程**——它 import 不到、
  //   也探测不到那份结论（`executor-binding.mjs:254-261` 对同一件事有过一句
  //   同源的说明）。所以本进程**没有**诊断来源，而"没有来源"这件事
  //   必须以 `NO_DIAGNOSIS`（退出 3）如实报出来，**不是**退出 0。
  //
  //     > 一个"因为读不到结论所以什么都没报"的体检，
  //     > 与一个"结论是一切正常"的体检，在退出码上是同一个东西——
  //     > 只不过前者会让一个已经坏掉的部署安静地通过门禁。
  //
  //   它长成 stdin 而不是某个"约定好的文件"，是因为**没有任何生产者会写那个文件**：
  //   发明一个只有本模块认识的文件格式，等于把"读不到"伪装成"读的是一个真来源"。
  //   管道是诚实的：对面有什么，就诊断什么。
  //
  // 附注：这份输入里有**没有**秘密？自检结论里只有检查项名与原因码，不含 token；
  // 但仍**只从 stdin 读**，与 `--wizard` 的密钥同一条纪律——argv 会进 shell 历史。
  if (parsed.flags.doctor === true) {
    let raw = null
    try {
      raw = await readStdinFn()
    } catch (e) {
      raw = null
      diagNote = `读 stdin 失败：${e?.message ?? String(e)}`
    }
    const input = parseDiagnosisInput(raw)
    const rep = doctorReport({ ...input, source: input.source ?? 'stdin', ...(diagNote === null ? {} : { note: diagNote }) })
    if (json) write(JSON.stringify(rep, null, 2))
    else write(renderDoctor(rep))
    return rep.exitCode
  }

  // ── DSH 运行时安装：计划（零副作用）与**显式**应用（PRT-257）───────────
  //
  // ★ 这一支放在**布局门禁之前**，与 `--doctor` 同一个理由：安装运行时这件事
  //   最需要在产品还没装好、布局还不完整的时候被问到。计划自己会把
  //   "数据目录没定下来"如实报成一条拒绝（退出 1），而不是被上面某一道
  //   别的门禁换成一个与安装无关的错误。
  //
  // ★ 应用那一边的四条硬要求，逐条对应下面四行：
  //   ① 必须显式给出 `--runtime-install`（没有任何配置键、环境变量能打开它）；
  //   ② 计划必须 `ok === true`（被拒绝的计划**一次都不执行**）；
  //   ③ 执行之前先把**将要跑的那条命令**打出来；
  //   ④ 测试进程里构造不出真实运行器（`underNodeTestRunner()`，见上面那条注释）。
  if (parsed.flags['runtime-install-plan'] === true || parsed.flags['runtime-install'] === true) {
    const applying = parsed.flags['runtime-install'] === true
    const dryRun = parsed.flags['dry-run'] === true
    const manifestFlag = parsed.flags['runtime-manifest']
    const manifestRead = runtimeManifestFrom({
      manifestPath: typeof manifestFlag === 'string' ? manifestFlag : null,
    })

    // 计划阶段**只读**：清单、产品配置、现役指针。`readActiveRuntime` 是一次
    // 纯读——它让 `relation` 能区分 fresh / upgrade / downgrade，而
    // "没读过"与"没装过"是两件不同的事，所以这里必须读一次再传进去。
    let plan = null
    if (manifestRead.ok === true) {
      const mod = await runtimeInstallModuleFn()
      const active = mod.readActiveRuntime({ dataDir: options.layout?.dataDir ?? null })
      plan = mod.planRuntimeInstall(runtimeInstallInputFrom({
        layout: options.layout,
        env,
        manifest: manifestRead.manifest,
        active,
        platform: options.layout?.platform ?? process.platform,
      }))
    }

    const exitCode = manifestRead.ok !== true
      ? RUNTIME_INSTALL_CLI_EXIT.UNDIAGNOSED
      : (plan.ok === true ? RUNTIME_INSTALL_CLI_EXIT.PLANNED : RUNTIME_INSTALL_CLI_EXIT.REFUSED)

    if (json) {
      write(JSON.stringify({
        phase: 'runtime-install-plan',
        ok: exitCode === RUNTIME_INSTALL_CLI_EXIT.PLANNED,
        exitCode,
        code: manifestRead.ok === true ? plan.code : manifestRead.code,
        manifest: manifestRead.ok === true
          ? {
            path: manifestRead.path,
            digest: manifestRead.digest,
            productVersion: manifestRead.manifest.productVersion,
            dshVersion: manifestRead.manifest.dshVersion,
            dshCompositionPatchVersion: manifestRead.manifest.dshCompositionPatchVersion,
            channel: manifestRead.manifest.channel,
          }
          : { path: manifestRead.path, digest: null },
        manifestProblems: manifestRead.problems,
        plan,
        repair: plan?.repair ?? null,
      }, null, 2))
    } else {
      write(renderRuntimePlan({ manifestRead, plan, applying, dryRun }))
    }

    // 计划没通过 ⇒ **到此为止**。被拒绝的计划在 `installRuntime` 里本来就会抛，
    // 而"在调用它之前就返回"比"靠它自己抛"更硬：前者不依赖模块的守卫还写着。
    if (exitCode !== RUNTIME_INSTALL_CLI_EXIT.PLANNED) return exitCode
    if (applying !== true || dryRun === true) return RUNTIME_INSTALL_CLI_EXIT.PLANNED

    // ①② 已经过了（显式开关 + 计划 ok）。③ 先说要做什么，再动手。
    const command = `${plan.installCommand.file} ${plan.installCommand.args.join(' ')}`
    writeErr(`⚠ 即将执行真实安装（npm install，会联网、会写 ${options.layout?.dataDir ?? '(数据目录未定)'}）：`)
    writeErr(`  ${command}`)

    const mod = await runtimeInstallModuleFn()
    let runner = null
    if (npmRunnerFn === null) {
      if (underNodeTestRunner()) {
        // ④ 结构性事实：测试进程里**没有**真实运行器可构造。
        writeErr('✖ 本进程跑在 node 测试运行器里（NODE_TEST_CONTEXT 已设）：拒绝构造真实 npm 运行器。')
        writeErr('  这不是"安装失败"，而是"这一次不允许真的去装"——用例必须注入运行器才能跑完安装。')
        return RUNTIME_INSTALL_CLI_EXIT.APPLY_FAILED
      }
      runner = mod.createNpmRunner()
    } else {
      runner = npmRunnerFn()
    }

    const result = mod.installRuntime({ plan, runner })
    if (json) {
      write(JSON.stringify({ phase: 'runtime-install', ...result }, null, 2))
    } else if (result.ok === true) {
      write(`✔ ${result.message}`)
      write(`  指针：${result.pointerPath}（现役 ${result.targetVersion}，上一版 ${result.previousVersion ?? '（无）'}）`)
      for (const c of result.verify.checks) write(`  ${c.ok === true ? '✔' : '✖'} ${c.label}：${c.detail ?? ''}`)
      write('  回滚：node product/launcher/cli.mjs --doctor（只提示，不自动改）')
    } else {
      write(`✖ 安装未完成（${result.code}）`)
      write(`  ${result.message}`)
      write('  指针**没有动**：旧版本仍然现役。这次失败只可能在 versions/ 下留下一个没有完成标记的目录。')
      for (const s of result.stages.filter((x) => x.ok !== true)) {
        write(`  · 出错的阶段：${s.stage}（${s.detail ?? '无详情'}）`)
      }
      if (result.repair !== null) write(`  下一步：${result.repair.command}`)
    }
    return result.ok === true ? 0 : RUNTIME_INSTALL_CLI_EXIT.APPLY_FAILED
  }

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
//   9 = `--wizard` 自己抛错（HEAD 起就在用，只是此前一直没写进这份契约——
//       一条"已经在用但没登记"的退出码，与一条没人用的退出码，
//       在读这份契约的人眼里是同一个东西：都不存在）。
//
// ★ PRT-257 的运行时安装入口**不复用**上表，它有自己的四档
//   （`RUNTIME_INSTALL_CLI_EXIT`，前三档与 `doctor.mjs` 的 `DOCTOR_EXIT` 同形）：
//     0 = 计划可执行；1 = 计划被拒绝（附下一步）；3 = 算不出计划（缺清单）；
//     10 = 计划过了但没装成。
//   为什么不并进 `EXIT_CODES`：上表是**启动流程**的读数，而这几档是**安装**的
//   读数；`1` 在本 CLI 里是全新的一个值（此前没有任何路径返回过它）。
//   `3` 两处含义一致（"拿不到结论，不能自动往前走"），不需要第二个数字；
//   而 `10` 取下一个没被占的数（`9` 是向导的），因为"向导抛错"与
//   "运行时装不上"是两件不同的、需要做不同下一步的事。
export const EXIT_CODES = Object.freeze({
  ok: 0, args: 2, layout: 3, check: 4, start: 5, config: 6, init: 7,
})

export { DEFAULT_BACKOFF }
