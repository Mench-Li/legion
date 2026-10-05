// 通道 sequence 高水位的判据（设计 §5、§9 line 204、§10 验收表第 2/8 行）
//
// 这一组守的是**发布端该怎么做**的规则，而不只是"回退被拒"：
//
//   · sequence 回退（CDN 返回旧清单）        → 拒绝   （§10 第 1/2 行）
//   · 撤回清单用**更高** sequence            → 接受   （§9 line 204）
//   · **续签**（issuedAt/expiresAt 变了、     → 接受   （§9 line 206「签名清单
//     releaseId 与内容都没变）但 sequence+1            定期续签可由 CI 定时
//                                                      任务执行」）
//   · 同一个 sequence 换摘要/换 releaseId     → 拒绝   （否则可以"原地顶掉"）
//   · 同一个 sequence 完全相同                → 接受   （幂等重放，无害）
//   · 不同 channel/platform/arch 互不干扰     → 各自一条高水位
//
// ★ 第 3 条（续签）必须**明确判为接受**。一个很自然的错误修法是给
//   `releaseId → manifestSha256` 加一条"绑定并不许变化"的判据——那会把每一次
//   正常续签判成攻击（续签必然改 issuedAt/expiresAt，字节就变了），
//   而告警疲劳正是这类判据最常见的死法。
//
//   > 一条"这个值不许变"的判据，在**这个值本来就会合法地变**的时候，
//   > 收获的不是安全，而是把它关掉的理由。
//
// ★ 第 6 条同样重要：高水位是按 channel/platform/arch **分键**的。如果它是
//   一条全局水位，那么"往 internal 发一次测试版"就会把 stable 的水位抬上去，
//   于是一次合法的 stable 发布会被拒——症状看起来像"CDN 返回了旧清单"。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FEED_CODES, FEED_FIELDS, buildFeedPayload, emptySequenceState, judgeSequence, recordSequence,
  selectCandidate, validateFeedPayload,
} from './feed.mjs'

const BASE = Object.freeze({
  channel: 'internal', platform: 'win32', arch: 'x64', sequence: 7,
  releaseId: 'rel-1.1.0', productVersion: '1.1.0',
  manifestSha256: 'a'.repeat(64), acceptedAtMs: 1_700_000_000_000,
})

function feed(overrides = {}) {
  return { ...BASE, ...overrides }
}

/** 走一次完整的"读—判定—记录"，返回判定与新的状态。 */
function accept(state, candidate) {
  const judgement = judgeSequence(state, candidate)
  return { judgement, state: judgement.accept ? recordSequence(state, candidate) : state }
}

test('sequence 高水位：首次看到就接受，并记下它', () => {
  const first = accept(emptySequenceState(), feed())
  assert.equal(first.judgement.accept, true)
  assert.equal(first.judgement.code, 'feed-first-seen')
  assert.equal(first.judgement.previous, null)
  assert.equal(first.state.entries['internal/win32-x64'].sequence, 7)
})

test('sequence 回退（CDN 返回旧清单）→ 拒绝，且**不改变**已记录的水位', () => {
  const first = accept(emptySequenceState(), feed())
  const older = accept(first.state, feed({ sequence: 6, releaseId: 'rel-1.0.0', manifestSha256: 'b'.repeat(64) }))
  assert.equal(older.judgement.accept, false)
  assert.equal(older.judgement.code, FEED_CODES.SEQUENCE_REGRESSION)
  assert.equal(older.judgement.regression, true)
  assert.equal(older.state.entries['internal/win32-x64'].sequence, 7, '被拒的清单把水位改动了')
})

