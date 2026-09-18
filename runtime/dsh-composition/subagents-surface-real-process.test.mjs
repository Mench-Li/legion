// runtime/dsh-composition/subagents-surface-real-process.test.mjs
// ============================================================================
// 把 PRT-211 审计里**从未被跑过**的那一面跑起来。
//
// `runtime/adapters/dsh/session-boundary.mjs` 是一份**静态源码锚点审计**。
// 它的接口面清单（`DSH_CONTINUABLE_SURFACE`，`:231-247`）主体是**进程内
// 父 agent ↔ continuable 子会话**的 `subagents` 服务——`startContinuable(:232)`、
// `sendMessage(:233)`、`interrupt(:234)`、`drainContinuableChildren(:235)`、
// `drainContinuableDescendants(:236)`、`listChildren(:237)`、`listDescendants(:238)`、
// `interruptByParent(:239)`——而它自己在 `:70` 与 `:436` 上逐字写着
// `behaviorVerified: false`：那些结论是**读**出来的，不是**跑**出来的。
//
// 本套件**不**改那份文档的任何一个字，也**不**翻转它的任何一面。
// `behaviorVerified` 仍然是 false——翻转它需要一个改那份文件的动作，
// 而那份文件是**另一层**的权威（源码锚点 + 出处核对，见 `pin-drift.mjs`）。
// 本套件是**另一层**的读数：一个真进程里真的派生、真的投递、真的打断、真的释放。
//
//   > 一条「我读了实现，所以这个面可用」的结论，
//   > 与一条「那个孩子真的出生、真的收到了消息、真的被打断」的读数，
//   > 在报告里都会写成「subagents 面可用」——
//   > 只不过前者从来没有一次 `await` 落在那个服务上。
//
// ## 这一面此前为什么没被跑：一句**字面上不成立**的话
//
// 此前的说法是「一个一次性的 `dsh --profile acp` 进程**没有父 agent**，
// 所以 `subagents.startContinuable` 在这个面上根本无从驱动」。
//
// 前半句按字面并不成立：ACP 的 `session/new` 逐字调用 `ctx.agents.create(...)`
// （`packages/acp/acp/src/session.ts:128`），于是一次 `session/new` 就在进程里
// 留下一个**活的根 agent**。本套件把这条也读出来了（见「诚实边界：ACP 那一侧」）。
//
// 但真正被漏掉的是后半句：这个面**根本不需要** ACP 侧的父 agent。
// 同一个进程里再插一行 `inject: ['subagents','agents','llm']` 的插件，
// 用 `ctx.agents.create` 现造一个父 agent，它就被驱动起来了。
//
// ## 为什么本套件能读到「孩子真的收到了」，而不只是「sendMessage 返回了 id」
//
// 桩模型（`probe-model`）是**这个进程里唯一的模型路由**，于是孩子每一轮的模型请求
// 都从这里过。每条请求上带着 `options.sessionId`——**孩子自己的会话 id**——
// 和整段对话原文。于是：
//
//   · 「消息送到了那个孩子」= 孩子那一轮的模型流里出现了**父级 mint 的 token**，
//     且这条流的 `sessionId === childId`；
//   · 「孩子真的跑出了这一轮」= 孩子自己的 durable 会话日志里出现了一条
//     **模型写下的** assistant 消息，里面就是那个 token；
//   · 「被打断」= 那条正在挂起的模型流**观察到了 abort**，且孩子的日志里那一轮
//     以 `turn/end { kind: 'aborted', reason: { kind: 'user' } }` 收尾；
//   · 「不是进程死了」= 那一轮之后 ACP 侧仍然应答请求（本套件在读数落盘后再问一次）。
//
//   > 一条「sendMessage 返回了一个 MessageId」的读数，
//   > 与一条「那个孩子真的收到了」的读数，
//   > 在投递成功与投递进了一个不存在的东西上，前半句都是绿的。
//   > 本套件要的是后半句。
//
// ## 底座：这一面靠什么才是可驱动的（都是**流程事实**，不是猜测）
//
//   · profile：`--profile acp` 的 bundle 列表是
//     `['@deepseek-ai/dsh-base','@deepseek-ai/dsh-acp-app']`
//     （`packages/boot/app-boot/src/profile.ts:106-109`），
//     而 base 挂 `@deepseek-ai/dsh-subagent` 与两个 in-process provider
//     （`providerName: spawn` / `fork`，`packages/bundle/base/cordis.patch.yml:328-339`）。
//   · ContinuableStartSpec 需要三样东西，本套件各给了一个来源：
//     一个**活着的父 Agent**（`ctx.agents.create` 现造）、
//     一个 provider（`spawn`）、一个 `request.prompt` 与 `signal`。
//   · 读数是**带外**写在子进程 cwd 之外的 JSONL（`LEGION_PROBE_FINDINGS`），
//     一行一条；进程被 kill 也不会把已落盘的读数带走。
//
// ## 为什么读数是「按内容匹配」而不是「按下标匹配」
//
// 父 agent 会在子会话结算时收到 `subagent-settled` 通知并因此**也跑自己的轮次**，
// 于是模型流的调用序列里父子轮次是**交错**的。所以每一次等待都按
// 那一轮独有的 token 去匹配——下标在两个 agent 并行时会错位，token 不会。
//
// ## 清理纪律
//
// 每一次 spawn 都用 `mkdtempSync` 现造 home/agents/cwd，且在 spawn **之前**
// 断言它们都在 temp root 之内；`after()` 无条件 kill 进程并删掉整棵 temp root，
// 失败路径也一样（不把孤儿目录留给下一个人）。
// ============================================================================

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { after, test } from 'node:test'
import { DSH_CONTINUABLE_SURFACE } from '../adapters/dsh/session-boundary.mjs'

// ★ 检出用**共享解析器**找。此前手写 `process.env.DSH_CHECKOUT`，
//   实测后果：变量没导出时本套件 **12 条全跳**，
//   CI 报 `PASS tests=12 pass=0 skipped=12`——一个"一条断言都没验过"的绿。
import { resolveDshCheckout } from '../../scripts/lib/dsh-checkout.mjs'

const DSH_FOUND = resolveDshCheckout({ need: 'cli' })
const CHECKOUT = DSH_FOUND.checkout ?? undefined
const CLI = CHECKOUT === undefined ? null : join(CHECKOUT, 'apps', 'cli', 'lib', 'bin.js')

/**
 * 条件式套件：没有可用检出时**逐条跳过**。
 * 跳过的理由是**写出来的**——一条静默的绿与一条伪装成通过的跳过是同一个东西。
 * ★ 而"写出来"这件事此前只做对了一半：那句话是**这里**手写的一个常量，
 *   它不知道检出其实在盘上（只是变量没导出）。现在理由来自解析器。
 */
const SKIP = CHECKOUT === undefined ? DSH_FOUND.reason : false

/** 条件式用例：`test()` 的第三个参数让每条用例各自的跳过理由可读。 */
const guarded = (name, fn) => test(name, { skip: SKIP, timeout: 300_000 }, fn)

const CHILD_LABEL = 'probe-continuable-child'
const SPAWN_TIMEOUT_MS = 180_000

/** 进程与目录的登记处：`after()` 从这里收尾，失败路径也走它。 */
const LIVE_CHILDREN = new Set()
const SCRATCH_DIRS = new Set()

after(() => {
  for (const child of LIVE_CHILDREN) {
    try {
      child.kill()
    } catch {
      // 已经退出就没什么可杀的；这里吞掉，收尾不该因为「已经干净」而失败。
    }
  }
  LIVE_CHILDREN.clear()
  for (const dir of SCRATCH_DIRS) rmSync(dir, { recursive: true, force: true })
  SCRATCH_DIRS.clear()
})

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

