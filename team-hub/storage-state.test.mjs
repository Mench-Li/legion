// team-hub/storage-state.test.mjs
// ============================================================================
// 定时体检的读数：谁在监控、多久前测的、结论是什么。
//
// 守三句话（每一条都对应一种**看起来正常**的坏法）：
//   ① 状态不能写在**正在满的那块盘**上；
//   ② "读不到"有三个不同的意思，要采取的动作也不同；
//   ③ 陈旧的 `ok` 比陈旧的 `critical` 危险得多。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fs from 'node:fs'

import { codeOnly } from '../scripts/lib/code-only.mjs'

import {
  STATE_SCHEMA, STALE_AFTER_MS, DEFAULT_STATE_PATH, LEVELS, STATE_REASONS,
  isAlarming, makeState, parseState, readStateLevel, writeStateAtomic, stateSummary, renderSummary,
} from './storage-state.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = 1_800_000_000_000

/** 造一份合法的状态文件原文。 */
const rawState = (over = {}) => JSON.stringify({
  schema: STATE_SCHEMA,
  atMs: T0,
  level: 'ok',
  exitCode: 0,
  report: { dbBytes: 3000000, walBytes: 4000000, freeBytes: 45 * 1024 ** 3, backupAgeMs: 4 * HOUR, backupStale: false },
  problems: [],
  host: 'test-host',
  ...over,
})

// ── ① ★★★ 状态落点：不能写在正在满的那块盘上 ───────────────────────────────

test('★★★ 默认落点是 `/run`（tmpfs），不是库所在的那块盘', () => {
  // ★ 这是本模块最要紧的一条设计约束。写在 `/var/lib/legion-hub/` 很自然，
  //   而那正好是错的：那块盘满的时候**写状态文件也会失败** ——
  //   而那一刻正是最需要这个读数的时候。
  //
  //   > 一个"写在被测磁盘上"的健康状态，会在磁盘满的时候**连同磁盘一起坏掉** ——
  //   > 而它存在的全部理由就是报告那件事。
  assert.match(DEFAULT_STATE_PATH, /^\/run\//, '状态必须落在 tmpfs（/run）上')
  assert.doesNotMatch(DEFAULT_STATE_PATH, /^\/var\/lib/, '不许落在库/备份所在的那块盘上')
  // 而且路径里要能看出它是谁的（多台 Hub 时不会互相覆盖）。
  assert.match(DEFAULT_STATE_PATH, /legion-hub/)
})

test('★★ 落点是一个 .json 文件（不是目录、不是无扩展名的东西）', () => {
  assert.match(DEFAULT_STATE_PATH, /\.json$/)
})

// ── ② ★★★ makeState：只留该留的 ──────────────────────────────────────────

test('★★★ makeState 只留读数里的**数**，不透传路径', () => {
  // 一个"整份透传"的实现会把库文件路径、备份目录路径写进状态 ——
  // 而这个状态是要给 Hub 读、可能还会显示出来的。少一个信息泄露面。
  const s = makeState({
    level: 'warn', exitCode: 1, atMs: T0, host: 'h',
    report: { dbBytes: 1, walBytes: 2, totalUsedBytes: 3, freeBytes: 4, totalBytes: 5, neededBytes: 6, backupAgeMs: 7, backupStale: true },
    problems: ['x'],
    // 这些是**不该**出现在状态里的东西。
    paths: { db: '/var/lib/legion-hub/team.db', backups: '/var/lib/legion-hub/backups' },
    secret: 'nope',
  })
  const text = JSON.stringify(s)
  assert.doesNotMatch(text, /team\.db|backups|\/var\/lib/, '不许把路径写进状态')
  assert.doesNotMatch(text, /nope/)
  assert.equal(s.schema, STATE_SCHEMA)
  assert.equal(s.level, 'warn')
  assert.equal(s.report.freeBytes, 4)
  assert.equal(s.report.backupStale, true)
  assert.deepEqual(s.problems, ['x'])
})

test('★★★ makeState 不认识的等级一律降成 `unknown`（不许猜成一个好看的）', () => {
  for (const bad of ['OK', 'fine', '', null, undefined, 42, 'warning']) {
    assert.equal(makeState({ level: bad }).level, 'unknown', `level=${String(bad)} 应当降成 unknown`)
  }
  for (const good of LEVELS) assert.equal(makeState({ level: good }).level, good)
})

test('★★ 缺时间戳时用 `Date.now()`，缺退出码时用 3（unknown）', () => {
  const s = makeState({ level: 'ok' })
  assert.ok(Number.isFinite(s.atMs) && s.atMs > 0)
  assert.equal(s.exitCode, 3, '缺退出码不许默认成 0（那会把"不知道"报成"正常"）')
})

test('★ makeState 畸形输入不抛', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    assert.doesNotThrow(() => makeState(bad))
    assert.equal(makeState(bad).schema, STATE_SCHEMA)
  }
})