test('★★ 续签：releaseId 与内容都没变、只重新签发（sequence+1）→ **必须接受**', () => {
  // 设计 §9 line 206：「签名清单定期续签可由 CI 定时任务执行」。续签会改
  // issuedAt/expiresAt ⇒ **字节必然变**。所以"字节变了"不能当成攻击信号，
  // 判断依据只能是 sequence 与内容摘要。
  const first = accept(emptySequenceState(), feed({ productVersion: '1.1.0' }))
  // 续签：同一个 releaseId、同一个清单摘要、同一个产品版本，只有签发时间变了。
  // 注意 `judgeSequence` 看的是**清单摘要**（manifestSha256），不是清单字节——
  // 这正是"续签"与"换包"能分开的原因。
  const renewed = accept(first.state, feed({ sequence: 8, acceptedAtMs: BASE.acceptedAtMs + 86_400_000 }))
  assert.equal(renewed.judgement.accept, true,
    `续签被拒了（${renewed.judgement.code}：${renewed.judgement.reason}）——`
    + '很可能是有人加了"同一个 releaseId 的摘要不许变"的判据，那会让每次正常续签都变成告警')
  assert.equal(renewed.judgement.code, 'feed-sequence-advanced')
  assert.equal(renewed.state.entries['internal/win32-x64'].sequence, 8)
})

test('★ 同一个 sequence 换摘要或换 releaseId → 拒绝（不能"原地顶掉"）', () => {
  const first = accept(emptySequenceState(), feed())
  // ★ 冲突判据的键是 `(releaseId, manifestSha256)` 这一对。
  //   清单的**身份**就是它们两个：摘要是内容，releaseId 是名字。
  for (const changed of [
    { manifestSha256: 'c'.repeat(64) },
    { releaseId: 'rel-1.1.0-repacked' },
    { manifestSha256: 'c'.repeat(64), releaseId: 'rel-1.1.0-repacked' },
  ]) {
    const r = accept(first.state, feed(changed))
    assert.equal(r.judgement.accept, false, `同 sequence 改了 ${JSON.stringify(changed)} 居然被接受`)
    assert.equal(r.judgement.code, FEED_CODES.SEQUENCE_CONFLICT)
    assert.equal(r.state.entries['internal/win32-x64'].manifestSha256, 'a'.repeat(64))
  }
  // ⚠️ 边界（**不是**缺陷，记下来免得下次误判）：只改 `productVersion` 而
  //    `releaseId` 与摘要都不变时，这一层**会接受**。理由是 `productVersion`
  //    不在冲突键里——它是给人看的显示字段，而真正权威的版本号在**已签名的
  //    发行清单**里（`validateRelease` 会核它与产品清单一致）。
  //    所以"通道上写着一个错的版本号"只会让界面文字短暂不对，不会让谁装上
  //    不该装的东西。
  const onlyVersion = accept(first.state, feed({ productVersion: '9.9.9' }))
  assert.equal(onlyVersion.judgement.code, 'feed-same-sequence-same-digest')
})

test('同一个 sequence 完全相同 → 接受（幂等重放，无害）', () => {
  const first = accept(emptySequenceState(), feed())
  const again = accept(first.state, feed())
  assert.equal(again.judgement.accept, true)
  assert.equal(again.judgement.code, 'feed-same-sequence-same-digest')
})

test('★ 高水位按 channel/platform/arch **分键**（否则一次测试发布会把正式通道顶住）', () => {
  let state = emptySequenceState()
  // internal/win32-x64 推到 7
  state = accept(state, feed()).state
  // stable/win32-x64 自己从 1 开始 —— 如果水位是全局的，这里会被判成回退。
  const stable = accept(state, feed({ channel: 'stable', sequence: 1, releaseId: 'rel-stable-1.0.0' }))
  assert.equal(stable.judgement.accept, true,
    '换通道之后被判成回退了：水位没有按 channel/platform/arch 分键')
  assert.equal(stable.judgement.code, 'feed-first-seen')
  state = stable.state
  // 平台与架构也是分键的一部分：键的形状是 `${channel}/${platform}-${arch}`。
  const linux = accept(state, feed({ platform: 'linux', arch: 'arm64', sequence: 1 }))
  assert.equal(linux.judgement.accept, true)
  assert.equal(linux.judgement.code, 'feed-first-seen')
  state = linux.state
  assert.deepEqual(Object.keys(state.entries).sort(),
    ['internal/linux-arm64', 'internal/win32-x64', 'stable/win32-x64'])
})

