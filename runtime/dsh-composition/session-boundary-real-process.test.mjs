// runtime/dsh-composition/session-boundary-real-process.test.mjs
// ============================================================================
// PRT-211 / PRT-212：把 continuable session 的**续接、身份/权限继承、取消边界**
// 从「读源码得到的结论」升级为「真进程跑出来的读数」。
//
// ## 这一套补的是哪个缺口
//
// `runtime/adapters/dsh/session-boundary.mjs` 自称得很清楚：
//
//   > 本批次**不**声称完成了「验证」这个词的全部含义。……
//   > 五个面里没有任何一个做过运行时行为验证。
//   > `behaviorVerified` 一律仍为 false。
//
// 那份自陈是**诚实**的，也是**空的**：它把每个面标成 `implementation-verified`
// 或 `api-surface-verified`，于是「我已经读过实现、结论确定」与「我压根没跑过」
// 在报告上是同一个形状。
//
// ## ★ 但是：这是**两个不同的层**，本套件**不**翻转那份文档里的任何一面
//
// `session-boundary.mjs` 的接口面清单（`DSH_CONTINUABLE_SURFACE`，`:231-247`）
// 主体是 `subagents` 服务——`startContinuable(:232)`、`sendMessage(:233)`、
// `interrupt(:234)`、`drainContinuableChildren(:235)`、
// `listChildren(:237)`/`listDescendants(:238)`、`interruptByParent(:239)`——
// 那是**进程内、父 agent ↔ continuable 子会话**的那一面。
//
// 本套件驱动的是 **ACP 客户端协议**：`session/new|list|resume|close|prompt|cancel`
// 加 `session/request_permission`。一个一次性的 `dsh --profile acp` 进程
// **没有父 agent**，所以 `subagents.startContinuable` 在这个面上根本无从驱动，
// 本套件**一次都没碰过**它。
//
//   > 一片「续接真的发生了」的绿，
//   > 与一片「父会话把它那个 continuable 子会话接着跑了」的绿，
//   > 在 PRT-211 的报告里会被读成同一行；
//   > 只不过前者说的是**外部客户端恢复了同一个会话**，
//   > 后者说的是**进程内父子谱系**——两者之间没有谁取代谁。
//
// 因此本套件**不**主张 `session-boundary.mjs` 的 `behaviorVerified`
// （`:436`、`:443`）翻成了 true：那份文档里五个面的权威仍是它自己的静态审计，
// 而本套件是**另一层**的读数。两层互不替代。
//
// **唯一一处能对上号的映射**（这是本套件唯一敢说"某个具体条目被跑到了"的地方）：
//
//   · `session-boundary.mjs:240` 的 `agents.resume(options: ResumeAgentOptions)`，
//     与 ACP 的 `session/resume` 是同一条实现路径——ACP 桥在
//     `packages/acp/acp/src/session.ts:80` 逐字调用
//     `await ctx.agents.resume({ resumeSessionId: options.sessionId, … })`。
//     所以「跨进程恢复一个已有会话」这一条，本套件给的是行为读数。
//   · 反之 `subagents.*` 那七条、`sessions.fork(:244)`、
//     `agents.isOwnedBy(:241)`/`enter(:242)` 在本套件里**全都没有被跑到**。
//
// ## 协议面（都是**读源码读出来的**，不是猜的）
//
//   · 入口：`node <DSH>/apps/cli/lib/bin.js --profile acp`
//     profile 名与 bundle 列表来自 `packages/boot/app-boot/src/profile.ts:106-109`
//     （`acp: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] }`）。
//
//   · **framing 是「一行一条 JSON」，不是 Content-Length 头**：
//     `packages/acp/acp/src/index.ts:374` 是
//     `const stream: Stream = config.stream ?? ndJsonStream(...)`（紧邻几行把
//     `process.stdout`/`process.stdin` 接进去），
//     而 SDK 的实现（`@agentclientprotocol/sdk` `dist/stream.js:13-20`）逐字是
//     `JSON.stringify(message) + "\n"`。没有 header、没有 \r\n 约定。
//
//   · 方法名（SDK `dist/schema/index.js:8-34` 是权威表，ACP agent 侧注册在
//     `packages/acp/acp/src/index.ts:379-390`）：
//       `initialize`
//       `session/new`               → `{ sessionId, configOptions }`
//       `session/list`              → `{ sessions: [{ sessionId, cwd }] }`
//       `session/resume`            → `{ configOptions }`（**不返回新 id**）
//       `session/close`             → `{}`
//       `session/set_config_option`
//       `session/prompt`            → `{ stopReason }`
//       通知 `session/cancel`（**没有 id**）
//       通知 `session/update`（agent → client，`{ sessionId, update }`）
//       请求 `session/request_permission`（agent → client，**审批口**）
//
//   · 审批口就是 ACP 桥自己。`packages/acp/acp/src/index.ts:152-173` 的注释逐字写着
//     "Permission requests are a machine policy channel for ACP clients"，
//     两个守卫是 `ownedRecord(request.agent) === undefined || request.callId === undefined`
//     ——任一命中就 `next()`，于是**静默让给别人**，客户端那一侧只会看到一片沉默。
//
// ## 为什么**不**用 spawnSync 折一次写完
//
// 这段对话**不可能**被折叠成一次 `input`：
//
//   initialize → session/new（**返回的 sessionId 是服务端随机 UUID**）
//   → session/prompt（要带那个 id）→ 过程中服务端**反向**发来
//   `session/request_permission`（要现场按策略作答）→ 才轮到 prompt 的响应。
//
// 第二个来回就已经需要读到第一个的响应体了。所以本文件用 `spawn` +
// 自己的 readline 对话循环 + 自己的超时/杀进程，**不用** `spawnSync`。
// 同样地，`session/resume` 是**另一个进程**里跑的（真跨进程续接），
// 也不是同一个 stdio 会话里能折叠出来的。
//
// ## 判别：三片长得一样的绿
//
//   > 一条「批准了就跑了」的断言，
//   > 与一条「审批口真的在起作用」的断言，
//   > 在一个**永远批准**的审批口上给出同一片绿。
//
// 所以本套件在**两条路上都断言**：批准 → 磁盘上出现 sentinel；
// 拒绝 → 磁盘上没有 sentinel，**且**日志里那对
// `approval/asked` + `approval/decided{outcome:'rejected'}` 确实存在，
// **且**同一进程里紧接着一条**不经审批的同样命令**真的写出了文件
// （否则「文件没出现」可能只是那条命令本来就跑不通）。
//
// 第三种沉默更阴：审批**服务**被问了，但 ACP **通道**从没被用过。
// `packages/interaction/user-approval/src/index.ts:268` 的
// `if (this.effectivePolicy(session) === 'never') return 'rejected'` 在 waterfall
// 之前就短掉了，于是 `'rejected'` 这个读数在两种完全不同的世界里同形：
//
//   ① 一条真 answerer 说了不；
//   ② 策略是 `never`，**没有任何 answerer 被问**。
//
// 因此本套件里还有一条 `never` 负对照：同一个会话形状、同一条升级请求，
// 断言 `session/request_permission` 的**次数为 0**，而日志里
// `approval/decided{outcome:'rejected'}` 照样存在。
// 「闸门拒绝了」与「闸门根本没被咨询过」在这条断言下才分得开。
//
// ## 安全纪律（与同目录那几套真实进程套件同一套）
//
//   每个子进程一套 `os.tmpdir()` 下的一次性 `DSH_HOME` + 一次性 agents home +
//   一次性 cwd；spawn 之前断言它们都在本次 run 的 scratch 之内；
//   `DSH_SNAPSHOT`/`DSH_SESSION_ID`/`DSH_WEB_URL`/`DEEPSEEK_API_KEY` 全部删掉；
//   子进程有硬超时并在超时时被杀；`after()` 删掉整棵 scratch。
//   **绝不**碰操作者真实的 `~/.dsh`，**绝不**往真实 profile 里写 patch，
//   **绝不**读 `.credentials.yaml`。本文件打印的唯一「token」是本进程
//   `randomBytes` mint 的一次性 sentinel 值，不是凭证。
//
// ## 诚实边界（这一套**没有**证明的东西）
//
//   · **Legion 自己的编排器不在环里。** 这是一个裸的 `dsh --profile acp`，
//     没有 Legion 的 launcher、没有它的 run store、没有它的授权记录。
//     这里说的「身份」是 **DSH session 的身份**（`sessionId` + 会话 header），
//     **不是** Legion 的 per-user 身份——那需要 Legion 的进程在场。
//   · **模型是桩。** 只有模型那条流是本地假适配器；工具派发、ToolRuntime、
//     sandbox、approval 服务全是生产的 `dsh-base`。所以本套件不问
//     「模型会不会正确地要求升级」，只问「机器上那条闸真的拦不拦得住」。
//   · **审批策略值不是通过 ACP 面观察的。** 本套件里那个 `policy=ask/never`
//     是桩从**系统提示文本**里读回来的（`Approval policy: ask.` /
//     `Approval prompts are disabled in this session`）——它是模型看到的事实，
//     不是审批服务的内部状态。服务内部状态另由**会话日志里的
//     `approval/policy` 事件**佐证。
//   · 只在 **win32** 上观测过（`dsh-base` 的 `tool-pwsh` 行写死
//     `disabled: !!js process.platform !== 'win32'`）。非 win32 逐条 SKIP。
//   · 没测 Legion 的 cancel 语义（那个在一次 Run 上）、没测崩溃恢复、
//     没测父→子会话的策略传播（`session-boundary.mjs` 的
//     `CHILD_POLICY_NOT_INHERITED` 讲的是**另一个边界**：
//     父会话 → 派生子会话；本套件测的是**同一个会话跨进程被恢复**，
//     两者的答案在本套件里是分开写的）。
// ============================================================================

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { after, describe, test } from 'node:test'

