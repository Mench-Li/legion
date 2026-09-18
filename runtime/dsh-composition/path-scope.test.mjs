// runtime/dsh-composition/path-scope.test.mjs
// ============================================================================
// PRT-604 的判据：文件与工作目录范围限制
//
// spec line 926：「实现文件和工作目录范围限制。」
// spec §6.6 line 449：hard floor、禁止工具、**禁止越界路径** →
//   `tools/pre-execute` 提前拒绝 **+** `ctx.tools.guard()` 最终复核
// spec §6.6 line 460：权限至少覆盖「文件读写范围」
// spec §6.6 line 454：`ctx.sandbox`「必须探测实际后端和 enforcement；仅有配置名不算生效」
//
// 一句话：**包含关系不能用字符串比**，而写操作恰好都是新文件。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PATH_SCOPE_CHECKED,
  PATH_SCOPE_VERSION,
  SCOPE_CODES,
  WINDOWS_DEVICE_NAMES,
  assertBackendEvidenceRequired,
  assertBoundaryNotPrefix,
  assertCaseRuleFollowsPlatform,
  assertHazardsRejected,
  assertNewFileResolved,
  assertSymlinkEscapeCaught,
  assertTrailingHazards,
  assertWriteScopeNarrowed,
  caseFoldsOn,
  checkPathScope,
  collapseSegments,
  contains,
  containsTextual,
  createResolver,
  describeBackendEvidence,
  narrowScopeToWorkspace,
  normalizeForCompare,
  normalizeScope,
  parsePath,
  resolveReal,
  splitAtDeepestExisting,
  stripTrailingHazards,
} from './path-scope.mjs'
import { createEnforcementBridge } from './tool-request.mjs'

const CTX = Object.freeze({
  scope: 'legion', actor: 'employee-1', action: 'file.write', taskId: 'task-1',
  cwd: 'C:/work', platform: 'win32',
})
const scope = (over = {}) => ({ read: ['/work'], write: ['/work'], platform: 'linux', ...over })
const fsOf = (real, links = {}, platform = 'linux') => createResolver({ real, links, platform })

// ------------------------------------------------- ① 边界：不是前缀

test('① ★★ `/work-evil` 不在 `/work` 之内（前缀不是边界）', () => {
  //   > 一个「用 `startsWith(root)` 判包含」的范围检查，
  //   > 与一个「/work-evil 也在 /work 之内」的范围检查，是同一个东西——
  //   > 而它的方向是放行。
  const e = assertBoundaryNotPrefix()
  assert.deepEqual(e.wrong, [], `边界判定有错：${JSON.stringify(e.wrong)}`)
  // 关键证据：`startsWith` 在**哪几行**给出错误答案
  assert.deepEqual([...e.prefixWouldBeWrongOn], ['/work-evil', '/work-evil/a.txt', '/workshop'])
  // 逐条对照（相等与更深都算在内）
  for (const s of e.samples) assert.equal(s.got, s.expected, `${s.root} ⊃ ${s.target}`)
  // 直接用 contains
  assert.equal(contains('/work', '/work'), true)
  assert.equal(contains('/work', '/work/a'), true)
  assert.equal(contains('/work', '/work-evil'), false)
  assert.equal(contains('/work', '/work-evil/a'), false)
  assert.equal(contains('/work', '/'), false)
  // 根 `/` 包含一切绝对路径
  assert.equal(contains('/', '/anything'), true)
  // `..` 折叠发生在比较之前
  assert.equal(containsTextual({ root: '/work', target: '/work/../etc', platform: 'linux' }), false)
  assert.equal(containsTextual({ root: '/work', target: '/work/sub/../a', platform: 'linux' }), true)
})

test('① ★★ `..` 必须真的往上走（不能静默变成 `.`）', () => {
  // 装载自检抓到的真缺陷：第一版 `stripTrailingHazards` 无条件剥尾点，于是 `..`
  // 被剥成空串、再兜底成 `.`——**每一个 `..` 都变成了 `.`**，路径只会往深处走。
  //
  //   > 一个「把 `..` 也当成'尾点'剥掉」的规范化，
  //   > 与一个「`..` 静默变成 `.`、于是路径永远往深处走」的规范化，是同一个东西——
  //   > 而它的方向是放行。
  //
  // 这条方向最坏的形态：`/work/sub/../../../etc` 折叠成 `/work/sub/etc`，
  // **在范围之内** —— 一次完整的越界。
  assert.deepEqual([...collapseSegments(['work', '..', 'etc'], { platform: 'win32' })], ['etc'])
  assert.deepEqual([...collapseSegments(['a', 'b', '..', 'c'], { platform: 'win32' })], ['a', 'c'])
  // 逃出根本身是**未定义**的，所以抛；不能"折成什么都不剩"。
  //
  //   > 一个「`..` 多到逃出根之后被折成空」的规范化，
  //   > 与一个「把它当成根的别名」的规范化，是同一个东西。
  assert.throws(() => collapseSegments(['..'], { platform: 'linux' }), new RegExp(SCOPE_CODES.OUT_OF_SCOPE))
  assert.throws(() => collapseSegments(['a', '..', '..', 'b'], { platform: 'linux' }), new RegExp(SCOPE_CODES.OUT_OF_SCOPE))
  // 正好回到根是允许的（`a/..` → 根）
  assert.deepEqual([...collapseSegments(['a', '..'], { platform: 'linux' })], [])
  assert.deepEqual([...collapseSegments(['a', 'b', '..', '..'], { platform: 'linux' })], [])
  // `..` 本身不被当作"尾点"
  assert.equal(stripTrailingHazards('..', { platform: 'win32' }), '..')
  assert.equal(stripTrailingHazards('.', { platform: 'win32' }), '.')
  // 而真正的尾点仍然被剥
  assert.equal(stripTrailingHazards('a.txt.', { platform: 'win32' }), 'a.txt')
  assert.equal(stripTrailingHazards('a.txt ', { platform: 'win32' }), 'a.txt')
  // 最坏形态实测：这个路径**必须**不在范围之内
  const v = checkPathScope({
    target: '/work/sub/../../../etc/passwd', scope: normalizeScope(scope()),
    direction: 'read', realpath: (p) => p, exists: () => true,
  })
  assert.equal(v.allowed, false, '`..` 逃逸被折叠掉了，路径看起来还在范围之内')
  // 报的是更具体的 `OUT_OF_SCOPE`（这个路径自己就往上逃出了根），不是笼统的"越界"：
  //   > 一个「把'路径自己就无效'报成'不在范围内'」的拒绝，
  //   > 与一个「值班的人去改范围表、而其实该改的是调用方」的拒绝，是同一个东西。
  assert.equal(v.code, SCOPE_CODES.OUT_OF_SCOPE)
  assert.match(v.reason, /逃出了根本身/)
})

