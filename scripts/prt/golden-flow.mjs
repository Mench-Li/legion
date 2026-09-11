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
  "scripts": { "test": "node --test test/" }
}
`,
  'src/cli.mjs': `#!/usr/bin/env node
// gf001-cli -- a tiny command-line tool.
import { argv } from 'node:process'

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

if (import.meta.url === \`file://\${argv[1]}\`) {
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
    prompt: 'greet 子命令可用、单元测试通过、README 已补充用法；四项缺一不可。',
  }),
  /** 预期任务状态序列（旧路径基线；§14.2 新旧对拍的比较基准）。 */
  expectedTaskStateSequence: Object.freeze([
    'todo', 'in_progress', 'in_review', 'done',
  ]),
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

/** 已冻结的夹具哈希。改动夹具内容必须同步更新此值并说明原因。 */
export const FIXTURE_HASH = '5cab66e2a938c41e14b76e4c9c76183b4a1160cb9bd751506c0aae1b00f49bf1'

/** 校验夹具未被漂移；返回 {ok, expected, actual}。 */
export function assertFixtureHash() {
  const actual = fixtureHash()
  return { ok: actual === FIXTURE_HASH, expected: FIXTURE_HASH, actual }
}

/** 夹具内容规范性检查：保证跨平台字节一致。 */
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