/** 在 `os.tmpdir()` 下现造一个目录，并在返回前断言它**没有跑出** temp root。 */
function makeTemp(prefix) {
  const base = resolve(tmpdir())
  const dir = resolve(mkdtempSync(join(base, prefix)))
  if (!dir.startsWith(base + sep)) throw new Error(`临时目录跑到 temp root 之外了：${dir}`)
  return dir
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── 探针模块的源码 ────────────────────────────────────────────────────────────
//
// 这段是可行性探针的**逐字节**源码：先在仓库外把它跑通（真进程里真的
// `startContinuable`、真的投递、真的打断），确认读数稳定之后才原样内联到这里。
//
// 它必须对这个模板字面量**透明**：没有反引号（会提前终止）、没有 `${`（会被插值）、
// 也没有反斜杠（会被当转义）。模块里那两处换行因此写成 `String.fromCharCode(10)`——
// 这不是风格，是一次实测踩到的坑：`'\n'` 会被这个模板字面量变成一个真的换行符，
// 写出去的模块当场 SyntaxError，而 `node --check` 检查的是**本文件**，它照样是绿的。
const MODULE_SRC = `
// 进程内探针：在真 DSH 进程里真的把 'subagents' 那个面驱动起来。
//
// 它做四件「读源码」做不到的事：
//   ① 用 'ctx.agents.create' 真的造出一个**活着的父 agent**——continuable 派生的前置条件，
//      也正是此前「没有父 agent 所以这个面跑不了」那句话里缺的那一块；
//   ② 'startContinuable' 真的派生一个 continuable 子会话，并把 childId 记下来；
//   ③ 一个只供应模型流的桩，让那个孩子的**每一轮**都在这里留下「自己的会话 id + 原文」，
//      于是「消息送到了孩子那里」有了一条出自**孩子自己那一轮**的读数，
//      而不是一条「sendMessage 返回了一个 MessageId」；
//   ④ 打断、列举、ownership、drain 各留一条读数，而不是一条 typeof === 'function'。
//
//   > 一条「服务在、八个方法都是 function」的结论，
//   > 与一条「那个孩子真的出生、真的收到消息、真的被打断」的读数，
//   > 在报告里都写成「这个面可用」——只不过前者一次 await 都没有过。
//
// 纪律：读数只取 leaf 字段（会话 id、句子、枚举），不搬 Agent/Session 活对象；
// 每一次「等待」都按**内容**匹配（token 唯一），不按下标，于是父级的穿插轮次不会错位。
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export const name = 'probe-drive-subagents'
export const inject = ['subagents', 'agents', 'llm']

const FINDINGS = process.env.LEGION_PROBE_FINDINGS
const PROVIDER = 'probe-model'
const MODEL = 'probe-model'
const HOLD = 'PROBE_HOLD'
const HOLD_MS = 5000
const CHILD_LABEL = 'probe-continuable-child'
const TOKEN_RE = /PROBE_TOKEN_[0-9A-F]{8}/g

/** 每一次模型流的现场读数。 */
const calls = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const mint = () => 'PROBE_TOKEN_' + randomUUID().slice(0, 8).toUpperCase()

function record(fields) {
  if (FINDINGS === undefined) return
  try {
    appendFileSync(FINDINGS, JSON.stringify({ at: Date.now(), ...fields }) + String.fromCharCode(10), 'utf8')
  } catch {
    // 写不出读数就没法判读；静默会让「探针没跑」看起来像「读数全绿」。
    process.stderr.write('probe-drive: 写读数失败' + String.fromCharCode(10))
  }
}

function describe(error) {
  if (error === null || error === undefined) return { text: String(error) }
  const out = { name: String(error.name ?? 'unknown'), message: String(error.message ?? error) }
  if (error.code !== undefined) out.code = String(error.code)
  return out
}

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: describe(error) }
  }
}

/** 摊平一条 listing 行：只取 leaf 字段，不整对象搬运。 */
function rowOf(entry) {
  return {
    kind: entry.kind,
    id: String(entry.id),
    mode: entry.mode,
    label: entry.label,
    activity: entry.activity,
    hasChildren: entry.hasChildren,
    depth: entry.depth,
    parentId: entry.parentId === undefined ? undefined : String(entry.parentId),
    reason: entry.reason,
  }
}

function rowsOf(entries) {
  return entries.map(rowOf)
}

/** 轮询等一次「带着这个 token 的模型流」出现——按内容匹配，不按下标匹配。 */
async function waitForCall(token, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = calls.find((call) => call.text.includes(token))
    if (found !== undefined) return found
    await sleep(20)
  }
  return null
}

async function waitForFinished(token, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = calls.find((call) => call.text.includes(token)
      && (call.finishedAt !== null || call.aborted))
    if (found !== undefined) return found
    await sleep(20)
  }
  return null
}

/** 轮询等一个孩子**从注册表里消失**（= 它的 Activation 被释放了）。 */
async function waitForNotLive(ctx, childId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ctx.agents.get(childId) === undefined) return true
    await sleep(25)
  }
  return ctx.agents.get(childId) === undefined
}

/**
 * 这一轮是「挂住」还是「回声」？
 *
 * 判据不看**最后一条消息**：子会话的对话里还有父级插件塞进来的
 * 「Current runtime context」段落，它排在用户提示后面，于是「最后一条」
 * 根本不是这一轮的提示。真正稳定的判据是**整段对话里最后出现的那个标记**——
 * 历史只增不减，最后一个 'PROBE_HOLD ' 与最后一个 'PROBE_ECHO ' 谁更靠后，
 * 就是这一轮的身份。
 */
function turnKindOf(text) {
  const holdAt = text.lastIndexOf(HOLD + ' ')
  const echoAt = text.lastIndexOf('PROBE_ECHO ')
  if (holdAt < 0) return 'echo'
  return holdAt > echoAt ? 'hold' : 'echo'
}

/** 把一次模型请求的对话摊成 "role:text" 行。 */
function collectText(options) {
  const parts = []
  for (const message of options.messages) {
    let text = ''
    for (const block of message.content) {
      if (block.type === 'text') text += block.text
    }
    parts.push(message.role + ':' + text)
  }
  return parts.join(String.fromCharCode(10))
}

/** 本轮提示的原文（最后一条消息）——用来判断这一轮是不是要挂住。 */
function lastTextOf(options) {
  const last = options.messages.length === 0 ? undefined : options.messages[options.messages.length - 1]
  if (last === undefined) return ''
  let text = ''
  for (const block of last.content) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** 最后一条消息的来源 kind（用来把「子会话结算通知」这种穿插轮次认出来）。 */
function sourceKindOf(options) {
  const last = options.messages.length === 0 ? undefined : options.messages[options.messages.length - 1]
  if (last === undefined) return 'none'
  const source = last.source
  if (source === undefined || source === null) return 'none'
  return typeof source.kind === 'string' ? source.kind : 'unshaped'
}

class ProbeAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }],
        defaultEffort: ReasoningEffortId('off'),
      },
    }
  }

  async *stream(options) {
    const text = collectText(options)
    const current = lastTextOf(options)
    const rec = {
      sessionId: String(options.sessionId ?? ''),
      provider: String(options.provider),
      model: String(options.model),
      messageCount: options.messages.length,
      lastSource: sourceKindOf(options),
      text: text.slice(0, 8000),
      hold: turnKindOf(text) === 'hold',
      startedAt: Date.now(),
      finishedAt: null,
      aborted: false,
      abortedAt: null,
    }
    calls.push(rec)
    record({
      phase: 'llm-call',
      sessionId: rec.sessionId,
      hold: rec.hold,
      hasSignal: options.signal !== undefined,
      abortedAtStart: options.signal === undefined ? null : options.signal.aborted,
      messageCount: rec.messageCount,
      lastSource: rec.lastSource,
      tail: current.slice(0, 90),
    })

    if (rec.hold) {
      // 挂住这一轮是打断类读数的承重件：没人打断它时它 5 秒后自己放开，
      // 于是「没观察到 abort」是一条**读数**，而不是一个挂死的进程。
      const signal = options.signal
      const aborted = new Promise((resolve) => {
        if (signal === undefined) return
        // abort 读数在**监听器里**就落定，不依赖这个生成器之后有没有被 resume：
        // 消费方可能已经放弃迭代，「没被 resume」与「没被 abort」是两件事。
        const mark = () => {
          rec.aborted = true
          rec.abortedAt = Date.now()
          rec.finishedAt = Date.now()
          resolve(true)
        }
        if (signal.aborted) {
          mark()
          return
        }
        signal.addEventListener('abort', mark, { once: true })
      })
      const outcome = await Promise.race([aborted, sleep(HOLD_MS).then(() => false)])
      record({ phase: 'llm-hold-outcome', sessionId: rec.sessionId, holdAborted: rec.aborted, outcome })
      rec.aborted = rec.aborted || outcome === true
      rec.abortedAt = rec.aborted ? (rec.abortedAt ?? Date.now()) : null
      rec.finishedAt = rec.finishedAt ?? Date.now()
      if (rec.aborted) return
      const held = 'PROBE_HELD_TO_COMPLETION'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: held }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: held } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    // 回声里带**本轮的** token（取最后一次出现），于是这个孩子的会话日志里
    // 会出现一条**模型自己写下的**、含该 token 的 assistant 消息。
    const matches = text.match(TOKEN_RE) ?? []
    const echo = matches.length === 0 ? 'NO_TOKEN' : matches[matches.length - 1]
    const reply = 'PROBE_REPLY ' + echo + ' msgs=' + options.messages.length
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
    rec.finishedAt = Date.now()
  }
}

/** 造一个活着的父 agent；agent 工厂可能比本行晚一步注册，所以按错误重试。 */
async function createParent(ctx, parentId, cwd) {
  let lastError
  for (let index = 0; index < 60; index += 1) {
    try {
      const handle = await ctx.agents.create({
        sessionId: parentId,
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

/** 等一条已挂住的回合，跑一个打断动作，再等那条回合真的观察到 abort。 */
async function abortHeld(ctx, childId, token, action) {
  const started = await waitForCall(token, 20000)
  if (started === null) return { holdStarted: false, aborted: false }
  const holder = ctx.agents.get(childId)
  const residentBefore = holder !== undefined
  record({
    phase: 'abort-held-begin',
    token,
    sessionId: started.sessionId,
    residentBefore,
    status: holder === undefined ? null : String(holder.status),
  })
  const result = await action()
  const finished = await waitForFinished(token, 25000)
  return {
    holdStarted: true,
    residentBefore,
    action: result,
    aborted: finished !== null && finished.aborted,
    abortMs: finished === null || finished.abortedAt === null ? null : finished.abortedAt - started.startedAt,
  }
}

/** 送一条「挂住」的消息并把它打断：一条完整的 hold 回合读数。 */
async function holdAndAbort(ctx, parent, childId, token, signal, action) {
  const sent = await attempt(() => ctx.subagents.sendMessage(
    parent,
    childId,
    [{ type: 'text', text: HOLD + ' ' + token }],
    { signal },
  ))
  if (!sent.ok) return { sent, holdStarted: false, aborted: false, messageId: null }
  const held = await abortHeld(ctx, childId, token, action)
  return { sent, messageId: String(sent.value), ...held }
}

async function drive(ctx) {
  const cwd = process.cwd()
  const parentId = randomUUID()
  const strangerId = randomUUID()
  record({
    phase: 'begin',
    parentId,
    strangerId,
    cwd,
    providers: ctx.subagents.list(),
    serviceKeys: Object.keys(ctx.subagents).sort(),
  })

  const parent = await createParent(ctx, parentId, cwd)
  record({
    phase: 'parent-created',
    parentId: String(parent.id),
    live: ctx.agents.get(parent.id) === parent,
    parentSession: parent.session.header.parentSession === undefined
      ? null
      : String(parent.session.header.parentSession),
  })

  // ── ① 派生：初始提示本身是一条**挂住**的提示，于是孩子在读列举/ownership 时必定在册 ──
  const token0 = mint()
  const controller = new AbortController()
  const started = await attempt(() => ctx.subagents.startContinuable({
    provider: 'spawn',
    label: CHILD_LABEL,
    request: {
      prompt: [{ type: 'text', text: HOLD + ' ' + token0 }],
      parent,
      agentOptions: { provider: PROVIDER, model: MODEL },
    },
    signal: controller.signal,
  }))
  record({ phase: 'start-continuable', token: token0, ok: started.ok, value: started.value, error: started.error })
  if (!started.ok) {
    record({ phase: 'done', verdict: 'startContinuable 失败——可行性到此为止' })
    return
  }
  const childId = String(started.value.childId)
  const initialMessageId = String(started.value.messageId)

  const childAgent = ctx.agents.get(childId)
  let enterCollision = 'not-attempted'
  if (childAgent !== undefined) {
    try {
      ctx.agents.enter(childAgent, parent)
      enterCollision = 'returned-without-throwing'
    } catch (error) {
      enterCollision = String(error && error.message)
    }
  }
  record({
    phase: 'child-established',
    childId,
    initialMessageId,
    uuidShaped: /^[0-9a-f-]{36}$/i.test(childId),
    liveAgent: childAgent !== undefined,
    liveAgentId: childAgent === undefined ? null : String(childAgent.id),
    isOwnedByParent: childAgent === undefined ? null : ctx.agents.isOwnedBy(childId, parent),
    isOwnedByStranger: childAgent === undefined
      ? null
      : ctx.agents.isOwnedBy(childId, { id: strangerId }),
    childParentSession: childAgent === undefined
      ? null
      : (childAgent.session.header.parentSession === undefined
        ? null
        : String(childAgent.session.header.parentSession)),
    enterCollision,
  })

  const residentListing = await attempt(() => ctx.subagents.listChildren(parent.id))
  record({
    phase: 'listing-while-resident',
    ok: residentListing.ok,
    rows: residentListing.ok ? rowsOf(residentListing.value) : null,
    error: residentListing.error,
    childLive: ctx.agents.get(childId) !== undefined,
  })

  // ── ② 初始提示真的进了孩子**自己那一轮**的模型流 ──
  const initialHeld = await abortHeld(ctx, childId, token0, async () => {
    const wrongAuthority = await attempt(() => ctx.subagents.interrupt(
      childId,
      { kind: 'user', parentSessionId: strangerId },
    ))
    const rightAuthority = await attempt(() => ctx.subagents.interrupt(
      childId,
      { kind: 'user', parentSessionId: parent.id },
    ))
    return { wrongAuthority, rightAuthority }
  })
  record({
    phase: 'initial-prompt-and-interrupt',
    token: token0,
    holdStarted: initialHeld.holdStarted,
    residentBefore: initialHeld.residentBefore,
    wrongAuthority: initialHeld.action?.wrongAuthority ?? null,
    rightAuthority: initialHeld.action?.rightAuthority ?? null,
    aborted: initialHeld.aborted,
    abortMs: initialHeld.abortMs,
  })

  // 打断之后，那个 Activation 会自然结算并释放；等它真的从注册表消失，
  // 这样下一条投递读到的是**冷启动**，而不是「碰巧还驻留」。
  const settledAfterInterrupt = await waitForNotLive(ctx, childId, 10000)
  const settledListing = await attempt(() => ctx.subagents.listChildren(parent.id))
  record({
    phase: 'listing-after-settle',
    settledAfterInterrupt,
    ok: settledListing.ok,
    rows: settledListing.ok ? rowsOf(settledListing.value) : null,
    error: settledListing.error,
    childLive: ctx.agents.get(childId) !== undefined,
  })

  // ── ③ 投递：父级 mint 的 token 必须出现在孩子那一轮的模型流里 ──
  const token1 = mint()
  const residentBeforeSend = ctx.agents.get(childId) !== undefined
  const sent = await attempt(() => ctx.subagents.sendMessage(
    parent,
    childId,
    [{ type: 'text', text: 'PROBE_ECHO ' + token1 }],
    { signal: controller.signal },
  ))
  const childTurn = sent.ok ? await waitForFinished(token1, 30000) : null
  record({
    phase: 'send-message',
    token: token1,
    ok: sent.ok,
    messageId: sent.ok ? String(sent.value) : null,
    error: sent.error,
    residentBeforeSend,
    childTurnSeen: childTurn !== null,
    childTurnSessionId: childTurn === null ? null : childTurn.sessionId,
    childTurnSessionIsChild: childTurn === null ? null : childTurn.sessionId === childId,
    childTurnMessageCount: childTurn === null ? null : childTurn.messageCount,
    childTurnEchoed: childTurn === null ? null : (childTurn.text.match(TOKEN_RE) ?? []).at(-1) ?? null,
  })

  // ── ④ 列举：真父级 vs 不存在的父级 ──
  const listParent = await attempt(() => ctx.subagents.listChildren(parent.id))
  const listGhost = await attempt(() => ctx.subagents.listChildren(strangerId))
  const descParent = await attempt(() => ctx.subagents.listDescendants(parent.id))
  const descGhost = await attempt(() => ctx.subagents.listDescendants(strangerId))
  record({
    phase: 'listing',
    parent: listParent.ok ? rowsOf(listParent.value) : null,
    parentError: listParent.error,
    ghost: listGhost.ok ? rowsOf(listGhost.value) : null,
    ghostError: listGhost.error,
    descendants: descParent.ok ? rowsOf(descParent.value) : null,
    descendantsError: descParent.error,
    descendantsGhost: descGhost.ok ? rowsOf(descGhost.value) : null,
    descendantsGhostError: descGhost.error,
  })

  // ── ⑤ interruptByParent（浏览器面）：负对照 + 受理回执 + 真打断 ──
  const token2 = mint()
  const holdB = await holdAndAbort(ctx, parent, childId, token2, controller.signal, async () => {
    const wrongParent = await attempt(() => ctx.subagents.interruptByParent(childId, strangerId, 'continuable'))
    const rightParent = await attempt(() => ctx.subagents.interruptByParent(childId, parent.id, 'continuable'))
    return { wrongParent, rightParent }
  })
  record({ phase: 'interrupt-by-parent', token: token2, ...holdB })

  // ── ⑥ drainContinuableChildren：释放选中的直系子会话 ──
  const token3 = mint()
  const holdC = await holdAndAbort(ctx, parent, childId, token3, controller.signal, async () => {
    const before = await attempt(() => ctx.subagents.listChildren(parent.id))
    const liveBefore = ctx.agents.get(childId) !== undefined
    const drained = await attempt(() => ctx.subagents.drainContinuableChildren(parent, [childId]))
    const after = await attempt(() => ctx.subagents.listChildren(parent.id))
    const absent = await attempt(() => ctx.subagents.drainContinuableChildren(parent, [randomUUID()]))
    return {
      listingWhileResident: before.ok ? rowsOf(before.value) : null,
      listingWhileResidentError: before.error,
      liveBefore,
      drained,
      liveAfter: ctx.agents.get(childId) !== undefined,
      listingAfterDrain: after.ok ? rowsOf(after.value) : null,
      listingAfterDrainError: after.error,
      drainAbsentChild: absent,
    }
  })
  record({ phase: 'drain-children', token: token3, ...holdC })

  // ── ⑦ drainContinuableDescendants：冷启动一次，再整棵释放，并证明准入真的关了 ──
  const token4 = mint()
  const holdD = await holdAndAbort(ctx, parent, childId, token4, controller.signal, async () => {
    const coldResumed = ctx.agents.get(childId) !== undefined
    const drained = await attempt(() => ctx.subagents.drainContinuableDescendants([parent]))
    const listing = await attempt(() => ctx.subagents.listChildren(parent.id))
    const closed = await attempt(() => ctx.subagents.sendMessage(
      parent,
      childId,
      [{ type: 'text', text: 'PROBE_ECHO ' + mint() }],
      { signal: controller.signal },
    ))
    return {
      coldResumed,
      drained,
      liveAfter: ctx.agents.get(childId) !== undefined,
      listingAfterDrain: listing.ok ? rowsOf(listing.value) : null,
      listingAfterDrainError: listing.error,
      sendAfterScopedDrain: closed,
    }
  })
  record({ phase: 'drain-descendants', token: token4, ...holdD })

  const live = ctx.agents.list()
  record({
    phase: 'live-agents',
    count: live.length,
    agents: live.map((agent) => ({
      id: String(agent.id),
      parentSession: agent.session.header.parentSession === undefined
        ? null
        : String(agent.session.header.parentSession),
      provider: agent.options.provider === undefined ? null : String(agent.options.provider),
      model: agent.options.model === undefined ? null : String(agent.options.model),
    })),
    calls: calls.map((call) => ({
      sessionId: call.sessionId,
      hold: call.hold,
      aborted: call.aborted,
      messageCount: call.messageCount,
      lastSource: call.lastSource,
      lastToken: (call.text.match(TOKEN_RE) ?? []).at(-1) ?? null,
    })),
  })

  // 等一个**外来**的活 agent：ACP 侧的 session/new 会造一个活的根会话。
  // 「一次性的 ACP 进程里没有父 agent」这句话需要一个读数，而不是一句推断——
  // 而 session/new 逐字调用 ctx.agents.create，于是进程里确实多了一个活 agent。
  // 注意：本套件**不依赖**它，父 agent 是下面那个探针自己造的。
  const foreignWaitStart = Date.now()
  const foreignDeadline = foreignWaitStart + 8000
  let foreign = []
  while (Date.now() < foreignDeadline) {
    foreign = ctx.agents.list().filter((agent) => String(agent.id) !== String(parent.id))
    if (foreign.length > 0) break
    await sleep(100)
  }
  record({
    phase: 'foreign-agents',
    waitedMs: Date.now() - foreignWaitStart,
    agents: foreign.map((agent) => ({
      id: String(agent.id),
      parentSession: agent.session.header.parentSession === undefined
        ? null
        : String(agent.session.header.parentSession),
      provider: agent.options.provider === undefined ? null : String(agent.options.provider),
      model: agent.options.model === undefined ? null : String(agent.options.model),
    })),
  })

  record({ phase: 'done', verdict: 'startContinuable 真的跑通了' })
}

export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new ProbeAdapter())
  record({ phase: 'activated', provider: PROVIDER })
  void drive(ctx).catch((error) => {
    record({ phase: 'fatal', error: describe(error) })
  })
}
`

// ── 一次性 profile ───────────────────────────────────────────────────────────
// 只有桩模型、没有真凭证、没有真 profile：`DSH_HOME` 指向这次现造的 temp home，
// `--patch` 指向这次现写的 overlay，绝不碰 `~/.dsh`。
const OVERLAY = [
  '# 桩模型：本进程里唯一可达的模型路由。',
  '- id: acp',
  '  config:',
  '    provider: probe-model',
  '    model: probe-model',
  '',
  '# 会话标题与包清单会额外发模型请求；关掉它们，让「孩子那一轮」是唯一的轮次来源。',
  '- id: session-title-llm',
  '  disabled: true',
  '',
  '- id: plugin-package-inventory-deepseek',
  '  disabled: true',
  '',
  '# 会话日志落在这一次的临时 home 里，不压缩（读数是按行 JSON）。',
  '- id: session-persistence-jsonl',
  '  config:',
  "    root: !!js dshHomePath('sessions')",
  '    compression: none',
  '',
  '# 探针行：注入 subagents/agents/llm，自己造父 agent，把这一面真的驱动起来。',
  '- insert:',
  '    - id: probe-drive-subagents',
  "      name: './probe-drive.mjs'",
  '',
].join('\n')

const PROFILE_PACKAGE = JSON.stringify({
  name: 'dsh-profile-acp',
  private: true,
  dependencies: {},
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
      patchReload: 'startup',
    },
  },
}, undefined, 2) + '\n'

