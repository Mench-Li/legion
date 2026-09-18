// runtime/dsh-composition/enforcement-real-process.test.mjs
// ============================================================================
// PRT-212 的诚实边界是这句话：
//
//   「还没有任何一个真 DSH 进程，通过审批口执行过一次工具调用。」
//
// 而更要紧的是它的下一句：Legion 的**强制层从未被证明能在一个真进程里真的拦住一次
// 真工具调用**。本套件补的正是这一截。
//
// ## 这一套件要回答的唯一问题
//
//   > 一个**真的** DSH 子进程、跑着**真的** ToolRuntime 与真的 pwsh/fs 沙箱栈、
//   > 被一个桩模型驱动去发一次**真的**工具调用时，
//   > Legion 的静态下限那一行，到底拦不拦得住？
//
// 判据不是"日志里出现了 denied"，也不是"组合树里有这一行"，而是**带外副作用**：
// 那条命令如果真被执行，它必然写出一个文件；那个文件**不出现**，才等于"工具没跑"。
//
// ## ★ 承重的那条断言为什么是"哨兵不存在"
//
//   `tool/result` 里的 `isError: true` 只说明**某一层**拒绝了。
//   一条"日志里写着 denied"的断言，
//   与一条"工具真的没跑起来"的断言，
//   在拒绝真的生效的那些运行里给出同一片绿——
//   只不过前者的绿，在一个把拒绝记进日志、却照样放行的钩子上也是绿的。
//
//   唯一不撒谎的读数是带外副作用：命令若被执行，文件必然出现。
//   只有它不出现，才等于"工具没有执行"。
//   因此 `sentinelExists === false` 是本套件的承重断言，其余都是归因。
//
// ## ★ 为什么这条用例**必须**自己给下限喂规则
//
// 下限的判定逻辑在 `enforcement.mjs` 的 `createHardFloorGuard`（`hard-floor.mjs`
// 只是薄绑定），而它的默认规则集 `DEFAULT_HARD_FLOOR` 是**空的**：
//
//     enforcement.mjs:32-35   const DEFAULT_HARD_FLOOR = { denyTools: [], denyPathPrefixes: [] }
//
// 仓库里那份 `legion-host.patch.yml` 里，`legion-enforcement-hard-floor` 那一行
// **也没有带 `config`**。也就是说：按今天这份补丁文件原样跑，
// **这个下限一条规则都不拦**。
//
//   > 一个"挂上去了、但规则集为空"的下限，
//   > 与一个"从未挂上去"的下限，在真进程里给出同一个读数——
//   > 只不过前者在组合树里看得见。
//
// 所以本套件用一层**测试自己的** overlay，把规则喂给那一行（`config.floor`），
// 形状取自 `hard-floor.mjs` 支持的判定族。
//
// ## 走的是哪一条规则（从 `hard-floor.mjs` / `enforcement.mjs` 读出来的）
//
// `createHardFloorGuard` 只有两族判定：
//
//   ① **工具名**（`enforcement.mjs:141`）：`denyTools` 里命中 `execution.name` ⇒
//      `hard floor：工具 <name> 被静态禁止（不可由审批解除）`；
//   ② **路径前缀**（`enforcement.mjs:145-158`）：从 `arguments.path ?? arguments.target
//      ?? arguments.file_path` 取一个路径，规范化后与 `denyPathPrefixes` 逐条比对 ⇒
//      `hard floor：路径落入静态禁止范围（<规范化前缀>）`。
//
// 本套件走 **②路径前缀**，理由不是"它更严格"，而是它的**拒绝理由里带着那条被禁前缀**：
// 于是"进程里的拒绝"与"YAML 里那条规则"之间有一条**字符串级**的对应关系，
// 而不是"某处说了 hard floor"。
//
// ## ★ 被禁的那条路径为什么选在**工作区之内**
//
// 选工作区之外的路径会让对照跑不起来（对照会被 DSH 自己的沙箱拒绝），
// 于是"哨兵不存在"既可能来自 sandbox、也可能来自 Legion 的下限——
// 两条读数长得一样，实验就是空的。所以被禁前缀取的是**对照能写、且真的写成功**的
// 那一个文件的绝对路径。对照是否真的写成功，由 §2 的断言负责。
//
// ## 一次性 home / 安全（与既有 `*-dsh-process.test.mjs` 同一套纪律）
//
//   每次子进程都有自己的 `mkdtempSync` home（spawn **之前**断言它落在 `os.tmpdir()` 内），
//   profile 就在那个 home 里现造、`patchReload: 'startup'`；从环境里**删掉**
//   `DSH_SNAPSHOT` / `DSH_SESSION_ID` / `DSH_WEB_URL` / `DEEPSEEK_API_KEY`；
//   `spawnSync` 带超时；每个 home 在 `finally` 里整棵删掉。
//   **绝不**读写操作者那台机器上的真实 profile（它是 `patchReload: 'live'`，
//   碰一下就会改到正在跑的 harness，包括本会话本身）。
//
// ## 没有 DSH_CHECKOUT 时整组 SKIP
//
// 与 `patch-loadable.test.mjs` 同一个纪律：**外部宿主测试不伪造通过**。
// 跳过是"这一次没跑"，不是"跑过了"。
// ============================================================================

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// ★ 检出用**共享解析器**找（理由见下面可跑性判定那段）。
import { resolveDshCheckout } from '../../scripts/lib/dsh-checkout.mjs'

