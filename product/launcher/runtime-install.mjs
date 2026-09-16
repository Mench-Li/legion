// product/launcher/runtime-install.mjs
// ============================================================================
// PRT-257：把 DSH 运行时**装进 DataDir**（PRT-011 路线 C 的生产半边）
//
// ## 这个文件补的是哪一截
//
// `PRT-011-dsh-distribution-decision.md:130-137` 把路线 C 拆成四件事交给 Launcher：
// 版本解析与锁定、安装位置、原子切换与回滚、不得编辑 shipped preset install。
// 本目录里其余东西（向导、首次运行、doctor、端口、就绪、监督、单实例、托盘、
// 日志策略、诊断包）都已经在，而这四件事的**生产实现是零**：
//
//   > 一个"决定了从 npm 装 DSH 进 DataDir"的产品，
//   > 与一个"从来没有把任何一个字节装进去过"的产品，在用户手上是同一个东西——
//   > 只不过前者的决策文档写得很完整。
//
// ## 一、判据（纯）与效果（脏）分成两半
//
//   · `planRuntimeInstall()` —— **纯**。它只做判断：路径边界、版本形状、版本区间、
//     补丁层与 DSH 的成对关系。返回一份冻结的、可断言的计划，**零 IO**。
//   · `installRuntime()`    —— 干活。它只执行已经被判定为可执行的计划。
//
// 这么分的理由不是洁癖：**拒绝必须发生在任何目录被创建之前**。把边界判断
// 和 `mkdirSync` 写在一个函数里，"被拒绝"与"拒绝之前先建了一个空目录"
// 在返回值上长得一模一样——而后者会在下一次重试时变成一个存在但没装完的版本目录。
//
//   > 一个"先建目录再判边界"的安装器，
//   > 与一个"边界判定通过"的安装器，在每次判定都通过的那些运行里是同一个东西——
//   > 只不过前者的红是在磁盘上，而不只是在返回值里。
//
// ## 二、原子切换：指针是一个**文件**，不是目录软链
//
// 装到 `versions/<版本>/`，校验通过之后才写 `current.json`；写完才算切换。
// 指针用「写临时文件 + `rename` 覆盖」而不是「删掉旧软链再建新软链」：文件级的
// rename 在同一卷上是原子的（读者要么看到旧的、要么看到新的），而目录软链的
// "先删后建"中间一定有一个**两边都不指向**的窗口。
//
//   > 一个"先删旧指针再写新指针"的切换，与一个"新旧之间没有任何窗口"的切换，
//   > 在没人恰好在那 2 毫秒里读它的那些运行里是同一个东西——
//   > 只不过前者会在恰好那一刻启动的部署上，报出"没装过运行时"。
//
// **Windows 上的诚实边界**：`fs.renameSync` 覆盖一个已存在的目标在 libuv 里是
// `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，语义上是原子的；但目标文件**正被
// 另一个进程打开**时（杀毒、索引器、或一个正在读它的 Launcher）它会 `EPERM`。
// 本模块**不做任何降级重试**（"删掉再 rename"会把原子性换成一次确定性的空窗），
// 只把失败如实报成 `RUNTIME_INSTALL_POINTER_SWITCH_FAILED`——那时指针**还是旧的**，
// 而旧版本仍然可用，这正是本模块要的那个结果。
//
// ## 三、完成标记：一个"目录存在"的判据不等于一个"这次装完了"的判据
//
// 版本目录**最后一步**才写 `install-complete.json`。指针只在校验通过之后才动，
// 所以标记并不参与"指针会不会指向半装目录"——它参与的是**下一次**：
// 一次崩在中间的安装在磁盘上留下 `versions/<版本>/`，而它与一个装好的目录
// 在 `existsSync` 上完全一样。
//
//   > 一个"目录存在"的判据，
//   > 与一个"这次的安装完成了"的判据，在安装总是成功时是同一个东西。
//
// 所以 `installRuntime` 对"目标目录已经在了"的处理是**读标记**：
// 有标记 ⇒ 拒绝覆盖（那是一次已经生效的安装）；没标记 ⇒ 删掉重装。
// `readActiveRuntime` 也读它：指针指向一个没有标记的目录时报 `broken`，
// 而不是报 `active`。
//
// ## 四、`dshCompositionPatchVersion`：这是**一对**版本，不是一个和一个
//
// spec §9.1（`2026-09-11-legion-product-runtime-design.md:688-698`）：
// 「`dshCompositionPatchVersion` 与 `dshVersion` **强绑定**：补丁层通过 patch
// 锚点作用于 DSH bundle，锚点随 DSH 版本变化，因此两者必须**成对验证**，
// 不允许出现"Dsh 已升级但补丁层仍是旧锚点"的组合。」
//
// 于是本模块带的判据是**一个绑定表**：`patchBindings` =
// 已知可用的 `{dshVersion, compositionPatchVersion}` 组合清单。清单声明的那一对
// 不在表里 ⇒ 拒绝（`RUNTIME_INSTALL_PATCH_PAIR_MISMATCH`），并在文案里说清是
// **哪一侧**没有对应物。没给绑定表 ⇒ 也拒绝（`PATCH_PAIR_UNVERIFIED`）：
//
//   > 一个"没有绑定表于是默认放行"的成对校验，
//   > 与一个从来没有查过成对关系的校验，是同一个东西。
//
// 判据形状与 `product/upgrade/index.mjs` 的 `patchPairOf()` **刻意一致**
// （同三态、同表结构）。没有 import 它，是因为那个模块连同 `manifest.mjs`
// 把升级审计的整条依赖拖进 Launcher 的进程，而 Launcher 的职责恰恰是
// "在那些东西起来之前先把进程看好"（同一条理由写在 `dsh-overlay.mjs:64-73`）。
// 代价是两处判断可能漂移——所以用例里有一条拿**真** `patchPairOf()` 逐格对拍。
//
// ## 五、清单是版本的**唯一**来源：这不是包管理器
//
// spec §9.1 同一段：「客户**不能在产品内单独升级 DSH**。」所以本模块**没有**
// 任何向 npm 问 "latest" 的代码路径：要装哪个版本是 `targetVersion` 入参，
// 受支持区间是 `supportedRange` 入参，成对关系是 `patchBindings` 入参。
//
//   > 一个"向 npm 问 latest"的解析器，
//   > 与一个"读清单声明的版本"的解析器，在两者恰好一致的那些日子里是同一个东西。
//
// 区间判据（`rangeSatisfied`）**缺省就是生产实现** `satisfiesRange`
// （`runtime/packs/manifest.mjs`），显式传 `null` 才关掉它、那时走
// `RANGE_UNCHECKED` 拒绝：一个"没有区间判据于是默认放行"的实现与一个
// 不检查区间的实现是同一个东西。
//
// ★ 上一版把缺省写成 `null`，并把"生产里由调用方接上"写在这里——那句话
//   是**错的**，而且错得很贵：它让任何真实调用都在 `RANGE_UNCHECKED` 上停下，
//   于是这个安装器**一个东西都装不了**，而"为什么装不了"在读数上与
//   "区间判据正确地拒绝了"长得一模一样。接线现在落在被用例覆盖的函数里面
//   （`product/logging/sink.mjs:45` 早就在 `product/` 里 import `runtime/`，
//   而 `dsh-boundary` 守的是 DSH 执行面记号、不是这条）。
//
// ★ 两个"版本号"不是同一个命名空间：PRT-011 §1.1 记的 `0.1.5-rc.2` 是 npm 上
//   `@deepseek-ai/dsh` 的**包版本**，spec §9.1 例子里的 `0.8.3` 是**产品清单字段**
//   的示例值。本模块只处理后者（清单声明的值），不把它与任何包版本互相换算。
//
// ## 六、不做的事
//
//   · **不进 InstallDir**（PRT-011 §2.1 引 PRT-001 §2.1 的同类问题）：
//     运行时是可变状态，安装目录是"升级时被整体替换"的只读面。
//   · **不碰 shipped preset install**：DSH 自带 preset 一律只读，Legion 自有内容
//     只进 `profiles/<profile>/cordis.patch.yml` 用户层。本模块的所有写入都被
//     `createRuntimeWriteGuard()` 逐次挡在 DataDir 内，落在只读根上的写入**抛**。
//   · **不发布 npm 包**（PRT-011 §3 第 3 条的另一半）。Legion 的四个 `file:` 包
//     走 **junction**：源是 Legion 安装目录里的四个包目录，落点是装好的运行时
//     的 `node_modules/@dsh-external/`。`plan.legion.route` 明写选了哪条路。
// ============================================================================

