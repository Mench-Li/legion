// product/launcher/run-credential-materialization.mjs
// ============================================================================
// PRT-509 缺口 ①：把 `security/secrets/credential-materializer.mjs`（**写侧能力**）
// 接进**生产的启动路径**，并让它在生产里真的有一个读者。
//
// ## 这个文件补的是哪一截（施工之前的状态）
//
// `openRunCredentials()` 有句柄、`materializeRunCredentials()` 有判据、两边都有
// 用例，而 `git grep` 的**非测试命中只有它们自己**。那份台账把这件事写成：
//
//   > 仍然没有生产调用方——本模块只是**写侧的能力**，还没接到任何一个 Run 的
//   > 启动路径上。
//
// 而"能力存在、测试全绿、没有任何生产代码调用"与"这个能力不存在"，
// 对用户来说是同一件事——**只不过前者的测试报告是绿的**。
//
// ## 什么时候跑：启动时**一次**，在 spawn Runtime 之前
//
// 三个候选各自的代价：
//
//   · **每一个 Run 开始时**：DSH 的凭证文档是**进程级共享**的一份，而且提供方
//     在 `watch: true` 时会热重载它。于是 Run B 落盘时会把 Run A 那份覆盖掉，
//     而 spec §6.7 要求"在途 Run 保持其启动时解析到的凭证"。**一次写入会改掉
//     另一个正在跑的东西手里的钥匙**——这是本仓最不能接受的那类失败（它不报错）。
//   · **按需（第一次真要模型请求时）**：那时 Runtime 已经起来、Run 已经派出去，
//     落盘晚于读取，Run 会以"模型鉴权失败"的形状失败，而真因是"文件还没写"。
//   · **启动时一次、在 spawn Runtime 之前**：这是唯一同时满足"读取方还没读"
//     与"失败还来得及报"的位置。文件在 Runtime 进程存在之前就位，落盘失败
//     发生在**任何进程被拉起来之前**。
//
// 于是本模块的调用点是 `launcher.start()` 里、`preflight()` 之后、
// `createSupervisor()`/spawn 之前。
//
// ## 让 DSH **真的读它**：不改 DSH_HOME，改凭证提供方那一行
//
// 材料化器的设计约束是"只写 Legion 自有目录、**拒绝对 operator 的真实 home 写**"，
// 所以目标**不可能**是 operator 的 `$DSH_HOME/.credentials.yaml`。而 DSH 默认只读
// 那个文件——这一截就是台账里的缺口 ③（"没有任何真实 DSH 进程读过这些文件"）。
//
// 把 Runtime 子进程的 `DSH_HOME` 指到 Legion 自有目录是**错的**，理由不是风格：
// 实测（spec §A.3）当前部署的 `$DSH_HOME` 下有 244 个指向源码 checkout 的 junction，
// 而且 `$DSH_HOME` 的位置本身还是 PRT-011 的**未决项**（spec `:820`）。换家目录会
// 顺带换掉 profile 安装位（`employee-preset` 写在那里）、settings 与历史会话——
// 那是另一个产品决定，不是本模块该顺手做的。
//
// DSH 自己提供了对的那条缝：`@deepseek-ai/dsh-credentials-local` 的行配置有
// `path`（`resolveSpec`：`config.path ?? join(resolveDshHome(config.dshHome), …)`），
// 而 Legion **已经**有一个"给 DSH 传补丁层"的机制（`--patch`，`dsh-overlay.mjs`）。
// 于是一个只含**一个路径**（不是密钥）的覆盖层就够了：
//
//     - id: credentials
//       config:
//         path: <Legion 自有的 .credentials.yaml>
//
// ★ 这一条是**实测**出来的，不是读文档推的：一次性 `$DSH_HOME` 下跑真 DSH，
//   `--dump-config` 的输出里那一行显示为
//   `# == @deepseek-ai/dsh-base, patched by <覆盖层文件>` 且 `config.path` 就是那个路径。
//
// ## 覆盖层**总是**被接上，内容随有没有东西可写而变
//
// `--patch` 指向的文件必须存在（DSH 对不存在的补丁文件直接报错退出），所以覆盖层
// 文件在 spawn 之前**必须**写出来。它的内容是两者之一：
//
//   · `[]`（空补丁表，**合法的空操作**）—— Legion 这次没有可材料化的凭证 ⇒
//     DSH 的凭证提供方保持默认（operator 的 `$DSH_HOME/.credentials.yaml`），
//     **行为与接线之前逐字相同**；
//   · 上面那一行 —— Legion 有自己的凭证 ⇒ DSH 读 Legion 那份。
//
// 这条分界守的是一个很容易踩的坑：一个"Legion 没配过模型密钥、却把 DSH 的
// 凭证来源改指到一个不存在的文件"的接线，会让**本来能用的部署**在接完线之后
// 用不上 DSH 里已有的钥匙，而且不报错（提供方对不存在的文档只看成 `absent`）。
//
// ## 值：本模块**从不**看、不拼、不记任何凭证值
//
// 值的搬运只有一条路：`materializeRunCredentials()` 从**冻结句柄**里取。
// 本模块只碰引用名、DSH 名字、路径、模式与计数。诊断里没有值、没有引用值、
// 也没有"有哪些引用名"的清单（引用名能画出这台机器配了哪些供应商）。
//
// ## 映射：由 DSH 自己的声明给，不由 Legion 猜
//
// 材料化器要求调用方给出「Legion 引用 → DSH 可寻址名字」，且**刻意不内置任何
// provider → 环境变量名的表**（那张表会随 DSH 的适配器一起过时，而过时的表现是
// 把钥匙写到一个没有任何人读的名字下面——它看起来完全成功）。
//
// 于是这里**问 DSH 自己**：从它随发行版带的 base bundle 补丁文件里读 `apiKeyEnv`
// 声明（例如 `apiKeyEnv: DEEPSEEK_API_KEY`）。读不到、或读出**不止一个不同的
// 名字**时**具名拒绝**，不猜——多供应商的部署需要一次显式的决定，而不是一个
// "取第一个"的默认。
// ============================================================================

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { isPathInside } from '../paths.mjs'
import { DSH_CREDENTIALS_FILENAME } from '../../security/secrets/index.mjs'
// 写侧能力的实现本身。**这是生产调用的那一次 import**：在此之前，整个仓库里
// 引用 `materializeRunCredentials` 的非测试文件**一个都没有**（缺口 ①）。
// 它不经 `security/secrets/index.mjs` 转出，与它自己的用例同一个口径
// （那个 index 是密钥层的公共出口，而这个函数是**产品接线**才需要的那一层）。
import { materializeRunCredentials } from '../../security/secrets/credential-materializer.mjs'

