// runtime/dsh-composition/run-floor-dsh-process.test.mjs
// ============================================================================
// PRT-214 缺口①的**真进程**读数：一次 Run 的静态 hard floor，能不能在
// 一个真 DSH 进程里真的拦住一个**真子 Agent 发起的真工具调用**。
//
// ## 这一套件要回答的唯一问题
//
// 进程内用例（`run-floor.test.mjs`）把下限装在一个 `createScope` 造出来的作用域上，
// 证明了"装在哪个作用域、就只影响哪个作用域"。但那些用例里的"Agent"是本套件
// 捏出来的一个 `{ id, ctx }` 对象，**不是引擎造出来的 Agent**：
//
//   > 一个"把下限装在一个人造作用域上、于是拒绝对了"的实现，
//   > 与一个"引擎真的会把它派生出来的孩子交到你手里、你装得上"的实现，
//   > 在进程内用例里是同一个东西——只不过前者的作用域键是本套件给的，
//   > 而生产里的键是 `createScope(loopCtx, this)` 自己 mint 的。
//
// 所以这里走**生产的那条路**：真 DSH 进程 + 真 `agents`/`subagents` 服务 +
// 真 in-process 子 Agent + 真 `write` 工具，下限由**生产端口工厂**
// （`createRuntimeHostInputsFactory()` 的 `startRun`）装上，
// 判据是**带外副作用**：那条命令若真被执行，必然写出一个文件。
//
// ## ★ 承重的那条断言是"哨兵在不在"
//
// `tool/result` 里的 `isError: true` 只说明某一层拒绝了；`turn/end` 正常收尾
// 也只说明这一轮没有崩。唯一不撒谎的读数是带外副作用：
//
//   · `denied.txt` **不出现** ⇒ 那份下限真的在 guard/pre-execute 那一级拦住了；
//   · `absent-risk.txt` **与** `absent.txt` **都不出现** ⇒ 缺席装的是
//     §6.8:479 的**发布前姿态**：拒绝一切工具调用；
//   · `control.txt` **出现**、且内容是这次运行 mint 的 token ⇒
//     同一个进程、同一份桩、同一时刻，"空下限"放行了**同一个**工具调用。
//
// 这三条合起来才等于"拒绝来自**这份下限**"：只有前两条时，"下限从没生效"也能解释；
// 只有第三条时，"这次没人写成"也能解释。
//
// ## ★ 缺席那一档为什么要打**两个不同名字空间**的工具
//
// spec §6.8 `:479` 对"没给下限"的处置说的是「legacy 路径在完成 DSH 强制面接线前
// **禁止高风险工具**」。一个**名字**名单要满足它，前提是名单里的名字与真工具名
// 处在同一个空间——这里不是：
//
//   · `HIGH_RISK_TOOL_NAMES` 写的是 Legion 的**能力名**（`delete-file` / …）；
//   · 真进程里 `execution.name` 是执行面的**工具名**（`write` / `pwsh` / …）；
//   · 九个里六个是宿主平面能力（没有执行面名字），三个共塌在 shell 那一对上。
//
// 于是缺席那次 Run 里打**两次**工具，两次都必须被拒——**两半缺一不可**：
//
//   · 一个 Legion 高风险名（宿主按 `HIGH_RISK_TOOL_NAMES` 注册的桩，执行时真的写文件）；
//     它被拒只说明"某个名字被拒了"，一个"按 Legion 名单禁"的实现也能让它绿；
//   · 一个低风险的**真** `write`（真 DSH 工具名）：按 Legion 名单禁会**放行**它，
//     而"拒绝一切"会拒掉它。**这一半才是判别项。**
//
//   > 一个「按 Legion 能力名名单禁九个」的处置，
//   > 与一个「拒绝一切」的处置，
//   > 在只打一个 Legion 高风险名字的用例里是同一个读数——
//   > 只不过真工具名进来时，前者放行一切，而它在摘要里是绿的。
//
// 判据是两条带外读数合起来：
//
//   · `absent-risk.txt`（桩写的）**不出现** ⇒ Legion 空间那个名字没跑起来；
//   · `absent.txt`（真 `write` 写的）**不出现** ⇒ 真 DSH 名也没跑起来。
//
// ★ 桩工具**必须是真的登记在册的**：一个没登记的名字，DSH 自己就会拒它，
// 于是那条绿与下限毫无关系。
//
//   > 一条「用真工具证明缺席也拦住」的用例，
//   > 与一条「用一个登记表里不存在的名字证明缺席也拦住」的用例，
//   > 在摘要里都是红/绿一行——只不过后者的绿来自 DSH 自己拒了未知工具。
//
// ## 三个场景在**同一个进程**里并发跑，这是故意的
//
// 同一个长命进程里连着三次 Run，各带**不同**的下限：
//
//   · `denied`：下限禁掉这次 Run 的哨兵路径 → 工具必须被拒；
//   · `absent`：这次 Run **没有**下限（`{state:'absent'}`）→ **任何**工具都必须被拒
//     （发布前姿态，两个名字空间各打一个）；
//   · `control`：这次 Run 的下限**是空的** → 工具必须被放行。
//
// `absent` 与 `control` 的差别只有载荷里的那一个状态字段，而它们的带外读数
// 一个是"两个名字都没写成"、一个是"同一个 `write` 写得成"——这正是
// "缺席是拒绝一切、而拒绝来自这份下限"这句话在真进程里的读数。若三条都在各自的
// 进程里跑，第三条的绿就证明不了"拒绝不是环境问题"。
//
// ## 诚实边界
//
// 本套件的读数**不**覆盖：真实模型（桩模型是唯一路由）、真实审批口
// （这次调用在下限那一级就被拒，没人被问过）。
//
// ★ 此处这份下限是**用例自己挂上去的**（`floorForScenario`），不是生产路径
//   派生出来的。两件事各自有各自的读数，别把它们读成一件：
//     · 「生产那一侧会把派生出来的下限放进 RunRequest」——
//       `orchestrator/worker/executor.test.mjs` 的 §⑥（读点是
//       `host.calls.startRun[0].options.enforcementFloor`）；
//     · 「真 DSH 进程会因为一份下限拒掉一次工具调用」——本文件。
//   今天仍然**没有一条**读数同时覆盖两者：把 §⑥ 那一份载荷真的喂给一个
//   长命 DSH 进程、并在带外看到"工具没跑成"，还没有人做过。
//   （`team-hub/run-floor.test.mjs` §⑦ 盯着本文件里这一行的形状，
//   所以它改成接真的生产者那天，那条会红。）
//
// ## 一次性 home / 安全（与既有 `*-dsh-process.test.mjs` 同一套纪律）
//
//   每次子进程都有自己的 `mkdtempSync` home（spawn **之前**断言它落在 `os.tmpdir()` 内），
//   profile 就在那个 home 里现造、`patchReload: 'startup'`；从环境里**删掉**
//   `DSH_SNAPSHOT` / `DSH_SESSION_ID` / `DSH_WEB_URL` / `DEEPSEEK_API_KEY`；
//   进程在 `after()` 里无条件 kill，整个 temp root 无条件删。
//   **绝不**读写操作者那台机器上的真实 profile。
// ============================================================================

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 判定与路径归一都取自**产品模块**，不在用例里另抄一份：
// 抄一份的话，产品改了规范化规则而用例还绿着，"断言的是那个拒绝"就变成了一句注释。
import { canonicalizePath } from './enforcement.mjs'
// ★ 桩工具的名字取自**产品的高风险名单**，不是用例里手写一个字符串：
//   这样"桩被拒"与"它真的在 Legion 的高风险那一档里"就连在一起——而下限拒它
//   必须**不是因为**它高风险（缺席拒一切，与风险无关），只是因为它是被调用者。
import { HIGH_RISK_TOOL_NAMES } from './tool-capability.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const DSH = process.env.DSH_CHECKOUT ?? null
const CLI = DSH === null ? null : join(DSH, 'apps', 'cli', 'lib', 'bin.js')

