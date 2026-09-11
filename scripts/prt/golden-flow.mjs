// scripts/prt/golden-flow.mjs
// ============================================================================
// PRT-004：黄金流程定义与固定输入夹具
//
// 这是**纯定义模块**：不含 I/O、不含时间戳、不含随机数。相同输入永远得到
// 相同的文件内容与相同的夹具哈希。
//
// 为什么夹具要「生成」而不是「塞一个目录进仓库」：
//   黄金流程要在阶段 3 被反复重放，用于新旧路径对拍（spec §14.2）。若夹具是
//   仓库里一个普通目录，一次误改、一次换行符归一化、一次 `git checkout` 都会让它
//   静默漂移，而对拍双方看到的是「两份输入不同」却以为是「两条路径行为不同」。
//   生成式夹具把「输入」变成可校验的哈希：`assertFixtureHash()` 一旦不符就报错。
//
// 内容里**刻意不含中文与制表符**，且统一 LF：确保跨平台字节一致。
// ============================================================================
import { createHash } from 'node:crypto'

/** 黄金流程标识。 */
export const GOLDEN_FLOW_ID = 'GF-001'

/**
 * 固定输入夹具：一个最小 Node CLI 项目。
 *
 * 选择理由：
 *   - 规模小到可以完整读出，又不至于简单到不需要分工；
 *   - 「新增一个子命令 + 测试 + 文档」天然需要**计划 → 实现 → 评审**三段交接，
 *     满足「单目标、至少两岗位交接」；
 *   - 验收可机器判定（命令输出 + 测试通过），不依赖主观判断。
 *
 * 内容全 ASCII：夹具与「黄金任务说什么语言」无关，但全 ASCII 直接消灭了一整类
 * 跨平台漂移（BOM、编辑器编码、全角标点归一化）。检查规则见 `checkFixtureHygiene`。
 */
export const FIXTURE_FILES = Object.freeze({
  'package.json': `{
  "name": "gf001-cli",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "bin": { "gf001": "./src/cli.mjs" },
  "scripts": { "test": "node --test" }
}
`,
  'src/cli.mjs': `#!/usr/bin/env node
// gf001-cli -- a tiny command-line tool.
import { argv } from 'node:process'
import { pathToFileURL } from 'node:url'

export const USAGE = [
  'gf001-cli 1.0.0',
  '',
  'Usage:',
  '  gf001 --version    print version',
  '  gf001 help         print this message',
].join('\\n')

export function main(args) {
  const cmd = args[0]
  if (cmd === '--version') return { code: 0, out: '1.0.0' }
  if (cmd === 'help' || cmd === undefined) return { code: 0, out: USAGE }
  return { code: 2, out: \`unknown command: \${cmd}\` }
}

// The entry guard must normalize with pathToFileURL before comparing.
// Hand-building the URL from argv[1] never matches on Windows: import.meta.url
// is file:///D:/... (three slashes, forward slashes) while the hand-built string
// uses two slashes and backslashes. The body then never runs -- exit code 0 with
// no output at all. Unit tests import main() directly and cannot see this; only
// running the CLI as a command exposes it.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  const r = main(argv.slice(2))
  console.log(r.out)
  process.exit(r.code)
}
`,
  'test/cli.test.mjs': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../src/cli.mjs'

test('--version prints the version', () => {
  assert.deepEqual(main(['--version']), { code: 0, out: '1.0.0' })
})

test('help prints usage', () => {
  const r = main(['help'])
  assert.equal(r.code, 0)
  assert.match(r.out, /Usage:/)
})

test('unknown command exits with code 2', () => {
  const r = main(['nope'])
  assert.equal(r.code, 2)
})
`,
  'README.md': `# gf001-cli

Golden-flow fixture project. See \`docs/superpowers/prt/PRT-004-golden-flow.md\`.

## Usage

    gf001 --version
    gf001 help
`,
})

