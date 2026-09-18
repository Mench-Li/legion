// runtime/dsh-composition/run-floor.mjs
// ============================================================================
// PRT-214 缺口①的**安装点**：把一次 Run 的静态 hard floor 装到**那个 Run 的 Agent** 上。
//
// ## 这一格此前缺的是什么
//
// `bootstrapDshRuntime({floor})` 从第一天起就接受一份下限，`assembleEnforcement()`
// 把它转给 `createEnforcementBridge()`，`plugins/hard-floor.mjs` 把它接到
// `ctx.tools.guard()`。也就是说**这一整条链是通的，只有一件事没通**：
// 那份下限只能由**本进程**的装配方（补丁层 / `installEnforcementRoot`）给出。
//
//   `git grep denyTools` 在生产代码里只有一个生产者（`team-hub/run-floor.mjs`，
//   纯函数、零 IO、**没有任何生产调用方**），而它的产物**没有一条路**进到
//   执行面那个进程里、更没有办法**按 Run** 装。
//
// 于是今天部署里实际生效的，是 `plugins/hard-floor.mjs` 那一行的默认值
// （`DEFAULT_HARD_FLOOR`，**空**）。spec §6.8 `:437-440` 要求的那三样东西里，
// 「Run 权限档位」早就在 `RunRequest.permissions` 上过线，「静态 hard floor」没有。
//
// ## 为什么安装点是「那个 Agent 自己的 Cordis 作用域」
//
// 装配级（`assembleEnforcement({floor})` 那一层）是**进程级**的：一个进程只装一次，
// 而 Runtime 进程是**长命的**、会服务很多次 Run（`runtime-contract-server.mjs` 的
// `handleExecute` 每次请求都调 `adapter.execute(request)`）。所以装配级的下限必然
// 等于"第一个 Run 的下限"，而它会被后面每一个 Run 继承：
//
//   > 一个「用第一次 Run 的下限服务所有 Run」的实现，
//   > 与一个「每次 Run 都按这次的下限拒绝」的实现，
//   > 在只有一个 Run 的那些用例里是同一个东西——
//   > 只不过前者会让第二个 Run 继承第一个 Run 的规则。
//
// 「每次 Run」要求下限有一个**按 Run 分开**的落点。这里能选的落点有两个族：
//
//   · **Agent 自己的作用域**（本模块选的）：DSH 的 `ctx.tools.guard()` 文档逐字写着
//     「a plain-context guard applies globally; one registered through `agent.ctx`
//     applies only to that agent」（`packages/core/tools/src/index.ts:1092`），
//     而 `tools/pre-execute` 的瀑布也按 `scopeTarget(this, exec.agent)` 派发
//     （同文件 `:1464-1466`）。一次 Run 的目标 Agent 恰好只有一个，于是"按 Run 分开"
//     与"按 Agent 分开"在这里是同一件事——而且是**构造上**同一件事，不是靠纪律。
//   · **Agent preset / 会话级挂载**：spec §6.9 `:500` 明确禁止——preset 可替换、
//     可扩展、可被 shadow，把不可绕过的下限放进去等于让下限取决于当前挂了哪个 preset。
//
// 而 Agent 的作用域**不是** preset：它是这次 Run 的目标 Agent 自己的运行期作用域，
// 由引擎在派生子 agent 时建立，Run 结束即回收。装在这里的下限：
//
//   · 只影响这个 Agent（及它的后代——guard 沿作用域链查，`guardReason()` 同文件 `:1108`）；
//   · 第二个 Run 是另一个 Agent ⇒ 另一份下限，**不可能**继承第一个 Run 的规则；
//   · 不改变 `runtime/dsh-composition/` 的装配形状，也不动进程拓扑。
//
// ## ★ 两个面用**同一个** guard 调用结果（这条件不是风格）
//
// spec §6.8 `:456` 要求下限同时落在 `tools/pre-execute`（提前拒绝，避免无效询问）
// 与 `ctx.tools.guard()`（最终复核）两处；`:486` 又要求"任何已被 pre-execute 放行
// 且获得 `allowed-once` 的调用，不得再被 guard 拒绝"。两条合起来只有一个解：
// **两处必须共用同一个 `createHardFloorGuard` 调用结果**——否则我们亲手造出
// §6.8 `:479` 抱怨的那种审计：「人工已批准但仍被 guard 拒绝」，而它没有修复动作。
//
// 所以本模块装的是**一个** `guard` 函数，两个面都指向它：
//
//   tools/pre-execute  →  guard(exec) 非 undefined ⇒ deny（认领）；否则 next()（让路）
//   tools.guard()      →  同一个 guard
//
// ## ★ 为什么 pre-execute 那一侧要 `prepend`
//
// 瀑布是"谁先返回非 `next()`，谁就认领"（`cordis/lib/index.js:317-325`：
// listeners run outermost-first）。Legion 的策略门（`root-row.mjs` 那条
// `tools/pre-execute`）是在**启动期**注册的；本模块的 listener 是在 Run 开始时
// 才注册的，按插入顺序天然排在后面——于是"注定被下限拒绝的调用"会**先**进策略门，
// 被问一次人，然后再被 guard 拒。那正是 `composePreExecuteFloor()` 的注释里
// 点名要避免的东西。
//
// `ctx.on(name, listener, options)` 收 `{prepend: true}`（同文件 `:336`：
// `options.prepend ? "unshift" : "push"`），于是本 listener 排到**最前**，
// 同一份下限的拒绝发生在任何动态判定之前。这一条**不能靠读代码断言**——
// 真进程里用"策略门被调了几次"来读它（见 run-floor-dsh-process.test.mjs）。
//
// ## 三种处境各有各的处置（`absent` 与 `refused` 都拒绝一切，理由不同）
//
// 本模块把"这次 Run 的下限"读成三态（形状判定在 `../contracts/run-floor.mjs`），
// 每一态的落法都不同：
//
//   · `installed` —— 装的就是控制面给的那份下限，原样。
//   · `absent`    —— 没给下限。装**拒绝一切**的 guard：这是 spec §6.8 `:479` 的
//                    **发布前姿态**（完成 DSH 强制面接线前）。理由不是一句判断，
//                    而是一条可查的**名字空间事实**：静态下限比的是**执行面的工具名**
//                    （`createHardFloorGuard()` 只看 `execution.name`），而 Legion
//                    派生出来的那些名单（`PRE_WIRING_HARD_FLOOR`、
//                    `HARD_FLOOR_CAPABILITIES`、`HIGH_RISK_TOOL_NAMES`）写的是**能力名**。
//                    两个名字空间不相交——把那九个当禁名单装进来，**一个真工具名也拦不住**。
//                    而名字名单本身**不是** fail closed 的（不在名单里的一律放行），
//                    所以接线完成前唯一 fail closed 的姿态是拒绝。
//   · `refused`   —— 有一份、但读不懂。装的**也是**拒绝一切，理由完全不同：
//                    连"哪些是高风险的"都不知道，猜一个"按高风险禁"是假装读懂了。
//
//   > 一个「拿 Legion 的能力名去比对执行面的工具名」的下限，
//   > 与一个「名字空间对得上、于是真的拦住了高风险工具」的下限，
//   > 在用例只喂 Legion 名字的那些日子里是同一个东西（手写的 probe 都能被拒）——
//   > 只不过真工具名进来时，前者一个都拦不住，却在摘要里看起来在执行 §6.8:479。
//
// ## 安装不上的时候：**拒绝**，不降级
//
// 目标 Agent 的作用域里没有 `ctx.tools.guard`、没有 `ctx.on`、或者引擎交回来的
// 不是 in-process 子 Agent（远程 provider 的 `localAgent === undefined`）时，
// 下限**装不上**。此时唯一安全的处置是**不让这个 Run 起跑**（具名码），
// 因为"装不上但照跑"就是我们正要消灭的那个读数：
//
//   > 一个「下限没装上、于是这次调用没人管」的实现，
//   > 与一个「下限装上了、名单恰好为空」的实现，在工具真的跑起来时是同一个东西——
//   > 只不过后者的空名单是一个陈述，前者是一次接线遗漏。
// ============================================================================

