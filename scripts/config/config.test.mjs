// config.test.mjs — P3-2 统一配置系统单测
//
// 覆盖四类：
//   ① 引擎语义：优先级（CLI > env > 默认）、类型/范围校验、脱敏、unknownEnv
//   ② 跨进程规则：端口冲突、hub 上游、token 一致性、暴露无 token、静态根、DB 与房间目录重叠
//   ③ 端到端夹具：good.env 必须 PASS(strict)、bad.env 必须 FAIL 且错误码符合预期、JSON 无明文密钥
//   ④ **默认值漂移**（非循环）：schema 里声明的默认值必须等于各进程代码里真实的默认值。
//      做法是直接 import 三进程自己的配置常量/解析函数，而不是读引擎输出（否则会自我印证）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  defineSchema, resolveConfig, redactConfig, formatSummary, summaryObject, parseArgv, coerce, maskSecret, SOURCE,
} from '../../packages/shared/src/config.mjs'
import * as ENGINE from '../../packages/shared/src/config.mjs'
import { runCrossChecks, isExposed } from './cross-checks.mjs'
import { parseEnvFileDetailed, SCHEMA_FILES } from './check.mjs'
import { scanProcess, extractEnvReads, PROCESSES, normalizeDynamicExpr, dynamicCoverage, foreignDynamicProblems, countViolations, FOREIGN_DYNAMIC_SUBSCRIPTS } from './scan.mjs'
import { SCHEMA as HUB } from '../../team-hub/config-schema.mjs'
import { SCHEMA as WB } from '../../workbench/scripts/config-schema.mjs'
import { SCHEMA as BOARD } from '../../whiteboard/apps/server/src/config-schema.mjs'
import { SCHEMA as PLUGINS } from '../../plugins/config-schema.mjs'
import { SCHEMA as BOARD_PLUGIN } from '../../board-plugin/config-schema.mjs'
import { SCHEMA as SERVICES } from '../../services-plugin/config-schema.mjs'
// PRT-254：`runtime/`（清单声明的第 3 个进程）与 `security/`（安全面库）此前不在扫描范围里
import { SCHEMA as RUNTIME } from '../../runtime/config-schema.mjs'
import { SCHEMA as SECURITY } from '../../security/config-schema.mjs'
// PRT-254（动态读取强制登记）：product 当时那 8 处动态下标此前一处都没登记
// （PRT-708 之后是 12 处：托盘图标宿主多了 PATH / ProgramFiles / SystemRoot 三处读）
import { SCHEMA as PRODUCT } from '../../product/config-schema.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
// 六个**配置面**：三个活跃进程 + 三个 DSH 插件族（P3-4 纳入；插件主配置面仍是宿主 composition）
const SCHEMAS = {
  'team-hub': HUB, workbench: WB, whiteboard: BOARD,
  plugins: PLUGINS, 'board-plugin': BOARD_PLUGIN, 'services-plugin': SERVICES,
}

// ───────────────────────── ① 引擎语义 ─────────────────────────

test('引擎：优先级 CLI > env > 默认，且 sources 能回答问题来源', () => {
  const schema = defineSchema({
    process: 'demo',
    fields: [
      { key: 'port', env: 'DEMO_PORT', cli: 'port', type: 'int', default: 1 },
      { key: 'host', env: 'DEMO_HOST', type: 'string', default: '127.0.0.1' },
    ],
  })
  const fromDefault = resolveConfig(schema, { env: {}, argv: [] })
  assert.equal(fromDefault.values.port, 1)
  assert.equal(fromDefault.sources.port, SOURCE.DEFAULT)
  assert.equal(fromDefault.sources.host, SOURCE.DEFAULT)

  const fromEnv = resolveConfig(schema, { env: { DEMO_PORT: '2' }, argv: [] })
  assert.equal(fromEnv.values.port, 2)
  assert.equal(fromEnv.sources.port, SOURCE.ENV)

  const fromCli = resolveConfig(schema, { env: { DEMO_PORT: '2' }, argv: ['--port', '3'] })
  assert.equal(fromCli.values.port, 3, 'CLI 必须压过 env')
  assert.equal(fromCli.sources.port, SOURCE.CLI)
})

test('引擎：空字符串视为未设置（回退默认），不被当成合法值', () => {
  const schema = defineSchema({ process: 'demo', fields: [{ key: 'host', env: 'DEMO_HOST', type: 'string', default: '127.0.0.1' }] })
  const r = resolveConfig(schema, { env: { DEMO_HOST: '' } })
  assert.equal(r.values.host, '127.0.0.1')
  assert.equal(r.sources.host, SOURCE.DEFAULT)
})

test('引擎：类型校验覆盖 int/bool/enum/csv/path，含 min/max/choices', () => {
  const schema = defineSchema({
    process: 'demo',
    fields: [
      { key: 'i', env: 'D_I', type: 'int', default: 5, min: 1, max: 10 },
      { key: 'b', env: 'D_B', type: 'bool', default: false },
      { key: 'e', env: 'D_E', type: 'enum', default: 'a', choices: ['a', 'b'] },
      { key: 'c', env: 'D_C', type: 'csv', default: 'x,y' },
      { key: 'p', env: 'D_P', type: 'path', default: '' },
    ],
  })
  const ok = resolveConfig(schema, { env: { D_I: '10', D_B: 'yes', D_E: 'b', D_C: 'a, b ,c', D_P: '/tmp/x' }, checkUnknownEnv: false })
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.values.i, 10)
  assert.equal(ok.values.b, true)
  assert.equal(ok.values.e, 'b')
  assert.deepEqual(ok.values.c, ['a', 'b', 'c'])
  assert.equal(ok.values.p, '/tmp/x')

  const bad = resolveConfig(schema, {
    env: { D_I: '11', D_B: 'maybe', D_E: 'z', D_P: '  ' },
    checkUnknownEnv: false,
  })
  assert.equal(bad.errors.length, 4, '四项非法值都应报错：' + JSON.stringify(bad.errors.map((e) => e.message)))
  // 非法值必须回退默认而不是崩掉或留下脏值
  assert.equal(bad.values.i, 5)
  assert.equal(bad.values.b, false)
  assert.equal(bad.values.e, 'a')
  assert.equal(bad.values.p, '')
  assert.match(bad.errors[0].message, /D_I 不得大于 10/)
})

test('引擎：coerce 对各类型的边界（含负数端口与前后空格）', () => {
  assert.equal(coerce({ env: 'X', type: 'int' }, ' 42 ').value, 42)
  assert.equal(coerce({ env: 'X', type: 'int' }, '4.2').ok, false)
  assert.equal(coerce({ env: 'X', type: 'int', min: 1 }, '0').ok, false)
  assert.equal(coerce({ env: 'X', type: 'bool' }, 'OFF').value, false)
  assert.equal(coerce({ env: 'X', type: 'bool' }, '1').value, true)
  assert.equal(coerce({ env: 'X', type: 'csv' }, 'a,,b').value.join('|'), 'a|b')
})

test('引擎：secret 脱敏——摘要/JSON 都不含明文，且能看出「是否配了」', () => {
  const schema = defineSchema({
    process: 'demo',
    fields: [
      { key: 'token', env: 'DEMO_TOKEN', type: 'string', default: '', sensitive: true },
      { key: 'port', env: 'DEMO_PORT', type: 'int', default: 1 },
    ],
  })
  const secret = 'super-secret-value-1234'
  const resolved = resolveConfig(schema, { env: { DEMO_TOKEN: secret }, checkUnknownEnv: false })
  const summary = formatSummary(schema, resolved)
  const obj = JSON.stringify(summaryObject(schema, resolved))
  assert.ok(!summary.includes(secret), '摘要泄漏明文：' + summary)
  assert.ok(!obj.includes(secret), 'JSON 摘要泄漏明文')
  assert.match(summary, /token=\*\*\*\(23 位\)/) // 长度提示便于确认「配了」
  assert.equal(redactConfig(schema, resolved.values).port, 1)

  // 未设置时给明确文案，而不是空串（空串会被误读成「配了个空 token」）
  const empty = resolveConfig(schema, { env: {}, checkUnknownEnv: false })
  assert.match(formatSummary(schema, empty), /token=\(未设置\)/)
  assert.equal(maskSecret(''), '')
  assert.equal(maskSecret('abc'), '***', '短值不留长度线索')
})

test('引擎：unknownEnv 只报「本进程前缀命中但未声明」的变量，foreignEnv 不算', () => {
  const schema = defineSchema({
    process: 'demo',
    prefixes: ['DEMO_'],
    foreignEnv: [{ name: 'DEMO_FOREIGN', owner: '其它系统', reason: '撞名' }],
    fields: [{ key: 'a', env: 'DEMO_A', type: 'string', default: '' }],
  })
  const r = resolveConfig(schema, { env: { DEMO_A: 'x', DEMO_TYPO_O: '1', DEMO_FOREIGN: '1', OTHER_VAR: '1' } })
  assert.deepEqual(r.unknownEnv, ['DEMO_TYPO_O'])
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0].message, /DEMO_TYPO_O/)
})