/**
 * 注册进真进程的那个桩工具名（一个 Legion **能力名**，见文件头）。
 *
 * ⚠️ 它**不是**这一档的判别项：缺席是"拒绝一切"，拒它不证明名单被读懂了。
 * 判别项是同一档里那次低风险的**真** `write`（真 DSH 工具名）也被拒——
 * 按 Legion 名单禁的实现会放行 `write`。
 */
const STUB_TOOL_NAME = HIGH_RISK_TOOL_NAMES[0]

const REGISTRAR_URL = pathToFileURL(join(REPO, 'runtime', 'dsh-composition', 'plugins', 'runtime-host-registrar-row.mjs')).href
const RUN_FLOOR_URL = pathToFileURL(join(REPO, 'runtime', 'dsh-composition', 'run-floor.mjs')).href

/** 为什么没跑。写清楚缺哪一样，而不是笼统的"环境不支持"。 */
const UNAVAILABLE = DSH === null
  ? '未配置 DSH_CHECKOUT'
  : !existsSync(CLI)
    ? `DSH 检出里找不到 CLI（${CLI}）——未构建？`
    : false
const SKIP = UNAVAILABLE === false ? false : `SKIP：${UNAVAILABLE}`

const PROFILE_NAME = 'acp'
const SPAWN_TIMEOUT_MS = 180_000

/** 进程登记处：`after()` 从这里收尾，失败路径也走它。 */
const LIVE_CHILDREN = new Set()
const SCRATCH_DIRS = new Set()

after(() => {
  for (const child of LIVE_CHILDREN) {
    try { child.kill() } catch { /* 已经退出就没什么可杀的 */ }
  }
  LIVE_CHILDREN.clear()
  for (const dir of SCRATCH_DIRS) rmSync(dir, { recursive: true, force: true })
  SCRATCH_DIRS.clear()
})

