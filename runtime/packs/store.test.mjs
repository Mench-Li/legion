// runtime/packs/store.test.mjs
// ============================================================================
// PRT-1003 的判据：安装、启用、停用和升级**记录**。
//
// spec §6.13 line 568：「安装、启用、停用和升级记录。」
//
// 这个文件要钉住的是一件容易被"看起来实现了"骗过去的事：
// 记录不是日志，而是**状态的唯一来源**。所以每一条用例问的都是
// "账上写了什么、从账上能不能推回来"，而不是"函数返回了成功"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  PACK_MANIFEST_VERSION,
  SAMPLE_HOST,
  contentHashOfEntries,
  normalizePackManifest,
  normalizePayload,
  preflightManifest,
  samplePack,
} from './manifest.mjs'
import {
  PACK_RECORD_KINDS,
  PACK_STORE_VERSION,
  STORE_CODES,
  createPackStore,
} from './store.mjs'

const codeOf = (fn) => {
  try {
    fn()
    return null
  } catch (err) {
    return err?.code ?? 'threw-without-code'
  }
}

/**
 * 造一个版本号不同、**内容也不同**的包。
 *
 * 内容必须真的不一样：`upgrade` 会拒"版本号变了而内容没变"，
 * 而那是刻意的——一条写不出任何信息的升级记录不该存在。
 */
function packAt(version, { extra = '' } = {}) {
  const base = samplePack()
  const files = base.files.map((f, i) => (i === 0 ? { path: f.path, text: `${f.text}// ${version}${extra}\n` } : f))
  const entries = normalizePayload(files)
  const manifest = {
    ...base.manifest,
    version,
    contents: entries.map((e) => ({ path: e.path, sha256: e.sha256, chars: e.chars })),
    contentHash: contentHashOfEntries(entries),
  }
  const verdict = preflightManifest({
    manifest, files, host: SAMPLE_HOST, installed: [], builtinPackIds: [manifest.packId],
  })
  assert.equal(verdict.ok, true, `夹具 ${version} 自己没过预检：${JSON.stringify(verdict.problems.map((p) => p.code))}`)
  // store 只接受已归一化的 manifest（`metaFrom` 会核对 manifestVersion）
  return { manifest: normalizePackManifest(manifest), files, verdict }
}

const V1 = packAt('1.0.0')
const V2 = packAt('1.1.0')
const PACK_ID = V1.manifest.packId

// --------------------------------------------------------------- 形状

test('① 账的形态版本与**五类**记录是常量；第五类正是 `rollback`', () => {
  assert.equal(PACK_STORE_VERSION, 'legion/pack-store@1')
  // ★ 这条用例曾经断言"没有第五类"。那条断言与 §4.4 对 F-20 的要求
  //   「安装可回滚」直接矛盾：回滚要么有自己的记录类型，要么只能伪装成
  //   一次 install / upgrade —— 而那样账上就看不出方向。
  //   现在它断言的是"恰好这五类"，把"随便加第六类"仍然堵住。
  assert.deepEqual(PACK_RECORD_KINDS, ['install', 'enable', 'disable', 'upgrade', 'rollback'])
  const store = createPackStore({ now: () => 0 })
  assert.equal(store.version, PACK_STORE_VERSION)
})

test('① ★ 空账的状态是**推出来的**，不是另一张表：没装过 = installed:false', () => {
  const store = createPackStore({ now: () => 0 })
  const s = store.stateOf('legion.nothing')
  assert.equal(s.installed, false)
  assert.equal(s.enabled, false)
  assert.equal(s.activeVersion, null)
  assert.equal(s.contentHash, null)
  assert.equal(s.trust, null)
  assert.deepEqual(s.records, [])
  assert.deepEqual(store.history(), [])
  assert.deepEqual(store.enabledPacks(), [])
  assert.deepEqual(store.installedList(), [])
})