/** 本模块的版本。落进读数，便于把一次启动与一份实现对起来。 */
export const RUN_CREDENTIAL_WIRING_VERSION = 1

/** 本模块的具名内部码。它们**不是**契约码：契约码仍由密钥层决定。 */
export const RUN_CREDENTIAL_WIRING_CODES = Object.freeze({
  /** 没有产品家目录（`layout.productHome` 解析不出来）——没有可写的 Legion 自有根。 */
  NO_ALLOWED_ROOT: 'RUN_CREDENTIALS_NO_ALLOWED_ROOT',
  /** 产品家目录**不可用**（相对路径 / 落在数据目录内）。 */
  ALLOWED_ROOT_INVALID: 'RUN_CREDENTIALS_ALLOWED_ROOT_INVALID',
  /** 目标会落在数据目录内：数据目录是备份/诊断包导出的对象（spec §3.1）。 */
  TARGET_INSIDE_DATA_DIR: 'RUN_CREDENTIALS_TARGET_INSIDE_DATA_DIR',
  /** 没有 operator 的真实 home（`$DSH_HOME` 与 `~/.dsh` 都没有）。**不写**。 */
  OPERATOR_HOME_REQUIRED: 'RUN_CREDENTIALS_OPERATOR_HOME_REQUIRED',
  /** 这次没有声明"运行时需要哪些凭证"⇒ 空操作，**不是**错误。 */
  NO_REFS_DECLARED: 'RUN_CREDENTIALS_NO_REFS_DECLARED',
  /** DSH 没有声明任何 `apiKeyEnv`（或声明读不出来）。**不猜**。 */
  DSH_DECLARATION_MISSING: 'RUN_CREDENTIALS_DSH_DECLARATION_MISSING',
  /** DSH 声明了**不止一个**不同的名字：多供应商部署需要一次显式决定，不取第一个。 */
  DSH_DECLARATION_AMBIGUOUS: 'RUN_CREDENTIALS_DSH_DECLARATION_AMBIGUOUS',
  /** 拿不到 base bundle 补丁文件的路径（拿不到声明就无从映射）。 */
  DSH_DECLARATION_UNLOCATABLE: 'RUN_CREDENTIALS_DSH_DECLARATION_UNLOCATABLE',
  /** 冻结句柄开不出来（密钥库打不开 / 引用解析失败）。 */
  HANDLE_FAILED: 'RUN_CREDENTIALS_HANDLE_FAILED',
  /** 材料化器具名拒绝了（它自己的码在 `cause` 里）。 */
  MATERIALIZE_REFUSED: 'RUN_CREDENTIALS_MATERIALIZE_REFUSED',
  /** DSH 的具名码 */ OVERLAY_WRITE_FAILED: 'RUN_CREDENTIALS_OVERLAY_WRITE_FAILED',
  /**
   * Legion 自有的落地目录建不出来。
   *
   * ★ 这一条是**接线必须自己做**的一件事，而不是材料化器会顺手做的：
   *   材料化器用 `realpathSync(allowedRoot)` 证"目标真的落在根内"，
   *   而它对**不存在的目录**是具名拒绝（`ALLOWED_ROOT_UNRESOLVED` /
   *   `TARGET_DIR_UNRESOLVED`），且刻意不替调用方建目录——"写进一个计划外的新
   *   目录是另一种意外"。
   *
   *   于是"接了线、但没建目录"的表现是：每次启动都调用材料化器、每次都具名拒绝、
   *   **一个字节都没写出去**——而调用方那一侧的读数看起来完全正常。这类"调用在、
   *   效果不在"的接线，与根本没有接线在部署上是同一个东西。
   */
  TARGET_DIR_UNCREATABLE: 'RUN_CREDENTIALS_TARGET_DIR_UNCREATABLE',
})