/** 在 `os.tmpdir()` 下现造一个目录，并在返回前断言它**没有跑出** temp root。 */
function makeTemp(prefix) {
  const base = resolve(tmpdir())
  const dir = resolve(mkdtempSync(join(base, prefix)))
  if (!dir.startsWith(base + sep)) throw new Error(`临时目录跑到 temp root 之外了：${dir}`)
  return dir
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** 三个场景的名字。它们出现在**提示文本**里，桩模型靠它选目标路径（见文件头）。 */
const SCENARIOS = Object.freeze(['denied', 'absent', 'control'])

// ── 探针模块的源码 ───────────────────────────────────────────────────────────
//
// 它必须对这个模板字面量**透明**：没有反引号（会提前终止）、没有 `${`（会被插值）。
// 探针里那两处需要真实换行的地方写成 `String.fromCharCode(10)`——
// 直接把 `'\n'` 写进来会被这个模板变成一个真换行，写出去的模块当场 SyntaxError，
// 而 `node --check` 检查的是**本文件**，它照样是绿的。
const MODULE_SRC = `
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ToolCallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { createRuntimeHostInputsFactory } from ${JSON.stringify(REGISTRAR_URL)}
import { runFloorInstalledOn } from ${JSON.stringify(RUN_FLOOR_URL)}

export const name = 'prt214floor-probe'
export const inject = ['subagents', 'agents', 'llm', 'tools']

const FINDINGS = process.env.PRT214FLOOR_FINDINGS
const PROVIDER = 'prt214floor-model'
const MODEL = 'prt214floor-model'
const TOKEN = process.env.PRT214FLOOR_TOKEN
// ★ 桩工具的名字由宿主用例从 Legion 的**高风险名单**里取（HIGH_RISK_TOOL_NAMES）——
//   于是"它被拒"只可能来自下限：DSH 自己不会拒一个**已登记**的工具。
//   注意它是 Legion 的**能力名**，不是执行面工具名：这一档真正的判别项是
//   同一个 Run 里那次低风险的**真** write 也被拒（按 Legion 名单禁会放行它）。
const STUB_TOOL = process.env.PRT214FLOOR_STUB_TOOL
const STUB_SENTINEL = process.env.PRT214FLOOR_ABSENT_RISK
const TARGETS = {
  denied: process.env.PRT214FLOOR_DENIED,
  absent: process.env.PRT214FLOOR_ABSENT,
  control: process.env.PRT214FLOOR_CONTROL,
}
const TASK_RE = /PRT214FLOOR-TASK (denied|absent|control)/
const RESULT_MARK = 'TOOLRESULT<'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function record(fields) {
  if (FINDINGS === undefined) return
  try {
    appendFileSync(FINDINGS, JSON.stringify({ at: Date.now(), ...fields }) + String.fromCharCode(10), 'utf8')
  } catch {
    process.stderr.write('prt214floor-probe: 写读数失败' + String.fromCharCode(10))
  }
}

const describe = (error) => (error === null || error === undefined
  ? String(error)
  : String(error.message ?? error))

/** 把一段对话摊成纯文本（桩只读 leaf 字段，不搬活对象）。 */
function flat(options) {
  const parts = []
  for (const message of options.messages ?? []) {
    for (const block of message.content ?? []) {
      if (block.type === 'text') parts.push(block.text)
      if (block.type === 'tool-result') {
        for (const inner of block.content ?? []) if (inner.type === 'text') parts.push('TOOLRESULT<' + inner.text + '>')
      }
    }
  }
  return parts.join(String.fromCharCode(10))
}

function countOf(haystack, needle) {
  let n = 0
  let at = haystack.indexOf(needle)
  while (at >= 0) { n += 1; at = haystack.indexOf(needle, at + needle.length) }
  return n
}

/**
 * 一次工具调用要吐出的模型流事件。
 *
 * ★ 参数用 \`JSON.stringify\` 生成，**不是**拼字符串：一个写死格式的桩会在
 * 引擎改参数形状时安静地"调用成功但参数不对"，而那次读数会被读成"工具跑了"。
 */
function toolCallEvents(id, name, args) {
  const raw = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textEvents(text, usage) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * 桩模型。它**只有**模型流这一件事，绝不碰文件系统：因此四个哨兵文件
 * 不可能由它写出来，只可能由真 ToolRuntime 里的真工具写出来。
 *
 * 目标路径按**提示文本里的场景名**选（不是按到达顺序）：并发三个孩子时，
 * 按下标配对会在任意一次调度抖动上错位，按内容不会。
 *
 * ★ 「absent」那一档打**两次**工具（见文件头）：第一次是 Legion 高风险能力名的桩，
 *   第二次是真 write。两次都必须被拒——第一次只证明"某个名字被拒了"，第二次
 *   （真 DSH 工具名）才是"拒绝一切"与"按 Legion 名单禁"之间唯一分得开的那个读数。
 *   两次都按"看见了几个工具结果"决定下一步，不看时序——一个按 tick 猜步数的桩
 *   会在慢机器上发出一串重复调用，而那些调用会让两条读数互相污染。
 */
class ProbeAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return {
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }], defaultEffort: ReasoningEffortId('off') },
    }
  }
  async * stream(options) {
    const text = flat(options)
    const matched = text.match(TASK_RE)
    const scenario = matched === null ? null : matched[1]
    const results = countOf(text, RESULT_MARK)
    const sawResult = results > 0
    // 取**最后**一个工具结果：缺席那一档有两轮，第一轮的结果在第三轮里还在，
    // 按第一个读会把第二次（真 write）那次的拒绝理由读成第一次（桩）的。
    const resultText = sawResult ? text.slice(text.lastIndexOf(RESULT_MARK) + RESULT_MARK.length).split('>')[0] : null
    record({
      phase: 'llm', sessionId: String(options.sessionId ?? ''), scenario,
      sawResult, results, resultText, tail: text.slice(-200),
    })
    if (scenario === null) {
      // 没有场景标记的轮次（例如父 agent 自己那一轮）不产生工具调用：
      // 一个什么都写的桩会让"是这次 Run 的规则拦住的"变得无从归因。
      for (const event of textEvents('PRT214FLOOR-NO-SCENARIO', { inputTokens: 3, outputTokens: 1 })) yield event
      return
    }
    // ★ 缺席那一档：先打 Legion 高风险能力名的桩，看到结果（无论拒没拒）
    //   再打低风险的真 write。两次都必须被拒 —— 第二次才是判别项。
    if (scenario === 'absent' && results === 0) {
      for (const event of toolCallEvents(ToolCallId('prt214floor-stub-call'), STUB_TOOL,
        { file_path: STUB_SENTINEL, content: TOKEN })) yield event
      return
    }
    if (!sawResult || (scenario === 'absent' && results === 1)) {
      for (const event of toolCallEvents(ToolCallId('prt214floor-call'), 'write',
        { file_path: TARGETS[scenario], content: TOKEN })) yield event
      return
    }
    for (const event of textEvents('PRT214FLOOR-DONE', { inputTokens: 3, outputTokens: 1 })) yield event
  }
}

/** 轮询等一个服务出现（Loader 并发建行，何时就位没有保证）。 */
async function waitFor(ctx, name, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = ctx.get(name)
    if (found !== undefined && found !== null) return found
    if (Date.now() > deadline) return null
    await sleep(100)
  }
}

/** 造一个活着的父 agent；agent 工厂可能比本行晚一步注册，所以按错误重试。 */
async function createParent(ctx, cwd) {
  let lastError
  for (let index = 0; index < 60; index += 1) {
    try {
      const handle = await ctx.agents.create({
        sessionId: randomUUID(),
        meta: { cwd },
        agentOptions: { provider: PROVIDER, model: MODEL },
      })
      return handle.agent
    } catch (error) {
      lastError = error
      if (!/no agent factory/.test(String(error && error.message))) throw error
      await sleep(250)
    }
  }
  throw lastError
}

/**
 * 一次 Run：走**生产端口**的 \`startRun\`，把下限载荷放在端口选项上。
 *
 * 每次 Run 一份**新的**载荷对象——这不是为了好看：端口按**对象身份**
 * 把载荷与它创建出来的子 Agent 配对，于是"哪份下限属于哪次 Run"
 * 由身份回答，不由顺序猜。
 */
async function runOne(built, parent, scenario) {
  const floorForScenario = {
    denied: { state: 'installed', floor: { denyTools: [], denyPathPrefixes: [TARGETS.denied], cwd: process.cwd(), platform: process.platform } },
    absent: { state: 'absent' },
    control: { state: 'installed', floor: { denyTools: [], denyPathPrefixes: [], cwd: process.cwd(), platform: process.platform } },
  }[scenario]

  const controller = new AbortController()
  let run
  try {
    run = await built.runtimeHost.startRun('spawn', {
      label: 'prt214floor-' + scenario,
      prompt: [{ type: 'text', text: 'PRT214FLOOR-TASK ' + scenario }],
      parent,
      signal: controller.signal,
      agentOptions: { provider: PROVIDER, model: MODEL },
      enforcementFloor: floorForScenario,
    })
  } catch (error) {
    record({ phase: 'run-start-failed', scenario, error: describe(error), code: String(error && error.code) })
    return
  }
  const child = run.localAgent
  record({
    phase: 'run-started', scenario,
    childId: child === undefined ? null : String(child.id),
    installed: child === undefined ? null : runFloorInstalledOn(child),
    floorState: floorForScenario.state,
  })
  let result = null
  try {
    result = await run.result
  } catch (error) {
    record({ phase: 'run-result-threw', scenario, error: describe(error) })
  }
  record({
    phase: 'run-settled', scenario,
    stopReason: result === null || result === undefined ? null : String(result.stopReason ?? null),
    installedAtSettle: child === undefined ? null : runFloorInstalledOn(child),
    disposed: runFloorInstalledOn(child) === false,
  })
  try { await run.dispose() } catch (error) { record({ phase: 'dispose-threw', scenario, error: describe(error) }) }
}

/**
 * 三个场景在**同一个进程**里跑。顺序无关：三份下限互不覆盖的判据是
 * 四个**不同**的哨兵文件，而不是执行顺序。
 */
async function drive(ctx) {
  const cwd = process.cwd()
  try {
    const subagents = await waitFor(ctx, 'subagents', 60000)
    record({ phase: 'services', subagents: subagents !== null, tools: ctx.get('tools') !== undefined, llm: ctx.get('llm') !== undefined })
    if (subagents === null) { record({ phase: 'done', verdict: 'no-subagents' }); process.exit(0) }
    // ★ 桩工具是真的登记在册的（见文件头）：登记失败就没有读数可言，如实记下来。
    let stubRegistered = false
    try {
      ctx.tools.register(defineContentToolFixture({
        name: STUB_TOOL,
        description: 'PRT-214 读数桩：执行时真的把 token 写进哨兵文件',
        parameters: {},
        async execute(args) {
          appendFileSync(String(args.file_path), TOKEN, 'utf8')
          return [{ type: 'text', text: 'PRT214FLOOR-STUB-RAN' }]
        },
      }))
      stubRegistered = true
    } catch (error) {
      record({ phase: 'stub-register-failed', tool: STUB_TOOL, error: describe(error) })
    }
    record({ phase: 'stub-registered', tool: STUB_TOOL, ok: stubRegistered })
    const built = createRuntimeHostInputsFactory()(ctx)
    record({ phase: 'port-built', startRun: typeof built.runtimeHost.startRun })
    const parent = await createParent(ctx, cwd)
    record({ phase: 'parent-created', parentId: String(parent.id) })
    for (const scenario of ${JSON.stringify(SCENARIOS)}) await runOne(built, parent, scenario)
  } catch (error) {
    record({ phase: 'probe-threw', error: describe(error) })
  }
  record({ phase: 'done' })
  process.exit(0)
}

export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new ProbeAdapter())
  setTimeout(() => { void drive(ctx) }, 0)
}
`

/** 补丁 overlay：只插一行探针。理由见文件头——被测的是**生产端口**，不是补丁层。 */
const OVERLAY = [
  '- insert:',
  '    - id: "prt214floor-probe"',
  "      name: './prt214floor-probe.mjs'",
  '',
].join('\n')

const PROFILE_PACKAGE = JSON.stringify({
  name: `dsh-profile-${PROFILE_NAME}`,
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      // 与 `subagents-surface-real-process.test.mjs` 同一个 profile：
      // base 挂 `agents`/`subagents`/`llm`/`tools`，acp-app 让 CLI 起得来并等 stdin。
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
      patchReload: 'startup',
    },
  },
}, undefined, 2) + '\n'

