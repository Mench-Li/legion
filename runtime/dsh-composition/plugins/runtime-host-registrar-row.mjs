// runtime/dsh-composition/plugins/runtime-host-registrar-row.mjs
// ============================================================================
// PRT-253（续批二）：`setDshRuntimeInputsFactory()` 的**生产注册方**——
// 也就是上一批 §6 点名的「唯一还缺的那一件」的下一层。
//
// ## 上一批留下的那个缝
//
// `runtime-host-row.mjs` 在自己的文件头写着一句诚实的话：
//
//   > `probeRuntime`（版本 + 四项必需能力）在全仓库**没有任何生产实现**，
//   > `canRead` 同样只有用例替身……**今天这个缝是空的，没有生产注册方**。
//
// 本模块就是那个注册方。它按 `team-hub/approval-registrar-row.mjs` 已经验证过的
// 形状工作：**模块求值期**注册工厂，然后默认导出**真的那个**插件对象
// （`===` 同一个对象，不是形状相同的替身）——于是"注册先于 `apply`"由 Node 的
// ESM 求值顺序保证，而不是由补丁行顺序保证（那条 2×2 矩阵的读数见
// `docs/superpowers/prt/PRT-214-enforcement-composition-root.md` §10）。
//
// ## ★ 本批真正回答的问题：这三样各自**从哪里来**
//
// | 输入 | 本批的结论 | 依据 |
// | --- | --- | --- |
// | 引擎**版本** | **有**真来源 → 填上了 | 进程自己那次启动的入口（`process.argv[1]`）所属安装的 `package.json`；读不到就**报 null**（fail closed） |
// | 四项必需**能力** | 一项有真来源，三项**报未确认** | 见下 |
// | `canRead` | **没有**合法来源 → **具名拒绝** | 见下 |
//
// ### 版本：从"正在跑的那份安装"读，不从常量读
//
// `probeRuntime` 要报的是**这台机器上正在跑的那个引擎**的版本。它必须来自
// 进程现场，不能是一行写死的字符串。本批实测（一次性 `DSH_HOME`、`bundles: []`、
// 真 `dsh` 进程）：
//
//     ARGV1 D:\project\DSH\dsh\deepseek-harness\apps\cli\lib\bin.js
//
// 也就是：DSH 进程的入口就是那份安装里的 CLI。于是本模块从 `process.argv[1]`
// （外加加载器树里那些 `file://` 模块名）出发，向上有限层找
// `@deepseek-ai/dsh` / `@deepseek-ai/dsh-root` 的 `package.json`，读它的 `version`。
// 找不到就是 `{ok:false}`，`probeDshRuntime()` 报 `version: null`——
// 而 `checkRuntimeVersion(null)` 判**不兼容**（`probe.mjs` 的 fail closed 口径）。
//
//   · 一个"读不到版本就当它兼容"的探针，
//     与一个"把补丁层装在认不出的引擎上"的探针，是同一个东西。
//
// ⚠️ 这条来源是一个**判断**，不是从契约推出来的：版本取自"启动本进程的那份安装的
// CLI 包"，不是引擎自报。理由与代价逐条写在文档 §诚实边界。
//
// ### 四项能力：一项真有来源，三项按**未确认**报
//
// `probe.mjs` 的判据是「必须**显式为 true**，缺失不算具备」。能力表里写 `false`
// 就是"未确认"（不是"引擎说不行"）。逐项：
//
//   · `structured-result`：**有**真来源。DSH 的 `ctx.get('subagents')` 是一张
//     **命名 provider 注册表**，每个 provider 自报 `capabilities.outputSchema`
//     （`packages/subagent/subagent/src/types.ts` 的 `SubagentCapabilities`），
//     而 `start()` 在派发前**真的按它拒收**。所以"这一次会用到的那个 provider
//     支不支持 outputSchema"是可以从现场读出来的。本模块读它：
//     注册表读不到 / 空 / 多于一个 provider（说不清会用哪一个）→ 一律**未确认**。
//   · `tool-permission-enforcement`：**未确认**。本产品里"按 `RunRequest.permissions`
//     约束工具与文件范围"就是 Legion 自己的补丁层（硬底线 guard / pre-execute 策略 /
//     审批应答者），而它是否生效由启动自检的 `composition-patch-layer` 与
//     `enforcement-mapping` 两项判定。探针**不把同一件事再判一遍**（两份判定会漂移），
//     所以这里报 false + 一个说得清"是谁在判"的码。
//   · `cancel-and-timeout`：**未确认**，而且理由是一条**已发生的生产故障**：
//     `runtime/adapters/dsh/port.mjs` 的文件头记着「subagent 可能挂死且
//     `run.result` 永不结算（abort 不保证杀死子代理）」——适配器的看门狗正是为它存在。
//     引擎契约（`SubagentRun.dispose` / `request.signal`）**声称**能取消；
//     仓库自己记录了它不保证。**不乐观**：这一项报未确认。
//   · `usage-reporting`：**未确认**。引擎一次性子代理的结果契约
//     （`SubagentResult`：`output` / `structured?` / `diagnostic?` / `stopReason`）
//     **没有**任何用量字段；而 `runtime/adapters/dsh/usage.mjs` 的 `collectUsage()`
//     读的是 `result.usage` / `result.tokenUsage` / `result.tokens`——这三个在真结果上
//     都不存在。所以一次 run 拿不回 token 用量：这一项报未确认。
//     （顺带量到的一条**相邻缺陷**：预算闸门（PRT-510）在生产路径上因此永远拿不到
//     token 数。本批**不修**它——它不属于这条缝；记在文档的诚实边界里。）
//
// ### `canRead`：**没有**合法来源 → 具名拒绝，不猜
//
// `canRead` 是"这一次 Attempt 能读哪些上下文来源"的**权限判定**。它的合法权威只有
// 一处：EmployeeManifest / lease 上的那次授权（`orchestrator/worker/context-stage.mjs`
// 的注释写明了这一点）。而本模块跑在 **DSH Runtime 进程**里，那个进程**只有**
// 身份 / hub 地址 / cwd / taskId / scope（`root.mjs` 从环境解析出来的那一份），
// 没有岗位清单、也没有 lease——lease 要等 worker 侧认领之后才存在。实测（真 DSH 进程、
// 一次性 `DSH_HOME`）：`ctx.get('canRead')` 那一类东西不存在，能看见的服务里
// **没有**任何权限来源。
//
// 所以默认工厂在**被调用时**抛 `RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE`，
// 而不是给一个"默认放行"或"默认拒绝"的替身：
//
//   · 默认放行 → 一次接线遗漏变成一次静默越权；
//   · 默认拒绝 → 一次接线遗漏变成一次静默停摆；
//   · **两者都不报错**，而"报不出来"正是这条缝上一批要修的东西。
//
// 这与强制面 plane 的口径同源（`hub = derivedHub ?? configuredFrom(ENV.hubUrl)`，
// **没有编出来的默认值**）：拿不到来源的名字，就以具名码拒绝。
//
// 注入点留给**知道答案的那一侧**（`createRuntimeHostInputsFactory({canRead})`，
// 形状与 `createRootRow({createRequestApproval})` 相同）：生产默认是拒绝，
// 用例可以显式注入一个替身来驱动其余接线。
//
// ## ★★ 本批量到的**更大的**一条：这条缝填上也不会改变部署读数
//
// `bindDshRuntime()` 注册进的是 `orchestrator/worker/executor-binding.mjs` 里一个
// **模块级 `bindingStack`**——它是**进程内**的。而 `productionExecutorProviderFromEnv()`
// 的生产调用点在 `product/orchestrator/worker.mjs`，那是**另一个进程**：
//
//     product/process-manifest.mjs:
//       key: 'runtime'      ← DSH 组合层在这里（本行也在这一侧）
//       key: 'orchestrator' ← entry: node-file product/orchestrator/worker.mjs（消费方在这里）
//       orchestrator.dependsOn: ['team-hub', 'runtime']
//
// 于是：**无论这个缝填得多好，另一个进程里的读者都看不到。** 上一批"绑定生效"的读数
// 是在**同一个 DSH 进程内**由一个探针行直接 import worker 侧那个模块读出来的——
// 那证明了这条链在**一个进程里**是通的，没有证明它在**部署的两个进程之间**通。
//
// 这条不是猜测：两侧都是读出来的（`bindingStack` 是模块级变量；进程清单里两个 key 分开）。
// 它意味着本批**不能**让 `runtimeHostRow` 变得可挂载，也意味着"最后一个生产环节"
// 缺的不只是一个端口工厂，还有**谁和谁在同一个进程里**这个前提。
// 详见 `docs/superpowers/prt/PRT-253-runtime-host-inputs.md` §诚实边界。
//
// ## ★ 为什么本行仍然**不进**静态补丁层（`PATCH_LAYER_ROWS`）
//
// 三条，任一条单独成立就够：
//
//   ① 探针**现在**会以"缺三项必需能力"判不兼容（这是诚实的读数），
//      于是挂上去 = 每一个 DSH Runtime 进程都起不来（PRT-214 文档 §9 读数 C 的形状）；
//   ② `canRead` 没有合法来源，工厂会以具名码拒绝——同样拦启动；
//   ③ 上面那条进程拓扑：挂上了也改不了 worker 进程的读数。
//
// 所以本模块**没有** `PATCH_LAYER_ROWS` 登记、**没有**进 `legion-host.patch.yml`、
// `DSH_COMPOSITION_PATCH_VERSION` **不变**、`render.mjs --write` **不跑**。
// 它今天是"可被挂载的生产注册方"，不是一个已挂载的部署件——这个区别写在文档里。
//
// ## 为什么它**没有**从 `runtime/dsh-composition/index.mjs` 出口
//
// 本模块在**模块求值期**注册工厂（这正是它安全的原因）。把它加进那个 barrel，
// 会让"import 一下出口"变成一次生产注册的副作用——包括在根本不跑 Runtime 的
// 进程里。补丁层是按**路径**加载这一行的模块的（与 `team-hub/approval-registrar-row.mjs`
// 完全一样），不经过 barrel；所以这里刻意不添那条出口。
// ============================================================================

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REQUIRED_CAPABILITIES } from '../../contracts/adapter.mjs'
import realRuntimeHostRow, { setDshRuntimeInputsFactory } from './runtime-host-row.mjs'