// ------------------------------------------------- ② 链接逃逸

test('② ★★ 允许目录里的链接指向外面 → 必须拦下（且报成"链接逃逸"）', () => {
  //   > 一个「只比路径字符串、不解析链接」的范围检查，
  //   > 与一个「在允许目录里放一个指向 /etc 的链接就得到了 /etc」的范围检查，
  //   > 是同一个东西——而它的方向是放行。
  const e = assertSymlinkEscapeCaught()
  assert.equal(e.textualWouldAllow, true, '夹具：纯字符串判定应当认为它在范围之内')
  assert.equal(e.allowed, false, '链接逃逸被放行了')
  assert.equal(e.code, SCOPE_CODES.SYMLINK_ESCAPE)
  assert.equal(e.resolved, '/etc/passwd')
  assert.match(e.verdict.reason, /链接逃逸/)

  const r = fsOf(['/work', '/etc', '/etc/passwd'], { '/work/etc': '/etc' })
  const s = normalizeScope(scope())
  // 链接之外的普通路径仍然放行
  assert.equal(checkPathScope({ target: '/work/a.txt', scope: s, direction: 'write', realpath: r.realpath, exists: r.exists }).allowed, true)
  // 链接本身指向外 → 拦
  assert.equal(checkPathScope({ target: '/work/etc/passwd', scope: s, direction: 'read', realpath: r.realpath, exists: r.exists }).allowed, false)
  // 中间段是链接（`/work/etc/sub/x`）也要解析
  const deep = fsOf(['/work', '/etc', '/etc/sub', '/etc/sub/x'], { '/work/etc': '/etc' })
  assert.equal(checkPathScope({ target: '/work/etc/sub/x', scope: s, direction: 'read', realpath: deep.realpath, exists: deep.exists }).allowed, false)
})

test('② ★★ 链接套链接：接回来的那一段**自己还会走链接**', () => {
  //   > 一个「只解析最深存在前缀、剩下那段直接拼接」的解析，
  //   > 与一个「在链接目录下面再套一层链接就逃出去了」的解析，是同一个东西——
  //   > 而它的方向是放行。
  //
  // `exists()` 看不穿链接：`/work/link1/link2/f` 在真实 fs 上也不存在，
  // 于是最深存在前缀是 `/work/link1`（它是链接），解析成 `/base`，
  // 接回 `link2/f` 得到 `/base/link2/f` —— 而 `link2` 自己也是一个链接。
  const r = fsOf(
    ['/work', '/base', '/base/link2', '/deep', '/deep/f'],
    { '/work/link1': '/base', '/base/link2': '/deep' },
  )
  const s = normalizeScope(scope()) // read/write 都是 /work
  const v = checkPathScope({ target: '/work/link1/link2/f', scope: s, direction: 'write', realpath: r.realpath, exists: r.exists })
  assert.equal(v.allowed, false, '两层链接之后的路径被放行了')
  assert.equal(v.code, SCOPE_CODES.SYMLINK_ESCAPE)
  assert.equal(v.targetResolved, '/deep/f', '接回来的那一段没有被重新解析')
  // 单层链接，且链接**指向范围内** → 放行（对照：证明上面的拒绝不是"见到链接就拒"）
  //
  //   > 一个「见到链接就拒绝」的范围检查，
  //   > 与一个「项目里用链接整理目录就整个不能写」的范围检查，是同一个东西。
  const one = fsOf(['/work', '/work/real', '/work/real/f'], { '/work/link1': '/work/real' })
  const v1 = checkPathScope({ target: '/work/link1/f', scope: s, direction: 'write', realpath: one.realpath, exists: one.exists })
  assert.equal(v1.allowed, true, '链接指向仍在范围内的位置，应当放行')
  assert.equal(v1.targetResolved, '/work/real/f')
  // 而同一个链接指向范围外 → 拒绝
  const oneOut = fsOf(['/work', '/base', '/base/f'], { '/work/link1': '/base' })
  assert.equal(checkPathScope({ target: '/work/link1/f', scope: s, direction: 'write', realpath: oneOut.realpath, exists: oneOut.exists }).allowed, false)
  // 解析轮数留证：叠的链接越多，需要的轮数越多（每轮只解析最深存在前缀，
  // 所以"套了几层"这件事是可查的事实，不是靠猜）。
  const r1 = resolveReal({ path: '/work/link1/f', realpath: one.realpath, exists: one.exists, platform: 'linux' })
  const r2 = resolveReal({ path: '/work/link1/link2/f', realpath: r.realpath, exists: r.exists, platform: 'linux' })
  assert.ok(r1.rounds >= 1, `一轮都要不了：${r1.rounds}`)
  assert.ok(r2.rounds > r1.rounds, `两层链接没有比一层多花轮数：r1=${r1.rounds} r2=${r2.rounds}`)
  assert.equal(r1.resolved, '/work/real/f')
  assert.equal(r2.resolved, '/deep/f')
  // 自我展开的链接表 → 拒绝，不能无限转。
  //
  // 注意区分两种"环"：`/loop/a → /loop` 会**收敛**（每轮吃掉一段），
  // 而 `/loop/a → /loop/a/a` 每轮**变长**，永远不稳定。
  //
  //   > 一个「递归解析但有轮数上限」的实现，
  //   > 与一个「链接表能自我加长时把进程转死」的实现，是同一个东西。
  const converges = fsOf(['/work', '/loop'], { '/loop/a': '/loop' })
  assert.equal(resolveReal({ path: '/loop/a/a/a/f', realpath: converges.realpath, exists: converges.exists, platform: 'linux' }).resolved, '/loop/f')
  const diverges = fsOf(['/work', '/loop'], { '/loop/a': '/loop/a/a' })
  assert.throws(
    () => resolveReal({ path: '/loop/a/f', realpath: diverges.realpath, exists: diverges.exists, platform: 'linux' }),
    new RegExp(SCOPE_CODES.UNRESOLVED),
  )
  assert.throws(
    () => resolveReal({ path: '/loop/a/f', realpath: diverges.realpath, exists: diverges.exists, platform: 'linux' }),
    /无限自我展开/,
  )
})

