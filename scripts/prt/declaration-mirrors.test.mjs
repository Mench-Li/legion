// scripts/prt/declaration-mirrors.test.mjs
// 判据：导出的常量表，与它自己被**手写复述**的那一份，是不是同一个东西。
//
// 这一组盯的是**判据本身**能不能分辨它声称要抓的形状——
// 因为一个"什么都没查"的判据，与一个"全都对"的判据，在输出上是同一个东西。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DECLARED_MIRRORS,
  DECL_RE,
  SELF_CHECK,
  checkDeclarations,
  checkRepo,
  isMirroring,
  iterPattern,
  measureDeclaration,
  membersOf,
  mirrorPattern,
  scanDeclarations,
} from './declaration-mirrors.mjs'

// ★ 真仓扫描很贵（238 张表 × 每张一次 git grep ≈ 2 分钟）。
//   ⑨ 与 ⑩ 看的是**同一次**扫描，所以只跑一次、共用。
let repoScan = null
const scanOnce = () => (repoScan ??= scanDeclarations())

test('① ★★★ 自证：判据必须认得出「修复前」，且不误报「修复后」', () => {
  // `allowlist: []` 是为了把 R2 也一起空转——这一条只测 R4 自证。
  const before = checkDeclarations({ rows: [], allowlist: [] })
  assert.equal(before.ok, true, `自证不该红：${JSON.stringify(before.problems)}`)
  assert.equal(before.selfCheck.before, 1, '自证没有覆盖到"修复前"那张表')
  assert.equal(before.selfCheck.after, 1)

  // ★ 反向：把自证的"修复前"形状换成"修复后"，R4 必须红（说明它真的在比对形状）
  const blind = checkDeclarations({
    rows: [], allowlist: [], selfCheck: { before: SELF_CHECK.after, after: SELF_CHECK.after },
  })
  assert.equal(blind.ok, false)
  assert.ok(blind.problems.some((p) => p.code === 'self-check-blind'),
    '判据把"修复后"当成了"修复前"，却没报 self-check-blind')
  // ★ 另一个方向：把"修复后"换成"修复前"，必须报 overreach
  const over = checkDeclarations({
    rows: [], allowlist: [], selfCheck: { before: SELF_CHECK.before, after: SELF_CHECK.before },
  })
  assert.equal(over.ok, false)
  assert.ok(over.problems.some((p) => p.code === 'self-check-overreach'))
})

test('② ★★★ 口径：只有**键位**才算复述——枚举值出现在**值位**是正常使用', () => {
  // 这是本判据最关键的一处口径。第一版我用"成员作为字符串出现过"来判，
  // 报了 17 张装饰表，而它们几乎全是误报：一张枚举表声明允许的取值，
  // 代码里当然会写下那些取值。
  const text = [
    "export const SNAPSHOT_STATUSES = Object.freeze(['failed', 'complete'])",
    'function f(status) {',
    "  if (status === 'failed') return 1",   // 值位：正常使用
    "  return status === 'complete' ? 2 : 0", // 值位
    '}',
  ].join('\n')
  const { mirrors, iterSites } = measureDeclaration({
    name: 'SNAPSHOT_STATUSES', members: ['failed', 'complete'], file: 'x.mjs', text,
    hits: [],
  })
  assert.equal(mirrors, 0, `值位被算成了复述（mirrors=${mirrors}）——那会把整仓的枚举全报成装饰`)
  assert.equal(iterSites, 0)
  // 而**键位**必须被算出来
  const text2 = [
    "export const SNAPSHOT_STATUSES = Object.freeze(['failed', 'complete'])",
    'const lab = {',
    '  failed: 1,',
    '  complete: 2,',
    '}',
  ].join('\n')
  const m2 = measureDeclaration({
    name: 'SNAPSHOT_STATUSES', members: ['failed', 'complete'], file: 'x.mjs', text: text2,
    hits: [],
  })
  assert.equal(m2.mirrors, 2, `键位没被算出来（mirrors=${m2.mirrors}）`)
})

test('③ ★★ 门槛：命中一个成员是巧合，命中一半以上才是"重建"', () => {
  assert.equal(isMirroring({ hitCount: 1, total: 6 }), false, '只命中一个就报 = 假阳性')
  assert.equal(isMirroring({ hitCount: 2, total: 6 }), false, '2/6 不到一半')
  assert.equal(isMirroring({ hitCount: 3, total: 6 }), true, '一半就够')
  assert.equal(isMirroring({ hitCount: 3, total: 3 }), true)
  assert.equal(isMirroring({ hitCount: 0, total: 3 }), false)
})