// ── ACP 客户端：够用就好（newline-delimited JSON，一行一条） ─────────────────
class AcpClient {
  constructor(child) {
    this.child = child
    this.requestId = 0
    this.pending = new Map()
    this.serverRequests = []
    this.stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { this.stderr += chunk })
    const reader = createInterface({ input: child.stdout })
    reader.on('line', (line) => { this.onLine(line) })
    this.exited = new Promise((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
  }

  get exitCode() {
    return this.child.exitCode
  }

  onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method === undefined && message.id !== undefined) {
      const settle = this.pending.get(message.id)
      if (settle !== undefined) {
        this.pending.delete(message.id)
        settle(message)
      }
      return
    }
    if (message.method === undefined) return
    if (message.id === undefined) return
    // 服务端 → 客户端的**请求**（审批口就是这个形状）。桩模型从不发工具调用，
    // 所以本套件预期一条都收不到；真收到就记下来并明确拒绝，别把对面挂住。
    this.serverRequests.push({ method: message.method, params: message.params })
    this.child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `legion 探针不回答服务端请求：${message.method}` },
    }) + '\n')
  }

  request(method, params, timeoutMs = 30_000) {
    const id = ++this.requestId
    const settled = new Promise((resolveResponse) => { this.pending.set(id, resolveResponse) })
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return withTimeout(settled, timeoutMs, `ACP 请求 ${method} 没有在 ${timeoutMs}ms 内应答`)
  }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (error) => { clearTimeout(timer); rejectPromise(error) },
    )
  })
}