/**
 * 黄金任务定义（固定、不可随实现漂移）。
 *
 * `acceptance` 是机器可判定的验收契约：spec §4.4 要求每次执行都有确定输出
 * 与验收，黄金流程的验收尤其不能是「看起来做完了」。
 */
export const GOLDEN_TASK = Object.freeze({
  id: 'GF-001-T1',
  title: '为 gf001-cli 新增 greet 子命令',
  goal: '给 gf001-cli 增加 `greet <name>` 子命令，输出 `Hello, <name>!`；补充单元测试与 README。',
  /** 岗位交接顺序：至少两段交接（spec §14.2）。 */
  handoffs: Object.freeze([
    Object.freeze({ from: 'planner', to: 'implementer', deliverable: '实施计划（改动文件清单 + 验收步骤）' }),
    Object.freeze({ from: 'implementer', to: 'reviewer', deliverable: '代码改动 + 自测输出' }),
    Object.freeze({ from: 'reviewer', to: 'planner', deliverable: '评审结论（通过 / 打回理由）' }),
  ]),
  /** 验收契约：全部为可机器判定项。 */
  acceptance: Object.freeze({
    schema: Object.freeze({
      type: 'object',
      required: ['filesChanged', 'testCommand', 'testPassed', 'readmeUpdated'],
      properties: Object.freeze({
        filesChanged: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
        testCommand: Object.freeze({ type: 'string' }),
        testPassed: Object.freeze({ type: 'boolean' }),
        readmeUpdated: Object.freeze({ type: 'boolean' }),
      }),
    }),
    prompt: 'greet 子命令可用、单元测试通过、README 已补充用法；验收五项缺一不可。',
    /**
     * 验收项（机器可判定）。**这一项是第一次真实执行后补上的**：
     * 前四项全部能被「只加函数、不接通命令行入口」的改动满足，
     * 于是夹具入口判据在 Windows 上失效（`node src/cli.mjs --version` 无输出）
     * 却仍然四项全绿。`cli` 把 CLI 当命令真跑一次，堵住这个缺口。
     */
    cliBehavior: Object.freeze({
      type: 'object',
      required: Object.freeze(['greetOk', 'missingNameNonZero', 'versionIntact', 'helpDiscoverable']),
      properties: Object.freeze({
        greetOk: Object.freeze({ type: 'boolean' }),
        missingNameNonZero: Object.freeze({ type: 'boolean' }),
        versionIntact: Object.freeze({ type: 'boolean' }),
        helpDiscoverable: Object.freeze({ type: 'boolean' }),
      }),
    }),
  }),
  /**
   * 预期任务状态序列（§14.2 新旧对拍的比较基准）。
   *
   * ## 这个值被实测证据修正过
   *
   * 首版写的是 `todo → in_progress → in_review → done`（人工臆测的理想路径）。
   * 用真实历史核对后（`scripts/prt/old-path-evidence.mjs`，software 空间）：
   *
   *   - 76 个有轨迹的已完成任务里，与该字面序列逐项相符的只有 **4 个（5.3%）**；
   *   - **42 个（55%）根本不经过 `in_review`**；
   *   - 最常见的形态是 `in_progress → advanced`（`advance` 不写 `to` 值）。
   *
   * 若继续拿那个字面序列当基准，阶段 3 会把一条**与旧路径等价**的新路径
   * 判成「不等价」——因为旧路径自己都不走那条路。
   *
   * 因此基准改为 `modalTaskStateSequence`（多数路径）+
   * `acceptedTaskStateSequences`（可接受集合），对拍语义从「逐字相等」改为
   * 「落在旧路径实际出现过的形态集合内」。
   *
   * ## `in_progress → done` 为什么是合法的（尽管 `TRANSITIONS` 不允许）
   *
   * 旧路径有**两条**写 `done` 的路径，只有其中一条查迁移表：
   *
   *   · `transitionTask`（`team-hub/server.mjs:2682`）查 `TRANSITIONS`，
   *     且硬性要求 `to === 'done'` 时 `by === 'general'`（将军在用户接受后收尾）；
   *   · `advanceTask`（`:2705`）**完全不查迁移表**，只要求操作者是该岗位本人，
   *     便直接把 `in_progress` / `in_review` 写成 `done`。
   *
   * 也就是说：**声明的状态机不是被强制执行的状态机**。`prt-007-baseline.json`
   * 记录的 20 条迁移边只覆盖了 `transitionTask`，`advanceTask` 的旁路不在其中。
   * 「只有将军能把任务移到 done」这条规则可以被岗位自己绕过——这正是 42/76 个任务
   * 不出现 `in_review` 的直接原因。
   *
   * 这件事必须记在这里：新路径若只实现 `TRANSITIONS`，就会**少一条旧路径真实走过的边**，
   * 对拍时被判成不等价。同时又不能把它当成「想要的语义」照抄——它更像一处待裁决的旧债。
   * 裁决入口登记在 `docs/PRT-005-evidence/verify-evidence.md` §3.4。
   */
  modalTaskStateSequence: Object.freeze(['in_progress', 'advanced']),
  acceptedTaskStateSequences: Object.freeze([
    Object.freeze(['todo', 'in_progress', 'advanced']),
    Object.freeze(['in_progress', 'advanced']),
    Object.freeze(['todo', 'in_progress', 'in_review', 'done']),
    Object.freeze(['in_progress', 'in_review', 'done']),
  ]),
  /**
   * 绕过迁移表的写 `done` 路径。可接受序列的合法性判定要同时考虑它，
   * 否则旧路径最主流的形态会被判成「非法迁移」——那是基准写错，不是旧路径错。
   */
  transitionBypass: Object.freeze({
    fn: 'advanceTask',
    at: 'team-hub/server.mjs:2705',
    allows: Object.freeze(['in_progress->done', 'in_review->done']),
    note: '不查 TRANSITIONS，也不要求 by === general',
  }),
  /** 旧路径实测依据（可复核）：逐项对拍结果见 docs/superpowers/prt/PRT-009-baseline.md。 */
  stateSequenceEvidence: Object.freeze({
    measuredAt: '2026-09-11',
    source: 'docs/superpowers/prt/prt-009-execution-evidence.json',
    completedWithTrail: 76,
    exactMatchWithLegacyExpectation: 4,
    skipInReview: 42,
  }),
})