// ── 一次真进程，一套读数 ─────────────────────────────────────────────────────

function readFindings(path) {
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try { out.push(JSON.parse(line)) } catch { /* 正在写的那一行 */ }
  }
  return out
}

let scenarioPromise = null
const scenario = () => (scenarioPromise ??= runScenario())

async function runScenario() {
  const root = makeTemp('prt214floor-')
  SCRATCH_DIRS.add(root)
  const home = join(root, 'home')
  const agentsHome = join(root, 'agents')
  const cwd = join(root, 'cwd')
  const profileDir = join(home, 'profiles', PROFILE_NAME)
  const findingsPath = join(root, 'findings.jsonl')

  for (const dir of [home, agentsHome, cwd]) {
    mkdirSync(dir, { recursive: true })
    // spawn **之前**先断言：三个目录都在这次 temp root 之内。
    assert.ok(dir.startsWith(root + sep), `spawn 之前目录就跑出 temp root 了：${dir}`)
  }
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'prt214floor-probe.mjs'), MODULE_SRC, 'utf8')
  writeFileSync(join(profileDir, 'package.json'), PROFILE_PACKAGE, 'utf8')
  writeFileSync(join(profileDir, 'overlay.yml'), OVERLAY, 'utf8')

  // 四个哨兵文件**各自一个路径**：三个场景的带外读数因此互不遮蔽。
  // 缺席那一档的两个哨兵：`absent-risk` 由 Legion 高风险能力名的桩写（`absent-risk`
  // 保留原名，读作"那一档里高风险空间的那个名字"），`absent` 由低风险的**真** `write`
  // 写。这一批之后**两个都必须不出现**——第二个才是判别项。
  const target = (name) => join(cwd, `prt214floor-${name}.txt`)
  const token = `PRT214FLOOR_${Math.random().toString(16).slice(2, 10).toUpperCase()}`

  const env = { ...process.env }
  for (const name of ['DSH_SNAPSHOT', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) {
    delete env[name]
  }
  Object.assign(env, {
    DSH_HOME: home,
    DSH_AGENTS_HOME: agentsHome,
    DSH_TELEMETRY_DISABLED: '1',
    // 工具层的沙箱策略：本套件测的是 Legion 的下限，不是 DSH 的沙箱。
    // 用最宽的一档把变量限制在**下限**这一个上（否则"写不出去"有两种成因）。
    DSH_PERMISSION_MODE: 'danger-full-access',
    PRT214FLOOR_FINDINGS: findingsPath,
    PRT214FLOOR_TOKEN: token,
    PRT214FLOOR_STUB_TOOL: STUB_TOOL_NAME,
    PRT214FLOOR_DENIED: target('denied'),
    PRT214FLOOR_ABSENT: target('absent'),
    PRT214FLOOR_ABSENT_RISK: target('absent-risk'),
    PRT214FLOOR_CONTROL: target('control'),
  })

  const startedAt = Date.now()
  const child = spawn(process.execPath, [
    CLI, '--profile', PROFILE_NAME, '--patch', join(profileDir, 'overlay.yml'),
  ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  LIVE_CHILDREN.add(child)

  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })

  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  // 探针跑完会 `process.exit(0)`；它若卡住，watchdog 兜底，绝不留下孤儿进程。
  const watchdog = setTimeout(() => { try { child.kill() } catch { /* 收尾路径 */ } },
    SPAWN_TIMEOUT_MS - 20_000)
  // ★ 等待上限也是一个**定时器**，必须自己清掉：不清的话 runner 会在所有用例
  //   跑完之后，为了这个还挂着的 handle 多等一整个超时（实测多等 166 秒）。
  //   那是"这一套很慢"的假象，与任何一个被测量的行为都无关。
  let waitTimer = null
  const waitLimit = new Promise((resolveWait) => {
    waitTimer = setTimeout(() => resolveWait({ code: null, signal: 'wait-timeout' }), SPAWN_TIMEOUT_MS - 10_000)
  })

  let exit
  try {
    exit = await Promise.race([exited, waitLimit])
  } finally {
    clearTimeout(watchdog)
    clearTimeout(waitTimer)
    try { child.kill() } catch { /* 已经退出 */ }
    LIVE_CHILDREN.delete(child)
  }

  const findings = readFindings(findingsPath)
  const sentinel = (name) => {
    const path = target(name)
    return { path, exists: existsSync(path), text: existsSync(path) ? readFileSync(path, 'utf8') : null }
  }
  return {
    elapsedMs: Date.now() - startedAt,
    exit,
    stdout,
    stderr,
    findings,
    token,
    cwd,
    denied: sentinel('denied'),
    absent: sentinel('absent'),
    absentRisk: sentinel('absent-risk'),
    control: sentinel('control'),
    home,
  }
}