// ── 读数的读法 ───────────────────────────────────────────────────────────────
function readFindings(path) {
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 正在写的那一行；下一次轮询再读。
    }
  }
  return out
}

async function waitForFindings(path, client, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lines = readFindings(path)
    if (lines.some((line) => line.phase === 'done')) return lines
    if (lines.some((line) => line.phase === 'fatal')) return lines
    if (client.exitCode !== null) break
    await sleep(100)
  }
  return readFindings(path)
}

function readJsonl(path) {
  if (!existsSync(path)) return []
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 尾部半行；下一次轮询再读。
    }
  }
  return out
}

async function waitForRecords(path, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let records = readJsonl(path)
  while (Date.now() < deadline && !predicate(records)) {
    await sleep(100)
    records = readJsonl(path)
  }
  return records
}

/** 会话日志的布局：`<home>/sessions/<cwd 摘要>/<sessionId>/session.v3.jsonl`。 */
function sessionLogFiles(home) {
  const root = join(home, 'sessions')
  const found = new Map()
  if (!existsSync(root)) return found
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path, depth + 1)
        continue
      }
      if (!entry.name.endsWith('.jsonl')) continue
      found.set(basename(dirname(path)), path)
    }
  }
  walk(root, 0)
  return found
}

const countOf = (records, type) => records.filter((record) => record.type === type).length
const userText = (record) => (record.data?.content ?? [])
  .filter((block) => block.type === 'text').map((block) => block.text).join('')
const assistantText = (record) => (record.data?.message?.content ?? [])
  .filter((block) => block.type === 'text').map((block) => block.text).join('')
const turnEndReasons = (records) => records
  .filter((record) => record.type === 'turn/end').map((record) => record.data?.reason)

// ── 一次真进程，一套读数 ─────────────────────────────────────────────────────
let scenarioPromise = null
const scenario = () => (scenarioPromise ??= runScenario())

