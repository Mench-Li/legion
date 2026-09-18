// runtime/dsh-composition/headless-real-tool.test.mjs
// ============================================================================
// 真 DSH 进程在一个真工具上留下了**带外副作用**——这是本套件唯一要钉住的事。
//
// ## 这一套补的是哪个缺口
//
// Legion 的台账上长期有三行卡在同一句话上：
//
//   > 没有真引擎跑完过真任务；没有任何真 DSH 进程执行过工具调用。
//
// 那句话当时是**诚实的**：仓库里所有"工具被调用过"的读数都来自形状检查、
// 进程内假想、或对日志文本的字符串匹配。本套件把那句话变成**可跑的读数**：
// 起一个真的 DSH 子进程（`--profile headless`），让它真的派发一次 `pwsh`，
// 然后不看它说了什么，只看**磁盘上多了什么**。
//
// ## 判别：三种在日志里长得一模一样的读法
//
// 一个"日志里出现了 `tool/call`"的判据，
// 与一个"工具真的跑过"的判据，
// 在模型本来就会调工具的那些运行里给出同一片绿——
// 只不过前者的绿，在工具被拒绝、被沙箱挡住、或压根没派发出去时也是绿的。
//
// 把日志摊开，下面三种读法与"真执行"**同形**：
//
//   ① `tool/call` 在场、`tool/result` 缺席 —— 循环决定要调，但没有任何东西执行；
//   ② `tool/result` 在场、`isError: true` —— 执行了，但**失败**了；
//   ③ 桩**自己报告**了一个结果（注入 `tool/result` 事件，或把结果编出来）——
//      日志里一切正常，只是没有任何工具进程存在过。
//
// 本套件的三条断言分别排掉它们：
//
//   · 断言 `tool/result` **存在**，且配得上那条 `tool/call` 的 callId        → 排掉 ①
//   · 断言 `isError === false` 且结果文本里带着本次 mint 的 token            → 排掉 ②
//   · 断言**带外副作用**：子进程 cwd 下那个 sentinel 文件的字节 == token，
//     而桩**不 import 任何文件系统模块**（第三条用例逐条读桩的源码）        → 排掉 ③
//
// ③ 是承重的。前两条都能由一个足够热情的桩伪造；磁盘上那个文件不能——
// 一个没有文件系统能力的模块，写不出一个只有真 `pwsh` 进程才写得出的文件。
//
//   > 一条"模型说了它调了工具"的断言，与一条"机器上真的发生过这件事"的断言，
//   > 在绿色的摘要里是同一行；只不过前者的绿，在你把工具换成 no-op 的时候
//   > 也照样是绿的。
//
// ## 配方来源（复现，不是发明）
//
// 这条路子由一次只读调查跑通并复现 3 次，产物在
// `.worktrees/_prt-handoff/probe-headless-be14efee/`（`FINDINGS.md` +
// `probe-b.mjs`）。本套件按它的做法重写，读数逐条对上：
//
//   · 入口：`node <DSH>/apps/cli/lib/bin.js --profile headless --patch <overlay.yml> "<task>"`
//   · 一次性 home：`DSH_HOME` / `DSH_AGENTS_HOME` 都是 `os.tmpdir()` 下的
//     `mkdtempSync`；`DSH_SNAPSHOT` 删掉；`DEEPSEEK_API_KEY` 删掉；cwd 也是临时的。
//   · profile 自己声明 shipped 的 bundle 列表
//     （`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`），
//     于是工具面、ToolRuntime、pwsh 沙箱全是**产品的那一套**。
//   · overlay 只加一处接缝：`agent-default-model` 改指 `probe-model`，
//     并 `insert` 一个本地纯 JS 行，做 `ctx.llm.registerAdapter(['probe-model'], …)`。
//     桩**只供应模型流**——工具派发、ToolRuntime、沙箱都还是生产的。
//   · profile 目录下的 `$DSH_HOME/profiles/node_modules` 由 CLI 自己在启动时
//     补齐（`healProfilesModuleFallback()`），所以桩里那句
//     `import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'` 解析得到。
//     本套件不需要额外做符号链接——实测直接起得来。
//
// ## 本次为什么设 `DSH_PERMISSION_MODE=danger-full-access`
//
// **不是**因为它是必要条件。调查的 §2.3 实测：把它删掉（落回 `dsh-base` 默认的
// `sandbox: workspace-write` / `approval: ask`）同一次写入照样发生——
// 写入目标是子进程 cwd，而 cwd 就是沙箱的 workspace root
// （`packages/bundle/base/cordis.patch.yml`，`workspaceRoot: !!js process.cwd()`）。
// 本套件设它，是为了把"被审批挡住"这一类失败从读数里排除掉，
// 让唯一可能的失败原因就是"工具没真跑"。本套件**不**断言它是条件——
// 谁把它当条件，谁就把一句安全加固读成了一条因果。
//
// ## 负对照为什么不是"完全不加 --patch"
//
// 完全不加 `--patch` 时子进程也会以 1 退出、也报同一句 `MISSING_CREDENTIAL`
// （probe-c 的 C2 观测过；写本文件时另跑过一次，读数一致）——
// 但那时持久化走的是默认的 zstd **多帧**格式，而 Node 内置的
// `zstdDecompressSync` 只解**第一帧**（实测：18 条记录只读出 1 条）。
// 于是"0 条 `tool/call`"这个断言会退化成"我只读到了第一条记录"——一句假绿。
//
// 所以负例保留 overlay，只把**模型接缝那两块**（`agent-default-model` 的 config
// 与 `- insert:`）逐字节减掉，让默认路由落回 shipped 的 `deepseek-official`：
// 退出码非 0、`MISSING_CREDENTIAL`、日志是明文可解，且**"两次运行只差这两块"
// 被机器逐字节核对过**（第二条用例第一段断言的就是这件事）。
// 另外，两个一次性 home 的内容**完全相同**（同一份 package.json、同一个桩文件、
// 两份 overlay 都在），差别只有命令行传的是哪一份 overlay——所以
// "桩文件躺在磁盘上但没被挂载，于是什么都没发生"这句话也是被读出来的。
//
// ## 诚实边界（这一套**没有**证明的东西）
//
//   · 只在 **win32** 上被观测过。工具面是 `pwsh`（`dsh-base` 里
//     `tool-pwsh` 的行写着 `disabled: !!js process.platform !== 'win32'`，
//     posix 上那行是 `tool-bash`）。posix 分支（`bash` + `printf`）在
//     `probe-b.mjs` 里写了但从没跑过，本套件因此**在非 win32 上逐条 SKIP**
//     并写明原因，而不是把一条未观测的路径放进 CI 赌它是绿的。
//   · 桩**不看任务文本**。读数全部来自"桩被装上了"这件事，不是来自
//     "模型理解了任务"。这不是缺陷，是刻意的：本套件问的是
//     "真进程会不会真的派发并执行一个工具"，不是"模型聪不聪明"。
//   · 桩是**本套件自己写进一次性 home** 的，不是 DSH 仓库里的东西。
//     它用的 API（`LlmAdapter` / `registerAdapter`）是产品的公开面，
//     但"这一行由本套件声明"是事实，写在这里而不是藏在代码里。
//   · 没有 TUI、没有监听端口、没有网络、没有任何凭证。
//   · **它没有测 Legion 的编排。** 它测的是"底层那条路真的能跑"——
//     也就是那三行台账一直缺的那半句。之上的东西要靠别的套件。
//
// ## 安全纪律（与同目录那几套真实进程套件同一套）
//
//   每个子进程一套 `os.tmpdir()` 下的一次性 `DSH_HOME` + 一次性 agents home +
//   一次性 cwd；spawn 之前断言它们都在本次 run 的 scratch 与 tmpdir **之内**；
//   `spawnSync` 带 180s 超时；`DSH_SNAPSHOT` 删掉；`after()` 把整棵 scratch 删掉。
//   **绝不**读/写/改操作者真实的 `~/.dsh`，**绝不**往真实 profile 里写 patch，
//   **绝不**读 `.credentials.yaml`。
//   本文件里唯一被打印的"token"是本进程 `randomBytes` mint 出来的一次性 sentinel，
//   不是凭证。
// ============================================================================

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { after, describe, test } from 'node:test'