// 判定与路径归一都取自**产品模块**，不在用例里另抄一份：
// 抄一份的话，产品改了规范化规则而用例还绿着，"断言的是那个拒绝"就变成了一句注释。
import { canonicalizePath } from './enforcement.mjs'
// 补丁层的仓库内路径也取自产品声明，不在这里手打一遍字符串。
import { PATCH_YAML_PATH } from './render.mjs'

// ───────────────────────────────────────────────── 可跑性判定（沿用既有口径）

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
// ★ 检出用**共享解析器**找。此前手写 `process.env.DSH_CHECKOUT ?? null`，
//   实测后果：变量没导出时本套件 **5 条全跳**，
//   CI 报 `PASS tests=5 pass=0 skipped=5`——"跑了 0 条"报绿。
const DSH_FOUND = resolveDshCheckout({ need: 'cli' })
const DSH = DSH_FOUND.checkout
const CLI = DSH === null ? null : join(DSH, 'apps', 'cli', 'lib', 'bin.js')
const LEGION_PATCH = join(REPO_ROOT, PATCH_YAML_PATH)

/** 为什么没跑。缺哪一样就写哪一样——理由来自共享解析器，不是笼统一句。 */
const UNAVAILABLE = DSH === null
  ? DSH_FOUND.reason
  : !existsSync(LEGION_PATCH)
    ? `仓库里找不到 Legion 补丁层（${LEGION_PATCH}）`
    : false
const SKIP = UNAVAILABLE === false ? false : UNAVAILABLE

/**
 * 每一条都是**真跳过**（runner 的 `skipped` 计数会涨），而不是"跑了个空断言"。
 * 一个"因为环境不在就 assert.ok(true)"的用例，与一个"真的跑过并过了"的用例，
 * 在摘要行上长得一样——只不过前者的绿什么也没证明。
 */
const guarded = (name, fn) => test(name, {
  timeout: 180_000,
  skip: SKIP === false ? false : `SKIP：${SKIP}`,
}, fn)

// ───────────────────────────────────────────────── 常量

const PROFILE_NAME = 'prt212enf'
const TASK_TEXT = 'Create the probe sentinel through a real tool call.'

/**
 * 哨兵文件名。它出现在两个地方：
 *   · 被禁前缀那一行（工具真被执行时写出的那个文件的绝对路径）；
 *   · 补丁文本归一化时用来认出"唯一随运行而变的那一行"。
 */
const SENTINEL_BASENAME = 'prt212-sentinel.txt'

/**
 * 被驱动去调用的工具。取 fs 工具的 `write`：它的参数里有 `file_path`
 * （`enforcement.mjs:145` 读的就是这三个字段之一），因此路径前缀那一族判定可达，
 * 而且它有一个**可观察的带外副作用**（写出那个文件）。
 *
 * ⚠️ 选 `pwsh` 就只能走①工具名那一族（shell 的参数里没有路径），
 * 拒绝理由里也就没有那条被禁前缀可对照。理由见文件头。
 */
const TOOL_NAME = 'write'

/** 子进程内那个观测点往 stderr 写的标记（证明调用走到了调度闸门）。 */
const GATE_MARKER = 'PRT212-GATE-SAW'
/** 下限自己的拒绝理由前缀（`enforcement.mjs:141,156`）。 */
const FLOOR_MARKER = 'hard floor'
/** 组合根那条 pre-execute 策略门的拒绝理由前缀（Legion 的另一个强制点）。 */
const POLICY_GATE_MARKER = '策略门不可用'
/** 策略门 unavailable 的连接阶段归因——用来证明"不是同一个东西拒的"。 */
const HUB_UNREACHABLE_MARKER = 'enforcement-team-hub-unreachable'
/** 缺凭证的归因标记（`apps/cli` 的启动失败口径）——拒绝**不是**它。 */
const CREDENTIAL_MARKER = 'MISSING_CREDENTIAL'
/** 沙箱级拒绝的典型文本——拒绝**不是**它。 */
const SANDBOX_MARKERS = Object.freeze(['operation not permitted', 'Access is denied', 'EPERM', 'EACCES'])

/**
 * 一行式开关。写成 flow 映射是为了让"两次运行的补丁文本只差这一行"这件事
 * **可以被逐行断言**（见 §4）：如果开关占两行，diff 就不再是一行了。
 */
const DISABLE_FLOOR_ROW = '- {id: legion-enforcement-hard-floor, disabled: true}'
const DISABLE_ROOT_ROW = '- {id: legion-enforcement-root, disabled: true}'

/**
 * Legion 组合根从**进程环境**读它要的身份（`plugins/root-row.mjs` 文件头）。
 * 五个都给全：缺任何一个它都会按具名码拒绝装配，于是启动路径直接失败——
 * 那是它**设计上**的 fail closed，不是本套件要测的东西。
 */
const LEGION_IDENTITY_ENV = Object.freeze({
  TEAM_HUB_URL: 'http://hub.invalid:8787',
  LEGION_ACTOR: 'prt212-real-process',
  LEGION_SCOPE: 'prt212-real-process',
  LEGION_ENFORCEMENT_ACTION: 'write',
})

// ───────────────────────────────────────────────── 脚手架