/** 改动来源、拒绝码或能力判据时递增。 */
export const RUNTIME_HOST_REGISTRAR_VERSION = 1

/** 本模块的具名码。每一个对应**一样具体的输入**，不是一个笼统的"注册失败"。 */
export const RUNTIME_HOST_REGISTRAR_CODES = Object.freeze({
  /** 工厂被调用时没有拿到 Cordis Context（要能 `ctx.get` 读现场服务）。 */
  NO_CONTEXT: 'RUNTIME_HOST_REGISTRAR_NO_CONTEXT',
  /** 进程里没有 `subagents` 服务（`startRun` 的**唯一**真来源）。 */
  NO_SUBAGENTS_PORT: 'RUNTIME_HOST_REGISTRAR_NO_SUBAGENTS_PORT',
  /** 能力表与 `REQUIRED_CAPABILITIES` 对不上（装载期就抛，不安静地少报一项）。 */
  CAPABILITY_TABLE_MISMATCH: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_TABLE_MISMATCH',
  /**
   * 没有任何 `canRead` 来源。
   *
   * **这就是那个"没有合法来源"的输入**：见文件头。它单列一个码，而不是与
   * `NO_SUBAGENTS_PORT` 合成一个"接线不对"——两者的修法完全不同：
   * 前者要去接权限权威（岗位清单 / lease），后者要去看引擎装没装上。
   */
  NO_CAN_READ_SOURCE: 'RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE',
})