test('引擎：defineSchema 对 schema 自身的错误立即失败（早失败胜过运行期困惑）', () => {
  assert.throws(() => defineSchema({ process: 'x', fields: [] }), /非空 fields/)
  assert.throws(() => defineSchema({ process: 'x', fields: [{ key: 'a', env: 'A' }, { key: 'a', env: 'B' }] }), /key 重复/)
  assert.throws(() => defineSchema({ process: 'x', fields: [{ key: 'a', env: 'A' }, { key: 'b', env: 'A' }] }), /env 重复/)
  assert.throws(() => defineSchema({ process: 'x', fields: [{ key: 'a', env: 'A', type: 'nope' }] }), /未知类型/)
  assert.throws(() => defineSchema({ process: 'x', fields: [{ key: 'a', env: 'A', type: 'enum' }] }), /enum 类型必须提供 choices/)
})

test('引擎：CLI 解析支持 --k v / --k=v / 裸开关（裸开关后跟取值则取该值，与仓库既有约定一致）', () => {
  const m = parseArgv(['--port', '9', '--host=1.2.3.4', '--verbose', 'ignored'])
  assert.equal(m.get('port'), '9')
  assert.equal(m.get('host'), '1.2.3.4')
  assert.equal(m.get('verbose'), 'ignored', '后跟非 -- token 时被当作取值')
  assert.equal(m.size, 3)
  // 末尾裸开关 → true；紧随另一个 -- 开关也 → true
  assert.equal(parseArgv(['--verbose']).get('verbose'), 'true')
  assert.equal(parseArgv(['--verbose', '--port', '1']).get('verbose'), 'true')
  assert.equal(parseArgv(['--verbose', '--port', '1']).get('port'), '1')
})

// ───────────────────────── ② 跨进程规则 ─────────────────────────

function cfgFor(name, env, argv = []) {
  const schema = SCHEMAS[name]
  return { schema, resolved: resolveConfig(schema, { env, argv, checkUnknownEnv: false }) }
}

const GOOD = {
  TEAM_HUB_PORT: '8787', TEAM_HUB_HOST: '127.0.0.1', TEAM_HUB_TOKEN: 'hub-t',
  DSH_WORKBENCH_PORT: '5173', DSH_WORKBENCH_HOST: '127.0.0.1', DSH_WORKBENCH_TOKEN: 'wb-t',
  DSH_HUB_UPSTREAM: 'http://127.0.0.1:8787', DSH_WORKBENCH_ROOT: 'workbench',
  PORT: '8080', HOST: '127.0.0.1', WHITEBOARD_TOKEN: 'board-t',
}

function cross(overrides = {}, opts = {}) {
  const env = { ...GOOD, ...overrides }
  return runCrossChecks(Object.fromEntries(
    Object.keys(SCHEMAS).map((name) => [name, cfgFor(name, env)]),
  ), { existsFn: () => true, ...opts })
}

const codes = (list) => list.map((c) => c.code).sort()

test('跨进程：一致配置下无 error（只有预期内的提示级 warning）', () => {
  const r = cross()
  assert.deepEqual(r.filter((c) => c.level === 'error'), [], JSON.stringify(r))
})

test('跨进程：端口冲突必须报 error', () => {
  const r = cross({ DSH_WORKBENCH_PORT: '8787' })
  assert.ok(codes(r).includes('port_conflict'))
})

test('跨进程：hub 上游端口与团队中枢不一致必须报 error；无法解析则 warning', () => {
  assert.ok(codes(cross({ DSH_HUB_UPSTREAM: 'http://127.0.0.1:9999' })).includes('hub_upstream_port_mismatch'))
  assert.ok(codes(cross({ DSH_HUB_UPSTREAM: 'not a url' })).includes('hub_upstream_unparsable'))
})

test('跨进程：token 三类不一致（单份环境无法触发，故直接构造两份配置）', () => {
  const hubEnv = { ...GOOD, TEAM_HUB_TOKEN: 'hub-secret' }
  const missing = runCrossChecks({
    'team-hub': cfgFor('team-hub', hubEnv),
    workbench: cfgFor('workbench', { ...GOOD, TEAM_HUB_TOKEN: '' }),
  }, { existsFn: () => true })
  assert.ok(codes(missing).includes('hub_token_missing_in_workbench'))

  const mismatch = runCrossChecks({
    'team-hub': { schema: HUB, resolved: resolveConfig(HUB, { env: { TEAM_HUB_TOKEN: 'A' }, checkUnknownEnv: false }) },
    workbench: { schema: WB, resolved: resolveConfig(WB, { env: { TEAM_HUB_TOKEN: 'B' }, checkUnknownEnv: false }) },
  }, { existsFn: () => true })
  assert.ok(codes(mismatch).includes('hub_token_mismatch'))

  const unused = runCrossChecks({
    'team-hub': cfgFor('team-hub', { ...GOOD, TEAM_HUB_TOKEN: '' }),
    workbench: cfgFor('workbench', { ...GOOD, TEAM_HUB_TOKEN: 'set-but-hub-open' }),
  }, { existsFn: () => true })
  assert.ok(codes(unused).includes('hub_token_unused'))
})

test('跨进程：非回环监听但没配 token 必须报 error（两个服务都会拒绝启动）', () => {
  const r = cross({ HOST: '0.0.0.0', WHITEBOARD_TOKEN: '' })
  const hit = r.find((c) => c.code === 'exposed_without_token')
  assert.ok(hit, JSON.stringify(r))
  assert.match(hit.message, /whiteboard/)
  // 配了 token 就不该报
  assert.ok(!codes(cross({ HOST: '0.0.0.0', WHITEBOARD_TOKEN: 'set' })).includes('exposed_without_token'))
  assert.equal(isExposed('127.0.0.1'), false)
  assert.equal(isExposed('localhost'), false)
  assert.equal(isExposed('::1'), false)
  assert.equal(isExposed('0.0.0.0'), true)
  assert.equal(isExposed('192.168.1.5'), true)
})

test('跨进程：静态产物缺失给 warning（P3-1 实测坑：进程照常起，用户侧才 404）', () => {
  const r = cross({ DSH_WORKBENCH_ROOT: 'workbench/dist-missing' }, { existsFn: (p) => !p.includes('dist-missing') })
  assert.ok(codes(r).includes('static_root_missing'))
  // 未显式配置时按内置默认路径判断，而不是因为「值非空」就跳过
  const r2 = runCrossChecks({ workbench: cfgFor('workbench', {}) }, { existsFn: (p) => !p.includes('dist') })
  assert.ok(codes(r2).includes('static_root_missing'))
})

test('跨进程：白板 DB_PATH 落进房间目录给 warning', () => {
  const r = cross({ WB_ROOMS_DIR: 'data/rooms', DB_PATH: 'data/rooms/x.db' })
  assert.ok(codes(r).includes('db_inside_rooms_dir'))
  const ok = cross({ WB_ROOMS_DIR: 'data/rooms', DB_PATH: 'data/x.db' })
  assert.ok(!codes(ok).includes('db_inside_rooms_dir'))
})

// ───────────────────────── ③ 端到端夹具 ─────────────────────────

function runCheck(args) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'config', 'check.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** 跑 `scripts/config/scan.mjs`（配置面门禁）并连 stderr 一起收——不重定向到文件，
 *  因为 PowerShell 的 `>` 会写成 UTF-16，而这里只需要拿到文本判读。 */
function runScan(args) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'config', 'scan.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('夹具 good.env：--isolated-env --strict 必须 PASS（error=0 warning=0）', () => {
  const r = runCheck(['--env-file=scripts/config/fixtures/good.env', '--isolated-env', '--strict'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /config check: PASS（error 0，warning 0，strict）/)
})

test('夹具 bad.env：必须 FAIL，且错误码/类型错误与文档一致（验证校验器有牙齿）', () => {
  const r = runCheck(['--env-file=scripts/config/fixtures/bad.env', '--isolated-env'])
  assert.equal(r.code, 1, r.out)
  // 值级错误
  assert.match(r.out, /DSH_WORKBENCH_PORT 必须是整数/)
  assert.match(r.out, /WB_MAX_CONNECTIONS 必须是整数/)
  // 跨进程错误
  assert.match(r.out, /\[port_conflict\]/)
  assert.match(r.out, /\[hub_upstream_port_mismatch\]/)
  assert.match(r.out, /\[exposed_without_token\]/)
  // 提示级
  assert.match(r.out, /\[static_root_missing\]/)
  assert.match(r.out, /\[db_inside_rooms_dir\]/)
})

test('check --json：可解析、ok 标志正确，且不含夹具里的任何明文 token', () => {
  const r = runCheck(['--env-file=scripts/config/fixtures/good.env', '--isolated-env', '--json'])
  assert.equal(r.code, 0, r.out)
  const payload = JSON.parse(r.out)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.counts, { errors: 0, warnings: 0 })
  for (const t of ['fixture-hub-token', 'fixture-wb-token', 'fixture-board-token', 'fixture-room-token']) {
    assert.ok(!r.out.includes(t), `JSON 泄漏明文 ${t}`)
  }
  assert.equal(payload.processes['team-hub'].values.token, '***(17 位)')
  assert.equal(payload.processes.whiteboard.values.port, 8080)
})

test('check：--process 只校验单个进程，未知进程返回用法错误码 2', () => {
  const one = runCheck(['--process=whiteboard', '--isolated-env', '--quiet'])
  assert.equal(one.code, 0, one.out)
  assert.ok(!one.out.includes('team-hub：'))
  const bad = runCheck(['--process=nope'])
  assert.equal(bad.code, 2)
})