// ── ③ ★★★ parseState：坏东西一律判"读不出来"，不许"当作没有" ────────────────

test('★★★ 坏 JSON / 不认识的版本 → **读不出来**（不是"没有"）', () => {
  // ★ 这两个的含义不同：文件在但读不出来说明**写入方**有问题（去查它），
  //   文件不在说明**从来没跑过**（去装它）。合成一个会让值班的人做错事。
  assert.equal(parseState('{ 不是 json').why, STATE_REASONS.UNREADABLE)
  assert.equal(parseState('null').why, STATE_REASONS.UNREADABLE)
  assert.equal(parseState('[1,2]').why, STATE_REASONS.UNREADABLE)
  assert.equal(parseState('').why, STATE_REASONS.UNREADABLE)
  assert.equal(parseState('   ').why, STATE_REASONS.UNREADABLE)
  for (const bad of [null, undefined, 42, {}]) {
    assert.equal(parseState(bad).ok, false, `${String(bad)} 不该被当成合法状态`)
  }
})

test('★★★ 版本不认识时**不许按旧格式猜**', () => {
  // 格式换了之后，"按旧格式读新文件"最可能的结果是读出一个
  // **看起来正常但其实没意义**的结论。
  const future = JSON.stringify({ schema: STATE_SCHEMA + 1, atMs: T0, level: 'ok', exitCode: 0 })
  assert.equal(parseState(future).why, STATE_REASONS.SCHEMA_MISMATCH)
  assert.equal(parseState(future).ok, false)
  const noSchema = JSON.stringify({ atMs: T0, level: 'ok', exitCode: 0 })
  assert.equal(parseState(noSchema).why, STATE_REASONS.SCHEMA_MISMATCH)
})

test('★★★ 没有时间戳的状态 = 读不出来（无法判断新旧）', () => {
  for (const bad of [undefined, null, 0, -1, NaN, 'x']) {
    const raw = JSON.stringify({ schema: STATE_SCHEMA, atMs: bad, level: 'ok', exitCode: 0 })
    assert.equal(parseState(raw).ok, false, `atMs=${String(bad)} 必须判读不出来`)
  }
})

test('★★★ 等级不认识 = 读不出来（不是"当作 ok"）', () => {
  const raw = JSON.stringify({ schema: STATE_SCHEMA, atMs: T0, level: 'excellent', exitCode: 0 })
  assert.equal(parseState(raw).ok, false)
  assert.equal(parseState(raw).why, STATE_REASONS.UNREADABLE)
})

test('★★ 合法的状态能读出来，且字段原样保留', () => {
  const p = parseState(rawState({ level: 'critical', exitCode: 2 }))
  assert.equal(p.ok, true)
  assert.equal(p.state.level, 'critical')
  assert.equal(p.state.exitCode, 2)
  assert.equal(p.why, null)
})

// ── ④ ★★★ readStateLevel：新鲜度──这一族的核心 ────────────────────────────

test('★★★ 文件不在 → `no-state`（**不是** ok）', () => {
  const r = readStateLevel({ raw: null, nowMs: T0 })
  assert.equal(r.level, 'unknown')
  assert.equal(r.reason, STATE_REASONS.NO_STATE)
  assert.equal(r.lastKnownLevel, null)
  assert.equal(r.fresh, false)
})