/** 版本来源的具名码。"读到了"与"没读到"必须分得开。 */
export const DSH_VERSION_CODES = Object.freeze({
  /** 从现场安装里读到了版本。 */
  READ: 'RUNTIME_HOST_REGISTRAR_DSH_VERSION_READ',
  /** 有限层数内没有找到那份安装的 `package.json`。**不是**"版本是 0"。 */
  NOT_FOUND: 'RUNTIME_HOST_REGISTRAR_DSH_VERSION_NOT_FOUND',
  /** 找到了 `package.json` 但读不出一个非空字符串版本。 */
  MALFORMED: 'RUNTIME_HOST_REGISTRAR_DSH_VERSION_MALFORMED',
})

/**
 * 四项必需能力各自的**判据码**。
 *
 * 每一个都说明"这一项为什么是现在这个答案"，于是"未确认"不会与"引擎说不行"同形——
 * 前者要人去接来源，后者要人去换引擎。
 */
export const CAPABILITY_EVIDENCE_CODES = Object.freeze({
  /** 现场 provider 注册表确认支持 `outputSchema`。 */
  PROVIDER_REGISTRY_CONFIRMS: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_REGISTRY_CONFIRMS',
  /** 注册表在，但那个 provider 自报不支持 `outputSchema`。 */
  PROVIDER_LACKS_OUTPUT_SCHEMA: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_LACKS_OUTPUT_SCHEMA',
  /** 注册表读不到 / 是空的（引擎端口不在场）。 */
  PROVIDER_REGISTRY_ABSENT: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_REGISTRY_ABSENT',
  /** 注册了多于一个 provider：说不清这次会用哪一个，**不挑一个**。 */
  PROVIDER_REGISTRY_AMBIGUOUS: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_PROVIDER_REGISTRY_AMBIGUOUS',
  /** 强制面由 Legion 补丁层实现，生效与否由启动自检判定——探针不重复判一遍。 */
  ENFORCEMENT_PLANE_MEASURED_ELSEWHERE: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_ENFORCEMENT_PLANE_MEASURED_ELSEWHERE',
  /** 仓库记录了"abort 不保证杀死子代理"这条生产故障。 */
  CANCEL_NOT_GUARANTEED_BY_ENGINE: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_CANCEL_NOT_GUARANTEED_BY_ENGINE',
  /** 引擎的一次性结果契约里没有用量字段。 */
  RESULT_CONTRACT_HAS_NO_USAGE: 'RUNTIME_HOST_REGISTRAR_CAPABILITY_RESULT_CONTRACT_HAS_NO_USAGE',
})