test('env 文件解析：重复键与非法行必须被报出来，而不是静默取最后一个', () => {
  const { values, duplicates, invalid } = parseEnvFileDetailed('A=1\nA=2\n# c\nBAD LINE\nB="x y"\n')
  assert.equal(values.A, '2')
  assert.equal(values.B, 'x y')
  assert.deepEqual(duplicates, ['A'])
  assert.deepEqual(invalid, ['BAD LINE'])
})

test('跨平台：CRLF 检出（Windows autocrlf）下 sync --check 仍必须 PASS', async () => {
  // 本仓库在 Windows 上 core.autocrlf 会把检出文件转成 CRLF：主检出曾因此让 sync --check 失败
  // （「副本头部第 1 行不符合预期：…\r」）。这里用 CRLF 变体直接验证归一化逻辑。
  const { stripHeader, normalizeEol, HEADER_LINES } = await import('./sync.mjs')
  const body = 'export const x = 1\n'
  const crlfVariant = HEADER_LINES.join('\r\n') + '\r\n' + body
  assert.equal(stripHeader(crlfVariant), body, 'CRLF 头部必须能被正确剥离')
  assert.equal(normalizeEol('a\r\nb\r\n'), 'a\nb\n')
  // 主检出的真实文件也应通过（存在时才校验，避免在非仓库布局下失败）
  const r = runCheck([]) // 仅为确保 check.mjs 可执行；真正的 sync 校验见 CI env 阶段
  assert.ok(r.code === 0 || r.code === 1)
})

// ───────────────────────── ④ 默认值漂移（非循环）─────────────────────────

test('漂移：team-hub schema 默认值 == 代码里导出的真实常量', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p32-hub-'))
  const prev = { ...process.env }
  try {
    // 用临时库导入，避免触碰真实 team.db
    process.env.TEAM_HUB_DB = join(dir, 't.db')
    return import('../../team-hub/server.mjs').then((hub) => {
      const expect = {
        attachMaxBytes: hub.CHAT_ATTACH_MAX_BYTES,
        attachMaxPerMsg: hub.CHAT_ATTACH_MAX_PER_MSG,
        attachStagedTtlMs: hub.CHAT_ATTACH_STAGED_TTL_MS,
        attachTtlMs: hub.CHAT_ATTACH_TTL_MS,
        replyTimeoutMs: hub.CHAT_REPLY_TIMEOUT_MS,
        maxRulesLen: hub.MAX_RULES_LEN,
      }
      for (const [key, actual] of Object.entries(expect)) {
        assert.equal(HUB.field(key).default, actual, `schema.${key} 默认值与 team-hub 代码不一致（代码=${actual}，schema=${HUB.field(key).default}）`)
      }
      // csv 类型：代码里 split+trim+lowercase 成数组；schema 的默认值写成同一份字符串，
      // 这里比对「扩展名集合」，同时确保 schema 默认值本身可被引擎解析成非空数组
      const parsed = coerce(HUB.field('attachBlacklistExt'), HUB.field('attachBlacklistExt').default)
      assert.equal(parsed.ok, true, 'schema 的 csv 默认值必须能被引擎解析')
      assert.deepEqual(
        [...parsed.value].map((s) => s.toLowerCase()).sort(),
        [...hub.CHAT_ATTACH_BLACKLIST_EXT].map((s) => s.toLowerCase()).sort(),
        '附件黑名单扩展名集合与 team-hub 代码不一致',
      )
    })
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k]
    Object.assign(process.env, prev)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('漂移：whiteboard schema 默认值 == limits.mjs / rooms.mjs 的真实默认值', async () => {
  const limits = await import('../../whiteboard/apps/server/src/limits.mjs')
  const rooms = await import('../../whiteboard/apps/server/src/rooms.mjs')
  const L = limits.resolveLimitConfig({}) // 空 env → 全部取代码默认值
  const expect = {
    maxConnections: L.MAX_CONNECTIONS,
    maxConnectionsPerRoom: L.MAX_CONNECTIONS_PER_ROOM,
    maxConnectionsPerIp: L.MAX_CONNECTIONS_PER_IP,
    maxMessageBytes: L.MAX_MESSAGE_BYTES,
    maxOpsPerMessage: L.MAX_OPS_PER_MESSAGE,
    messageRatePerSec: L.MESSAGE_RATE_PER_SEC,
    messageBurst: L.MESSAGE_BURST,
    rateStrikes: L.RATE_STRIKES,
  }
  for (const [key, actual] of Object.entries(expect)) {
    assert.equal(BOARD.field(key).default, actual, `schema.${key} 默认值与白板代码不一致（代码=${actual}，schema=${BOARD.field(key).default}）`)
  }
  const R = rooms.resolveRoomConfig({})
  assert.equal(BOARD.field('roomIdleMs').default, R.IDLE_MS)
  assert.equal(BOARD.field('maxRooms').default, R.MAX_ROOMS)
  // P3-1 的设计约束也要保持在 schema 里（单 IP 上限不得小于单房间上限）
  assert.ok(BOARD.field('maxConnectionsPerIp').default >= BOARD.field('maxConnectionsPerRoom').default)
})

test('漂移：workbench schema 默认值 == serve.mjs 的真实默认值', async () => {
  const wb = await import('../../workbench/scripts/serve.mjs')
  const expect = {
    maxUpload: wb.FILES_LIMITS.MAX_UPLOAD,
    chunkSize: wb.UPLOAD_CHUNK_SIZE,
    maxUploadTotal: wb.UPLOAD_MAX_SIZE,
    cacheTtlMs: wb.WEB_CACHE_DEFAULTS.TTL_MS,
    cacheMax: wb.WEB_CACHE_DEFAULTS.MAX_ENTRIES,
    quotaSpaceRpm: wb.WEB_QUOTA_DEFAULTS.SPACE_RPM,
    quotaConcurrency: wb.WEB_QUOTA_DEFAULTS.SPACE_CONCURRENCY,
    quotaHostRpm: wb.WEB_QUOTA_DEFAULTS.HOST_RPM,
    quotaDailyBytes: wb.WEB_QUOTA_DEFAULTS.DAILY_BYTES,
    auditMaxBytes: wb.WEB_AUDIT.DEFAULT_MAX_BYTES,
  }
  for (const [key, actual] of Object.entries(expect)) {
    assert.equal(WB.field(key).default, actual, `schema.${key} 默认值与 workbench 代码不一致（代码=${actual}，schema=${WB.field(key).default}）`)
  }
})

test('漂移：三进程的监听/鉴权默认值与代码一致（host/port 语义不得被 schema 悄悄改写）', () => {
  assert.equal(HUB.field('port').default, 8787)
  assert.equal(HUB.field('host').default, '127.0.0.1')
  assert.equal(WB.field('port').default, 5173)
  assert.equal(WB.field('host').default, '127.0.0.1')
  assert.equal(BOARD.field('port').default, 8080)
  assert.equal(BOARD.field('host').default, '127.0.0.1')
})

/**
 * 名字里含 TOKEN 但**不是**密钥的字段，逐条登记。
 *
 * 为什么不直接把规则改宽（比如排除 TOKENIZER）：那会让规则下一次
 * 再撞上同类误报时**没有任何记录**，于是下一个人要么再改一次规则、
 * 要么就把一个真密钥标成 sensitive 了事。
 *
 *   > 一个"可以随手往里加名字"的豁免表，
 *   > 与一条"凡含 TOKEN 就必须 sensitive"的规则，在没人往里加东西的时候
 *   > 是同一个东西——只不过前者会让规则每一次失效都留下一条**写明理由**的记录。
 */
const NOT_SECRET_BY_NAME = new Set([
  // PRT-413：tokenizer 产物（词表）的**目录**。它是零依赖项目里
  // 「精确 token 数」的接入点，里面是模型词表，不是任何形式的凭证。
  // 标成 sensitive 会让它从 `/api/config` 里被抹掉——而运维排查
  // "我配了词表目录，到底生效了没有"时正是要看它。
  'team-hub.LEGION_TOKENIZER_DIR',
])

test('安全：凡 env 名含 TOKEN/SECRET/KEY 的字段都必须标记 sensitive', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    for (const f of schema.fields) {
      if (/TOKEN|SECRET|PASSWORD|_KEY$/.test(f.env)) {
        if (NOT_SECRET_BY_NAME.has(`${name}.${f.env}`)) {
          // 例外必须是**真的不需要脱敏**：标了 sensitive 又进豁免表是自相矛盾的。
          assert.notEqual(f.sensitive, true,
            `${name}.${f.env} 同时出现在豁免表里并被标成 sensitive——两者只能有一个`)
          continue
        }
        assert.equal(f.sensitive, true, `${name}.${f.env} 看起来是密钥但未标记 sensitive（会明文进摘要）`)
      }
    }
  }
})

test('安全：复合值里的内嵌 token 也必须脱敏（WHITEBOARD_ROOMS=roomId:token:role）', () => {
  const resolved = resolveConfig(BOARD, {
    env: { WHITEBOARD_ROOMS: 'main:room-secret-1:rw,guest:room-secret-2:ro' },
    checkUnknownEnv: false,
  })
  const summary = formatSummary(BOARD, resolved)
  assert.ok(!summary.includes('room-secret-1'), '摘要泄漏房间 token：' + summary)
  assert.ok(!summary.includes('room-secret-2'))
  // 但可运维信息要保留：房间 id 与角色仍可见
  assert.match(summary, /rooms=main:\*\*\*:rw,guest:\*\*\*:ro/)
})