/** 夹具内所有文件的 sha256（按路径排序后逐个计算）。 */
export function fixtureFileHashes(files = FIXTURE_FILES) {
  const out = {}
  for (const path of Object.keys(files).sort()) {
    out[path] = createHash('sha256').update(files[path], 'utf8').digest('hex')
  }
  return out
}

/**
 * 夹具整体哈希：对「路径 + 内容」的有序拼接取摘要。
 * 任一文件被改动，或文件集合变化，本值都会变。
 *
 * 接受 `files` 参数是为了让「哈希确实同时覆盖路径与内容」这条性质可被测到，
 * 而不必在测试里重写一遍同样的哈希逻辑（那样测的是测试自己）。
 */
export function fixtureHash(files = FIXTURE_FILES) {
  const h = createHash('sha256')
  h.update(`golden-fixture-v1\0${GOLDEN_FLOW_ID}\0`, 'utf8')
  for (const path of Object.keys(files).sort()) {
    h.update(path, 'utf8')
    h.update('\0', 'utf8')
    h.update(files[path], 'utf8')
    h.update('\0', 'utf8')
  }
  return h.digest('hex')
}

/**
 * 已冻结的夹具哈希。改动夹具内容必须同步更新此值并说明原因。
 *
 * 变更记录：
 *   · 5cab66e2…（首版）→ 2ad47fc4…：`package.json` 的 test 脚本由
 *     `node --test test/` 改为 `node --test`。
 *     原因：Node 24 把 `--test` 的位置参数当作**模块路径**解析，目录不会被展开，
 *     因此 `node --test test/` 报 `Cannot find module '...\test'` 并以退出码 1 结束——
 *     也就是说夹具自带的 `npm test` **从来没有通过过**。
 *     夹具内 3 条用例本身是正确的（`node --test` 自动发现时 3/3 通过）。
 *     这个缺陷在阶段 0 冻结时未被发现，因为当时没有任何一条用例真的执行过夹具的
 *     test 脚本；现已补上（golden-flow.test.mjs「夹具真实可执行」一节）。
 *   · 2ad47fc4… → 现值：`src/cli.mjs` 的入口判据由手拼
 *     `file://${argv[1]}` 改为 `pathToFileURL(argv[1]).href`。
 *     原因：手拼在 Windows 上**恒不成立**（`import.meta.url` 是 `file:///D:/…`，
 *     手拼得到 `file://D:\\…`），脚本主体永不进入 → `node src/cli.mjs --version`
 *     **退出码 0 且无任何输出**。单元测试 `import { main }` 直接调函数，看不到它。
 *     发现路径：**第一次真实执行黄金流程时，planner（deepseek-v4-pro）在现状勘察里
 *     实测出该现象并写进计划书 E3 节**——这正是黄金流程要有真实执行的价值。
 *     同批加固：验收契约新增 CLI 用户视角的四项检查（见 gf001-run.mjs），
 *     因为原四项（filesChanged/testCommand/testPassed/readmeUpdated）全部能被
 *     「只加函数、不改入口」满足，会把这个缺陷全绿放行。
 */