// ★ 检出用**共享解析器**找（理由见下面可跑性判定那段）。
import { resolveDshCheckout } from '../../scripts/lib/dsh-checkout.mjs'

// ── 可跑性判定（沿用同目录 `employee-preset-mount-dsh-process.test.mjs` 的口径）──
// ★ 检出用**共享解析器**找（`tests/dsh-checkout.mjs`）。此前手写
//   `process.env.DSH_CHECKOUT ?? null`，实测后果：变量没导出时本套件
//   **4 条全跳**，CI 报 `PASS tests=4 pass=0 skipped=4`。
const DSH_FOUND = resolveDshCheckout({ need: 'cli' })
const DSH = DSH_FOUND.checkout
const CLI = DSH === null ? null : join(DSH, 'apps', 'cli', 'lib', 'bin.js')

/**
 * 缺 DSH 时整组逐条 `t.skip(原因)`，**不失败**；跑不了就不算跑过。
 *
 * 平台那一条是**刻意**的：见文件头"诚实边界"——posix 分支没有被观测过，
 * 与其把它塞进 CI 赌一次绿，不如让它显式地出现在 `skipped: N` 里。
 */
const DSH_SKIP = DSH === null
  ? DSH_FOUND.reason
  : process.platform !== 'win32'
    ? `本套件只在 win32 上被观测过（工具面是 pwsh）；当前平台 ${process.platform}`
      : false