test('★★★ 新鲜的 ok → ok，并报出年龄', () => {
  const r = readStateLevel({ raw: rawState(), nowMs: T0 + 30 * MIN })
  assert.equal(r.level, 'ok')
  assert.equal(r.reason, STATE_REASONS.FRESH)
  assert.equal(r.fresh, true)
  assert.equal(r.stateAgeMs, 30 * MIN)
  assert.equal(r.exitCode, 0)
})

test('★★★ 陈旧的 `ok` **必须**降级成 unknown（这是最危险的一种）', () => {
  // ★ 三天前测到"充足"，今天报"充足" → 你以为有人看着，其实**没有人在测**。
  const r = readStateLevel({ raw: rawState({ level: 'ok' }), nowMs: T0 + 3 * 24 * HOUR })
  assert.equal(r.level, 'unknown', '陈旧的 ok 绝不能当成 ok')
  assert.equal(r.reason, STATE_REASONS.STALE)
  assert.equal(r.fresh, false)
  // ★ 但上次的结论要**一起报出来** —— 只说"没人测了"值班的人不知道要不要立刻动手。
  assert.equal(r.lastKnownLevel, 'ok')
  assert.ok(r.stateAgeMs > 3 * 24 * HOUR - 1000)
})

test('★★★ 陈旧的 `critical` 也降级，但 `lastKnownLevel` 保留 critical', () => {
  // 两件事同时可见："没人测了" + "上次测到的是危险"。
  const r = readStateLevel({ raw: rawState({ level: 'critical', exitCode: 2 }), nowMs: T0 + 3 * 24 * HOUR })
  assert.equal(r.level, 'unknown')
  assert.equal(r.reason, STATE_REASONS.STALE)
  assert.equal(r.lastKnownLevel, 'critical')
  const s = stateSummary({ raw: rawState({ level: 'critical', exitCode: 2 }), nowMs: T0 + 3 * 24 * HOUR })
  // ⚠️ 判据必须读 `vars` / `text`，**不是** `key` ——
  //    `key` 是**模板**（占位符还没填），第一版我拿 `key` 去 match 具体值，
  //    于是判据在正确实现上变红。（这条也是"key 是模板"那个陷阱的另一面。）
  assert.equal(s.vars.last, 'critical')
  assert.match(s.text, /没跑/, '要说清"没人测了"')
  assert.match(s.text, /critical/, '也要说清上次测到的是什么')
})

test('★★★ 新鲜度边界：正好等于阈值算**新鲜**，超过一毫秒算陈旧', () => {
  const raw = rawState()
  assert.equal(readStateLevel({ raw, nowMs: T0 + STALE_AFTER_MS }).fresh, true, '边界上算新鲜')
  assert.equal(readStateLevel({ raw, nowMs: T0 + STALE_AFTER_MS + 1 }).fresh, false, '过一毫秒就陈旧')
})

test('★★★ 阈值可覆盖，且垃圾阈值回落到默认（不许变成"永远新鲜"）', () => {
  const raw = rawState()
  assert.equal(readStateLevel({ raw, nowMs: T0 + 10 * MIN, staleAfterMs: 5 * MIN }).fresh, false, '自定义阈值生效')
  for (const bad of [0, -1, NaN, 'x', null, undefined]) {
    assert.equal(readStateLevel({ raw, nowMs: T0 + STALE_AFTER_MS + 1, staleAfterMs: bad }).fresh, false,
      `staleAfterMs=${String(bad)} 必须回落到默认，不许"永远新鲜"`)
  }
})

test('★★★ 新鲜的 `unknown` 要给**自己的**原因（体检跑过了但读不到）', () => {
  // 与 `no-state`（从来没跑）区别开：一个是"去查挂载与权限"，一个是"去装定时器"。
  const r = readStateLevel({ raw: rawState({ level: 'unknown', exitCode: 3 }), nowMs: T0 + MIN })
  assert.equal(r.level, 'unknown')
  assert.equal(r.reason, STATE_REASONS.CHECK_COULD_NOT_READ)
  assert.equal(r.fresh, true, '它**是**新鲜的 —— 体检确实跑过了')
  assert.notEqual(r.reason, STATE_REASONS.NO_STATE)
})