test('② ★★ 根自己也要解析（根被换成链接 → 不能整片失效）', () => {
  //   > 一个「只解析目标、不解析根」的范围检查，
  //   > 与一个「根被换成一个链接之后就整片失效」的范围检查，是同一个东西。
  // 根 `/work` 是一个指向 `/elsewhere` 的链接；目标用 `/work/a.txt`。
  // 解析后目标是 `/elsewhere/a.txt`，解析后的根是 `/elsewhere` → 内部 → 放行。
  const r = fsOf(['/elsewhere', '/elsewhere/a.txt'], { '/work': '/elsewhere' })
  const s = normalizeScope(scope())
  const v = checkPathScope({ target: '/work/a.txt', scope: s, direction: 'write', realpath: r.realpath, exists: r.exists })
  assert.equal(v.allowed, true, '根是链接时被误拒了')
  assert.equal(v.targetResolved, '/elsewhere/a.txt')
  assert.equal(v.rootMatched, '/work')
  // 而根是链接、目标逃到链接之外 → 拦
  const r2 = fsOf(['/elsewhere', '/etc/passwd'], { '/work': '/elsewhere' })
  // `/work/../etc/passwd` 文本折叠后是 `/etc/passwd`：文本层面就不在范围内
  const v2 = checkPathScope({ target: '/work/../etc/passwd', scope: s, direction: 'read', realpath: r2.realpath, exists: r2.exists })
  assert.equal(v2.allowed, false)
})

// ------------------------------------------------- ③ 写操作恰好都是新文件

test('③ ★★ 新建文件也必须解析（不能"解析不了就跳过"）', () => {
  //   > 一个「只对已存在的文件做真实路径解析」的范围检查，
  //   > 与一个「新建文件时静默跳过解析」的范围检查，是同一个东西——
  //   > 而写操作恰好都是新建文件。
  const e = assertNewFileResolved()
  assert.equal(e.createsNew, true, '夹具：目标必须是一个还不存在的文件')
  assert.equal(e.escaped.allowed, false, '链接目录下的**新文件**被放行了')
  assert.equal(e.escaped.code, SCOPE_CODES.SYMLINK_ESCAPE)
  assert.equal(e.escaped.resolved, '/elsewhere/new-file.txt')
  assert.equal(e.plain.allowed, true, '普通目录下的新文件被误拒')
  assert.equal(e.plain.createsNew, true)
  assert.equal(e.plain.resolved, '/work/sub/new-file.txt')
  // 最深存在前缀 + 剩余段
  assert.equal(e.split.existing, '/work/sub')
  assert.deepEqual([...e.split.missing], ['new-file.txt'])
  assert.equal(e.split.createsNew, true)
  // 目录本身都不存在时也要能切（一层一层往上找）
  const noSub = fsOf(['/work'])
  const split = splitAtDeepestExisting({ path: '/work/a/b/c.txt', exists: noSub.exists, platform: 'linux' })
  assert.equal(split.existing, '/work')
  assert.deepEqual([...split.missing], ['a', 'b', 'c.txt'])
  // 连根都不存在 → 拒绝
  const none = fsOf([])
  assert.throws(() => splitAtDeepestExisting({ path: '/nope/a.txt', exists: none.exists, platform: 'linux' }), new RegExp(SCOPE_CODES.UNRESOLVED))
})