/**
 * 每一条真进程用例都走这里：缺 DSH 时 `t.skip(原因)`。
 *
 * 注意这里**不**像同目录那套一样再补一条 `assert.ok(true, '本次未运行')` 的用例：
 * 一个 ok 的"未运行"用例与一个 skipped 的用例在摘要里不是同一个读数——
 * 前者会混进 `pass` 里，后者老老实实待在 `skipped` 里。
 */
const guarded = (name, fn) => test(name, { timeout: 240_000 }, (t) => {
  if (DSH_SKIP !== false) return t.skip(`SKIP：${DSH_SKIP}`)
  return fn(t)
})

// ── 一次性 scratch（整棵在 after() 里删）────────────────────────────────
const TMP_ROOT = resolve(tmpdir())
const SCRATCH = resolve(mkdtempSync(join(TMP_ROOT, 'legion-headless-realtool-')))
assert.ok(SCRATCH.startsWith(TMP_ROOT + sep), `scratch 逃出了 tmpdir：${SCRATCH}`)

after(() => {
  // 子进程都走 spawnSync，此刻已经退出；整棵 scratch 连同它下面每一个一次性 home 一起删。
  rmSync(SCRATCH, { recursive: true, force: true })
})

// ── 常量 ────────────────────────────────────────────────────────────────
const PROFILE_NAME = 'headless'
/**
 * 子进程 cwd 里那个 sentinel 的文件名。
 *
 * 用**文件**而不是"子进程退出码"或"stdout 里出现了什么"：文件是
 * 工具进程写的字节，不是模型协议里的字符串。
 */
const SENTINEL_NAME = 'headless-real-tool-sentinel.txt'
/** 一次性 profile 里那三份文件的文件名。 */
const STUB_MODULE_NAME = 'legion-probe-llm.mjs'
const POS_PATCH_NAME = 'legion-probe.patch.yml'
const NEG_PATCH_NAME = 'legion-probe-nomodel.patch.yml'
/** 桩脚本写给工具的那次调用用的 callId；日志里的 `tool/result` 必须配上它。 */
const PROBE_CALL_ID = 'legion-probe-call'
/** 桩脚本导出的 provider 名；overlay 把它设为默认路由。 */
const PROBE_PROVIDER = 'probe-model'
/** 本平台真正会被挂上的 shell 工具（见文件头"诚实边界"）。 */
const TOOL_NAME = 'pwsh'
/** 任务文本。桩不看它——它是一次性流程的入场券，不是判据的一部分。 */
const TASK = 'Write the sentinel token into the working directory through one real tool call.'

/** 每个子进程一套：os.tmpdir() 下的一次性目录，且在 spawn 之前被断言没有逃逸。 */
function mkTemp(tag) {
  const dir = resolve(mkdtempSync(join(SCRATCH, tag)))
  assert.ok(dir.startsWith(TMP_ROOT + sep), `一次性目录逃出了 tmpdir：${dir}`)
  assert.ok(dir.startsWith(SCRATCH + sep), `一次性目录逃出了本次 run 的 scratch：${dir}`)
  return dir
}

/** 本进程 mint 的一次性 sentinel。它不是凭证，打印它没有风险。 */
function mintToken() {
  return `SENTINEL_${randomBytes(10).toString('hex').toUpperCase()}`
}

// ── overlay：正例与负例的差别被逐字节钉住 ───────────────────────────────
/**
 * 四块，各自独立，拼起来就是 overlay。
 *
 * 拆成块是为了让"负例 = 正例减去模型接缝"这句话**可被机器核对**，
 * 而不是靠一条注释声称。见下面第二条用例的第一段断言。
 */
const PATCH_BLOCKS = Object.freeze({
  /** 模型接缝 ①：把默认路由指到桩的 provider。 */
  modelSeam: '- id: agent-default-model\n'
    + '  config:\n'
    + `    provider: ${PROBE_PROVIDER}\n`
    + `    model: ${PROBE_PROVIDER}\n`,
  /** 三个与本次无关、但会各自去打网络/读凭证的行，关掉以去掉噪音。 */
  disables: '- id: session-title-llm\n'
    + '  disabled: true\n'
    + '\n'
    + '- id: plugin-package-inventory-deepseek\n'
    + '  disabled: true\n'
    + '\n'
    + '- id: agent-instructions\n'
    + '  disabled: true\n',
  /**
   * 会话持久化写成**明文**。
   *
   * 不是风格偏好：默认的多帧 zstd 无法用 Node 内置的 zstd 读完
   * （只解第一帧），于是"日志里有/没有 tool/call"会退化成
   * "我只读到了第一条记录"。判据必须建立在完整读完的日志上。
   */
  persistence: '- id: session-persistence-jsonl\n'
    + '  config:\n'
    + "    root: !!js dshHomePath('sessions')\n"
    + '    compression: none\n',
  /** 模型接缝 ②：把本地纯 JS 桩挂成一行插件。它只供应模型流。 */
  insert: '- insert:\n'
    + '    - id: probe-headless-llm\n'
    + `      name: './${STUB_MODULE_NAME}'\n`,
})