test('buildFeedPayload 产出的是一份形状合法的清单（自己能被判定）', () => {
  const payload = buildFeedPayload({
    channel: 'internal', platform: 'win32', arch: 'x64', sequence: 9,
    issuedAt: new Date(1_700_000_000_000).toISOString(),
    expiresAt: new Date(1_700_000_000_000 + 86_400_000).toISOString(),
    releaseId: 'rel-1.2.0', productVersion: '1.2.0',
    manifestPath: 'releases/rel-1.2.0/manifest.json', manifestSha256: 'd'.repeat(64),
  })
  const r = accept(emptySequenceState(), { ...payload, acceptedAtMs: 1_700_000_000_000 })
  assert.equal(r.judgement.accept, true)
  assert.equal(r.judgement.code, 'feed-first-seen')
  // 通道挑候选：这份清单指向一个比本机更新的版本。
  const picked = selectCandidate({ feed: payload, currentVersion: '1.1.0' })
  // verdict 的取值来自 feed.mjs 自己的词表（'newer' = 有更新的版本）。
  assert.equal(picked.verdict, 'newer')
  assert.equal(picked.candidate.releaseId, 'rel-1.2.0')
})

// ---------------------------------------------------------------------------
// ⑫ 通道清单的形状：`FEED_FIELDS` 是**真的**（它被遍历）
// ---------------------------------------------------------------------------

test('★★★★ `FEED_FIELDS` 必须被遍历——照它加一项要真的生效（判据不能是装饰）', () => {
  // ★ 这条守的是一件**关于判据本身**的事，而它来自一次真实的红灯。
  //
  //   本仓有一条判据（`scripts/prt/declaration-mirrors.test.mjs`）专门抓
  //   "声明了却没有任何遍历点的表"。它抓到的正是这里的 `FEED_FIELDS`：
  //
  //     > `FEED_FIELDS` 声明了却**没有任何遍历点**，而同文件里把它的成员
  //     > 手写复述了 11 次——这张表是装饰，照它的注释加一项会被静默丢掉。
  //
  //   它说得对，而且我当时**把这条红灯误判成了前存债务**（见 §5 的 ㊵）。
  //   修法不是删表，而是让它**被遍历**：`validateFeedPayload` 末尾多了一条
  //   存在性判据，逐个问"这个字段在不在"。
  //
  //   于是这条用例要证明两件事：
  //     ① 表里的字段**缺一个就会被拒**（表是承重的）；
  //     ② 具体类型判据仍然**先**报（不会被一句笼统的"少了 X"盖掉）。
  const full = buildFeedPayload({
    channel: 'internal', platform: 'win32', arch: 'x64', sequence: 7,
    issuedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-10-08T00:00:00Z',
    releaseId: 'rel-1.1.0', productVersion: '1.1.0',
    manifestPath: 'releases/rel-1.1.0/manifest.json', manifestSha256: 'a'.repeat(64),
  })
  const ok = validateFeedPayload(full)
  assert.equal(ok.ok, true, `一份完整清单被拒了：${ok.reason}`)
  // 表里的每一个字段都必须在产物里真的存在（否则下面那些"缺一个"的探针
  // 会因为"本来就没有"而全部命中，失去分辨力）。
  //
  // ★★ 这里**故意**不写成一个"把表名直接放在 `of` 后面"的 for…of 循环。
  //
  //   本仓那条判据（`scripts/prt/declaration-mirrors.mjs` 的 `iterPattern`）
  //   把任何"`of` 紧跟表名"的文本都算成遍历点——而它的命中来源是
  //   `git grep` 整棵仓库，**用例文件也算**。于是用例里写那一行，会让那条判据
  //   对着**生产代码**也放行：把 `feed.mjs` 里那个循环删掉，它会因为
  //   *这条用例*里的循环而继续报绿。
  //
  //   > 一条判据的"证据来源"里混进了用例，它就会把"用例遍历过"
  //   > 读成"生产代码遍历过"。
  //
  //   我用一个局部别名绕开那条正则，正是为了让那条判据的绿**只**能由
  //   生产代码里那个循环挣来。（实测：把生产那个循环清空之后，
  //   那条判据会红——否则下面这几行就是空话。）
  //
  //   ★ 而写这段说明时我又踩了同一个坑一次：我本来把这个"反例写法"原样
  //     抄进了注释，于是**注释里那句话本身**又满足了那条正则——判据再次被
  //     它的说明文字弄瞎（与 ㉚ 里那次同一个形状）。所以这里只用文字描述，
  //     不出现那个字面写法。
  const declaredFields = FEED_FIELDS
  for (const field of declaredFields) {
    assert.notEqual(full[field], undefined, `buildFeedPayload 没产出 ${field}，而它在 FEED_FIELDS 里`)
  }

  // ① 缺一个就该被拒。`issuedAt` 特意选**本模块类型判据盖不到**的那个
  //    （它的类型判据在 `envelope.mjs` 的有效期窗口里），所以这一条只可能
  //    由那条遍历判据满足——这正证明表是承重的。
  for (const field of ['issuedAt', 'expiresAt']) {
    const missing = { ...full }
    delete missing[field]
    const result = validateFeedPayload(missing)
    assert.equal(result.ok, false, `缺 ${field} 的清单被接受了`)
    assert.equal(result.code, FEED_CODES.BAD_FIELD)
    assert.equal(result.problems[0].field, field, `报的不是缺的那个字段：${JSON.stringify(result.problems[0])}`)
    assert.match(result.reason, new RegExp(field))
  }

  // ② 具体类型判据仍然先报：`arch` 既在表里、也有自己的正则判据，
  //    所以缺它时报的应当是**类型那句**（"必须是小写架构名"），
  //    而不是"IE 少了 arch"。顺序反了会让报告变模糊。
  const noArch = { ...full }
  delete noArch.arch
  const archResult = validateFeedPayload(noArch)
  assert.equal(archResult.ok, false)
  assert.equal(archResult.problems[0].field, 'arch')
  assert.equal(archResult.problems.length, 1,
    `同一个字段被报了两遍（类型判据 + 存在性判据）：${JSON.stringify(archResult.problems)}`)
  assert.match(archResult.problems[0].message, /小写架构名/)

  // ③ 一个存在但**非法**的值（`sequence: 0`）走的仍然是类型判据，
  //    不会因为"存在"而被存在性判据放过、也不会被它重复报一遍。
  const zeroSeq = validateFeedPayload({ ...full, sequence: 0 })
  assert.equal(zeroSeq.ok, false)
  assert.equal(zeroSeq.problems[0].field, 'sequence')
  assert.match(zeroSeq.problems[0].message, /正整数/)
})