export const FIXTURE_HASH = '9d4d958cd027235183a3ff67ee8cd9d10a6663ca38e127512cab384d9e628817'

/** 校验夹具未被漂移；返回 {ok, expected, actual}。 */
export function assertFixtureHash() {
  const actual = fixtureHash()
  return { ok: actual === FIXTURE_HASH, expected: FIXTURE_HASH, actual }
}

/**
 * 夹具内容规范性检查：保证跨平台字节一致。
 *
 * 注意这里**没有**跑 `npm test`：规范性检查是纯函数式的内容检查，跑测试要落盘、
 * 要起进程。夹具「能不能真的跑起来」由 `golden-flow.test.mjs` 里那条
 * 真实物化 + 真实执行 `npm test` 的用例负责——本条注释的存在，是因为
 * 曾经只有这里、没有那条用例，于是夹具带着一条在 Node 24 上必然失败的
 * test 脚本被冻结了下来，而没人发现。
 */
export function checkFixtureHygiene(files = FIXTURE_FILES) {
  const problems = []
  for (const [path, content] of Object.entries(files)) {
    if (content.includes('\r')) problems.push(`${path} 含 CR，破坏跨平台字节一致`)
    if (content.includes('\t')) problems.push(`${path} 含制表符，破坏跨平台字节一致`)
    if (!content.endsWith('\n')) problems.push(`${path} 未以 LF 结尾`)
    if (/[^\x00-\x7F]/.test(content)) problems.push(`${path} 含非 ASCII 字符，可能受编码影响`)
    if (path.startsWith('/') || path.includes('..')) problems.push(`${path} 不是安全的相对路径`)
  }
  return problems
}

/**
 * 把夹具物化到给定写入器（注入式，便于在测试中不落盘）。
 * @param {(path: string, content: string) => void} write
 */
export function materializeFixture(write) {
  const problems = checkFixtureHygiene()
  if (problems.length > 0) throw new Error(`夹具不符合规范：${problems.join('; ')}`)
  for (const path of Object.keys(FIXTURE_FILES).sort()) {
    write(path, FIXTURE_FILES[path])
  }
  return { files: Object.keys(FIXTURE_FILES).length, hash: fixtureHash() }
}