/** 一次性目录，且**当场断言**它落在 `os.tmpdir()` 之内。 */
function mkTemp(prefix) {
  const dir = resolve(mkdtempSync(join(tmpdir(), prefix)))
  assert.ok(dir.startsWith(resolve(tmpdir()) + sep), `一次性目录逃出了 os.tmpdir()：${dir}`)
  return dir
}

/**
 * 桩模型。它**只有**模型流这一件事，绝不碰文件系统：
 * 因此哨兵文件不可能由它写出来——只可能由真 ToolRuntime 里的真工具写出来。
 *
 * 第二轮（模型看到 tool-result 之后）把工具结果回显成最终助手消息，
 * 于是 stdout 里也带着那份结果文本，而 session 日志里是原始记录。
 */
function stubLlmSource({ toolName, toolArguments }) {
  return `
import { ToolCallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

const TOOL = ${JSON.stringify(toolName)}
// 工具参数在**子进程内**序列化：模型流里的 arguments / argumentsDelta 必须是字符串，
// 而注入一份对象字面量会让 argumentsDelta 变成对象——那是一次**桩自己的**失败，
// 与被测的强制面毫无关系（读数是 turn/end reason=error、toolCalls=[]）。
const ARGS = JSON.stringify(${JSON.stringify(toolArguments)})

class ProbeAdapter extends LlmAdapter {
  async resolveModel(provider, model) {
    return {
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }], defaultEffort: ReasoningEffortId('off') },
    }
  }
  async * stream(options) {
    const last = options.messages.at(-1)
    const toolResult = last === undefined ? undefined : last.content.find(b => b.type === 'tool-result')
    if (toolResult === undefined) {
      const id = ToolCallId('probe-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: TOOL, argumentsDelta: ARGS }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: TOOL, arguments: ARGS } }
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = toolResult.content.filter(b => b.type === 'text').map(b => b.text).join('')
    const reply = 'PROBE_TOOL_RESULT<' + text.trim() + '>'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'prt212-probe-llm'
export const inject = ['llm']
export function apply(ctx) {
  ctx.llm.registerAdapter(['probe-model'], new ProbeAdapter())
}
`
}

/**
 * 进程内观测点：工具调用到达**可扩展的** `tools/pre-execute` 瀑布时写一行 stderr。
 *
 * 它不改判定（返回 `next()`），只在进程内留下一个读数：
 * **这次调用真的走到了调度闸门**。有了它，"哨兵不存在"就不再可能被读成
 * "调用根本没发出去"，而拒绝只剩一种解释：发生在 pre-execute **之后**的那一级。
 *
 *   > 一个"日志里说被拒了"的读数，与一个"调用真的走到了闸门、然后没执行"的读数，
 *   > 只看最终 stdout 是同一个东西——只不过前者的 stdout 在"桩没发调用"时也长这样。
 */
const GATE_PROBE_SRC = `
export const name = 'prt212-gate-probe'
export function apply(ctx) {
  ctx.on('tools/pre-execute', (exec, next) => {
    const seen = exec === null || exec === undefined ? '<none>' : exec.name
    process.stderr.write('${GATE_MARKER} ' + String(seen) + '\\n')
    return next()
  })
}
`

/** 公共 overlay：桩模型 + 静音几条与本次读数无关的行 + 明文 session 日志 + 观测点。 */
function commonPatchLines() {
  return [
    '- id: agent-default-model',
    '  config:',
    '    provider: probe-model',
    '    model: probe-model',
    '',
    // 这几行在无凭证的 headless 面上会各自报错/拖慢，且与本次读数无关：
    // 关掉它们是**为了把变量限制在强制面上**，而不是为了掩盖失败。
    '- id: session-title-llm',
    '  disabled: true',
    '',
    '- id: plugin-package-inventory-deepseek',
    '  disabled: true',
    '',
    '- id: agent-instructions',
    '  disabled: true',
    '',
    // ★ `compression: none`：session 落盘成**明文 JSONL**，于是读数不必去拆 zstd 帧
    //   （`zstdDecompressSync` 只解第一帧，多帧日志要按魔数切开——那是另一件事的坑）。
    '- id: session-persistence-jsonl',
    '  config:',
    "    root: !!js dshHomePath('sessions')",
    '    compression: none',
    '',
    '- insert:',
    '    - id: prt212-probe-llm',
    "      name: './prt212-probe-llm.mjs'",
    '    - id: prt212-gate-probe',
    "      name: './prt212-gate-probe.mjs'",
    '',
  ]
}

/**
 * 下限那一行的配置 overlay。
 *
 * `deny-sentinel` 与 `inert` 只差 `floor` 里的**数据**——形状完全相同。
 * 这一点是 §4 的判据：同一行、同一份补丁形状，只有运行期配置不同，结果就不同。
 */
function floorPatchLines({ floor, disableFloorRow, disableRootRow, sentinelPath }) {
  const rule = floor === 'inert'
    ? {
      denyTools: [],
      denyPathPrefixes: [process.platform === 'win32' ? 'C:\\prt212\\no\\such\\deny\\root' : '/prt212/no/such/deny/root'],
    }
    : { denyTools: [], denyPathPrefixes: [sentinelPath] }
  const lines = [
    '- id: legion-enforcement-hard-floor',
    '  config:',
    '    floor:',
    `      denyTools: ${JSON.stringify(rule.denyTools)}`,
    '      denyPathPrefixes:',
    ...rule.denyPathPrefixes.map((p) => `        - ${JSON.stringify(p)}`),
    '',
  ]
  if (disableRootRow) lines.push(DISABLE_ROOT_ROW)
  if (disableFloorRow) lines.push(DISABLE_FLOOR_ROW)
  return lines
}