test('① 每次写入都追加一条**冻结**记录，seq 单调递增', () => {
  const store = createPackStore({ now: () => 7 })
  const r1 = store.install({ manifest: V1.manifest, verdict: V1.verdict })
  const r2 = store.enable(PACK_ID)
  assert.equal(Object.isFrozen(r1), true)
  assert.equal(r1.seq, 1)
  assert.equal(r2.record.seq, 2)
  assert.equal(r1.at, 7, '记录没有带上 now() 给的时间')
  assert.throws(() => { r1.kind = 'disable' }, TypeError)
  // history 返回的是**副本**：改它不该动到账
  const h = store.history()
  assert.equal(h.length, 2)
  assert.deepEqual(store.history().map((r) => r.kind), ['install', 'enable'])
})

test('① 一个包的全部记录按时间序，且 stateOf 的 records 与 recordsOf 一致', () => {
  const store = createPackStore({ now: () => 0 })
  store.install({ manifest: V1.manifest, verdict: V1.verdict })
  store.enable(PACK_ID)
  store.disable(PACK_ID)
  assert.deepEqual(store.recordsOf(PACK_ID).map((r) => r.kind), ['install', 'enable', 'disable'])
  assert.deepEqual(store.stateOf(PACK_ID).records, store.recordsOf(PACK_ID))
})

// --------------------------------------------------------------- ② 没有预检结论不写账

test('② ★ 没有预检结论时**写不进账**，而不是写一条"待验证"', () => {
  const store = createPackStore({ now: () => 0 })
  assert.equal(codeOf(() => store.install({ manifest: V1.manifest })), STORE_CODES.NO_VERDICT)
  assert.equal(codeOf(() => store.install({ manifest: V1.manifest, verdict: null })), STORE_CODES.NO_VERDICT)
  assert.deepEqual(store.history(), [], '被拒的安装还是在账上留下了东西')
})

test('② 预检结论是"不通过"时也不能写账', () => {
  const store = createPackStore({ now: () => 0 })
  const rejected = { ok: false, code: 'some-code', problems: [{ code: 'some-code' }], computed: { contentHash: V1.manifest.contentHash, trust: 'builtin' } }
  assert.equal(codeOf(() => store.install({ manifest: V1.manifest, verdict: rejected })), STORE_CODES.VERDICT_REJECTED)
  assert.deepEqual(store.history(), [])
})

test('② ★ 账上记的内容哈希必须是**算出来的**那一个，不是作者写的那一个', () => {
  const store = createPackStore({ now: () => 0 })
  // 预检算出来的哈希与 manifest 里写的不一致 → 拒绝
  const mismatched = {
    ok: true,
    code: null,
    problems: [],
    computed: { contentHash: `sha256:${'0'.repeat(64)}`, trust: 'builtin' },
  }
  assert.equal(
    codeOf(() => store.install({ manifest: V1.manifest, verdict: mismatched })),
    STORE_CODES.VERDICT_MISMATCH,
  )

  // 阳性对照：对得上时必须写进去，并且记录里同时留着**两个**哈希
  const rec = store.install({ manifest: V1.manifest, verdict: V1.verdict })
  assert.equal(rec.contentHash, V1.verdict.computed.contentHash)
  assert.equal(rec.declaredContentHash, V1.manifest.contentHash)
  assert.equal(rec.contentHash, rec.declaredContentHash)
})

test('② 预检结论里没有合法的来源等级 → 拒绝（不能默认成 builtin）', () => {
  const store = createPackStore({ now: () => 0 })
  const noTrust = {
    ok: true, code: null, problems: [],
    computed: { contentHash: V1.manifest.contentHash, trust: 'trust-me-bro' },
  }
  assert.equal(codeOf(() => store.install({ manifest: V1.manifest, verdict: noTrust })), STORE_CODES.NO_VERDICT)
})

test('② 记录里留着预检**逐条**给出的码，而不只是一句"通过"', () => {
  const store = createPackStore({ now: () => 0 })
  const rec = store.install({ manifest: V1.manifest, verdict: V1.verdict })
  assert.ok(Array.isArray(rec.verdictCodes))
  assert.equal(rec.trust, 'builtin')
  assert.equal(rec.packId, PACK_ID)
  assert.equal(rec.version, '1.0.0')
  assert.equal(rec.packType, 'team')
})

// --------------------------------------------------------------- ③ 安装

