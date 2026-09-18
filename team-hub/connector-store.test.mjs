// team-hub/connector-store.test.mjs
// ============================================================================
// F-21 落盘面的判据。
//
// 三条主线：
//   · 控制面不 import 执行面：字面量副本必须**从执行面源码抽出来**比对
//   · 声明按**内容哈希**冻结（同版本换内容 = 409），因为连接器声明说的是
//     "一个外部进程能拿到什么权限"
//   · 故障事件的记录必须**点名是哪一个**连接器
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONNECTOR_EVENT_KINDS, CONNECTOR_LITERALS, CONNECTOR_RECORD_VERSION, CONNECTOR_STORE_ERRORS,
  appendIncident, connectorCounts, connectorIncidents, connectorRegistrations,
  declarationContentHash, ensureConnectorSchema, exportConnectors, freezeDeclaration, getDeclaration,
  normalizeDeclaration,
} from './connector-store.mjs'

// ★ 执行面的注册表：F-21 的**判定面**。控制面**不** import 它（见文件头 ①），
//   但**用例**要 import —— 因为这里要量的是一条**跨平面**的读数：
//   "控制面冻结下来的那份记录，执行面到底用不用得上"。
//   理由与上面"字面量从执行面源码里抽出来比对"同源：两边必须放在一起量。
import { createRegistry } from '../runtime/connectors/registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function freshDb() {
  const db = new DatabaseSync(':memory:')
  ensureConnectorSchema(db)
  return db
}