/**
 * 哪些包名算"引擎的安装"。
 *
 * 两个都认：DSH 的 CLI 包是 `@deepseek-ai/dsh`（`apps/cli/package.json`，实测
 * version `0.1.5-rc.2`），根工作区是 `@deepseek-ai/dsh-root`。只认这两个，
 * 免得从 Legion 自己的 `package.json` 里读出产品的版本当成引擎版本——
 * 那会是一个"有依据样子"的错读数。
 */
export const DSH_PACKAGE_NAMES = Object.freeze(['@deepseek-ai/dsh', '@deepseek-ai/dsh-root'])

/** 向上找 `package.json` 的层数上界。有限，免得在一个异常路径上走到盘根。 */
export const DSH_VERSION_SEARCH_DEPTH = 8

function registrarError(code, message, extra = {}) {
  const err = new Error(`runtime-host-registrar 拒绝：${message}`)
  err.name = 'RuntimeHostRegistrarError'
  err.code = code
  Object.assign(err, extra)
  return err
}

/** `ctx.get(name)`——**读不到就是 undefined**（第二个参数是 strict，不是 fallback）。 */
function serviceOf(ctx, name) {
  return ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function'
    ? ctx.get(name)
    : undefined
}

// ───────────────────────────────────────────────────────────────────────────
// 版本：从**正在跑的那份安装**读
// ───────────────────────────────────────────────────────────────────────────

/** 一个候选路径 → 绝对路径（`file://` 名字要转回来；其余的路径原样）。 */
function candidatePath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const text = raw.trim()
  if (text.startsWith('file://')) {
    try {
      return fileURLToPath(text)
    } catch {
      return null
    }
  }
  return text
}

/** 从加载器树里取**字符串**模块名当候选（非字符串一律不猜）。 */
function loaderModuleNames(ctx) {
  const loader = serviceOf(ctx, 'loader')
  if (loader === null || typeof loader !== 'object' || typeof loader.entries !== 'function') return []
  const out = []
  try {
    for (const entry of loader.entries()) {
      const name = entry?.options?.name
      if (typeof name === 'string' && name !== '') out.push(name)
    }
  } catch {
    // 树读了一半抛错：不给部分结果——版本来源少一个候选不等于"读到了别的"。
    return []
  }
  return out
}