const POS_PATCH_TEXT = [
  PATCH_BLOCKS.modelSeam,
  PATCH_BLOCKS.disables,
  PATCH_BLOCKS.persistence,
  PATCH_BLOCKS.insert,
].join('\n')

/** 负例：同一份 overlay，逐字节减去模型接缝的两块。 */
const NEG_PATCH_TEXT = [
  PATCH_BLOCKS.disables,
  PATCH_BLOCKS.persistence,
].join('\n')

/** profile 自己声明的 shipped bundle 列表——工具面与 ToolRuntime 都来自它。 */
function profilePackageJson() {
  return JSON.stringify({
    name: `dsh-profile-${PROFILE_NAME}`,
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
        patchReload: 'startup',
      },
    },
  }, undefined, 2) + '\n'
}

/**
 * 桩的源码：**只**做一件事——把一次工具调用当成模型输出吐出来。
 *
 * 这一段是**要被写进文件的 JavaScript 源码**，用字符串数组拼出来（不是模板串），
 * 所以里面既没有反引号也没有 `${`，不会跟本文件的语法打架。
 *
 * 三个刻意的性质（第三条用例会逐条读它们）：
 *   ① 唯一的 import 是 `@deepseek-ai/dsh-llm`——模型抽象，不是文件系统；
 *   ② sentinel 路径与 token 各自只作为**一个字面量**出现一次
 *      （`const SENTINEL = …` / `const TOKEN = …`），命令字符串由这两个变量拼出来，
 *      于是路径在桩里没有第二个出口；
 *   ③ 不 `inject` 工具面、不 `emit` 任何事件、不认识 `tool/result`。
 */
function stubSource(sentinel, token, toolName) {
  return [
    '// Legion 探针行（由 headless-real-tool.test.mjs 生成，不是产品代码）。',
    '// 它只做一件事：把一次工具调用当作模型输出吐出来。',
    '// 它不 import 任何文件系统/进程模块，也不派发任何工具。',
    "import { ToolCallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'",
    '',
    'const SENTINEL = ' + JSON.stringify(sentinel),
    'const TOKEN = ' + JSON.stringify(token),
    'const TOOL_NAME = ' + JSON.stringify(toolName),
    'const COMMAND = "Set-Content -LiteralPath \'" + SENTINEL + "\' -Value \'" + TOKEN',
    '  + "\'; Get-Content -LiteralPath \'" + SENTINEL + "\'"',
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
    '    const last = options.messages.at(-1)',
    "    const toolResult = last === undefined",
    '      ? undefined',
    "      : last.content.find((block) => block.type === 'tool-result')",
    '    if (toolResult === undefined) {',
    "      const args = JSON.stringify({ command: COMMAND, description: 'legion headless real-tool probe' })",
    '      const id = ToolCallId(' + JSON.stringify(PROBE_CALL_ID) + ')',
    "      yield { type: 'block-start', index: 0, blockType: 'tool-call' }",
    "      yield { type: 'tool-call-delta', index: 0, id, name: TOOL_NAME, argumentsDelta: args }",
    "      yield { type: 'block-end', index: 0,",
    "        block: { type: 'tool-call', id, name: TOOL_NAME, arguments: args } }",
    "      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }",
    "      yield { type: 'finish', reason: { kind: 'tool-calls' } }",
    '      return',
    '    }',
    '    const text = toolResult.content',
    "      .filter((block) => block.type === 'text')",
    "      .map((block) => block.text).join('')",
    "    const reply = 'LEGION_TOOL_RESULT<' + text.trim() + '>'",
    "    yield { type: 'block-start', index: 0, blockType: 'text' }",
    "    yield { type: 'text-delta', index: 0, text: reply }",
    "    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }",
    "    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 3 } }",
    "    yield { type: 'finish', reason: { kind: 'stop' } }",
    '  }',
    '}',
    '',
    "export const name = 'probe-headless-llm'",
    "export const inject = ['llm']",
    'export function apply(ctx) {',
    `  ctx.llm.registerAdapter([${JSON.stringify(PROBE_PROVIDER)}], new LegionProbeAdapter())`,
    '}',
    '',
  ].join('\n')
}

/** 一次性 home 的三个目录（都在本次 run 的 scratch 之下）。 */
function makeHome(tag) {
  const home = mkTemp(`home-${tag}-`)
  const agents = mkTemp(`agents-${tag}-`)
  const cwd = mkTemp(`cwd-${tag}-`)
  const profileDir = join(home, 'profiles', PROFILE_NAME)
  mkdirSync(profileDir, { recursive: true })
  return { home, agents, cwd, profileDir }
}

/**
 * 把一次性 profile 写满：package.json + 桩 + **两份** overlay。
 *
 * 两份都写，是为了让正例与负例的 home 内容完全相同——
 * 于是"两次运行只差命令行上的那一份 overlay"这件事不需要靠注释声称。
 */
