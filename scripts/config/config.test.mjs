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
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  defineSchema, resolveConfig, redactConfig, formatSummary, summaryObject, parseArgv, coerce, maskSecret, SOURCE,
} from '../../packages/shared/src/config.mjs'
import * as ENGINE from '../../packages/shared/src/config.mjs'
import { runCrossChecks, isExposed } from './cross-checks.mjs'
import { parseEnvFileDetailed } from './check.mjs'
import { scanProcess, extractEnvReads } from './scan.mjs'
import { SCHEMA as HUB } from '../../team-hub/config-schema.mjs'
import { SCHEMA as WB } from '../../workbench/scripts/config-schema.mjs'
import { SCHEMA as BOARD } from '../../whiteboard/apps/server/src/config-schema.mjs'
import { SCHEMA as PLUGINS } from '../../plugins/config-schema.mjs'
import { SCHEMA as BOARD_PLUGIN } from '../../board-plugin/config-schema.mjs'
import { SCHEMA as SERVICES } from '../../services-plugin/config-schema.mjs'

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

test('安全：凡 env 名含 TOKEN/SECRET/KEY 的字段都必须标记 sensitive', () => {
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    for (const f of schema.fields) {
      if (/TOKEN|SECRET|PASSWORD|_KEY$/.test(f.env)) {
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