/**
 * 版本搜索的候选：**本进程的入口** + 加载器树里的模块名。
 *
 * `process.argv[1]` 是主候选，理由是实测的（文件头）：DSH 进程的入口就是那份安装里的
 * `apps/cli/lib/bin.js`。加载器树里那些 `file://` 行是**第二个**候选——
 * 在带 bundle 的真实部署里它们也指回同一份安装。
 */
export function dshInstallCandidates({ ctx = null, argvEntry = process.argv[1] } = {}) {
  const out = []
  const push = (p) => {
    if (p !== null && !out.includes(p)) out.push(p)
  }
  push(candidatePath(argvEntry))
  for (const name of loaderModuleNames(ctx)) push(candidatePath(name))
  return out
}

/**
 * 从候选路径向上找 DSH 安装的 `version`。
 *
 * 纯 fs 逻辑，可注入（用例拿它测"读到 / 读不到 / 读到畸形"三条分支）。
 *
 * @param {object} [o]
 * @param {string[]} [o.candidates] 候选**文件**路径（从它们的目录开始向上找）。
 * @param {(path: string) => string} [o.readTextFile] 读文本（默认 `readFileSync`）。
 * @param {number} [o.maxDepth] 向上层数上界。
 * @returns {{ok: boolean, code: string, version: string|null, packageName: string|null, source: string|null, searched: number, reason: string|null}}
 */