test('★ 通道清单**不**拒绝未知字段（前向兼容是刻意的）', () => {
  // ★ 把这条写下来，是为了让"以后有人想加一条'拒绝未知字段'"这件事
  //   有据可依：设计 §5 用 `format` 做版本门（`legion/update-feed@1`），
  //   所以**加字段**要连同 format 一起升版，而不是让老客户端去拒新字段。
  //
  //   一个"拒绝 payload 里任何未知键"的实现在这里看起来更严，但它会把
  //   "发布端先加字段、客户端后升级"这条正常路径变成一次硬失败——
  //   而设计 §5 整节都在讲怎么让发布与消费**解耦**（通道清单与发行清单分开、
  //   签名与传输分开）。
  const full = buildFeedPayload({
    channel: 'internal', sequence: 7, issuedAt: '2026-10-01T00:00:00Z',
    expiresAt: '2026-10-08T00:00:00Z', releaseId: 'rel-1.1.0', productVersion: '1.1.0',
    manifestPath: 'releases/rel-1.1.0/manifest.json', manifestSha256: 'a'.repeat(64),
  })
  const withExtra = validateFeedPayload({ ...full, somethingNew: 'x' })
  assert.equal(withExtra.ok, true, `多了一个未知字段就被拒了：${withExtra.reason}`)
  // 对照：`FEED_FIELDS` 那张表**不是**用来判"只能有这些键"的——
  // 它是"这些必须有"。两件事不能混。
  assert.equal(Object.keys(full).length, FEED_FIELDS.length,
    'FEED_FIELDS 与产物字段数对不上——那么"多一个键"这条对照就没有分辨力')
})