async function runScenario() {
  const root = makeTemp('legion-subagents-')
  SCRATCH_DIRS.add(root)
  const home = join(root, 'home')
  const agentsHome = join(root, 'agents')
  const cwd = join(root, 'cwd')
  const profileDir = join(home, 'profiles', 'acp')
  const findingsPath = join(root, 'findings.jsonl')

  for (const dir of [home, agentsHome, cwd]) {
    mkdirSync(dir, { recursive: true })
    // spawn **之前**先断言：三个目录都在这次 temp root 之内。
    assert.ok(dir.startsWith(root + sep), `spawn 之前目录就跑出 temp root 了：${dir}`)
  }
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'probe-drive.mjs'), MODULE_SRC, 'utf8')
  writeFileSync(join(profileDir, 'package.json'), PROFILE_PACKAGE, 'utf8')
  writeFileSync(join(profileDir, 'overlay.yml'), OVERLAY, 'utf8')

  const env = { ...process.env }
  // 不把宿主 harness 的会话、快照、Web、凭证继承给子进程。
  for (const name of ['DSH_SNAPSHOT', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) {
    delete env[name]
  }
  Object.assign(env, {
    DSH_HOME: home,
    DSH_AGENTS_HOME: agentsHome,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: 'danger-full-access',
    LEGION_PROBE_FINDINGS: findingsPath,
  })

  const startedAt = Date.now()
  const child = spawn(process.execPath, [
    CLI, '--profile', 'acp', '--patch', join(profileDir, 'overlay.yml'),
  ], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  LIVE_CHILDREN.add(child)
  const client = new AcpClient(child)
  const wallClock = { timedOut: false }
  const watchdog = setTimeout(() => {
    wallClock.timedOut = true
    try {
      child.kill()
    } catch {
      // 收尾路径；杀不动也要继续往下走，让读数自己说话。
    }
  }, SPAWN_TIMEOUT_MS - 20_000)

  try {
    const initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    }, 60_000)
    assert.equal(initialized.error, undefined, `ACP initialize 报错：${JSON.stringify(initialized.error)}`)

    // ACP 侧真的开一个会话——这一条**不是**本套件驱动 subagents 面的前提，
    // 而是「ACP 进程里没有父 agent」那句话的对照读数（见最后两条用例）。
    const created = await client.request('session/new', { cwd, mcpServers: [] }, 60_000)
    const acpSessionId = created.result?.sessionId ?? null

    const lines = await waitForFindings(findingsPath, client, 120_000)

    // 读数落盘之后再问一次 ACP：三次打断 + 两次 drain 之后，这个进程还在服务吗？
    // 先开一个新会话（还"能干新的活"），再问一次列表（读路径也还通）。
    // 注意 `session/list` 会**过滤掉活着的会话**（`packages/acp/acp/src/index.ts:304-313`
    // 逐字判 `sessions.has(header.id) || ctx.sessions.get(header.id) !== undefined`），
    // 所以它返回空表是**对的**，不是"进程出问题了"——本用例只拿"它应答了"当存活读数。
    let liveness
    try {
      const reopened = await client.request('session/new', { cwd, mcpServers: [] }, 30_000)
      const listed = await client.request('session/list', {}, 30_000)
      liveness = {
        ok: true,
        postDriveSessionId: reopened.result?.sessionId ?? null,
        sessions: Array.isArray(listed.result?.sessions) ? listed.result.sessions : null,
        error: null,
      }
    } catch (error) {
      liveness = {
        ok: false,
        postDriveSessionId: null,
        sessions: null,
        error: String(error?.message ?? error),
      }
    }

    const phases = new Map()
    for (const line of lines) phases.set(line.phase, line)
    const started = phases.get('start-continuable')
    const fatal = phases.get('fatal')

    return {
      lines,
      phases,
      root,
      home,
      findingsPath,
      acpSessionId,
      liveness,
      wallClock,
      elapsedMs: Date.now() - startedAt,
      serverRequests: client.serverRequests,
      stderr: client.stderr,
      childId: started?.value?.childId ?? null,
      initialMessageId: started?.value?.messageId ?? null,
      parentId: phases.get('begin')?.parentId ?? null,
      logFiles: sessionLogFiles(home),
      notes: (fatal === undefined
        ? `读数 ${lines.length} 条，最后一条 [${[...phases.keys()].at(-1)}]`
        : `探针写下 fatal：${JSON.stringify(fatal.error)}`)
        + ` exit=${JSON.stringify(await Promise.race([client.exited, sleep(0).then(() => 'still-running')]))}`
        + ` stderr=${client.stderr.slice(-800)}`,
    }
  } finally {
    clearTimeout(watchdog)
    try {
      child.stdin.end()
    } catch {
      // 已经退出。
    }
    await Promise.race([client.exited, sleep(5000)])
    try {
      child.kill()
    } catch {
      // 已经退出。
    }
    LIVE_CHILDREN.delete(child)
  }
}

// ── 断言用的取数小工具 ───────────────────────────────────────────────────────
function recordOf(r, phase) {
  const found = r.phases.get(phase)
  assert.ok(found !== undefined, `读数里没有 [${phase}] 这一条：${r.notes}`)
  return found
}

function requireChildId(r) {
  const started = recordOf(r, 'start-continuable')
  assert.equal(started.ok, true,
    `startContinuable 没有跑通，后面的读数都无从谈起：${JSON.stringify(started.error ?? null)}`)
  assert.match(String(r.childId), UUID_RE, `childId 不是会话 id 的形状：${String(r.childId)}`)
  return String(r.childId)
}

async function childLogFile(r, timeoutMs = 15_000) {
  const childId = requireChildId(r)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const files = sessionLogFiles(r.home)
    if (files.has(childId)) return files.get(childId)
    await sleep(100)
  }
  assert.fail(`孩子的 durable 会话日志没有出现：${r.home} 的 sessions 下没有以 ${childId} 命名的一份`)
}

function diagnose(t, r) {
  t.diagnostic(`进程 ${r.elapsedMs}ms exit=${r.wallClock.timedOut ? 'watchdog-kill' : 'clean'} `
    + `读数=${r.lines.length} 条 acpSession=${String(r.acpSessionId).slice(0, 8)} `
    + `liveness=${r.liveness.ok ? 'alive' : `dead(${r.liveness.error})`} `
    + `serverRequests=${r.serverRequests.length}`)
}

// ── 用例 ─────────────────────────────────────────────────────────────────────

guarded('★★★★★ startContinuable 真的建立了一个 durable continuable 子会话', async (t) => {
  const r = await scenario()
  diagnose(t, r)
  const childId = requireChildId(r)
  assert.match(String(r.initialMessageId), UUID_RE, 'startContinuable 没有给出初始提示的 MessageId')

  const established = recordOf(r, 'child-established')
  assert.equal(established.liveAgent, true, '那个 childId 在 agents 注册表里没有对应的活 agent')
  assert.equal(established.liveAgentId, childId, '活 agent 的 id 与 startContinuable 给的 childId 不是同一个')
  assert.equal(established.childParentSession, r.parentId,
    '孩子会话的 durable parentSession 不是那个父 agent——那就不是"这个父级的子会话"')
  assert.equal(established.uuidShaped, true)

  // 列举与事实一致：它是一条 continuable、带 label 的 direct child，且此刻在册。
  const resident = recordOf(r, 'listing-while-resident')
  assert.equal(resident.ok, true, `孩子在册时的列举就报错了：${JSON.stringify(resident.error ?? null)}`)
  const row = resident.rows.find((entry) => entry.id === childId)
  assert.ok(row !== undefined, `listChildren 没有列出刚建立的孩子：${JSON.stringify(resident.rows)}`)
  assert.equal(row.kind, 'child')
  assert.equal(row.mode, 'continuable', '列出来的不是 continuable 模式')
  assert.equal(row.label, CHILD_LABEL)
  assert.equal(row.activity, 'running', '孩子此刻应当在册（running）')
  assert.equal(row.hasChildren, false)

  // durable：它有一份自己的会话日志，而且目录名就是 childId。
  const logFile = await childLogFile(r)
  assert.ok(logFile.startsWith(r.home + sep), '会话日志跑出了这次 temp home')
  t.diagnostic(`childId=${childId} 会话日志=${logFile.slice(logFile.indexOf('sessions'))}`
    + ` 字节=${statSync(logFile).size}`)
})

guarded('★★★★★ childId 跨 Activation 稳定：一个已释放的 Activation 之后，同一个 id 又被冷启动跑出下一轮', async (t) => {
  const r = await scenario()
  diagnose(t, r)
  const childId = requireChildId(r)

  // ① 第一轮被打断后，Activation 自然结算、从注册表里消失。
  const settled = recordOf(r, 'listing-after-settle')
  assert.equal(settled.settledAfterInterrupt, true, '打断之后那个 Activation 一直没有被释放')
  assert.equal(settled.childLive, false, 'Activation 应当已经释放，但那个 agent 还在注册表里')
  const inactiveRow = settled.rows.find((entry) => entry.id === childId)
  assert.ok(inactiveRow !== undefined,
    'Activation 释放之后孩子从列举里消失了——但它的身份是 **durable** 的，不该消失')
  assert.equal(inactiveRow.activity, 'inactive', '释放之后列举应当读成 inactive')

  // ② 同一个 childId 的再一次投递：这一次是**冷启动**，而它跑出来了。
  const send = recordOf(r, 'send-message')
  assert.equal(send.residentBeforeSend, false,
    '这一条要读的是冷启动：投递那一刻孩子必须不在册（否则读到的是"碰巧还驻留"）')
  assert.equal(send.childTurnSessionIsChild, true,
    '第二轮模型流上的会话 id 不是那个 childId——那意味着换了一个会话，而不是同一个继续')
  assert.equal(send.childTurnSessionId, childId)

  // ③ 又一次冷启动（最后一个 hold 轮），仍是同一个 id。
  const descendants = recordOf(r, 'drain-descendants')
  assert.equal(descendants.action?.coldResumed, true, 'drain 之前那一次冷启动没有把它拉起来')

  // ④ durable 层面的同一性：一份日志、一个 header、五轮都在里面。
  const logFile = await childLogFile(r)
  const records = await waitForRecords(logFile, (all) => countOf(all, 'turn/end') >= 5)
  assert.equal(countOf(records, 'session'), 1,
    '同一个 childId 下出现了不止一个 session header——那不是"一个 durable 会话"，是几段拼接')
  assert.ok(countOf(records, 'turn/start') >= 5,
    `孩子至少跑了 5 轮（初始/投递/打断/两次 drain），实际 turn/start=${countOf(records, 'turn/start')}`)
  t.diagnostic(`同一份日志里 turn/start=${countOf(records, 'turn/start')}`
    + ` turn/end=${countOf(records, 'turn/end')} session header=${countOf(records, 'session')}`)
})