test('③ 同一个版本装两次 → 拒绝（不是幂等吞掉）', () => {
  const store = createPackStore({ now: () => 0 })
  store.install({ manifest: V1.manifest, verdict: V1.verdict })
  assert.equal(codeOf(() => store.install({ manifest: V1.manifest, verdict: V1.verdict })), STORE_CODES.ALREADY_INSTALLED)
  assert.equal(store.history().length, 1, '被拒的重复安装还是写了账')
})

// --------------------------------------------------------------- ④ 启用 / 停用

test('④ 启用与停用都是**状态变化**：没有变化就不写记录', () => {
  const store = createPackStore({ now: () => 0 })
  store.install({ manifest: V1.manifest, verdict: V1.verdict })

  const first = store.enable(PACK_ID)
  assert.equal(first.changed, true)
  assert.equal(first.state.enabled, true)

  //   > 一个「又按了一次启用也写一条记录」的账，
  //   > 与一个「这个包被启用过几次」这个数字没人能解释的账，是同一个东西。
  const again = store.enable(PACK_ID)
  assert.equal(again.changed, false)
  assert.equal(again.record, null)
  assert.equal(store.recordsOf(PACK_ID).filter((r) => r.kind === 'enable').length, 1)

  const off = store.disable(PACK_ID)
  assert.equal(off.changed, true)
  assert.equal(off.state.enabled, false)
  const offAgain = store.disable(PACK_ID)
  assert.equal(offAgain.changed, false)
  assert.equal(store.recordsOf(PACK_ID).filter((r) => r.kind === 'disable').length, 1)
})

test('④ 启用/停用没装过的包 → 拒绝，账上不留痕', () => {
  const store = createPackStore({ now: () => 0 })
  assert.equal(codeOf(() => store.enable('legion.nothing')), STORE_CODES.NOT_INSTALLED)
  assert.equal(codeOf(() => store.disable('legion.nothing')), STORE_CODES.NOT_INSTALLED)
  assert.deepEqual(store.history(), [])
})

test('④ 状态是**扫账**推出来的：启用-停用-启用 之后就是启用', () => {
  const store = createPackStore({ now: () => 0 })
  store.install({ manifest: V1.manifest, verdict: V1.verdict })
  store.enable(PACK_ID)
  store.disable(PACK_ID)
  store.enable(PACK_ID)
  const s = store.stateOf(PACK_ID)
  assert.equal(s.enabled, true)
  assert.equal(s.activeVersion, '1.0.0')
  assert.deepEqual(s.records.map((r) => r.kind), ['install', 'enable', 'disable', 'enable'])
  assert.deepEqual(store.enabledPacks(), [PACK_ID])
})

// --------------------------------------------------------------- ⑤ 升级

test('⑤ 升级要真的升：同版本 / 更低版本都不走 upgrade', () => {
  const store = createPackStore({ now: () => 0 })
  store.install({ manifest: V1.manifest, verdict: V1.verdict })

  // 同版本：内容也没变 → UPGRADE_NO_CHANGE（先于版本比较命中）
  assert.equal(codeOf(() => store.upgrade({ manifest: V1.manifest, verdict: V1.verdict })), STORE_CODES.UPGRADE_NO_CHANGE)

  //   > 一个「升级与降级共用一条记录」的账，
  //   > 与一个「值班的人看不出这次变动是前进还是后退」的账，是同一个东西。
  const lower = packAt('0.9.0')
  assert.equal(codeOf(() => store.upgrade({ manifest: lower.manifest, verdict: lower.verdict })), STORE_CODES.NOT_AN_UPGRADE)
  assert.equal(store.history().length, 1, '被拒的升级还是写了账')
})

test('⑤ ★ 版本号变了而**内容没变** → 拒绝，因为这条记录写不出任何信息', () => {
  const store = createPackStore({ now: () => 0 })
  store.install({ manifest: V1.manifest, verdict: V1.verdict })
  // 只有版本号不同，内容与 V1 逐字节相同
  const sameContent = { ...V1.manifest, version: '1.1.0' }
  const verdict = preflightManifest({
    manifest: sameContent, files: V1.files, host: SAMPLE_HOST, builtinPackIds: [PACK_ID],
  })
  assert.equal(verdict.ok, true, '夹具自己没过预检')
  assert.equal(
    codeOf(() => store.upgrade({ manifest: normalizePackManifest(sameContent), verdict })),
    STORE_CODES.UPGRADE_NO_CHANGE,
  )
  assert.equal(store.stateOf(PACK_ID).activeVersion, '1.0.0')
})