import {
  RUN_FLOOR_CODES,
  RUN_FLOOR_PORT_STATES,
  RUN_FLOOR_STATES,
  RUN_FLOOR_WIRE_VERSION,
  readRunFloor,
} from '../contracts/run-floor.mjs'
import { createHardFloorGuard } from './enforcement.mjs'

/** 安装方式或读法变化时递增。 */
export const RUN_FLOOR_INSTALL_VERSION = 1

/** 安装点的**构造期/安装期**失败码。闭集：每种修法不同。 */
export const RUN_FLOOR_INSTALL_CODES = Object.freeze({
  /** 端口载荷不是对象。 */
  NOT_AN_OBJECT: 'RUN_FLOOR_INSTALL_NOT_AN_OBJECT',
  /** 端口载荷的 `state` 不在闭集里（`installed` / `absent`）。 */
  UNKNOWN_STATE: 'RUN_FLOOR_INSTALL_UNKNOWN_STATE',
  /** 端口载荷上有我不认识的键。 */
  UNKNOWN_KEY: 'RUN_FLOOR_INSTALL_UNKNOWN_KEY',
  /** `state: 'installed'` 却没给 `floor`，或它解释不通。 */
  MISSING_FLOOR: 'RUN_FLOOR_INSTALL_MISSING_FLOOR',
  /** 要装的那个 Agent 没有自己的 Cordis 作用域。 */
  NO_AGENT_CONTEXT: 'RUN_FLOOR_INSTALL_NO_AGENT_CONTEXT',
  /** 那个作用域里没有 `tools.guard`——最终复核没有落点。 */
  NO_GUARD_SEAM: 'RUN_FLOOR_INSTALL_NO_GUARD_SEAM',
  /** 那个作用域里没有 `ctx.on`——提前拒绝没有落点。 */
  NO_EVENT_SEAM: 'RUN_FLOOR_INSTALL_NO_EVENT_SEAM',
})