import { spawnSync } from 'node:child_process'
import {
  chmodSync, closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { isPathInside, normalizePath, samePath } from '../paths.mjs'
// 区间判据的**生产实现**（通用 semver，与 DSH 无耦合）。见 `planRuntimeInstall()`
// 里 `rangeSatisfied` 缺省值那一段：接线必须落在被用例覆盖的函数**里面**。
//
// `product/` 在 `scripts/ci/dsh-boundary.mjs` 里是"必须为零"的边界模块，
// 但那条闸守的是 **DSH 执行面记号**——执行面的那几个**服务名**与几个
// **包名**（不在这里写出来：那是一条文本扫描，注释里的记号与真实依赖
// 在它眼里是同一个东西，本行第一版就因此被判成"新增执行面依赖"）。
// 它**不是**"不许 import `runtime/`"：既有的生产代码早就在这么做
// （`product/logging/sink.mjs:45` → `runtime/contracts/redact-patterns.mjs`）。
import { satisfiesRange } from '../../runtime/packs/manifest.mjs'

/** 本模块的版本。落进计划与结果，便于把一次安装与一份实现对起来。 */
export const RUNTIME_INSTALL_VERSION = 1

/**
 * DSH 运行时在 **DataDir** 内的相对位置。
 *
 * `<DataDir>/runtime/` 已经是既有的约定（`runtime/runtime-contract.json` 就写在
 * 它下面，见 `runtime/dsh-composition/runtime-contract-publication.mjs:87`），
 * 这里只是**再下一层**给运行时用。与 InstallDir 无关，这是本模块最要紧的一条：
 *
 *   > 把 1.6 GB 的运行时写进"升级时被整体替换"的那棵树，
 *   > 与把用户数据写进去，是同一种错误——只不过前者更大、更难回退。
 */
export const RUNTIME_ROOT_PARTS = Object.freeze(['runtime', 'dsh'])

/** 版本目录的父目录名。 */
export const VERSIONS_DIRNAME = 'versions'

/** 指针文件名（相对运行时的根）。**切换的就是这个文件**。 */
export const POINTER_FILENAME = 'current.json'

/**
 * 上一个现役版本的指针。回滚读它。
 *
 * 之所以**存一行**而不是"回滚 = 装回清单里那个更旧的版本"：安装器不知道
 * "上一次用的是哪个"，而"我以为它是上一版"与"它真的是上一版"在回滚失败时
 * 是两种完全不同的处境。
 */
export const PREVIOUS_POINTER_FILENAME = 'previous.json'

/**
 * 完成标记文件名（相对**版本目录**）。
 *
 * 写在版本目录里的**最后一步**。它回答的是"这一次安装装完了吗"——
 * 一个与"这个目录在不在"不同的问题（见文件头 §三）。
 */
export const COMPLETION_MARKER_FILENAME = 'install-complete.json'

/** Node 的包目录名。 */
export const NODE_MODULES_DIRNAME = 'node_modules'

/**
 * npm 输出的**进度日志**文件名（相对版本目录）。
 *
 * 为什么它必须真的存在，而不只是"我们想报进度"：`installRuntime` 是同步的，
 * `spawnSync` 会把本线程挡到 npm 退出为止，所以这 600 秒里本进程报不出任何进度。
 * 把 npm 的 stdout/stderr 直接交给两个**继承的文件描述符**，是在"不能改成异步"
 * 的前提下唯一能做出**真进度面**的办法：另一个进程在 npm 还在跑的时候就能读到它。
 * 详见 `createNpmRunner`。
 */
export const NPM_LOG_FILENAME = 'npm-install.log'

/** 从日志文件里读回来的尾部长度上限（失败文案只要尾部，不要几 MB）。 */
const LOG_TAIL_CHARS = 8_000

/**
 * DSH 在 npm 上的包名。**默认值，不是硬编码**：调用方可以覆盖。
 *
 * 它是 `installCommand` 里唯一一个拼出来的包名，版本号不在里面——
 * 版本永远来自 `targetVersion` 入参（清单），不来自 `@latest`。
 */
export const DEFAULT_DSH_PACKAGE = '@deepseek-ai/dsh'

/**
 * 运行时入口在**包内**的相对路径（相对 `node_modules/<包名>/`）。
 *
 * 取自 PRT-011 §1.1 实测的 `bin`：`{ "dsh": "lib/bin.js" }`。
 * 它是"这个版本装好了没有"的**可执行**判据：一个只判 `node_modules/<包名>/`
 * 目录存在的校验，会在一次只装了一半的 npm 安装上全绿。
 */
export const DEFAULT_ENTRY_RELPATH = 'lib/bin.js'

/** Legion 自己的 `file:` 包前缀（与 `scripts/prt/composition-baseline.mjs` 一致）。 */
export const LEGION_PACKAGE_PREFIX = '@dsh-external/'

/**
 * Legion 自有四个 `file:` 包的**仓库内来源目录**。
 *
 * 逐字取自 `scripts/prt/composition-baseline.mjs:51-56` 的 `LEGION_PACKAGES`
 * （PRT-010 §2.3 记录了这四个包都是 `file:` 依赖且 `pointsAtRepoDir: true`）。
 * 这里再写一次字面量而不是 import 那个脚本：它是 `scripts/` 下的**采集工具**，
 * 带着自己的 CLI 入口与快照路径。代价是两处可能漂移——用例里有一条钉住
 * 四对 `(包名, 目录名)` 与那份表逐对相等。
 *
 * ★ 四个包的**入口形状不一样**：`services-plugin` 的 `main` 是 `./index.js`，
 *   另外三个是 `./lib/index.js`。所以这里只记"包名 + 源目录"，**不记入口**——
 *   入口由各自的 `package.json` 说了算，由 DSH 的加载器去解析。
 *   在这一层编一个统一入口，会在 services-plugin 那一行上变成一个指不到东西的路径。
 */
export const LEGION_FILE_PACKAGES = Object.freeze([
  Object.freeze({ name: '@dsh-external/dsh-team-hub', repoDir: 'team-hub' }),
  Object.freeze({ name: '@dsh-external/dsh-scrum-worker', repoDir: 'plugins' }),
  Object.freeze({ name: '@dsh-external/dsh-scrum-board', repoDir: 'board-plugin' }),
  Object.freeze({ name: '@dsh-external/dsh-legion-services', repoDir: 'services-plugin' }),
])

/**
 * Legion 自有包接进安装好的运行时的**路线**。
 *
 * PRT-011 §3 第 3 条给了两条路（发布成 npm 包 / 由 Launcher 从安装目录做 junction），
 * 并说"PRT-257 必须先回答它"。本模块选了 junction，并把选择**写进计划**
 * （`plan.legion.route`），而不是只写在注释里：
 *
 *   > 一个"路线写在文档里"的决定，
 *   > 与一个"每一次安装都真的照着它做"的决定，在文档没被读的那些日子里是同一个东西。
 */
export const LEGION_ROUTE_JUNCTION = 'junction-from-install-dir'

/** 计划里 `targetDirPolicy` 的取值。见 `planRuntimeInstall` 的说明。 */
export const TARGET_DIR_POLICY = Object.freeze({
  /** 目标版本目录不存在（或调用方已观测为不存在）。 */
  CREATE: 'create',
  /** 调用方已观测到目标目录存在但**没有完成标记**。 */
  REPLACE_INCOMPLETE: 'replace-incomplete',
  /** 交给 `installRuntime` 用真实 fs 读标记再定（缺省）。 */
  DECIDE_AT_APPLY: 'decide-at-apply',
})

/** 本模块的具名码。每一条都对应一种**下一步动作不同**的处境。 */
export const RUNTIME_INSTALL_CODES = Object.freeze({
  // ── 位置（全部在纯计划里判，**任何目录被创建之前**）──────────────────
  /** 没有 DataDir —— 不知道往哪儿装。 */
  NO_DATA_DIR: 'RUNTIME_INSTALL_NO_DATA_DIR',
  /** DataDir 不是绝对路径。 */
  DATA_DIR_NOT_ABSOLUTE: 'RUNTIME_INSTALL_DATA_DIR_NOT_ABSOLUTE',
  /** 目标落在**真实 operator 的** `$DSH_HOME` / `~/.dsh` 里。 */
  TARGET_INSIDE_DSH_HOME: 'RUNTIME_INSTALL_TARGET_INSIDE_DSH_HOME',
  /** 目标落在 InstallDir 里（PRT-011 §2.1 明确禁止）。 */
  TARGET_INSIDE_INSTALL_DIR: 'RUNTIME_INSTALL_TARGET_INSIDE_INSTALL_DIR',
  /** 目标越出调用方给的允许根（含"没给允许根"——那按越界处理）。 */
  TARGET_OUTSIDE_ALLOWED_ROOT: 'RUNTIME_INSTALL_TARGET_OUTSIDE_ALLOWED_ROOT',

  // ── 版本（同样在纯计划里判）────────────────────────────────────────
  /** 版本字符串形状不认识。 */
  VERSION_MALFORMED: 'RUNTIME_INSTALL_VERSION_MALFORMED',
  /** 区间判据没给、给了但判不出来、或区间本身是空的。**一律拒绝**。 */
  RANGE_UNCHECKED: 'RUNTIME_INSTALL_RANGE_UNCHECKED',
  /** 版本确实落在受支持区间之外。 */
  VERSION_OUT_OF_RANGE: 'RUNTIME_INSTALL_VERSION_OUT_OF_RANGE',

  // ── §9.1 成对（同样在纯计划里判）──────────────────────────────────
  /** 清单声明的 `(dshVersion, dshCompositionPatchVersion)` 不在已知绑定表里。 */
  PATCH_PAIR_MISMATCH: 'RUNTIME_INSTALL_PATCH_PAIR_MISMATCH',
  /** 没给绑定表 —— "没有验证过"不等于"验证通过"。 */
  PATCH_PAIR_UNVERIFIED: 'RUNTIME_INSTALL_PATCH_PAIR_UNVERIFIED',

  // ── 效果（`installRuntime` / `rollbackRuntime`）────────────────────
  /** 有一个 Legion `file:` 包的源目录不在（junction 会指向空处）。 */
  LEGION_SOURCE_MISSING: 'RUNTIME_INSTALL_LEGION_SOURCE_MISSING',
  /** 目标版本目录已存在**且带完成标记** —— 不覆盖一次已经生效的安装。 */
  TARGET_DIR_EXISTS: 'RUNTIME_INSTALL_TARGET_DIR_EXISTS',
  /** 命令运行器失败（非零退出 / 抛错）。 */
  RUNNER_FAILED: 'RUNTIME_INSTALL_RUNNER_FAILED',
  /** 装完了，但校验没过 —— **此时指针一定还没动**。 */
  VERIFY_FAILED: 'RUNTIME_INSTALL_VERIFY_FAILED',
  /** 一次写入（或一次链接）落在允许根之外 / 只读根之内，被挡下。 */
  WRITE_REFUSED: 'RUNTIME_INSTALL_WRITE_REFUSED',
  /** 指针文件在、但读不懂（不是 JSON / 不是我写的形状）。 */
  POINTER_UNREADABLE: 'RUNTIME_INSTALL_POINTER_UNREADABLE',
  /** 指针切换失败（Windows 上最常见：目标文件正被别人打开）。**旧指针还在**。 */
  POINTER_SWITCH_FAILED: 'RUNTIME_INSTALL_POINTER_SWITCH_FAILED',
  /** 指针**指着一个**没有完成标记 / 入口文件不在的目录。 */
  ACTIVE_RUNTIME_INCOMPLETE: 'RUNTIME_INSTALL_ACTIVE_RUNTIME_INCOMPLETE',
  /** 没有可回滚的目标（从未切换过 / `previous.json` 不在）。 */
  ROLLBACK_UNAVAILABLE: 'RUNTIME_INSTALL_ROLLBACK_UNAVAILABLE',
  /** 回滚目标目录存在，但**缺完成标记 / 入口文件不在**。 */
  ROLLBACK_TARGET_INCOMPLETE: 'RUNTIME_INSTALL_ROLLBACK_TARGET_INCOMPLETE',
  /** 没有被上面任何一支接住的抛出。收口用，**不是**某一类失败的同义词。 */
  UNEXPECTED: 'RUNTIME_INSTALL_UNEXPECTED',
})

/** 指向已存在修复入口的"下一步"。**每条拒绝都带它**（spec §6.3：提示修复或回滚）。 */
export function runtimeInstallRepair() {
  return Object.freeze({
    command: 'node product/launcher/cli.mjs --doctor',
    why: '把这次自检结论从 stdin 交给修复入口：它逐项给出修法或回滚路径，'
      + '并且**只提示、不自动改**（自动改用户环境的"修复"在改坏的那天没人能回退）',
  })
}

// ---------------------------------------------------------------- 版本

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/

/**
 * 解析一个语义版本；形状不对返回 `null`。
 *
 * 只接受完整三段（`1.2` 不接受）：`1.2` 在有的生态里是 `1.2.0`、在有的生态里
 * 是范围，而这里要的是一个**确定的值**——歧义解析与"猜"是同一件事。
 *
 * 接受预发布（`0.1.5-rc.2` 是本产品实际要面对的形状）与 build 元数据
 * （build 不参与比较，SemVer 如此）。
 */
export function parseDshVersion(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  const m = VERSION_RE.exec(raw)
  if (m === null) return null
  return Object.freeze({
    raw,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? null : m[4],
    build: m[5] === undefined ? null : m[5],
  })
}

function comparePrerelease(a, b) {
  const x = a.split('.')
  const y = b.split('.')
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i += 1) {
    if (x[i] === y[i]) continue
    const xn = /^\d+$/.test(x[i])
    const yn = /^\d+$/.test(y[i])
    if (xn && yn) return Number(x[i]) < Number(y[i]) ? -1 : 1
    if (xn) return -1
    if (yn) return 1
    return x[i] < y[i] ? -1 : 1
  }
  if (x.length === y.length) return 0
  return x.length < y.length ? -1 : 1
}

/**
 * 版本比较：`-1` / `0` / `1`；任一侧畸形则返回 `null`（**不抛**）。
 *
 * 返回 `null` 而不是抛，是因为调用它的是"这两个哪个更新"的读数，而
 * "比不出来"与"一样新"必须分开——把前者读成后者会让 `upgrade` 变成 `same`。
 */
export function compareDshVersions(a, b) {
  const x = typeof a === 'string' ? parseDshVersion(a) : a
  const y = typeof b === 'string' ? parseDshVersion(b) : b
  if (x === null || y === null || x === undefined || y === undefined) return null
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1
  }
  if (x.prerelease === y.prerelease) return 0
  if (x.prerelease === null) return 1
  if (y.prerelease === null) return -1
  return comparePrerelease(x.prerelease, y.prerelease)
}

// ---------------------------------------------------------------- 路径

const parts = (...xs) => xs.filter((x) => x !== null && x !== undefined)
const splitParts = (rel) => rel.split('/').filter((s) => s !== '')

/**
 * 与**具体版本无关**的那几个路径。纯拼接，不碰磁盘。
 *
 * 与 `runtimePathsOf()` 分开是有判据的：**边界判定必须先于版本判定**。
 * 合在一起的话，"版本字符串畸形"这条拒绝在算路径时就会先撞上路径拼接，
 * 而它要证明的恰恰是"拒绝发生在任何目录被创建之前"——顺序错了，
 * 那条证据就不再成立（`join(versionsDir, '..')` 会指到运行时根上）。
 */
export function runtimeRootOf({ dataDir } = {}) {
  const runtimeRoot = join(resolve(String(dataDir)), ...RUNTIME_ROOT_PARTS)
  return Object.freeze({
    runtimeRoot,
    versionsDir: join(runtimeRoot, VERSIONS_DIRNAME),
    pointerPath: join(runtimeRoot, POINTER_FILENAME),
    previousPointerPath: join(runtimeRoot, PREVIOUS_POINTER_FILENAME),
  })
}