// ── 可跑性判定（沿用同目录 `headless-real-tool.test.mjs` 的口径）────────────
const DSH = process.env.DSH_CHECKOUT ?? null
const CLI = DSH === null ? null : join(DSH, 'apps', 'cli', 'lib', 'bin.js')

/** 缺 DSH / 缺 CLI / 非 win32 时整组逐条 `t.skip(原因)`，**不失败**。 */
const DSH_SKIP = DSH === null
  ? '未配置 DSH_CHECKOUT'
  : !existsSync(CLI)
    ? `DSH 检出里找不到 CLI（${CLI}）——未构建？`
    : process.platform !== 'win32'
      ? `本套件只在 win32 上被观测过（工具面是 pwsh）；当前平台 ${process.platform}`
      : false

/** 缺 DSH 时 `t.skip(原因)`；跑不了就不算跑过。 */
const guarded = (name, fn) => test(name, { timeout: 300_000 }, (t) => {
  if (DSH_SKIP !== false) return t.skip(`SKIP：${DSH_SKIP}`)
  return fn(t)
})

// ── 一次性 scratch（整棵在 after() 里删）───────────────────────────────────
const TMP_ROOT = resolve(tmpdir())
const SCRATCH = resolve(mkdtempSync(join(TMP_ROOT, 'legion-session-boundary-')))
assert.ok(SCRATCH.startsWith(TMP_ROOT + sep), `scratch 逃出了 tmpdir：${SCRATCH}`)

after(() => {
  // 每个子进程都在用例结束时被杀/已退出；整棵 scratch 连同一次性 home 一起删。
  rmSync(SCRATCH, { recursive: true, force: true })
})

// ── 常量 ──────────────────────────────────────────────────────────────────
const PROFILE_NAME = 'acp'
const STUB_NAME = 'legion-acp-probe-llm.mjs'
const OVERLAY_MAIN = 'legion-acp-main.patch.yml'
const OVERLAY_NEVER = 'legion-acp-never.patch.yml'
const SESSIONS_DIR = 'sessions'
const PROBE_PROVIDER = 'probe-model'
/** 探针 callId：日志里的 `tool/result` 必须配上它。 */
const PROBE_CALL_ID = 'legion-acp-probe-call'

/** 桩行为选择器（出现在提示文本里，桩按它选分支）。 */
const MARK_ALLOW = 'PROBE_ALLOW'      // 发一条**带 sandbox_permissions** 的 pwsh
const MARK_PLAIN = 'PROBE_PLAIN'      // 发一条**不带 sandbox_permissions** 的 pwsh
const MARK_CANCEL = 'PROBE_CANCEL'    // 先睡，再说话（给取消留窗口）

/**
 * 每条提示自报它要写哪个 sentinel（`PROBE_TARGET_<n>`）。
 *
 * 为什么不用「取 token 里最后一个出现过的」：跨进程续接那一轮的历史里
 * **同时**躺着第 1、2 轮（乃至第 3 轮）的 token，按「出现过」去挑会挑到
 * 最早那轮的目标，于是「续接轮写没写文件」这句话会被**上一轮写过**的事实
 * 污染成一个假绿。所以目标由本轮提示自己点名，桩按 `lastIndexOf` 取**最近**
 * 的那一个点名——历史再长也只认本轮。
 */
const TARGET_MARK = (index) => `PROBE_TARGET_${index + 1}`

/**
 * sentinel 用**裸文件名**而不是绝对路径：命令的 workdir 默认就是会话 cwd，
 * 于是各个一次性 home 里生成的桩源码**逐字节相同**。
 * 这一点是承重的——「两个 home 的差别只有策略」这句话必须可核对，
 * 否则续接/权限那些读数差都可能来自桩本身。
 */
const SENTINEL_NAMES = Object.freeze([
  'legion-boundary-sentinel-1.txt',
  'legion-boundary-sentinel-2.txt',
  'legion-boundary-sentinel-3.txt',
])


/** ACP `session/update` 的标准执行面（`packages/acp/acp/src/updates.ts`）。 */
const STANDARD_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'usage_update',
  'config_option_update',
])

const UPDATED_AT = () => new Date().toISOString()

// ── 一次性目录 ────────────────────────────────────────────────────────────
/** `os.tmpdir()` 下的一次性目录，且在 spawn 之前被断言没有逃逸。 */
function mkTemp(tag) {
  const dir = resolve(mkdtempSync(join(SCRATCH, tag)))
  assert.ok(dir.startsWith(TMP_ROOT + sep), `一次性目录逃出了 tmpdir：${dir}`)
  assert.ok(dir.startsWith(SCRATCH + sep), `一次性目录逃出了本次 run 的 scratch：${dir}`)
  return dir
}

/** 本进程 mint 的一次性 sentinel token。它不是凭证，打印它没有风险。 */
function mintToken(tag) {
  return `SENTINEL_${tag}_${randomBytes(8).toString('hex').toUpperCase()}`
}

// ── 桩：只供应**模型流**，不碰文件系统 ─────────────────────────────────────
/**
 * 桩的源码。**用字符串数组拼**，所以里面既没有反引号也没有 `${`，
 * 不会跟本文件的语法打架（这是同目录那套踩过的坑）。
 *
 * 它做四件事，每一件都对应本文件的一条承重断言：
 *   ① 收到带 `PROBE_ALLOW` 的对话 → 吐一条**带 sandbox_permissions** 的 pwsh 调用
 *      （`danger-full-access`），于是这条调用必然撞上审批闸；
 *   ② 收到 `PROBE_PLAIN` → 吐**同一条命令但不带** sandbox_permissions，
 *      用来证明「文件没出现」不是因为命令本身跑不通；
 *   ③ 收到 `PROBE_CANCEL` → 先睡 6 秒，给客户端一个发送 `session/cancel` 的窗口；
 *   ④ 每一轮都把它**看到的对话**折成一行事实（prior/now/msgs/policy/sandbox）
 *      回吐出来——这是「续接真的发生了」与「权限继承到没到」的唯一出口。
 *
 * 它 import 的只有 `@deepseek-ai/dsh-llm`（模型抽象），没有任何文件系统能力：
 * 磁盘上那个 sentinel 文件只可能是真 pwsh 进程写的（与
 * `headless-real-tool.test.mjs` 同一条纪律）。
 */