// ───────────────────────────────────────────────── 跑一个真子进程并读出全部读数

function parseSessionRecords(home) {
  const sessionsRoot = join(home, 'sessions')
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else files.push(p)
    }
  }
  if (existsSync(sessionsRoot)) walk(sessionsRoot)
  const records = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      // 半行/非 JSON 行不参与读数，但也不静默吞掉整份日志：坏行只影响它自己。
      try { records.push(JSON.parse(line)) } catch { /* 非记录行 */ }
    }
  }
  return records
}

const toolCallsOf = (records) => records
  .filter((r) => r.type === 'tool/call')
  .map((r) => ({ name: r.data?.name ?? null, arguments: r.data?.arguments ?? null }))

const toolResultsOf = (records) => {
  const out = []
  for (const r of records) {
    if (r.type !== 'tool/result') continue
    for (const block of r.data?.message?.content ?? []) {
      if (block?.type !== 'tool-result') continue
      out.push({
        toolCallId: block.toolCallId ?? null,
        isError: block.isError === true,
        text: (block.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''),
      })
    }
  }
  return out
}

const valuesOfType = (records, type) => records.filter((r) => r.type === type).map((r) => r.data ?? null)

/**
 * 建一个一次性 home + 一次性 cwd，跑一次真 CLI，读回全部读数，然后在 `finally`
 * 里把三个临时目录整棵删掉。
 *
 * @param {{tag: string, withLegionPatch: boolean, floor: 'deny-sentinel'|'inert',
 *          disableFloorRow?: boolean, disableRootRow: boolean}} scenario
 */
function runRealDsh(scenario) {
  const { tag, withLegionPatch, floor, disableFloorRow = false, disableRootRow } = scenario
  const home = mkTemp(`prt212enf-home-${tag}-`)
  const agents = mkTemp(`prt212enf-agents-${tag}-`)
  const ws = mkTemp(`prt212enf-ws-${tag}-`)
  const token = `HARDFLOOR_${randomBytes(8).toString('hex').toUpperCase()}`
  const sentinelPath = join(ws, SENTINEL_BASENAME)

  let record = null
  try {
    const profileDir = join(home, 'profiles', PROFILE_NAME)
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: `dsh-profile-${PROFILE_NAME}`,
      private: true,
      dependencies: {},
      // 生产形状：真 `dsh-base`（真 ToolRuntime + 真 sandbox-policy + 真 pwsh/fs 沙箱）
      // 之上再挂 headless 面。**不用任何替身服务**——替身 tools 服务能证明的只有接线。
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
          patchReload: 'startup',
        },
      },
    }, null, 2) + '\n')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '# 空用户层\n[]\n')

    const toolArguments = { file_path: sentinelPath, content: token }
    writeFileSync(join(profileDir, 'prt212-probe-llm.mjs'), stubLlmSource({ toolName: TOOL_NAME, toolArguments }))
    writeFileSync(join(profileDir, 'prt212-gate-probe.mjs'), GATE_PROBE_SRC)

    const commonPath = join(profileDir, 'common.patch.yml')
    writeFileSync(commonPath, commonPatchLines().join('\n'))
    const floorLines = floorPatchLines({ floor, disableFloorRow, disableRootRow, sentinelPath })
    const floorPath = join(profileDir, 'floor.patch.yml')
    writeFileSync(floorPath, floorLines.join('\n'))

    // 两个场景的 argv 只差「--patch <legion-host.patch.yml>」这一对（见 §2 的断言）。
    const argv = ['--profile', PROFILE_NAME]
    if (withLegionPatch) argv.push('--patch', LEGION_PATCH)
    argv.push('--patch', commonPath)
    argv.push('--patch', floorPath)
    argv.push(TASK_TEXT)

    const env = { ...process.env }
    delete env.DSH_SNAPSHOT
    delete env.DSH_SESSION_ID
    delete env.DSH_WEB_URL
    delete env.DEEPSEEK_API_KEY
    delete env.DEEPSEEK_BASE_URL
    delete env.DSH_PERMISSION_MODE
    Object.assign(env, {
      DSH_HOME: home,
      DSH_AGENTS_HOME: agents,
      DSH_TELEMETRY_DISABLED: '1',
      ...LEGION_IDENTITY_ENV,
      LEGION_CWD: ws,
    })

    const startedAt = Date.now()
    const res = spawnSync(process.execPath, [CLI, ...argv], {
      cwd: ws,
      env,
      encoding: 'utf8',
      timeout: 150_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    const elapsedMs = Date.now() - startedAt

    const sentinelExists = existsSync(sentinelPath)
    const sentinelText = sentinelExists ? readFileSync(sentinelPath, 'utf8') : null
    const records = parseSessionRecords(home)

    record = {
      tag,
      argv,
      floorLines,
      withLegionPatch,
      home,
      ws,
      token,
      sentinelPath,
      sentinelExists,
      sentinelText,
      elapsedMs,
      spawnError: res.error === undefined ? null : (res.error?.message ?? String(res.error)),
      exit: res.status,
      signal: res.signal,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      toolCalls: toolCallsOf(records),
      toolResults: toolResultsOf(records),
      turnEnds: valuesOfType(records, 'turn/end').map((d) => d?.reason?.kind ?? null),
      sandboxModes: valuesOfType(records, 'sandbox/mode'),
      approvalPolicies: valuesOfType(records, 'approval/policy'),
    }
  } finally {
    for (const dir of [home, agents, ws]) rmSync(dir, { recursive: true, force: true })
  }
  return record
}