/**
 * 一个目标版本的**全部路径**。纯函数：只做拼接，不碰磁盘。
 *
 * 单独抽出来是因为下游有三个地方要问"这个版本的入口文件在哪"
 * （校验、指针内容、回滚），而三处各拼一次就是三份会漂移的写法。
 *
 * ★ `targetVersion` 必须是**已经通过 `parseDshVersion`** 的值。这里再挡一次
 *   路径分隔符与 `..`：本函数是导出的，而"调用方一定先校验过"是一个
 *   在有人直接调它的那天不成立的假设。
 *
 * @throws {TypeError} 版本形状不合法（含含分隔符 / `..` 的写法）。
 */
export function runtimePathsOf({
  dataDir,
  targetVersion,
  packageName = DEFAULT_DSH_PACKAGE,
  entryRelpath = DEFAULT_ENTRY_RELPATH,
} = {}) {
  const v = String(targetVersion ?? '').trim()
  if (parseDshVersion(v) === null) {
    throw new TypeError(`runtimePathsOf 需要合法版本号（含版本目录名，不接受路径片段）：收到 ${JSON.stringify(targetVersion)}`)
  }
  const { runtimeRoot, versionsDir, pointerPath, previousPointerPath } = runtimeRootOf({ dataDir })
  const versionDir = join(versionsDir, v)
  const packageDir = join(versionDir, NODE_MODULES_DIRNAME, ...splitParts(String(packageName)))
  return Object.freeze({
    runtimeRoot,
    versionsDir,
    versionDir,
    packageDir,
    entryPath: join(packageDir, ...splitParts(String(entryRelpath))),
    markerPath: join(versionDir, COMPLETION_MARKER_FILENAME),
    pointerPath,
    previousPointerPath,
  })
}

/** 拒绝/结论的**唯一**构造点。任何 `ok: true` 都不从这里出。 */
function refuse({ code, message, detail = null, fields = {} }) {
  return Object.freeze({
    version: RUNTIME_INSTALL_VERSION,
    ok: false,
    stage: 'refused',
    code,
    message,
    detail,
    repair: runtimeInstallRepair(),
    diagnostics: Object.freeze([]),
    ...fields,
  })
}

/**
 * §9.1 的成对判据。返回 `{verdict, side, knownGoodPatches, message}`。
 *
 * 三态与 `product/upgrade/index.mjs` 的 `patchPairOf()` 一致：
 * `'unverified'`（没给表）不是 `'match'`。
 *
 * ★ 比 `patchPairOf()` 多一件事：`side` 说清**是哪一侧**没有对应物。
 *   绑定表里**根本没有这个 DSH 版本** ⇒ `'dsh'`（这一版的锚点我们从没见过）；
 *   表里有这个 DSH 版本、但配的补丁层版本与清单声明的不一样 ⇒ `'patch'`
 *   （补丁层那一侧动了）。两种的下一步动作不同：前者要重新验证锚点，
 *   后者要对齐清单声明。
 */
export function dshPatchPairOf({ targetVersion, expectedPatchVersion, patchBindings = null } = {}) {
  if (!Array.isArray(patchBindings)) {
    return Object.freeze({
      verdict: 'unverified',
      side: null,
      knownGoodPatches: Object.freeze([]),
      message: '没有给出已知可用的 (dshVersion, dshCompositionPatchVersion) 绑定表：'
        + '没有验证过成对关系，不等于成对关系成立',
    })
  }
  const forDsh = patchBindings
    .filter((b) => b !== null && typeof b === 'object' && b.dshVersion === targetVersion)
    .map((b) => b.compositionPatchVersion)
  const patchOk = Number.isInteger(expectedPatchVersion) && expectedPatchVersion >= 1
  if (patchOk && forDsh.includes(expectedPatchVersion)) {
    return Object.freeze({
      verdict: 'match',
      side: null,
      knownGoodPatches: Object.freeze([...forDsh]),
      message: `DSH ${targetVersion} 与补丁层 ${expectedPatchVersion} 在已知绑定表里成对`,
    })
  }
  if (forDsh.length === 0) {
    return Object.freeze({
      verdict: 'mismatch',
      side: 'dsh',
      knownGoodPatches: Object.freeze([]),
      message: `绑定表里没有 DSH ${targetVersion}：这个 DSH 版本配哪一版补丁层锚点，我们从未验证过`
        + `（清单声明的补丁层版本是 ${JSON.stringify(expectedPatchVersion)}）`,
    })
  }
  return Object.freeze({
    verdict: 'mismatch',
    side: 'patch',
    knownGoodPatches: Object.freeze([...forDsh]),
    message: `DSH ${targetVersion} 在绑定表里配的补丁层版本是 ${forDsh.join('/')}，`
      + `清单声明的却是 ${JSON.stringify(expectedPatchVersion)}：`
      + '补丁锚点随 DSH 版本变化，锚点失效时进程照常启动而强制面（ToolGuard / pre-execute / '
      + 'approval answerer / preset 表）全都不在',
  })
}

/**
 * **纯**计划。零 IO：不读文件、不建目录、不起进程。
 *
 * ## 判定顺序（顺序本身是判据的一部分）
 *
 * 1. DataDir 在不在、是不是绝对路径；
 * 2. 目标是不是落在 `$DSH_HOME` / `~/.dsh` / InstallDir 里、有没有越出允许根；
 * 3. 版本字符串形状；
 * 4. 版本区间（**注入**的判据，缺省即拒绝）；
 * 5. §9.1 成对关系（绑定表，缺省即拒绝）。
 *
 * 前五条**任何一条不过就不返回 `ok: true`**，因此"被拒绝"这条路径上
 * 一次 `mkdirSync` 都没有发生过——这不是纪律，是结构：`installRuntime` 只接受
 * `ok === true` 的计划。
 *
 * ## 它**不**判什么（以及为什么）
 *
 * "目标版本目录在不在、有没有完成标记"是**磁盘读数**，而本函数是纯的。
 * 于是计划里写的是 `targetDirPolicy: 'decide-at-apply'`，由 `installRuntime`
 * 用真实 fs 读标记再定。刻意**不**接受调用方传一份"目录在不在"的副本：
 *
 *   > 一份"调用方说这个目录是空的"与一份"磁盘上这个目录真的没有完成标记"，
 *   > 在调用方没说错的时候是同一个读数——只不过前者会让安装器去覆盖一次
 *   > 已经生效（或已经装了一半）的安装。
 *
 * @returns {object} 冻结的计划；`ok === true` 才可交给 `installRuntime`。
 */