function stubSource({ tokens, sentinels }) {
  return [
    '// Legion 探针行（由 session-boundary-real-process.test.mjs 生成，不是产品代码）。',
    '// 它只供应模型流：不 import 文件系统/子进程，不派发任何工具。',
    "import { ToolCallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'",
    '',
    'const TOKENS = ' + JSON.stringify(tokens),
    'const SENTINELS = ' + JSON.stringify(sentinels),
    'const MARK_PLAIN = ' + JSON.stringify(MARK_PLAIN),
    'const MARK_CANCEL = ' + JSON.stringify(MARK_CANCEL),
    'const PROBE_ALLOW = ' + JSON.stringify(MARK_ALLOW),
    'const CALL_ID = ' + JSON.stringify(PROBE_CALL_ID),
    '',
    '/** 把对话摊成 [{role, text}]，只读 leaf 字段。 */',
    'function collect(options) {',
    '  const parts = []',
    '  for (const message of options.messages) {',
    '    let text = ""',
    '    for (const block of message.content) {',
    "      if (block.type === 'text') text += block.text",
    '    }',
    '    parts.push({ role: message.role, text: text })',
    '  }',
    '  return parts',
    '}',
    '',
    '/** 桩在系统提示里读到的沙箱模式（模型看到的事实，不是服务内部状态）。 */',
    'function sandboxModeOf(all) {',
    "  const marker = 'Current DSH file policy: '",
    '  const at = all.lastIndexOf(marker)',
    "  if (at < 0) return 'unreported'",
    '  const rest = all.slice(at + marker.length)',
    "  const modes = ['danger-full-access', 'workspace-write', 'read-only']",
    '  for (const mode of modes) {',
    '    if (rest.startsWith(mode)) return mode',
    '  }',
    "  return 'unparsed'",
    '}',
    '',
    '/** 桩在对话里读到的审批策略句。 */',
    'function policyOf(all) {',
    "  if (all.includes('Approval prompts are disabled in this session')) return 'never'",
    "  if (all.includes('Approval policy: ask')) return 'ask'",
    "  return 'unreported'",
    '}',
    '',
    '/** 本轮要写的那个 sentinel：取对话里**最近一次**点名（lastIndexOf 最大者）。 */',
    'function targetOf(all) {',
    '  let index = 0',
    '  let best = -1',
    '  for (let at = 0; at < TOKENS.length; at += 1) {',
    "    const found = all.lastIndexOf('PROBE_TARGET_' + (at + 1))",
    '    if (found > best) { best = found; index = at }',
    '  }',
    '  return { token: TOKENS[index], sentinel: SENTINELS[index] }',
    '}',
    '',
    'class LegionProbeAdapter extends LlmAdapter {',
    '  async resolveModel(provider, model) {',
    '    return {',
    '      provider, id: model, name: model,',
    "      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }],",
    "        defaultEffort: ReasoningEffortId('off') },",
    '    }',
    '  }',
    '  async * stream(options) {',
    '    const parts = collect(options)',
    "    const all = parts.map((part) => part.text).join('\\n')",
    '    const target = targetOf(all)',
    "    const facts = 'prior=' + (all.includes(TOKENS[0]) ? 1 : 0)",
    "      + ' now=' + (all.includes(TOKENS[1]) ? 1 : 0)",
    "      + ' msgs=' + options.messages.length",
    "      + ' policy=' + policyOf(all)",
    "      + ' sandbox=' + sandboxModeOf(all)",
    '',
    '    if (all.includes(MARK_CANCEL)) {',
    '      await new Promise((resolve) => setTimeout(resolve, 6000))',
    "      const text = 'CANCEL_SURVIVED'",
    "      yield { type: 'block-start', index: 0, blockType: 'text' }",
    "      yield { type: 'text-delta', index: 0, text: text }",
    "      yield { type: 'block-end', index: 0, block: { type: 'text', text: text } }",
    "      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }",
    "      yield { type: 'finish', reason: { kind: 'stop' } }",
    '      return',
    '    }',
    '',
    '    const last = options.messages.at(-1)',
    '    let toolResult',
    '    if (last !== undefined) {',
    "      toolResult = last.content.find((block) => block.type === 'tool-result')",
    '    }',
    '',
    '    if (toolResult === undefined) {',
    '      // 最近一次点名决定这一轮要不要带升级参数（历史里两种标记都可能躺着）。',
    '      const escalate = all.lastIndexOf(MARK_PLAIN) < all.lastIndexOf(PROBE_ALLOW)',
    "      const command = \"Set-Content -LiteralPath '\" + target.sentinel + \"' -Value '\"",
    "        + target.token + \"'; Get-Content -LiteralPath '\" + target.sentinel + \"'\"",
    '      const args = JSON.stringify({',
    '        command: command,',
    "        description: 'legion session-boundary probe',",
    '        ...escalate ? {',
    "          sandbox_permissions: 'danger-full-access',",
    "          justification: 'the probe needs one approved escalation to write its sentinel',",
    '        } : {},',
    '      })',
    '      const id = ToolCallId(CALL_ID)',
    "      yield { type: 'block-start', index: 0, blockType: 'tool-call' }",
    "      yield { type: 'tool-call-delta', index: 0, id, name: 'pwsh', argumentsDelta: args }",
    "      yield { type: 'block-end', index: 0,",
    "        block: { type: 'tool-call', id, name: 'pwsh', arguments: args } }",
    "      yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }",
    "      yield { type: 'finish', reason: { kind: 'tool-calls' } }",
    '      return',
    '    }',
    '',
    "    const observed = toolResult.content",
    "      .filter((block) => block.type === 'text')",
    "      .map((block) => block.text).join('')",
    "    const text = 'LEGION_RESULT ' + facts + ' TOOL<' + observed.slice(0, 400) + '>'",
    "    yield { type: 'block-start', index: 0, blockType: 'text' }",
    "    yield { type: 'text-delta', index: 0, text: text }",
    "    yield { type: 'block-end', index: 0, block: { type: 'text', text: text } }",
    "    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 4 } }",
    "    yield { type: 'finish', reason: { kind: 'stop' } }",
    '  }',
    '}',
    '',
    "export const name = 'probe-acp-llm'",
    "export const inject = ['llm']",
    'export function apply(ctx) {',
    `  ctx.llm.registerAdapter([${JSON.stringify(PROBE_PROVIDER)}], new LegionProbeAdapter())`,
    '}',
    '',
  ].join('\n')
}

// ── 一次性 profile ────────────────────────────────────────────────────────
/** profile 自己声明的 shipped bundle 列表（与 `PROFILE_TEMPLATES.acp` 一致）。 */
function profilePackageJson() {
  return JSON.stringify({
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
        patchReload: 'startup',
      },
    },
  }, undefined, 2) + '\n'
}

/** 三段 overlay 块：模型接缝 / 噪音关闭 / 明文持久化。 */
const OVERLAY_SEAM = '- id: acp\n'
  + '  config:\n'
  + `    provider: ${PROBE_PROVIDER}\n`
  + `    model: ${PROBE_PROVIDER}\n`

const OVERLAY_DISABLES = '- id: session-title-llm\n'
  + '  disabled: true\n'
  + '\n'
  + '- id: plugin-package-inventory-deepseek\n'
  + '  disabled: true\n'

/**
 * 会话日志写成**明文**。不是风格偏好：默认的多帧 zstd 无法用 Node 内置的
 * `zstdDecompressSync` 读完（只解第一帧），于是「日志里有没有那对审批事件」
 * 会退化成「我只读到了第一条记录」。
 */
const OVERLAY_PERSISTENCE = '- id: session-persistence-jsonl\n'
  + '  config:\n'
  + "    root: !!js dshHomePath('sessions')\n"
  + '    compression: none\n'

const OVERLAY_INSERT = '- insert:\n'
  + '    - id: probe-acp-llm\n'
  + `      name: './${STUB_NAME}'\n`

const OVERLAY_MAIN_TEXT = [OVERLAY_SEAM, OVERLAY_DISABLES, OVERLAY_PERSISTENCE, OVERLAY_INSERT].join('\n')

/**
 * `never` 负对照：在主 overlay 之上**只**加两块——把审批策略钉成 `never`，
 * 并把预设表补成能容纳 (workspace-write, never) 这一组合
 * （否则 `permission-presets` 的 derive 会落到 `custom` 并在启动时抛错）。
 *
 * `permission` 那一块不是「顺便改的」：预设表是**整体替换**的，
 * 所以这里必须把 workspace-write 那一行照抄回来，否则 composed
 * `(workspace-write, ask)` 会失去它的预设名。
 */
const OVERLAY_NEVER_EXTRA = '- id: approval\n'
  + '  config:\n'
  + '    policy: never\n'
  + '\n'
  + '- id: permission\n'
  + '  config:\n'
  + '    presets:\n'
  + '      workspace-write:\n'
  + '        sandbox: workspace-write\n'
  + '        approval: ask\n'
  + '      never-ask:\n'
  + '        sandbox: workspace-write\n'
  + '        approval: never\n'
  + '    defaultPreset: never-ask\n'

/** 负例 overlay = 正例 overlay + 那两块；差别被机器逐字节核对（见第一条用例）。 */
const OVERLAY_NEVER_TEXT = OVERLAY_MAIN_TEXT + OVERLAY_NEVER_EXTRA

/** 一次性 home：`$DSH_HOME` + agents home + cwd 各自独立，且都在 scratch 之下。 */
function makeHome(tag) {
  const home = mkTemp(`home-${tag}-`)
  const agents = mkTemp(`agents-${tag}-`)
  const cwd = mkTemp(`cwd-${tag}-`)
  const profileDir = join(home, 'profiles', PROFILE_NAME)
  mkdirSync(profileDir, { recursive: true })
  return { home, agents, cwd, profileDir }
}

/** 把一次性 profile 写满：package.json + 桩 + 两份 overlay（都写，选哪份只在命令行上）。 */
function writeHome({ profileDir }, stub, ) {
  writeFileSync(join(profileDir, 'package.json'), profilePackageJson())
  writeFileSync(join(profileDir, STUB_NAME), stub)
  writeFileSync(join(profileDir, OVERLAY_MAIN), OVERLAY_MAIN_TEXT)
  writeFileSync(join(profileDir, OVERLAY_NEVER), OVERLAY_NEVER_TEXT)
}

/**
 * 子进程环境：一次性 home、删掉 `DSH_SNAPSHOT`/`DSH_SESSION_ID`/`DSH_WEB_URL`/
 * 凭证变量，`DSH_PERMISSION_MODE` 决定**这个进程**的沙箱默认与审批默认
 * （`packages/bundle/base/cordis.patch.yml:211` 与 `:227` 两行各自读它）。
 */
function childEnv({ home, agents }, permissionMode) {
  const env = { ...process.env }
  delete env.DSH_SNAPSHOT
  delete env.DSH_SESSION_ID
  delete env.DSH_WEB_URL
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEEK_BASE_URL
  Object.assign(env, {
    DSH_HOME: home,
    DSH_AGENTS_HOME: agents,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: permissionMode,
  })
  return env
}

// ── ACP 客户端：真对话循环（ND-JSON 一行一条）──────────────────────────────
/**
 * 一个最小的 ACP 客户端。它做三件 spawnSync 做不到的事：
 *   ① 按 `id` 配请求与响应（会话 id 是服务端随机给的，必须先读到才能用）；
 *   ② 处理**服务端反向请求**（`session/request_permission`）并现场按策略作答；
 *   ③ 收集 `session/update` 通知（事件续接的读数全在这里）。
 *
 * framing 按源码：`JSON.stringify(message) + '\n'`，没有 Content-Length 头。
 */