test('★★★ 坏状态文件 → `unreadable`，且**不是** `no-state`', () => {
  const r = readStateLevel({ raw: '{坏', nowMs: T0 })
  assert.equal(r.level, 'unknown')
  assert.equal(r.reason, STATE_REASONS.UNREADABLE)
  assert.equal(r.lastKnownLevel, null)
})

test('★★ 时钟倒退（状态来自未来）按 0 岁处理，不许算出负数年龄', () => {
  const r = readStateLevel({ raw: rawState(), nowMs: T0 - 5 * MIN })
  assert.equal(r.stateAgeMs, 0)
  assert.equal(r.fresh, true)
  assert.equal(r.level, 'ok')
})

test('★ 畸形输入不抛', () => {
  for (const bad of [null, undefined, 'nope', 42, {}]) {
    assert.doesNotThrow(() => readStateLevel(bad))
    assert.equal(readStateLevel(bad).level, 'unknown', `${JSON.stringify(bad)} 必须判 unknown`)
  }
})

// ── ⑤ ★★★ 报警语义 ───────────────────────────────────────────────────────

test('★★★ `unknown` 也算要人动手（没人测就是没人测）', () => {
  assert.equal(isAlarming('critical'), true)
  assert.equal(isAlarming('warn'), true)
  assert.equal(isAlarming('unknown'), true, 'unknown 不算报警，等于允许"没人监控"静默存在')
  assert.equal(isAlarming('ok'), false)
  assert.equal(isAlarming('nope'), true, '不认识的等级按"要人看"处理，不许当成 ok')
})

// ── ⑥ ★★★ writeStateAtomic：原子 + 失败不抛 ──────────────────────────────

test('★★★ 原子写：写完之后没有残留的临时文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-state-'))
  try {
    const path = join(dir, 'storage-state.json')
    const r = writeStateAtomic({ fs, path, state: makeState({ level: 'ok', atMs: T0 }), dir })
    assert.equal(r.ok, true, `写失败：${r.reason}`)
    assert.ok(existsSync(path))
    // ⚠️ 第一版这里写成 `readFileSync(dir, 'utf8') === undefined ? [] : require(...)`
    //    —— 对**目录**调 `readFileSync` 直接抛 EISDIR。要数文件就该用 `readdirSync`。
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [], '不许留下临时文件')
    // 写出来的是合法 JSON，且能被 parseState 读回。
    assert.equal(parseState(readFileSync(path, 'utf8')).ok, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('★★★ 写失败**不抛**（状态写不进去不影响体检结论本身）', () => {
  // 体检的结论已经算出来了、也打印了。写状态失败只意味着 Hub 那边显示
  // "陈旧/读不到" —— 那是一个**诚实的**降级，而不是把整次体检判为失败。
  const broken = {
    writeFileSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) },
    renameSync: () => { },
    unlinkSync: () => { },
    mkdirSync: () => { },
  }
  let r
  assert.doesNotThrow(() => { r = writeStateAtomic({ fs: broken, path: '/tmp/x.json', state: makeState({ level: 'ok' }) }) })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'ENOSPC')
  // 缺 fs / 缺 path 也只是回 ok:false。
  assert.equal(writeStateAtomic({}).ok, false)
  assert.equal(writeStateAtomic({ fs, path: '' }).ok, false)
})

test('★★ 写失败时会试图收尾临时文件（不留垃圾）', () => {
  let unlinked = null
  const partially = {
    writeFileSync: () => { },
    renameSync: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }) },
    unlinkSync: (p) => { unlinked = p },
    mkdirSync: () => { },
  }
  const r = writeStateAtomic({ fs: partially, path: '/tmp/x.json', state: makeState({}) })
  assert.equal(r.ok, false)
  assert.match(String(unlinked), /x\.json\.tmp-/, '重命名失败后要删掉临时文件')
})

// ── ⑦ ★★★ stateSummary：给运维看的那句话 ─────────────────────────────────