export function planRuntimeInstall({
  dataDir = null,
  allowedRoot = null,
  installDir = null,
  dshHome = null,
  operatorHome = null,
  shippedPresetRoot = null,
  targetVersion = null,
  supportedRange = null,
  // ★★ 缺省**就是生产实现**，不是 `null`。
  //
  // 上一版把它写成 `null`，理由是"没有区间判据于是默认放行的实现，与不检查
  // 区间的实现是同一个东西"——那条理由本身是对的，但结论落错了地方：
  // 它把一个**接线缺口**变成了一个**运行期拒绝**，于是任何真实调用都会拿到
  // `RANGE_UNCHECKED`，安装器**什么都装不了**，而"为什么装不了"在读数上
  // 与"区间判据被正确地拒绝了"长得一模一样。
  //
  //   > 一根"没有任何调用方会传"的接线，
  //   > 与一根"故意不接、要求调用方显式提供"的接线，
  //   > 在每一次被拒绝的调用上都是同一个东西——
  //   > 只不过前者是缺陷，而后者看起来像纪律。
  //
  // 所以默认值取 `satisfiesRange`（`runtime/packs/manifest.mjs`，一个通用
  // semver 区间判据，与 DSH 无耦合）：**接线落在被用例覆盖的函数里面**，
  // 而不是落在一个没人能跑到的组装点。显式传 `null`/`undefined` 仍然可以
  // 关掉它——那时才真的走 `RANGE_UNCHECKED`（fail-closed 保留）。
  rangeSatisfied = satisfiesRange,
  expectedPatchVersion = null,
  installedVersion = null,
  installedPatchVersion = null,
  patchBindings = null,
  packageName = DEFAULT_DSH_PACKAGE,
  legionPackages = LEGION_FILE_PACKAGES,
  legionSourceRoot = null,
  entryRelpath = DEFAULT_ENTRY_RELPATH,
  platform = process.platform,
} = {}) {
  const norm = (v) => (typeof v === 'string' && v.trim() !== '' ? normalizePath(v, platform) : null)

  // ── ① DataDir ──────────────────────────────────────────────────────────
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    return refuse({
      code: RUNTIME_INSTALL_CODES.NO_DATA_DIR,
      message: '没有 DataDir：DSH 运行时按 PRT-011 §2.1 装在数据目录里，'
        + '而安装目录是"升级时被整体替换"的只读面，不能放进去',
    })
  }
  if (!isAbsolute(dataDir)) {
    return refuse({
      code: RUNTIME_INSTALL_CODES.DATA_DIR_NOT_ABSOLUTE,
      message: `DataDir 不是绝对路径：${JSON.stringify(dataDir)}。`
        + '相对路径的落点取决于当时的 cwd，于是"装到哪了"在两次启动之间可以不同',
    })
  }

  const roots = {
    dataDir: normalizePath(dataDir, platform),
    installDir: norm(installDir),
    dshHome: norm(dshHome),
    operatorHome: norm(operatorHome),
    allowedRoot: norm(allowedRoot),
    shippedPresetRoot: norm(shippedPresetRoot),
    legionSourceRoot: norm(legionSourceRoot) ?? norm(installDir),
  }
  const base = runtimeRootOf({ dataDir: roots.dataDir })

  // ── ② 边界：先算目标，再判它落在谁的地盘上 ────────────────────────────
  if (roots.dshHome !== null && isPathInside(roots.dshHome, base.runtimeRoot, platform)) {
    return refuse({
      code: RUNTIME_INSTALL_CODES.TARGET_INSIDE_DSH_HOME,
      message: `运行时会落到真实 operator 的 DSH 家目录里（${roots.dshHome}）：${base.runtimeRoot}。`
        + '那是**另一个程序**拥有的目录：它的 clean/upgrade 会把整棵树换掉，'
        + '而我们会以为自己装了一个运行时',
      fields: { runtimeRoot: base.runtimeRoot, dshHome: roots.dshHome },
    })
  }
  // `~/.dsh` 是 DSH 在没有设 DSH_HOME 时的默认家目录。它**不**由 DSH_HOME 表达，
  // 所以必须单独判：只判 DSH_HOME 会在"用户没设那个变量"的机器上全绿。
  if (roots.operatorHome !== null) {
    const defaultDshHome = join(roots.operatorHome, '.dsh')
    if (isPathInside(defaultDshHome, base.runtimeRoot, platform)) {
      return refuse({
        code: RUNTIME_INSTALL_CODES.TARGET_INSIDE_DSH_HOME,
        message: `运行时会落到 DSH 的默认家目录里（${defaultDshHome}）：${base.runtimeRoot}。`
          + '即使这次没有设 DSH_HOME，那也仍然是 DSH 的地盘',
        fields: { runtimeRoot: base.runtimeRoot, dshHome: defaultDshHome },
      })
    }
  }
  if (roots.installDir !== null && isPathInside(roots.installDir, base.runtimeRoot, platform)) {
    return refuse({
      code: RUNTIME_INSTALL_CODES.TARGET_INSIDE_INSTALL_DIR,
      message: `运行时会落到安装目录里（${roots.installDir}）：${base.runtimeRoot}。`
        + 'PRT-011 §2.1 明确禁止这一条（同类问题见 PRT-001 §2.1）：'
        + '升级会把安装目录整体替换，运行时与它一起消失',
      fields: { runtimeRoot: base.runtimeRoot, installDir: roots.installDir },
    })
  }
  if (roots.allowedRoot === null) {
    return refuse({
      code: RUNTIME_INSTALL_CODES.TARGET_OUTSIDE_ALLOWED_ROOT,
      message: '没有给出允许根（allowedRoot），无法判定这次安装的写入边界。'
        + '**按越界处理**：一个"没有边界所以不检查边界"的安装器与一个不检查边界的安装器是同一个东西',
      fields: { runtimeRoot: base.runtimeRoot },
    })
  }
  if (!isPathInside(roots.allowedRoot, base.runtimeRoot, platform)) {
    return refuse({
      code: RUNTIME_INSTALL_CODES.TARGET_OUTSIDE_ALLOWED_ROOT,
      message: `运行时会落到允许根之外：${base.runtimeRoot} 不在 ${roots.allowedRoot} 内`,
      fields: { runtimeRoot: base.runtimeRoot, allowedRoot: roots.allowedRoot },
    })
  }
  if (!samePath(roots.dataDir, base.runtimeRoot, platform)
    && !isPathInside(roots.dataDir, base.runtimeRoot, platform)) {
    return refuse({
      code: RUNTIME_INSTALL_CODES.TARGET_OUTSIDE_ALLOWED_ROOT,
      message: `运行时的落点与 DataDir 不一致：${base.runtimeRoot} 不在 ${roots.dataDir} 内。`
        + 'PRT-011 §2.1 要的是"装进 DataDir"，这里按越界处理',
      fields: { runtimeRoot: base.runtimeRoot, dataDir: roots.dataDir },
    })
  }

  // ── ③ 版本形状 ────────────────────────────────────────────────────────
  const parsedTarget = parseDshVersion(targetVersion)
  if (parsedTarget === null) {
    return refuse({
      code: RUNTIME_INSTALL_CODES.VERSION_MALFORMED,
      message: `清单声明的 DSH 版本不是合法版本号：${JSON.stringify(targetVersion)}。`
        + '要求完整的 major.minor.patch（可带 -prerelease）——'
        + '形状不对的版本拿去装，报出来的会是 npm 的 404，而那条错离"清单写错了"很远',
      detail: { targetVersion },
    })
  }
  const paths = runtimePathsOf({ dataDir: roots.dataDir, targetVersion: parsedTarget.raw, packageName, entryRelpath })

  // ── ④ 版本区间：注入判据，缺省即拒绝 ──────────────────────────────────
  let rangeVerdict = null
  if (typeof supportedRange === 'string' && supportedRange.trim() !== '' && typeof rangeSatisfied === 'function') {
    try {
      const r = rangeSatisfied(parsedTarget.raw, supportedRange.trim())
      rangeVerdict = r === true ? true : (r === false ? false : null)
    } catch {
      // 判据自己抛错（例如区间写法不认识）**不算通过**：
      // "判不出来"与"判过了"必须分开，否则一个拼错的区间会让门禁静默失效。
      rangeVerdict = null
    }
  }
  if (rangeVerdict === null) {
    return refuse({
      code: RUNTIME_INSTALL_CODES.RANGE_UNCHECKED,
      message: `无法判定 DSH ${parsedTarget.raw} 是否落在清单声明的受支持区间里`
        + `（区间 ${JSON.stringify(supportedRange ?? null)}，判据 ${
          rangeSatisfied === null || rangeSatisfied === undefined ? '未提供' : '判不出来'}）。`
        + '**按不在区间内处理**：一个"没有区间判据于是默认放行"的安装器，'
        + '与一个从来不检查区间的安装器，是同一个东西',
      detail: { targetVersion: parsedTarget.raw, supportedRange: supportedRange ?? null },
    })
  }
  if (rangeVerdict === false) {
    return refuse({
      code: RUNTIME_INSTALL_CODES.VERSION_OUT_OF_RANGE,
      message: `DSH ${parsedTarget.raw} 不在清单声明的受支持区间内（${supportedRange.trim()}）。`
        + '清单是版本的**唯一**来源（spec §9.1：客户不能在产品内单独升级 DSH）——'
        + '这个安装器不是包管理器，它只装清单声明的那个版本',
      detail: { targetVersion: parsedTarget.raw, supportedRange: supportedRange.trim() },
    })
  }

  // ── ⑤ §9.1 成对关系 ───────────────────────────────────────────────────
  const patchPair = dshPatchPairOf({ targetVersion: parsedTarget.raw, expectedPatchVersion, patchBindings })
  const pairMoved = Object.freeze({
    dsh: typeof installedVersion === 'string' && installedVersion !== '' ? installedVersion !== parsedTarget.raw : null,
    patch: Number.isInteger(installedPatchVersion) ? installedPatchVersion !== expectedPatchVersion : null,
  })
  if (patchPair.verdict === 'unverified') {
    return refuse({
      code: RUNTIME_INSTALL_CODES.PATCH_PAIR_UNVERIFIED,
      message: patchPair.message,
      detail: { targetVersion: parsedTarget.raw, expectedPatchVersion, moved: pairMoved },
      fields: { patchPair },
    })
  }
  if (patchPair.verdict === 'mismatch') {
    return refuse({
      code: RUNTIME_INSTALL_CODES.PATCH_PAIR_MISMATCH,
      message: patchPair.message,
      detail: {
        targetVersion: parsedTarget.raw,
        expectedPatchVersion,
        side: patchPair.side,
        knownGoodPatches: patchPair.knownGoodPatches,
        moved: pairMoved,
      },
      fields: { patchPair },
    })
  }

  // ── 全部通过：算关系与 Legion junction ────────────────────────────────
  const relation = (() => {
    if (typeof installedVersion !== 'string' || installedVersion.trim() === '') return 'fresh'
    const c = compareDshVersions(parsedTarget.raw, installedVersion)
    if (c === null) return 'unknown'
    return c === 0 ? 'same' : (c > 0 ? 'upgrade' : 'downgrade')
  })()

  const linkType = platform === 'win32' ? 'junction' : 'dir'
  const links = legionPackages.map((p) => Object.freeze({
    name: p.name,
    repoDir: p.repoDir,
    sourceDir: roots.legionSourceRoot === null ? null : join(roots.legionSourceRoot, p.repoDir),
    linkPath: join(paths.versionDir, NODE_MODULES_DIRNAME, ...splitParts(p.name)),
    linkType,
  }))

  const diagnostics = Object.freeze([
    ...(relation === 'downgrade' ? [Object.freeze({
      severity: 'warn',
      code: 'runtime-install-downgrade',
      message: `这次装的是比现役更旧的版本（${installedVersion} → ${parsedTarget.raw}）。`
        + '这是被允许的（它是回滚的一条正路），但它**不是升级**：'
        + '装完之后现役运行时比之前旧，而"我以为在升级"与"其实在降级"在结果上完全不同',
    })] : []),
    ...(pairMoved.dsh === true && pairMoved.patch === false ? [Object.freeze({
      severity: 'warn',
      code: 'runtime-install-patch-carried-over',
      message: `DSH 版本在动（${installedVersion} → ${parsedTarget.raw}）而补丁层版本没动`
        + `（${installedPatchVersion}）。绑定表说这一对是已知可用的，所以放行——`
        + '但这一条要在日志里留下：它是 §9.1 那条禁令（"DSH 已升级但补丁层仍是旧锚点"）'
        + '唯一可能出现的地方',
    })] : []),
  ])

  return Object.freeze({
    version: RUNTIME_INSTALL_VERSION,
    ok: true,
    stage: 'planned',
    code: null,
    message: `可以安装 DSH ${parsedTarget.raw}（${relation}）到 ${paths.versionDir}`,
    detail: null,
    repair: null,
    diagnostics,

    targetVersion: parsedTarget.raw,
    parsedTarget,
    supportedRange: supportedRange.trim(),
    expectedPatchVersion,
    installedVersion: typeof installedVersion === 'string' && installedVersion !== '' ? installedVersion : null,
    installedPatchVersion: Number.isInteger(installedPatchVersion) ? installedPatchVersion : null,
    packageName,
    entryRelpath,

    relation,
    patchPair,
    patchPairMoved: pairMoved,

    dataDir: roots.dataDir,
    allowedRoot: roots.allowedRoot,
    runtimeRoot: paths.runtimeRoot,
    versionsDir: paths.versionsDir,
    versionDir: paths.versionDir,
    packageDir: paths.packageDir,
    entryPath: paths.entryPath,
    markerPath: paths.markerPath,
    pointerPath: paths.pointerPath,
    previousPointerPath: paths.previousPointerPath,

    /**
     * 目标目录策略。**不是**从调用方抄来的读数，见本函数说明。
     * `installRuntime` 会用真实 fs 读完成标记把它落成
     * `create` 或 `replace-incomplete`，并把落成后的值放进结果。
     */
    targetDirPolicy: TARGET_DIR_POLICY.DECIDE_AT_APPLY,

    /** 装哪个版本、怎么装。`args` 里只有**清单声明的精确版本**，没有 `latest`。 */
    installCommand: Object.freeze({
      file: platform === 'win32' ? 'npm.cmd' : 'npm',
      args: Object.freeze([
        'install',
        '--prefix', paths.versionDir,
        '--no-save',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        `${packageName}@${parsedTarget.raw}`,
      ]),
    }),

    legion: Object.freeze({
      route: LEGION_ROUTE_JUNCTION,
      why: 'PRT-011 §3 第 3 条给了两条路（发布成 npm 包 / 由 Launcher 从安装目录做 junction）。'
        + '这里走 junction：它不需要先发布任何东西，而"发布成 npm 包"是一条独立的、'
        + '尚未决定的路线（本模块不做包发布器）',
      sourceRoot: roots.legionSourceRoot,
      links: Object.freeze(links),
    }),

    /** 只读根：任何一次写入落在它们之内都会被 `createRuntimeWriteGuard()` 挡下。 */
    readOnlyRoots: Object.freeze(parts(roots.installDir, roots.shippedPresetRoot)),
    /** 允许写入的根。**只有它**。 */
    writableRoot: roots.dataDir,
  })
}

// ---------------------------------------------------------------- 校验 → 修复入口

/**
 * 把一次安装校验的逐项结论翻成 `doctor.mjs` 认的**修复计划**形状。
 *
 * 为什么不自己长一套"健康"的判据：`doctor.mjs` 已经是那个判据的出口
 * （退出码 0/1/3、`planFrom()` 认 `{ok, items}`）。第二套"健康"的定义
 * 会在两处对同一件事给出不同答案。
 *
 * ★ 每一项的 `action` 一律是 `'inspect-manually'`。这是**刻意**的：
 *   `doctor.mjs` 把这一档单独成段，文案是"没有预置修法，需要人工排查"。
 *   编一个看起来像 `REPAIR_ACTIONS` 里的动作名，会让报告说出一件
 *   **没有任何代码会做**的事。
 *
 * @param {object} verify `installRuntime` 结果里的 `verify`
 * @returns {{ok: boolean, items: object[]}}
 */
export function installationRepairPlan(verify) {
  const checks = Array.isArray(verify?.checks) ? verify.checks : []
  return Object.freeze({
    ok: verify?.ok === true,
    items: Object.freeze(checks.map((c) => Object.freeze({
      ok: c.ok === true,
      check: c.code,
      label: c.label ?? c.code,
      action: 'inspect-manually',
      why: c.why ?? '这一项没通过时，装出来的运行时会被判成"装好了"，而它可能根本起不来',
      reasons: Object.freeze([c.detail ?? '没有给出细节']),
    }))),
  })
}

// ---------------------------------------------------------------- 写入守卫

/**
 * 把每一次**写入**都挡在允许根之内，并挡在只读根之外。
 *
 * 这不是"多一层保险"，它是 PRT-011 §2.1 与 §2.4（`line 136-137`）在本模块里
 * 唯一可执行的形式：**不得编辑 shipped preset install**。一条写在文档里的
 * "只读"与一条"没有任何一次写入落在那条路径上"的断言，在没人违反它的那些日子里
 * 是同一个东西——只不过前者的文档不会在有人违反时变红。
 *
 * @param {object} o
 * @param {object} o.fs      注入的 fs（最少要实现下面用到的那些）
 * @param {string} o.writableRoot  允许写入的根
 * @param {string[]} o.readOnlyRoots 只读根
 * @param {string[]} [o.allowedLinkTargets] junction/软链**允许指向**的目录
 * @param {string} [o.platform]
 * @returns {{calls: object[], guardPath: Function, guardLink: Function}} 包装过的写操作
 * @throws {Error} 目标越界时抛，`err.code = RUNTIME_INSTALL_WRITE_REFUSED`
 */