export function readDshVersionOfInstall({
  candidates = [],
  readTextFile = (p) => readFileSync(p, 'utf8'),
  maxDepth = DSH_VERSION_SEARCH_DEPTH,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  let searched = 0
  let sawPackageJson = false
  for (const raw of list) {
    if (typeof raw !== 'string' || raw === '') continue
    let current = resolve(raw)
    for (let depth = 0; depth <= maxDepth; depth += 1) {
      const dir = dirname(current)
      if (dir === current) break // 到根了
      const pkgPath = join(dir, 'package.json')
      searched += 1
      let text = null
      try {
        text = readTextFile(pkgPath)
      } catch {
        text = null // 这一层没有 package.json（或读不了）：继续向上，不猜
      }
      if (typeof text === 'string' && text !== '') {
        sawPackageJson = true
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = null
        }
        if (parsed !== null && typeof parsed === 'object' && DSH_PACKAGE_NAMES.includes(parsed.name)) {
          if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
            return {
              ok: false,
              code: DSH_VERSION_CODES.MALFORMED,
              version: null,
              packageName: parsed.name,
              source: pkgPath,
              searched,
              reason: `${pkgPath} 的 name 是 ${parsed.name}，但 version 不是一个非空字符串` +
                '——**不编一个版本**：一个编出来的版本会让兼容判定在一个认不出的引擎上给"可以跑"',
            }
          }
          return {
            ok: true,
            code: DSH_VERSION_CODES.READ,
            version: parsed.version,
            packageName: parsed.name,
            source: pkgPath,
            searched,
            reason: null,
          }
        }
      }
      current = dir
    }
  }
  return {
    ok: false,
    code: DSH_VERSION_CODES.NOT_FOUND,
    version: null,
    packageName: null,
    source: null,
    searched,
    reason: `在 ${list.length} 个候选路径的 ${maxDepth} 层之内` +
      `${sawPackageJson ? '没有找到 name 属于 ' + JSON.stringify([...DSH_PACKAGE_NAMES]) + ' 的 package.json' : '没有读到任何 package.json'}` +
      '——探测据此报 `version: null`，而版本读不出来按**不兼容**处理' +
      '（「读不到」不等于「没问题」）',
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 四项能力：一项读现场注册表，三项按**未确认**报
// ───────────────────────────────────────────────────────────────────────────

/**
 * 现场 provider 注册表里**那一个** provider 的 `outputSchema` 支持。
 *
 * 为什么"多于一个就报未确认"而不是挑第一个：`runtime/adapters/dsh/index.mjs` 派发时
 * 用的是 `RunRequest` 里那个 provider 名，而探针**拿不到那一次请求**。
 * 挑一个等于替调用方猜"你会用谁"——猜对了没有功劳，猜错了就是一条
 * "有依据样子"的错误能力表。
 */
function structuredResultEvidence(ctx) {
  const registry = serviceOf(ctx, 'subagents')
  if (registry === null || typeof registry !== 'object'
    || typeof registry.list !== 'function' || typeof registry.getProvider !== 'function') {
    return {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_ABSENT,
      source: null,
      reason: '进程里读不到子代理 provider 注册表（`subagents` 服务不在或形状不对）：' +
        '说不清这次会用哪一个 provider，因此这一项报**未确认**，而不是 true',
    }
  }
  let names = null
  try {
    names = registry.list()
  } catch {
    names = null
  }
  if (!Array.isArray(names) || names.length === 0) {
    return {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_ABSENT,
      source: null,
      reason: '子代理 provider 注册表是空的（或 `list()` 没有返回数组）：没有 provider 可以支持 ' +
        '`outputSchema`，这一项报未确认',
    }
  }
  if (names.length > 1) {
    return {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_AMBIGUOUS,
      source: null,
      reason: `注册了 ${names.length} 个 provider（${names.join(', ')}）：探针拿不到那一次请求会用哪一个，` +
        '**不挑一个**，这一项报未确认',
    }
  }
  const name = names[0]
  let provider = null
  try {
    provider = registry.getProvider(name)
  } catch {
    provider = null
  }
  const advertised = provider?.capabilities?.outputSchema
  if (advertised !== true) {
    return {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.PROVIDER_LACKS_OUTPUT_SCHEMA,
      source: `subagents.getProvider(${JSON.stringify(name)}).capabilities.outputSchema`,
      reason: `现场唯一的 provider ${JSON.stringify(name)} 没有把 outputSchema 报成 true` +
        `（读到 ${JSON.stringify(advertised)}）：引擎的 start() 会据此**拒收**带 schema 的请求，` +
        '所以这一项报未确认',
    }
  }
  return {
    satisfied: true,
    code: CAPABILITY_EVIDENCE_CODES.PROVIDER_REGISTRY_CONFIRMS,
    source: `subagents.getProvider(${JSON.stringify(name)}).capabilities.outputSchema`,
    reason: null,
  }
}

/**
 * 四项必需能力**逐项**的根据。
 *
 * @returns {{capabilities: object, evidence: object}}
 *   `capabilities` 是 `probe.mjs` 要的布尔表（只有显式 true 才算具备）；
 *   `evidence` 是逐项的判据码与来源说明，给运维与人读。
 */
export function runtimeCapabilityEvidence(ctx) {
  const structured = structuredResultEvidence(ctx)
  const evidence = {
    'structured-result': structured,
    'tool-permission-enforcement': {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.ENFORCEMENT_PLANE_MEASURED_ELSEWHERE,
      source: 'runtime/dsh-composition/selfcheck.mjs 的 composition-patch-layer / enforcement-mapping',
      reason: '本产品里"按 RunRequest.permissions 约束工具与文件范围"由 Legion 自己的补丁层' +
        '（硬底线 guard / pre-execute 策略 / 审批应答者）实现，生效与否由启动自检那两项判定。' +
        '探针**不把同一件事再判一遍**（两份判定会漂移），所以这里报未确认',
    },
    'cancel-and-timeout': {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.CANCEL_NOT_GUARANTEED_BY_ENGINE,
      source: 'runtime/adapters/dsh/port.mjs 文件头记录的生产故障',
      reason: '引擎契约声称 `request.signal` / `run.dispose()` 会终止执行，而本仓库记录了相反的现场事实：' +
        '「subagent 可能挂死且 run.result 永不结算（abort 不保证杀死子代理）」。' +
        '适配器的看门狗正是为它存在——**不乐观**，这一项报未确认',
    },
    'usage-reporting': {
      satisfied: false,
      code: CAPABILITY_EVIDENCE_CODES.RESULT_CONTRACT_HAS_NO_USAGE,
      source: 'DSH SubagentResult 契约（output / structured? / diagnostic? / stopReason）',
      reason: '引擎一次性子代理的结果契约里**没有**任何用量字段，而 ' +
        '`runtime/adapters/dsh/usage.mjs` 的 `collectUsage()` 读的是 result.usage / tokenUsage / tokens。' +
        '一次 run 拿不回 token 用量：这一项报未确认',
    },
  }

  const capabilities = {}
  for (const name of REQUIRED_CAPABILITIES) {
    capabilities[name] = evidence[name]?.satisfied === true
  }
  return { capabilities, evidence }
}

/**
 * 装载期检查：能力表**恰好**覆盖产品的必需清单。
 *
 * 与 `root-row.mjs` 的 `NONE_SHORTCUT_CHECKED` 同一条理由：靠契约的东西要在装载期
 * 测一遍。`REQUIRED_CAPABILITIES` 加一项而本模块没跟上时**当场抛**，
 * 而不是安静地少报一项——后者会让探针在缺一项能力时仍然报 ok。
 */
export function assertCapabilityTableComplete() {
  const known = Object.keys(runtimeCapabilityEvidence(null).evidence)
  const missing = REQUIRED_CAPABILITIES.filter((c) => !known.includes(c))
  const extra = known.filter((c) => !REQUIRED_CAPABILITIES.includes(c))
  if (missing.length > 0 || extra.length > 0) {
    throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.CAPABILITY_TABLE_MISMATCH,
      `能力表与 REQUIRED_CAPABILITIES 不一致（少：${missing.join(', ') || '无'}；多：${extra.join(', ') || '无'}）。` +
      '少报一项会让探针在缺能力时仍然可能报 ok——这条契约必须在装载期就对上')
  }
  return true
}