/**
 * Legion 自己声明的"运行时需要哪一份凭证"。
 *
 * `model/api-key` 是**产品自己的**引用名：向导把它写进受保护密钥库
 * （`product/launcher/cli.mjs` 的 `MODEL_KEY_REF`）。这里**不重新发明**一个名字，
 * 也不把它换成 provider 相关的名字——引用名与"DSH 怎么寻址"是两件事，
 * 后者由 DSH 的声明给（见文件头）。
 *
 * 用例会**读源码**钉住这两处字面量相等（两份手写的常量会漂移，而漂移的表现是
 * "向导存了、运行时拿不到"，只在用户真的跑起来时才暴露）。
 */
export const RUNTIME_MODEL_KEY_REF = 'model/api-key'

/** 缺省声明：运行时的模型钥匙。 */
export const DEFAULT_RUNTIME_CREDENTIAL_REFS = Object.freeze([RUNTIME_MODEL_KEY_REF])

/** 覆盖层要 patch 的 DSH 行 id（`@deepseek-ai/dsh-base` 里的那一行）。 */
export const RUN_CREDENTIAL_OVERLAY_ROW_ID = 'credentials'

/** 空补丁表：合法的空操作覆盖层（见文件头"覆盖层总是被接上"）。 */
export const RUN_CREDENTIAL_OVERLAY_NOOP = '[]\n'

/**
 * 算出 Legion 自有的凭证落地位置。
 *
 * **在 `layout.productHome` 下，不在 `layout.dataDir` 下**：数据目录是备份、
 * 恢复与诊断包导出的对象（spec §3.1），而这份文件是**明文**的 DSH 文档
 * （DSH 只读明文）。把明文凭证放进会被打包带走的目录，等于让每一次导出都
 * 顺手带走一份钥匙。
 *
 * @param {object} layout `resolveLayout()` 的产物
 * @returns {Readonly<{ok:boolean, code:string|null, message:string|null,
 *   root:string|null, allowedRoot:string|null, targetFile:string|null, overlayFile:string|null}>}
 */
