// product/launcher/dsh-overlay.mjs
// ============================================================================
// 把 Legion 的补丁层**真的**接进 DSH Runtime（PRT-257 / PRT-214 的最后一段接线）
//
// ## 这个文件补的是哪一截
//
// `legion-host.patch.yml` 早就有了、也早就被证明"DSH 读得懂"
// （`patch-loadable.test.mjs` 用真 DSH 管线验过：零警告、permission 表被真的替换）。
// 但**从来没有任何东西把它交给一个 DSH 进程**：
//
//   · Launcher 拼 `runtime` 进程的命令行时只用 `runtime.command`（`argsTemplate: []`）；
//   · `extraArgs` 这个口子存在，却没人往里放东西。
//
// 于是那份补丁层的实际作用范围是**零个部署**——包括本机这一个。
//
//   > 一个"写好了、也验证过能被加载"的补丁层，
//   > 与一个"从未被交给任何进程"的补丁层，在运行的部署上是同一个东西——
//   > 只不过前者的用例是绿的。
//
// ## 为什么是 `--patch`，而不是 profile 自己的 `cordis.patch.yml`
//
// DSH 的组合顺序是：bundle 层 → profile 的 `cordis.patch.yml` → `--patch` 覆盖层
// （profile 根的 `cordis.yml` 文件头自己写着这句话，`args.ts` 的
// `--patch <path>  extra patch-list overlay applied after the profile layer` 同样）。
//
// profile 的 `cordis.patch.yml` **属于用户**：那是他在 `dsh plugin add` 之后
// 手改的那一份，也是产品升级时最不该被覆盖的一份。把强制面写进去，
// 等于"用户下一次编辑自己的 profile 时，可以把安全下限顺手删掉"。
//
//   > 一个"能被用户在同一次编辑里删掉"的强制面，
//   > 与一个"根本没有强制面"的部署，在事故复盘里是同一个东西——
//   > 只不过前者的配置文件里曾经写着它。
//
// `--patch` 覆盖层在最高优先级、由启动方逐次给出、且**不落进用户的 profile**。
//
// ## 默认开、但"关掉"必须是一次说出来的选择
//
// `enabled` 默认 `true`。关掉不是被禁止的——有些部署（例如只想跑一个纯 DSH）
// 确实不需要这一层。但关掉会产出一条 `warn` 诊断把它记下来。
// 这与 `product/secrets.mjs` 里"明文后端 fail closed，但错误文案直接写出
// `requireProtected: false` 怎么写"是同一条取舍：
//
//   > 一个让人猜不到怎么关掉的门禁最后会被人绕过；
//   > 一个写清怎么关掉的门禁，至少让绕过成为一个被记录下来的决定。
//
// ## 打开但文件不在 → 阻塞
//
// 这是本模块唯一"拦启动"的情形，理由是这一层**被要求装上却没装上**。
// 如果这里只报 warn 然后照常启动，得到的就是一个"看起来装了强制面"的运行时——
// 比一个明确起不来的运行时危险得多。
//
// ## 零 IO（`fs` 可注入）
//
// 与 `secrets-check.mjs` / `logFs` 同一做法：判据是"该拦谁、该放谁"，
// 而那件事不需要真的去读磁盘就能逐条验证。
// ============================================================================

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** 本模块的版本。落进诊断，便于把一次启动与一份实现对上。 */
export const DSH_OVERLAY_VERSION = 1

/**
 * 补丁层在**安装目录**里的相对位置。
 *
 * 与 `runtime/dsh-composition/render.mjs` 的 `PATCH_YAML_PATH` 是**同一个文件**，
 * 这里刻意用字面量再写一次而不是 import 那个模块：
 * `product/` 去 import `runtime/dsh-composition/render.mjs` 会把生成器的
 * 整条依赖（以及它的 CLI 入口）拖进 Launcher 的进程。
 * 代价是两处可能漂移——所以有一条用例钉住这两个字面量相等。
 */
export const DSH_OVERLAY_RELPATH = 'runtime/dsh-composition/legion-host.patch.yml'

/** DSH 接受 `--patch <path>`，可重复；覆盖层按 argv 顺序叠在 profile 层之上。 */
export const DSH_OVERLAY_FLAG = '--patch'

/** 只有这个进程吃 `--patch`。 */
export const DSH_OVERLAY_PROCESS_KEY = 'runtime'

export const DSH_OVERLAY_CODES = Object.freeze({
  /** 被要求装上、但补丁文件不在。**阻塞启动**。 */
  PATCH_FILE_MISSING: 'DSH_OVERLAY_PATCH_FILE_MISSING',
  /** 路径存在，但不是普通文件（目录 / 设备）。 */
  PATCH_FILE_NOT_A_FILE: 'DSH_OVERLAY_PATCH_FILE_NOT_A_FILE',
  /** 拿不到安装目录——无从判断补丁层在哪。 */
  NO_INSTALL_DIR: 'DSH_OVERLAY_NO_INSTALL_DIR',
  /** 配置里显式关掉了。**不阻塞**，但必须被记录下来。 */
  DISABLED_BY_CONFIG: 'DSH_OVERLAY_DISABLED_BY_CONFIG',
})

function overlayDiag(severity, code, message, extra = {}) {
  return Object.freeze({
    severity,
    code,
    process: DSH_OVERLAY_PROCESS_KEY,
    message,
    ...extra,
  })
}