test('★★★ 四种原因四句不同的话（值班的人要照着它分派动作）', () => {
  const cases = [
    [{ raw: null, nowMs: T0 }, /没有\*\*在定时体检|没有在定时体检/],
    [{ raw: '{坏', nowMs: T0 }, /读不出来/],
    [{ raw: rawState({ schema: 99 }), nowMs: T0 }, /版本不认识/],
    [{ raw: rawState(), nowMs: T0 + 3 * 24 * HOUR }, /没跑/],
    [{ raw: rawState({ level: 'unknown' }), nowMs: T0 + MIN }, /读不到读数/],
  ]
  const seen = new Set()
  for (const [input, re] of cases) {
    const s = stateSummary(input)
    assert.match(s.key, re, `输入 ${JSON.stringify(input)} 的说法不对：${s.key}`)
    seen.add(s.key)
  }
  assert.equal(seen.size, cases.length, '五句话必须互不相同')
})

test('★★★ 充足时也要说"多久前测的"（否则"充足"是个没有时间的话）', () => {
  const s = stateSummary({ raw: rawState({ level: 'ok' }), nowMs: T0 + 3 * HOUR })
  assert.equal(s.vars.hours, '3', '要说清是几小时前测的')
  assert.match(s.text, /3/, '渲染出来的句子里要有那个数')
  assert.match(s.text, /充足/)
})