export function runCredentialPaths(layout) {
  const no = (code, message) => Object.freeze({
    ok: false, code, message, root: null, allowedRoot: null, targetFile: null, overlayFile: null,
  })
  const home = layout?.productHome
  if (typeof home !== 'string' || home.trim() === '') {
    return no(RUN_CREDENTIAL_WIRING_CODES.NO_ALLOWED_ROOT,
      '没有产品家目录（layout.productHome）——没有 Legion 自有的写入根，'
      + '而凭证**不允许**落在 operator 的真实 home 里（见材料化器的目标路径判据）')
  }
  if (!isAbsolute(home)) {
    return no(RUN_CREDENTIAL_WIRING_CODES.ALLOWED_ROOT_INVALID,
      '产品家目录不是绝对路径——相对路径落在哪里取决于当前工作目录，那不是一个可复核的写入目标')
  }
  const platform = layout?.platform ?? process.platform
  const root = resolve(join(home, 'runtime-credentials'))
  // 数据目录是导出对象：明文凭证不得落在里面（与 `SECRETS_INSIDE_DATA_DIR` 同一条规矩）。
  if (typeof layout?.dataDir === 'string' && layout.dataDir !== '' && isPathInside(layout.dataDir, root, platform)) {
    return no(RUN_CREDENTIAL_WIRING_CODES.TARGET_INSIDE_DATA_DIR,
      `凭证落地位置（${root}）落在数据目录（${layout.dataDir}）内：`
      + '数据目录会被备份/诊断包导出带走，而这份文件是明文凭证')
  }
  return Object.freeze({
    ok: true,
    code: null,
    message: null,
    root,
    // `allowedRoot` 就是它自己：材料化器只允许写这个目录**里面的**那个文件名。
    allowedRoot: root,
    targetFile: resolve(join(root, DSH_CREDENTIALS_FILENAME)),
    overlayFile: resolve(join(root, 'credentials-path.patch.yml')),
  })
}

/**
 * 渲染"把 DSH 的凭证提供方指到 Legion 那份文件"的覆盖层文档。
 *
 * 只含一个**路径**（不是密钥）。路径用 JSON 字符串字面量写：YAML 的双引号标量
 * 与 JSON 的转义规则在反斜杠这一点上一致，于是 Windows 路径不会被 YAML 吃掉
 * （用裸标量写 `C:\a\b` 会被解析成完全不同的东西）。
 */
export function runCredentialOverlayDocument({ targetFile } = {}) {
  if (typeof targetFile !== 'string' || targetFile.trim() === '') return RUN_CREDENTIAL_OVERLAY_NOOP
  return `- id: ${RUN_CREDENTIAL_OVERLAY_ROW_ID}\n  config:\n    path: ${JSON.stringify(targetFile)}\n`
}

/**
 * 要追加到 runtime 命令之后的 `--patch` 参数。
 *
 * `[]` 时**不追加**：一个把 `--patch` 指向不存在文件的接线，会让 DSH 起不来，
 * 而那条失败看起来像"运行时装坏了"。
 */
export function runCredentialOverlayArgs(paths) {
  if (paths === null || typeof paths !== 'object' || paths.ok !== true) return Object.freeze([])
  if (typeof paths.overlayFile !== 'string' || paths.overlayFile === '') return Object.freeze([])
  return Object.freeze(['--patch', paths.overlayFile])
}

/**
 * 从 DSH 的 base bundle 补丁文本里读出它声明的凭证名字（`apiKeyEnv`）。
 *
 * **只认恰好一个不同的名字**：
 *   · 0 个 ⇒ 声明读不到，不猜（`DSH_DECLARATION_MISSING`）；
 *   · ≥2 个 ⇒ 多供应商部署，需要一次显式决定（`DSH_DECLARATION_AMBIGUOUS`）。
 *
 * 取"第一个"看起来更宽容，但它会把"这台机器上到底该用哪个名字"这个决定
 * 藏进一个**数组顺序**里——而顺序不是任何人做过的决定。
 *
 * @param {{text:string}} o
 * @returns {Readonly<{ok:boolean, code:string|null, message:string|null, names:ReadonlyArray<string>}>}
 */
export function dshCredentialNamesFromPatchText({ text } = {}) {
  const none = (code, message, names = []) => Object.freeze({ ok: false, code, message, names: Object.freeze(names) })
  if (typeof text !== 'string' || text === '') {
    return none(RUN_CREDENTIAL_WIRING_CODES.DSH_DECLARATION_MISSING,
      '读不到 DSH 的 base bundle 补丁文本，因此读不到它的 apiKeyEnv 声明——不猜名字')
  }
  const names = []
  const re = /^\s*apiKeyEnv:\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*$/gm
  for (const m of text.matchAll(re)) {
    const name = m[1] ?? m[2] ?? m[3]
    if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name)
  }
  if (names.length === 0) {
    return none(RUN_CREDENTIAL_WIRING_CODES.DSH_DECLARATION_MISSING,
      'DSH 的 base bundle 补丁里没有任何 apiKeyEnv 声明——'
      + '本模块不内置 provider → 环境变量名的表（那张表会随 DSH 的适配器一起过时，'
      + '而过时的表现是把钥匙写到一个没有任何人读的名字下面，它看起来完全成功）')
  }
  if (names.length > 1) {
    return none(RUN_CREDENTIAL_WIRING_CODES.DSH_DECLARATION_AMBIGUOUS,
      `DSH 声明了 ${names.length} 个不同的凭证名字——多供应商部署需要一次显式决定：`
      + '不取第一个，因为"第一个"不是任何人做过的决定', names)
  }
  return Object.freeze({ ok: true, code: null, message: null, names: Object.freeze(names) })
}