// ★ 这里**没有**"引擎交回的不是 in-process 子 Agent"那个码，尽管文件头把它列为一种处境。
// 理由与 `runtime/contracts/run-floor.mjs` 去掉 `PATH_PREFIX_NOT_IDEMPOTENT` 完全相同：
// 那个条件**不在这一层判**——`installRunFloorIntoAgent` 拿到的已经是一个 Agent 对象，
// "引擎根本没交回 Agent"（远程 provider 的 `localAgent === undefined`）是在**端口**那一层
// （`plugins/runtime-host-registrar-row.mjs` 的 `startRun`）先判掉的，用的是
// `RUNTIME_HOST_REGISTRAR_FLOOR_NOT_INSTALLABLE`，并把 provider 名字与内层 `e.code`
// 一起写进理由。在这一层再声明一个永远产生不了的码，只会让读者以为它也查过。
//   > 一条声明了、却没有任何代码会产生的拒绝码，比没有这个码更坏。

/**
 * 适配器交给端口的**已解析**载荷状态。
 *
 * 它的**定义**在 `../contracts/run-floor.mjs`（那一层是 Legion 自己的边界形状，
 * 适配器与宿主端口两侧都要用同一个闭集）；这里只把它转出去，
 * 让 `runtime/dsh-composition/` 的读者不必跨目录找名字。
 */
export { RUN_FLOOR_PORT_STATES }

/** 端口载荷允许出现的键。**闭合**：多一个就拒（同 `readRunFloor` 的理由）。 */
export const RUN_FLOOR_PORT_KEYS = Object.freeze(['state', 'floor', 'notices'])

/** 装到 Agent 作用域上的两个面。`pre-execute` 在前，`guard` 在后。 */
export const RUN_FLOOR_SURFACES = Object.freeze(['tools/pre-execute', 'tools.guard'])

/**
 * 适配器→宿主端口那一层的选项名（`startRun(provider, { enforcementFloor })`）。
 *
 * 它属于**Legion 自己的端口契约**（`runtime/adapters/dsh/port.mjs` 的文件头），
 * 不在 DSH 的 `SubagentStartRequest` 里——所以它由 Legion 两侧同时定义：
 * 适配器写，宿主端口的 wrapper 读。
 */
export const RUN_FLOOR_RUN_OPTION_KEY = 'enforcementFloor'

/**
 * ★ 下限**随子 Agent 的创建请求**一起走的那个键（放在 `agentOptions` 里）。
 *
 * ## 为什么必须让它跟着创建请求走，而不是"起跑之后再装"
 *
 * 引擎发布子 Agent 的顺序是：`agents.create()`（内部 `setup` → `agent/created`）
 * → `create()` 返回 → `drivePublishedRun()` 里 `child.followup(prompt)` 启动第一轮
 * （`subagent-in-process-driver/src/index.ts:122-152,178-183`）。
 * 也就是说**第一轮在 `start()` 结算之前就已经开始了**——"拿回句柄之后立刻装"
 * 落在第一轮开始之后，两者的先后只由微任务队列决定：
 *
 *   > 一个"靠'模型总得先花一次往返'来保证下限先装上的"实现，
 *   > 与一个"下限真的先装上"的实现，在真模型上永远看不出区别——
 *   > 只不过前者在任何一个还能同步结算的 provider 上会先放行一次工具调用。
 *
 * 于是下限走 `agentOptions`：`resolveChildAgentOptions()` 把 `requested` 原样摊开
 * （`subagent/src/child-agent.ts:113`），`ReactLoopAgent` 把它收成 `agent.options`
 * （`agent-loop/src/agent.ts:99`），而 Legion 的 `agent/created` 监听器在**创建窗口内**
 * 就把它装到那个 Agent 的作用域上——那发生在 `followup()` 之前，是**顺序**保证，
 * 不是时序侥幸。
 *
 * 顺带解决"哪一次 Run"这个身份问题：`agent.options[KEY]` 就是端口这次传进去的
 * **那个对象本身**（`...requested` 是引用展开，不是深拷贝），而父级继承不会复制它
 * （同函数 `:108-115` 只逐字段取 provider/model/reasoningEffort/maxTokens）。
 * 于是按**对象身份**配对是精确的：并发两个 Run 各带各的载荷，不可能串台；
 * 长命父级的第二个 Run 也不可能继承第一个 Run 的下限。
 */
export const RUN_FLOOR_CHILD_OPTION_KEY = 'legionRunFloor'