test('③ ★★ 没有解析器时**抛**，不降级为"跳过解析"', () => {
  //   > 一个「解析器不可用就放行」的降级，
  //   > 与一个「强制面可以被一次配置疏漏关掉」的降级，是同一个东西。
  assert.throws(() => resolveReal({ path: '/work/a.txt', exists: () => true, platform: 'linux' }), new RegExp(SCOPE_CODES.RESOLVER_MISSING))
  assert.throws(() => resolveReal({ path: '/work/a.txt', exists: () => true, platform: 'linux' }), /realpath/)
  assert.throws(() => splitAtDeepestExisting({ path: '/work/a.txt', platform: 'linux' }), new RegExp(SCOPE_CODES.RESOLVER_MISSING))
  // 解析器返回空值也算解析不出来 → 拒绝（而 checkPathScope 把它变成 allowed:false）
  const v = checkPathScope({
    target: '/work/a.txt', scope: normalizeScope(scope()), direction: 'read',
    realpath: () => null, exists: () => true,
  })
  assert.equal(v.allowed, false)
  assert.equal(v.code, SCOPE_CODES.UNRESOLVED)
  // 解析器本身抛（真实 fs 权限错误等）→ 也拒绝
  const v2 = checkPathScope({
    target: '/work/a.txt', scope: normalizeScope(scope()), direction: 'read',
    realpath: () => { throw new Error('EPERM') }, exists: () => true,
  })
  assert.equal(v2.allowed, false)
  assert.match(v2.reason, /EPERM/)
})

// ------------------------------------------------- ④ Windows 的那些坑

test('④ ★★ 盘符相对 / 无盘符 / 设备命名空间 / 设备名 一律拒绝', () => {
  const e = assertHazardsRejected()
  assert.deepEqual(e.mismatched, [], `有样本没被按预期拒绝：${JSON.stringify(e.mismatched)}`)
  for (const s of e.samples) assert.equal(s.code, s.expected, `${s.path}@${s.platform}`)
  // `C:foo` 是盘符**相对**路径（相对该盘的当前目录），不是绝对路径
  assert.throws(() => parsePath('C:foo', { platform: 'win32' }), new RegExp(SCOPE_CODES.NOT_ABSOLUTE))
  assert.throws(() => parsePath('C:foo', { platform: 'win32' }), /盘符相对/)
  // `\foo` 是"当前盘"，随进程而变
  assert.throws(() => parsePath('\\foo', { platform: 'win32' }), /没有盘符/)
  // 设备命名空间：那里的 `..` 与尾点规则都不同，不假装能理解
  assert.throws(() => parsePath('\\\\?\\C:\\work\\a', { platform: 'win32' }), /设备命名空间/)
  // 设备名：**无论有没有扩展名**都生效
  for (const d of ['NUL', 'CON', 'PRN', 'AUX', 'COM1', 'LPT9']) {
    assert.throws(() => normalizeForCompare(`C:\\work\\${d}`, { platform: 'win32' }), /设备名/, d)
    assert.throws(() => normalizeForCompare(`C:\\work\\${d.toLowerCase()}.txt`, { platform: 'win32' }), /设备名/, `${d}.txt`)
  }
  assert.equal(WINDOWS_DEVICE_NAMES.length, 22)
  // 而正常的名字（含 `nul` 作为**子串**）安静通过
  assert.equal(normalizeForCompare('C:\\work\\nullable.txt', { platform: 'win32' }).key, 'c:/work/nullable.txt')
  assert.equal(normalizeForCompare('C:\\work\\console.log', { platform: 'win32' }).key, 'c:/work/console.log')
})

test('④ ★★ 尾点尾空格必须剥（`etc.` 与 `etc` 是同一个位置）', () => {
  const e = assertTrailingHazards()
  assert.equal(e.windows.same, true, '`..\\etc.` 与 `..\\etc` 折叠结果不同')
  assert.equal(e.windows.trailingDots, 'c:/etc')
  for (const s of e.samples) {
    assert.equal(s.stripped, s.segment.replace(/[. ]+$/, '') || '.', s.segment)
    // Linux 上**不**剥：那里的尾点是名字的一部分
    assert.equal(s.untouchedOnLinux, s.segment)
  }
  // 实测：`/work/../etc.` 在 win32 上折叠后是 `c:/etc` —— 必须被拦
  const v = checkPathScope({
    target: 'C:\\work\\..\\etc.', scope: normalizeScope({ read: ['C:\\work'], write: ['C:\\work'], platform: 'win32' }),
    direction: 'write', realpath: (p) => p, exists: () => true,
  })
  assert.equal(v.allowed, false, '尾点让它看起来还在范围之内')
})

test('④ ★★ 大小写规则**跟着平台走**，平台不认识就抛', () => {
  const e = assertCaseRuleFollowsPlatform()
  assert.equal(e.win32.same, true, 'win32 上大小写应当折叠')
  assert.equal(e.linux.same, false, 'linux 上大小写应当敏感')
  assert.equal(e.unknownPlatformCode, SCOPE_CODES.CASE_RULE)
  assert.equal(caseFoldsOn('win32'), true)
  assert.equal(caseFoldsOn('darwin'), true)
  assert.equal(caseFoldsOn('linux'), false)
  // 不给默认值
  assert.throws(() => caseFoldsOn('plan9'), new RegExp(SCOPE_CODES.CASE_RULE))
  assert.throws(() => caseFoldsOn(undefined), /大小写规则未知/)
  assert.throws(() => normalizeForCompare('/x', {}), new RegExp(SCOPE_CODES.CASE_RULE))
})