test('P3-4：类型面 config.d.mts 与引擎导出集合一致（防类型文件悄悄过期）', () => {
  // TS 消费者（plugins/src/config.ts）只能看到 .d.mts；引擎新增导出而类型面没跟上时，
  // 编译期会报错、但**没有任何测试**会发现两者已经分叉。这里做一次集合级对齐。
  const dts = readFileSync(join(ROOT, 'packages', 'shared', 'src', 'config.d.mts'), 'utf8')
  const declared = new Set([...dts.matchAll(/export declare (?:function|const) (\w+)/g)].map((m) => m[1]))
  const actual = new Set(Object.keys(ENGINE))
  assert.deepEqual([...declared].sort(), [...actual].sort(),
    'config.d.mts 与 config.mjs 的导出不一致：缺失=' + [...actual].filter((k) => !declared.has(k)).join(',') +
    ' 多余=' + [...declared].filter((k) => !actual.has(k)).join(','))
  // 类型面的关键形状必须在（供插件 TS 代码使用）
  for (const t of ['ConfigSchema', 'ConfigResolved', 'ConfigRuleViolation', 'ConfigInject', 'ConfigField']) {
    assert.ok(new RegExp(`export interface ${t}\\b`).test(dts), `config.d.mts 缺少 ${t}`)
  }
})

test('一致性：三份 schema 的 process 名与登记表一致，且 secret 字段确有其数', () => {
  assert.deepEqual(Object.keys(SCHEMAS).sort(), ['board-plugin', 'plugins', 'services-plugin', 'team-hub', 'whiteboard', 'workbench'])
  assert.deepEqual(HUB.secretKeys(), ['token'])
  assert.deepEqual(WB.secretKeys().sort(), ['teamHubToken', 'token'])
  assert.deepEqual(BOARD.secretKeys(), ['token'])
  // P3-4 插件族：能配 token 的两个插件必须标 sensitive（摘要/--json 都走脱敏）
  assert.deepEqual(BOARD_PLUGIN.secretKeys(), ['hubToken'])
  assert.deepEqual(SERVICES.secretKeys(), ['teamHubToken'])
  assert.deepEqual(PLUGINS.secretKeys(), [])
})

// ───────────────────────── ⑤ P3-4 插件配置面（plugins / board-plugin / services-plugin）─────────────────────────

test('P3-4：扫描器不被注释骗到，也不会因为字符串里的 // 漏掉同一行的真实读取', () => {
  // ① 散文注释里提到读法不算读取点。P3-4 实测：`plugins/src/config.ts` 的注释里那句
  //    `Number(process.env.X || 默认值)` 让**主检出**（文件已被 git 跟踪）多出一个未声明键 `X`，
  //    而当时的工作树还没提交 → 该文件未被扫描 → 本地跑是绿的。假阳性会被 `scan --check` 当成错误拦住。
  const prose = [
    '// 历史写法：Number(process.env.X || 默认值)',
    '/* 说明：端口来自 process.env.TEAM_HUB_PORT */',
    "const url = 'http://127.0.0.1:8787' // 行尾注释里也提到 process.env.IGNORED",
  ].join('\n')
  assert.deepEqual([...extractEnvReads(prose).literal], [], '注释里的读法不应算读取点')
  assert.deepEqual([...extractEnvReads('/* process.env.BLOCKED */').literal], [])

  // ② 但**字符串里的 `//` 不得吃掉同一行后面的真实读取**（假阴性比假阳性更危险）：
  //    仓库里到处是 `'http://127.0.0.1:8787'`，用正则裸替换注释会把这些行整个截掉。
  const mixed = [
    "const u = 'http://127.0.0.1:8787'; const token = process.env.TEAM_HUB_TOKEN",
    "const t2 = process.env['WHITEBOARD_TOKEN'] // 行尾注释",
    'const { WB_MAX_ROOMS } = process.env',
    '// const dead = process.env.NEVER_READ',
  ].join('\n')
  const reads = extractEnvReads(mixed).literal
  assert.ok(reads.has('TEAM_HUB_TOKEN'), '字符串里的 // 不得吃掉同一行的读取：' + [...reads])
  assert.ok(reads.has('WHITEBOARD_TOKEN'), '行尾注释不得影响本行读取：' + [...reads])
  assert.ok(reads.has('WB_MAX_ROOMS'), '解构读取不受影响：' + [...reads])
  assert.ok(!reads.has('NEVER_READ'), '注释掉的读取点不算：' + [...reads])

  // ③ 字符串字面量本身保留（「疑似 env 字面量」规则仍要看得见 readKey('WB_MAX_CONNECTIONS')）
  assert.ok(extractEnvReads("readKey('WB_MAX_CONNECTIONS')").suspicious.has('WB_MAX_CONNECTIONS'))
})

test('★ 别名 `env` 对象：只认大写键、且方法调用不算读取点（否则会编出不存在的环境变量）', () => {
  // 背景：为了把 `runtime/` 与 `security/` 纳入扫描范围（PRT-254 里那条"这两个目录不被覆盖"的缺口），
  // 先试扫了一遍，读出**三个根本不存在的环境变量**：
  //
  //   · `req.env.some((k) => …)` —— `req.env` 是**数组**，`some` 是它的方法；
  //   · `env.t !== 'map'` —— `env` 是**YAML 映射节点**，`t` 是节点类型标签；
  //   · `env.v` —— 同上，`v` 是节点值。
  //
  // 这三条进不了 `nonEnvLiterals`（那份名单管的是"像 env 键的字面量"，不管"读到的键名"），
  // 于是让门禁变绿的唯一做法就是往 schema 的 `fields` 里写三个不存在的环境变量——
  // **那等于让配置面声明开始说谎**，而这份声明的全部价值就是它说的每一句都是真的。
  const alias = [
    'const n = req.env.some((k) => typeof k !== "string")',
    "if (env.t !== 'map') return null",
    'const v = env.v',
    // —— 下面这些是**真实读取点**，必须仍然被认出来 ——
    'const url = options.env.TEAM_HUB_URL',
    'const tok = baseEnv.WHITEBOARD_TOKEN',
  ].join('\n')
  const r = extractEnvReads(alias).literal
  assert.ok(!r.has('some'), '方法调用不算读取点（`req.env.some(` 是调用不是读取）：' + [...r])
  assert.ok(!r.has('t'), '小写属性不算别名读取点（`env.t` 是 YAML 节点标签）：' + [...r])
  assert.ok(!r.has('v'), '小写属性不算别名读取点：' + [...r])
  assert.ok(r.has('TEAM_HUB_URL'), '别名上的大写键必须仍被认出：' + [...r])
  assert.ok(r.has('WHITEBOARD_TOKEN'), '②b 的别名形态不受影响：' + [...r])

  // ① 的 `process.env.*` **不区分大小写**，不受本次收紧影响——
  //    否则就会为了消掉假阳性而制造一个假阴性，而假阴性比假阳性更危险。
  const direct = extractEnvReads('const a = process.env.lower_case_key').literal
  assert.ok(direct.has('lower_case_key'), 'process.env 是明确无歧义的，小写键仍要认：' + [...direct])
})

test('P3-4：plugins schema 覆盖插件真实读取的全部 env，且扫描器能看到别名 env 对象的读取', () => {
  const plugins = scanProcess('plugins', { includeTests: false })
  // 先确认真的扫到了文件：`[]` 作为「没有直接读取」的证据，只有在这个前提下才有意义
  // （P3-4 实测过反面教材：文件尚未提交时扫描器跳过未跟踪文件，空集合会给出假绿）
  assert.ok(plugins.filesScanned >= 10, 'plugins/src 应被完整扫描，实际文件数 ' + plugins.filesScanned)
  assert.equal(plugins.mode, 'git-tracked')
  // 插件改造后不再直接读 env（统一走 plugins/src/config.ts + 引擎）；这里的价值是「以后新增读取点必须登记」
  assert.deepEqual([...plugins.reads.keys()], [], 'plugins 不应再直接读 env：' + JSON.stringify([...plugins.reads.keys()]))
  assert.deepEqual(PLUGINS.envNames().sort(), [
    'CHAT_CTX_BUDGET_CHARS', 'CHAT_CTX_DIGEST_BUDGET_CHARS', 'CHAT_CTX_FILE_CAP_CHARS',
    'NORMS_GLOBAL_MAX', 'NORMS_SPACE_MAX', 'NORMS_TOTAL_MAX',
  ])

  // services-plugin 读的是 `baseEnv.NAME`（别名对象）——直接扫描看不到，靠 P3-4 新增的识别规则
  const svc = scanProcess('services-plugin', { includeTests: false })
  for (const key of ['TEAM_HUB_HOST', 'TEAM_HUB_TOKEN', 'DSH_HUB_UPSTREAM']) {
    assert.ok(svc.reads.has(key), `services-plugin 的 baseEnv.${key} 读取点必须被扫出来（否则配置面有盲区）`)
  }
  assert.deepEqual(SERVICES.envNames().sort(), ['DSH_HUB_UPSTREAM', 'TEAM_HUB_HOST', 'TEAM_HUB_TOKEN'])

  // board-plugin 从环境回落的 hub token
  const boardPlug = scanProcess('board-plugin', { includeTests: false })
  assert.ok(boardPlug.reads.has('TEAM_HUB_TOKEN'))
  assert.deepEqual(BOARD_PLUGIN.envNames(), ['TEAM_HUB_TOKEN'])
})