/** 装载期结论（`true`；不成立就抛）。 */
export const CAPABILITY_TABLE_CHECKED = assertCapabilityTableComplete()

// ───────────────────────────────────────────────────────────────────────────
// 探针
// ───────────────────────────────────────────────────────────────────────────

/**
 * `probeRuntime()` 的实现：报**从现场读到**的版本与能力表。
 *
 * 形状是 `runtime/adapters/dsh/port.mjs` 的端口契约要的那个：
 * `{ version, capabilities }`。额外的 `versionEvidence` / `capabilityEvidence`
 * 是给运维与人读的判据——`probe.mjs` 只读 `version` 与 `capabilities`，
 * 多出来的键不影响它的判定（也就不会把判据码混进布尔表）。
 */
export function probeDshRuntime(ctx, { readVersion = readDshVersionOfInstall, argvEntry } = {}) {
  const versionReading = readVersion({
    candidates: dshInstallCandidates(argvEntry === undefined ? { ctx } : { ctx, argvEntry }),
  })
  const { capabilities, evidence } = runtimeCapabilityEvidence(ctx)
  return {
    version: versionReading.ok === true ? versionReading.version : null,
    capabilities,
    versionEvidence: versionReading,
    capabilityEvidence: evidence,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 工厂：生产默认**拒绝**（canRead 没有合法来源），注入点是给知道答案的那一侧
// ───────────────────────────────────────────────────────────────────────────

/**
 * 造一个 `setDshRuntimeInputsFactory()` 认的工厂：`(ctx) => ({runtimeHost, canRead})`。
 *
 * ## 为什么工厂收 `ctx`
 *
 * `runtime-host-row.mjs` 在**它自己的 `apply` 期**调工厂，并把那个 Context 交进来。
 * 少了它，工厂只能靠一个全局 Context 或者靠模块求值期的现场——前者是隐式依赖，
 * 后者在 DSH 里根本不存在（模块求值期还没有树）。这是本批对上一批契约的**唯一**
 * 一处扩展，方向与上一批文件头写的那句一致：「工厂在本行 `apply` 时被调用：
 * 它需要 DSH 进程的现场」——现在它**真的**拿得到现场。
 *
 * 零参工厂（上一批的用例形状）不受影响：多传一个参数，JS 会忽略。
 *
 * ## 为什么 `canRead` 默认是拒绝
 *
 * 见文件头。生产默认 = **没有合法来源 → 具名拒绝**；
 * 知道答案的那一侧（岗位清单 / lease 的持有者）用 `createRuntimeHostInputsFactory({canRead})`
 * 显式给。
 */
export function createRuntimeHostInputsFactory({
  canRead = null,
  probe = probeDshRuntime,
  readVersion = readDshVersionOfInstall,
} = {}) {
  if (canRead !== null && typeof canRead !== 'function') {
    throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE,
      `canRead 要么是一个函数，要么是 null（表示"没有来源"），收到 ${typeof canRead}。` +
      '一个"注册了个空的"与"明确没有来源"必须在读数上分得开')
  }
  return function runtimeHostInputsFactory(ctx) {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') {
      throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.NO_CONTEXT,
        `工厂需要一个 Cordis Context（要能 \`ctx.get\` 读现场服务），收到 ${ctx === null ? 'null' : typeof ctx}`)
    }

    const subagents = serviceOf(ctx, 'subagents')
    if (subagents === null || typeof subagents !== 'object' || typeof subagents.start !== 'function') {
      throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.NO_SUBAGENTS_PORT,
        '进程里没有可用的 `subagents` 服务（`start(provider, request)` 不在）。' +
        '它是 `startRun` 的**唯一**真来源——编一个"能返回结果的 startRun"就是伪造执行引擎')
    }

    if (typeof canRead !== 'function') {
      throw registrarError(RUNTIME_HOST_REGISTRAR_CODES.NO_CAN_READ_SOURCE,
        '没有任何 `canRead` 来源：这次的上下文能读哪些来源，权威在 EmployeeManifest / lease 上，' +
        '而 DSH Runtime 进程里两者都不在（它只有身份 / hub 地址 / cwd / taskId / scope）。' +
        '**不猜**——默认放行会让一次接线遗漏变成一次静默越权，默认拒绝会让它静默停摆，' +
        '两者都不报错。把来源交进来：`createRuntimeHostInputsFactory({ canRead })`')
    }

    const runtimeHost = Object.freeze({
      // 真来源：引擎的 subagents 服务。**不包一层**，按引用转发，
      // 于是"端口连的是谁"与"引擎是谁"是同一个对象——多包一层就会有一个会漂移的替身。
      startRun: (provider, options) => subagents.start(provider, options),
      probeRuntime: () => probe(ctx, { readVersion }),
    })

    return { runtimeHost, canRead }
  }
}