test('④ ★ UNC 路径要有自己的根（不是盘符）', () => {
  const p = parsePath('\\\\server\\share\\sub\\a.txt', { platform: 'win32' })
  assert.equal(p.kind, 'unc')
  assert.equal(p.root, '//server/share')
  assert.deepEqual([...p.segments], ['sub', 'a.txt'])
  assert.equal(normalizeForCompare('\\\\server\\share\\sub\\a.txt', { platform: 'win32' }).key, '//server/share/sub/a.txt')
  // 另一个 share 不在同一个根之内
  assert.equal(contains('//server/share', '//server/share2/a'), false)
  assert.equal(contains('//server/share', '//server/share/a'), true)
})

// ------------------------------------------------- ⑤ 范围表只能收窄

test('⑤ ★★ 写范围必须是读范围的子集', () => {
  //   > 一个「写范围可以大于读范围」的范围表，
  //   > 与一个「写不了的东西先读出来、再写到别处」的范围表，是同一个东西。
  const e = assertWriteScopeNarrowed()
  assert.equal(e.widenedWriteCode, SCOPE_CODES.WRITE_NOT_IN_READ)
  assert.deepEqual([...e.ok.write], ['/work/sub'])
  assert.throws(() => normalizeScope({ read: ['/work'], write: ['/etc'], platform: 'linux' }), /写范围必须是读范围的子集/)
  // 字段必须闭合（同 PRT-603 的纪律）
  assert.throws(() => normalizeScope({ read: ['/work'], write: ['/work'], platform: 'linux', denyPaths: ['/etc'] }), /不认识的字段/)
  assert.throws(() => normalizeScope({ read: ['/work'], platform: 'linux' }), /read 与 write/)
  assert.throws(() => normalizeScope(null), /需要一份范围对象/)
  // 空写范围是安全的（什么都不许写）
  assert.deepEqual([...normalizeScope({ read: ['/work'], write: [], platform: 'linux' }).write], [])
  // 空读范围 + 非空写范围 → 拒绝（写不在读之内）
  assert.throws(() => normalizeScope({ read: [], write: ['/work'], platform: 'linux' }), new RegExp(SCOPE_CODES.WRITE_NOT_IN_READ))
})

test('⑤ ★★ 写一行 `version` 不能跳过范围表的校验', () => {
  // 与 PRT-603 同一个形状：第一版 `checkPathScope` / `narrowScopeToWorkspace` 写的是
  // `scope?.version === PATH_SCOPE_VERSION ? scope : normalizeScope(scope)`，
  // 于是手工构造一个带 `version` 的范围表就跳过了**全部**校验。
  //
  //   > 一个「看到 version 字段就认为它已经校验过」的校验，
  //   > 与一个「在范围表里写一行 version 就能跳过所有检查」的校验，是同一个东西。
  const handMade = { version: PATH_SCOPE_VERSION, read: ['/work'], write: ['/etc'], platform: 'linux' }
  assert.throws(() => checkPathScope({ target: '/etc/passwd', scope: handMade, direction: 'write', realpath: (p) => p, exists: () => true }), new RegExp(SCOPE_CODES.WRITE_NOT_IN_READ), '带 version 的范围表跳过了 write ⊆ read 校验')
  assert.throws(() => narrowScopeToWorkspace({ scope: handMade, workspaceRoot: '/etc' }), new RegExp(SCOPE_CODES.WRITE_NOT_IN_READ))
  assert.throws(() => checkPathScope({ target: '/work/a', scope: { version: PATH_SCOPE_VERSION, read: ['/work'], write: ['/work'], platform: 'linux', denyPaths: [] }, direction: 'read', realpath: (p) => p, exists: () => true }), /不认识的字段/)
  assert.throws(() => checkPathScope({ target: '/work/a', scope: { version: 'legion/path-scope@0', read: ['/work'], write: ['/work'], platform: 'linux' }, direction: 'read', realpath: (p) => p, exists: () => true }), /version/)
})

test('⑤ ★★ 归一化必须**接受自己的输出**（幂等）', () => {
  // 装载自检撞到的真缺陷：`normalizeScope` 的输出带 `version`，而字段闭合名单里
  // 没有 `version` → `normalizeScope(normalizeScope(x))` 直接抛"不认识的字段"。
  //
  //   > 一个「接受不了自己的输出」的归一化，
  //   > 与一个「第二次经过就抛」的归一化，是同一个东西。
  const once = normalizeScope({ read: ['/work'], write: ['/work/sub'], platform: 'linux' })
  const twice = normalizeScope(once)
  assert.deepEqual({ ...twice, read: [...twice.read], write: [...twice.write] },
    { ...once, read: [...once.read], write: [...once.write] })
  assert.equal(twice.version, PATH_SCOPE_VERSION)
  // 收窄的输出也必须是可再次归一化的（它带 version 与 cwd）
  const narrowed = narrowScopeToWorkspace({ scope: once, workspaceRoot: '/work/sub/deep' })
  const again = normalizeScope(narrowed)
  assert.deepEqual([...again.write], ['/work/sub/deep'])
  assert.equal(again.cwd, '/work/sub/deep')
  // 判定接受归一化后的对象（它每次都会再归一化一遍）
  const r = fsOf(['/work/sub', '/work/sub/deep'])
  assert.equal(checkPathScope({ target: '/work/sub/deep/a.txt', scope: narrowed, direction: 'write', realpath: r.realpath, exists: r.exists }).allowed, true)
})