guarded('★★★★★ sendMessage 真的送到了那个孩子：孩子那一轮的模型流带着父级 mint 的 token，日志里也有那个 messageId', async (t) => {
  const r = await scenario()
  diagnose(t, r)
  const childId = requireChildId(r)
  const send = recordOf(r, 'send-message')

  assert.equal(send.ok, true, `sendMessage 报错：${JSON.stringify(send.error ?? null)}`)
  assert.match(String(send.messageId), UUID_RE, 'sendMessage 没有给出 MessageId')

  // ① 孩子**自己那一轮**的模型流：会话 id 是那个孩子，原文里有父级 mint 的 token。
  //    这一条才是"送达"；"返回了一个 MessageId"只是它的前半句。
  assert.equal(send.childTurnSeen, true, '送出去之后孩子的模型流一次都没被调用——消息没有到达任何一轮')
  assert.equal(send.childTurnSessionIsChild, true, '那一轮模型流上的会话 id 不是这个孩子')
  assert.equal(send.childTurnEchoed, send.token,
    '孩子那一轮的对话里没有那个父级 mint 的 token——投递没有落进这一轮')

  // ② durable 层：那个 messageId 出现在**孩子自己的**会话日志里，原文含同一个 token，
  //    而且来源标着"父级 relay 过来的"。
  const logFile = await childLogFile(r)
  const records = await waitForRecords(logFile, (all) => all.some(
    (record) => record.type === 'user/message' && record.data?.id === send.messageId))
  const delivered = records.find(
    (record) => record.type === 'user/message' && record.data?.id === send.messageId)
  assert.ok(delivered !== undefined,
    `孩子自己的日志里没有 id=${send.messageId} 的用户消息——返回的那个 id 没有落到孩子身上`)
  assert.ok(userText(delivered).includes(send.token), '孩子日志里那条消息不含父级 mint 的 token')
  assert.equal(delivered.data?.source?.kind, 'agent-message',
    '孩子日志里那条消息的来源不是"另一个 agent 发来的"')
  assert.equal(String(delivered.data?.source?.senderSessionId), r.parentId,
    '那条消息的发送者不是本套件造的那个父 agent')

  // ③ 更强的一条：孩子日志里有一条**模型自己写下的** assistant 消息，含同一个 token。
  const assistant = records.filter((record) => record.type === 'assistant/message')
  assert.ok(assistant.length >= 1, '孩子一轮都没跑完过，日志里没有 assistant 消息')
  assert.ok(assistant.some((record) => assistantText(record).includes(send.token)),
    `孩子的 assistant 消息里没有那个 token：${JSON.stringify(assistant.map(assistantText))}`)

  // ④ 初始提示的 messageId 同样落在孩子日志里（第一条投递也要有落点）。
  const initial = records.find(
    (record) => record.type === 'user/message' && record.data?.id === r.initialMessageId)
  assert.ok(initial !== undefined, 'startContinuable 返回的初始 MessageId 不在孩子的日志里')
  t.diagnostic(`token=${send.token} messageId=${send.messageId}`
    + ` childStreamSession=${String(send.childTurnSessionId).slice(0, 8)}`
    + ` 孩子日志 user/message=${countOf(records, 'user/message')} assistant/message=${countOf(records, 'assistant/message')}`)
})

guarded('★★★★ listChildren / listDescendants 与事实一致，且不存在的父级返回空表而不是报错或编造', async (t) => {
  const r = await scenario()
  diagnose(t, r)
  const childId = requireChildId(r)
  const listing = recordOf(r, 'listing')

  const mine = listing.parent.find((entry) => entry.id === childId)
  assert.ok(mine !== undefined, `listChildren(真父级) 没有列出那个孩子：${JSON.stringify(listing.parent)}`)
  assert.equal(mine.mode, 'continuable')

  // 不存在的父级：**空表**。既不是异常，也不是编造出来的一条。
  assert.deepEqual(listing.ghost, [],
    `一个不存在的父级被列出了一个孩子：${JSON.stringify(listing.ghost)}`)
  assert.equal(listing.ghostError, undefined, `不存在的父级应当返回空表，而不是报错：${JSON.stringify(listing.ghostError ?? null)}`)
  assert.deepEqual(listing.descendantsGhost, [],
    `一行都不存在的根被列出了后代：${JSON.stringify(listing.descendantsGhost)}`)
  assert.equal(listing.descendantsGhostError, undefined,
    `不存在的根应当返回空表，而不是报错：${JSON.stringify(listing.descendantsGhostError ?? null)}`)

  // 后代视图带上树的坐标：深度 1、直系父级就是那个父 agent。
  const descendant = listing.descendants.find((entry) => entry.id === childId)
  assert.ok(descendant !== undefined, `listDescendants(真根) 没有列出那个孩子：${JSON.stringify(listing.descendants)}`)
  assert.equal(descendant.depth, 1, '直系子会话的 depth 应当是 1')
  assert.equal(descendant.parentId, r.parentId, '后代视图上的 parentId 与那个父 agent 不一致')

  // durable 侧的同一条：父级日志里有一条 subagent/catalog 行，指的就是这个孩子。
  const parentLog = r.logFiles.get(r.parentId)
  assert.ok(parentLog !== undefined, '父 agent 自己的会话日志不存在')
  const catalog = readJsonl(parentLog).filter((record) => record.type === 'subagent/catalog')
  assert.ok(catalog.some((record) => record.data?.childId === childId),
    `父级日志里没有指向 ${childId} 的 subagent/catalog 行：${JSON.stringify(catalog)}`)
  t.diagnostic(`parent=${listing.parent.length} child 行 ghost=${listing.ghost.length} 行`
    + ` descendants=${listing.descendants.length} 行 catalog=${catalog.length} 行`)
})

guarded('★★★★ interrupt 打断的是正在跑的那一轮（不是只发了一个取消），并且进程没死', async (t) => {
  const r = await scenario()
  diagnose(t, r)
  const childId = requireChildId(r)
  const interrupted = recordOf(r, 'initial-prompt-and-interrupt')

  // 孩子那一轮真的进了模型流，并且挂在那里（这才是"正在跑"）。
  assert.equal(interrupted.holdStarted, true, '孩子那一轮一次都没进模型流，无从谈"打断正在跑的那一轮"')
  assert.equal(interrupted.residentBefore, true, '打断那一刻孩子不在册')
  assert.equal(interrupted.rightAuthority.ok, true,
    `exact live parent 的授权被拒了：${JSON.stringify(interrupted.rightAuthority.error ?? null)}`)
  // 负对照：换一个父会话 id，同一个孩子、同一时刻，必须被拒。
  assert.equal(interrupted.wrongAuthority.ok, false, '陌生人父级竟然也能打断——授权检查没真的跑')
  assert.equal(interrupted.wrongAuthority.error?.code, 'UNAUTHORIZED')
  // 承重的一条：那条挂起的模型流**观察到了 abort**，而且很快。
  assert.equal(interrupted.aborted, true,
    '打断被"受理"了，但那条正在跑的模型流从没观察到 abort——那是 cancel 发了个寂寞')
  assert.ok(interrupted.abortMs !== null && interrupted.abortMs < 5000,
    `abort 的观察耗时不合理：${String(interrupted.abortMs)}ms`)

  // durable 层：「被干净地打断」与「进程死了」在日志里是不同的东西。
  const logFile = await childLogFile(r)
  const records = await waitForRecords(logFile, (all) => countOf(all, 'turn/end') >= 1)
  const reasons = turnEndReasons(records)
  assert.ok(reasons.some((reason) => reason?.kind === 'aborted' && reason?.reason?.kind === 'user'),
    `孩子日志里没有一条"被 user 打断"的 turn/end：${JSON.stringify(reasons)}`)
  assert.equal(countOf(records, 'session'), 1, '孩子过了一轮就换了一份会话——身份不稳定')

  // 进程没死：三次打断 + 两次 drain 之后，ACP 侧仍然应答，而且还能再开一个新会话
  // （只答一个读请求是"活着"，能再开一个会话是"还在干活"）。
  assert.equal(r.liveness.ok, true, `读数落盘之后 ACP 不再应答了：${String(r.liveness.error)}`)
  assert.match(String(r.liveness.postDriveSessionId), UUID_RE,
    '读数落盘之后 ACP 已经开不出新会话了——那是一次"打断把进程弄死了"的读数')
  assert.ok(r.liveness.sessions !== null, 'ACP 的 session/list 没有返回 sessions 数组')
  t.diagnostic(`abortMs=${String(interrupted.abortMs)} turn/end=${JSON.stringify(reasons)}`
    + ` liveness=${r.liveness.ok ? 'alive' : 'dead'} postDriveSession=${String(r.liveness.postDriveSessionId).slice(0, 8)}`
    + ` session/list=${JSON.stringify(r.liveness.sessions)} serverRequests=${r.serverRequests.length}`)
})