/**
 * 算出要交给 DSH Runtime 的覆盖层参数。
 *
 * @param {object} o
 * @param {string|null} o.installDir  安装目录（`layout.installDir`）
 * @param {boolean} o.enabled         是否装上这一层（来自配置 `runtime.enforcementOverlay`）
 * @param {object} [o.fs]             `{ existsSync, statSync }`，可注入
 * @returns {{version:number, enabled:boolean, path:string|null, args:string[],
 *            diagnostics:object[], ok:boolean}}
 *   `ok === false` 表示**不得继续启动**（调用方负责转成阻塞诊断）。
 */
export function resolveDshOverlay({
  installDir = null,
  enabled = true,
  fs = null,
} = {}) {
  const io = {
    exists: fs?.existsSync ?? existsSync,
    stat: fs?.statSync ?? statSync,
  }

  const base = Object.freeze({
    version: DSH_OVERLAY_VERSION,
    enabled: enabled !== false,
    path: null,
    args: Object.freeze([]),
  })

  // ① 显式关掉：给出 args 为空**且**留一条 warn。
  //    顺序很重要——先判 `enabled`。反过来的话，一个"关掉了而且文件也不在"
  //    的部署会同时报两条，而其中一条在说"你没装"，其实用户是**故意不装**。
  if (enabled === false) {
    return Object.freeze({
      ...base,
      ok: true,
      diagnostics: Object.freeze([overlayDiag(
        'warn',
        DSH_OVERLAY_CODES.DISABLED_BY_CONFIG,
        `配置里关闭了 DSH 强制面覆盖层（runtime.enforcementOverlay: false）：` +
        '本次启动的 DSH Runtime **不会**装上 Legion 的 ToolGuard hard floor 与 ' +
        'permission preset 表。这是被允许的，但请确认这是你要的——' +
        '这个运行时里的工具调用不会经过 Legion 的安全下限。' +
        '要恢复：把 runtime.enforcementOverlay 设为 true（或删掉该键，默认即 true）。',
      )]),
    })
  }

  // ② 没有安装目录就无从定位。
  if (typeof installDir !== 'string' || installDir.trim() === '') {
    return Object.freeze({
      ...base,
      ok: false,
      diagnostics: Object.freeze([overlayDiag(
        'error',
        DSH_OVERLAY_CODES.NO_INSTALL_DIR,
        '拿不到安装目录，无法定位 DSH 强制面覆盖层 ' +
        `(runtime.enforcementOverlay 为 true)。` +
        '强制面是被要求装上的，因此这里不能"跳过这一层继续启动"——' +
        '那样得到的运行时看起来装了强制面，而实际上没有。',
      )]),
    })
  }

  const path = isAbsolute(DSH_OVERLAY_RELPATH)
    ? DSH_OVERLAY_RELPATH
    : join(resolve(installDir), ...DSH_OVERLAY_RELPATH.split('/'))

  // ③ 文件在不在。这是唯一会阻塞启动的分支（见文件头）。
  if (!io.exists(path)) {
    return Object.freeze({
      ...base,
      path,
      ok: false,
      diagnostics: Object.freeze([overlayDiag(
        'error',
        DSH_OVERLAY_CODES.PATCH_FILE_MISSING,
        `找不到 DSH 强制面覆盖层：${path}。` +
        '它由 `node runtime/dsh-composition/render.mjs --write` 从 patch-layer.mjs 生成，' +
        '随安装包分发。缺失说明这次安装不完整。' +
        '**不降级为警告**：一个"没有强制面但照常起来"的运行时，' +
        '比一个明确起不来的运行时更难发现。',
        { path },
      )]),
    })
  }

  // ④ 存在但不是普通文件（目录最可能：把 relpath 写成了一个目录名）。
  let st = null
  try { st = io.stat(path) } catch { st = null }
  if (st !== null && typeof st.isFile === 'function' && st.isFile() === false) {
    return Object.freeze({
      ...base,
      path,
      ok: false,
      diagnostics: Object.freeze([overlayDiag(
        'error',
        DSH_OVERLAY_CODES.PATCH_FILE_NOT_A_FILE,
        `DSH 强制面覆盖层不是一个普通文件：${path}。` +
        'DSH 读它会直接失败，而失败发生在 Runtime 启动那一刻——' +
        '那条报错不会提到"补丁层"，排障会从 Runtime 开始找。',
        { path },
      )]),
    })
  }

  return Object.freeze({
    ...base,
    path,
    args: Object.freeze([DSH_OVERLAY_FLAG, path]),
    ok: true,
    diagnostics: Object.freeze([]),
  })
}

/**
 * 覆盖层参数该放在命令行的哪个位置。
 *
 * 返回的是**追加到 `runtime.command` 之后**的那一段——`materializeProcessPlan`
 * 的 `extraArgs` 正是这个语义（`[...configured.args, ...args, ...extras]`）。
 *
 * 单独做成一个函数是为了让"位置"这件事可断言：DSH 的 `--patch` 是顶层可重复选项，
 * 但它在 `dsh web --patch X` 与 `dsh --patch X web` 里落到不同的解析分支上。
 * 生产路径是前者（`web` 是 `runtime.command` 里的模式），所以这里只产出后者要的那一段。
 */
export function overlayArgsFor(overlay) {
  if (overlay === null || typeof overlay !== 'object') return Object.freeze([])
  if (!Array.isArray(overlay.args)) return Object.freeze([])
  return Object.freeze([...overlay.args])
}

/** 供诊断文案与用例使用：把绝对路径显示成安装目录内的相对形式。 */
export function overlayRelpathOf(installDir, path) {
  if (typeof installDir !== 'string' || typeof path !== 'string') return null
  const root = resolve(installDir)
  const abs = resolve(path)
  if (abs === root) return ''
  return abs.startsWith(root + sep) ? abs.slice(root.length + 1).split(sep).join('/') : abs
}