function throwsCode(fn, code) {
  let err = null
  try { fn() } catch (e) { err = e }
  assert.notEqual(err, null, `期望抛出 ${code}，但没有抛`)
  assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`)
  return err
}

/** 一份合法声明。`extraTools` 用来造"内容确实不同"的另一版。 */
function decl(over = {}) {
  return {
    connectorId: 'github',
    version: '1.0.0',
    transport: 'stdio',
    policy: 'allow',
    tools: [{ name: 'list_issues', capabilities: ['repo:read'], declaredRisk: 'low', policy: 'allow' }],
    secretRefs: ['mcp.github.token'],
    ...over,
  }
}

// ---------------------------------------------------------------------------
// ① ★★★ 单向产品边界：从执行面源码**抽**出来比对
// ---------------------------------------------------------------------------

test('① ★★★ 字面量副本与执行面**逐字**相同（单向边界的代价由此钉住）', () => {
  const src = readFileSync(join(HERE, '..', 'runtime', 'connectors', 'registry.mjs'), 'utf8')
  // ★ 从执行面源码里抽，而不是再抄一遍：两份手抄件互相核对时，
  //   两边一起写错它全绿。
  const v = /export const CONNECTOR_REGISTRY_VERSION = '([^']+)'/.exec(src)
  assert.notEqual(v, null, '没能抽出 CONNECTOR_REGISTRY_VERSION——锚点变了，用例失去意义')
  assert.equal(CONNECTOR_LITERALS.registryVersion, v[1])

  for (const [name, exported] of [
    ['CONNECTOR_TRANSPORTS', CONNECTOR_LITERALS.transports],
    ['CONNECTOR_DECISIONS', CONNECTOR_LITERALS.decisions],
    ['CIRCUIT_STATES', CONNECTOR_LITERALS.circuitStates],
  ]) {
    const block = new RegExp(`export const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`).exec(src)
    assert.notEqual(block, null, `没能抽出 ${name}`)
    const fromSource = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    assert.deepEqual([...exported], fromSource, `${name} 与执行面不一致`)
  }
})

test('① ★★ 产品库**没有** import 执行面（一条 import 就能打破单向边界）', () => {
  const src = readFileSync(join(HERE, 'connector-store.mjs'), 'utf8')
  const imports = [...src.matchAll(/^import .*from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual([...imports].sort(), ['./schema-util.mjs', 'node:crypto'])
  assert.equal(/from '.*runtime\//.test(src), false)
})

// ---------------------------------------------------------------------------
// ② ★★★ 按内容哈希冻结
// ---------------------------------------------------------------------------

test('② ★★★ 同 (id, version) 同内容 ⇒ **幂等**，且不改写冻结时刻与冻结人', () => {
  const db = freshDb()
  const a = freezeDeclaration({ db, declaration: decl(), frozenAtMs: 1000, frozenBy: 'alice' })
  assert.equal(a.created, true)
  assert.equal(a.frozen, true)
  const b = freezeDeclaration({ db, declaration: decl(), frozenAtMs: 9999, frozenBy: 'bob' })
  assert.equal(b.created, false, '重放应该幂等')
  assert.equal(b.contentHash, a.contentHash)
  // ★ 这里要断言**两件不同的事**，它们各自对应一个独立的失败模式：
  //   (1) **返回值**不能撒谎——返回 9999/bob 时，调用方会据此写下一条
  //       "这份声明是 bob 在 9999 冻的"的审计记录，而那不是真的。
  assert.equal(b.frozenAtMs, 1000, '返回值里的冻结时刻被重试改写了（调用方会据此写下假的审计记录）')
  assert.equal(b.frozenBy, 'alice', '返回值里的冻结人被重试改写了')
  //   (2) **库里那一行**不能被改写——查返回值之外还要**重新读一次**：
  //       F-19 那一批就是被这一点咬到——一条 UPDATE 之后仍返回改之前读出来的行，
  //       于是只查返回值的用例全绿，而库里已经被踩过。
  const reread = getDeclaration({ db, connectorId: 'github', version: '1.0.0' })
  assert.equal(reread.frozenAtMs, 1000, '库里那一行的冻结时刻被重试改写了')
  assert.equal(reread.frozenBy, 'alice', '库里那一行的冻结人被重试改写了')
  assert.equal(connectorRegistrations({ db }).length, 1)
})

test('② ★★★ 同 (id, version) **不同内容** ⇒ 409，且这一次写入没有发生', () => {
  const db = freshDb()
  freezeDeclaration({ db, declaration: decl() })
  // 加上一个"能删库"的工具——这正是"同版本换内容"最危险的形状。
  const dangerous = decl({
    tools: [...decl().tools, { name: 'delete_repo', capabilities: ['repo:write'], declaredRisk: 'high', policy: 'allow' }],
  })
  assert.notEqual(declarationContentHash(dangerous), declarationContentHash(decl()))
  const err = throwsCode(
    () => freezeDeclaration({ db, declaration: dangerous }),
    CONNECTOR_STORE_ERRORS.VERSION_CONFLICT,
  )
  assert.equal(err.statusCode, 409)
  assert.match(err.message, /没有发生/)
  assert.match(err.message, /递增版本号/)
  assert.match(err.message, /外部进程能拿到什么权限/)
  // 原来那一版一字未动。
  const got = getDeclaration({ db, connectorId: 'github', version: '1.0.0' })
  assert.equal(got.declaration.tools.length, 1)
  assert.equal(connectorRegistrations({ db }).length, 1)
})

test('② ★★★ 多版本**同时存在**（"当时放行了哪些工具"要有得查）', () => {
  const db = freshDb()
  freezeDeclaration({ db, declaration: decl({ version: '1.0.0' }), frozenAtMs: 1000 })
  freezeDeclaration({
    db,
    declaration: decl({ version: '1.1.0', tools: [{ name: 'list_issues', capabilities: ['repo:read'], declaredRisk: 'low', policy: 'allow' }, { name: 'ping', capabilities: ['mcp:call'], declaredRisk: 'high', policy: 'ask' }] }),
    frozenAtMs: 2000,
  })
  // 两版都在。
  assert.equal(connectorRegistrations({ db }).length, 2)
  assert.equal(getDeclaration({ db, connectorId: 'github', version: '1.0.0' }).declaration.tools.length, 1)
  assert.equal(getDeclaration({ db, connectorId: 'github', version: '1.1.0' }).declaration.tools.length, 2)
  // 不传 version ⇒ 最新（按 frozenAtMs）。
  assert.equal(getDeclaration({ db, connectorId: 'github' }).version, '1.1.0')
})

test('② ★★ 哈希只看**决定权限**的东西：重排工具顺序不算换内容', () => {
  // 让顺序进哈希，会让一次纯重排看起来像一次权限变更——
  // 于是审阅的人去查一个不存在的差异。
  const one = decl({
    tools: [
      { name: 'a', capabilities: ['repo:read'], policy: 'allow' },
      { name: 'b', capabilities: ['repo:read'], policy: 'allow' },
    ],
  })
  const two = decl({ tools: [...one.tools].reverse() })
  assert.equal(declarationContentHash(one), declarationContentHash(two))
  // capabilities 的顺序同理。
  const three = decl({ tools: [{ name: 'a', capabilities: ['repo:read', 'mcp:call'], policy: 'allow' }] })
  const four = decl({ tools: [{ name: 'a', capabilities: ['mcp:call', 'repo:read'], policy: 'allow' }] })
  assert.equal(declarationContentHash(three), declarationContentHash(four))
  // ★ 但来源信息（谁冻的、什么时候）**不**进哈希——否则幂等重放会变成"换了一版"。
  assert.equal(declarationContentHash(decl()), declarationContentHash(decl({ frozenBy: 'x', frozenAtMs: 5 })))
  // 而真正的权限变化要能区分。
  assert.notEqual(
    declarationContentHash(decl()),
    declarationContentHash(decl({ tools: [{ name: 'list_issues', capabilities: ['repo:read'], policy: 'deny' }] })),
  )
  assert.notEqual(declarationContentHash(decl()), declarationContentHash(decl({ policy: 'deny' })))
  assert.notEqual(declarationContentHash(decl()), declarationContentHash(decl({ secretRefs: [] })))
})

test('② ★★★ 哈希在**规范化前后一致**（否则身份取决于"你传的是哪个形状"）', () => {
  // `freezeDeclaration` 内部先规范化。若哈希对"原始输入"与"规范化后的记录"
  // 给出两个值，那么调用方事前自己算一次哈希去比对时必然对不上；
  // 更糟的是幂等判断会时灵时不灵——一次无害的重放被报成"同版本换内容"(409)，
  // 而真正换过内容的那次有可能被当成重放收下。
  const raw = decl()
  const normalized = normalizeDeclaration(raw)
  assert.equal(declarationContentHash(raw), declarationContentHash(normalized))
  // 规范化本身也要幂等（`version_label` 优先于 `version`，见实现里的长注释）。
  assert.deepEqual(normalizeDeclaration(normalized), normalized)
  assert.equal(normalizeDeclaration(normalized).version_label, '1.0.0')
  // ★ 反过来：把**记录格式版本**当声明版本号要报错，不能猜。
  const err = throwsCode(
    () => normalizeDeclaration({ ...raw, version: 'legion/connector-record@1', version_label: undefined }),
    CONNECTOR_STORE_ERRORS.BAD_RECORD,
  )
  assert.match(err.message, /记录长什么样/)
})

test('② ★★★ 存的每个权限字段都进哈希（改了 `declaredRisk` 不能报"内容没变"）', () => {
  // 不覆盖该字段时：把某工具的 `declaredRisk` 从 high 改成 low，哈希不变，
  // 于是这次冻结被当成"重放"收下并**静默丢弃**，
  // 而调用方得到一句"内容相同、无需重冻"。
  //
  // ★★★ 这条用例**原来一直是绿的，但它什么都没验到**。
  //
  //   它把两个声明写成 `risk: 'high'` / `risk: 'low'` —— 而 `risk` 是
  //   `normalizeTool` / `decide()` 交出去的**输出**字段，声明里的输入字段
  //   叫 `declaredRisk`。`declareConnector` 当时**静默忽略** `risk`，
  //   所以这两个声明在权限上**完全一样**（有效风险都落回能力下限 `low`）。
  //
  //   哈希之所以还是不同，是因为 `declarationContentHash` 把那个**无效**字段
  //   也读进了载荷（`connector-store.mjs:267` 的 `risk: t.risk ?? null`）。
  //   也就是说：这条"证明 declaredRisk 进哈希"的用例，
  //   靠的恰恰是一个**永远不生效的字段**。
  //
  //   > 一个"用错字段名写、但断言碰巧也成立"的用例，
  //   > 与一个"真的验过 declaredRisk"的用例，在套件读数上是同一个 ✔。
  //
  //   现在 `declareTool` 的键集是封闭的（多写 `risk` 直接具名拒），
  //   所以这里改成 `declaredRisk` —— 这才是它一开始想验的东西。
  const high = decl({ tools: [{ name: 't', capabilities: ['repo:read'], declaredRisk: 'high', policy: 'allow' }] })
  const low = decl({ tools: [{ name: 't', capabilities: ['repo:read'], declaredRisk: 'low', policy: 'allow' }] })
  assert.notEqual(declarationContentHash(high), declarationContentHash(low))

  // ★ 前置对照：这两个声明在**有效风险**上必须真的不同。
  //
  //   上面那个"什么都没验到"的版本缺的正是这一条断言——少了它，
  //   "两个声明其实一模一样"也能绿。
  // ▲ 这里给 `command`：`createRegistry` 真的会建表，而 transport=stdio 必须带命令。
  //   （`decl()` 的夹具不带它——那正是测试 ⑧ 说的"喂不进"缺的那一样。）
  assert.notEqual(
    createRegistry({ connectors: [{ ...high, command: 'npx x' }] })
      .decide({ connectorId: 'github', toolName: 't' }).risk,
    createRegistry({ connectors: [{ ...low, command: 'npx x' }] })
      .decide({ connectorId: 'github', toolName: 't' }).risk,
    '前提：改 declaredRisk 必须真的改变有效风险，否则上面那条哈希断言还是白测的',
  )

  // `policy` 是另一个存下来的权限字段，同理钉住。
  const ask = decl({ tools: [{ name: 't', capabilities: ['repo:read'], declaredRisk: 'high', policy: 'ask' }] })
  assert.notEqual(declarationContentHash(high), declarationContentHash(ask))
})

test('② ★★ 撞上另一个写入者 ⇒ 同哈希幂等、不同哈希 409（不是 500）', () => {
  const d = decl()
  const hash = declarationContentHash(d)
  // 假 db：SELECT 说"没有"，INSERT 抛，再查能查到。
  let calls = 0
  const fake = {
    prepare(sql) {
      if (/^\s*SELECT/i.test(sql)) {
        return {
          get: () => {
            calls += 1
            return calls === 1 ? undefined : {
              seq: 1, scope: 'default', connector_id: 'github', version: '1.0.0',
              content_hash: hash, transport: 'stdio', tool_count: 1,
              record_json: JSON.stringify(normalizeDeclaration(d)), frozen_at_ms: 1, frozen_by: null,
            }
          },
        }
      }
      return { run: () => { throw new Error('UNIQUE constraint failed') } }
    },
  }
  const r = freezeDeclaration({ db: fake, declaration: d })
  assert.equal(r.created, false, '竞态下拿到同哈希应该报幂等，而不是失败')
})

test('② ★★ 写失败报 500（把磁盘错误报成 4xx 会让调用方放弃重试）', () => {
  const fake = {
    prepare(sql) {
      if (/^\s*SELECT/i.test(sql)) return { get: () => undefined }
      return { run: () => { throw new Error('disk I/O error') } }
    },
  }
  const err = throwsCode(() => freezeDeclaration({ db: fake, declaration: decl() }), CONNECTOR_STORE_ERRORS.WRITE_FAILED)
  assert.equal(err.statusCode, 500)
  assert.match(err.message, /disk I\/O error/)
  // 读失败也抛 500。
  const broken = { prepare: () => { throw new Error('库打不开') } }
  assert.equal(throwsCode(() => connectorRegistrations({ db: broken }), CONNECTOR_STORE_ERRORS.READ_FAILED).statusCode, 500)
  assert.equal(throwsCode(() => freezeDeclaration({ db: null, declaration: decl() }), CONNECTOR_STORE_ERRORS.WRITE_FAILED).statusCode, 500)
})

// ---------------------------------------------------------------------------
// ③ 形状校验（两层都拦）
// ---------------------------------------------------------------------------

test('③ ★★ 传输方式 / 策略 / 工具清单的形状都被拒', () => {
  throwsCode(() => freezeDeclaration({ db: freshDb(), declaration: decl({ transport: 'grpc' }) }),
    CONNECTOR_STORE_ERRORS.UNKNOWN_TRANSPORT)
  throwsCode(() => freezeDeclaration({ db: freshDb(), declaration: decl({ policy: 'allow-once' }) }),
    CONNECTOR_STORE_ERRORS.BAD_RECORD)
  const noTools = throwsCode(() => freezeDeclaration({ db: freshDb(), declaration: decl({ tools: [] }) }),
    CONNECTOR_STORE_ERRORS.NO_TOOLS)
  assert.match(noTools.message, /没读到/)
  throwsCode(() => freezeDeclaration({ db: freshDb(), declaration: decl({ tools: [{ name: 't', capabilities: ['repo:read'], policy: 'always' }] }) }),
    CONNECTOR_STORE_ERRORS.BAD_RECORD)
  // 工具没 capabilities ⇒ 拒（与执行面一致）。
  throwsCode(() => freezeDeclaration({ db: freshDb(), declaration: decl({ tools: [{ name: 't', capabilities: [] }] }) }),
    CONNECTOR_STORE_ERRORS.BAD_RECORD)
  // 重复工具 ⇒ 拒。
  const dup = throwsCode(() => freezeDeclaration({
    db: freshDb(),
    declaration: decl({ tools: [{ name: 't', capabilities: ['repo:read'] }, { name: 't', capabilities: ['repo:read'] }] }),
  }), CONNECTOR_STORE_ERRORS.TOOL_DUPLICATE)
  assert.match(dup.message, /遮蔽/)
  // 非法 id / 缺 version。
  throwsCode(() => freezeDeclaration({ db: freshDb(), declaration: decl({ connectorId: 'a/b' }) }),
    CONNECTOR_STORE_ERRORS.BAD_RECORD)
  throwsCode(() => freezeDeclaration({ db: freshDb(), declaration: decl({ version: '' }) }),
    CONNECTOR_STORE_ERRORS.BAD_RECORD)
})

test('③ ★ 建表幂等；表里**没有** UPDATE / DELETE；追加路径用 `lastInsertRowid`', () => {
  const db = new DatabaseSync(':memory:')
  ensureConnectorSchema(db)
  ensureConnectorSchema(db)
  assert.equal(connectorCounts({ db }).readable, true)
  const src = readFileSync(join(HERE, 'connector-store.mjs'), 'utf8')
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  // 声明与事件都是只追加的。
  for (const table of ['connector_registrations', 'connector_incidents']) {
    assert.deepEqual([...code.matchAll(new RegExp(`UPDATE\\s+${table}`, 'gi'))].map((m) => m[0]), [], `出现了 UPDATE ${table}`)
    assert.deepEqual([...code.matchAll(new RegExp(`DELETE\\s+FROM\\s+${table}`, 'gi'))].map((m) => m[0]), [], `出现了 DELETE FROM ${table}`)
  }
  // ★ 判据要盯住**那个失败模式**：追加之后不能靠回读序号来知道"我插的是第几号"。
  //
  //   第一版这条断言写的是"整个文件里不许出现 `SELECT MAX(seq)`"。那**太宽**了：
  //   它同时禁掉了一处完全正当的查询（"每个连接器最后一条事件是哪条"），
  //   于是会逼着人把那句 SQL 改写成别的形状来骗过检查——
  //   **一条过严的规则会制造"为了过关而撒谎"的压力**。
  //   真正要禁的是"把它当作自己的序号读回来"。
  const readback = [...code.matchAll(/SELECT\s+MAX\(seq\)\s+AS\s+seq/gi)].map((m) => m[0])
  assert.deepEqual(readback, [], '出现了把 MAX(seq) 当自己序号回读的写法')
  // 两个追加路径都必须用 lastInsertRowid（`freezeDeclaration` 不返回 seq，
  // 它的身份是 content_hash）。
  const appendIncidentBody = code.slice(code.indexOf('function appendIncident'), code.indexOf('export function connectorIncidents'))
  assert.match(appendIncidentBody, /lastInsertRowid/, 'appendIncident 没用 lastInsertRowid')
  // 而且**行为上**要能证明：连着写两条，序号必须是各自的。
  // （结构断言容易被绕过，行为断言不会。）
  const db2 = freshDb()
  const a = appendIncident({ db: db2, connectorId: 'g', kind: 'circuit-opened', circuitState: 'open', atMs: 1 })
  const b = appendIncident({ db: db2, connectorId: 'h', kind: 'circuit-opened', circuitState: 'open', atMs: 2 })
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
})

// ---------------------------------------------------------------------------
// ④ ★★★ 故障事件必须点名
// ---------------------------------------------------------------------------

test('④ ★★★ 事件必须点名**是哪一个**连接器（不接"全局"）', () => {
  const db = freshDb()
  const err = throwsCode(
    () => appendIncident({ db, connectorId: '', kind: 'circuit-opened', circuitState: 'open', atMs: 1 }),
    CONNECTOR_STORE_ERRORS.BAD_EVENT,
  )
  assert.match(err.message, /是哪一个/)
  assert.match(err.message, /大面积故障/)
  throwsCode(() => appendIncident({ db, connectorId: '  ', kind: 'circuit-opened', circuitState: 'open', atMs: 1 }),
    CONNECTOR_STORE_ERRORS.BAD_EVENT)
})

test('④ ★★ 事件种类与熔断状态都是封闭词表', () => {
  const db = freshDb()
  assert.deepEqual([...CONNECTOR_EVENT_KINDS], ['circuit-opened', 'circuit-closed', 'probe-failed'])
  throwsCode(() => appendIncident({ db, connectorId: 'c', kind: 'exploded', circuitState: 'open', atMs: 1 }),
    CONNECTOR_STORE_ERRORS.BAD_EVENT)
  throwsCode(() => appendIncident({ db, connectorId: 'c', kind: 'circuit-opened', circuitState: 'melted', atMs: 1 }),
    CONNECTOR_STORE_ERRORS.UNKNOWN_STATE)
  // atMs 必填且整数（`undefined` 与"当时就是 0"同形）。
  throwsCode(() => appendIncident({ db, connectorId: 'c', kind: 'circuit-opened', circuitState: 'open' }),
    CONNECTOR_STORE_ERRORS.BAD_EVENT)
})

test('④ ★★ 事件按连接器分开读，且**点名**开路的那些', () => {
  const db = freshDb()
  appendIncident({ db, connectorId: 'github', kind: 'circuit-opened', circuitState: 'open', atMs: 1, reason: '连续失败' })
  appendIncident({ db, connectorId: 'gitlab', kind: 'circuit-opened', circuitState: 'open', atMs: 2, reason: '连续失败' })
  appendIncident({ db, connectorId: 'github', kind: 'circuit-closed', circuitState: 'closed', atMs: 3, reason: '探针成功' })
  assert.equal(connectorIncidents({ db }).length, 3)
  assert.equal(connectorIncidents({ db, connectorId: 'github' }).length, 2)
  // github 已经恢复 ⇒ open 的只有 gitlab。
  // ★ 只给"有故障"这一个布尔时，一次隔离良好的单点故障与一次大面积故障长得一样。
  const c = connectorCounts({ db })
  assert.deepEqual(c.openCircuitIds, ['gitlab'])
  assert.equal(c.incidentConnectorIds, 2)
  assert.equal(c.incidents, 3)
})

test('④ ★★ 事件 seq 是自己那一条的号，且可按 sinceSeq 增量读', () => {
  const db = freshDb()
  const a = appendIncident({ db, connectorId: 'g', kind: 'circuit-opened', circuitState: 'open', atMs: 1 })
  const b = appendIncident({ db, connectorId: 'g', kind: 'circuit-closed', circuitState: 'closed', atMs: 2 })
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
  assert.equal(connectorIncidents({ db, sinceSeq: a.seq }).length, 1)
  // 写失败报 500。
  const broken = { prepare: () => { throw new Error('库打不开') } }
  assert.equal(throwsCode(() => appendIncident({ db: broken, connectorId: 'g', kind: 'circuit-opened', circuitState: 'open', atMs: 1 }),
    CONNECTOR_STORE_ERRORS.WRITE_FAILED).statusCode, 500)
  assert.equal(throwsCode(() => connectorIncidents({ db: broken }), CONNECTOR_STORE_ERRORS.READ_FAILED).statusCode, 500)
  assert.equal(throwsCode(() => appendIncident({ db: null, connectorId: 'g', kind: 'circuit-opened', circuitState: 'open', atMs: 1 }),
    CONNECTOR_STORE_ERRORS.WRITE_FAILED).statusCode, 500)
})

// ---------------------------------------------------------------------------
// ⑤ 坏行 / 读数 / 导出
// ---------------------------------------------------------------------------

test('⑤ ★★ 坏 `record_json` ⇒ `readable:false`，**不是**当作没登记过', () => {
  const db = freshDb()
  freezeDeclaration({ db, declaration: decl() })
  db.prepare("UPDATE connector_registrations SET record_json = '{ 坏了'").run()
  const rows = connectorRegistrations({ db })
  assert.equal(rows.length, 1, '坏行仍要在结果里——悄悄丢掉它会让"从没登记过"与"这行坏了"同形')
  assert.equal(rows[0].readable, false)
  assert.equal(rows[0].declaration, null)
  // 投影列还在，于是至少知道这里曾经有一条登记。
  assert.equal(rows[0].connectorId, 'github')
  assert.equal(rows[0].version, '1.0.0')
})

test('⑤ ★★ 拿不到读数时报 `readable:false` + null，不是 0', () => {
  const broken = { prepare: () => { throw new Error('表被删了') } }
  const c = connectorCounts({ db: broken })
  assert.equal(c.readable, false)
  assert.equal(c.registrations, null)
  assert.equal(c.openCircuitIds, null)
  assert.match(c.reason, /表被删了/)
  assert.equal(connectorCounts({ db: freshDb() }).registrations, 0)
  // `getDeclaration` 找不到时返回 null（不是抛，也不是空壳）。
  assert.equal(getDeclaration({ db: freshDb(), connectorId: 'nope' }), null)
  assert.equal(getDeclaration({ db: freshDb(), connectorId: 'github', version: '9.9.9' }), null)
  throwsCode(() => getDeclaration({ db: freshDb(), connectorId: '  ' }), CONNECTOR_STORE_ERRORS.BAD_RECORD)
})

test('⑤ ★★ 导出是可提交进 Git 的文本：含权限面与引用**名**，不含命令与 URL', () => {
  const db = freshDb()
  freezeDeclaration({ db, declaration: decl(), frozenBy: 'alice', frozenAtMs: 1700000000000 })
  appendIncident({ db, connectorId: 'github', kind: 'circuit-opened', circuitState: 'open', atMs: 5, reason: '连续失败' })
  const { text, doc } = exportConnectors({ db, exportedAtMs: 1 })
  assert.equal(doc.format, 'legion/connector-export@1')
  assert.equal(doc.recordVersion, CONNECTOR_RECORD_VERSION)
  assert.equal(doc.registryVersion, CONNECTOR_LITERALS.registryVersion)
  assert.equal(doc.registrations.length, 1)
  // ★ 权限面必须在（那正是这个文件存在的理由）。
  assert.equal(doc.registrations[0].policy, 'allow')
  assert.deepEqual(doc.registrations[0].tools, [
    { name: 'list_issues', capabilities: ['repo:read'], policy: 'allow', declaredRisk: 'low' },
  ])
  // ★ 引用的**名字**要在（它告诉审阅的人这个连接器要拿哪类凭证），
  //   而凭证值本身不可能在这里——声明里就装不下。
  assert.deepEqual(doc.registrations[0].secretRefs, ['mcp.github.token'])
  assert.equal(doc.incidents.length, 1)
  assert.equal(doc.incidents[0].connectorId, 'github')
  assert.equal(doc.incidents[0].reason, '连续失败')
  // 命令与 URL 不进导出（它们可能带上内网地址或参数）。
  assert.equal(text.includes('command'), false)
  assert.equal(text.includes('npx'), false)
})

test('⑤ 空库上的导出也能用，且给出真实的 0', () => {
  const db = freshDb()
  const { doc } = exportConnectors({ db })
  assert.deepEqual(doc.registrations, [])
  assert.deepEqual(doc.incidents, [])
  assert.equal(doc.counts.registrations, 0)
  assert.equal(doc.counts.readable, true)
  // 读不出来时导出抛 500，而不是导出一份空文档。
  const broken = { prepare: () => { throw new Error('库打不开') } }
  assert.equal(throwsCode(() => exportConnectors({ db: broken }), CONNECTOR_STORE_ERRORS.READ_FAILED).statusCode, 500)
})

test('⑤ ★ `scope` 隔离', () => {
  const db = freshDb()
  freezeDeclaration({ db, declaration: decl({ version: 'a' }), scope: 'team-a' })
  freezeDeclaration({ db, declaration: decl({ version: 'b' }), scope: 'team-b' })
  assert.equal(connectorRegistrations({ db, scope: 'team-a' }).length, 1)
  assert.equal(connectorRegistrations({ db, scope: 'team-a' })[0].version, 'a')
  assert.equal(getDeclaration({ db, connectorId: 'github', scope: 'team-c' }), null)
  appendIncident({ db, connectorId: 'github', kind: 'circuit-opened', circuitState: 'open', atMs: 1, scope: 'team-a' })
  assert.equal(connectorIncidents({ db, scope: 'team-a' }).length, 1)
  assert.equal(connectorIncidents({ db, scope: 'team-b' }).length, 0)
})

test('⑤ ★ 每个码都至少被一个用例触达', () => {
  const src = readFileSync(join(HERE, 'connector-store.mjs'), 'utf8')
  const declared = [...src.matchAll(/^\s{2}([A-Z_]+):\s*'/gm)].map((m) => m[1])
  const testSrc = readFileSync(join(HERE, 'connector-store.test.mjs'), 'utf8')
  const unreachable = declared.filter((n) => !testSrc.includes(`CONNECTOR_STORE_ERRORS.${n}`))
  assert.deepEqual(unreachable, [], `这些码没有用例触达：${unreachable.join(', ')}`)
})

// ---------------------------------------------------------------------------
// ⑧ ★★★ 控制面的记录能不能喂进执行面的注册表
// ---------------------------------------------------------------------------

test('⑧ ★★★ 控制面冻结的记录**喂不进**执行面的注册表——缺的是**连接目标**，不是策略', () => {
  // 这条读数决定了一件很具体的事：F-21 的判定面能不能"照抄 PRT-214 的形状，
  // 把控制面的连接器声明挂到 `RunRequest` 上、由执行面装成一份注册表"。
  //
  // 结论：**不能**。而且原因不是"没人接线"，是**控制面根本没有那两个字段**——
  // 于是任何"照抄形状"的施工都会在 `declareConnector` 这一步具名拒绝。
  // 想让它通过，唯一的办法是**编一个连接目标**，那正是"发明默认值"。
  const record = normalizeDeclaration(decl())

  // ① 控制面存的是**策略**那一半：id / transport / policy / tools / secretRefs。
  //    它**不**存连接目标。这是设计使然，但后果很具体：执行面靠这两个字段
  //    才认得出"连去哪儿"。
  assert.equal('command' in record, false, '控制面竟然存了 command——读数过期了，重写本节')
  assert.equal('url' in record, false, '控制面竟然存了 url——读数过期了，重写本节')

  // ② 把那份记录**原样**喂进执行面的注册表 → **具名拒绝**。
  //
  //   静默成功才是最坏的一种：一个"注册成功但永远连不上"的连接器，
  //   与一个"连上了但没有工具"的连接器，在读数上长得一模一样。
  const err = throwsCode(
    () => createRegistry({ connectors: [record] }),
    'connector-transport-target-missing',
  )
  assert.match(err.message, /必须给 command/)

  // ③ 反向对照：**只**补上连接目标，它就能建起来。
  //    少了这条，② 无法排除"其实是别的地方也不对"——那样本节就只是
  //    "这条路走不通"，而不是"**只差**连接目标"。
  const reg = createRegistry({ connectors: [{ ...record, command: 'npx' }] })
  assert.equal(reg.connectors().length, 1)

  // ④ 不是 stdio 独有：http/sse 缺的是 url，同一个具名码。
  //    少了这条，一个"只为 stdio 补了 command"的施工会在 http 上继续静默失败。
  const httpErr = throwsCode(
    () => createRegistry({ connectors: [normalizeDeclaration(decl({ transport: 'http' }))] }),
    'connector-transport-target-missing',
  )
  assert.match(httpErr.message, /必须给 url/)
})