test('★★★ `text` 里不许剩占位符（它会被直接打印给值班的人）', () => {
  // ★ 这是本模块最要紧的一条**可用性**判据，也是我在自己的测试里先红过一次的坑：
  //
  //   `key` 是**模板**（`{hours}` 还没填），而运维脚本会直接 `console.log` 它。
  //   一个只有 `key` 的返回值被打印时，会把 `{hours}` **原样印给值班的人看**。
  //
  //   所以 `text` 必须是渲染好的，而这条判据盯着它。
  const inputs = [
    { raw: null, nowMs: T0 },
    { raw: '{坏', nowMs: T0 },
    { raw: rawState({ schema: 99 }), nowMs: T0 },
    { raw: rawState(), nowMs: T0 + 3 * 24 * HOUR },
    { raw: rawState({ level: 'unknown' }), nowMs: T0 + MIN },
    { raw: rawState({ level: 'ok' }), nowMs: T0 + 3 * HOUR },
    { raw: rawState({ level: 'warn' }), nowMs: T0 + MIN },
    { raw: rawState({ level: 'critical' }), nowMs: T0 + MIN },
  ]
  for (const input of inputs) {
    const s = stateSummary(input)
    assert.doesNotMatch(s.text, /\{[A-Za-z_]/, `text 里还剩占位符：${s.text}`)
    assert.doesNotMatch(s.text, /undefined|\bnull\b/, `text 里有 undefined/null：${s.text}`)
    // 而 `key` **必须**保留占位符（它是给 i18n 层用的模板）。
    if (Object.keys(s.vars).length > 0) {
      assert.match(s.key, /\{[A-Za-z_]/, `vars 非空时 key 应当是模板：${s.key}`)
    }
    // 两者必须对应：把 vars 填进 key 就该得到 text。
    assert.equal(renderSummary(s.key, s.vars), s.text, 'key+vars 渲染出来必须等于 text')
  }
})

test('★★ `renderSummary` 缺变量时**原样留占位符**（不印 undefined）', () => {
  // 留一个看得见的 `{hours}` 比印一个 `undefined` 好查 ——
  // 前者一眼能看出是模板没填，后者看起来像数据坏了。
  assert.equal(renderSummary('已经 {hours} 小时', {}), '已经 {hours} 小时')
  assert.equal(renderSummary('已经 {hours} 小时', { hours: undefined }), '已经 {hours} 小时')
  assert.equal(renderSummary('已经 {hours} 小时', { hours: null }), '已经 {hours} 小时')
  assert.equal(renderSummary('已经 {hours} 小时', { hours: 0 }), '已经 0 小时', '0 是合法值，不许被当成缺变量')
  assert.equal(renderSummary('没有占位符', { x: 1 }), '没有占位符')
  for (const bad of [null, undefined, 42, {}]) {
    assert.doesNotThrow(() => renderSummary(bad, {}))
    assert.equal(renderSummary(bad, {}), '')
  }
})

test('★ 反例守卫：五句话"互不相同"的判据不是恒真', () => {
  const same = [1, 2, 3, 4, 5].map(() => ({ key: '同一句' }))
  assert.equal(new Set(same.map((s) => s.key)).size, 1, '反例：同一句必须只算 1 种')
  const real = [
    stateSummary({ raw: null, nowMs: T0 }),
    stateSummary({ raw: '{坏', nowMs: T0 }),
    stateSummary({ raw: rawState({ schema: 99 }), nowMs: T0 }),
    stateSummary({ raw: rawState(), nowMs: T0 + 3 * 24 * HOUR }),
    stateSummary({ raw: rawState({ level: 'unknown' }), nowMs: T0 + MIN }),
  ]
  assert.ok(new Set(real.map((s) => s.key)).size > 1)
})

// ── ⑧ 端到端：写→读一条链 ────────────────────────────────────────────────

test('★★★ 写进去再读出来，等级与年龄都对得上', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-state-'))
  try {
    const path = join(dir, 's.json')
    writeStateAtomic({ fs, path, state: makeState({ level: 'warn', exitCode: 1, atMs: T0, host: 'h' }), dir })
    const raw = readFileSync(path, 'utf8')
    const r = readStateLevel({ raw, nowMs: T0 + 2 * HOUR })
    assert.equal(r.level, 'warn')
    assert.equal(r.fresh, true)
    assert.equal(r.exitCode, 1)
    assert.equal(r.host, 'h')
    // 而同一个文件在两倍阈值之后必须变成 unknown。
    assert.equal(readStateLevel({ raw, nowMs: T0 + 2 * STALE_AFTER_MS }).level, 'unknown')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('★★★ 判据只写临时目录（不许把真实落点当写入目标）', async () => {
  // ★ 这条原本写的是 `assert.equal(existsSync('/run/legion-hub/…'), false)` ——
  //   一个**环境**断言，不是实现的性质。它红了两次：一次是我自己的破坏性
  //   验证（把 `--state` 解析打破之后，CLI 回落到默认落点，**真的**在
  //   `D:\run\…` 写下了一份状态文件）。
  //
  //   > 一个断言"这台机器上某个路径不存在"的判据，测的是**这台机器的历史**，
  //   > 不是被测代码的性质 —— 而它会在别人跑过一次之后失效。
  //
  //   换成一个真正的性质：**判据文件里不许把默认落点当作写入目标**。
  // ★ 剥掉注释再扫 —— 这条判据的原话就在注释里提到了那几个写入调用，
  //   于是它第一次跑就在**完全正确**的文件上红了（第四次踩同一个坑）。
  const src = codeOnly(readFileSync(new URL('./storage-state.test.mjs', import.meta.url), 'utf8'))
  // ★ 针仍然要**拼出来**：注释已被 `codeOnly` 剥掉，但**断言列表本身**是代码，
  //   写全的针会出现在它自己的列表里 —— 那是另一条恒真的路。
  //
  // ★ 针要**拼出来**，不能写全 —— 写全的话，针会出现在它自己的断言列表里，
  //   于是判据**恒真**（我在第一版上就是这么栽的：它报"文件里含
  //   `writeFileSync(DEFAULT_STATE_PATH`"，而那正是这行断言自己的字符串）。
  //
  //   > 一条把自己的"针"写进去的源码扫描判据，
  //   > 与一条永远为真的判据，是同一条判据。
  const WRITE = 'writeFile' + 'Sync'
  const ATOMIC = 'writeState' + 'Atomic'
  for (const needle of [`${ATOMIC}({ fs, path: DEFAULT_STATE_PATH`, `${WRITE}(DEFAULT_STATE_PATH`]) {
    assert.equal(src.includes(needle), false, `判据不许对真实落点写入：${needle}`)
  }
  // 反向守卫：拼出来的针确实能在一个**真的**有它的样本上匹配到
  // （否则上面两条只是在找两个永远不存在的字符串）。
  const sample = `const x = ${WRITE}(DEFAULT_STATE_PATH, 'x')`
  assert.equal(sample.includes(`${WRITE}(DEFAULT_STATE_PATH`), true, '针必须能命中真的样本')
  // 而所有用例都必须用 `mkdtempSync` 造的目录。
  assert.match(src, /mkdtempSync/, '判据应当用临时目录')
  assert.match(DEFAULT_STATE_PATH, /^\/run\//, '（同时确认默认落点仍然是 tmpfs）')
})