const findingsOf = (r, phase) => r.findings.filter((f) => f.phase === phase)
const findingOf = (r, phase, scenarioName) => findingsOf(r, phase).find((f) => f.scenario === scenarioName) ?? null

/** 摘要用的现场，让失败信息自带读数。 */
function describeReading(r) {
  return [
    `exit=${JSON.stringify(r.exit)} ms=${r.elapsedMs}`,
    `denied.exists=${r.denied.exists} absent.exists=${r.absent.exists}`
    + ` absent-risk.exists=${r.absentRisk.exists} control.exists=${r.control.exists}`,
    `stub-registered=${JSON.stringify(findingsOf(r, 'stub-registered')[0] ?? null)}`,
    `phases=${r.findings.map((f) => f.phase + (f.scenario === undefined ? '' : ':' + f.scenario)).join(',')}`,
    `stderr=${r.stderr.slice(-600)}`,
  ].join('\n  ')
}

const guarded = (name, fn) => test(name, { skip: SKIP, timeout: 300_000 }, fn)

// ── 用例 ─────────────────────────────────────────────────────────────────────

guarded('★★★★★ 真进程 · 被下限禁掉的那次 Run：工具真的没执行（哨兵不存在）', async (t) => {
  const r = await scenario()
  const settled = findingOf(r, 'run-settled', 'denied')
  assert.notEqual(settled, null, `denied 那次 Run 没有结算：\n  ${describeReading(r)}`)
  assert.equal(settled.stopReason, 'completed', '那一轮没有正常收尾——拒绝应当是一次正常的工具结果')
  assert.equal(r.denied.exists, false,
    `★ 下限禁掉了那条路径，文件却出现了（${r.denied.path}）——下限在真进程里没生效：\n  ${describeReading(r)}`)
  t.diagnostic(`denied.txt 不存在；stopReason=${String(settled.stopReason)} ms=${r.elapsedMs}`)
})