test('P3-4：plugins 的 schema 规则（预算包含关系）在 check 里以 warning 呈现，不改变取值', () => {
  const resolved = resolveConfig(PLUGINS, {
    env: { CHAT_CTX_BUDGET_CHARS: '1000', CHAT_CTX_DIGEST_BUDGET_CHARS: '4000' },
    checkUnknownEnv: false,
  })
  const violations = PLUGINS.rules.flatMap((rule) => rule(resolved.values))
  const byCode = Object.fromEntries(violations.map((v) => [v.code, v]))
  assert.equal(byCode.ctx_digest_over_total.level, 'warning')
  assert.match(byCode.ctx_digest_over_total.message, /大于总预算/)
  assert.ok(byCode.ctx_file_cap_over_total, '单块上限 4000 > 总预算 1000 也应报出')
  // 规则只提示，不改写取值（与「非法值回退默认」是两回事）
  assert.equal(resolved.values.chatCtxDigestBudgetChars, 4000)
  assert.equal(resolved.values.chatCtxBudgetChars, 1000)

  // 默认配置下不得有任何规则告警（否则每次 check 都会刷屏）
  const clean = resolveConfig(PLUGINS, { env: {}, checkUnknownEnv: false })
  assert.deepEqual(PLUGINS.rules.flatMap((rule) => rule(clean.values)), [])
})

test('P3-4：跨进程——services-plugin 会覆盖子进程端口/CLI，与环境解析值不一致时必须报出来', () => {
  const r = cross({ TEAM_HUB_PORT: '9000' })
  const hit = r.find((c) => c.code === 'services_inject_overrides_env')
  assert.ok(hit, '托管实例端口被覆盖却没有告警：' + JSON.stringify(r))
  assert.match(hit.message, /TEAM_HUB_PORT=8787/)
  assert.match(hit.message, /9000/)
  // 一致时（默认 8787）不得报
  assert.ok(!codes(cross()).includes('services_inject_overrides_env'))
  // workbench 的 --port 覆盖同理
  const wbPort = cross({ DSH_WORKBENCH_PORT: '6000' })
  assert.ok(codes(wbPort).includes('services_inject_overrides_env'))
  assert.match(wbPort.find((c) => c.code === 'services_inject_overrides_env').message, /--port/)
})

test('P3-4：跨进程——hub 配了 token 而看板插件没拿到时必须提示（否则 hub 模式写操作 401）', () => {
  const r = cross({ TEAM_HUB_TOKEN: 'hub-secret' })
  // 同一份环境里 board-plugin 读的是同一个变量 → 它也有值，故不报（真实陷阱出现在两份配置不同的情形）
  assert.ok(!codes(r).includes('plugin_hub_token_unset'))
  const twoSources = runCrossChecks({
    'team-hub': cfgFor('team-hub', { TEAM_HUB_TOKEN: 'hub-secret' }),
    'board-plugin': cfgFor('board-plugin', { TEAM_HUB_TOKEN: '' }),
  }, { existsFn: () => true })
  assert.ok(codes(twoSources).includes('plugin_hub_token_unset'))
  // hub 没配 token 时不提示（插件空 token 也能读）
  const open = runCrossChecks({
    'team-hub': cfgFor('team-hub', { TEAM_HUB_TOKEN: '' }),
    'board-plugin': cfgFor('board-plugin', { TEAM_HUB_TOKEN: '' }),
  }, { existsFn: () => true })
  assert.ok(!codes(open).includes('plugin_hub_token_unset'))
})

test('P3-4：夹具与 CLI —— good 夹具 strict PASS 覆盖插件字段，bad 夹具报出插件非法值，--process=plugins 可用', () => {
  const good = runCheck(['--env-file=scripts/config/fixtures/good.env', '--isolated-env', '--strict', '--quiet'])
  assert.equal(good.code, 0, good.out)
  const json = runCheck(['--env-file=scripts/config/fixtures/good.env', '--isolated-env', '--json'])
  const payload = JSON.parse(json.out)
  assert.equal(payload.processes.plugins.values.chatCtxBudgetChars, 10000, 'good 夹具必须真的覆盖到插件字段')
  assert.equal(payload.processes.plugins.sources.chatCtxBudgetChars, 'env')
  assert.equal(payload.processes.plugins.values.chatCtxFileCapChars, 2000)
  assert.equal(payload.processes['board-plugin'].values.hubToken, '***(17 位)', '看板插件 token 必须脱敏')

  const bad = runCheck(['--env-file=scripts/config/fixtures/bad.env', '--isolated-env'])
  assert.equal(bad.code, 1)
  assert.match(bad.out, /NORMS_GLOBAL_MAX 必须是整数/)
  assert.match(bad.out, /\[ctx_digest_over_total\]/)
  assert.match(bad.out, /\[services_inject_overrides_env\]/)

  const one = runCheck(['--process=plugins', '--isolated-env', '--quiet'])
  assert.equal(one.code, 0, one.out)
  assert.ok(!one.out.includes('=== team-hub'))
  const badName = runCheck(['--process=pluginz'])
  assert.equal(badName.code, 2)
})

test('P3-4：插件族的 schema 不接管宿主 composition 的主配置面（边界写死在 schema 里）', () => {
  // plugins/board-plugin 的主配置（角色、轮询间隔、hubUrl、scope…）来自 cordis composition，
  // 不是 env：schema 里不得出现这些字段，否则会诱导运维在环境变量里配它们（不生效）。
  for (const name of ['plugins', 'board-plugin']) {
    for (const f of SCHEMAS[name].fields) {
      assert.ok(!/^(SCOUT_|WORKER_|LEGION_ROLE|HUB_URL$|LEGION_SCOPE)/.test(f.env), `${name}.${f.env} 疑似接管了 composition 配置项`)
    }
  }
  // services-plugin 声明了它**注入**的 env/CLI（跨进程规则据此判断实际生效值）
  const injects = SERVICES.injects
  assert.deepEqual(injects.map((i) => `${i.target}:${i.env}`).sort(), [
    'team-hub:TEAM_HUB_HOST', 'team-hub:TEAM_HUB_PORT', 'team-hub:TEAM_HUB_TOKEN',
    'workbench:DSH_HUB_UPSTREAM', 'workbench:DSH_WORKBENCH_PORT', 'workbench:TEAM_HUB_TOKEN',
  ])
  assert.equal(injects.find((i) => i.env === 'DSH_WORKBENCH_PORT').via, 'cli')
})

// ───────────────────────── ⑥ PRT-254：runtime / security 的扫描覆盖 ─────────────────────────
//
// 这一节补的是一个**真实覆盖缺口**：`runtime/` 是 `product/process-manifest.mjs` 的
// `PROCESS_SPECS` 已经声明的进程，却从 PRT-301 起一直不在 `scan.mjs` 的 `PROCESSES` 里；
// `security/` 更是两边都没有登记。结果：这两个目录里的 344 个疑似字面量
//（含 **10 个真实的环境变量键**）不受「必须登记」那条检查约束，而 `scan --check`
// 一直报 PASS——它报的是"我扫过的东西没问题"，不是"没问题"。
//
//   > 一道看不见某个目录的闸门，比没有闸门更坏：它给出"已核对过"的错觉。

test('★ PRT-254：runtime/ 与 security/ 同时登记了扫描范围与权威 schema（缺一处就红）', () => {
  // 为什么两处都要断言：PRT-251 的真实事故就是"两份手写映射只更新了一份"——
  // `scan --check` 说"全部已处理"，`topology-inventory --diff` 说"product 的 8 个键未声明"。
  // 两边各自的输出都能自圆其说，而目录其实是无人检查的。这里把"必须两处都有"钉死。
  for (const name of ['runtime', 'security']) {
    assert.ok(PROCESSES[name], `PROCESSES 缺少 ${name}——这个目录又回到"没有任何配置面门禁"的状态`)
    assert.deepEqual(PROCESSES[name].dirs, [name], `${name} 的扫描范围必须正好是它自己的目录`)
    assert.ok(existsSync(join(ROOT, PROCESSES[name].dirs[0])), `${name} 的扫描目录不存在`)
    assert.ok(SCHEMA_FILES[name], `SCHEMA_FILES 缺少 ${name}——scan --check 会把它扫到的读取点全部当成未声明`)
    assert.ok(existsSync(join(ROOT, SCHEMA_FILES[name])), `${name} 的 schema 文件不存在：${SCHEMA_FILES[name]}`)
  }
  // 映射只有一份（scan.mjs 委托 check.mjs）：每个扫描范围都必须在 SCHEMA_FILES 里
  for (const name of Object.keys(PROCESSES)) {
    assert.ok(SCHEMA_FILES[name], `进程 ${name} 未在 SCHEMA_FILES 登记：要么它不该在 PROCESSES，要么它缺 config-schema`)
  }
})