function installError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 读适配器交给端口的已解析载荷。
 *
 * `state: 'installed'` 时，`floor` 的形状**不在这里另写一份检查**：它被重新包成
 * 一份线上下限载荷交给 `readRunFloor()`——于是"什么算一份合法下限"全仓库只有一处定义。
 * `notices` 同理一起借过去：告诫的形状判定也只有那一道，本层不抄第二份。
 *
 * @param {unknown} payload
 * @returns {{state: string, floor: object|null, notices: readonly object[],
 *            code: string|null, message: string|null}}
 */
export function readRunFloorPortPayload(payload) {
  const refuse = (code, message) => Object.freeze({
    state: RUN_FLOOR_STATES.REFUSED, floor: null, notices: Object.freeze([]), code, message,
  })
  if (!isPlainObject(payload)) {
    return refuse(RUN_FLOOR_INSTALL_CODES.NOT_AN_OBJECT,
      `端口上的下限载荷必须是对象，收到 ${payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload}`)
  }
  for (const key of Object.keys(payload)) {
    if (!RUN_FLOOR_PORT_KEYS.includes(key)) {
      return refuse(RUN_FLOOR_INSTALL_CODES.UNKNOWN_KEY,
        `端口上的下限载荷有我不认识的键 ${JSON.stringify(key)}（只认识 ${RUN_FLOOR_PORT_KEYS.join(' / ')}）。`
        + '忽略它等于猜它是装饰，而猜错的代价落在安全侧')
    }
  }
  if (payload.state === RUN_FLOOR_PORT_STATES.ABSENT) {
    if (payload.floor !== undefined) {
      return refuse(RUN_FLOOR_INSTALL_CODES.MISSING_FLOOR,
        '端口上的下限载荷说 state 是 absent，却又带了一份 floor——"没有"与"有一份、只是它不生效"必须分得开')
    }
    return Object.freeze({
      state: RUN_FLOOR_STATES.ABSENT,
      floor: null,
      notices: Object.freeze([]),
      code: RUN_FLOOR_CODES.NOT_SUPPLIED,
      message: '这次 Run 没有下限（`enforcementFloor` 不在 RunRequest 上）',
    })
  }
  if (payload.state !== RUN_FLOOR_PORT_STATES.INSTALLED) {
    return refuse(RUN_FLOOR_INSTALL_CODES.UNKNOWN_STATE,
      `端口上的下限载荷 state 是 ${JSON.stringify(payload.state)}，本实现只认识 `
      + `${JSON.stringify(Object.values(RUN_FLOOR_PORT_STATES))}`)
  }
  // 借用线上那一份形状判定（**同一份实现**，不是抄一份）——`floor` 与 `notices` 一起。
  const asWire = readRunFloor({
    version: RUN_FLOOR_WIRE_VERSION, derived: true, floor: payload.floor, notices: payload.notices,
  })
  if (asWire.state !== RUN_FLOOR_STATES.INSTALLED) {
    // 措辞要覆盖**两个**被借去检查的字段，否则一条形状坏掉的 `notices` 会被
    // 读成"floor 解释不通"，排障的人会去看那份下限（它其实是对的）。
    return refuse(RUN_FLOOR_INSTALL_CODES.MISSING_FLOOR,
      `端口上的下限载荷说 state 是 installed，但其中的 floor 或 notices 解释不通（${asWire.code}）：${asWire.message}`)
  }
  return Object.freeze({
    state: RUN_FLOOR_STATES.INSTALLED,
    floor: asWire.floor,
    notices: asWire.notices,
    code: null,
    message: null,
  })
}