test('⑤ 升级记录同时留着"从哪来"和"到哪去"，以及两个内容哈希', () => {
  const store = createPackStore({ now: () => 0 })
  const first = store.install({ manifest: V1.manifest, verdict: V1.verdict })
  const up = store.upgrade({ manifest: V2.manifest, verdict: V2.verdict })

  assert.equal(up.kind, 'upgrade')
  assert.equal(up.fromVersion, '1.0.0')
  assert.equal(up.version, '1.1.0')
  assert.equal(up.fromContentHash, first.contentHash)
  assert.equal(up.contentHash, V2.manifest.contentHash)
  assert.notEqual(up.fromContentHash, up.contentHash, '升级两个哈希相同——那条 UPGRADE_NO_CHANGE 检查就没有拦点')

  const s = store.stateOf(PACK_ID)
  assert.equal(s.activeVersion, '1.1.0')
  assert.deepEqual(s.installedVersions, ['1.0.0', '1.1.0'], '装过的版本表不对')
  assert.equal(s.contentHash, V2.manifest.contentHash)
})

test('⑤ 升级**不改变**启用状态（它是一次内容替换，不是一次开关）', () => {
  const store = createPackStore({ now: () => 0 })
  store.install({ manifest: V1.manifest, verdict: V1.verdict })
  store.enable(PACK_ID)
  store.upgrade({ manifest: V2.manifest, verdict: V2.verdict })
  assert.equal(store.stateOf(PACK_ID).enabled, true, '升级把启用状态弄丢了')

  const store2 = createPackStore({ now: () => 0 })
  store2.install({ manifest: V1.manifest, verdict: V1.verdict })
  store2.upgrade({ manifest: V2.manifest, verdict: V2.verdict })
  assert.equal(store2.stateOf(PACK_ID).enabled, false, '没启用过的包被升级"顺手启用"了')
})

test('⑤ 升级目标不是语义版本 → 拒绝', () => {
  const store = createPackStore({ now: () => 0 })
  store.install({ manifest: V1.manifest, verdict: V1.verdict })
  // 不走归一化：这里要证明的是 **store 自己**也拦得住，
  // 而不是"上游的归一化会拦住它"。
  const bad = { ...V2.manifest, version: 'v1.1' }
  assert.equal(codeOf(() => store.upgrade({ manifest: bad, verdict: V2.verdict })), STORE_CODES.BAD_RECORD)
})

test('⑤ store 只接受**已归一化**的 manifest：形状不对就拒绝', () => {
  const store = createPackStore({ now: () => 0 })
  const raw = { ...V1.manifest, manifestVersion: 'legion/other@9' }
  assert.equal(codeOf(() => store.install({ manifest: raw, verdict: V1.verdict })), STORE_CODES.BAD_RECORD)
})

test('⑤ 没装过的包不能升级', () => {
  const store = createPackStore({ now: () => 0 })
  assert.equal(codeOf(() => store.upgrade({ manifest: V2.manifest, verdict: V2.verdict })), STORE_CODES.NOT_INSTALLED)
})

// --------------------------------------------------------------- ⑥ 供依赖预检用

test('⑥ installedList 是**当前生效**的版本表，可以直接喂给依赖预检', () => {
  const store = createPackStore({ now: () => 0 })
  store.install({ manifest: V1.manifest, verdict: V1.verdict })
  store.enable(PACK_ID)
  store.upgrade({ manifest: V2.manifest, verdict: V2.verdict })

  const list = store.installedList()
  assert.equal(list.length, 1)
  assert.equal(list[0].packId, PACK_ID)
  assert.equal(list[0].version, '1.1.0', 'installedList 报的不是当前生效版本')
  assert.equal(list[0].enabled, true)
  assert.equal(list[0].contentHash, V2.manifest.contentHash)

  // 真的能接上：一个依赖 ^1.1.0 的包，用这份表判定时必须满足
  const dependent = {
    ...V1.manifest,
    packId: 'legion.dependent',
    dependsOn: [{ packId: PACK_ID, range: '^1.1.0' }],
  }
  const verdict = preflightManifest({
    manifest: dependent, files: V1.files, host: SAMPLE_HOST, installed: list, builtinPackIds: [dependent.packId],
  })
  assert.equal(verdict.ok, true, `${JSON.stringify(verdict.problems.map((p) => p.code))}`)
  assert.deepEqual(verdict.computed.dependencies.map((d) => d.installedVersion), ['1.1.0'])
})