/**
 * 定位 DSH 随发行版带的 base bundle 补丁文件。
 *
 * 用 Node 自己的解析器（`createRequire(入口).resolve(...)`）而不是拼路径：
 * 开发布局（`$DSH_HOME` 下全是指向 checkout 的 junction）与路线 C（npm 装进
 * `<DataDir>/runtime/dsh/versions/<版本>/`）的目录形状**不同**，而拼路径的
 * 版本会在其中一种布局上返回 null——那时"读不到声明"会被当成"DSH 没声明"，
 * 于是一次映射失败看起来像一次合法的空操作。
 *
 * 入口从 `runtime.command.args` 里**认**出来（第一个 `.js/.mjs/.cjs`），
 * 认不出就返回 null，不猜。
 */
export function resolveDshBaseBundlePatchPath({ runtimeCommand = null, requireFn = null } = {}) {
  const args = Array.isArray(runtimeCommand?.args) ? runtimeCommand.args : []
  const entry = args.find((a) => typeof a === 'string' && /\.(?:mjs|cjs|js)$/i.test(a))
  if (typeof entry !== 'string' || entry === '') return null
  let req = requireFn
  try {
    // `createRequire()` 的产物**是**一个函数，但唯一用到的方法是 `.resolve`。
    // 判据按"有没有那个方法"来，而不是按"是不是函数"：一个按后者写的判据会把
    // 所有以对象形状注入的替代实现（用例最自然的注入形状）当成"没注入"，
    // 于是走进 `createRequire` 那条真实路径去解析一个不存在的入口。
    const usable = (r) => r !== null && typeof r === 'object' && typeof r.resolve === 'function'
    if (!usable(req)) {
      if (!isAbsolute(entry)) return null
      req = createRequire(entry)
    }
    if (!usable(req)) return null
    const found = req.resolve('@deepseek-ai/dsh-base/cordis.patch.yml')
    return typeof found === 'string' && found !== '' ? found : null
  } catch {
    // 解析不出来就说"解析不出来"（返回 null），由调用方翻成具名读数。
    return null
  }
}

/**
 * 生产默认的冻结句柄工厂（`({refs, runId}) => Promise<handle>`）。
 *
 * ★ 走**解析器**（`resolver.resolveCredential`）而不是直接 `store.get`：
 *   解析器的第一顺位仍是 Legion 自己的受保护库，只有库里**没有**那条时才去读
 *   DSH 的只读回退来源（路线 A′）。用 `store` 会让"DSH 里有、Legion 库里没有"
 *   的那把钥匙在接完线之后**消失**——而接线最容易制造的就是这种静默的行为改变：
 *   它不报错，只是模型再也连不上。
 *
 * 库里没有这条引用时，解析器返回 `null`，于是 `openRunCredentials()` 具名拒绝
 * （`RESOLVE_FAILED`）、这里再翻成 `HANDLE_FAILED`、覆盖层退回**空操作**：
 * DSH 的凭证提供方保持默认。这是"用户还没配过模型密钥"那条正常路径——
 * 它不该被报成故障，也**不该**把 DSH 的来源改指到一个不存在的文件。
 *
 * 它在这里、而不在 `launcher.mjs` 的闭包里：闭包里的默认实现**没法被单测**，
 * 而"只有生产才跑的那条分支"正是缺陷最容易藏身的地方（本文件要修的缺口 ①
 * 就是这么来的）。注入点收成两个（`openSecrets` / `openRunCredentialsImpl`），
 * 生产默认仍是那两个动态 import。
 *
 * @param {object} deps
 * @param {object} deps.layout `resolveLayout()` 的产物
 * @param {boolean} [deps.requireProtected] 是否要求受保护后端（默认 `true`）
 * @param {string|null} [deps.dshCredentialsFile] 只读回退来源（路线 A′）
 * @param {Function|null} [deps.openSecrets] 注入点：`openProductSecrets` 的替代
 * @param {Function|null} [deps.openRunCredentialsImpl] 注入点：`openRunCredentials` 的替代
 * @returns {(args: {refs: ReadonlyArray<string>, runId: string}) => Promise<object>}
 */