export function createRuntimeWriteGuard({
  fs,
  writableRoot,
  readOnlyRoots = [],
  allowedLinkTargets = [],
  platform = process.platform,
  onCall = null,
} = {}) {
  if (fs === null || typeof fs !== 'object') throw new TypeError('createRuntimeWriteGuard 需要注入 fs')
  if (typeof writableRoot !== 'string' || writableRoot.trim() === '') {
    throw new TypeError('createRuntimeWriteGuard 需要 writableRoot：没有它就无法判定写入边界')
  }
  const writable = normalizePath(writableRoot, platform)
  const readOnly = readOnlyRoots
    .filter((r) => typeof r === 'string' && r.trim() !== '')
    .map((r) => normalizePath(r, platform))
  const linkTargets = allowedLinkTargets
    .filter((r) => typeof r === 'string' && r.trim() !== '')
    .map((r) => normalizePath(r, platform))

  const calls = []
  const record = (op, path) => {
    const entry = Object.freeze({ op, path })
    calls.push(entry)
    if (typeof onCall === 'function') onCall(entry)
  }

  function denied(op, path, why) {
    const err = new Error(`拒绝写入 ${path}（${op}）：${why}`)
    err.code = RUNTIME_INSTALL_CODES.WRITE_REFUSED
    err.op = op
    err.path = path
    return err
  }

  /** 判定一个写入目标可不可以。**内外都判**：既不能出允许根，也不能进只读根。 */
  function guardPath(op, path) {
    if (typeof path !== 'string' || path.trim() === '') {
      throw denied(op, String(path), '路径是空的，无法判定边界')
    }
    const p = normalizePath(path, platform)
    // 顺序：先判只读（更具体的禁令），再判允许根。
    // 反过来的话，"往 InstallDir 里写"会被报成"越出允许根"——技术上没错，
    // 但把 PRT-011 §2.1 那条明确的禁令藏在一句泛泛的边界话里。
    for (const r of readOnly) {
      if (samePath(p, r, platform) || isPathInside(r, p, platform)) {
        throw denied(op, p, `它落在只读根之内（${r}）：shipped preset install 与安装目录一律只读`)
      }
    }
    if (!(samePath(p, writable, platform) || isPathInside(writable, p, platform))) {
      throw denied(op, p, `它越出了允许写入的根（${writable}）`)
    }
    record(op, p)
    return p
  }

  /**
   * 链接目标可以**在**允许根之外（junction 就是要指向 Legion 安装目录），
   * 但它必须是一个**被声明过**的目录。没有这一条，一个被注入的绝对路径就能
   * 把运行时的一块挂到任意位置。
   */
  function guardLink(op, linkPath, target) {
    guardPath(op, linkPath)
    if (typeof target !== 'string' || target.trim() === '') throw denied(op, String(target), '链接目标是空的')
    if (!isAbsolute(target)) throw denied(op, target, '链接目标不是绝对路径')
    const t = normalizePath(target, platform)
    if (!linkTargets.some((r) => samePath(r, t, platform) || isPathInside(r, t, platform))) {
      throw denied(op, t, `链接目标不在任何被声明的来源根之内（${linkTargets.join('、') || '（空）'}）`)
    }
    return t
  }

  return Object.freeze({
    calls,
    guardPath,
    guardLink,
    mkdir(path, opts) { guardPath('mkdir', path); fs.mkdirSync(path, opts) },
    writeFile(path, data) { guardPath('write', path); fs.writeFileSync(path, data, 'utf8') },
    copyFile(from, to) { guardPath('copy', to); fs.copyFileSync(from, to) },
    remove(path, opts) { guardPath('remove', path); fs.rmSync(path, opts) },
    unlink(path) { guardPath('unlink', path); fs.unlinkSync(path) },
    chmod(path, mode) { guardPath('chmod', path); fs.chmodSync(path, mode) },
    /** 同卷内的原子替换：`from` 也要在允许根内。 */
    replace(from, to) {
      guardPath('replace-from', from)
      guardPath('replace-to', to)
      fs.renameSync(from, to)
    },
    symlink(target, linkPath, type) {
      guardLink('link', linkPath, target)
      fs.symlinkSync(target, linkPath, type)
    },
  })
}

// ---------------------------------------------------------------- runner

/**
 * 运行器的具名读数。**只有一条**：命令**拼不出来**。
 *
 * 它必须与"npm 跑了但失败了"分开：前者一个进程都没起、一个字节都没写，
 * 后者可能已经在 `node_modules/` 下留了半棵树。`installRuntime` 把两者都报成
 * `RUNNER_FAILED`（对"指针动没动"这个问题，两者是同一个答案），但 `error` 文案
 * 与 `invocation` 字段让读日志的人分得出来。
 */
export const NPM_RUNNER_CODES = Object.freeze({
  /** 在 Windows 上拿到了一个 `.cmd` 垫片，却解析不出它背后那份 npm 的 CLI 脚本。 */
  INVOCATION_UNRESOLVED: 'RUNTIME_NPM_INVOCATION_UNRESOLVED',
})

/**
 * 把**计划里的那条命令**翻成**这台机器上真的能起得来的那条调用**。
 *
 * ## 它修的是一个实测出来的洞，不是一个假想的洞
 *
 * `planRuntimeInstall()` 在 Windows 上把 `installCommand.file` 写成 `npm.cmd`
 * （那是 npm 的**用户入口**）。而 `spawnSync('npm.cmd', args)` 在 Windows 上
 * **根本起不来**：
 *
 * ```
 *   spawnSync('npm.cmd', ['--version'])               → EINVAL: spawnSync npm.cmd EINVAL
 *   spawnSync(process.execPath, [npmCli,'--version']) → status 0, "11.17.0"
 *   spawnSync('npm.cmd', [...], {shell:true})         → status 0（但见下）
 * ```
 *
 * （Node 2024 年 4 月那次安全发布之后，`.cmd` / `.bat` 不带 `shell: true` 一律
 * 拒绝执行——见 <https://nodejs.org/ro/blog/vulnerability/april-2024-security-releases-2>
 * 与 execa #987 <https://github.com/sindresorhus/execa/issues/987>。）
 *
 * 这一条在此之前**没有任何读数**：本 CLI 从来没有真的跑过一次 npm，用例全部
 * 注入假运行器，于是"生产运行器在 Windows 上 100% 失败"与"生产运行器没问题"
 * 在测试报告上是同一片绿。**实测一次就红。**
 *
 * ## 为什么不选 `shell: true`
 *
 * 它是能跑通的那条路（上面第三行），但 Node 自己为它发了弃用警告
 * （`DEP0190`），理由是**参数只做拼接、不做转义**。而这条命令里有一个
 * 用户选的绝对路径（`--prefix <DataDir>/...`）：Windows 上的数据目录
 * 完全可能带空格（`C:\Program Files\...`、中文用户名目录下的临时根），
 * 那时拼接出来的命令行会被切错位置。
 *
 *   > 一个"把路径拼进 shell 命令行"的调用，
 *   > 与一个"把路径当数组元素交给 CreateProcess"的调用，
 *   > 在路径恰好没有空格的那些机器上是同一个东西——
 *   > 只不过前者的红只在**别人**的机器上出现。
 *
 * 所以走 `process.execPath` + npm 自己的 CLI 脚本，参数仍然是数组：
 * 不经过 shell，路径里有空格也不会被切开，且 `.cmd` 垫片里那层 cmd.exe
 * 语义（`%*` 转发）也不再参与。
 *
 * ## 解析不出来时**不猜**
 *
 * 两个候选都没有时返回 `ok:false`（具名码），**不回落**到 `shell:true`，
 * 也不回落到直接 spawn 那个 `.cmd`（那是已知必然 EINVAL 的那条路）。
 * 一个"想尽办法把命令拼出来"的解析器，会在拼错的时候照样返回一条看起来
 * 正常的命令行——而那条命令行会以 npm 的退出码失败，读起来像"装不上"。
 *
 * @param {object} o
 * @param {{file: string, args: string[]}} o.command 计划里的那条命令
 * @param {string} [o.platform]
 * @param {string} [o.execPath]   本进程的 node（默认 `process.execPath`）
 * @param {Function} [o.exists]   存在性判据（可注入：判据要能离线逐条验证）
 * @returns {{ok: true, file: string, args: string[], mode: string, candidates: string[]}
 *          | {ok: false, code: string, message: string, candidates: string[],
 *             file: null, args: null, mode: null}}
 */
export function resolveNpmInvocation({
  command, platform = process.platform, execPath = process.execPath, exists = existsSync,
} = {}) {
  const file = typeof command?.file === 'string' ? command.file : ''
  const argv = Array.isArray(command?.args) ? command.args.map(String) : []
  const base = { candidates: Object.freeze([]), file: null, args: null, mode: null }

  // ① 非 Windows：`npm` 是一个带 shebang 的可执行脚本，直接起就对了。
  if (platform !== 'win32') {
    return Object.freeze({ ...base, ok: true, file, args: Object.freeze([...argv]), mode: 'direct' })
  }
  // ② Windows，但不是 `.cmd` / `.bat` 垫片（例如调用方已经给了 `node.exe`，
  //    或者给了一个 `.exe`）：原样交给 CreateProcess。
  const isShim = /\.(cmd|bat)$/i.test(file)
  if (!isShim) {
    return Object.freeze({ ...base, ok: true, file, args: Object.freeze([...argv]), mode: 'direct' })
  }

  // ③ Windows + 垫片：找它背后那份 npm CLI 脚本。两个候选都是**推导**出来的
  //    （不是猜一个魔法路径）：Node 官方发行包把 npm 装在 `node` 旁边；
  //    nvm-windows / volta / fnm 也保持这个布局。
  const candidates = []
  if (typeof execPath === 'string' && execPath.trim() !== '') {
    candidates.push(join(dirname(execPath), NODE_MODULES_DIRNAME, 'npm', 'bin', 'npm-cli.js'))
  }
  // 只有在 `file` 自己**带着目录**时才从它旁边找：裸的 `npm.cmd` 会让第二个
  // 候选变成相对路径，而相对路径的落点取决于当时的 cwd —— 那正是
  // `planRuntimeInstall` 拒绝相对 DataDir 的同一条理由。
  if (file !== '' && (isAbsolute(file) || file.includes('/') || file.includes('\\'))) {
    candidates.push(join(dirname(file), NODE_MODULES_DIRNAME, 'npm', 'bin', 'npm-cli.js'))
  }
  const found = candidates.find((c) => { try { return exists(c) === true } catch { return false } })
  if (found === undefined) {
    return Object.freeze({
      ...base, ok: false, code: NPM_RUNNER_CODES.INVOCATION_UNRESOLVED, candidates: Object.freeze([...candidates]),
      message: `在 Windows 上拿到了 npm 的 .cmd 垫片（${file}），但找不到它背后那份 npm CLI 脚本`
        + `（试过：${candidates.join('、') || '（没有候选）'}）。`
        + '**这不是"安装失败"**：一个 npm 进程都还没有起过，一个字节都还没有写。'
        + '不带 shell 直接 spawn 这个垫片在 Windows 上必然 EINVAL，所以这里不回落、也不猜路径；'
        + '请确认 npm 与它旁边那个 node 一起装的（`node -p "process.execPath"`）。',
    })
  }
  return Object.freeze({
    ...base, ok: true, mode: 'node-cli', candidates: Object.freeze([...candidates]),
    file: execPath, args: Object.freeze([found, ...argv]),
  })
}