/**
 * 造一次 Run 的下限装置：**一个** guard + 它的归属读数。
 *
 * 三种处境，**三种不同的处置**（这是本模块存在的全部理由）：
 *
 *   · `installed` —— 装的就是这次 Run 给的那份下限，原样。
 *   · `absent`    —— **没有下限**。装的是 spec §6.8 `:479` 的**发布前姿态**：
 *                    **拒绝一切**工具调用。这一档一度被写成"按 Legion 的高风险名单
 *                    禁掉九个"——那份实现本身写得很好、也被测过，但它**在这个 guard 上
 *                    拦不住任何真工具**，因为两个名字空间不相交（见下）。
 *   · `refused`   —— **有一份、但读不懂**。装的**也是拒绝一切**，理由不同：连
 *                    "哪些是高风险的"都不知道，猜一个"按高风险禁"就是假装读懂了。
 *
 * ## 为什么 `absent` 只能是"拒绝一切"（而不是"按高风险名单禁"）
 *
 * spec §6.8 `:479` 的原文是「legacy 路径在完成 DSH 强制面接线前**禁止高风险工具**」。
 * 一个**名字**名单要满足它，前提是名单里的名字与 `execution.name` 处在同一个空间。
 * 这里不是：
 *
 *   · 名单写的是 Legion 的**能力名**（`read-secret` / `run-command` / …）；
 *   · guard 比的是执行面的**工具名**（`write` / `read` / `pwsh` / …）；
 *   · 九个高风险能力里**六个是宿主平面能力**，根本没有执行面的工具名；
 *     剩下三个（`run-command` / `git-commit` / `git-push`）都塌在 shell 那一对名字上，
 *     而**低风险**的 `git-status` 也用那一对——按名字禁连"禁高风险、放低风险"这个
 *     粒度都表达不出来。
 *
 * 于是"按名单禁"的实际读数是：拒绝集 = 名单 ∩ 真工具名 = **空集**。它看起来在执行
 * §6.8:479（名单非空、`denyTools` 计数是 9、单源用例也绿），实际上一个真工具都没拦。
 *
 *   > 一个「按 Legion 能力名名单禁」的处置，
 *   > 与一个「名字空间对得上、于是真的禁住了高风险工具」的处置，
 *   > 在用例只喂 Legion 名字的那些日子里是同一个东西（手写的 probe 都能被拒）——
 *   > 只不过真工具名进来时，前者放行一切，而它在摘要里是绿的。
 *
 * 名字名单**不是** fail closed 的：不在名单里的一律放行，而"所有真工具名都不在名单里"
 * 这个事实不会让任何一条断言变红。§6.8:479 要的是"禁止高风险工具"——**过度禁止满足它，
 * 而"看起来在禁、实际一个真工具都没拦住"不满足**。所以接线完成前这一档就是拒绝一切；
 * 接线完成（下限能过线）之后由 `installed` 那一档按**真名单**放行。
 *
 * ## 为什么 `refused` **也**必须拒绝一切（另一半）
 *
 * 「给了一份下限、但我读不懂」时，我连"哪些是高风险的"都不知道。此时猜一个
 * "按高风险禁"就是**假装读懂了**：那份读不懂的载荷完全可能是"只禁三个"或者
 * "一个都不禁"的另一种形状，而按高风险禁会把它的意图替我说死。
 *
 *   > 一个「读不懂就按我猜的高风险禁」的处置，
 *   > 与一个「读懂了、而它恰好只要禁那九个」的处置，在工具真的跑起来时是同一个东西——
 *   > 只不过前者把一个**接线错误**伪装成了一份**政策**。
 *
 * 两档的**处置**一样（都拒绝），**理由**不一样：理由里带的是不同的码与不同的事实，
 * 于是审计读得出"这是一次接线遗漏之上的发布前姿态"还是"这是一份读不懂的载荷"。
 *
 * ## 为什么是"拒绝工具调用"而不是"拒收这次 Run"
 *
 * `absent` 的处置是一个判断，不是从两边契约推出来的：今天**没有任何生产调用方**
 * 生产这份下限（`deriveRunFloor()` 一个调用点都没有），若把缺席升级成"整个 Run
 * 拒收"，那会让每一次 Run 都失败——那是另一个政策，而且它会把"下限的搬运还没接线"
 * 表现成"产品起不来了"。所以选"工具一个都跑不了"这一档：它保住 `:479` 的禁止，
 * 又不把一次接线遗漏伪装成一次运行期崩溃。**这条选择写在报告里，不藏在代码里。**
 *
 *   ⚠️ **2026-09-18 订正：上面那句"今天没有任何生产调用方生产这份下限
 *   （`deriveRunFloor()` 一个调用点都没有）"**已过期**。** 它现在**有**生产调用路径：
 *   `product/orchestrator/worker.mjs:18`（生产装配点）→
 *   `orchestrator/worker/executor.mjs:386`（对**每一个**请求）→
 *   `:868` 的 `deriveRunFloor()`。原文保留。
 *   ★ 本节**结论**（选"拒绝工具调用"而不是"拒收这次 Run"）**没有被本轮改动**：
 *   前提过期不等于结论就错，而"结论是否仍然成立"是一次**新的裁决**，属于这条政策的
 *   所有者。本轮只记下前提过期，并给出可核的调用链。
 *
 * @param {unknown} payload 适配器交给端口的已解析载荷
 * @returns {{state: string, code: string|null, message: string|null, floor: object|null,
 *            guard: Function, denyTools: number, denyPathPrefixes: number}}
 */