export function productRunCredentialOpener({
  layout,
  requireProtected = true,
  dshCredentialsFile = null,
  openSecrets = null,
  openRunCredentialsImpl = null,
} = {}) {
  return async function openRunCredentialHandle({ refs, runId }) {
    const opened = typeof openSecrets === 'function'
      ? await openSecrets({ layout, requireProtected, dshCredentialsFile })
      : await (async () => {
        const mod = await import('../secrets.mjs')
        return mod.openProductSecrets({ layout, requireProtected, dshCredentialsFile })
      })()
    if (opened?.ok !== true) {
      // 错误里**只带具名码**：密钥库自己的 message 可能含库路径等现场信息。
      const err = new Error('secrets-store-unavailable')
      err.code = opened?.code ?? 'SECRETS_STORE_OPEN_FAILED'
      throw err
    }
    const resolver = opened.resolver
    const store = typeof resolver?.resolveCredential === 'function'
      ? { get: (ref) => resolver.resolveCredential(ref) }
      : opened.store
    const open = typeof openRunCredentialsImpl === 'function'
      ? openRunCredentialsImpl
      : (await import('../../security/secrets/run-credentials.mjs')).openRunCredentials
    return open({ store, refs, runId })
  }
}

/** 把文件层读数翻成诊断。**只有具名码、路径与计数，没有值。** */
function diagnostic(severity, code, message, extra = {}) {
  return Object.freeze({ severity, code, process: 'runtime', message, ...extra })
}

/**
 * 生产步骤：算出目标 → 开冻结句柄 → 材料化 → 写覆盖层。
 *
 * 失败**不抛**：它返回一个具名读数，由调用方决定"阻止启动"还是"只提醒"
 * （与 `secrets-check.mjs` 同一条分界：启动本身会制造新危险的才阻止）。
 * 唯一的例外是**覆盖层写不出来**：那时 `--patch` 会指向一个不存在的文件，
 * 于是 spawn 必然失败——那条由调用方按 `blocking: true` 处理。
 *
 * @param {object} deps
 * @param {object} deps.layout             `resolveLayout()` 的产物
 * @param {object|null} [deps.paths]       已算好的 `runCredentialPaths()`（可注入）
 * @param {string|null} [deps.dshCredentialsFile] operator 的 `$DSH_HOME/.credentials.yaml`
 * @param {string|null} [deps.operatorHome] operator 的**操作系统**家目录（`~/.dsh` 的父目录）
 * @param {string} [deps.runId]            这次启动的标识（落进句柄）
 * @param {ReadonlyArray<string>|null} [deps.refs] 本次要材料化的引用名；`null`=缺省声明
 * @param {Map|object|null} [deps.mapping] Legion 引用 → DSH 名字（不给则问 DSH）
 * @param {object|null} [deps.runtimeCommand] 用来定位 DSH 的 base bundle 补丁
 * @param {Function|null} [deps.openHandle] 注入点：`({refs, runId}) => Promise<handle>`
 * @param {Function} [deps.materialize]     注入点：默认 `materializeRunCredentials`
 * @param {Function|null} [deps.requireFn]  注入点：`createRequire` 的替代
 * @param {object} [deps.io]                文件操作门面（用例注入）
 * @returns {Promise<Readonly<object>>}
 */