// ───────────────────────────────────────────────── 场景（每个子进程只跑一次）

const SCENARIOS = Object.freeze({
  /** 真补丁层 + 匹配的下限规则 + 组合根那一行关掉（隔离，理由见 §5）。 */
  denied: { tag: 'denied', withLegionPatch: true, floor: 'deny-sentinel', disableRootRow: true },
  /** 对照：同一命令、同一桩、同一份 floor overlay，**只少 Legion 的补丁层**。 */
  control: { tag: 'control', withLegionPatch: false, floor: 'deny-sentinel', disableRootRow: true },
  /** 真补丁层在、规则也配了，但**那一行被 disable 掉**。 */
  rowDisabled: { tag: 'row-disabled', withLegionPatch: true, floor: 'deny-sentinel', disableRootRow: true, disableFloorRow: true },
  /** 那一行挂着，但规则**匹配不到**这次调用（"挂上了却没贡献任何东西"）。 */
  inertFloor: { tag: 'inert-floor', withLegionPatch: true, floor: 'inert', disableRootRow: true },
  /** 真补丁层**原样**：组合根那一行也开着（部署形状）。 */
  fullLayer: { tag: 'full-layer', withLegionPatch: true, floor: 'deny-sentinel', disableRootRow: false },
})

const READINGS = new Map()
function readingOf(key) {
  if (!READINGS.has(key)) READINGS.set(key, runRealDsh(SCENARIOS[key]))
  return READINGS.get(key)
}