export function createRunFloorInstallation(payload) {
  const reading = readRunFloorPortPayload(payload)

  if (reading.state === RUN_FLOOR_STATES.INSTALLED) {
    return Object.freeze({
      state: RUN_FLOOR_STATES.INSTALLED,
      code: null,
      message: null,
      floor: reading.floor,
      // ★ 告诫跟着装备一起走。它是"下限装上去之后仍然成立"的读数，所以落在
      //   **装置**上而不是某一次调用上：装的时候没人读，就再也没有第二次机会
      //   ——`installRunFloorIntoAgent` 的 `log` 口是它唯一的读者（见那里）。
      notices: reading.notices,
      // ★ 判定逻辑**不在这里**：它就是 `enforcement.mjs` 的 `createHardFloorGuard`，
      //   与装配级那一行、与 `composePreExecuteFloor` 用的是同一个函数。
      guard: createHardFloorGuard(reading.floor),
      denyTools: reading.floor.denyTools.length,
      denyPathPrefixes: reading.floor.denyPathPrefixes.length,
    })
  }

  if (reading.state === RUN_FLOOR_STATES.ABSENT) {
    // ★ spec §6.8 `:479` 的发布前姿态：**拒绝一切**（理由见函数头）。
    //   这里**不**装 `PRE_WIRING_HARD_FLOOR`：那九个是 Legion 的**能力名**，而本 guard
    //   比对的是执行面的**工具名**——装上去的拒绝集是空集（六个高风险能力是宿主平面
    //   能力、根本没有执行面名字，另外三个都塌在 shell 那一对上）。名字名单不是
    //   fail closed 的：不在名单里的一律放行，所以装它等于没装。
    const code = reading.code ?? RUN_FLOOR_CODES.NOT_SUPPLIED
    return Object.freeze({
      state: RUN_FLOOR_STATES.ABSENT,
      code,
      message: reading.message,
      // `floor: null` 是**"这次 Run 没有下限"**这个读数本身，不许被一份合成的下限
      // 冒名顶替。`denyTools: 0` 同样是读数而不是判定：这一档的拒绝**与名字无关**，
      // 而一份名字名单永远表达不出"拒绝一切"。
      floor: null,
      notices: reading.notices,
      guard: (exec) => {
        const name = exec !== null && typeof exec === 'object' && typeof exec.name === 'string'
          ? exec.name
          : '<读不出工具名>'
        return `hard floor：${code} —— 这次 Run **没有**下限（不是"没有东西该被禁止"）。`
          + '安装点按 spec §6.8:479 的**发布前姿态**（完成 DSH 强制面接线前）拒绝一切工具调用：'
          + `被拒的调用是 ${name}，本姿态**不看**它的风险等级、也不看它在不在任何名单上。`
          + '理由是静态下限比的是**执行面（DSH）的工具名**（`execution.name`），'
          + '而 Legion 派生出来的那些名单（`PRE_WIRING_HARD_FLOOR`、`HIGH_RISK_TOOL_NAMES`）'
          + '写的是 Legion 的**能力名**：两个名字空间不相交，把那份名单当禁名单装进来，'
          + '一个真工具名都拦不住。名字名单不是 fail closed（不在名单里的一律放行），'
          + '所以接线完成前唯一 fail closed 的姿态是拒绝；接线完成后由下限那一档按真名单放行。'
      },
      denyTools: 0,
      denyPathPrefixes: 0,
    })
  }

  // 解释不通：一份**拒绝一切**的 guard（反向的那一半，理由见函数头）。理由里带着码，
  // 于是审计读得出这是"下限解释不了"，而不是一句"被拒了"。
  const code = reading.code ?? RUN_FLOOR_CODES.NOT_SUPPLIED
  const reason = `hard floor：${code} —— 这次 Run 的下限**解释不了**：${reading.message}`
    + '安装点按 fail closed 处理：拒绝一切工具调用（连"哪些是高风险的"都读不出来，'
    + '猜一个"按高风险禁"就是在假装读懂了这份载荷）。直到下限能过线为止'

  return Object.freeze({
    state: reading.state,
    code,
    message: reading.message,
    floor: null,
    notices: reading.notices,
    guard: () => reason,
    denyTools: 0,
    denyPathPrefixes: 0,
  })
}

/**
 * 把一个已造好的下限装置装到**那个 Agent 自己的作用域**上。
 *
 * 装两个面（见文件头），两处共用 `installation.guard` 这**一个**函数对象。
 *
 * 幂等：同一个 Agent 上重复安装返回**第一次**那份读数（重装会让每次调用被拒两遍，
 * 而且第二份 disposer 谁都不认识——那是一次静默的泄漏）。
 *
 * @param {object} o
 * @param {object} o.agent 引擎交回来的 in-process 子 Agent（要能给出 `ctx`）
 * @param {object} o.installation `createRunFloorInstallation()` 的产物
 * @param {(e: {toolName: string|null, reason: string|null, surface: string}) => void} [o.onGuard]
 *   观测点，**不参与判定**。
 * @param {(e: string) => void} [o.log] 诊断输出口（默认不输出）。
 * @returns {{state: string, code: string|null, surfaces: string[], denyTools: number,
 *            denyPathPrefixes: number, dispose: () => void, guard: Function}}
 */