export async function prepareRuntimeCredentials({
  layout,
  paths = null,
  dshCredentialsFile = null,
  operatorHome = null,
  runId = 'launch',
  refs = null,
  mapping = null,
  runtimeCommand = null,
  openHandle = null,
  materialize = materializeRunCredentials,
  requireFn = null,
  io = null,
} = {}) {
  const fs = io ?? { mkdirSync, readFileSync, writeFileSync }
  const resolvedPaths = paths ?? runCredentialPaths(layout)
  const written = { overlay: false, credentials: false }

  /** 把覆盖层写成空操作，并返回一个具名读数。 */
  const giveUp = (severity, code, message, extra = {}) => {
    writeOverlay(RUN_CREDENTIAL_OVERLAY_NOOP)
    const ok = code === RUN_CREDENTIAL_WIRING_CODES.NO_REFS_DECLARED
    return Object.freeze({
      version: RUN_CREDENTIAL_WIRING_VERSION,
      ok,
      applied: false,
      blocking: false,
      code,
      message,
      target: null,
      overlay: resolvedPaths.overlayFile ?? null,
      entry: null,
      overlayWritten: written.overlay,
      ...extra,
      diagnostics: Object.freeze([diagnostic(severity, code, message)]),
    })
  }

  function writeOverlay(text) {
    if (resolvedPaths.ok !== true || typeof resolvedPaths.overlayFile !== 'string') return false
    try {
      fs.mkdirSync(dirname(resolvedPaths.overlayFile), { recursive: true })
      fs.writeFileSync(resolvedPaths.overlayFile, text, 'utf8')
      written.overlay = true
      return true
    } catch {
      written.overlay = false
      return false
    }
  }

  if (resolvedPaths.ok !== true) {
    // 没有 Legion 自有的落地位置 ⇒ 不接覆盖层（行为与接线之前逐字相同），只报告。
    return Object.freeze({
      version: RUN_CREDENTIAL_WIRING_VERSION,
      ok: false,
      applied: false,
      blocking: false,
      code: resolvedPaths.code,
      message: resolvedPaths.message,
      target: null,
      overlay: null,
      entry: null,
      overlayWritten: false,
      diagnostics: Object.freeze([diagnostic('warn', resolvedPaths.code, resolvedPaths.message)]),
    })
  }

  // ── operator 的真实 home：**必填**（材料化器的目标路径判据靠它） ──────────
  //
  // `$DSH_HOME` 从**已经解析好的**凭证文件路径反推（同一个来源、同一个键），
  // `~/.dsh` 由调用方注入。两个都没有 ⇒ 这条拒绝线不在 ⇒ **不写**（具名拒绝）。
  const operatorHomes = []
  if (typeof dshCredentialsFile === 'string' && dshCredentialsFile.trim() !== '') {
    operatorHomes.push(resolve(dirname(dshCredentialsFile)))
  }
  if (typeof operatorHome === 'string' && operatorHome.trim() !== '') {
    operatorHomes.push(resolve(join(operatorHome, '.dsh')))
  }
  if (operatorHomes.length === 0) {
    return giveUp('warn', RUN_CREDENTIAL_WIRING_CODES.OPERATOR_HOME_REQUIRED,
      '没有声明 operator 的真实 home（$DSH_HOME 未设、也没有操作系统家目录）——'
      + '材料化器不允许写进那两个目录，而"漏注入"会让这条拒绝线**不在**，'
      + '所以它拒绝写；这里同样不写。')
  }

  // ── 声明：这次运行需要哪一份凭证 ────────────────────────────────────────
  const declaredRefs = refs === null || refs === undefined ? DEFAULT_RUNTIME_CREDENTIAL_REFS : refs
  if (!Array.isArray(declaredRefs) || declaredRefs.length === 0) {
    return giveUp('info', RUN_CREDENTIAL_WIRING_CODES.NO_REFS_DECLARED,
      '这次没有声明运行时需要的凭证（refs 为空）——空操作覆盖层：'
      + 'DSH 的凭证提供方保持默认，行为与接线之前相同。')
  }

  // ── 映射：问 DSH 自己（不给映射时） ────────────────────────────────────
  let resolvedMapping = mapping
  if (resolvedMapping === null || resolvedMapping === undefined) {
    const patchPath = resolveDshBaseBundlePatchPath({ runtimeCommand, requireFn })
    if (patchPath === null) {
      return giveUp('warn', RUN_CREDENTIAL_WIRING_CODES.DSH_DECLARATION_UNLOCATABLE,
        '定位不到 DSH 的 base bundle 补丁文件（拿不到它的 apiKeyEnv 声明）——不猜名字，这次不材料化')
    }
    let text = null
    try {
      text = fs.readFileSync(patchPath, 'utf8')
    } catch {
      text = null
    }
    const declared = dshCredentialNamesFromPatchText({ text })
    if (declared.ok !== true) {
      return giveUp(declared.code === RUN_CREDENTIAL_WIRING_CODES.DSH_DECLARATION_AMBIGUOUS ? 'warn' : 'warn',
        declared.code, declared.message)
    }
    // 声明里恰好一个名字 ⇒ 每一条本次声明的引用都映到它。
    const map = new Map()
    for (const ref of declaredRefs) map.set(ref, declared.names[0])
    resolvedMapping = map
  }

  // ── 冻结句柄：开不出来就**不写**（"半个凭证集合"比"没有"危险得多） ────────
  let handle = null
  try {
    if (typeof openHandle !== 'function') throw new Error('no-open-handle')
    handle = await openHandle({ refs: declaredRefs, runId })
  } catch (e) {
    return giveUp('warn', RUN_CREDENTIAL_WIRING_CODES.HANDLE_FAILED,
      `开不出这次运行的冻结凭证句柄（${e?.code ?? e?.name ?? 'Error'}）——`
      + '不写半份凭证文件：一个拿到 3/5 份凭证的 Runtime 会**带病跑完**')
  }

  // ── 材料化 ─────────────────────────────────────────────────────────────
  //
  // ★ 建目录是**这一步必须做的事**，不是材料化器会顺手做的：它用 `realpathSync`
  //   证"目标真的落在根内"，而对不存在的根/父目录是具名拒绝，且刻意不替调用方
  //   建目录。漏掉这一步的表现是"每次都调用、每次都被拒、一个字节都没写出去"。
  //   Legion 自有的目录由 Legion 建；operator 的真实 home 一个都不碰。
  try {
    fs.mkdirSync(resolvedPaths.root, { recursive: true })
  } catch {
    return giveUp('warn', RUN_CREDENTIAL_WIRING_CODES.TARGET_DIR_UNCREATABLE,
      `建不出 Legion 自有的凭证目录（${resolvedPaths.root}）——`
      + '材料化器证不出目标落在根内就不写，所以这次不材料化。'
      + '注意不要为了绕开它去改 `allowedRoot`：那个根是"只写 Legion 自有目录"这条保证本身')
  }

  const materializeFn = materialize
  if (typeof materializeFn !== 'function') {
    return giveUp('warn', RUN_CREDENTIAL_WIRING_CODES.MATERIALIZE_REFUSED,
      '没有可用的材料化实现（materialize 不是函数）——不写')
  }
  let entry = null
  try {
    entry = materializeFn({
      handle,
      targetFile: resolvedPaths.targetFile,
      mapping: resolvedMapping,
      allowedRoot: resolvedPaths.allowedRoot,
      operatorHomes,
      ...(io === null ? {} : { io }),
    })
    written.credentials = true
  } catch (e) {
    // 材料化器自己的具名码进 `cause`（它不带值）。
    return giveUp('warn', RUN_CREDENTIAL_WIRING_CODES.MATERIALIZE_REFUSED,
      `材料化被拒绝（${e?.code ?? e?.name ?? 'Error'}）——目标未被改动，`
      + '本次不把 DSH 的凭证来源改指到 Legion 那份',
      { cause: e?.code ?? null })
  }

  // ── 覆盖层：真的把 DSH 指过去 ──────────────────────────────────────────
  const ok = writeOverlay(runCredentialOverlayDocument({ targetFile: resolvedPaths.targetFile }))
  if (!ok) {
    return Object.freeze({
      version: RUN_CREDENTIAL_WIRING_VERSION,
      ok: false,
      applied: false,
      // ★ 这一条**阻止启动**：`--patch` 指向的文件写不出来，spawn 必然失败，
      //   而那条失败在 DSH 那侧读起来像"运行时装坏了"。
      blocking: true,
      code: RUN_CREDENTIAL_WIRING_CODES.OVERLAY_WRITE_FAILED,
      message: `写不出凭证覆盖层（${resolvedPaths.overlayFile ?? '（无路径）'}）：`
        + '`--patch` 会指向一个不存在的文件，Runtime 起来必然失败——'
        + '所以在这里说清，而不是让用户去读 DSH 的报错',
      target: resolvedPaths.targetFile,
      overlay: resolvedPaths.overlayFile,
      entry,
      overlayWritten: false,
      diagnostics: Object.freeze([diagnostic('error', RUN_CREDENTIAL_WIRING_CODES.OVERLAY_WRITE_FAILED,
        '写不出凭证覆盖层：Runtime 的 `--patch` 会指向不存在的文件')]),
    })
  }

  const count = Array.isArray(entry?.entries) ? entry.entries.length : null
  return Object.freeze({
    version: RUN_CREDENTIAL_WIRING_VERSION,
    ok: true,
    applied: true,
    blocking: false,
    code: null,
    message: `已把这次运行声明的凭证材料化到 Legion 自有目录，并让 DSH 的凭证提供方读它`
      + `（${count === null ? '条目数未知' : `${count} 条`}）`,
    target: entry?.target ?? resolvedPaths.targetFile,
    overlay: resolvedPaths.overlayFile,
    entry,
    overlayWritten: true,
    diagnostics: Object.freeze([]),
  })
}