test('⑤ ★★ `workspaceRoot` 进一步收窄是**取交集**，不是筛选', () => {
  // 第一版写的是"只保留落在 workspaceRoot 之内的写根"，于是
  // `write:['/work/sub']` + `workspaceRoot:'/work/sub/deep'` 被判成"没有交集"——
  // 而正确答案是 `/work/sub/deep`。
  //
  //   > 一个「把'工作目录比写根更深'当成'没有交集'」的收窄，
  //   > 与一个「岗位配了一个更深的目录就什么都写不了」的收窄，是同一个东西。
  const e = assertWriteScopeNarrowed()
  assert.deepEqual([...e.narrowed.write], ['/work/sub/deep'])
  assert.equal(e.narrowed.cwd, '/work/sub/deep')
  assert.deepEqual([...e.narrowed.read], ['/work'], '读范围不该被工作目录动到')
  // 三种关系
  const s = normalizeScope({ read: ['/work'], write: ['/work/sub'], platform: 'linux' })
  assert.deepEqual([...narrowScopeToWorkspace({ scope: s, workspaceRoot: '/work/sub/deep' }).write], ['/work/sub/deep'])
  assert.deepEqual([...narrowScopeToWorkspace({ scope: s, workspaceRoot: '/work' }).write], ['/work/sub'])
  assert.deepEqual([...narrowScopeToWorkspace({ scope: s, workspaceRoot: '/work/sub' }).write], ['/work/sub'])
  // 毫无交集 → 抛（配置一定错了）
  assert.throws(() => narrowScopeToWorkspace({ scope: s, workspaceRoot: '/elsewhere' }), new RegExp(SCOPE_CODES.OUT_OF_SCOPE))
  // 不传工作目录 → 内容原样返回（**总是**归一化，所以是新对象，但不是同一个引用）
  const same = narrowScopeToWorkspace({ scope: s, workspaceRoot: null })
  assert.deepEqual({ ...same, read: [...same.read], write: [...same.write] }, { ...s, read: [...s.read], write: [...s.write] })
  assert.deepEqual([...same.write], [...s.write])
  assert.deepEqual([...same.read], [...s.read])
  // 收窄之后 write ⊆ read 这条不变量必须仍然成立
  const narrowed = narrowScopeToWorkspace({ scope: s, workspaceRoot: '/work/sub/deep' })
  assert.ok(narrowed.write.every((w) => narrowed.read.some((r) => contains(r, w))))
})

// ------------------------------------------------- ⑥ 判定与接线

test('⑥ ★★ 写范围与读范围各自生效（写比读窄时不能借道写）', () => {
  const s = normalizeScope({ read: ['/work'], write: ['/work/sub'], platform: 'linux' })
  const r = fsOf(['/work', '/work/sub', '/work/a.txt', '/work/sub/b.txt'])
  const readOut = checkPathScope({ target: '/work/a.txt', scope: s, direction: 'read', realpath: r.realpath, exists: r.exists })
  assert.equal(readOut.allowed, true)
  const writeOut = checkPathScope({ target: '/work/a.txt', scope: s, direction: 'write', realpath: r.realpath, exists: r.exists })
  assert.equal(writeOut.allowed, false, '写范围之外的写被放行了')
  assert.equal(writeOut.code, SCOPE_CODES.OUTSIDE_WRITE)
  assert.match(writeOut.reason, /不在写范围/)
  assert.equal(checkPathScope({ target: '/work/sub/b.txt', scope: s, direction: 'write', realpath: r.realpath, exists: r.exists }).allowed, true)
  // 方向参数不认识 → 抛（不是默认成 read）
  assert.throws(() => checkPathScope({ target: '/work/a.txt', scope: s, direction: 'append', realpath: r.realpath, exists: r.exists }), /必须是 read 或 write/)
  // 空范围 → 拒绝，且码区分读/写
  const none = normalizeScope({ read: [], write: [], platform: 'linux' })
  assert.equal(checkPathScope({ target: '/work/a.txt', scope: none, direction: 'read', realpath: r.realpath, exists: r.exists }).code, SCOPE_CODES.OUTSIDE_READ)
  assert.equal(checkPathScope({ target: '/work/a.txt', scope: none, direction: 'write', realpath: r.realpath, exists: r.exists }).code, SCOPE_CODES.OUTSIDE_WRITE)
  // 每个判定都要说清楚"靠哪个根通过的"
  const ok = checkPathScope({ target: '/work/sub/b.txt', scope: s, direction: 'write', realpath: r.realpath, exists: r.exists })
  assert.equal(ok.rootMatched, '/work/sub')
  assert.equal(ok.targetResolved, '/work/sub/b.txt')
})