/**
 * ★ 注册发生在**模块求值期**——与 `team-hub/approval-registrar-row.mjs` 同一个形状。
 *
 * 补丁层按路径加载本模块时拿到的是本模块的 default；Node 的 ESM 语义保证
 * 被 import 的模块先求值完，才轮到 import 它的那个模块——也就必然先于挂载那个
 * 插件的 Fiber 的 `apply`。所以无论 Loader 并发创建多少行、无论别的行挂起多久，
 * `setDshRuntimeInputsFactory()` 都已经执行过了。
 *
 * 生产默认**没有** `canRead` → 被调用时以 `NO_CAN_READ_SOURCE` 拒绝。
 * 这不是"什么都没注册"：注册了、并且**拒绝得出来**，这两件事在读数上分得开。
 */
export const registeredRuntimeHostInputsFactory = createRuntimeHostInputsFactory()

/** `setDshRuntimeInputsFactory()` 给的那次注销（幂等；只撤掉**自己**那一次注册）。 */
const undoRegistration = setDshRuntimeInputsFactory(registeredRuntimeHostInputsFactory)

/** 撤销上面那次注册（用例专用：反向对照要在同一进程里做）。 */
export function unregisterRuntimeHostInputsFactory() {
  undoRegistration()
}

/**
 * ★ 默认导出就是**真的那个** `runtime-host-row` 插件对象（`===`，不是形状相同的替身）。
 *
 * 补丁层里的行 id 与插件名仍然是 `legion-runtime-host`：换掉的只是
 * "这一行的模块从哪里加载"，挂载审计读的那两个字段一字未改。
 */
export default realRuntimeHostRow