guarded('★★★★★ 真进程 · 同一次进程里的对照：空下限放行了**同一个**工具调用', async (t) => {
  const r = await scenario()
  const settled = findingOf(r, 'run-settled', 'control')
  assert.notEqual(settled, null, `control 那次 Run 没有结算：\n  ${describeReading(r)}`)
  assert.equal(settled.stopReason, 'completed', '对照组没有正常收尾')
  assert.equal(r.control.exists, true,
    `★ 空下限也把工具拦住了——"下限没禁它"与"下限从没生效"分不开了：\n  ${describeReading(r)}`)
  assert.equal(r.control.text, r.token, '对照组写出来的内容不是这次运行 mint 的 token')
  t.diagnostic(`control.txt 存在且内容匹配；denied.exists=${r.denied.exists}`)
})

guarded('★★★★★ 真进程 · 缺席的下限＝拒绝一切：两个名字空间的哨兵**都不出现**', async (t) => {
  const r = await scenario()
  const settled = findingOf(r, 'run-settled', 'absent')
  assert.notEqual(settled, null, `absent 那次 Run 没有结算：\n  ${describeReading(r)}`)
  assert.equal(settled.stopReason, 'completed', 'absent 那一轮没有正常收尾')

  // ★ 桩必须是**真的登记过**的：一个没登记的名字，DSH 自己就会拒它，
  //   于是那条绿与下限毫无关系（见文件头）。
  const stub = findingsOf(r, 'stub-registered')[0] ?? null
  assert.notEqual(stub, null, `探针没有留下"桩工具登记了没有"的读数：\n  ${describeReading(r)}`)
  assert.equal(stub.ok, true,
    `桩工具 ${STUB_TOOL_NAME} 没登记上——那这次拒绝就可能来自 DSH 而不是下限：${JSON.stringify(stub)}`)

  // ★ 第一半：Legion 能力名空间那条读数。桩工具**真的会写文件**，所以"没写成"
  //   只可能是下限拦的。但这一半**不判别**："按 Legion 高风险名单禁"的实现也满足它。
  assert.equal(r.absentRisk.exists, false,
    `★ 缺席的下限放行了一个 Legion 高风险能力名（${STUB_TOOL_NAME}）：`
    + `§6.8:479 的"禁止高风险工具"是空的：\n  ${describeReading(r)}`)
  // ★ 第二半：低风险的**真** `write`（真 DSH 工具名）也必须没写成。
  //   它才是"拒绝一切"与"按 Legion 能力名名单禁"之间唯一分得开的读数——
  //   后者会放行 `write`（那份名单里没有这个执行面名字）。
  assert.equal(r.absent.exists, false,
    `★ 缺席的下限放行了低风险的**真** write（${r.absent.path} 出现了）——`
    + '那是"按 Legion 能力名名单禁"的读数：名单 ∩ 真工具名 = 空集，一个真工具都没拦住。'
    + `§6.8:479 要求的是**禁止**高风险工具，而这条路径把一切真工具都放行了：\n  ${describeReading(r)}`)
  // 承重对照：同一个进程、同一份桩，control 用**同一个** write 写成了 ⇒
  // "没写成"不是环境问题（不是工具不存在、不是路径不可写），而是这份下限拒的。
  assert.equal(r.control.exists, true,
    '对照组也没写成 ⇒ 这条读数证明不了"缺席拒了它"，只证明了"这次没人写成"')
  t.diagnostic(`absent-risk.txt(${STUB_TOOL_NAME}) 不存在；absent.txt 不存在；`
    + `同一进程的 control.txt 存在（同一个 write）。stub=${STUB_TOOL_NAME} ms=${r.elapsedMs}`)
})