test('⑥ 多个包时 enabledPacks / installedList 都按 packId 排序', () => {
  const store = createPackStore({ now: () => 0 })
  store.install({ manifest: V1.manifest, verdict: V1.verdict })
  const other = packAt('1.0.0')
  const otherManifest = normalizePackManifest({ ...other.manifest, packId: 'legion.aaa' })
  const otherVerdict = preflightManifest({
    manifest: otherManifest, files: other.files, host: SAMPLE_HOST, builtinPackIds: ['legion.aaa'],
  })
  store.install({ manifest: otherManifest, verdict: otherVerdict })
  store.enable(PACK_ID)
  store.enable('legion.aaa')
  assert.deepEqual(store.enabledPacks(), ['legion.aaa', PACK_ID])
  assert.deepEqual(store.installedList().map((x) => x.packId), ['legion.aaa', PACK_ID])
})

test('⑥ 账的形态版本进记录：未来读账的人要能看出形状变过', () => {
  const store = createPackStore({ now: () => 0 })
  const rec = store.install({ manifest: V1.manifest, verdict: V1.verdict })
  assert.equal(rec.preflightVersion, V1.verdict.version ?? null)
  assert.equal(V1.manifest.manifestVersion, PACK_MANIFEST_VERSION)
})

// ───────────────────────── ⑦ F-20 缺口①：回滚 ─────────────────────────

/** 装 1.0.0 → 升 1.1.0 的标准前缀，回滚用例都从这里出发。 */
function installedThenUpgraded() {
  const store = createPackStore({ now: () => 0 })
  const r1 = store.install({ manifest: V1.manifest, verdict: V1.verdict })
  const r2 = store.upgrade({ manifest: V2.manifest, verdict: V2.verdict })
  return { store, r1, r2 }
}

test('⑦ ★★★ 回滚回到装过的低版本，且账上留下**方向**', () => {
  const { store } = installedThenUpgraded()
  assert.equal(store.stateOf(PACK_ID).activeVersion, '1.1.0')
  const rec = store.rollback({ packId: PACK_ID, toVersion: '1.0.0' })
  // ★ 判据一：它是一条**独立的**记录类型。回滚被记成 upgrade 或 install 时，
  //   "这次变动是前进还是后退"在账上就看不出来了。
  assert.equal(rec.kind, 'rollback')
  assert.equal(rec.version, '1.0.0')
  // ★ 判据二：账上同时留着"从哪来"和"到哪去"。
  assert.equal(rec.fromVersion, '1.1.0')
  assert.equal(rec.fromContentHash, V2.manifest.contentHash)
  // ★ 判据三：内容哈希取自**账**（1.0.0 装进来时算出来的那个），
  //   不是调用方再喂一份 manifest 的结果。
  assert.equal(rec.contentHash, V1.manifest.contentHash)
  const s = store.stateOf(PACK_ID)
  assert.equal(s.activeVersion, '1.0.0')
  assert.equal(s.contentHash, V1.manifest.contentHash)
  // ★ 判据四：回滚**不新增** installedVersions——1.0.0 本来就在里面。
  assert.deepEqual([...s.installedVersions].sort(), ['1.0.0', '1.1.0'])
})

test('⑦ 回滚**不改变**启用状态（和升级同一条纪律：它是版本变动，不是开关）', () => {
  const { store } = installedThenUpgraded()
  store.enable(PACK_ID)
  assert.equal(store.stateOf(PACK_ID).enabled, true)
  store.rollback({ packId: PACK_ID, toVersion: '1.0.0' })
  assert.equal(store.stateOf(PACK_ID).enabled, true, '回滚把一个启用中的包停用了')
})