export function installRunFloorIntoAgent({ agent, installation, onGuard = null, log = null } = {}) {
  if (installation === null || typeof installation !== 'object' || typeof installation.guard !== 'function') {
    throw installError(RUN_FLOOR_INSTALL_CODES.MISSING_FLOOR,
      'installRunFloorIntoAgent 需要 createRunFloorInstallation() 的产物（要有 guard 函数）')
  }
  if (agent === null || typeof agent !== 'object' || agent.ctx === null || typeof agent.ctx !== 'object') {
    throw installError(RUN_FLOOR_INSTALL_CODES.NO_AGENT_CONTEXT,
      '要装下限的那个 Agent 没有自己的 Cordis 作用域（`agent.ctx`）：'
      + '下限的落点就是这个作用域，没有它就等于"这次 Run 没有任何东西在管工具调用"')
  }

  const existing = INSTALLED.get(agent)
  if (existing !== undefined) return existing

  const ctx = agent.ctx
  if (ctx.tools === undefined || typeof ctx.tools.guard !== 'function') {
    throw installError(RUN_FLOOR_INSTALL_CODES.NO_GUARD_SEAM,
      `Agent ${String(agent.id ?? '<unknown>')} 的作用域里没有 ctx.tools.guard：`
      + '最终复核没有落点。**不降级**：一个"装了一半的下限"比没有下限更危险，因为它在组合树里看得见')
  }
  if (typeof ctx.on !== 'function') {
    throw installError(RUN_FLOOR_INSTALL_CODES.NO_EVENT_SEAM,
      `Agent ${String(agent.id ?? '<unknown>')} 的作用域里没有 ctx.on：`
      + 'spec §6.8 要求下限在 tools/pre-execute 上**提前拒绝**，那需要瀑布的落点')
  }

  const guard = installation.guard
  const observe = (surface) => (exec) => {
    const reason = guard(exec)
    onGuard?.({
      surface,
      toolName: typeof exec?.name === 'string' ? exec.name : null,
      reason: typeof reason === 'string' ? reason : null,
    })
    return reason
  }

  // ① 最终复核（spec §6.8 `:456` 的后半）：单调、同步、只降级。
  const guardDispose = ctx.tools.guard(observe('tools.guard'))

  // ② 提前拒绝：同一份 guard 的**投影**。`deny` 认领；其余一律 `next()` 让路——
  //    一个"自己就把 allow 定案了"的强制面会让后面每一道门闭嘴（见 pre-execute.mjs
  //    文件头那条 PRT-214 纪律）。`prepend` 的理由见文件头。
  const preDispose = ctx.on('tools/pre-execute', (exec, next) => {
    const reason = observe('tools/pre-execute')(exec)
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  }, { prepend: true })

  const reading = Object.freeze({
    state: installation.state,
    code: installation.code,
    surfaces: Object.freeze([...RUN_FLOOR_SURFACES]),
    denyTools: installation.denyTools,
    denyPathPrefixes: installation.denyPathPrefixes,
    // 装备上的告诫原样带出来：`log` 口是**默认**读者，但调用方（诊断页、用例、
    // 将来的审计行）要拿到结构化的那几条，不该去 grep 日志文本。
    notices: Object.freeze([...(installation.notices ?? [])]),
    agentId: agent.id === undefined ? null : String(agent.id),
    guard,
    dispose: () => {
      INSTALLED.delete(agent)
      // 两个面各自撤掉；顺序无关（一个是单调拒绝，一个是提前拒绝）。
      try { guardDispose() } catch { /* 已卸载 */ }
      try { preDispose() } catch { /* 已卸载 */ }
    },
  })
  INSTALLED.set(agent, reading)

  log?.(`[run-floor] v${RUN_FLOOR_INSTALL_VERSION} 已把这次 Run 的下限装到 Agent `
    + `${reading.agentId ?? '<unknown>'}（state=${installation.state}`
    + `${installation.code === null ? '' : ` code=${installation.code}`}`
    + ` denyTools=${installation.denyTools} denyPathPrefixes=${installation.denyPathPrefixes}）`)

  // ── 告诫（notices）：**这就是它的生产消费者** ──────────────────────────────
  //
  // 一行一条，而不是拼进上面那一行：告诫是"这次下限**额外**做了什么/做不到什么"，
  // 把它挤进状态行会让它在下一次有人精简日志时第一个被删掉——而那正是
  // step-1「接受连带禁止，但必须记录」那条裁决要防的事。
  //
  // 为什么值得单独占一行日志：
  //
  //   > 一个"为了拦一个推送而关掉整个 shell"的下限，与一个"只拦了推送"的下限，
  //   > 在 `denyTools` 上是同一个读数、在状态行上也是同一个读数——
  //   > 只有当那条告诫真的被打印出来时，这两件事才分得开。
  //
  // `installation.notices` 缺席时（旧调用方、或 `absent`/`refused` 那两档）
  // 什么都不打印：**不**补一句"没有告诫"——那是把一个不存在的读数写进日志。
  for (const n of installation.notices ?? []) {
    log?.(`[run-floor] 告诫 ${n.code}：关于「${n.tool}」——${n.message}`
      + (n.dshTools.length > 0 ? `（执行面上禁掉 ${JSON.stringify(n.dshTools)}）` : '')
      + (n.collateral.length > 0 ? `（连带也会禁掉 ${JSON.stringify(n.collateral)}）` : ''))
  }
  return reading
}

/** 已安装的读数（按 Agent 身份；用例与诊断用，**不放活对象**）。 */
const INSTALLED = new WeakMap()

/** 该 Agent 上装过没有（只读观察）。 */
export function runFloorInstalledOn(agent) {
  return INSTALLED.has(agent)
}