/**
 * 真实命令运行器。**必须显式注入**——本模块不提供缺省实现。
 *
 * 这是本模块唯一一条"离开这台机器"的路径（npm install 会联网）。把它做成
 * 必填参数，等于让"这一次到底有没有真的去装"变成一个调用方**写出来了**的事实：
 *
 *   > 一个"缺省就会真的跑 npm"的安装器，
 *   > 与一个"在用例里跑过一次真的 npm"的安装器，在用例的绿上是同一个东西——
 *   > 只不过前者的绿要靠网络，而网络不在 CI 的承诺里。
 *
 * 生产调用方显式传 `createNpmRunner()`；用例传假运行器，于是"没有真的跑过
 * npm install"是一个**结构性**事实，而不是一句注释。
 *
 * ## 返回值里的 `invocation`
 *
 * 计划里那条命令是 `npm.cmd install --prefix …`，而这台机器上**真的被执行**的
 * 是 `node <…>/npm-cli.js install --prefix …`（见 `resolveNpmInvocation`）。
 * 两者必须都能被读到：`installRuntime` 把 `invocation` 记进 `runnerCalls`，
 * 于是"将要执行的"与"真的执行了的"不会被读成同一条命令。
 *
 * ## `logPath`：同步世界里的**真进度面**
 *
 * `installRuntime` 是同步的，`spawnSync` 会把本线程挡到 npm 退出为止。于是这
 * 600 秒里本进程**没有任何办法**报出进度——而一个"最长要转十分钟、且十分钟里
 * 一个字都不说"的安装，与一个卡死了的安装，在用户看到的界面上是同一个东西。
 *
 * 在"不能改成异步"（`product/launcher/cli.mjs` 同步调用它）的前提下，唯一能做出
 * **真的**进度面的办法是：把 npm 的 stdout/stderr 交给**操作系统**（两个继承的
 * 文件描述符），而不是接进管道。管道里的字节只有到进程退出才被 Node 交回来；
 * 而落到文件上的字节，**另一个进程**在 npm 还在跑的时候就能读到。
 *
 *   > 一个"跑完之后 stderr 全文可见"的运行器，
 *   > 与一个"跑的过程中就能被读到"的运行器，在成功的那次运行里是同一个东西——
 *   > 只不过在卡住的那一次里，前者是十分钟的静默。
 *
 * 代价说清楚：stdout 与 stderr **混在同一个文件**里（一个 fd 不能分成两路），
 * 所以 `logsCombined: true`；`stdout` 因此是空串，而 `stderr` 是那份日志的尾部
 * ——失败文案里真正有信息量的东西（`npm ERR!`）本来就在 stderr。
 *
 * @returns {(command: {file: string, args: string[]}, opts: object) => object}
 */
export function createNpmRunner({
  spawn = spawnSync,
  env = process.env,
  timeoutMs = 600_000,
  platform = process.platform,
  execPath = process.execPath,
  exists = existsSync,
  now = () => Date.now(),
} = {}) {
  return function npmRunner(command, { cwd = null, logPath = null } = {}) {
    const invocation = resolveNpmInvocation({ command, platform, execPath, exists })
    if (invocation.ok !== true) {
      // 一个进程都没起：`status` 是 `null`（不是 0，也不是 1）。
      return {
        ok: false, status: null, stdout: '', stderr: '',
        error: invocation.message,
        code: invocation.code,
        invocation: null,
        logPath: null, logBytes: null, logsCombined: false,
        elapsedMs: 0,
      }
    }

    let fd = null
    let resolvedLogPath = null
    let logError = null
    if (typeof logPath === 'string' && logPath.trim() !== '') {
      try {
        mkdirSync(dirname(logPath), { recursive: true })
        const candidate = openSync(logPath, 'a')
        // ★ 打开成功 ≠ 这是个**文件**：Windows 上 `openSync(一个目录, 'a')` 会成功。
        //   不查这一下的话，"进度面在 <路径>"这句话可能指着一个目录，
        //   而那个读数会被读成"日志写了但内容为空"（另一件完全不同的事）。
        if (fstatSync(candidate).isFile() !== true) {
          closeSync(candidate)
          throw new Error(`不是普通文件：${logPath}`)
        }
        fd = candidate
        resolvedLogPath = logPath
      } catch (e) {
        // 开不出日志文件**不是**安装失败：宁可不留痕，也不能让一次能装成功的
        // 安装因为"日志写不进去"而红。这一档记在 `logError` 里。
        fd = null
        resolvedLogPath = null
        logError = String(e?.message ?? e)
      }
    }

    const beganAt = now()
    let r = null
    try {
      r = spawn(invocation.file, [...invocation.args], {
        cwd: cwd ?? undefined,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        stdio: fd === null ? ['ignore', 'pipe', 'pipe'] : ['ignore', fd, fd],
      })
    } finally {
      if (fd !== null) { try { closeSync(fd) } catch { /* 关不掉不影响结论 */ } }
    }

    // 落盘的那份日志要在**退出之后**读回来：它同时是"进度面"与"错误详情"。
    let tail = ''
    let logBytes = 0
    if (resolvedLogPath !== null) {
      try {
        const raw = readFileSync(resolvedLogPath, 'utf8')
        logBytes = raw.length
        tail = raw.length > LOG_TAIL_CHARS ? raw.slice(-LOG_TAIL_CHARS) : raw
      } catch { /* 读不回来就当它没写 */ }
    }
    const pipedStdout = typeof r?.stdout === 'string' ? r.stdout : ''
    const pipedStderr = typeof r?.stderr === 'string' ? r.stderr : ''

    const out = {
      stdout: resolvedLogPath === null ? pipedStdout : '',
      stderr: resolvedLogPath === null ? pipedStderr : tail,
      logPath: resolvedLogPath,
      logBytes,
      logsCombined: resolvedLogPath !== null,
      ...(logError === null ? {} : { logError }),
      invocation: Object.freeze({
        file: invocation.file,
        args: invocation.args,
        mode: invocation.mode,
        plannedFile: command?.file ?? null,
        timeoutMs,
        logPath: resolvedLogPath,
      }),
      elapsedMs: Math.max(0, now() - beganAt),
    }
    if (r?.error !== undefined && r?.error !== null) {
      return { ...out, ok: false, status: null, error: String(r.error?.message ?? r.error) }
    }
    return { ...out, ok: r?.status === 0, status: r?.status ?? null, error: null }
  }
}

// ---------------------------------------------------------------- 读数

const defaultFs = Object.freeze({
  existsSync, lstatSync, readFileSync,
  mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync, copyFileSync, unlinkSync, chmodSync,
})