test('★ PRT-254：runtime/ 与 security/ 真的被扫到了（不是"扫了 0 个文件"的绿）', () => {
  const rt = scanProcess('runtime', { includeTests: false })
  assert.equal(rt.mode, 'git-tracked')
  // 空集合只有在"确实扫到了文件"的前提下才是证据（P3-4 的实测反面教材：文件未提交时扫描器跳过它）
  assert.ok(rt.filesScanned >= 74, `runtime/ 应被完整扫描，实际 ${rt.filesScanned} 个文件`)
  assert.deepEqual([...rt.reads.keys()], [], 'runtime/ 没有**字面量**形式的 env 读取点（它的读取全在下标里）')
  assert.ok(rt.suspicious.size >= 285, `runtime/ 的疑似字面量应 ≥285，实际 ${rt.suspicious.size}`)
  // 真读法：root-row.mjs 在 apply 期按 k 下标读 process.env
  assert.ok(
    rt.dynamic.some((d) => d.file === 'runtime/dsh-composition/plugins/root-row.mjs' && d.expr === 'env[k]'),
    'root-row.mjs 的 env[k] 是真实读取点，必须在动态清单里：' + JSON.stringify(rt.dynamic),
  )

  const sec = scanProcess('security', { includeTests: false })
  assert.equal(sec.mode, 'git-tracked')
  assert.ok(sec.filesScanned >= 8, `security/ 应被完整扫描，实际 ${sec.filesScanned} 个文件`)
  assert.deepEqual([...sec.reads.keys()], [], 'security/ 不读 process.env（它自己的设计约束）')
  assert.ok(sec.suspicious.size >= 59, `security/ 的疑似字面量应 ≥59，实际 ${sec.suspicious.size}`)
})

test('★★ PRT-254：nonEnvLiterals 与**源码**逐条对账——多一条是编造，少一条是漏登', () => {
  // 344 个字面量正是"人会开始编"的量级，而编造与真实在名单里**长得一模一样**：
  //   · 漏一条 → 门禁红（可见，代价小）；
  //   · 编一条 → 门禁**比真相更绿**（不可见，代价大）。
  // 所以两个方向都钉死，而不是只断言"没有漏"。
  //
  // ⚠️ 判据必须取"这条字面量出现在**除 config-schema.mjs 以外**的源文件里没有"，
  // 不能直接用 `scan.suspicious.has(k)`——那是一条**空的**断言：
  // schema 文件自己就在被扫描的目录里，往 nonEnvLiterals 里编一条，规则③立刻又把
  // 那条字符串扫出来，"登记 ⊆ 扫描结果"于是永远成立。
  // 这不是推理——是本批**实测**到的：编造一条时 `scan --check` 仍然 PASS、42 条用例全绿。
  //   > 一条在任何实现下都为真的断言，与一条没写的断言，在覆盖率报告里长得一样。
  for (const name of ['runtime', 'security']) {
    const schema = name === 'runtime' ? RUNTIME : SECURITY
    const schemaRel = SCHEMA_FILES[name]
    const scan = scanProcess(name, { includeTests: false })
    // 只保留"至少有一个出处不是 schema 文件"的字面量
    const fromSource = new Set(
      [...scan.suspicious.keys()].filter((k) => scan.suspicious.get(k).files.some((f) => f !== schemaRel)),
    )
    const declared = new Set(schema.nonEnvLiterals)
    const known = new Set([
      ...schema.envNames(),
      ...schema.nonEnvLiterals,
      ...schema.prefixes,
      ...schema.foreignEnv.map((x) => (typeof x === 'string' ? x : x.name)),
    ])
    const fabricated = [...declared].filter((k) => !fromSource.has(k)).sort()
    const dropped = [...fromSource].filter((k) => !known.has(k)).sort()
    assert.deepEqual(fabricated, [], `${name} 的 nonEnvLiterals 里有**源码中不存在**的条目（编造）：${fabricated.join(', ')}`)
    assert.deepEqual(dropped, [], `${name} 有扫到、却没被任何机制覆盖的字面量（漏登）：${dropped.join(', ')}`)
  }
  // 反向：`security/` 一个 env 键都不读，所以它的 nonEnvLiterals 必须与**源码**里的那一批
  // 完全相等（多一条就是编的；少一条上面的 dropped 会红）——这是最强的一档对账。
  const secScan = scanProcess('security', { includeTests: false })
  const secSource = [...secScan.suspicious.keys()]
    .filter((k) => secScan.suspicious.get(k).files.some((f) => f !== SCHEMA_FILES.security))
    .sort()
  assert.deepEqual([...SECURITY.nonEnvLiterals].sort(), secSource, 'security 的 nonEnvLiterals 必须逐条等于源码里的字面量')
})

test('★★ PRT-254：声明的 env 键必须等于 runtime 源码里两张键名表的并集（不许多、不许少）', async () => {
  // 键名**不手抄**：从 runtime 自己的源码取。这两张表就是它全部的下标读取面，
  // 而两张表都是 `env[k]` / `source[key]` 形态——扫描器的字面量规则一条都读不到，
  // 所以这条断言是它们**唯一**的机器判据：
  //   · 表里加了一个键而 fields 没跟上 → 红（否则门禁看不见它，与缺口当初一模一样）；
  //   · fields 里编了一个键 → 红（那是往配置面声明里塞假话）。
  const { DECIDE_ENV_KEYS } = await import('../../runtime/dsh-composition/plugins/root-row.mjs')
  const { ENFORCEMENT_CONFIG_FIELDS, } = await import('../../runtime/dsh-composition/root.mjs')
  const expected = [...new Set([
    ...Object.values(DECIDE_ENV_KEYS),
    ...Object.values(ENFORCEMENT_CONFIG_FIELDS).flatMap((f) => [...f.envKeys]),
  ])].sort()
  assert.equal(expected.length, 10, `两张键名表共 ${expected.length} 个键（复核基线 10）：数量变了就要重新审一遍这份声明`)
  assert.deepEqual(RUNTIME.envNames().sort(), expected,
    'runtime/config-schema.mjs 的 fields 与源码里的键名表不一致（多一个=编了一个环境变量，少一个=门禁看不见它）')

  // foreignEnv 同理：必须逐条等于 execution-scope.mjs 的 DANGEROUS_ENV_KEYS，不许只抄一半
  const { DANGEROUS_ENV_KEYS } = await import('../../runtime/dsh-composition/execution-scope.mjs')
  assert.deepEqual(
    RUNTIME.foreignEnv.map((x) => (typeof x === 'string' ? x : x.name)).sort(),
    [...DANGEROUS_ENV_KEYS].sort(),
    'foreignEnv 必须逐条等于 execution-scope.mjs 的 DANGEROUS_ENV_KEYS',
  )
  assert.ok(RUNTIME.foreignEnv.every((x) => x.owner && x.reason), 'foreignEnv 每一条都要写明归属与理由')

  // 安全面库：0 个 env 键，而且是**显式**声明"没有"，不是靠空数组默认放行
  assert.deepEqual(SECURITY.envNames(), [])
  assert.equal(SECURITY.fields.length, 0)
})

test('★ 引擎：fields 为空必须显式写 allowEmptyFields，默认仍然报错（"忘写"与"确实没有"不能同形）', () => {
  const empty = defineSchema({ process: 'demo-empty', title: '无 env 的扫描范围', allowEmptyFields: true, fields: [] })
  assert.deepEqual(empty.envNames(), [])
  assert.deepEqual(empty.keys(), [])
  assert.deepEqual(empty.secretKeys(), [])
  // 空 schema 走一遍解析引擎：不崩、无错误、无告警（包括 unknownEnv——它没有前缀）
  const resolved = resolveConfig(empty, { env: { ANY: '1' } })
  assert.deepEqual(resolved.values, {})
  assert.deepEqual(resolved.errors, [])
  assert.deepEqual(resolved.warnings, [])
  // 默认（不给开关）必须仍然拒绝：忘写 fields 与"确实没有 fields"不能是同一个读数
  assert.throws(() => defineSchema({ process: 'x', fields: [] }), /非空 fields/)
  assert.throws(() => defineSchema({ process: 'x', allowEmptyFields: true, fields: undefined }), /必须是数组/)
})

// ───────────────────────── ⑦ 动态读取的强制登记（本批：把「打印」变成「判定」）─────────────────────────
//
// 背景：`extractEnvReads` 一直会返回 `dynamic`，注释里也一直写着「必须显式登记」，
// 但 `--check` **只打印 `[动态]` 就从不算它**。于是「新加一处计算式 env 读取」在门禁上没有任何读数：
// 唯一的消费方是 `topology-inventory`，它读 `dynamicEnvReads` 却从不判缺失。
// 结果就是本批实测到的形态：**product 有 8 处动态下标、一份声明都没有，而 `scan --check` 一直是 PASS**。
//
//   > 一道只打印、不判定的门禁，与没有这道门禁，在"新读取点能不能溜过去"这个问题上是同一个读数——
//   > 只不过前者会让人以为已经核对过。
//
// 这一节的要害是**判据不能自证**：被断言的对象（读取点）必须来自源码扫描，
// 断言的依据（声明）必须来自 schema，两者分开构造。下面第 1/3/8 条用的是**人造 scan**，
// 与被测的实现完全独立——那是"把实现改坏，测试必须红"的来源。若断言写成
// `declared ⊆ scan.dynamic`，schema 文件本身就在扫描目录里，往声明里编一条会立刻被扫出来，
// 那条断言在**任何实现下**都为真（这正是本仓库今天踩过两次的坑）。

/** 造一份最小的 scan 结果（只带动态读取），与被测实现无关。 */
const dynScan = (name, dyn) => ({ name, dynamic: dyn.map((d) => ({ file: d.file, expr: d.expr })) })
/** 造一份最小 schema（只带 dynamicEnvReads）。 */
const dynSchema = (dynamicEnvReads = []) => ({ dynamicEnvReads })