guarded('★★★★ interruptByParent 同样可观察：陌生人地址被拒，真地址受理并真的打断', async (t) => {
  const r = await scenario()
  diagnose(t, r)
  requireChildId(r)
  const byParent = recordOf(r, 'interrupt-by-parent')

  assert.equal(byParent.holdStarted, true, '第二轮没有真的进模型流')
  assert.equal(byParent.residentBefore, true, 'interruptByParent 那一刻孩子不在册')
  assert.equal(byParent.sent?.ok, true, '那一条 hold 消息没有投递成功')

  // 负对照：换一个父会话 id —— 这是一条 RemoteError（浏览器面），不是静默成功。
  const wrong = byParent.action?.wrongParent
  assert.equal(wrong?.ok, false, '陌生人父级竟然被受理了——父级地址检查没真的跑')
  assert.equal(wrong?.error?.name, 'RemoteError')
  assert.equal(wrong?.error?.code, 'subagent/unauthorized')
  // 正例：受理回执 + 那条挂起的模型流观察到 abort。
  const right = byParent.action?.rightParent
  assert.equal(right?.ok, true, `真父级被拒了：${JSON.stringify(right?.error ?? null)}`)
  assert.equal(right?.value?.accepted, true, 'interruptByParent 没有给出 accepted 回执')
  assert.equal(byParent.aborted, true, '受理了却从没打断那条正在跑的模型流')

  const logFile = await childLogFile(r)
  const records = await waitForRecords(logFile, (all) => countOf(all, 'turn/end') >= 3)
  const userAborts = turnEndReasons(records)
    .filter((reason) => reason?.kind === 'aborted' && reason?.reason?.kind === 'user')
  assert.ok(userAborts.length >= 2,
    `两条 user 打断（interrupt 与 interruptByParent）在日志里应当各留一条 aborted/user，实际 ${JSON.stringify(turnEndReasons(records))}`)
  t.diagnostic(`accepted=${JSON.stringify(right?.value)} wrongCode=${String(wrong?.error?.code)}`
    + ` aborted=${String(byParent.aborted)} aborted/user=${userAborts.length} 条`)
})

guarded('★★★ drainContinuableChildren 返回，且之后的列举从 running 变成 inactive', async (t) => {
  const r = await scenario()
  diagnose(t, r)
  const childId = requireChildId(r)
  const drain = recordOf(r, 'drain-children')
  const action = drain.action ?? {}

  assert.equal(drain.holdStarted, true, 'drain 之前那一轮没有真的进模型流，"放下一个正在跑的孩子"就无从谈起')
  assert.equal(drain.residentBefore, true, 'drain 那一刻孩子不在册')
  const whileResident = action.listingWhileResident?.find((entry) => entry.id === childId)
  assert.equal(whileResident?.activity, 'running', 'drain 之前列举应当读到 running')
  assert.equal(action.liveBefore, true)
  assert.equal(action.drained?.ok, true, `drainContinuableChildren 报错：${JSON.stringify(action.drained?.error ?? null)}`)
  assert.equal(action.liveAfter, false, 'drain 返回之后那个 agent 还在注册表里——没有真的释放')
  const afterDrain = action.listingAfterDrain?.find((entry) => entry.id === childId)
  assert.ok(afterDrain !== undefined, 'drain 之后孩子从列举里消失了——但它的 durable 记录应当在')
  assert.equal(afterDrain.activity, 'inactive', 'drain 之后列举应当读成 inactive')
  // 一个不在册的 childId 是**受理的空操作**，不是异常。
  assert.equal(action.drainAbsentChild?.ok, true,
    `对一个不存在的 childId 调 drain 竟然报错了：${JSON.stringify(action.drainAbsentChild?.error ?? null)}`)

  // durable 层：那一轮是以 **parent** 的名义被取消的（与 user 打断可区分）。
  const logFile = await childLogFile(r)
  const records = await waitForRecords(logFile, (all) => turnEndReasons(all)
    .some((reason) => reason?.kind === 'aborted' && reason?.reason?.kind === 'parent'))
  assert.ok(turnEndReasons(records).some((reason) => reason?.kind === 'aborted' && reason?.reason?.kind === 'parent'),
    `drain 之后孩子日志里没有一条 aborted/parent 的 turn/end：${JSON.stringify(turnEndReasons(records))}`)
  t.diagnostic(`running->inactive 通过 liveBefore=${String(action.liveBefore)}`
    + ` -> liveAfter=${String(action.liveAfter)} turn/end=${JSON.stringify(turnEndReasons(records))}`)
})

guarded('★★★ drainContinuableDescendants 返回，并且真的关掉了准入：之后的 sendMessage 报 DRAINING', async (t) => {
  const r = await scenario()
  diagnose(t, r)
  const childId = requireChildId(r)
  const drain = recordOf(r, 'drain-descendants')
  const action = drain.action ?? {}

  assert.equal(drain.holdStarted, true, '冷启动那一轮没有真的进模型流')
  assert.equal(action.coldResumed, true, '冷启动没有把孩子拉回注册表，drain 就没东西可放')
  assert.equal(action.drained?.ok, true, `drainContinuableDescendants 报错：${JSON.stringify(action.drained?.error ?? null)}`)
  assert.equal(action.liveAfter, false, 'drain 返回之后那个 agent 还在注册表里')
  const afterDrain = action.listingAfterDrain?.find((entry) => entry.id === childId)
  assert.ok(afterDrain !== undefined, 'drain 之后孩子的 durable 记录不该从列举里消失')
  assert.equal(afterDrain.activity, 'inactive')

  // ★ 承重的一条：drain **不是**空操作。之后再投递必须被拒，且理由是 DRAINING。
  assert.equal(action.sendAfterScopedDrain?.ok, false,
    'drainContinuableDescendants 之后还能往那棵树下投递——那它没关掉准入')
  assert.equal(action.sendAfterScopedDrain?.error?.code, 'DRAINING')
  assert.match(String(action.sendAfterScopedDrain?.error?.message), /draining/)

  const logFile = await childLogFile(r)
  const records = await waitForRecords(logFile, (all) => turnEndReasons(all)
    .filter((reason) => reason?.kind === 'aborted' && reason?.reason?.kind === 'parent').length >= 2)
  const parentAborts = turnEndReasons(records)
    .filter((reason) => reason?.kind === 'aborted' && reason?.reason?.kind === 'parent')
  assert.ok(parentAborts.length >= 2,
    `两次 drain 应当各留一条 aborted/parent，实际 ${JSON.stringify(turnEndReasons(records))}`)
  t.diagnostic(`DRAINING=${JSON.stringify(action.sendAfterScopedDrain?.error?.message ?? null).slice(0, 120)}`
    + ` aborted/parent=${parentAborts.length} 条`)
})

guarded('★★★ agents.isOwnedBy 说得出"这个孩子是这个父级造的"；enter 的碰撞边界在册时生效', async (t) => {
  const r = await scenario()
  diagnose(t, r)
  requireChildId(r)
  const established = recordOf(r, 'child-established')

  assert.equal(established.isOwnedByParent, true,
    'isOwnedBy(childId, 那个父 agent) 说不是他造的——所有权在注册表里没有真的建立')
  assert.equal(established.isOwnedByStranger, false, '一个陌生人对象竟然也被认成 owner')

  // `agents.enter` 只驱动到它的**碰撞边界**：同一个 id 已在册 ⇒ 必须抛。
  // 成功插入那条需要一个尚未发布的 Agent（enter 的语义是"在一个 id 被占用前把它插进去"），
  // 本探针不拥有这样的 Agent，所以**没有**驱动它——这句话是读数边界，不是免责声明。
  assert.match(String(established.enterCollision), /already registered/,
    `enter 对一个已在册的 id 没有抛"已经注册"：${String(established.enterCollision)}`)
  t.diagnostic(`isOwnedBy(parent)=true isOwnedBy(stranger)=false enter=${JSON.stringify(established.enterCollision)}`)
})