/** 摘要用的读数行，让失败信息自带现场。 */
function describeReading(r) {
  return [
    `[${r.tag}] exit=${r.exit} signal=${r.signal} spawnError=${r.spawnError} ms=${r.elapsedMs}`,
    `argv=${JSON.stringify(r.argv)}`,
    `sentinelExists=${r.sentinelExists} sentinelText=${JSON.stringify(r.sentinelText)}`,
    `toolCalls=${JSON.stringify(r.toolCalls)}`,
    `toolResults=${JSON.stringify(r.toolResults.map((x) => ({ isError: x.isError, text: x.text.slice(0, 400) })))}`,
    `turnEnds=${JSON.stringify(r.turnEnds)}`,
    `stderr=${JSON.stringify(r.stderr.slice(0, 600))}`,
    `stdout=${JSON.stringify(r.stdout.slice(0, 600))}`,
  ].join('\n  ')
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 ★★★★★ 下限真的拦住了一次真工具调用
// ═════════════════════════════════════════════════════════════════════════════

guarded('★★★★★ 1 · 真 DSH 进程里 Legion 的静态下限拒绝了一次真工具调用：哨兵文件不存在', (t) => {
  const r = readingOf('denied')

  // 把原始读数打进测试输出：绿的时候也要看得见"绿在哪一次调用上"。
  t.diagnostic(`[denied] exit=${r.exit} ms=${r.elapsedMs} sentinelExists=${r.sentinelExists}`)
  t.diagnostic(`[denied] tool/result = ${JSON.stringify(r.toolResults[0]?.text ?? null)}`)
  t.diagnostic(`[denied] stderr = ${JSON.stringify(r.stderr.trim())}`)

  // 不是崩溃、不是启动失败：真跑完了一轮。
  assert.equal(r.spawnError, null, `子进程没能起来/被超时杀掉：\n  ${describeReading(r)}`)
  assert.equal(r.exit, 0, `真进程不是正常退出——那不是"被拒绝"，那是"跑挂了"：\n  ${describeReading(r)}`)

  // ★ 调用**真的发出去了**。这一条与下面那条互为反面：少了它，
  //   "哨兵不存在"可以被读成"桩压根没发调用"，而那说明不了任何强制面的事。
  assert.equal(r.toolCalls.length, 1, `桩没有发出那一次工具调用：\n  ${describeReading(r)}`)
  assert.equal(r.toolCalls[0].name, TOOL_NAME, `发出的不是我们要审的那次调用：\n  ${describeReading(r)}`)

  // ★★ 进程内的闸门观测点看到了这次调用 ⇒ 它确实走到了调度闸门，
  //    而不是被更早的东西（模型流/参数解析/工具不存在）挡在外面。
  assert.ok(r.stderr.includes(`${GATE_MARKER} ${TOOL_NAME}`),
    `进程内的 tools/pre-execute 观测点没看到这次调用——那说明它根本没走到闸门，`
    + `于是"哨兵不存在"不能归因给强制面：\n  ${describeReading(r)}`)

  // ★★★★★ 承重断言：带外副作用**不存在**。
  //
  //   这条命令如果真被执行，这个文件必然出现。它不出现，才等于"工具没有执行"。
  //   一条"日志里写着 denied"的断言，
  //   与一条"工具真的没跑起来"的断言，
  //   在拒绝真的生效的那些运行里给出同一片绿——
  //   只不过前者的绿，在一个把拒绝记进日志、却照样放行的钩子上也是绿的。
  assert.equal(r.sentinelExists, false,
    `哨兵文件存在 ⇒ 工具真的执行了 ⇒ 下限没有拦住它（${r.sentinelPath}）：\n  ${describeReading(r)}`)

  // 拒绝必须是**可见**的（否则"没执行"可能只是"默默地什么也没发生"）。
  assert.equal(r.toolResults.length, 1, `没有 tool/result 记录 ⇒ 拒绝不可见：\n  ${describeReading(r)}`)
  assert.equal(r.toolResults[0].isError, true, `工具被拒绝却没有 isError：\n  ${describeReading(r)}`)
})

// ═════════════════════════════════════════════════════════════════════════════
// §2 ★★★★★ 对照：少了补丁层，同一条命令真的执行了
// ═════════════════════════════════════════════════════════════════════════════

guarded('★★★★★ 2 · 对照：同一命令、同一桩，只少 Legion 的补丁层 → 工具真的执行了，哨兵存在且内容正确', (t) => {
  const denied = readingOf('denied')
  const control = readingOf('control')

  t.diagnostic(`[control] exit=${control.exit} ms=${control.elapsedMs} sentinelExists=${control.sentinelExists}`)
  t.diagnostic(`[control] sentinel = ${JSON.stringify(control.sentinelText)}`)
  t.diagnostic(`[control] tool/result = ${JSON.stringify(control.toolResults[0]?.text ?? null)}`)
  t.diagnostic(`[control] stderr = ${JSON.stringify(control.stderr.trim())}`)

  // ★ 单变量：两个场景的 argv 只差「--patch <legion-host.patch.yml>」这一对。
  //   不把这一点断言出来，"对照"就只是一句注释。
  assert.ok(denied.argv.includes(LEGION_PATCH), `被拒的那一次没有带 Legion 补丁层：\n  ${describeReading(denied)}`)
  assert.ok(!control.argv.includes(LEGION_PATCH), `对照竟然也带了 Legion 补丁层——那它就不是对照：\n  ${describeReading(control)}`)

  /** 摘掉「--patch <Legion 补丁层>」这一对。 */
  const withoutLegionPatch = (argv) => {
    const at = argv.indexOf(LEGION_PATCH)
    if (at < 0) return [...argv]
    assert.equal(argv[at - 1], '--patch', 'Legion 补丁层前面不是 --patch —— argv 形状与本用例的假设不符')
    return [...argv.slice(0, at - 1), ...argv.slice(at + 1)]
  }
  /** 每次运行的 home 都不同，于是补丁文件的绝对路径也不同；按 basename 归一。 */
  const maskPatchPaths = (argv) => argv.map((a) => (/(\.ya?ml)$/.test(a) ? basename(a) : a))
  assert.deepEqual(
    maskPatchPaths(withoutLegionPatch(denied.argv)),
    maskPatchPaths(control.argv),
    '被拒与对照的 argv 不止差 Legion 补丁层——那这就不是单变量实验',
  )

  assert.equal(control.spawnError, null, `对照子进程没能起来：\n  ${describeReading(control)}`)
  assert.equal(control.exit, 0, `对照不是正常退出：\n  ${describeReading(control)}`)

  // ★★★★★ 对照必须真的跑起来。跑不起来，§1 的绿就是装饰：
  //   一个"把什么工具调用都拦下"的布置，与一个"真的在拦某一条规则"的布置，
  //   在只有被拒那一次观测时给出同一个读数。
  assert.equal(control.sentinelExists, true,
    '对照里工具没有执行 ⇒ 这个实验是空的：被拒那一次的"哨兵不存在"'
    + `既可能是强制面拦下的，也可能是这条路径本来就写不进去（例如沙箱）。\n  ${describeReading(control)}`)
  assert.equal(control.sentinelText.trim(), control.token,
    `对照写出的内容不对（期望那个随机 token）：\n  ${describeReading(control)}`)
  assert.equal(control.toolResults[0].isError, false, `对照里工具报了错：\n  ${describeReading(control)}`)
  assert.ok(control.stderr.includes(`${GATE_MARKER} ${TOOL_NAME}`),
    `对照里观测点也没看到调用——两个场景都没走到闸门，实验同样不成立：\n  ${describeReading(control)}`)
})

// ═════════════════════════════════════════════════════════════════════════════
// §3 ★★★ 拒绝是"具名"的，不是笼统的"失败了"
// ═════════════════════════════════════════════════════════════════════════════

guarded('★★★ 3 · 拒绝是 Legion 具名的：理由是 hard floor + 那条被禁路径，不是崩溃/缺凭证/沙箱/策略门', () => {
  const r = readingOf('denied')
  const reason = r.toolResults[0].text

  // ★ 理由里必须同时有**判定族的名字**与**那条被禁前缀本身**。
  //
  //   后半截是关键：它是"进程里的这次拒绝"与"我们写进 YAML 的那条规则"之间
  //   唯一的字符串级对应。少了它，"某处说了 hard floor"就只是一个标记，
  //   任何写这句话的东西都能让它变绿。
  assert.ok(reason.includes(FLOOR_MARKER),
    `拒绝理由里没有下限自己的标记 ${JSON.stringify(FLOOR_MARKER)}：\n  理由=${JSON.stringify(reason)}`)
  const canonicalDenied = canonicalizePath(r.sentinelPath, { cwd: r.ws, platform: process.platform })
  assert.ok(reason.includes(canonicalDenied),
    '拒绝理由里没有被禁的那条路径（规范化后）——于是这次拒绝读不出是**哪条规则**拦的：\n'
    + `  理由=${JSON.stringify(reason)}\n  期望包含=${JSON.stringify(canonicalDenied)}`)

  // ★ 下面四条是"长得一样"的其它读数，逐条排除。
  //   它们都会给出"哨兵不存在 + isError:true"这同一个外观：
  //     · 进程崩了        → exit != 0（§1 已断言 exit === 0）
  //     · 缺模型凭证      → 进程起不来、stderr 里是 MISSING_CREDENTIAL，且不会有 tool/result
  //     · DSH 自己的沙箱  → 理由里是 operation not permitted / Access is denied 一类
  //     · Legion 的策略门 → 理由前缀是"策略门不可用"+ 连接阶段归因（见 §5）
  //     · 挂上了却没贡献  → 哨兵会存在（见 §4）
  assert.ok(!reason.includes(CREDENTIAL_MARKER),
    `拒绝理由里出现了缺凭证标记 ${JSON.stringify(CREDENTIAL_MARKER)}——那不是下限拒的：\n  理由=${JSON.stringify(reason)}`)
  assert.ok(!r.stderr.includes(CREDENTIAL_MARKER),
    `stderr 里出现了缺凭证标记，于是这次运行不是"被拒绝"，而是"没跑起来"：\n  ${describeReading(r)}`)
  assert.ok(!reason.includes(POLICY_GATE_MARKER) && !reason.includes(HUB_UNREACHABLE_MARKER),
    '拒绝是 Legion 的**策略门**给的，不是静态下限给的——两者理由前缀不同，不能混成一个"被拒了"：\n'
    + `  理由=${JSON.stringify(reason)}`)
  for (const marker of SANDBOX_MARKERS) {
    assert.ok(!reason.includes(marker),
      `拒绝理由是沙箱级的（${marker}）——那说明拦下它的是 DSH 的沙箱，而不是 Legion 的下限：\n  理由=${JSON.stringify(reason)}`)
  }

  // 被拒的这一侧仍然是"一轮跑完"，不是"跑炸了"。
  assert.deepEqual(r.turnEnds, ['completed'], `turn 没有正常结束：\n  ${describeReading(r)}`)
  assert.deepEqual(r.sandboxModes, [{ mode: 'workspace-write' }], `沙箱模式与预期不符：\n  ${describeReading(r)}`)
})

// ═════════════════════════════════════════════════════════════════════════════
// §4 ★★ 这一行是在**跑的进程里**生效的，不是磁盘上的一段 YAML
// ═════════════════════════════════════════════════════════════════════════════

guarded('★★ 4 · 这一行是在跑的进程里生效的（激活与运行时配置都改得动结果），不是磁盘上的一段 YAML', (t) => {
  const denied = readingOf('denied')
  const rowDisabled = readingOf('rowDisabled')
  const inert = readingOf('inertFloor')

  t.diagnostic(`[row-disabled] sentinelExists=${rowDisabled.sentinelExists} text=${JSON.stringify(rowDisabled.sentinelText)}`)
  t.diagnostic(`[inert-floor] sentinelExists=${inert.sentinelExists} text=${JSON.stringify(inert.sentinelText)}`)
  t.diagnostic(`[denied] sentinelExists=${denied.sentinelExists}`)

  // (a) 行的**激活**是真的。
  //     row-disabled 的 floor overlay 与 denied 逐行相同，只多一行 `disabled: true`。
  //     如果这一行只是"仓库里的一段 YAML"，这个开关不会改变任何东西。
  //
  //     唯一随运行而变的是"被禁前缀"那一行（每次运行的 ws 都是新的 mkdtemp），
  //     所以比对前把它归一成同一个占位符；剩下的差异只可能来自那个开关。
  const withoutSwitch = (lines) => lines.filter((l) => l !== DISABLE_FLOOR_ROW)
  const maskSentinelLine = (lines) => lines.map((l) => (l.includes(SENTINEL_BASENAME) ? '        - "<per-run sentinel>"' : l))
  assert.deepEqual(maskSentinelLine(withoutSwitch(rowDisabled.floorLines)), maskSentinelLine(withoutSwitch(denied.floorLines)),
    'row-disabled 与 denied 的 floor overlay 不止差那个开关——那 (a) 就不是单变量读数')
  assert.equal(rowDisabled.floorLines.length, denied.floorLines.length + 1,
    'row-disabled 的 floor overlay 不是"恰好多一行开关"——(a) 的判据塌了')

  assert.equal(rowDisabled.sentinelExists, true,
    '把这一行 disable 掉之后工具仍然没跑 ⇒ 拒绝不是这一行给的，§1 的归因是错的：\n'
    + `  ${describeReading(rowDisabled)}`)
  assert.equal(rowDisabled.toolResults[0].isError, false, `row-disabled 里工具报了错：\n  ${describeReading(rowDisabled)}`)
  assert.ok(rowDisabled.stderr.includes(`${GATE_MARKER} ${TOOL_NAME}`),
    `row-disabled 里观测点没看到调用：\n  ${describeReading(rowDisabled)}`)

  // (b) 那一行**读的是运行期的配置数据**，不是"存在即拦一切"。
  //     inert 与 denied 是同一行、同一份 patch 形状，只有 `floor` 里的数据不同
  //     （一条匹配不到任何东西的前缀）。结果必须不同。
  assert.notDeepEqual(inert.floorLines, denied.floorLines,
    'inert 与 denied 的 floor overlay 竟然是同一份——那 (b) 什么也没测')
  assert.equal(inert.sentinelExists, true,
    '规则匹配不到这次调用，工具却仍然没跑 ⇒ 这一行不是"按规则判定"，'
    + `而是"挂上就拦一切"（或者别的什么东西在拦）：\n  ${describeReading(inert)}`)
  assert.equal(inert.toolResults[0].isError, false, `inert 里工具报了错：\n  ${describeReading(inert)}`)

  // (c) 拒绝发生在**可扩展闸门之后**的那一级。
  //     进程内的 tools/pre-execute 观测点看到了这次调用（§1 已断言），
  //     而工具体没有执行（sentinel 不存在）—— 两者之间只剩 guard 那一级。
  assert.ok(denied.stderr.includes(`${GATE_MARKER} ${TOOL_NAME}`) && denied.sentinelExists === false,
    'pre-execute 观测点没看到调用，或者哨兵存在——(c) 的前提不成立')

  // ── 诚实边界 ────────────────────────────────────────────────────────────
  // 本用例**没有**做到的：直接读"guard 已经注册到 ToolRuntime 上"这件事本身。
  //
  //   · `hard-floor.mjs` 挂上时的 `ctx.logger.info` 那一行，在这个 headless 面上
  //     **不出现在 stderr**（实测 stderr 里只有我们自己写的观测点标记）；
  //   · 想枚举组合树/guard 列表，就得再插一个探针行，而它只能在 headless 运行器
  //     **自行退出之前**用计时器抢占 `process.exit`——那会把被测过程本身改掉，
  //     而"改掉了被测过程的读数"与"读到了真读数"在绿的时候长得一样。
  //
  // 因此 (a)(b)(c) 是这条路径上能拿到的最强读数：**结果随行的激活与运行期配置变化**，
  // 且拒绝发生在闸门之后、工具体之前。要更强的直接读数，需要 headless 面上的
  // 一个非抢占式的 in-process 观测口——那还不存在。
})

// ═════════════════════════════════════════════════════════════════════════════
// §5 ★★★ 归因对照：完整补丁层下也被拒，但拒绝**不是** hard floor 给的
// ═════════════════════════════════════════════════════════════════════════════

guarded('★★★ 5 · 归因对照：完整补丁层下同一条命令也被拒，但拒绝不是 hard floor 给的', (t) => {
  const denied = readingOf('denied')
  const full = readingOf('fullLayer')

  t.diagnostic(`[full-layer] exit=${full.exit} sentinelExists=${full.sentinelExists}`)
  t.diagnostic(`[full-layer] tool/result = ${JSON.stringify(full.toolResults[0]?.text ?? null)}`)
  t.diagnostic(`[denied]     tool/result = ${JSON.stringify(denied.toolResults[0]?.text ?? null)}`)

  // 部署形状：`legion-host.patch.yml` **一个字节都不改**，组合根那一行也开着。
  assert.deepEqual(full.floorLines.filter((l) => l === DISABLE_ROOT_ROW), [],
    'full-layer 竟然关掉了组合根那一行——那它就不是部署形状')
  assert.equal(full.withLegionPatch, true)

  assert.equal(full.spawnError, null, `full-layer 子进程没能起来：\n  ${describeReading(full)}`)
  assert.equal(full.exit, 0, `full-layer 不是正常退出：\n  ${describeReading(full)}`)

  // 同一条命令、同一份 floor overlay，在完整补丁层下**同样**不产生哨兵。
  assert.equal(full.sentinelExists, false,
    `完整补丁层下工具竟然跑起来了：\n  ${describeReading(full)}`)

  // ★ 但拒绝的理由**不是**下限给的：是组合根挂上的 pre-execute 策略门，
  //   在"这次调用需要人、而进程里没有可用审批策略"时按 fail closed 拒的。
  const fullReason = full.toolResults[0].text
  assert.ok(fullReason.includes(POLICY_GATE_MARKER),
    `完整补丁层下的拒绝理由不是策略门的：\n  理由=${JSON.stringify(fullReason)}`)
  assert.ok(fullReason.includes(HUB_UNREACHABLE_MARKER),
    `策略门的拒绝里没有连接阶段归因：\n  理由=${JSON.stringify(fullReason)}`)
  assert.ok(!fullReason.includes(FLOOR_MARKER),
    '完整补丁层下的拒绝理由里出现了 hard floor —— 归因假设变了，请重新读这一条：\n'
    + `  理由=${JSON.stringify(fullReason)}`)

  // ★ 这就是"两个读数长得一样"的现场：
  //   `sentinelExists === false` 在 §1 与这里**完全相同**，
  //   而只有理由字符串分得清是哪一个强制点拒的。
  //   §1 之所以要隔离掉组合根那一行（disable），正是因为不隔离时下限**说不上话**：
  //   在没有任何工具能力目录注入的情况下，策略门对**每一个**工具调用都需要人，
  //   于是它在 guard 之前就把调用拒掉了。
  assert.notEqual(fullReason, denied.toolResults[0].text,
    '两个场景的拒绝理由一模一样——那"归因"这件事在本套件里就没有被真正区分开')
})