test('⑥ ★★ pre-execute 与 guard **两处**都查路径范围（spec §6.6 line 449）', async () => {
  //   > 一个「只在 pre-execute 查路径范围」的组合，
  //   > 与一个「guard 那一层已经换成了另一份范围表」的组合，是同一个东西——
  //   > 而 guard 正是"不可撤销"的那一道。
  const s = normalizeScope(scope({ platform: 'win32', read: ['C:\\work'], write: ['C:\\work'] }))
  // 夹具必须让**越界的那个目标也能被解析出来**，否则它先以"解析不出来"被拒，
  // 那条越界分支就永远走不到（同 PRT-603 的"被前一道更宽的规则挡住"）。
  const r = fsOf(['C:\\work', 'C:\\etc', 'C:\\etc\\passwd'], {}, 'win32')
  const scopeGuardFn = (p) => checkPathScope({
    target: p.target, scope: s, direction: 'write', realpath: r.realpath, exists: r.exists,
  })
  const bridge = createEnforcementBridge({ context: CTX, pathScope: scopeGuardFn, decide: () => ({ kind: 'allow' }) })

  // 范围内：pre-execute 放行，guard 也放行
  const insideExec = { name: 'write-file', callId: 'c1', arguments: { path: 'C:\\work\\a.txt' } }
  assert.equal((await bridge.preExecute(insideExec)).kind, 'allow')
  assert.equal(bridge.guard(insideExec), undefined)

  // 范围外：**两处都拒绝**，而且理由都指向路径越界
  const outside = { name: 'write-file', callId: 'c2', arguments: { path: 'C:\\etc\\passwd' } }
  const d = await bridge.preExecute(outside)
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /路径越界/)
  assert.match(d.reason, new RegExp(SCOPE_CODES.OUTSIDE_WRITE))
  const g = bridge.guard(outside)
  assert.ok(typeof g === 'string' && g.includes('路径越界'), `guard 没有复核路径范围：${g}`)

  // 证据：两道都拒绝，且都在账上
  const p = bridge.projectionFor(outside).projection
  const sources = bridge.ledgerOf(p.canonicalHash).map((e) => `${e.source}:${e.decision}`)
  assert.ok(sources.includes('guard:deny'), `guard 没记账：${JSON.stringify(sources)}`)
  assert.ok(sources.includes('pre-execute:deny'), `pre-execute 没记账：${JSON.stringify(sources)}`)
})

test('⑥ ★★ 路径范围在**白名单之前**（两者拒绝的理由不同、修复动作也不同）', async () => {
  let whitelistCalls = 0
  const s = normalizeScope(scope({ platform: 'win32', read: ['C:\\work'], write: ['C:\\work'] }))
  const r = fsOf(['C:\\work'], {}, 'win32')
  const bridge = createEnforcementBridge({
    context: CTX,
    pathScope: (p) => checkPathScope({ target: p.target, scope: s, direction: 'write', realpath: r.realpath, exists: r.exists }),
    whitelist: () => { whitelistCalls += 1; return { allowed: true, rule: null, reason: null } },
    decide: () => ({ kind: 'allow' }),
  })
  const d = await bridge.preExecute({ name: 'write-file', callId: 'c1', arguments: { path: 'C:\\etc\\passwd' } })
  assert.equal(d.kind, 'deny')
  assert.match(d.reason, /路径越界/)
  assert.equal(whitelistCalls, 0, '越界的调用仍然去问了岗位白名单——顺序反了')
})

test('⑥ ★★ 路径范围检查本身出错 → 拒绝，不炸掉强制面', async () => {
  // 与 `projectionFor` 同理：检查抛错必须变成一次拒绝。
  const bridge = createEnforcementBridge({
    context: CTX,
    pathScope: () => { throw Object.assign(new Error('boom'), { code: 'path-scope-malformed' }) },
    decide: () => ({ kind: 'allow' }),
  })
  const d = await bridge.preExecute({ name: 'write-file', callId: 'c1', arguments: { path: 'C:\\work\\a.txt' } })
  assert.equal(d.kind, 'deny', '检查抛错时被放行了')
  assert.match(d.reason, /路径范围检查本身出错/)
  assert.match(d.reason, /path-scope-malformed/)
  // 返回非对象 / allowed 不是 true 也算拒绝
  for (const bad of [() => null, () => ({}), () => 'ok', () => ({ allowed: 'true', code: 'x' })]) {
    const b = createEnforcementBridge({ context: CTX, pathScope: bad, decide: () => ({ kind: 'allow' }) })
    const r = await b.preExecute({ name: 'write-file', callId: 'c1', arguments: { path: 'C:\\work\\a.txt' } })
    assert.equal(r.kind, 'deny')
    assert.match(r.reason, /路径越界/)
  }
})