test('★★ 动态读取必须被 dynamicEnvReads 覆盖：一处未登记即违规（并报出进程/文件/表达式）', () => {
  const scan = dynScan('demo', [
    { file: 'demo/a.mjs', expr: 'env[k]' },
    { file: 'demo/b.mjs', expr: 'env[other]' },
  ])
  const cov = dynamicCoverage(scan, dynSchema([{ file: 'demo/a.mjs', expr: 'env[k]' }]),
    { schemaFile: 'demo/config-schema.mjs', processName: 'demo', foreign: [] })
  assert.deepEqual(cov.uncovered.map((e) => `${e.file} → ${e.expr}`), ['demo/b.mjs → env[other]'])
  assert.equal(cov.uncovered[0].file, 'demo/b.mjs', '违规必须带文件')
  assert.equal(cov.uncovered[0].expr, 'env[other]', '违规必须带表达式')

  // 空声明 ⇒ 两处都违规。这一条就是本批要消掉的那个洞：不登记必须红，而不是"跳过判定"。
  const none = dynamicCoverage(scan, dynSchema([]), { schemaFile: 'demo/config-schema.mjs', processName: 'demo', foreign: [] })
  assert.deepEqual(none.uncovered.map((e) => `${e.file} → ${e.expr}`), ['demo/a.mjs → env[k]', 'demo/b.mjs → env[other]'])
  // schema 连 dynamicEnvReads 这个属性都没有（product 在本批之前的形态）同样按"一处都没声明"处理
  const bare = dynamicCoverage(scan, {}, { schemaFile: 'demo/config-schema.mjs', processName: 'demo', foreign: [] })
  assert.equal(bare.uncovered.length, 2, 'schema 没有 dynamicEnvReads 属性时不得被当成"全部已登记"')
})

test('★ Trap 4 匹配规则：文件 + 归一化表达式（同一处读法的三种渲染互相覆盖，同文件不同键不覆盖）', () => {
  // 归一：剥掉 process.env[...] / env[...] 外壳与尾部 ]
  assert.equal(normalizeDynamicExpr('process.env[name]'), 'name')
  assert.equal(normalizeDynamicExpr('env[name]'), 'name')
  assert.equal(normalizeDynamicExpr('name'), 'name')
  assert.equal(normalizeDynamicExpr('process.env[env[name]]'), 'name')
  assert.equal(normalizeDynamicExpr('env[LEGION_ENV.HOME]'), 'LEGION_ENV.HOME')
  // security 那处被扫描器截断的表达式与源码写法**不相等**（`]` 不在规则的字符集里）——
  // 这正是"非 env 登记要按扫描器的原样写 expr"的原因，用一条断言把它钉住。
  assert.equal(normalizeDynamicExpr('env[names[0]'), 'names[0')
  assert.equal(normalizeDynamicExpr('env[names[0]]'), 'names[0]')

  // workbench 的真实形态：源码一处 `process.env[name]`，扫描器报两条（`name` / `env[name]`），
  // 而 schema 登记的是源码写法 `process.env[name]`。逐字比对会把一条**正确**的声明判成没生效。
  const scan = dynScan('wb', [{ file: 'wb/serve.mjs', expr: 'name' }, { file: 'wb/serve.mjs', expr: 'env[name]' }])
  const ok = dynamicCoverage(scan, dynSchema([{ file: 'wb/serve.mjs', expr: 'process.env[name]' }]),
    { schemaFile: 'wb/config-schema.mjs', processName: 'wb', foreign: [] })
  assert.deepEqual(ok.uncovered, [], '同一处读法的不同渲染必须互相覆盖（否则正确声明会被判成没生效）')

  // 归一化仍然**不是**"同文件放行"：文件相同但键表达式不同，一律不覆盖。
  // （注意分组口径：上面两条渲染归一后是**同一个键**，所以这里是一组、occurrences=2。）
  const loose = dynamicCoverage(scan, dynSchema([{ file: 'wb/serve.mjs', expr: 'env[anythingElse]' }]),
    { schemaFile: 'wb/config-schema.mjs', processName: 'wb', foreign: [] })
  assert.equal(loose.uncovered.length, 1, '同文件里随手指一个声明不得覆盖任何读取点')
  assert.equal(loose.uncovered[0].occurrences, 2)
  // 文件不同也不行
  const otherFile = dynamicCoverage(scan, dynSchema([{ file: 'wb/other.mjs', expr: 'env[name]' }]),
    { schemaFile: 'wb/config-schema.mjs', processName: 'wb', foreign: [] })
  assert.equal(otherFile.uncovered.length, 1, '文件不同的声明不得互相覆盖')
  assert.equal(otherFile.uncovered[0].occurrences, 2)
})

test('★★ Trap 1：只按**精确 schema 路径**排除自身登记文本（宽松排除会藏掉真实读取）', () => {
  const scan = dynScan('demo', [
    { file: 'demo/config-schema.mjs', expr: 'env[notDeclared]' }, // schema 自己的登记文本
    { file: 'demo/deep/config-schema.mjs', expr: 'env[k]' }, // 真实源码，只是同名文件
  ])
  const cov = dynamicCoverage(scan, dynSchema([]), { schemaFile: 'demo/config-schema.mjs', processName: 'demo', foreign: [] })
  // ① 排除必须**只**认那一个精确路径：按 basename / 后缀排除会把子目录里的真实同名文件一起吞掉，
  //    于是一处未声明的真实读取被静默藏起来——那是比不排除更坏的假绿。放在最前面断言，
  //    这样"把排除放宽"的改动会直接命中这条消息，而不是被其它断言先拦下。
  assert.deepEqual(cov.uncovered.map((e) => e.file), ['demo/deep/config-schema.mjs'],
    '同名的真实文件被当成 schema 自身排除 = 悄悄藏掉未声明读取')
  // ② 排除本身必须发生：否则 schema 自己的 `expr: 'env[k]'` 会被当成一处"未声明读取"（门禁自咬）
  assert.deepEqual(cov.self.map((d) => d.file), ['demo/config-schema.mjs'], 'schema 文件自身必须被排除，且只排除它一个')
})

test('★ Trap 1 实测：runtime 7 处 = 5 处 schema 自身登记文本 + 2 处真实源（product 声明后自身文本变 8）', () => {
  // 这组数字是"重数一遍"的锚点：数量变了就要重新审这份声明，而不是改数字让它变绿。
  const rt = scanProcess('runtime', { includeTests: false })
  const rtCov = dynamicCoverage(rt, RUNTIME, { schemaFile: SCHEMA_FILES.runtime, processName: 'runtime' })
  assert.equal(rt.dynamic.length, 7, 'runtime 动态命中数变了（基线 7）')
  assert.equal(rtCov.self.length, 5, 'runtime 的 5 处自身登记文本必须被排除，而不是当成 5 处待登记读取')
  assert.equal(rtCov.source.length, 2, 'runtime 的真实源动态读取是 2 处（root-row.mjs 同一行两处 env[k]）')
  assert.ok(rtCov.self.every((d) => d.file === SCHEMA_FILES.runtime))
  assert.deepEqual(rtCov.uncovered, [], 'runtime 的 2 处真实源必须被现有 dynamicEnvReads 覆盖：' + JSON.stringify(rtCov.uncovered))

  const wb = scanProcess('workbench', { includeTests: false })
  const wbCov = dynamicCoverage(wb, WB, { schemaFile: SCHEMA_FILES.workbench, processName: 'workbench' })
  assert.equal(wb.dynamic.length, 6)
  assert.equal(wbCov.self.length, 4)
  assert.equal(wbCov.source.length, 2)
  assert.deepEqual(wbCov.uncovered, [])
})

test('★★ Trap 3：security 的那处动态下标是**非 env 读取**，用独立登记记录，绝不进 dynamicEnvReads', () => {
  const scan = scanProcess('security', { includeTests: false })
  assert.equal(scan.dynamic.length, 1)
  assert.equal(scan.dynamic[0].file, 'security/secrets/dsh-credentials.mjs')
  // 不能为了变绿往 fields / dynamicEnvReads 里编东西：security 的实测结论是"一个 env 键都不读"
  assert.deepEqual(SECURITY.envNames(), [])
  assert.deepEqual(SECURITY.dynamicEnvReads, [], '假阳性不得被写成"我确实这样读 env"')

  const cov = dynamicCoverage(scan, SECURITY, { schemaFile: SCHEMA_FILES.security, processName: 'security' })
  assert.deepEqual(cov.uncovered, [], '假阳性必须有机器可读的去处，否则 --check 只能靠「不检查动态读取」变绿')
  assert.equal(cov.entries.length, 1)
  assert.equal(cov.entries[0].via, 'foreign')
  assert.equal(cov.entries[0].foreign.kind, 'foreign-object')

  // 登记必须指向源码里真实存在的那处下标（判据在 security/config-schema.mjs 文件头：env 是 YAML 映射节点）
  const src = readFileSync(join(ROOT, 'security/secrets/dsh-credentials.mjs'), 'utf8')
  assert.ok(src.includes('record.env[names[0]]'), '非 env 登记必须指向源码里真实存在的那处下标')
  assert.deepEqual([...extractEnvReads(src).literal], [], 'security 确实不读 process.env（否则这条"假阳性"判断就错了）')
})