function writeProfile({ profileDir, cwd }, sentinel, token) {
  writeFileSync(join(profileDir, 'package.json'), profilePackageJson())
  const source = stubSource(sentinel, token, TOOL_NAME)
  writeFileSync(join(profileDir, STUB_MODULE_NAME), source)
  writeFileSync(join(profileDir, POS_PATCH_NAME), POS_PATCH_TEXT)
  writeFileSync(join(profileDir, NEG_PATCH_NAME), NEG_PATCH_TEXT)
  return source
}

/**
 * 子进程环境：一次性 home、删掉 `DSH_SNAPSHOT`、没有 `DEEPSEEK_API_KEY`。
 *
 * `DSH_PERMISSION_MODE` 的理由写在文件头——它是防呆，**不是**前提。
 */
function childEnv(home, agents) {
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
    DSH_PERMISSION_MODE: 'danger-full-access',
  })
  return env
}

/** 跑一次真 dsh：带超时、stdio 走管道、cwd 是那个一次性目录。 */
function spawnDsh({ home, agents, cwd, patch, task, timeoutMs = 180_000 }) {
  const args = ['--profile', PROFILE_NAME, '--patch', patch, task]
  const started = Date.now()
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: childEnv(home, agents),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  return {
    code: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    spawnError: result.error === undefined ? null : String(result.error.message ?? result.error),
    elapsedMs: Date.now() - started,
  }
}

// ── 会话日志 ────────────────────────────────────────────────────────────

/** 一次性 home 下的全部会话日志（`.jsonl` / `.jsonl.zstd`），排序后返回。 */
function sessionLogFiles(home) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return []
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * 读一份会话日志，返回记录数组。
 *
 * 只吃明文。overlay 里 `compression: none` 就是为此；真读到 zstd 就**如实报错**，
 * 而不是把压缩字节当文本 split——那会让"0 条 `tool/call`"变成一句假绿。
 */
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

/**
 * 从一条 `tool/result` 记录里取出三个叶子字段。
 *
 * 只读叶子、不整对象搬运：记录来自磁盘（是普通 JSON），但把整条塞进断言消息里
 * 会让失败输出变成一屏噪音，而且形状一变就只剩"字符串对不上"这一句。
 * 形状变了这里会读出 `null`，断言随即点名说清是哪一个字段。
 */
function resultFacts(record) {
  const message = record?.data?.message
  const block = Array.isArray(message?.content)
    ? message.content.find((entry) => entry?.type === 'tool-result')
    : undefined
  const text = Array.isArray(block?.content)
    ? block.content.filter((entry) => entry?.type === 'text').map((entry) => entry.text).join('')
    : ''
  return {
    toolCallId: block?.toolCallId ?? null,
    isError: block?.isError ?? null,
    text,
  }
}

// ── 场景（每个场景 = 一个真子进程；同一个场景只起一次）──────────────────

const SCENARIOS = new Map()

/**
 * 一个场景只跑一次，多条用例共用它的读数。
 *
 * 理由与同目录那套一样：本套件的每一条断言都是**同一次运行里两个读数之间的关系**
 * （call 与 result、日志与磁盘），分成两次进程去读，两边的差异就可能是
 * "进程不同"而不是"断言在问的那件事"。
 */
function scenario(name, build) {
  if (!SCENARIOS.has(name)) SCENARIOS.set(name, build())
  return SCENARIOS.get(name)
}

/**
 * 一次真运行。正例与负例走同一条装配路径，唯一不同的参数是 `patchName`。
 *
 * 这本身就是那一句"唯一被加进去的是模型接缝"的机械形式：
 * home 的构造、env、任务文本、超时、工具面，两边逐字相同。
 */
function buildRun(tag, patchName) {
  const token = mintToken()
  const base = makeHome(tag)
  const sentinel = join(base.cwd, SENTINEL_NAME)
  const source = writeProfile(base, sentinel, token)

  const run = spawnDsh({ ...base, patch: join(base.profileDir, patchName), task: TASK })

  const logFiles = sessionLogFiles(base.home)
  const records = logFiles.flatMap(readRecords)
  return { ...run, ...base, token, sentinel, source, logFiles, records }
}

const buildPositive = () => buildRun('pos', POS_PATCH_NAME)
const buildNegative = () => buildRun('neg', NEG_PATCH_NAME)

// ── 桩里**不许**出现的东西 ──────────────────────────────────────────────
/**
 * 判据是"桩有没有能力碰文件系统或伪造工具事件"，所以查的是**能力入口**，
 * 不是"某个词有没有出现"。`Set-Content` / `Get-Content` 这两串**允许**出现——
 * 它们是要交给真工具执行的命令**字符串**，不是桩自己在做的事：
 *
 *   > 一段"把 `Set-Content` 当作 string 递给别人"的代码，
 *   > 与一段"自己写文件"的代码，在全文搜索 `Set-Content` 时一模一样。
 *   > 所以这里禁的是 import / API 名，不是命令文本。
 */