test('⑥ ★★ 没接上的强制面必须能被读出来（配置里写了 ≠ 挂上了）', () => {
  //   > 一个「端口是可选的、但没有任何地方能看出它没接」的桥，
  //   > 与一个「以为范围限制在生效、其实那道检查根本没挂」的桥，是同一个东西。
  const bare = createEnforcementBridge({ context: CTX })
  // ★ 2026-09-18：多了 `connectorFeedback` 一格（F-21 第二半）。
  //   这一格**必须**在这里显式写出来——它报的是"反馈面装了没有"，
  //   而"没装"（`false`）正是这条用例存在的理由：
  //   > 一个「端口是可选的、但没有任何地方能看出它没接」的桥，
  //   > 与一个「以为范围限制在生效、其实那道检查根本没挂」的桥，是同一个东西。
  //   本批之前这一格**根本不存在**，所以"连接器反馈面没装"**读不出来**。
  assert.deepEqual(bare.enforcementSurfaces(), {
    hardFloor: true, pathScope: false, whitelist: false, policy: false, approval: false,
    connectorFeedback: false,
    // ★ 2026-09-18：又多了 `connectorJudgment` 一格（F-21 **第一半**）。
    //
    //   为什么它必须与上面那一格**分开**：一个"反馈面装了、判定面没装"的强制面，
    //   与一个"连接器失败被记下来了、但记下来之后谁也不看"的强制面，
    //   在只有 `connectorFeedback` 一格的读数里是同一个东西。
    connectorJudgment: false,
    // ★★★ 2026-09-18 第 19 轮：又多了 `executionScope` 一格（PRT-605 的命令/网络/MCP）。
    //
    //   为什么它必须与 `pathScope` **分格**（它们形状相同、时点相同）：
    //   两道范围检查对应**两份不同的配置**（`LEGION_PATH_SCOPE` /
    //   `LEGION_EXECUTION_SCOPE`）。
    //   一格读数下，"路径范围配好了、执行面授权表漏了"与"两道都配好了"是同一个东西——
    //   而值班的人要修的配置完全不同。
    executionScope: false,
    // ★★★ 2026-09-18 第 20 轮：又多了 `externalApiScope` 一格（PRT-606 的外部 API 读/写）。
    //
    //   它必须**再分一格**，理由与上面那一段一字不差：这是**第三份**配置
    //   （`LEGION_EXTERNAL_API_SCOPE`）。三合一的话，"路径范围配好了、
    //   执行面与外部 API 都漏了"与"三道全配好了"读起来是同一个东西。
    //
    //   ★ 三道范围检查至此**全部**有了位置——这个键集从 7 格长到 9 格，
    //     每一次长一格都是被"接上了而读数读不出来"逼出来的。
    externalApiScope: false,
  })
  const full = createEnforcementBridge({
    context: CTX,
    pathScope: () => ({ allowed: true }),
    whitelist: () => ({ allowed: true }),
    decide: () => ({ kind: 'allow' }),
    requestApproval: async () => 'rejected',
  })
  assert.deepEqual(full.enforcementSurfaces(), {
    hardFloor: true, pathScope: true, whitelist: true, policy: true, approval: true,
    // ★ 没传 listener ⇒ 仍然是 `false`。这不是"漏了"，是**如实**：
    //   上面那条桥给了四个端口但没给连接器声明。
    connectorFeedback: false,
    // ★ 同上：`policy: true` **不能**代替这一格。
    //   判定面是接在策略门**外面**的一层（它把连接器层的意见与政策门的意见取严合并），
    //   所以两者都存在时 `policy` 与这一格同时为 `true` —— 它们不是同一件事。
    connectorJudgment: false,
    // ★ 同上：这条桥给了四个端口，但**没有**给执行面授权表 ⇒ `false`。
    //   ★★ 这一格与 `pathScope: true` 同时出现，正是"两格必须分开"的**活证据**：
    //     路径范围配好了、执行面没配，两种状态都在这一行里读得出来。
    executionScope: false,
    // ★ 同上：这条桥给了四个端口，但**没有**给外部 API 授权表 ⇒ `false`。
    //   三道范围检查在这里同时出现"一道 true、两道 false"——这就是分格的用处。
    externalApiScope: false,
  })
  // 而硬 floor 永远是挂着的（它不是可选端口）
  assert.equal(bare.enforcementSurfaces().hardFloor, true)
})

// ------------------------------------------------- ⑦ 沙箱：配置名不算证据

test('⑦ ★★ `sandbox: workspace-write` 这行配置**不算**证据', () => {
  // spec §6.6 line 454：「必须探测实际后端和 enforcement；**仅有配置名不算生效**」。
  //
  //   > 一个「看到 `sandbox: workspace-write` 就认为范围限制在生效」的判定，
  //   > 与一个「沙箱后端根本没启动、而所有人都以为它在」的判定，是同一个东西。
  const e = assertBackendEvidenceRequired()
  assert.equal(e.namedOnly.configuredNameOnly, true)
  assert.equal(e.namedOnly.effective, false, '只有配置名却被判成"已生效"')
  assert.match(e.namedOnly.note, /未生效/)
  assert.equal(e.probed.effective, true)
  assert.equal(e.probed.configuredNameOnly, false)
  assert.equal(e.missing.effective, false)
  assert.equal(e.missing.sandboxMode, null)
  // 直接调
  assert.equal(describeBackendEvidence({ sandboxMode: 'danger-full-access', probed: undefined }).effective, false)
  assert.equal(describeBackendEvidence({ sandboxMode: 'danger-full-access', probed: true }).effective, true)
  assert.equal(describeBackendEvidence({}).note, null)
})

// ------------------------------------------------- ⑧ 装载时证据

test('⑧ ★★ 装载时留下的证据都是**算出来的产物**', () => {
  const e = PATH_SCOPE_CHECKED
  assert.equal(e.version, PATH_SCOPE_VERSION)
  assert.deepEqual(e.boundary.wrong, [])
  assert.equal(e.boundary.prefixWouldBeWrongOn.length, 3)
  assert.equal(e.symlink.textualWouldAllow, true)
  assert.equal(e.symlink.allowed, false)
  assert.equal(e.symlink.code, SCOPE_CODES.SYMLINK_ESCAPE)
  assert.equal(e.newFile.createsNew, true)
  assert.equal(e.newFile.escaped.allowed, false)
  assert.equal(e.newFile.plain.allowed, true)
  assert.equal(e.trailing.windows.same, true)
  assert.equal(e.caseRule.win32.same, true)
  assert.equal(e.caseRule.linux.same, false)
  assert.equal(e.caseRule.unknownPlatformCode, SCOPE_CODES.CASE_RULE)
  assert.deepEqual(e.hazards.mismatched, [])
  assert.equal(e.hazards.samples.length, 15)
  assert.equal(e.scopeTable.widenedWriteCode, SCOPE_CODES.WRITE_NOT_IN_READ)
  assert.deepEqual([...e.scopeTable.narrowed.write], ['/work/sub/deep'])
  assert.equal(e.backend.namedOnly.effective, false)
  assert.equal(e.backend.probed.effective, true)
  // 自检之间必须自洽：链接逃逸那条用的就是同一套判定
  assert.equal(e.symlink.verdict.targetResolved, e.symlink.resolved)
})