guarded('★★★★ 真进程 · 拒绝理由来自这份下限，不是别的东西', async (t) => {
  const r = await scenario()
  const deniedLlms = findingsOf(r, 'llm').filter((f) => f.scenario === 'denied' && f.sawResult === true)
  assert.ok(deniedLlms.length >= 1,
    `denied 那次 Run 的工具结果没有进模型流 —— 无从归因是谁拒的：\n  ${describeReading(r)}`)
  const texts = deniedLlms.map((f) => String(f.resultText ?? '')).join(' | ')
  assert.match(texts, /hard floor/,
    `工具结果里没有下限的拒绝理由（"hard floor"）：${JSON.stringify(texts.slice(0, 300))}`)
  // ★ 被禁前缀在理由里是**规范化之后**的样子（win32 上会小写折叠），
  //   所以期望值也走产品自己的 `canonicalizePath`——手抄一份大小写就是一次会漂的对照。
  const expectedPrefix = canonicalizePath(r.denied.path, { cwd: r.cwd, platform: process.platform })
  assert.ok(texts.includes(expectedPrefix),
    `拒绝理由里没有那条被禁前缀（规范化后应为 ${expectedPrefix}），`
    + `于是"是这条规则拦的"没有字符串级对应：${JSON.stringify(texts.slice(0, 300))}`)

  const absentLlms = findingsOf(r, 'llm').filter((f) => f.scenario === 'absent' && f.sawResult === true)
  const absentTexts = absentLlms.map((f) => String(f.resultText ?? '')).join(' | ')
  // ★ 缺席那一档的理由必须同时说清**四件事**，否则审计分不开两种"被拒"：
  //   没给下限（`NOT_SUPPLIED`）、以及**两条不同名字空间**的调用都被拒
  //   （Legion 能力名的桩、真 DSH 名的 write）、依据是 §6.8:479 的发布前姿态。
  //   第二条与第三条**不能省**：省掉它们，"按 Legion 能力名名单禁"的拒绝理由
  //   与"拒绝一切"的理由在这个读数上分不开。
  assert.match(absentTexts, /RUN_FLOOR_NOT_SUPPLIED/,
    `缺席那一档的拒绝理由应当点名"没给下限"，实际：${JSON.stringify(absentTexts.slice(0, 300))}`)
  assert.match(absentTexts, new RegExp(`被拒的调用是 ${STUB_TOOL_NAME}`),
    `缺席那一档的拒绝理由没有点名 Legion 空间被拒的工具（${STUB_TOOL_NAME}）：`
    + `于是"是这条规则拦的"没有字符串级对应：${JSON.stringify(absentTexts.slice(0, 300))}`)
  assert.match(absentTexts, /被拒的调用是 write/,
    '★ 缺席那一档没有留下"低风险的**真** write 也被拒"的理由 —— 那一半才是判别项：'
    + `按 Legion 能力名名单禁的实现会给 write 一个"放行"的读数：${JSON.stringify(absentTexts.slice(0, 300))}`)
  assert.match(absentTexts, /6\.8:479/,
    '缺席那一档的拒绝理由没有点出 spec §6.8:479 的发布前姿态——'
    + `"按高风险禁"与"读不懂所以拒一切"在审计里就分不开了：${JSON.stringify(absentTexts.slice(0, 300))}`)
  assert.doesNotMatch(absentTexts, /这个 Run 的下限\*\*解释不了\*\*/,
    '缺席那一档被描述成"读不懂的下限"了 —— 那是 `refused` 的措辞，两者的修法完全不同')
  t.diagnostic('denied 理由含 hard floor 与被禁路径；absent 理由含 RUN_FLOOR_NOT_SUPPLIED'
    + ` + ${STUB_TOOL_NAME} + write + §6.8:479：${JSON.stringify(absentTexts.slice(0, 500))}`)
})