test('⑦ ★★★ 没装过的版本**不能**"回滚"过去（那是一条绕过预检的通道）', () => {
  const { store } = installedThenUpgraded()
  // 1.2.0 从来没装过。接受它就是让"回滚到已知安全版本"这句话
  // 变成"装一个我从没有过、也没验过的版本"。
  assert.equal(
    codeOf(() => store.rollback({ packId: PACK_ID, toVersion: '1.2.0' })),
    'pack-store-rollback-target-unknown',
  )
})

test('⑦ ★★ 回滚目标必须**更低**：更高是升级，相等是没有变化', () => {
  const { store } = installedThenUpgraded()
  assert.equal(
    codeOf(() => store.rollback({ packId: PACK_ID, toVersion: '1.1.0' })),
    'pack-store-rollback-no-change',
  )
  const fresh = createPackStore({ now: () => 0 })
  fresh.install({ manifest: V1.manifest, verdict: V1.verdict })
  fresh.upgrade({ manifest: V2.manifest, verdict: V2.verdict })
  // 2.0.0 没装过 → 先撞 TARGET_UNKNOWN；改用装过再升级的序列才测得到方向。
  const third = packAt('2.0.0')
  fresh.upgrade({ manifest: third.manifest, verdict: third.verdict })
  fresh.rollback({ packId: PACK_ID, toVersion: '1.0.0' })
  // 现在 active=1.0.0，往 1.1.0/2.0.0 都是"前进"，不是回滚。
  assert.equal(
    codeOf(() => fresh.rollback({ packId: PACK_ID, toVersion: '2.0.0' })),
    'pack-store-not-a-rollback',
  )
})

test('⑦ ★★ 没装过的包不能回滚；目标版本不是语义版本要拒', () => {
  const store = createPackStore({ now: () => 0 })
  assert.equal(codeOf(() => store.rollback({ packId: PACK_ID, toVersion: '1.0.0' })), 'pack-store-not-installed')
  const { store: s2 } = installedThenUpgraded()
  assert.equal(codeOf(() => s2.rollback({ packId: PACK_ID, toVersion: 'not-a-version' })), 'pack-store-rollback-target-unknown')
  assert.equal(codeOf(() => s2.rollback({ packId: PACK_ID })), 'pack-store-bad-record')
})

test('⑦ ★ 回滚之后可以再升回去（方向由账决定，不由"曾经到过"决定）', () => {
  const { store } = installedThenUpgraded()
  store.rollback({ packId: PACK_ID, toVersion: '1.0.0' })
  // 1.1.0 装过、也到过——但 upgrade 判的是"比当前高"，1.1.0 > 1.0.0，成立。
  // 若这里改成"装过就不许再升"，回滚过一次的包就永远回不到新版本了。
  const rec = store.upgrade({ manifest: V2.manifest, verdict: V2.verdict })
  assert.equal(rec.kind, 'upgrade')
  assert.equal(store.stateOf(PACK_ID).activeVersion, '1.1.0')
})

test('⑦ ★ `rollbackTargets` 只列装过的、更低的版本，且降序', () => {
  const store = createPackStore({ now: () => 0 })
  store.install({ manifest: V1.manifest, verdict: V1.verdict })
  const mid = packAt('1.0.5')
  store.upgrade({ manifest: mid.manifest, verdict: mid.verdict })
  store.upgrade({ manifest: V2.manifest, verdict: V2.verdict })
  assert.deepEqual(store.rollbackTargets(PACK_ID), ['1.0.5', '1.0.0'])
  assert.deepEqual(store.rollbackTargets('legion.nothing'), [])
  store.rollback({ packId: PACK_ID, toVersion: '1.0.0' })
  assert.deepEqual(store.rollbackTargets(PACK_ID), [])
})

// ───────────────────── ⑧ F-20 缺口②：账的重建 ─────────────────────