guarded('★★★ 孩子有一份独立、durable 的日志：header 与 descriptor 都说得出它是什么', async (t) => {
  const r = await scenario()
  diagnose(t, r)
  const childId = requireChildId(r)
  const logFile = await childLogFile(r)

  // 父与子各一份日志，不是同一份。
  assert.ok(r.logFiles.size >= 2, `这次应当至少有两份会话日志（父 + 子），实际 ${r.logFiles.size}`)
  assert.ok(r.logFiles.has(r.parentId), '父 agent 的会话日志不存在')
  assert.notEqual(logFile, r.logFiles.get(r.parentId))

  const records = await waitForRecords(logFile, (all) => countOf(all, 'session') >= 1)
  const header = records.find((record) => record.type === 'session')
  assert.ok(header !== undefined, '孩子的日志里没有 session header')
  assert.equal(header.id, childId, '日志里的会话 id 与 startContinuable 给的 childId 不一致')
  assert.equal(header.parentSession, r.parentId, '日志里的 durable parentSession 不是那个父 agent')
  assert.equal(header.origin, 'subagent', '孩子的会话 header 没有标成 subagent 来源')
  assert.equal(header.delegationDepth, 1, '直系子会话的 delegationDepth 应当是 1')
  assert.equal(header.isSeeded, false, 'spawn provider 不该把孩子标成 seeded（那是 fork 的事）')

  // descriptor 是「它是 continuable」这件事的 durable 出处，也是 provider/模型选择的出处。
  const descriptor = records.find((record) => record.type === 'subagent/descriptor')
  assert.ok(descriptor !== undefined, '孩子的日志里没有 subagent/descriptor')
  assert.equal(descriptor.data?.mode, 'continuable')
  assert.equal(descriptor.data?.provider, 'spawn')
  assert.equal(descriptor.data?.label, CHILD_LABEL)
  assert.equal(descriptor.data?.agentProvider, 'probe-model', 'descriptor 里的模型 provider 不是那个桩')
  assert.equal(descriptor.data?.agentModel, 'probe-model')
  t.diagnostic(`header origin=${String(header.origin)} depth=${String(header.delegationDepth)}`
    + ` descriptor=${JSON.stringify(descriptor.data)}`)
})

guarded('★★ 诚实边界：ACP 那一侧的 session/new 也是一个活的根 agent', async (t) => {
  const r = await scenario()
  diagnose(t, r)
  const foreign = recordOf(r, 'foreign-agents')

  // 这条读数的用途是**修正一句措辞**：此前写「一次性的 ACP 进程没有父 agent」，
  // 而 session/new 逐字调用 ctx.agents.create，于是进程里确实多了一个活 agent。
  // 精确的说法是：它有**活着的根 agent**，但它不拥有任何 continuable 子会话，
  // 而且本套件**没有**依赖它——父 agent 是探针自己用 ctx.agents.create 现造的。
  assert.match(String(r.acpSessionId), UUID_RE, 'ACP session/new 没有返回 sessionId')
  const acp = (foreign.agents ?? []).find((agent) => agent.id === r.acpSessionId)
  assert.ok(acp !== undefined,
    `ACP 侧开的会话没有出现在活 agent 列表里：${JSON.stringify(foreign.agents ?? [])}`)
  assert.equal(acp.parentSession, null, 'ACP 侧的会话是**根**：它没有自己的父会话')
  t.diagnostic(`探测到的外来活 agent=${JSON.stringify(foreign.agents ?? [])}`
    + ` 等待=${String(foreign.waitedMs)}ms`)
})

guarded('★★ 诚实边界：审计面哪几条被驱动了、哪几条没有（与 session-boundary.mjs 的清单逐条对齐）', async (t) => {
  const r = await scenario()
  diagnose(t, r)

  // 逐条表态：**每一条**审计面都必须在这里有一个明确的结论。
  // 这一条测试的存在意义就是让「没跑」不可能悄悄混进「跑过了」——
  // 审计面清单以后新增一条，这里会红，而不是让新条目默认变成绿的。
  const verdicts = new Map(Object.entries(FACE_VERDICT))
  const faces = DSH_CONTINUABLE_SURFACE.map((entry) => {
    const head = String(entry.signature).split('(')[0].trim().split(/\s+/)
    return { service: entry.service, method: head[head.length - 1], role: entry.role }
  })
  const unstated = faces.filter((face) => !verdicts.has(`${face.service}.${face.method}`))
  assert.deepEqual(unstated, [],
    '审计面里出现了本套件没有表态的条目——请显式表态，别让它悄悄变成"没跑也算跑过了"')

  // subagents 服务那八条，本套件全部**直接驱动**了。
  const subagentFaces = faces.filter((face) => face.service === 'subagents')
  assert.equal(subagentFaces.length, 8, `审计面里的 subagents 条目数变了：${subagentFaces.length}`)
  for (const face of subagentFaces) {
    assert.equal(verdicts.get(`${face.service}.${face.method}`), 'driven',
      `${face.service}.${face.method} 没有被标成 driven`)
  }

  // 两条 recovery 面是**间接**读数：探针从不直接调用 agents.resume / agentLoop.resume，
  // 是 continuation manager 在冷恢复路径上调用它们。它的前提必须同时成立，否则这句话是空的。
  const send = recordOf(r, 'send-message')
  assert.match(String(verdicts.get('agents.resume')), /^indirect/)
  assert.match(String(verdicts.get('agentLoop.resume')), /^indirect/)
  assert.equal(send.residentBeforeSend, false,
    'agents.resume 的间接读法缺了前提：投递那一刻孩子必须在册之外（= 真的走了冷恢复）')
  assert.equal(send.childTurnSessionIsChild, true, '冷恢复之后那一轮的会话 id 不是同一个孩子')

  // 三条独立读数：本套件**没有**驱动 approval 面，也**没有**驱动 sessions.fork。
  assert.match(String(verdicts.get('sessions.fork')), /^not-driven/)
  assert.match(String(verdicts.get('approval.setPolicy')), /^not-driven/)
  assert.match(String(verdicts.get('approval.overrideOf')), /^not-driven/)

  // 一处**顺带**读到的、与 permission 面相邻的事实，明确标注它不是那一面：
  // 孩子的日志里有 approval/policy 行——但那是 DSH 在**发布子会话之前**把父级已有的
  // 显式覆盖写成 source:'delegation' 的结果（child-agent.ts 的 appendDelegatedPolicyOverrides），
  // **不是**本套件调用 setPolicy/overrideOf 得到的读数。这里只断言"这行存在"。
  const logFile = await childLogFile(r)
  const records = await waitForRecords(logFile, (all) => all.some(
    (record) => record.type === 'approval/policy'))
  const policies = records.filter((record) => record.type === 'approval/policy')
  assert.ok(policies.length >= 1, '孩子的日志里没有 approval/policy 行')
  t.diagnostic(`驱动=driven: subagents×8 + agents.isOwnedBy；indirect: agents.resume/agentLoop.resume；`
    + `partial: agents.enter（只到碰撞边界）；not-driven: sessions.fork + approval×2。`
    + ` 顺带读到 approval/policy=${JSON.stringify(policies.map((record) => record.data))}`
    + `（这是子会话建立时的 delegation 写入，**不是** setPolicy/overrideOf 的读数）`)

  // 最后把「本套件不翻转静态审计的任何一面」写成读数：那份文档的接口面清单仍是 15 条、
  // 五个面仍是 behavior-unverified。本节套件是**另一层**。
  assert.equal(DSH_CONTINUABLE_SURFACE.length, 15)
  t.diagnostic(`session-boundary.mjs 的 DSH_CONTINUABLE_SURFACE=${DSH_CONTINUABLE_SURFACE.length} 条`
    + `（本套件一行都没改；behaviorVerified 仍是 false，翻转它不是本层的动作）`)
})

// ── 逐条表态表：审计面里的每一个 (service, method) 都在这里有一句话 ──────────
//
// 'driven'    = 探针**直接**调用了它，并留下了一条读数；
// 'indirect'  = 探针没有直接调用，但某个真实路径调用了它，且读数能证明那条路径真的走过；
// 'partial:…' = 只驱动到了它的一部分语义，括号里写清哪一部分没驱动、为什么；
// 'not-driven'= 一次都没有驱动。
const FACE_VERDICT = Object.freeze({
  'subagents.startContinuable': 'driven',
  'subagents.sendMessage': 'driven',
  'subagents.interrupt': 'driven',
  'subagents.drainContinuableChildren': 'driven',
  'subagents.drainContinuableDescendants': 'driven',
  'subagents.listChildren': 'driven',
  'subagents.listDescendants': 'driven',
  'subagents.interruptByParent': 'driven',
  'agents.isOwnedBy': 'driven',
  'agents.enter': 'partial: 只驱动到「同一 id 已在册 ⇒ 抛 already registered」这条碰撞边界；'
    + '成功插入那条需要一个尚未发布的 Agent，本探针不拥有',
  'agents.resume': 'indirect: 探针没有直接调用；continuation manager 在冷恢复路径上调用它。'
    + '证据：sendMessage 时 child 不在册（residentBeforeSend=false）而同一个 childId 仍跑出了下一轮',
  'agentLoop.resume': 'indirect: 同 agents.resume——agents.resume 经 factory 落到 agent-loop 的 resume',
  'sessions.fork': 'not-driven: 本探针没有任何 fork 分支',
  'approval.setPolicy': 'not-driven: 本探针一次都没有按 agent 设置策略',
  'approval.overrideOf': 'not-driven: 本探针一次都没有按 session 查询策略',
})