class AcpClient {
  constructor(child, { answer }) {
    this.child = child
    this.answer = answer
    this.nextId = 1
    this.pending = new Map()
    this.updates = []
    this.permissionRequests = []
    this.otherServerRequests = []
    this.stderr = ''
    this.unparsedLines = []
    this.exited = null
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { this.stderr += chunk })
    child.on('exit', (code, signal) => { this.exited = { code, signal } })
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', (line) => this.#onLine(line))
  }

  #onLine(line) {
    const trimmed = line.trim()
    if (trimmed === '') return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      // 非 JSON 的 stdout 行是**异常读数**，单独存起来而不是丢掉：
      // 「ACP 的 stdout 只属于协议」这句话本身就是一条契约。
      this.unparsedLines.push(trimmed.slice(0, 200))
      return
    }
    // 服务端 → 客户端的请求：有 id、有 method。
    if (message.method !== undefined && message.id !== undefined) {
      this.#onServerRequest(message)
      return
    }
    // 通知：有 method、没有 id。
    if (message.method !== undefined) {
      if (message.method === 'session/update') {
        this.updates.push({ sessionId: message.params?.sessionId, update: message.params?.update })
      }
      return
    }
    // 我们发出的请求的响应。
    if (message.id !== undefined) {
      const settle = this.pending.get(message.id)
      if (settle === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) settle.reject(new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`))
      else settle.resolve(message.result)
    }
  }

  #onServerRequest(message) {
    if (message.method === 'session/request_permission') {
      this.permissionRequests.push(message.params)
      this.#write({ jsonrpc: '2.0', id: message.id, result: this.answer(message.params) })
      return
    }
    this.otherServerRequests.push({ method: message.method, params: message.params })
    this.#write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `legion probe client does not implement ${message.method}` },
    })
  }

  #write(message) {
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  request(method, params, timeoutMs = 90_000) {
    const id = this.nextId
    this.nextId += 1
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP 请求超时 ${timeoutMs}ms：${method}\nstderr:\n${this.stderr.slice(-2000)}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
    })
    this.#write({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  /** 关掉 stdin：ACP 连接随之关闭，进程 quiesce 后退出。 */
  endInput() {
    this.child.stdin.end()
  }

  /** 等进程退出（或超时后强杀）。 */
  waitExit(timeoutMs = 60_000) {
    if (this.exited !== null) return Promise.resolve(this.exited)
    return new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        this.child.kill()
        resolveExit({ code: null, signal: 'TIMEOUT-KILL', timedOut: true })
      }, timeoutMs)
      this.child.once('exit', (code, signal) => {
        clearTimeout(timer)
        resolveExit({ code, signal })
      })
    })
  }

  /** 进程此刻是否还活着（`exitCode === null` 且没收到 exit 事件）。 */
  isAlive() {
    return this.exited === null && this.child.exitCode === null
  }

  /** 所有 `agent_message_chunk` 的文本，按到达顺序。 */
  agentTexts() {
    return this.updates
      .filter((entry) => entry.update?.sessionUpdate === 'agent_message_chunk')
      .map((entry) => (entry.update.content?.type === 'text' ? entry.update.content.text : ''))
  }

  /** 所有 `tool_call` / `tool_call_update` 的 update。 */
  toolUpdates() {
    return this.updates
      .map((entry) => entry.update)
      .filter((update) => update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update')
  }

  kill() {
    try { this.child.kill() } catch { /* 已经退出的进程杀不动是正常的 */ }
    try { this.lines.close() } catch { /* 同上 */ }
  }
}

/** 批准作答：选 allow-once；选项缺席时 fail closed 地取消。 */
function allowOnce(params) {
  const option = params.options.find((entry) => entry.optionId === 'allow-once')
  if (option === undefined) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}

/** 拒绝作答：选 reject-once。 */
function rejectOnce(params) {
  const option = params.options.find((entry) => entry.optionId === 'reject-once')
  if (option === undefined) return { outcome: { outcome: 'cancelled' } }
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}

/** 起一个真 ACP 子进程。 */
function spawnAcp({ home, agents, cwd, overlayName, permissionMode, answer }) {
  const started = Date.now()
  const child = spawn(process.execPath, [
    CLI, '--profile', PROFILE_NAME, '--patch', join(home, 'profiles', PROFILE_NAME, overlayName),
  ], {
    cwd,
    env: childEnv({ home, agents }, permissionMode),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const client = new AcpClient(child, { answer })
  return { child, client, started }
}

// ── 会话日志 ──────────────────────────────────────────────────────────────
/** 一次性 home 下的全部会话日志（`.jsonl` / `.jsonl.zstd`），排序后返回。 */
function sessionLogFiles(home) {
  const root = join(home, SESSIONS_DIR)
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) out.push(path)
    }
  }
  walk(root)
  return out.sort()
}

/** 只吃明文；真读到 zstd 就**如实报错**，而不是把压缩字节当文本 split。 */
function readRecords(file) {
  const raw = readFileSync(file)
  if (raw.subarray(0, 4).toString('hex') === '28b52ffd') {
    throw new Error(`会话日志是 zstd 压缩的（${file}）——本套件依赖 compression: none 的明文日志`)
  }
  return raw.toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

const ofType = (records, type) => records.filter((record) => record.type === type)

/** 从一条 `tool/result` 记录里取三个 leaf 字段（不整对象搬运）。 */
function resultFacts(record) {
  const message = record?.data?.message
  const block = Array.isArray(message?.content)
    ? message.content.find((entry) => entry?.type === 'tool-result')
    : undefined
  const text = Array.isArray(block?.content)
    ? block.content.filter((entry) => entry?.type === 'text').map((entry) => entry.text).join('')
    : ''
  return { toolCallId: block?.toolCallId ?? null, isError: block?.isError ?? null, text }
}

// ── 场景（一个场景 = 一个真子进程；同一个场景只起一次）────────────────────
const SCENARIOS = new Map()

/**
 * 场景只跑一次，多条用例共用读数。
 *
 * 理由与同目录那套一样：每一条断言都是**同一次运行里两个读数之间的关系**
 * （审批口与磁盘、续接前的日志与续接后的对话）。分成两次进程去读，
 * 两边的差异就可能是「进程不同」而不是断言在问的那件事。
 */
function scenario(name, build) {
  if (!SCENARIOS.has(name)) SCENARIOS.set(name, Promise.resolve().then(build))
  return SCENARIOS.get(name)
}

// 一次 run 内共用的 token（每个 home 一套文件，互不干扰）。
const TOKENS = [mintToken('T1'), mintToken('T2'), mintToken('T3')]

/**
 * home 的构造：**同一个桩源码**、**同一份 overlay**、同一个 fake 模型路由。
 * sentinel 用裸文件名（见 `SENTINEL_NAMES`），所以桩源码与 home 无关——
 * 「两个 home 只差策略」这句话是可以逐字节核对的。
 */
function buildHome(tag) {
  const base = makeHome(tag)
  const stub = stubSource({ tokens: TOKENS, sentinels: [...SENTINEL_NAMES] })
  writeHome(base, stub)
  return { ...base, sentinels: SENTINEL_NAMES.map((name) => join(base.cwd, name)), stub }
}

/** 全部读数：stdout 侧（ACP）与磁盘侧（日志、sentinel）。 */
function readings(base, client, exit, elapsedMs, extra = {}) {
  const logFiles = sessionLogFiles(base.home)
  const records = logFiles.flatMap(readRecords)
  return {
    ...base,
    client,
    exit,
    elapsedMs,
    logFiles,
    records,
    updates: client.updates,
    permissionRequests: client.permissionRequests,
    agentTexts: client.agentTexts(),
    toolUpdates: client.toolUpdates(),
    stderr: client.stderr,
    unparsedLines: client.unparsedLines,
    otherServerRequests: client.otherServerRequests,
    ...extra,
  }
}

/**
 * 场景 1（H1，workspace-write，MAIN overlay，客户端一律 allow-once）：
 *   ① `session/new` → sid
 *   ② `session/prompt`（PROBE_ALLOW + TOKEN1）→ 桩发**带升级**的 pwsh 调用
 *      → 审批口发 `session/request_permission` → 答 allow-once → sentinel1 落盘
 *   ③ 同一会话**第二次** `session/prompt`（PROBE_ALLOW + TOKEN3）——
 *      一次性授权不该变成持久授权，所以这里**必须再问一次**
 *   ④ `session/close` → 关 stdin → 退出
 */
const buildAllow = () => scenario('allow', async () => {
  const base = buildHome('h1-allow')
  const { child, client, started } = spawnAcp({ ...base, overlayName: OVERLAY_MAIN, permissionMode: 'workspace-write', answer: allowOnce })
  try {
    const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const created = await client.request('session/new', { cwd: base.cwd, mcpServers: [] })
    const sessionId = created.sessionId

    const first = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `${MARK_ALLOW} ${TARGET_MARK(0)} ${TOKENS[0]} write the first sentinel` }],
    })
    const firstText = client.agentTexts().at(-1) ?? ''

    const second = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `${MARK_ALLOW} ${TARGET_MARK(2)} ${TOKENS[2]} write the third sentinel` }],
    })

    await client.request('session/close', { sessionId })
    client.endInput()
    const exit = await client.waitExit()
    return readings(base, client, exit, Date.now() - started, {
      init,
      sessionId,
      first,
      firstText,
      second,
      child,
      tokens: TOKENS,
    })
  } finally {
    client.kill()
  }
})

/**
 * 场景 2（H1，**danger-full-access**，MAIN overlay）：**另一个进程**里 resume
 * 同一个 sid 再跑一轮（PROBE_ALLOW + TOKEN2）。
 *
 * 这一场景的 env 与场景 1 **不同**，这是承重的：H1 的会话日志里写着
 * `sandbox/mode: workspace-write` 与 `approval/policy: ask`，
 * 而这个进程的**组合默认**是 danger-full-access / never（base 的
 * `cordis.patch.yml:211` 与 `:227` 两行各自从 `DSH_PERMISSION_MODE` 推导）。
 * 于是「继承到没到」在两个方向上都有读数：
 *   · 桩报 `sandbox=`：会话自己的日志赢 ⇒ workspace-write（不是进程默认的 danger-full-access）
 *   · 桩报 `policy=`：会话自己的日志赢 ⇒ ask（不是进程默认的 never）
 *   · 升级仍然被问：只有 effective mode = workspace-write 才「严格更宽」，
 *     只有 policy = ask 才会走到 waterfall 并触碰 ACP 桥。
 * 三个读数指向同一件事；任何一个没继承到，这一轮都会以**不同的**失败文本暴露
 * （`not strictly wider` / `the user rejected escalating`）。
 */
const buildResume = () => scenario('resume', async () => {
  const prior = await buildAllow()
  const base = prior
  const { child, client, started } = spawnAcp({
    ...base,
    overlayName: OVERLAY_MAIN,
    permissionMode: 'danger-full-access',
    answer: allowOnce,
  })
  try {
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    // 先 list：会话在**另一个进程**的持久层里应当已经可见（身份写在磁盘上）。
    const listed = await client.request('session/list', {})
    const resumed = await client.request('session/resume', {
      sessionId: prior.sessionId,
      cwd: base.cwd,
      mcpServers: [],
    })
    const turn = await client.request('session/prompt', {
      sessionId: prior.sessionId,
      prompt: [{ type: 'text', text: `${MARK_ALLOW} ${TARGET_MARK(1)} ${TOKENS[1]} continue the resumed session` }],
    })
    await client.request('session/close', { sessionId: prior.sessionId })
    client.endInput()
    const exit = await client.waitExit()
    const after = readings(base, client, exit, Date.now() - started, {
      listed,
      resumed,
      turn,
      turnText: client.agentTexts().at(-1) ?? '',
      child,
      prior,
    })
    // H1 的日志在这一步之后才完整（两个进程往同一个会话追加）。
    return after
  } finally {
    client.kill()
  }
})

/**
 * 场景 3（H2，workspace-write，MAIN overlay）：拒绝则不执行，**随后**在同一个
 * 会话里跑一条**不带升级**的同形状命令。
 *
 * 后一条是防假绿的：没有它，「sentinel 没出现」在一个连命令都跑不通
 * （被沙箱挡住、pwsh 起不来）的世界里也是绿的。
 */
const buildReject = () => scenario('reject', async () => {
  const base = buildHome('h2-reject')
  const { child, client, started } = spawnAcp({ ...base, overlayName: OVERLAY_MAIN, permissionMode: 'workspace-write', answer: rejectOnce })
  try {
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const created = await client.request('session/new', { cwd: base.cwd, mcpServers: [] })
    const sessionId = created.sessionId
    const denied = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `${MARK_ALLOW} ${TARGET_MARK(0)} ${TOKENS[0]} this escalated write must be refused` }],
    })
    const deniedText = client.agentTexts().at(-1) ?? ''
    const plain = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `${MARK_PLAIN} ${TARGET_MARK(2)} ${TOKENS[2]} this one needs no approval` }],
    })
    const plainText = client.agentTexts().at(-1) ?? ''
    await client.request('session/close', { sessionId })
    client.endInput()
    const exit = await client.waitExit()
    return readings(base, client, exit, Date.now() - started, {
      sessionId, denied, deniedText, plain, plainText, child,
    })
  } finally {
    client.kill()
  }
})

/**
 * 场景 4（H3，workspace-write，**NEVER overlay**）：审批口**根本没被咨询**。
 *
 * 客户端仍然配了 reject-once 作答器，但断言的是它**一次都没被调用**：
 * `ApprovalService.decide` 在 waterfall 之前就用
 * `effectivePolicy === 'never'` 返回了 `'rejected'`
 * （`packages/interaction/user-approval/src/index.ts:268`）。
 */
const buildNever = () => scenario('never', async () => {
  const base = buildHome('h3-never')
  const { child, client, started } = spawnAcp({ ...base, overlayName: OVERLAY_NEVER, permissionMode: 'workspace-write', answer: rejectOnce })
  try {
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const created = await client.request('session/new', { cwd: base.cwd, mcpServers: [] })
    const sessionId = created.sessionId
    const turn = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `${MARK_ALLOW} ${TARGET_MARK(0)} ${TOKENS[0]} the policy is never, so nobody is asked` }],
    })
    const turnText = client.agentTexts().at(-1) ?? ''
    await client.request('session/close', { sessionId })
    client.endInput()
    const exit = await client.waitExit()
    return readings(base, client, exit, Date.now() - started, { sessionId, turn, turnText, child })
  } finally {
    client.kill()
  }
})

/**
 * 场景 5（H4，workspace-write，MAIN overlay）：取消边界。
 *
 * 桩在 `PROBE_CANCEL` 那一轮先睡 6 秒，客户端在 1.5 秒时发 `session/cancel`
 * 通知（**没有 id** 的那条）。要读的是两件事，而且必须分开读：
 *   · 会话报告了什么（`session/prompt` 的 `stopReason` 应当是 `cancelled`）
 *   · 进程是死了还是活着（活着才有「干净地取消」可言）
 */
const buildCancel = () => scenario('cancel', async () => {
  const base = buildHome('h4-cancel')
  const { child, client, started } = spawnAcp({ ...base, overlayName: OVERLAY_MAIN, permissionMode: 'workspace-write', answer: allowOnce })
  try {
    await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const created = await client.request('session/new', { cwd: base.cwd, mcpServers: [] })
    const sessionId = created.sessionId
    const promptPromise = client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `${MARK_CANCEL} hold the turn open` }],
    })
    await new Promise((done) => setTimeout(done, 1500))
    client.notify('session/cancel', { sessionId })
    const turn = await promptPromise
    const aliveAfterCancel = client.isAlive()
    // 活着的话，它还得能继续服务——否则「活着」只是一个还没回收的僵尸。
    const closed = await client.request('session/close', { sessionId })
    client.endInput()
    const exit = await client.waitExit()
    return readings(base, client, exit, Date.now() - started, {
      sessionId, turn, closed, aliveAfterCancel, child, agentTextsAfterCancel: client.agentTexts(),
    })
  } finally {
    client.kill()
  }
})

// ── 用例 ──────────────────────────────────────────────────────────────────

describe('真 ACP 会话协议 × continuable session 边界（一次性 home）', () => {
  guarded('★★★★ 会话建立与一轮完成：session/new 给出 id，session/prompt 在批准后真的落盘', async (t) => {
    const r = await buildAllow()

    // 两个 overlay 的差别被机器逐字节核对：`never` 负例 = 主例 + 那两块。
    assert.equal(OVERLAY_NEVER_TEXT, OVERLAY_MAIN_TEXT + OVERLAY_NEVER_EXTRA,
      'never 负例 overlay 不是主 overlay 加上策略钉死那两块——那它问的就不是「同一件事换个策略」')
    assert.equal(OVERLAY_MAIN_TEXT.includes('policy: never'), false, '主 overlay 里混进了 never 策略')
    assert.equal(OVERLAY_NEVER_TEXT.includes('policy: never'), true, 'never overlay 里没有 never 策略')

    // 协议面：initialize 的能力宣称（`packages/acp/acp/src/index.ts:183-187`）。
    assert.equal(r.init.agentInfo.name, 'deepseek-harness-acp', `agentInfo 不是预期的：${JSON.stringify(r.init.agentInfo)}`)
    assert.deepEqual(Object.keys(r.init.agentCapabilities.sessionCapabilities).sort(), ['close', 'list', 'resume'],
      'sessionCapabilities 不是 {close,list,resume}——resume 这一面正是本套件要压的')
    assert.equal(r.init.authMethods.length, 0, 'ACL 认证面无故多出条目')

    // session/new 真的给了 id（而且是品牌的 UUID 形状）。
    assert.equal(typeof r.sessionId, 'string', `session/new 没有给出 sessionId：${JSON.stringify(r.sessionId)}`)
    assert.match(r.sessionId, /^[0-9a-f-]{36}$/i, `sessionId 不是 UUID 形状：${r.sessionId}`)

    // ★ 承重断言：带外副作用。桩没有文件系统能力，这个文件只可能由真 pwsh 写。
    assert.ok(existsSync(r.sentinels[0]), `sentinel1 不存在：${r.sentinels[0]}`)
    assert.equal(readFileSync(r.sentinels[0], 'utf8').trim(), TOKENS[0], 'sentinel1 的内容不是本次 mint 的 token1')

    // 审批口真的响过，而且只提供一次性选项。
    assert.equal(r.permissionRequests.length, 2,
      `两次升级应当各问一次（一次性授权不该变成持久授权），实际 ${r.permissionRequests.length} 次`)
    for (const params of r.permissionRequests) {
      assert.equal(params.sessionId, r.sessionId, 'session/request_permission 的 sessionId 不是本次会话')
      assert.equal(typeof params.toolCall?.toolCallId, 'string', 'session/request_permission 缺 toolCallId')
      assert.deepEqual(params.options.map((o) => o.optionId).sort(), ['allow-once', 'reject-once'],
        `一次性选项面不是 [allow-once, reject-once]：${JSON.stringify(params.options)}`)
    }

    // stdout 只属于协议：没有一行非 JSON。
    assert.deepEqual(r.unparsedLines, [], `ACP 的 stdout 上出现了非 JSON 行：${JSON.stringify(r.unparsedLines)}`)
    assert.deepEqual(r.otherServerRequests, [], `出现了本客户端未实现的 agent→client 请求：${JSON.stringify(r.otherServerRequests)}`)

    // 停止原因是标准词汇。
    assert.equal(r.first.stopReason, 'end_turn', `第一轮 stopReason 不是 end_turn：${r.first.stopReason}`)
    assert.equal(r.second.stopReason, 'end_turn', `第二轮 stopReason 不是 end_turn：${r.second.stopReason}`)

    // 通知面：只有标准 update，而且全部归属同一个 sessionId。
    const kinds = new Set(r.updates.map((entry) => entry.update?.sessionUpdate))
    for (const kind of kinds) {
      assert.ok(STANDARD_UPDATES.has(kind), `出现了非标准的 session/update：${kind}`)
    }
    assert.ok(kinds.has('tool_call') && kinds.has('tool_call_update'), '通知里没有工具生命周期：' + [...kinds].join(','))
    for (const entry of r.updates) {
      assert.equal(entry.sessionId, r.sessionId, 'session/update 的 sessionId 不是本次会话')
    }

    // 日志侧：一次会话一份明文日志，cwd 与本次子进程一致。
    assert.equal(r.logFiles.length, 1, `应当恰好一份会话日志，实际 ${r.logFiles.length}：${r.logFiles.join(' | ')}`)
    const session = ofType(r.records, 'session')[0]
    assert.notEqual(session, undefined, '会话日志里没有 session 记录')
    assert.equal(resolve(session.cwd), resolve(r.cwd), `日志的 cwd（${session.cwd}）不是本次子进程的 cwd（${r.cwd}）`)

    // 审批审计对：两次都是 allowed-once。
    const decided = ofType(r.records, 'approval/decided').map((record) => record.data.outcome)
    assert.deepEqual(decided, ['allowed-once', 'allowed-once'],
      `日志里的审批结论不是两次 granted：${JSON.stringify(decided)}`)

    // 工具结果对得上那条调用，且不是失败态。
    const calls = ofType(r.records, 'tool/call')
    const results = ofType(r.records, 'tool/result')
    assert.equal(calls.length, 2, `应当恰好两条 tool/call，实际 ${calls.length}`)
    assert.equal(results.length, 2, `应当恰好两条 tool/result，实际 ${results.length}`)
    for (const result of results) {
      const facts = resultFacts(result)
      assert.equal(facts.isError, false, `工具结果失败：${JSON.stringify(facts.text).slice(0, 300)}`)
    }

    assert.equal(r.exit.code, 0, `子进程应当 exit 0，实际 code=${r.exit.code} signal=${r.exit.signal}\n${r.stderr.slice(-2000)}`)
    t.diagnostic(`ALLOW sid=${r.sessionId} perm=2 sentinel1=1 sentinel3=${existsSync(r.sentinels[2]) ? 1 : 0} exit=0 ${r.elapsedMs}ms`)
  })

  guarded('★★★★★ 拒绝则不执行：审批口说了不，那条命令一次都没跑', async (t) => {
    const r = await buildReject()

    // 闸门真的被咨询过，而且给的是那道一次性选择题。
    assert.equal(r.permissionRequests.length, 1, `拒绝那一轮应当恰好问一次，实际 ${r.permissionRequests.length} 次`)
    assert.equal(r.permissionRequests[0].sessionId, r.sessionId, '审批请求挂的不是本次会话')

    // ★ 世界：被拒的那条**没写**，同形状、不经审批的那条**写了**。
    assert.equal(existsSync(r.sentinels[0]), false,
      '升级被拒却还是写出了 sentinel1——审批口没有拦住执行')
    assert.ok(existsSync(r.sentinels[2]), `不经审批的对照命令没写出 sentinel3：${r.sentinels[2]}`)
    assert.equal(readFileSync(r.sentinels[2], 'utf8').trim(), TOKENS[2], 'sentinel3 的内容不是本次 mint 的 token3')

    // 审计对：恰好一条 decided，而且是 `rejected`——**不是** `cancelled`、
    // **不是** `unavailable`。三者含义完全不同：只有 `rejected` 是「机器说了不」。
    const decided = ofType(r.records, 'approval/decided').map((record) => record.data.outcome)
    assert.deepEqual(decided, ['rejected'],
      `审批结论不是一次 rejected：${JSON.stringify(decided)}（cancelled=signal 中止，unavailable=没有 answerer）`)

    // 被拒那一轮的工具结果是**具名失败**，不是「进程死了」。
    const results = ofType(r.records, 'tool/result')
    assert.equal(results.length, 2, `应当恰好两条 tool/result（一拒一放），实际 ${results.length}`)
    const denied = resultFacts(results[0])
    assert.equal(denied.isError, true, '被拒的那条工具结果是成功态')
    assert.match(denied.text, /rejected escalating this command to "danger-full-access"/,
      `失败原因不是「升级被拒」：${JSON.stringify(denied.text).slice(0, 300)}`)
    assert.equal(resultFacts(results[1]).isError, false, '对照那条不经审批的命令不该失败')

    // 「拒绝」与「进程死了」是两件事：同一个进程还活着服务完了第二轮，并以 0 退出。
    assert.equal(r.denied.stopReason, 'end_turn', `拒绝那一轮 stopReason 不是 end_turn：${r.denied.stopReason}`)
    assert.equal(r.plain.stopReason, 'end_turn', `对照那一轮 stopReason 不是 end_turn：${r.plain.stopReason}`)
    assert.equal(r.exit.code, 0, `子进程应当 exit 0，实际 code=${r.exit.code} signal=${r.exit.signal}`)

    // ACP 侧的工具卡：拒绝那一轮以 failed 收尾（不是静默丢掉）。
    const failed = r.toolUpdates.filter((update) => update.sessionUpdate === 'tool_call_update' && update.status === 'failed')
    assert.equal(failed.length, 1, `被拒的工具卡应当恰好一张 failed，实际 ${failed.length}`)

    t.diagnostic(`REJECT perm=1 decided=rejected sentinel1=0 sentinel3=1 exit=0 ${r.elapsedMs}ms`)
  })

  guarded('★★★★★ never 负对照：闸门被咨询了，ACP 审批口一次都没响', async (t) => {
    const r = await buildNever()

    // ★ 承重断言：**零次** session/request_permission。
    //
    // 这一条与上面那条「拒绝」在「文件没出现」上同形；区别只在这里。
    // 一个只在世界状态上断言的套件，会在整个 ACP 桥缺失时也是绿的。
    assert.equal(r.permissionRequests.length, 0,
      `策略是 never，却有 ${r.permissionRequests.length} 次 session/request_permission——waterfall 本不该被派发`)
    assert.equal(existsSync(r.sentinels[0]), false, '策略是 never 却写出了 sentinel1')

    // 但审批**服务**确实被问过：审计对在日志里。
    assert.equal(ofType(r.records, 'approval/asked').length, 1,
      `neither asked 记录：${JSON.stringify(ofType(r.records, 'approval/asked'))}`)
    const decided = ofType(r.records, 'approval/decided').map((record) => record.data.outcome)
    assert.deepEqual(decided, ['rejected'],
      `never 策略的结论不是 rejected：${JSON.stringify(decided)}`)

    // 策略本身在会话日志里是 never（`permission-presets` 在 session/created 时钉进去的）。
    const policies = ofType(r.records, 'approval/policy').map((record) => record.data.policy)
    assert.deepEqual(policies, ['never'], `会话日志里的 approval/policy 不是 never：${JSON.stringify(policies)}`)

    // 桩从**系统提示**里读到的也是 never——模型被告知的口径与服务的行为一致。
    assert.match(r.turnText, /policy=never/, `桩读到的策略不是 never：${JSON.stringify(r.turnText).slice(0, 300)}`)
    assert.match(r.turnText, /the user rejected escalating this command to "danger-full-access"/,
      `失败文本不是「被拒绝」那一句：${JSON.stringify(r.turnText).slice(0, 400)}`)

    // 进程没有因此崩掉。
    assert.equal(r.turn.stopReason, 'end_turn', `stopReason 不是 end_turn：${r.turn.stopReason}`)
    assert.equal(r.exit.code, 0, `子进程应当 exit 0，实际 code=${r.exit.code} signal=${r.exit.signal}`)

    t.diagnostic(`NEVER perm=0 asked=1 decided=rejected sentinel1=0 exit=0 ${r.elapsedMs}ms`)
  })

  guarded('★★★★ 续接：另一个进程 resume 之后，那一轮真的接着上一次的对话跑', async (t) => {
    const r = await buildResume()
    const prior = r.prior

    // 先钉住两个进程的**唯一**差别是策略默认：同一个 overlay、同一个桩、同一个 home。
    assert.equal(prior.profileDir, r.profileDir, 'resume 场景换了一个 home——那就不是同一个会话的续接')
    assert.equal(readFileSync(join(r.profileDir, STUB_NAME), 'utf8'), prior.stub,
      '两次运行的桩源码不同——那读数差可能来自桩而不是续接')

    // ★★ 承重断言：resume 那一轮的模型**看见了上一次那一轮的内容**。
    //
    // 这一条**不能**由「拿到一个 session id」或「有响应回来」代替：
    // 一个悄悄新开会话的实现，在这两条上同样是绿的。
    // 桩把「历史里有没有 token1」写成一行事实回吐，我们读那一行。
    assert.match(r.turnText, /prior=1/, `resume 之后模型没看见上一轮的内容：${JSON.stringify(r.turnText).slice(0, 400)}`)
    assert.match(r.turnText, /now=1/, `resume 之后模型没看见本轮提示：${JSON.stringify(r.turnText).slice(0, 400)}`)
    assert.match(prior.firstText, /prior=1 now=0/,
      `第一轮的读数形状不对（应当 prior=1 now=0）：${JSON.stringify(prior.firstText).slice(0, 300)}`)

    // 消息条数真的长长了（「续接」而不是「重放」）。
    const msgsOf = (text) => Number(/msgs=(\d+)/.exec(text)?.[1] ?? -1)
    assert.ok(msgsOf(r.turnText) > msgsOf(prior.firstText),
      `resume 之后的历史没有被追加：${msgsOf(prior.firstText)} -> ${msgsOf(r.turnText)}`)

    // 会话身份：resume **不返回新 id**（协议如此），客户端用的还是原来那个。
    assert.equal(Object.hasOwn(r.resumed, 'sessionId'), false,
      `session/resume 结果里出现了 sessionId 字段：${JSON.stringify(r.resumed)}`)
    assert.deepEqual(Object.keys(r.resumed), ['configOptions'],
      `session/resume 的返回形状变了：${JSON.stringify(Object.keys(r.resumed))}`)

    // 身份写在磁盘上：另一个进程的 session/list 里能看到它，且 cwd 一致。
    const listed = r.listed.sessions.filter((entry) => entry.sessionId === prior.sessionId)
    assert.equal(listed.length, 1,
      `session/list 在另一个进程里看不到这个会话：${JSON.stringify(r.listed.sessions)}`)
    assert.equal(resolve(listed[0].cwd), resolve(prior.cwd), `session/list 报的 cwd 与本次不同：${listed[0].cwd}`)

    // 续接那一轮仍然走完了工具生命周期，并把 sentinel2 写到了磁盘上。
    assert.equal(r.turn.stopReason, 'end_turn', `续接轮 stopReason 不是 end_turn：${r.turn.stopReason}`)
    assert.ok(existsSync(r.sentinels[1]), `续接轮没写出 sentinel2：${r.sentinels[1]}`)
    assert.equal(readFileSync(r.sentinels[1], 'utf8').trim(), TOKENS[1], 'sentinel2 的内容不是本次 mint 的 token2')

    assert.equal(r.exit.code, 0, `续接进程应当 exit 0，实际 code=${r.exit.code} signal=${r.exit.signal}（resume 失败会在 stdout 上给出 JSON-RPC 错误而不是退出码）`)

    t.diagnostic(`RESUME sid=${prior.sessionId} prior=1 now=1 msgs=${msgsOf(prior.firstText)}->${msgsOf(r.turnText)} exit=0 ${r.elapsedMs}ms`)
  })

  guarded('★★★ 身份与权限继承：跨进程恢复时，沙箱模式与审批策略都由**会话自己的日志**决定', async (t) => {
    const r = await buildResume()
    const prior = r.prior
    const log = r.records

    // 会话自己的落地事实：H1 第一个进程写下的两条 override 事件。
    const policies = ofType(log, 'approval/policy').map((record) => record.data.policy)
    const modes = ofType(log, 'sandbox/mode').map((record) => record.data.mode)
    assert.deepEqual(policies, ['ask'], `会话日志里的 approval/policy 不是 ask：${JSON.stringify(policies)}`)
    assert.deepEqual(modes, ['workspace-write'], `会话日志里的 sandbox/mode 不是 workspace-write：${JSON.stringify(modes)}`)

    // ★ 继承读数一：桩在**续接进程**里读到的沙箱模式。
    //   那个进程的组合默认是 danger-full-access（本用例可以核对 overlay 里没有钉它，
    //   而 `DSH_PERMISSION_MODE` 是 danger-full-access），会话自己的日志说
    //   workspace-write ⇒ 读到 workspace-write 就意味着会话的那条事件越过了进程边界。
    assert.match(r.turnText, /sandbox=workspace-write/,
      `续接进程里桩读到的沙箱模式不是会话自己的那条：${JSON.stringify(r.turnText).slice(0, 400)}`)

    // ★ 继承读数二：桩读到的审批策略句。续接进程的组合默认是 never
    //   （`cordis.patch.yml:227` 从 `DSH_PERMISSION_MODE=danger-full-access` 推导），
    //   而会话日志说 ask ⇒ 读到 ask 就意味着策略也是会话自己的。
    assert.match(r.turnText, /policy=ask/,
      `续接进程里桩读到的审批策略不是会话自己的那条：${JSON.stringify(r.turnText).slice(0, 400)}`)

    // ★ 继承读数三（协议侧）：升级**仍然**被问了。
    //   这一条把上面两条绑到一个行为上——只有 effective mode = workspace-write
    //   （严格更宽成立）**且** effective policy = ask（会走到 waterfall 并触碰
    //   ACP 桥）时，`session/request_permission` 才会出现。
    //   两个继承任一失败，这一轮会以另外两种完全不同的文本失败：
    //   `not strictly wider`（沙箱模式没继承）或 `the user rejected escalating`
    //   （策略没继承到、落到 never）。
    assert.equal(r.permissionRequests.length, 1,
      `续接轮应当恰好问一次审批；实际 ${r.permissionRequests.length} 次。`
      + `若是 0 次，请先看失败文本：${JSON.stringify(r.turnText).slice(0, 400)}`)

    // 反面：**没有**继承的东西，也说清楚。
    //   会话 header 的 cwd 是 resume 的**前置条件**（不匹配直接 invalidParams），
    //   所以它是「被强制」而不是「被继承」——两者在成功路径上同形，
    //   下面这一条用例把差异读出来。
    assert.equal(resolve(log.find((record) => record.type === 'session').cwd), resolve(prior.cwd))

    t.diagnostic(`IDENTITY policy=${policies.join(',')} sandbox=${modes.join(',')} perm=1 cwd=${prior.cwd}`)
  })

  guarded('★★★ cwd 是 resume 的**前置条件**而不是继承来的值：换个 cwd 直接被拒，且该 id 从此不可用', async (t) => {
    const prior = await buildAllow()
    const other = mkTemp('cwd-mismatch-')
    const { child, client } = spawnAcp({
      home: prior.home,
      agents: prior.agents,
      cwd: other,
      overlayName: OVERLAY_MAIN,
      permissionMode: 'workspace-write',
      answer: allowOnce,
    })
    try {
      await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      let refusal
      try {
        await client.request('session/resume', {
          sessionId: prior.sessionId,
          cwd: other,
          mcpServers: [],
        })
      } catch (error) {
        refusal = error
      }
      // 这一条把「cwd 一致」从一句注释变成一次真读数：
      // 一致时才谈得上「继承」，不一致时协议**拒绝**，而不是静默换一个。
      //
      //   > 一条「resume 拿到了 configOptions」的断言，
      //   > 与一条「resume 拒绝用另一个 cwd 冒充那个会话」的断言，
      //   > 在 cwd 恰好没变的那些运行里是同一片绿——
      //   > 只不过前者的绿，在一个「随客户端说什么就是什么」的实现上也是绿的。
      //
      // 出处：`packages/acp/acp/src/index.ts:270-275`，逐字是
      //   `/* v8 ignore start -- the persisted header was checked before resume; … */`
      //   `if (!await sameDirectory(record.agent.session.header.cwd, params.cwd)) {`
      //   `  await record.close('session/resume cwd mismatch')`
      //   `  throw invalidParams(\`session cwd does not match: ${params.cwd}\`)`
      //   `}`
      //   `/* v8 ignore stop */`
      // （同一句在 `:252-254` 还有一道**前置**检查，走的是持久层 header。）
      // ★ 那个分支**上游自己没测**：它被那对 `v8 ignore` 包着。所以钉住它不是
      //   重复 DSH 的测试，而是给一段**故意不覆盖**的分支留下一条行为读数。
      assert.notEqual(refusal, undefined,
        'cwd 不匹配时 session/resume 竟然成功了——那 cwd 就不是 resume 的前置条件')
      assert.match(refusal.message, /session cwd does not match/,
        `拒绝原因不是 cwd 不匹配：${refusal.message}`)

      // ★ 拒绝是**终局的**，不是装饰性的：`record.close(...)` 之后那条记录
      //   从未 `sessions.set` 进去，于是同一 id 上任何后续动作都只能得到
      //   `unknown session`（`index.ts:65-70` 的 `requireSession`）。
      //   一条「留下了还能用的会话」的拒绝，不是拒绝。
      //
      // 计数取**这一次被拒之前**的快照，而不是写死一个数：H1 这个 home 是
      // 与 resume 场景共用的（续接那一轮也会往同一份日志里追加），
      // 写死数字会让这条断言在不相关的用例先后顺序下变红——
      // 那是**顺序依赖**，不是被测行为。
      const countBefore = (type) => ofType(sessionLogFiles(prior.home).flatMap(readRecords), type).length
      const callsBefore = countBefore('tool/call')
      const resultsBefore = countBefore('tool/result')

      let useAfterRefusal
      try {
        await client.request('session/prompt', {
          sessionId: prior.sessionId,
          prompt: [{ type: 'text', text: `${MARK_PLAIN} ${TARGET_MARK(0)} ${TOKENS[0]} 不该跑到这里` }],
        })
      } catch (error) {
        useAfterRefusal = error
      }
      assert.notEqual(useAfterRefusal, undefined, '被拒之后同一 id 竟然还能接受 prompt——那次拒绝没有生效')
      assert.match(useAfterRefusal.message, /unknown session/,
        `被拒之后的报错不是 unknown session：${useAfterRefusal.message}`)

      // 而且这一轮**没有**任何副作用落地。
      //
      // ⚠️ 这里**不**断言「没有新的 turn/start」：`session/resume` 是先
      //    `ctx.agents.resume(...)` 再校验 cwd 的，所以一次被拒的 resume
      //    会在日志里留下它的边界事件。把「有没有 turn 记录」当成
      //    「有没有跑过东西」，会把一次**边界事件**读成一次**执行**。
      //    真正该看的是工具派发与磁盘。
      assert.ok(existsSync(prior.sentinels[0]) && existsSync(prior.sentinels[2]),
        '对照：第一个进程写过的 sentinel 应当还在')
      assert.equal(countBefore('tool/call'), callsBefore,
        '被拒的那次 resume 之后多出了工具派发')
      assert.equal(countBefore('tool/result'), resultsBefore,
        '被拒的那次 resume 之后多出了工具结果')

      client.endInput()
      const exit = await client.waitExit()
      assert.equal(exit.code, 0, `被拒之后进程应当干净退出，实际 code=${exit.code} signal=${exit.signal}`)
      t.diagnostic(`CWD-MISMATCH refused="${refusal.message.slice(0, 90)}" then="${useAfterRefusal.message.slice(0, 60)}" turns=2 exit=0`)
    } finally {
      client.kill()
    }
  })

  guarded('★★ 事件续接：续接轮的通知流全部归属同一个 sessionId，且消息 id 是新的', async (t) => {
    const r = await buildResume()
    const prior = r.prior

    // 会话归属：每一个 update 都挂在同一个 id 上（不是新会话）。
    assert.ok(r.updates.length > 0, '续接轮没有任何 session/update')
    for (const entry of r.updates) {
      assert.equal(entry.sessionId, prior.sessionId,
        `续接轮的 update 挂到了别的会话上：${entry.sessionId} != ${prior.sessionId}`)
    }
    const kinds = new Set(r.updates.map((entry) => entry.update?.sessionUpdate))
    for (const kind of kinds) {
      assert.ok(STANDARD_UPDATES.has(kind), `续接轮出现了非标准 update：${kind}`)
    }

    // 消息 id 是**新**的：同一个会话、新的轮次，不是把上一轮的 update 重放一遍。
    const messageIds = new Set(r.updates.map((entry) => entry.update?.messageId).filter((id) => id !== undefined))
    const priorMessageIds = new Set(prior.updates.map((entry) => entry.update?.messageId).filter((id) => id !== undefined))
    assert.ok(messageIds.size > 0, '续接轮没有带 messageId 的 update')
    for (const id of messageIds) {
      assert.equal(priorMessageIds.has(id), false, `续接轮复用了上一轮的 messageId：${id}`)
    }

    // 工具调用 id 也是新的（每一轮都是新的一次派发）。
    const callIds = new Set(r.updates
      .map((entry) => entry.update?.toolCallId)
      .filter((id) => id !== undefined))
    assert.ok(callIds.size > 0, '续接轮没有工具调用 update')
    assert.equal(callIds.has(PROBE_CALL_ID), true, `续接轮的工具调用 id 不是桩声明的那个：${[...callIds].join(',')}`)

    // 会话日志里只该有**一份**日志文件（同一个会话，跨两个进程追加）。
    assert.equal(r.logFiles.length, 1,
      `同一个会话跨两个进程应当仍是一份日志，实际 ${r.logFiles.length}：${r.logFiles.join(' | ')}`)
    const headers = ofType(r.records, 'session').map((record) => record.id)
    assert.deepEqual(headers, [prior.sessionId], `日志里的会话 id 不是同一个：${JSON.stringify(headers)}`)
    assert.ok(ofType(r.records, 'turn/start').length >= 3,
      `日志里的 turn/start 少于 3 次（H1 两轮 + 续接一轮）：${ofType(r.records, 'turn/start').length}`)

    t.diagnostic(`EVENTS updates=${r.updates.length} newMessageIds=${messageIds.size} callIds=${[...callIds].join(',')} turns=${ofType(r.records, 'turn/start').length}`)
  })

  guarded('★★ 取消边界：stopReason=cancelled，且进程**没有死**', async (t) => {
    const r = await buildCancel()

    // 会话报告的是标准取消原因（`codec.ts:22` 的 `interrupted -> cancelled`，
    // 以及显式取消路径 `session.ts` 的 `inflight.resolve('cancelled')`）。
    assert.equal(r.turn.stopReason, 'cancelled', `取消后的 stopReason 不是 cancelled：${r.turn.stopReason}`)

    // ★ 「取消干净了」与「进程死了」必须分开读：
    //   一个把子进程杀掉的实现也会让 prompt 提前 settle，只是 settle 成别的形状。
    assert.equal(r.aliveAfterCancel, true,
      `cancel 之后子进程已经死了——那不是取消，是崩溃。stderr:\n${r.stderr.slice(-1500)}`)
    assert.deepEqual(r.closed, {}, `cancel 之后 session/close 没有正常返回：${JSON.stringify(r.closed)}`)
    assert.equal(r.exit.code, 0, `最终退出码不是 0：code=${r.exit.code} signal=${r.exit.signal}`)

    // 桩在 6 秒后才说话，1.5 秒时的取消应当让它**没能**说完。
    // 这一条也是「取消」与「那一轮其实跑完了」的分界：如果桩把话说完并把
    // `agent_message_chunk` 送出去了，那 stopReason 是 cancelled 也只能说明
    // 客户端**以为**它取消了。
    assert.equal(r.agentTextsAfterCancel.includes('CANCEL_SURVIVED'), false,
      `取消之后桩仍然把话说完并送出了 update：${JSON.stringify(r.agentTextsAfterCancel)}`)

    // 取消是**通知**，它没有响应：协议面只留下那一条 update 流。
    assert.deepEqual(r.unparsedLines, [], `取消路径上 stdout 出现了非 JSON 行：${JSON.stringify(r.unparsedLines)}`)

    t.diagnostic(`CANCEL stopReason=cancelled alive=1 close=ok exit=0 agentTexts=${r.agentTextsAfterCancel.length} ${r.elapsedMs}ms`)
  })

  guarded('★ 诚实边界：这套跑出来的东西与**没**跑出来的东西', async (t) => {
    const allow = await buildAllow()
    const never = await buildNever()

    // 桩没有文件系统能力：磁盘上那几个文件只可能是真 pwsh 写的。
    const importLines = allow.stub.split('\n').filter((line) => line.startsWith('import '))
    assert.deepEqual(importLines, ["import { ToolCallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'"],
      `桩 import 了模型抽象之外的东西：${JSON.stringify(importLines)}`)
    // 逐条点名**能力**，而不是碰运气地搜子串：
    // 早先这一组里有一项写的是 `process.`，它命中了桩自己注释里的
    // `process.platform` 那句话——一条「桩没有文件系统能力」的断言，
    // 被自己的散文弄红了，是断言写错了而不是桩有问题。所以这里只查
    // 真正给能力的**模块与调用**。
    // `ctx.llm.registerAdapter` 不在名单里：注册模型适配器**就是**这个桩的
    // 全部职责，它给的是模型流，不是文件系统或子进程。
    for (const forbidden of [
      "from 'node:fs", 'from "node:fs', "from 'fs", 'require(',
      "from 'node:child_process'", "from 'child_process'", 'import(',
      'ctx.on(', 'ctx.approval', 'ctx.tools', 'ctx.sessionPersistence',
    ]) {
      assert.equal(allow.stub.includes(forbidden), false, `桩里出现了能力入口 ${forbidden}`)
    }
    // 桩唯一的注册动作就是模型流那一条；这是它的职责边界，也顺手钉住它。
    assert.equal(allow.stub.includes('ctx.llm.registerAdapter'), true, '桩没有注册模型适配器')
    assert.equal(allow.stub.includes('export function apply(ctx)'), true, '桩没有 apply')
    assert.equal((allow.stub.match(/^import /gm) ?? []).length, 1, '桩的 import 不止一行')

    // 「同一件事换个策略」被机器核对过：两个 home 的桩源码逐字节相同。
    assert.equal(never.stub, allow.stub, '两个 home 的桩源码不同——那读数差可能来自桩而不是策略')

    // 明确写下**没有**证明的东西。这一段是可执行的：它断言的是
    // 「本套件里没有 Legion 的编排器在场」这件事的证据（子进程只有 CLI 一个入口）。
    const entry = join(DSH, 'apps', 'cli', 'lib', 'bin.js')
    assert.ok(existsSync(entry), `入口不存在：${entry}`)
    assert.equal(allow.home.startsWith(TMP_ROOT + sep), true, '一次性 home 不在 tmpdir 之下')
    assert.equal(allow.home.includes(`${sep}.dsh`), false, `一次性 home 碰到了真实家目录：${allow.home}`)

    t.diagnostic('HONEST legion-orchestrator=absent stub-model=yes real-tool-dispatch=yes '
      + 'real-approval-service=yes real-sandbox=yes per-user-identity=unobserved crash-recovery=unobserved '
      + 'parent-to-child-policy-propagation=unobserved')
    t.diagnostic('LAYERS this-suite=acp-external-client-session-surface '
      + '(session/new|list|resume|close|prompt|cancel + session/request_permission); '
      + 'session-boundary.mjs=in-process-parent-child-surface '
      + '(subagents.startContinuable|sendMessage|interrupt|drainContinuable*|listChildren|listDescendants|'
      + 'interruptByParent) — subagents.* NOT exercised here (no parent agent in a one-shot acp process); '
      + 'the single mapping that IS exercised is session-boundary.mjs:240 agents.resume '
      + '<-> ACP session/resume (packages/acp/acp/src/session.ts:80)')
  })
})