test('④ ★★ 缩进不影响键位识别（第一版漏了 `\\s*`，真实代码认不出来）', () => {
  // 真实代码里对象字面量的键是**缩进**的。第一版用 `(^|[{,]\s*)`，
  // 于是 `    key: String(...)` 认不出来 ⇒ 自证 self-check-blind。
  assert.ok(mirrorPattern('key').test('    key: String(p?.key ?? "x"),'),
    '缩进 4 格的键位认不出来')
  assert.ok(mirrorPattern('key').test('  key: 1,'))
  assert.ok(mirrorPattern('key').test('{ key: 1 }'))
  assert.ok(mirrorPattern('key').test('{ key, pid }'), '简写键不认识')
  assert.equal(mirrorPattern('key').test("  if (status === 'key') return"), false, '值位被误判成键位')
})

test('⑤ ★★ 注释行不算复述：在注释里点名一个成员是解释', () => {
  // ★★ 夹具必须**真的是键位形状**。第一版我写的是 `// data: 业务状态`——
  //    它前面有 `// `，**本来就**不匹配 `^\s*data\s*:`，所以那一条即使把
  //    "去注释"整行删掉也照样绿：它测的是**夹具没构造出那个形状**。
  //    （破验 M3 漏网就是这么来的。）
  const text = [
    "export const ROLES = Object.freeze(['data', 'cache'])",
    "// 展开成 { data: layout.dataDir, cache: layout.cacheDir } 那种形状",
    'const x = 1',
  ].join('\n')
  const { mirrors } = measureDeclaration({
    name: 'ROLES', members: ['data', 'cache'], file: 'x.mjs', text, hits: [],
  })
  assert.equal(mirrors, 0, '注释里的键位形状被算成了第二份实现')
  // 反向控制：把同样的字面量**移出注释**，必须被算出来
  const live = [
    "export const ROLES = Object.freeze(['data', 'cache'])",
    'const x = { data: 1, cache: 2 }',
  ].join('\n')
  assert.equal(measureDeclaration({
    name: 'ROLES', members: ['data', 'cache'], file: 'x.mjs', text: live, hits: [],
  }).mirrors, 2, '非注释里的键位没被算出来（那 ⑤ 的正向半边是空的）')
})

test('⑤b ★★★ 只挖掉声明**那一段**，不是整行——同一行上的真代码要算', () => {
  // 声明与真实代码同处一行时，"整行跳过"会把 `{ key: 1 }` 这处**真凭据**丢掉。
  // 这就是 `isDeclarationLine` 那个写法的假阴性（破验 M4 漏网暴露的）。
  const text = "export const F = Object.freeze(['key','pid']); const row = { key: 1, pid: 2 }"
  const { mirrors, mirrorSites } = measureDeclaration({
    name: 'F', members: ['key', 'pid'], file: 'x.mjs', text, hits: [],
  })
  assert.equal(mirrors, 2, `同一行上的真代码被丢掉了（mirrors=${mirrors}）：${mirrorSites.join(' ')}`)
  // 而声明**自己**那些带引号的成员不许自命中（否则每张表都是"装饰"）
  const only = "export const F = Object.freeze(['key','pid'])"
  assert.equal(measureDeclaration({
    name: 'F', members: ['key', 'pid'], file: 'x.mjs', text: only, hits: [],
  }).mirrors, 0, '声明自己的成员被当成了复述自己——那每张表都会被判成装饰')
})

test('⑥ ★★ 遍历点：for…of / 展开 / 数组方法都算，字面量比较不算', () => {
  const p = iterPattern('ROLES')
  const re = new RegExp(p)
  assert.ok(re.test('for (const r of ROLES) {}'))
  assert.ok(re.test('const all = [...ROLES]'))
  assert.ok(re.test('ROLES.map((r) => r)'))
  assert.ok(re.test('ROLES.includes(x)'))
  assert.equal(re.test("if (role === 'ROLES') return"), false)
})

test('⑦ ★★★ 声明解析：只认纯字符串字面量的表', () => {
  const m = [..."export const ROLES = Object.freeze(['data', 'cache'])".matchAll(DECL_RE)]
  assert.equal(m.length, 1)
  assert.deepEqual(membersOf(m[0][2]), ['data', 'cache'])
  // 含变量的表**不适用**（返回 null，跳过），而不是猜
  const m2 = [...'export const X = Object.freeze([A, B])'.matchAll(DECL_RE)]
  assert.equal(membersOf(m2[0][2]), null)
  assert.equal(membersOf(''), null)
})