const FORBIDDEN_IN_STUB = Object.freeze([
  'node:',
  "'fs'", '"fs"',
  "'child_process'", '"child_process"',
  'require(', 'createRequire',
  'readFile', 'writeFile', 'appendFile', 'existsSync', 'readdir', 'unlink', 'statSync',
  'createWriteStream', 'createReadStream',
  'spawn', 'execSync', 'execFile', 'fork(',
  'process.', 'globalThis', 'Deno',
  "'tool/result'", '"tool/result"', "'tool/call'", '"tool/call"',
  'ctx.tools', 'ctx.get(', 'ctx.on(', '.emit(', 'toolRuntime',
])

// ── 用例 ────────────────────────────────────────────────────────────────

describe('真 DSH 进程 × 真工具执行（headless 一次性运行）', () => {
  guarded('★★★★★ 真执行本身：真 DSH 进程跑真 pwsh，在 cwd 留下 sentinel', (t) => {
    const r = scenario('positive', buildPositive)

    assert.equal(r.spawnError, null, `子进程没能起来：${r.spawnError}`)
    assert.equal(r.signal, null, `子进程被信号打断（超时？）：signal=${r.signal}\n${r.stderr}`)
    assert.equal(r.code, 0, `真 DSH 进程必须 exit 0：\n${r.stderr}`)

    // ★ 承重断言：带外副作用。
    //
    // 这一条**不能**由一个没有文件系统能力的模块伪造。桩 import 的只有
    // `@deepseek-ai/dsh-llm`（下面第三条用例逐条读源码），它唯一能做的事就是把
    // 一段命令字符串交给模型协议。磁盘上这个文件是**另一个进程**写的。
    assert.ok(existsSync(r.sentinel), `sentinel 文件不存在：${r.sentinel}`)
    const onDisk = readFileSync(r.sentinel, 'utf8')
    assert.equal(onDisk.trim(), r.token,
      `sentinel 的内容不是本次 mint 的 token：读到 ${JSON.stringify(onDisk)}`)
    t.diagnostic(`SENTINEL-ON-DISK ${SENTINEL_NAME} = ${JSON.stringify(onDisk)}`)

    // 本次运行真的写了一份日志。
    //
    // 没有这一段，"日志里有 tool/result"可能是在读一份**上一次运行**留下的文件，
    // 也可能是空集合上的恒真命题。一次性 home 让前者不可能，但"确实是这一次写的"
    // 要能被读出来——下面那条 cwd 比对就是这件事。
    assert.equal(r.logFiles.length, 1,
      `一次性 home 下应当恰好一份会话日志，实际 ${r.logFiles.length} 份：${r.logFiles.join(' | ')}`)
    const session = ofType(r.records, 'session')[0]
    assert.notEqual(session, undefined, '会话日志里没有 session 记录')
    assert.equal(resolve(session.cwd), resolve(r.cwd),
      `会话日志的 cwd（${session.cwd}）不是本次子进程的 cwd（${r.cwd}）——这不是这一次写的日志`)

    // ① 排掉"决定要调、但没有任何东西执行"：必须有一条 tool/call，**且**配得上一条 tool/result。
    const calls = ofType(r.records, 'tool/call')
    const results = ofType(r.records, 'tool/result')
    assert.equal(calls.length, 1, `应当恰好一条 tool/call，实际 ${calls.length} 条`)
    assert.equal(results.length, 1, `应当恰好一条 tool/result，实际 ${results.length} 条`)

    const call = calls[0]
    assert.equal(call.data.name, TOOL_NAME, `派发的工具不是 ${TOOL_NAME}：${call.data.name}`)
    assert.equal(call.data.callId, PROBE_CALL_ID, `callId 不是桩脚本声明的那个：${call.data.callId}`)
    // 派发出去的命令真的是针对本次那个 sentinel 的，且带着本次 mint 的 token。
    // （这两条证明的是"派发发生了"，不是"执行成功了"——执行成功由磁盘上的文件证明。）
    const args = String(call.data.arguments ?? '')
    assert.ok(args.includes(SENTINEL_NAME), `派发的命令里没有 sentinel 文件名：${args.slice(0, 300)}`)
    assert.ok(args.includes(r.token), '派发的命令里没有本次 mint 的 token')

    // ② 排掉"执行了但失败了"。
    const facts = resultFacts(results[0])
    assert.equal(facts.toolCallId, call.data.callId,
      `tool/result 配不上那条 tool/call：${String(facts.toolCallId)} vs ${String(call.data.callId)}`)
    assert.equal(facts.isError, false, `工具结果是失败：${JSON.stringify(facts.text).slice(0, 300)}`)
    assert.ok(facts.text.includes(r.token),
      `工具结果文本里没有本次 mint 的 token：${JSON.stringify(facts.text).slice(0, 300)}`)

    // 结果排在调用之后，且时间戳真的有间隔（真子进程的往返，不是同一 tick 里编出来的）。
    assert.ok(results[0].seq > call.seq, 'tool/result 的 seq 不在 tool/call 之后')
    assert.ok(results[0].time >= call.time,
      `tool/result 的时间戳早于 tool/call：${results[0].time} < ${call.time}`)

    // 这一条**不是**判据：桩把工具结果拼进了最终回复，所以 stdout 里有 token
    // 是桩的行为。留在这里只为覆盖 headless 入口"打印最终消息"这一句契约。
    assert.ok(r.stdout.includes(r.token), `stdout 里没有最终消息：${JSON.stringify(r.stdout)}`)

    t.diagnostic(`TOOL ${TOOL_NAME} callId=${PROBE_CALL_ID} isError=false exit=0 ${r.elapsedMs}ms`)
  })

  guarded('★★★ 负对照：同一套 home、逐字节减去模型接缝 → MISSING_CREDENTIAL 且 0 条 tool/call', (t) => {
    // 先钉住"两次运行的差别是什么"，再做任何读取。
    //
    // 一个"绿了"的负对照，与一个"减错了地方"的负对照，在只看退出码时一模一样：
    // 后者删掉的可能正好是持久化那一行，于是"日志格式不同"会被读成"模型接缝是原因"。
    const derived = POS_PATCH_TEXT
      .replace(PATCH_BLOCKS.modelSeam + '\n', '')
      .replace('\n' + PATCH_BLOCKS.insert, '')
    assert.equal(derived, NEG_PATCH_TEXT,
      '负例 overlay 不是正例 overlay 逐字节减去模型接缝的两块——那这一条负对照问的不是"只差接缝"')
    assert.equal(NEG_PATCH_TEXT.includes(PROBE_PROVIDER), false, '负例 overlay 里还留着桩的 provider')
    assert.equal(NEG_PATCH_TEXT.includes(STUB_MODULE_NAME), false, '负例 overlay 里还挂着桩那一行')
    assert.equal(NEG_PATCH_TEXT.includes('session-persistence-jsonl'), true,
      '负例 overlay 把持久化那一行也删了——两次运行的日志格式就不同形了')

    const r = scenario('negative', buildNegative)

    // 桩**在磁盘上**（两个 home 的内容逐字相同），只是没有任何一行挂载它。
    assert.ok(existsSync(join(r.profileDir, STUB_MODULE_NAME)),
      `负例的 home 里没有那个桩文件——那"桩躺在磁盘上但没被挂载"这句话就没被读出来：${r.profileDir}`)

    assert.equal(r.spawnError, null, `子进程没能起来：${r.spawnError}`)
    assert.equal(r.signal, null, `子进程被信号打断（超时？）：signal=${r.signal}\n${r.stderr}`)
    assert.notEqual(r.code, 0, `没有模型接缝却 exit 0 —— 那"工具跑起来了"跟模型接缝无关：\n${r.stdout}`)

    // 点名原因，而不是"非 0 就算数"：超时、崩溃、缺包都会给非 0，
    // 而它们与"这条路需要模型凭证"是完全不同的事。
    assert.match(r.stderr, /MISSING_CREDENTIAL/,
      `失败原因不是凭证拒绝（对照的是"唯一被加进去的是模型接缝"）：\n${r.stderr}`)

    // ★ 零条 tool/call。
    //
    // 这里与上面那条正例共用同一个事实：dsh-base 照样把工具面挂起来了，
    // 任务文本一个字都没变，改的只有"模型那条路有没有桩"。
    // 一个只会证明"配好了就能跑"的套件，在工具因为别的原因跑起来时也是绿的；
    // 这一条钉住的是：**我们加进去的只有模型接缝**。
    assert.equal(r.logFiles.length, 1,
      `一次性 home 下应当恰好一份会话日志，实际 ${r.logFiles.length} 份：${r.logFiles.join(' | ')}`)
    // 非空条件：日志里必须真的有一次 turn 开始过。
    // 否则"0 条 tool/call"可能只是"进程根本没走到 agent 循环"——
    // 那是另一件事，不是这一条要问的。
    assert.ok(ofType(r.records, 'turn/start').length >= 1,
      `负例日志里没有 turn/start —— "0 条 tool/call"就成了空条件：${r.records.map((x) => x.type).join(',')}`)
    assert.equal(ofType(r.records, 'tool/call').length, 0,
      `没有模型接缝却出现了 tool/call：${JSON.stringify(ofType(r.records, 'tool/call')).slice(0, 300)}`)
    assert.equal(ofType(r.records, 'tool/result').length, 0,
      `没有模型接缝却出现了 tool/result：${JSON.stringify(ofType(r.records, 'tool/result')).slice(0, 300)}`)

    t.diagnostic(`NEG exit=${r.code} records=${r.records.length} tool/call=0 tool/result=0 ${r.elapsedMs}ms`)
  })

  guarded('★★★ 桩不伪造结果：桩没有文件系统能力，sentinel 路径在桩里只有一个出口', (t) => {
    const r = scenario('positive', buildPositive)
    const source = r.source

    // ① 唯一的 import 就是模型抽象。
    //
    // 这一条不是洁癖：下面那句"桩不可能写出那个文件"的**全部**依据就是它。
    const importLines = source.split('\n').filter((line) => line.startsWith('import '))
    assert.deepEqual(importLines,
      ["import { ToolCallId, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'"],
      `桩 import 了模型抽象之外的东西：${JSON.stringify(importLines)}`)

    // ② 没有任何文件系统/子进程/伪造工具事件的入口。
    for (const forbidden of FORBIDDEN_IN_STUB) {
      assert.equal(source.includes(forbidden), false,
        `桩里出现了 ${forbidden} —— 那"这个文件只可能是真工具写的"这句话就不成立了`)
    }

    // ③ sentinel 路径在桩里**只出现一次**，而且是作为一个普通字符串常量。
    //
    // 出现两次就说明它进了某个函数的参数位置（第二次出现就是"拿它去做什么"）；
    // 出现一次、且桩没有任何碰文件系统的入口，意味着它唯一的去向是
    // 被拼进要递给工具的那段命令**文本**里。
    const encodedSentinel = JSON.stringify(r.sentinel)
    assert.equal(encodedSentinel, JSON.stringify(resolve(r.cwd, SENTINEL_NAME)),
      'sentinel 不是子进程 cwd 下的那个文件')
    assert.equal(source.split(encodedSentinel).length - 1, 1,
      `sentinel 路径在桩里出现了 ${source.split(encodedSentinel).length - 1} 次，应当只有 1 次`)
    const sentinelLine = source.split('\n').find((line) => line.includes(encodedSentinel))
    assert.match(sentinelLine, /^const SENTINEL = /,
      `sentinel 路径出现的那一行不是常量声明：${sentinelLine}`)

    // ④ token 同理：桩只知道它，不代表桩能把它的**存在**写下来。
    const encodedToken = JSON.stringify(r.token)
    assert.equal(source.split(encodedToken).length - 1, 1,
      `token 在桩里出现了 ${source.split(encodedToken).length - 1} 次，应当只有 1 次`)
    assert.match(source.split('\n').find((line) => line.includes(encodedToken)), /^const TOKEN = /,
      'token 出现的那一行不是常量声明')

    // ⑤ 桩只声明了模型那一个服务：它没有工具面的入口。
    assert.equal(source.split('export const inject').length - 1, 1, '桩声明了不止一处 inject')
    assert.match(source, /^export const inject = \['llm'\]$/m,
      '桩 inject 的不是只有 llm —— 它可能自己去派发工具了')

    // ⑥ 交叉：三个地方的 token 是**同一个**。
    //
    //    本进程 mint 的 r.token
    //      == 磁盘上那个文件的字节（真工具进程写的）
    //      == 日志里 tool/result 的文本（真 ToolRuntime 记的）
    //    桩只知道第一个；中间那一个只能由工具进程产生。
    const facts = resultFacts(ofType(r.records, 'tool/result')[0] ?? {})
    assert.equal(readFileSync(r.sentinel, 'utf8').trim(), r.token, '磁盘上的 token 与本次 mint 的不一致')
    assert.ok(facts.text.includes(r.token), 'tool/result 里的 token 与本次 mint 的不一致')
    assert.equal(facts.isError, false, 'tool/result 是失败态')

    t.diagnostic('STUB-IMPORTS=1(only @deepseek-ai/dsh-llm)  FORBIDDEN=0  SENTINEL-LITERAL=1  TOKEN-LITERAL=1')
  })

  guarded('★ 判别汇总：正例的读数与负例的读数必须同时成立', (t) => {
    const pos = scenario('positive', buildPositive)
    const neg = scenario('negative', buildNegative)

    // 正例：真执行。
    assert.equal(pos.spawnError, null)
    assert.equal(pos.code, 0)
    assert.equal(readFileSync(pos.sentinel, 'utf8').trim(), pos.token)
    const posCalls = ofType(pos.records, 'tool/call')
    const posResults = ofType(pos.records, 'tool/result')
    assert.equal(posCalls.length, 1)
    assert.equal(posResults.length, 1)
    assert.equal(resultFacts(posResults[0]).isError, false)

    // 负例：同一个工具面、同一个任务，只少了模型接缝 → 一条工具记录都没有。
    assert.notEqual(neg.code, 0)
    assert.match(neg.stderr, /MISSING_CREDENTIAL/)
    assert.equal(ofType(neg.records, 'tool/call').length, 0)
    assert.equal(ofType(neg.records, 'tool/result').length, 0)

    // ★ 两条一起看才是本套件的意思：
    //
    //   > 一个"正例是绿的"的套件，与一个"正例绿、负例红得有名有姓"的套件，
    //   > 在摘要里都只是一片绿；只不过前者的绿，在工具根本没被派发时也是绿的。
    t.diagnostic(`POS exit=0 sentinel=1 tool/call=1 isError=false (${pos.elapsedMs}ms)  `
      + `NEG exit=${neg.code} tool/call=0 (${neg.elapsedMs}ms)`)
  })
})