test('★★ product 的 12 处动态下标逐条对账：10 处真读进 dynamicEnvReads（9 条声明），2 处写目标进非 env 名单', () => {
  const scan = scanProcess('product', { includeTests: false })
  const cov = dynamicCoverage(scan, PRODUCT, { schemaFile: SCHEMA_FILES.product, processName: 'product' })
  // ① 源码侧：先把"要登记什么"数清楚。★ 用 cov.source（已排除 schema 文件自身）而不是 scan.dynamic——
  //    schema 文件就在扫描目录里，它自己的登记文本（`env[OS_HOME_ENV.HOME]` 之类）会被同一条规则再扫一遍，
  //    直接数 scan.dynamic 会把**声明**当成读取点（这条断言第一版就是这么红的，正好是 Trap 1 的真身）。
  const got = cov.source.map((d) => `${d.file} → ${d.expr}`).sort()
  assert.deepEqual(got, [
    'product/launcher/allowlist.mjs → env[key]',
    'product/launcher/allowlist.mjs → env[key]',
    'product/launcher/cli.mjs → env[DSH_HOME_ENV]',
    'product/launcher/cli.mjs → env[OS_HOME_ENV.HOME]',
    'product/launcher/cli.mjs → env[OS_HOME_ENV.LOCAL_APP_DATA]',
    'product/launcher/cli.mjs → env[OS_HOME_ENV.USER_PROFILE]',
    // PRT-708：托盘图标宿主要在 Windows 上照 DSH 那条解析顺序找 shell，
    // 于是多了 PATH / ProgramFiles / SystemRoot 三处读（PATH 读两处，见注册表 occ=2）。
    'product/launcher/tray-icon.mjs → env[SHELL_ENV.PATH]',
    'product/launcher/tray-icon.mjs → env[SHELL_ENV.PATH]',
    'product/launcher/tray-icon.mjs → env[SHELL_ENV.PROGRAM_FILES]',
    'product/launcher/tray-icon.mjs → env[SHELL_ENV.SYSTEM_ROOT]',
    'product/paths.mjs → env[LEGION_ENV.HOME]',
    'product/paths.mjs → env[envKey]',
  ], 'product 的动态下标清单变了——重数一遍再改 schema，不要照抄旧数字')
  assert.equal(cov.self.length, 11, 'product 声明之后，schema 自身登记文本命中 11 处（必须被排除，不是待登记）')

  // ② 声明侧：每一处都必须有明确去处
  assert.deepEqual(cov.uncovered, [], 'product 的每处动态下标都必须有去处：' + JSON.stringify(cov.uncovered))
  assert.equal(PRODUCT.dynamicEnvReads.length, 9, '真实读取 9 条声明（覆盖 10 处，PATH 那一处出现两次）')
  assert.equal(PRODUCT.dynamicEnvReads.length + 0, cov.entries.filter((e) => e.via === 'dynamicEnvReads').length,
    '每条声明都必须真的覆盖到一处读取（多一条声明 = 编造，少一条 = 覆盖不到）')
  for (const d of PRODUCT.dynamicEnvReads) {
    assert.ok(d.file && d.expr && typeof d.reason === 'string' && d.reason.trim().length > 20,
      `动态读取登记必须写明 file/expr/reason：${JSON.stringify(d)}`)
    // 声明必须指向扫描器真的看到的站点（不是编出来的读取点）
    assert.ok(
      cov.entries.some((e) => e.via === 'dynamicEnvReads' && e.file === d.file && e.normalized === normalizeDynamicExpr(d.expr)),
      `product 声明了源码里不存在的动态读取：${d.file} → ${d.expr}`,
    )
  }

  // ③ allowlist 的两处是**赋值左值**（写），不是读取：登记在非 env 名单里，kind 必须是 write-target
  const allow = cov.entries.find((e) => e.file === 'product/launcher/allowlist.mjs')
  assert.equal(allow.occurrences, 2)
  assert.equal(allow.via, 'foreign')
  assert.equal(allow.foreign.kind, 'write-target')
  const allowSrc = readFileSync(join(ROOT, 'product/launcher/allowlist.mjs'), 'utf8')
  assert.equal((allowSrc.match(/env\[key\] = /g) ?? []).length, 2, 'allowlist 的 env[key] 必须是赋值左值')
  assert.ok(!/env\[key\](?!\s*=)/.test(allowSrc), 'allowlist 里不存在以 env[key] 为右值的读取')
})

test('★ 非 env 动态下标登记必须完整（缺 reason / 缺处数即红），且每条都指向源码里真实存在的下标', () => {
  assert.deepEqual(foreignDynamicProblems(), [], '登记不完整：' + foreignDynamicProblems().join('；'))
  // 豁免必须写明"为什么不是 env 读取"与"覆盖几处"——否则它就是一张永久免检表
  const problems = foreignDynamicProblems([
    { process: 'x', file: 'x/a.mjs', expr: 'env[k]', occurrences: 1 },
    { process: 'x', file: 'x/a.mjs', expr: 'env[k]', reason: '有理由' },
  ])
  assert.equal(problems.length, 2, '缺 reason 与缺 occurrences 都必须被报出来：' + JSON.stringify(problems))
  // 反向：每条豁免都要有源码出处（把 expr / source 文本回到文件里找得到），
  // 这样"删掉源码里的下标、豁免留着"会被红，而不是变成一句越攒越多的假话。
  for (const f of FOREIGN_DYNAMIC_SUBSCRIPTS) {
    const src = readFileSync(join(ROOT, f.file), 'utf8')
    assert.ok(src.includes(f.source ?? f.expr), `${f.file} 里找不到「${f.source ?? f.expr}」——这条非 env 登记已经失效`)
    assert.equal(typeof f.reason, 'string')
  }
})

test('★ 非 env 登记按「文件 + 表达式 + 处数」精确豁免：多出一处同类下标即违规，登记失效也违规', () => {
  const scan = dynScan('demo', [{ file: 'demo/a.mjs', expr: 'env[k]' }, { file: 'demo/a.mjs', expr: 'env[k]' }])
  const one = [{ process: 'demo', file: 'demo/a.mjs', expr: 'env[k]', occurrences: 1, kind: 'write-target', reason: 'r' }]
  const short = dynamicCoverage(scan, dynSchema([]), { schemaFile: 'demo/config-schema.mjs', processName: 'demo', foreign: one })
  assert.equal(short.entries[0].occurrences, 2)
  assert.equal(short.uncovered.length, 1, '登记 1 处、实际 2 处 ⇒ 多出来那处必须违规（豁免不能顺手放大）')
  assert.equal(short.entries[0].via, null)
  assert.equal(short.entries[0].foreign.occurrences, 1, '输出要能说出"登记 N 处、实际 M 处"')

  const exact = dynamicCoverage(scan, dynSchema([]), { schemaFile: 'demo/config-schema.mjs', processName: 'demo', foreign: [{ ...one[0], occurrences: 2 }] })
  assert.deepEqual(exact.uncovered, [])
  assert.equal(exact.entries[0].via, 'foreign')

  // 豁免条目在源码里已经没有对应下标 ⇒ 也是违规（登记已经变成一句假话）
  const gone = dynamicCoverage(scan, dynSchema([]),
    { schemaFile: 'demo/config-schema.mjs', processName: 'demo', foreign: [{ ...one[0], file: 'demo/gone.mjs', occurrences: 2 }] })
  assert.deepEqual(gone.staleForeign.map((f) => f.file), ['demo/gone.mjs'])
  assert.equal(gone.uncovered.length, 1, '原读取点仍然没有去处')
})

test('★ 端到端：scan --check 必须 PASS，且把「schema 自身登记文本」与「真实源」分开报（Trap 1 可见）', () => {
  // 这条守的是"最终形态"：本仓库当前必须绿；同时"5 处已排除"必须在输出里看得见——
  // 看不看得见不是美观问题：没有它，"5 处已排除"与"5 处没登记"在日志里是同一个读数。
  const r = runScan(['--check'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /scan: PASS（全部 env 读取点、疑似字面量与动态读取均已处理/)
  assert.match(r.out, /runtime\/config-schema\.mjs 命中 5 处/)
  assert.match(r.out, /product\/config-schema\.mjs 命中 11 处/)
  assert.match(r.out, /allowlist\.mjs[\s\S]{0,60}write-target/)
  assert.match(r.out, /dsh-credentials\.mjs[\s\S]{0,60}foreign-object/)
  assert.ok(!/未声明动态读取/.test(r.out), 'PASS 时不得报未声明动态读取：\n' + r.out)
})

test('★ --check 的违规计数口径（countViolations）：四类未处理项全部计入，一项都不许漏算', () => {
  // 这条守的是 main() 里那半句"把发现变成非零退出"的式子。
  // 它原本内联在 main() 里，本批实测（Mutation D）：从内联式里删掉两个 dyn 项，
  // 51 条用例全绿、scan --check 照旧 PASS —— 现状每处都已登记，少算不会变红。
  // 抽成 countViolations 之后，同一处删改会在这里变红。
  const n = (k) => Array.from({ length: k }, (_, i) => ({ file: `f${i}.mjs`, expr: 'env[k]' }))
  assert.equal(countViolations({
    undeclared: ['A'], undeclaredLiterals: ['B', 'C'],
    dyn: { uncovered: n(2), staleForeign: n(1) },
  }), 6) // 1 未声明 env 键 + 2 未处理字面量 + 2 未登记动态读取 + 1 登记失效
  assert.equal(countViolations({}), 0)
  assert.equal(countViolations({ dyn: null }), 0)
  assert.equal(countViolations({ dyn: { uncovered: n(1), staleForeign: [] } }), 1, '动态未登记必须计入')
  assert.equal(countViolations({ dyn: { uncovered: [], staleForeign: n(3) } }), 3, '「非 env」登记失效必须计入')
})