function readJson(absPath, fs) {
  try {
    const value = JSON.parse(fs.readFileSync(absPath, 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return value
  } catch {
    return null
  }
}

/**
 * 现役运行时是**什么**——一次真实磁盘读数，不是一个布尔。
 *
 * `state` 四态里最要紧的是 `broken` 与 `active` 分开：
 *
 *   > 一个"指针指着一个没有完成标记的目录"的部署，
 *   > 与一个"指针指着一个装好的目录"的部署，在 `existsSync(指针)===true`
 *   > 上是同一个读数——只不过前者的运行时会在启动那一刻才炸。
 *
 * 同理 `absent`（还没有指针）与 `unreadable`（指针在、读不懂）分开：
 * 前者是干净机器上的正常读数，后者是一次坏掉的安装留下的。
 */
export function readActiveRuntime({
  dataDir, fs = null, packageName = DEFAULT_DSH_PACKAGE, entryRelpath = DEFAULT_ENTRY_RELPATH,
} = {}) {
  const io = fs ?? defaultFs
  const { runtimeRoot, pointerPath, previousPointerPath } = runtimeRootOf({ dataDir })
  const base = Object.freeze({ runtimeRoot, pointerPath, previousPointerPath })

  if (!io.existsSync(pointerPath)) {
    return Object.freeze({
      ...base, state: 'absent', installed: false, code: null,
      version: null, dir: null, entryPath: null, entryExists: false, complete: false, patchVersion: null,
      previousVersion: null, previousDir: null, previousUsable: false,
      message: '还没有装过 DSH 运行时（指针不存在）。这是干净机器上的正常读数，不是错误',
    })
  }
  const pointer = readJson(pointerPath, io)
  if (pointer === null || typeof pointer.version !== 'string' || typeof pointer.dir !== 'string') {
    return Object.freeze({
      ...base, state: 'unreadable', installed: false, code: RUNTIME_INSTALL_CODES.POINTER_UNREADABLE,
      version: null, dir: null, entryPath: null, entryExists: false, complete: false, patchVersion: null,
      previousVersion: null, previousDir: null, previousUsable: false,
      message: `指针文件读不懂：${pointerPath}。它不是 JSON、或不是本模块写的形状——`
        + '一个"读不懂就当没装过"的实现会在这里把一次安装判丢',
    })
  }
  const marker = readJson(join(pointer.dir, COMPLETION_MARKER_FILENAME), io)
  const entryPath = join(pointer.dir, NODE_MODULES_DIRNAME, ...splitParts(packageName), ...splitParts(entryRelpath))
  const complete = marker !== null && typeof marker.version === 'string'
  const entryExists = io.existsSync(entryPath)
  const usable = complete && entryExists
  const previous = readJson(previousPointerPath, io)
  const previousUsable = previous !== null
    && typeof previous.dir === 'string'
    && readJson(join(previous.dir, COMPLETION_MARKER_FILENAME), io) !== null

  return Object.freeze({
    ...base,
    state: usable ? 'active' : 'broken',
    installed: true,
    code: usable ? null : RUNTIME_INSTALL_CODES.ACTIVE_RUNTIME_INCOMPLETE,
    version: pointer.version,
    dir: pointer.dir,
    entryPath,
    entryExists,
    complete,
    patchVersion: Number.isInteger(marker?.dshCompositionPatchVersion) ? marker.dshCompositionPatchVersion : null,
    markerPath: join(pointer.dir, COMPLETION_MARKER_FILENAME),
    previousVersion: typeof previous?.version === 'string' ? previous.version : null,
    previousDir: typeof previous?.dir === 'string' ? previous.dir : null,
    previousUsable,
    message: usable
      ? `现役 DSH ${pointer.version}（补丁层 ${marker.dshCompositionPatchVersion ?? '未记录'}）`
      : `指针指向 ${pointer.dir}，但那里没有完成标记或入口文件不在：`
        + '这是一次装到一半就被打断的安装留下的指针，不能当作可用',
  })
}

// ---------------------------------------------------------------- 安装

/**
 * 执行一份已经判定为可执行的计划。
 *
 * ## 顺序是全部要点
 *
 * ```
 *   0. 守卫（把这次安装的每一次写入都钉在 DataDir 内）
 *   1. 建 runtime/ 与 versions/          ← 结构性目录，不含任何版本
 *   2. 检查四个 Legion 源目录在不在        ← 在建版本目录**之前**
 *   3. 读目标目录的完成标记 → create / replace-incomplete
 *   4. 建版本目录
 *   5. 跑 npm install（注入的 runner）
 *   6. 建四个 @dsh-external/* junction
 *   7. **校验**（入口文件在、装到的版本 == 清单声明、四个 junction 在）
 *   8. 写完成标记
 *   9. 写 previous.json（旧现役）
 *  10. 写 current.json（切指针）
 * ```
 *
 * 第 7 步在第 10 步**之前**，这就是全部原子性：
 *
 *   > 一条"新版本装好了"的断言，
 *   > 与一条"指针只有在校验通过之后才动"的断言，在安装永远成功的那些运行里
 *   > 是同一片绿——只不过前者的绿，在一次装到一半的失败里会留下一个半装的 current。
 *
 * 任何一步失败都**直接返回**，不清理、不重试、不动指针。留下的半装目录没有完成
 * 标记，所以它不可选（下一次安装会把它删掉重来）。
 *
 * @param {object} o
 * @param {object} o.plan   `planRuntimeInstall()` 的产物；`ok !== true` 直接拒绝
 * @param {Function} o.runner **必填**（见 `createNpmRunner` 的说明）
 * @param {object} [o.fs]   注入的 fs；缺省是 node:fs
 * @param {Function} [o.now]
 */
export function installRuntime({ plan, runner, fs = null, now = () => Date.now(), logger = null } = {}) {
  const io = fs ?? defaultFs
  if (plan === null || typeof plan !== 'object' || plan.ok !== true) {
    // 结构上不可能从一条被拒绝的计划走到任何一次写入。
    throw new TypeError(
      'installRuntime 只接受 ok === true 的计划：'
      + `收到 ${plan === null || typeof plan !== 'object' ? String(plan) : JSON.stringify({ code: plan.code ?? null, stage: plan.stage ?? null })}。`
      + '拒绝必须发生在任何目录被创建之前——把"先建目录再判边界"写进同一条路径，'
      + '会让"被拒绝"与"拒绝之前先建了目录"在返回值上长得一样',
    )
  }
  if (typeof runner !== 'function') {
    throw new TypeError(
      'installRuntime 需要 runner：本模块不提供缺省运行器。'
      + '缺省运行器会让"这一次到底有没有真的去装"变成一个没人写下来的事实，'
      + '而用例里的绿就要靠网络——网络不在 CI 的承诺里。生产调用方传 createNpmRunner()',
    )
  }

  const stages = []
  const runnerCalls = []
  /**
   * **这台机器上真的被执行**的那条调用（`resolveNpmInvocation` 的产物）。
   *
   * 计划里的 `npm.cmd` 与它在这台机器上的实际形态（`node …/npm-cli.js`）
   * 不是同一条命令行。两者都留着：前者是"产品决定要做什么"，
   * 后者是"这一次到底起了哪个进程"。
   */
  let lastInvocation = null
  /**
   * npm 这一次的输出落在哪里、多大。`null` = 这一次没有留下进度日志
   * （运行器不支持，或者日志文件开不出来——后者会记在 `error` 里，
   * 且**不算安装失败**）。
   */
  let npmLog = null
  const record = (stage, ok, detail = null) => stages.push(Object.freeze({ stage, ok, detail }))

  // 守卫先建：下面每一条失败路径都要把它已经记下的写入带出去——
  // "这一次到底往磁盘上碰了什么"是失败时唯一能回答问题的那份读数。
  let guard
  try {
    guard = createRuntimeWriteGuard({
      fs: io,
      writableRoot: plan.writableRoot,
      readOnlyRoots: plan.readOnlyRoots,
      allowedLinkTargets: plan.legion.sourceRoot === null ? [] : [plan.legion.sourceRoot],
    })
  } catch (e) {
    return Object.freeze({
      version: RUNTIME_INSTALL_VERSION,
      ok: false, code: RUNTIME_INSTALL_CODES.WRITE_REFUSED, message: String(e?.message ?? e),
      detail: null, targetVersion: plan.targetVersion, versionDir: plan.versionDir,
      pointerPath: plan.pointerPath, movedPointer: false, targetDirAction: null,
      stages: Object.freeze([]), runnerCalls: Object.freeze([]), writes: Object.freeze([]),
      invocation: null, npmLog: null, verify: null, repair: runtimeInstallRepair(),
    })
  }

  const fail = ({ code, message, detail = null, targetDirAction = null, verify = null }) => Object.freeze({
    version: RUNTIME_INSTALL_VERSION,
    ok: false,
    code,
    message,
    detail,
    targetVersion: plan.targetVersion,
    relation: plan.relation,
    versionDir: plan.versionDir,
    pointerPath: plan.pointerPath,
    // ★ 这条读数在**每一条**失败路径上都是 false，除了指针切换之后才失败的路径
    //   （这里根本没有那样一条）。把它做成字段而不是让它隐含在文案里：
    //   断言"指针有没有动"是原子性用例的全部内容。
    movedPointer: false,
    targetDirAction,
    stages: Object.freeze([...stages]),
    runnerCalls: Object.freeze([...runnerCalls]),
    writes: Object.freeze([...guard.calls]),
    invocation: lastInvocation,
    npmLog,
    verify,
    repair: runtimeInstallRepair(),
  })

  try {
    // ── 1. 结构性目录 ────────────────────────────────────────────────────
    guard.mkdir(plan.runtimeRoot, { recursive: true })
    guard.mkdir(plan.versionsDir, { recursive: true })
    record('dirs', true, plan.versionsDir)

    // ── 2. Legion 源目录（在建版本目录**之前**）──────────────────────────
    const missingSources = plan.legion.links
      .filter((l) => l.sourceDir === null || io.existsSync(l.sourceDir) !== true)
    if (missingSources.length > 0) {
      record('legion-sources', false, missingSources.map((l) => l.sourceDir ?? `(未解析) ${l.name}`).join('、'))
      return fail({
        code: RUNTIME_INSTALL_CODES.LEGION_SOURCE_MISSING,
        message: `${missingSources.length} 个 Legion 包的源目录不在`
          + `（${missingSources.map((l) => `${l.name} → ${l.sourceDir ?? '未解析'}`).join('；')}）。`
          + 'junction 指向一个不存在的目录不会报错——它只是指向空处，'
          + '于是组合树里那一行会"看起来挂着、而实际什么都没挂"',
        detail: { missing: missingSources.map((l) => ({ name: l.name, sourceDir: l.sourceDir })) },
      })
    }
    record('legion-sources', true, `${plan.legion.links.length} 个源目录都在`)

    // ── 3. 目标目录：读**完成标记**，不是读"在不在" ──────────────────────
    const targetExists = io.existsSync(plan.versionDir)
    const targetMarker = targetExists ? readJson(plan.markerPath, io) : null
    let targetDirAction = 'create'
    if (targetExists && targetMarker !== null) {
      record('target-dir', false, '已存在且带完成标记')
      return fail({
        code: RUNTIME_INSTALL_CODES.TARGET_DIR_EXISTS,
        message: `目标版本目录已经存在，而且带着完成标记：${plan.versionDir}。`
          + '**不覆盖**：那是一次已经生效的安装，覆盖它等于在没有回滚点的情况下换掉现役运行时。'
          + '要重装请先显式删掉那个目录（或装另一个版本）',
        detail: { versionDir: plan.versionDir, markerVersion: targetMarker.version ?? null },
      })
    }
    if (targetExists) {
      targetDirAction = 'replace-incomplete'
      guard.remove(plan.versionDir, { recursive: true, force: true })
      record('target-dir', true, '存在但没有完成标记 → 删除重装（半装残留不构成"已经装过"）')
    } else {
      record('target-dir', true, '不存在 → 新建')
    }

    // ── 4. 版本目录 ──────────────────────────────────────────────────────
    guard.mkdir(plan.versionDir, { recursive: true })

    // ── 5. npm install ──────────────────────────────────────────────────
    //
    // `logPath` 是**进度面**：npm 的输出直接落到版本目录里的一个文件上，
    // 于是本进程被 `spawnSync` 挡住的这几分钟里，别的进程仍然读得到进度。
    // 它落在版本目录里（可写面之内），随这一次安装一起被回滚/重装。
    const npmLogPath = join(plan.versionDir, NPM_LOG_FILENAME)
    runnerCalls.push(Object.freeze({
      kind: 'planned',
      file: plan.installCommand.file,
      args: Object.freeze([...plan.installCommand.args]),
    }))
    let run = null
    try {
      run = runner(plan.installCommand, { cwd: plan.versionDir, purpose: 'runtime-install', logPath: npmLogPath })
    } catch (e) {
      record('npm-install', false, String(e?.message ?? e))
      return fail({
        code: RUNTIME_INSTALL_CODES.RUNNER_FAILED,
        message: `装 DSH ${plan.targetVersion} 的命令抛了错：${String(e?.message ?? e)}。`
          + '指针没有动，旧版本仍然可用',
        detail: { command: plan.installCommand },
        targetDirAction,
      })
    }
    // ★ 运行器说它**真的起了哪个进程**时，把它单独记一条。
    //
    //   只在 `plan.installCommand` 里记计划是不够的：Windows 上计划写的是
    //   `npm.cmd`，而真的被执行的是 `node <…>/npm-cli.js`（见
    //   `resolveNpmInvocation`）。把两者折叠成一条，会让"将要执行的"
    //   与"真的执行了的"在事后复盘里变成同一个读数。
    if (run !== null && typeof run === 'object' && run.invocation !== null && run.invocation !== undefined) {
      lastInvocation = Object.freeze({ ...run.invocation })
      runnerCalls.push(Object.freeze({
        kind: 'actual',
        file: lastInvocation.file,
        args: Object.freeze([...lastInvocation.args]),
      }))
    }
    // 进度面落在哪里、有多大：失败之后要能**指着**那个文件说话
    // （"去读 <路径> 的尾巴"比"npm 失败了"有用得多）。
    if (run !== null && typeof run === 'object') {
      npmLog = Object.freeze({
        path: typeof run.logPath === 'string' ? run.logPath : null,
        bytes: typeof run.logBytes === 'number' ? run.logBytes : null,
        combined: run.logsCombined === true,
        error: typeof run.logError === 'string' ? run.logError : null,
      })
      if (npmLog.path !== null) record('npm-log', true, `${npmLog.path}（${npmLog.bytes ?? 0} 字节）`)
    }
    if (run === null || run === undefined || run.ok !== true) {
      record('npm-install', false, `status=${run?.status ?? '?'}`)
      return fail({
        code: RUNTIME_INSTALL_CODES.RUNNER_FAILED,
        message: `装 DSH ${plan.targetVersion} 的命令没有成功（退出码 ${run?.status ?? '未知'}）：`
          + String(run?.error ?? run?.stderr ?? '').trim().split('\n').slice(-3).join(' / '),
        detail: { command: plan.installCommand, status: run?.status ?? null },
        targetDirAction,
      })
    }
    record('npm-install', true, 'status=0')

    // ── 6. four junctions ────────────────────────────────────────────────
    const createdLinks = []
    for (const l of plan.legion.links) {
      try {
        // 作用域目录必须**先建**：真实 npm 只会建它自己那棵依赖树里的目录，
        // 而 `@dsh-external/` 这一层不在其中。少了这一步，链接会以 ENOENT 失败——
        // 那个错看起来像"源目录不在"，而源目录其实好好的。
        guard.mkdir(dirname(l.linkPath), { recursive: true })
        guard.symlink(l.sourceDir, l.linkPath, l.linkType)
        createdLinks.push(l)
      } catch (e) {
        record('legion-links', false, String(e?.message ?? e))
        return fail({
          code: e?.code === RUNTIME_INSTALL_CODES.WRITE_REFUSED
            ? RUNTIME_INSTALL_CODES.WRITE_REFUSED : RUNTIME_INSTALL_CODES.UNEXPECTED,
          message: `给 ${l.name} 建 ${l.linkType} 失败（${l.linkPath} → ${l.sourceDir}）：${String(e?.message ?? e)}`,
          detail: { link: l },
          targetDirAction,
        })
      }
    }
    record('legion-links', true, createdLinks.map((l) => l.name).join('、'))

    // ── 7. 校验：**在指针动之前** ────────────────────────────────────────
    const verify = verifyInstallation({ plan, fs: io, links: createdLinks })
    if (verify.ok !== true) {
      record('verify', false, verify.checks.filter((c) => c.ok !== true).map((c) => c.code).join('、'))
      return fail({
        code: RUNTIME_INSTALL_CODES.VERIFY_FAILED,
        message: `DSH ${plan.targetVersion} 装完了，但校验没过：`
          + verify.checks.filter((c) => c.ok !== true).map((c) => `${c.label}（${c.detail}）`).join('；')
          + '。**指针没有动**：旧版本仍然是现役，这次失败只留下一个没有完成标记的目录',
        detail: { checks: verify.checks },
        targetDirAction,
        verify,
      })
    }
    record('verify', true, verify.checks.map((c) => c.code).join('、'))

    // ── 8. 完成标记（最后一步落在这个目录里）─────────────────────────────
    guard.writeFile(plan.markerPath, `${JSON.stringify({
      version: plan.targetVersion,
      packageName: plan.packageName,
      dshCompositionPatchVersion: plan.expectedPatchVersion,
      legionRoute: plan.legion.route,
      legionPackages: plan.legion.links.map((l) => l.name),
      installedAtMs: now(),
      installerVersion: RUNTIME_INSTALL_VERSION,
    }, null, 2)}\n`)
    record('marker', true, plan.markerPath)

    // ── 9+10. 指针：先记旧的，再切新的 ──────────────────────────────────
    const previousPointer = io.existsSync(plan.pointerPath) ? readJson(plan.pointerPath, io) : null
    if (previousPointer !== null) {
      guard.writeFile(plan.previousPointerPath, `${JSON.stringify(previousPointer, null, 2)}\n`)
      record('previous-pointer', true, `${previousPointer.version ?? '?'} → previous.json`)
    } else {
      record('previous-pointer', true, '没有旧指针（首次安装）')
    }

    const pointer = {
      version: plan.targetVersion,
      dir: plan.versionDir,
      entry: plan.entryPath,
      packageName: plan.packageName,
      dshCompositionPatchVersion: plan.expectedPatchVersion,
      switchedAtMs: now(),
    }
    const tmp = `${plan.pointerPath}.tmp-${process.pid}-${now()}`
    guard.writeFile(tmp, `${JSON.stringify(pointer, null, 2)}\n`)
    try {
      guard.replace(tmp, plan.pointerPath)
    } catch (e) {
      try { guard.unlink(tmp) } catch { /* tmp 清不掉不影响结论：它不在指针路径上 */ }
      record('pointer', false, String(e?.message ?? e))
      return fail({
        code: RUNTIME_INSTALL_CODES.POINTER_SWITCH_FAILED,
        message: `指针切换失败（${plan.pointerPath}）：${String(e?.message ?? e)}。`
          + '**这是安全的那一侧**：指针还是旧的，旧版本仍然现役。'
          + 'Windows 上最常见的原因是目标文件正被另一个进程打开（杀毒 / 索引器 / 一个正在读它的进程）。'
          // ★ 这一步失败会留下一个**反直觉**的终态，必须自己说出来：
          //   完成标记在第 8 步就写过了，而指针在第 10 步才切——于是磁盘上多了一个
          //   "装完了、但没成为现役"的目录。它会让**下一次装同一个版本**被
          //   `TARGET_DIR_EXISTS` 拒绝，而那条拒绝读起来像是"我明明没装成过"。
          //   > 一个"失败之后留下一个完整但没人指向的安装"的安装器，
          //   > 与一个"失败之后什么都没留下"的安装器，在返回值的 `ok` 上是同一个东西——
          //   > 只不过前者的第二次尝试会被一条看起来莫名其妙的拒绝挡住。
          + `注意：${plan.versionDir} 里的安装**已经写完**（完成标记在指针之前写），`
          + '但它不是现役。于是再装同一个版本会被"目标目录已存在且带着完成标记"拒绝——'
          + `那是这条失败留下的痕迹。要么删掉 ${plan.versionDir} 再装一次，要么直接装一个别的版本；`
          + '旧版本在这期间一直是现役，产品仍然可用',
        detail: { pointerPath: plan.pointerPath, orphanedVersionDir: plan.versionDir },
        targetDirAction,
        verify,
      })
    }
    record('pointer', true, `${previousPointer?.version ?? '(无)'} → ${plan.targetVersion}`)

    return Object.freeze({
      version: RUNTIME_INSTALL_VERSION,
      ok: true,
      code: null,
      message: `DSH ${plan.targetVersion} 已装好并切成现役（${plan.relation}，补丁层 ${plan.expectedPatchVersion}）`,
      detail: null,
      targetVersion: plan.targetVersion,
      relation: plan.relation,
      versionDir: plan.versionDir,
      entryPath: plan.entryPath,
      pointerPath: plan.pointerPath,
      previousVersion: previousPointer?.version ?? null,
      movedPointer: true,
      targetDirAction,
      stages: Object.freeze([...stages]),
      runnerCalls: Object.freeze([...runnerCalls]),
      writes: Object.freeze([...guard.calls]),
      invocation: lastInvocation,
      npmLog,
      verify,
      legion: Object.freeze({ route: plan.legion.route, linked: Object.freeze(createdLinks.map((l) => l.name)) }),
      repair: null,
    })
  } catch (e) {
    // 兜底：任何没被上面接住的抛出都在这里收口。**指针一定没动**——
    // 指针切换是最后一步，而它自己也被 try 包着。
    // 这里刻意**不做**任何"顺手回滚"：那会把一次明确的失败变成一次没有记录的状态变更。
    record('unexpected', false, String(e?.message ?? e))
    if (typeof logger === 'function') {
      logger(`runtime-install: 未预期的错误（${plan.pointerPath} 未改动）：${String(e?.message ?? e)}`)
    }
    return fail({
      code: e?.code === RUNTIME_INSTALL_CODES.WRITE_REFUSED
        ? RUNTIME_INSTALL_CODES.WRITE_REFUSED : RUNTIME_INSTALL_CODES.UNEXPECTED,
      message: `安装中断：${String(e?.message ?? e)}（指针未改动）`,
    })
  }
}

/**
 * 逐项校验一次刚装好的运行时。**在指针切换之前调用**。
 *
 * 三项都是**磁盘读数**，没有一项读返回值：
 *   · 入口文件在不在（`node_modules/<包>/lib/bin.js`，PRT-011 §1.1 的 `bin`）；
 *   · 装到的版本是不是清单声明的那个（读装出来的 `package.json`）；
 *   · 四个 `@dsh-external/*` junction 在不在。
 *
 * ★ 它**不是** `doctor.mjs` 的替代品。`doctor.mjs` 判的是"一个**跑着的** DSH
 *   进程里强制面生没生效"（ToolGuard hard floor / pre-execute / approval answerer /
 *   preset 表），那件事只有把一个 DSH 进程起起来才看得到。本函数只看"字节装对了没有"。
 *   把两者混成一个"健康"，会让"装好了"被读成"生效了"——而这两件事之间的差距
 *   正是 PRT-214 那条"能加载但 warn-and-skip"的教训。
 *
 * @returns {{ok: boolean, checks: object[]}}
 */
export function verifyInstallation({ plan, fs = null, links = null } = {}) {
  const io = fs ?? defaultFs
  const checks = []
  const push = (code, label, ok, detail, why) => checks.push(Object.freeze({ code, label, ok, detail, why }))

  const entryExists = io.existsSync(plan.entryPath)
  push('entry-file-present', '运行时入口文件', entryExists, plan.entryPath,
    '入口是"这个版本真的能起来"的唯一可执行判据；只判包目录存在的校验会在半装的 npm 安装上全绿')

  let installedVersion = null
  try {
    const pkg = JSON.parse(io.readFileSync(join(plan.packageDir, 'package.json'), 'utf8'))
    installedVersion = typeof pkg?.version === 'string' ? pkg.version : null
  } catch { installedVersion = null }
  push('installed-package-version', '装到的包版本', installedVersion === plan.targetVersion,
    `装到的是 ${installedVersion ?? '读不到'}，清单声明的是 ${plan.targetVersion}`,
    'npm 的解析结果不完全受 args 控制（缓存、镜像、registry 上的 dist-tag 都可能改道）；'
    + '不比对的话，"装的是清单那版"只是一个假设')

  const linkList = links ?? plan.legion.links
  const badLinks = linkList.filter((l) => {
    try {
      const st = io.lstatSync(l.linkPath)
      return typeof st?.isSymbolicLink === 'function' ? st.isSymbolicLink() !== true : true
    } catch { return true }
  })
  push('legion-link-present', `Legion 的 ${linkList.length} 个包链接`, badLinks.length === 0,
    badLinks.length === 0 ? linkList.map((l) => l.name).join('、') : `缺：${badLinks.map((l) => l.name).join('、')}`,
    'PRT-011 §3 第 3 条要求 Legion 自己的四个包在装好的运行时里可达；'
    + '不校验的话，"装了 DSH 但挂不上自己的包"要等到组合树里那一行静默失效才发现')

  return Object.freeze({ ok: checks.every((c) => c.ok === true), checks: Object.freeze(checks) })
}

// ---------------------------------------------------------------- 回滚

/**
 * 回到上一个现役版本。**这是一次真实读数，不是一个布尔**。
 *
 * 判据全部落在磁盘上：
 *   · `previous.json` 在不在；
 *   · 它指的那个目录**有完成标记**、且入口文件在（否则回滚会把现役指向一个半装目录）；
 *   · 切换之后 `current.json` 的内容、以及它指的那个目录里的入口文件。
 *
 *   > 一个"返回 `{ok:true}`"的回滚，
 *   > 与一个"指针真的指回去了"的回滚，在指针本来就指着旧版本的那些运行里
 *   > 是同一个东西——只不过前者在下一次启动时会报出"没装过运行时"。
 *
 * 回滚是**可逆**的：切走的那一版会写进 `previous.json`，所以再回滚一次能回来。
 */
export function rollbackRuntime({
  dataDir, fs = null, now = () => Date.now(),
  packageName = DEFAULT_DSH_PACKAGE, entryRelpath = DEFAULT_ENTRY_RELPATH,
} = {}) {
  const io = fs ?? defaultFs
  const { pointerPath, previousPointerPath } = runtimeRootOf({ dataDir })
  const deny = (code, message, detail = null) => Object.freeze({
    version: RUNTIME_INSTALL_VERSION, ok: false, code, message, detail,
    from: null, to: null, pointerPath, previousPointerPath, dir: null, entryPath: null, entryExists: false,
    repair: runtimeInstallRepair(),
  })

  const previous = readJson(previousPointerPath, io)
  if (previous === null || typeof previous.dir !== 'string' || typeof previous.version !== 'string') {
    return deny(
      RUNTIME_INSTALL_CODES.ROLLBACK_UNAVAILABLE,
      `没有可回滚的上一个版本：${previousPointerPath} 不在或读不懂。`
        + '只有**真的切换过**至少一次之后才有回滚目标——'
        + '"装过一次"与"切过一次"不是同一个状态',
      { previousPointerPath },
    )
  }

  // 回滚目标必须是**真的可用**的：有完成标记、入口文件在。
  const targetMarker = readJson(join(previous.dir, COMPLETION_MARKER_FILENAME), io)
  const targetEntry = join(previous.dir, NODE_MODULES_DIRNAME, ...splitParts(packageName), ...splitParts(entryRelpath))
  const targetEntryExists = io.existsSync(targetEntry)
  if (targetMarker === null || !targetEntryExists) {
    return deny(
      RUNTIME_INSTALL_CODES.ROLLBACK_TARGET_INCOMPLETE,
      `回滚目标不可用：${previous.dir}`
        + `（完成标记 ${targetMarker === null ? '不在' : '在'}，入口文件 ${targetEntryExists ? '在' : '不在'}）。`
        + '把指针指回一个半装目录，等于用一个"能启动的旧版本"换一个"起不来的新版本"',
      { targetDir: previous.dir, markerPath: join(previous.dir, COMPLETION_MARKER_FILENAME), entryPath: targetEntry },
    )
  }

  const current = readJson(pointerPath, io)
  try {
    // 可逆：先把"现在这一版"记成上一个，再切回去。
    if (current !== null && typeof current.dir === 'string' && typeof current.version === 'string') {
      io.writeFileSync(previousPointerPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
    }
    const tmp = `${pointerPath}.tmp-${process.pid}-${now()}`
    io.writeFileSync(tmp, `${JSON.stringify(previous, null, 2)}\n`, 'utf8')
    io.renameSync(tmp, pointerPath)
  } catch (e) {
    return deny(
      RUNTIME_INSTALL_CODES.POINTER_SWITCH_FAILED,
      `回滚时切换指针失败（${pointerPath}）：${String(e?.message ?? e)}。`
        + '指针还是回滚前的那一个——失败落在了安全的那一侧',
      { pointerPath },
    )
  }

  // ★ 结论**从磁盘读回来**，不用上面那几个变量拼。一次"写完就报成功"的实现
  //   在磁盘写入被挡下时也会报成功，而调用方拿到的会是一个不存在的事实。
  const after = readJson(pointerPath, io)
  const entryPath = join(after?.dir ?? '', NODE_MODULES_DIRNAME, ...splitParts(packageName), ...splitParts(entryRelpath))
  const entryExists = after !== null && io.existsSync(entryPath)
  const restored = after !== null && after.version === previous.version && entryExists
  return Object.freeze({
    version: RUNTIME_INSTALL_VERSION,
    ok: restored,
    code: restored ? null : RUNTIME_INSTALL_CODES.ROLLBACK_TARGET_INCOMPLETE,
    message: `已回滚到 DSH ${previous.version}（${previous.dir}）`,
    detail: null,
    from: typeof current?.version === 'string' ? current.version : null,
    to: after?.version ?? null,
    pointerPath,
    previousPointerPath,
    dir: after?.dir ?? null,
    entryPath,
    entryExists,
    repair: null,
  })
}