/** 读端口选项上的下限载荷（**缺席就是 `undefined`**，不补默认值）。 */
export function runFloorOptionOf(options) {
  if (options === null || typeof options !== 'object') return undefined
  return options[RUN_FLOOR_RUN_OPTION_KEY]
}

/**
 * 把下限载荷挂到这次创建请求的 `agentOptions` 上，返回**新**的 options。
 *
 * 为什么不改原对象：调用方（适配器）的 options 是它自己的数据；就地加一个键会让
 * "端口读到了什么"与"适配器交出去了什么"变成同一个对象——而它们必须能分别断言
 * （`runtime-host-registrar-row.test.mjs` 就有一条按引用比较 options 的用例）。
 *
 * @param {object} options 端口收到的原始选项
 * @param {unknown} payload 下限载荷
 * @returns {object} 带载体键的新选项对象
 */
export function withRunFloorCarrier(options, payload) {
  const base = options !== null && typeof options === 'object' ? options : {}
  const prior = base.agentOptions !== null && typeof base.agentOptions === 'object' ? base.agentOptions : {}
  return {
    ...base,
    agentOptions: { ...prior, [RUN_FLOOR_CHILD_OPTION_KEY]: payload },
  }
}

/** 读一个**已创建**的 Agent 身上的下限载体（不在就是 `undefined`）。 */
export function runFloorCarrierOf(agent) {
  const options = agent === null || typeof agent !== 'object' ? undefined : agent.options
  if (options === null || typeof options !== 'object') return undefined
  return options[RUN_FLOOR_CHILD_OPTION_KEY]
}


/**
 * 装载期自检：**算出来的产物**，不是一个布尔。
 *
 * 四条读数各自钉着一件会静默失效的事：
 *   · `absent` 与"空下限"必须是**两个不同的 state**；
 *   · `absent` 的 guard 必须**拒掉一个真 DSH 工具名**（否则 §6.8:479 的禁止是空的）；
 *   · `absent` 的 guard 必须**连一个不在任何 Legion 名单里的名字也拒**——这是名字名单
 *     **不可能**提供的性质（不在名单里的一律放行），也是"看起来在禁、其实一个真工具
 *     都没拦住"那句话唯一的判别项；
 *   · `refused` 的 guard 必须**放行不了任何东西**（读不懂就不许猜，见函数头）。
 *
 * 与"高风险的九个"有关的那两条读数**不在这里**：它们钉的是 `HIGH_RISK_TOOL_NAMES`
 * 这份**数据**（见 `tool-capability.mjs` 的注释与 run-floor.test.mjs 的单源用例），
 * 而不是这一档的判定——把数据当判定读，正是这一批修掉的那个错。
 */
export const RUN_FLOOR_INSTALL_CHECKED = Object.freeze({
  version: RUN_FLOOR_INSTALL_VERSION,
  portStates: Object.freeze(Object.values(RUN_FLOOR_PORT_STATES)),
  // 一个本来会被允许的调用：空名单下必须放行
  probe: 'write',
  emptyFloorState: createRunFloorInstallation({ state: RUN_FLOOR_PORT_STATES.INSTALLED, floor: { denyTools: [], denyPathPrefixes: [], platform: 'linux' } }).state,
  emptyFloorAllowsProbe: createRunFloorInstallation({ state: RUN_FLOOR_PORT_STATES.INSTALLED, floor: { denyTools: [], denyPathPrefixes: [], platform: 'linux' } }).guard({ name: 'write', arguments: {} }) === undefined,
  absentState: createRunFloorInstallation({ state: RUN_FLOOR_PORT_STATES.ABSENT }).state,
  // ★ 缺席只有一个方向：**任何**名字都被拒。`write` 是一个**真 DSH 工具名**，
  //   于是"按 Legion 能力名名单禁"的实现在这一条上就红了（它会放行 `write`）。
  absentDeniesProbe: typeof createRunFloorInstallation({ state: RUN_FLOOR_PORT_STATES.ABSENT }).guard({ name: 'write', arguments: {} }) === 'string',
  // 一个**不在任何 Legion 名单里**的名字也被拒：名字名单做不到这件事。
  absentDeniesUnlistedProbe: typeof createRunFloorInstallation({ state: RUN_FLOOR_PORT_STATES.ABSENT }).guard({ name: 'name-in-no-legion-list', arguments: {} }) === 'string',
  // 0 是读数：这一档的拒绝与名字无关，所以它没有一份名字名单。
  absentDenyTools: createRunFloorInstallation({ state: RUN_FLOOR_PORT_STATES.ABSENT }).denyTools,
  absentGuardCode: createRunFloorInstallation({ state: RUN_FLOOR_PORT_STATES.ABSENT }).code,
  // 反向的那一半：读不懂的载荷也放不出任何工具。
  refusedDeniesProbe: typeof createRunFloorInstallation({ state: 'nope' }).guard({ name: 'write', arguments: {} }) === 'string',
})