test('⑧ ★★ 规则 R1/R2/R3 各自可被证伪', () => {
  // ★ 夹具必须带上 `decorative` 本身——第一版只写了 `mirroring: true`，
  //   于是 R1 看不到任何装饰表、这条断言测的是**夹具写错了**，不是判据漏了。
  //   > 一个"判据没报"的读数，与一个"夹具根本没构造出那个形状"的读数，
  //   > 在只看 `problems` 长度时是同一个东西。
  const decorativeRow = {
    file: 'a.mjs', name: 'T', members: ['x', 'y'],
    iterSites: 0, mirrors: 2, mirrorSites: ['1:x'], mirroring: true, decorative: true,
  }
  // R1：装饰表没豁免 ⇒ 红
  assert.equal(checkDeclarations({ rows: [decorativeRow], allowlist: [] }).problems
    .some((p) => p.code === 'decorative-declaration'), true)
  // R1：豁免了就绿
  assert.equal(checkDeclarations({
    rows: [decorativeRow],
    allowlist: [{ name: 'T', why: '这是一条足够长的理由，长到能通过 R3 的字数门槛（至少二十个字符）', owner: '§5 第 16 条' }],
  }).ok, true)
  // R2：豁免了一个**不再装饰**的表 ⇒ 红（豁免会变成一句没人核的话）
  // ★ 夹具必须把**派生字段 `decorative` 也一起改掉**：第一版只改了
  //   `iterSites`/`mirroring`，展开运算符却把 `decorative: true` 原样带过来了
  //   ⇒ R2 看的是 `decorative`，于是它根本没看到"不再装饰"这个形状。
  //   > 一个"只改了输入、没改派生读数"的夹具，
  //   > 与一个"判据不检查过期豁免"的读数，在只看断言真假时是同一个东西。
  assert.equal(checkDeclarations({
    rows: [{ ...decorativeRow, iterSites: 3, mirroring: false, decorative: false }],
    allowlist: [{ name: 'T', why: '这是一条足够长的理由，长到能通过 R3 的字数门槛（至少二十个字符）', owner: '§5 第 16 条' }],
  }).problems.some((p) => p.code === 'stale-exemption'), true)
  // R3：理由太短 / 没写裁决处
  assert.equal(checkDeclarations({ rows: [decorativeRow], allowlist: [{ name: 'T', why: '短', owner: '§5 第 16 条' }] })
    .problems.some((p) => p.code === 'exemption-no-why'), true)
  assert.equal(checkDeclarations({ rows: [decorativeRow], allowlist: [{ name: 'T', why: '这是一条足够长的理由，长到能通过 R3 的字数门槛（至少二十个字符）', owner: '' }] })
    .problems.some((p) => p.code === 'exemption-no-owner'), true)
})

test('⑨ ★★★ 真仓：判据跑得通，且**真的查了东西**（不是"什么都没查"）', () => {
  const r = checkRepo({ rows: scanOnce() })
  // ★ 下限守卫：扫到 0 张表的"绿"与"全都对"的绿是同一个读数
  assert.ok(r.scanned > 100, `只扫到 ${r.scanned} 张表——判据可能是瞎的`)
  assert.ok(r.selfCheck.before > 0 && r.selfCheck.after > 0, '自证没跑')
  assert.equal(r.ok, true, `真仓里还有未定性的装饰表：${JSON.stringify(r.problems)}`)
  // 当下有 3 张，且每一张都写了理由（R3 保证）
  assert.equal(r.decorative.length, DECLARED_MIRRORS.length)
  for (const a of DECLARED_MIRRORS) {
    assert.ok(a.why.length >= 20, `豁免 ${a.name} 的理由太短`)
    assert.ok(typeof a.owner === 'string' && a.owner.length > 0)
  }
})

test('⑩ ★★★ 两处真缺陷都在读数里：第 40 轮那张表**已不再**装饰', () => {
  // `RUN_RECORD_OPTIONAL_FIELDS` 是第 40 轮修掉的那张（声明表没有消费者）。
  // 它今天被 `buildRunRecord` / `validateRunRecord` 真的**遍历**了 ⇒ 不该报。
  const all = scanOnce()
  const names = all.map((r) => r.name)
  assert.ok(names.includes('RUN_RECORD_FIELDS'), '判据没扫到 run-record 的表')
  for (const r of all) {
    if (r.name === 'RUN_RECORD_OPTIONAL_FIELDS' || r.name === 'RUN_RECORD_FIELDS') {
      assert.ok(r.iterSites > 0, `${r.name} 又变成装饰表了（第 40 轮的修复被回退？）`)
    }
  }
  // 而 `BUDGET_ALERT_CONFIDENCE`（第 41 轮修的）也必须已经有遍历点
  const budget = all.find((r) => r.name === 'BUDGET_ALERT_CONFIDENCE')
  assert.ok(budget !== undefined, '判据没扫到 budget-alert 的词表')
  assert.ok(budget.iterSites > 0, 'BUDGET_ALERT_CONFIDENCE 又变成装饰表了')
})

test('⑪ ★★ 判据自己**不许**用 `rg`（本机没有它；ENOENT 会被吞成"没有匹配"）', () => {
  const src = readFileSync(new URL('./declaration-mirrors.mjs', import.meta.url), 'utf8')
  assert.equal(/\bspawnSync\s*\(\s*['"]rg['"]/.test(src), false)
  assert.equal(/execFileSync\s*\(\s*['"]rg['"]/.test(src), false)
  // 且必须用 git grep，并且**只有退出码 1** 才算"没有匹配"
  assert.match(src, /git.*grep|'grep'/)
  assert.match(src, /if \(e\.status === 1\) return \[\]/)
  assert.match(src, /throw e/)
})