guarded('★★★★ 真进程 · 下限是按 Run 装的：它挂在那个子 Agent 上，并随 Run 撤掉', async (t) => {
  const r = await scenario()
  const started = findingsOf(r, 'run-started')
  assert.equal(started.length, SCENARIOS.length,
    `三次 Run 没有各留下一条"已起跑"读数：${JSON.stringify(started.map((f) => f.scenario))}`)
  for (const scenarioName of SCENARIOS) {
    const row = findingOf(r, 'run-started', scenarioName)
    assert.equal(row.installed, true,
      `第 ${scenarioName} 次 Run 起跑时，下限没有装在那个子 Agent 上：${JSON.stringify(row)}`)
    assert.notEqual(row.childId, null, `第 ${scenarioName} 次 Run 交回来的运行里没有 in-process 子 Agent`)
  }
  // 三个孩子是**三个不同的** Agent：同一条下限不可能"顺便"服务别人。
  const ids = started.map((f) => f.childId)
  assert.equal(new Set(ids).size, ids.length, `三次 Run 交回了同一个子 Agent：${JSON.stringify(ids)}`)
  // 结算之后那两个面被撤掉（Run 的生命周期 owns 它们）。
  for (const scenarioName of SCENARIOS) {
    assert.equal(findingOf(r, 'run-settled', scenarioName).installedAtSettle, false,
      `第 ${scenarioName} 次 Run 结算之后下限还挂在那个 Agent 上——那是一次静默泄漏`)
  }
  t.diagnostic(`三个子 Agent：${ids.map((id) => String(id).slice(0, 8)).join(',')}；结算后均已撤下`)
})

guarded('★★★ 真进程 · 探针真的跑到了尽头（不是"进程挂了所以没有副作用"）', async (t) => {
  const r = await scenario()
  assert.deepEqual(findingsOf(r, 'probe-threw').map((f) => f.error), [],
    `探针自己抛了 —— 那会读成"下限拦住了"，实际是探针没跑完：\n  ${describeReading(r)}`)
  assert.equal(findingOf(r, 'done') !== null, true,
    `探针没有走到 done（进程可能没起来）：\n  ${describeReading(r)}`)
  const port = findingsOf(r, 'port-built')
  assert.equal(port.length, 1, '生产端口没有被建出来')
  assert.equal(port[0].startRun, 'function', '端口上没有 startRun')
  t.diagnostic(`exit=${JSON.stringify(r.exit)} 读数 ${r.findings.length} 行，探针自报 done`)
})