test('⑧ ★★★ 快照 → 重建：重启之后"现在装了什么"不变', () => {
  const { store } = installedThenUpgraded()
  store.enable(PACK_ID)
  const before = store.stateOf(PACK_ID)

  // 模拟"进程重启"：账从快照里回来，其余什么都不带。
  const revived = createPackStore({ now: () => 0, history: store.snapshot() })
  const after = revived.stateOf(PACK_ID)

  // ★ 全部可观察字段都要一致。少比一个，"重启即失忆"就能从某个没人比的
  //   字段上溜过去——而 `enabledPacks()` / `installedList()` 正是依赖预检
  //   的基线：基线空了，每个包都会突然报"缺依赖"。
  assert.equal(after.installed, before.installed)
  assert.equal(after.enabled, before.enabled)
  assert.equal(after.activeVersion, before.activeVersion)
  assert.equal(after.contentHash, before.contentHash)
  assert.equal(after.trust, before.trust)
  assert.deepEqual([...after.installedVersions], [...before.installedVersions])
  assert.deepEqual(revived.enabledPacks(), store.enabledPacks())
  assert.deepEqual(revived.installedList(), store.installedList())
  assert.equal(revived.history().length, store.history().length)
})

test('⑧ ★★★ 重建之后 `seq` 接着走，不是从 1 重来', () => {
  const { store } = installedThenUpgraded()
  const revived = createPackStore({ now: () => 0, history: store.snapshot() })
  const rec = revived.rollback({ packId: PACK_ID, toVersion: '1.0.0' })
  // seq 从 1 重来的话，两条不同的记录会共用同一个 seq，
  // 而 seq 是"账只追加、记录不可变"这条保证唯一的凭据。
  assert.equal(rec.seq, store.snapshot().seq + 1)
  assert.equal(new Set(revived.history().map((r) => r.seq)).size, revived.history().length)
})

test('⑧ ★★★ 坏账**整本拒绝**，不是跳过坏的那几条', () => {
  const { store } = installedThenUpgraded()
  const good = [...store.snapshot().records]

  // ① 未知记录类型
  assert.equal(
    codeOf(() => createPackStore({ history: [...good, { ...good[0], seq: 3, kind: 'sideways' }] })),
    'pack-store-bad-snapshot',
  )
  // ② seq 不连续（少了一条）
  assert.equal(
    codeOf(() => createPackStore({ history: good.map((r, i) => ({ ...r, seq: i === 1 ? 7 : r.seq })) })),
    'pack-store-bad-snapshot',
  )
  // ③ packId 为空
  assert.equal(
    codeOf(() => createPackStore({ history: [{ ...good[0], packId: '' }] })),
    'pack-store-bad-snapshot',
  )
  // ④ 根本不是数组
  assert.equal(codeOf(() => createPackStore({ history: { nope: true } })), 'pack-store-bad-snapshot')
  // ★ 判据的要害：拒绝的是**整本**。跳过坏记录的实现会安静地返回一本
  //   少了三条 install 的账，于是"这几个包没装过"与"这几条记录坏了"
  //   变成同一个读数。
  assert.equal(codeOf(() => createPackStore({ history: [...good.slice(0, 1), { kind: 'bogus', seq: 2, packId: 'x', version: '1.0.0' }] })), 'pack-store-bad-snapshot')
})

test('⑧ ★ 快照带形态版本，且改它不影响账', () => {
  const { store } = installedThenUpgraded()
  const snap = store.snapshot()
  assert.equal(snap.version, PACK_STORE_VERSION)
  assert.equal(snap.records.length, 2)
  assert.deepEqual(Object.keys(snap).sort(), ['records', 'seq', 'version'])
  assert.equal(Object.isFrozen(snap), true)
  assert.equal(Object.isFrozen(snap.records), true)
})

test('⑧ ★★ 重建后仍能拒绝非法操作（账回来了，纪律也回来了）', () => {
  const { store } = installedThenUpgraded()
  const revived = createPackStore({ now: () => 0, history: store.snapshot() })
  // 同版本重复安装
  assert.equal(
    codeOf(() => revived.install({ manifest: V1.manifest, verdict: V1.verdict })),
    'pack-store-already-installed',
  )
  // 不是升级的升级
  assert.equal(
    codeOf(() => revived.upgrade({ manifest: V1.manifest, verdict: V1.verdict })),
    'pack-store-not-an-upgrade',
  )
})
