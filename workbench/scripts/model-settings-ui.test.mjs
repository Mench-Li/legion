// workbench/scripts/model-settings-ui.test.mjs
// ============================================================================
// PRT-507：设置面的**面板状态**纯逻辑
//
// 这一组守两条**方向完全不同**的纪律：
//
//   · 「读不出来」≠「是空的」
//   · 「没探测过」≠「探测失败」
//
// 两条错误的共同形态是一样的：**一个故障被渲染成一份可操作的空状态**。
// 用户会照着"你还没有任何凭证"重新录入钥匙（而密钥库根本打不开），
// 或者照着"连接失败"去查网络与供应商（而我们**从没问过**供应商）。
// ============================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { hubErrorFromBody } from '../src/hub-errors.ts'
import { chainView } from '../src/modelSettings.ts'
import {
  aclView, bundlePlanView, collectionView, failedState, loadingState, migrationPlanView,
  panelErrorFrom, probeViewFrom, readyState, resolutionView, secretDeleteResultView, secretErrorView,
  secretRefEditView, secretRowView, secretStatusView, secretWriteResultView,
} from '../src/modelSettingsUi.ts'

/** 造一个与 `api.ts` 里**同一个来源**的中枢错误（`hubErrorFromBody`，不是手写的替身）。 */
const hubErr = (status, body) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return hubErrorFromBody(status, raw, typeof body === 'string' ? null : body)
}

// ─────────────────────────────────────── ①「读不出来」≠「是空的」

describe('① 读取三态：读不出来不许说「你还没有」', () => {
  const copy = { noun: '凭证', emptyHint: '你还没有录入任何凭证。', readFailedHint: '这不代表密钥库里没有东西。' }

  test('ready 且为空 → kind 恰为 empty（这是唯一可以说"你没有"的分支）', () => {
    const v = collectionView(readyState([]), copy)
    assert.equal(v.kind, 'empty')
    assert.equal(v.detail, copy.emptyHint)
    assert.equal(v.code, null)
  })

  test('failed → kind 恰为 unreadable，并带上后端原码', () => {
    const err = hubErr(503, { ok: false, error: '密钥库不可用', code: 'SECRET_ADMIN_STORE_UNAVAILABLE' })
    const v = collectionView(failedState(err), copy)
    assert.equal(v.kind, 'unreadable')
    assert.equal(v.code, 'SECRET_ADMIN_STORE_UNAVAILABLE', '码必须原样到达界面')
    assert.ok(v.detail.includes('SECRET_ADMIN_STORE_UNAVAILABLE'), `详情里要看得到码：${v.detail}`)
    assert.equal(v.tone, 'bad')
  })

  test('**两个状态必须被区分**：empty 与 unreadable 的 kind 不同', () => {
    const empty = collectionView(readyState([]), copy)
    const dead = collectionView(failedState(hubErr(503, { error: 'x', code: 'SECRET_ADMIN_STORE_UNAVAILABLE' })), copy)
    assert.notEqual(empty.kind, dead.kind)
    assert.notEqual(empty.headline, dead.headline)
  })

  test('**文案不许互相串门**：读不出来时不出现空状态提示，反之亦然', () => {
    const empty = collectionView(readyState([]), copy)
    const dead = collectionView(failedState(hubErr(503, { error: 'x', code: 'SECRET_ADMIN_STORE_UNAVAILABLE' })), copy)
    assert.ok(!dead.detail.includes(copy.emptyHint), `故障里混进了空状态提示：${dead.detail}`)
    assert.ok(!dead.headline.includes('还没有'), `故障标题不该说"还没有"：${dead.headline}`)
    assert.ok(!empty.detail.includes('读不出来'), `空状态里混进了故障文案：${empty.detail}`)
    assert.ok(!empty.headline.includes('读不出来'))
  })

  test('failed 可重试（读不出来是暂时状态，不是终点）', () => {
    assert.equal(collectionView(failedState(new Error('ECONNREFUSED')), copy).canRetry, true)
  })

  test('loading 与 empty 也不同（别在加载中说"你没有"）', () => {
    const loading = collectionView(loadingState(), copy)
    assert.equal(loading.kind, 'loading')
    assert.notEqual(loading.kind, collectionView(readyState([]), copy).kind)
    assert.ok(!loading.detail.includes(copy.emptyHint))
  })

  test('有数据 → rows，并且数出真实条数', () => {
    const v = collectionView(readyState([{ ref: 'A' }, { ref: 'B' }]), copy)
    assert.equal(v.kind, 'rows')
    assert.match(v.headline, /2/)
  })

  test('非中枢错误**不假装**有结构（code/field 都是 null）', () => {
    const e = panelErrorFrom(new Error('ECONNREFUSED'))
    assert.equal(e.code, null)
    assert.equal(e.field, null)
    assert.equal(e.status, null)
    assert.equal(e.text, 'ECONNREFUSED')
  })

  test('field/hint/candidates 从**原始响应体**里读出来（PRT-252 的那一半）', () => {
    const err = hubErr(400, {
      error: '引用名非法', code: 'SECRET_REF_INVALID', field: 'ref',
      hint: '只允许字母数字与 . _ -', candidates: ['custom-ds'],
    })
    const e = panelErrorFrom(err)
    assert.equal(e.field, 'ref')
    assert.equal(e.hint, '只允许字母数字与 . _ -')
    assert.deepEqual(e.candidates, ['custom-ds'])
    assert.equal(e.code, 'SECRET_REF_INVALID')
  })
})

// ─────────────────────────────────────── ②「没探测过」≠「探测失败」

describe('② 探测：503 是「这次没探测过」，不是一次判定', () => {
  const unavailable = (code) => hubErr(503, {
    ok: false, code,
    error: '无法测试连接：密钥库打不开（SECRET_STORE_UNPROTECTED）。**这次没有探测过**——这不是"模型连不上"，别去查网络。',
  })

  test('三个真实的服务端码都渲染成灰色「未测试」', () => {
    for (const code of ['PROBE_LAYOUT_BLOCKED', 'PROBE_SECRETS_UNAVAILABLE', 'PROBE_NO_CREDENTIAL_REF']) {
      const b = probeViewFrom({ error: unavailable(code) })
      assert.equal(b.tone, 'muted', `${code} 必须是灰色`)
      assert.equal(b.label, '未测试', `${code} 的标签`)
      assert.ok(!/分类/.test(b.detail), `未测试不该提失败分类：${b.detail}`)
      // ★ 这一条是**断验证 ⑦④ 量出来补上的**。
      //
      //   第一版只断言了 tone / label / "不提分类"——而"这个码不在已知集合里"
      //   那句附注**三条都不碰**。于是把 `PROBE_UNAVAILABLE_CODES` 整张表清空、
      //   让每一个**已知**的"没探测过"码都被加上那句"不在已知集合里"，
      //   套件**仍然全绿**（fail=0）。
      //
      //   危害不是文案丑：那句话的用途是**标记没归类的码**，
      //   挂在已经归好类的码上时，读的人会以为这一类需要额外处置。
      //   这与"把认识的当成不认识的"是同一类误读，只是方向相反。
      //
      //     > 一张"只有否定分支被断言过"的表，
      //     > 与一张空表，在报告上是同一个读数——只不过前者看起来是有人在守的。
      assert.ok(!/不在已知的/.test(b.detail),
        `${code} 是**已知**的"没探测过"码，不该被说成"不在已知集合里"：${b.detail}`)
    }
  })

  test('**未测试与失败必须被区分**（tone 与 label 都不同）', () => {
    const untested = probeViewFrom({ error: unavailable('PROBE_SECRETS_UNAVAILABLE') })
    const failed = probeViewFrom({ error: hubErr(404, { ok: false, code: 'PROFILE_NOT_FOUND', error: '没有这个模型档案：p1' }) })
    assert.equal(failed.tone, 'bad')
    assert.equal(failed.label, '失败')
    assert.notEqual(untested.tone, failed.tone)
    assert.notEqual(untested.label, failed.label)
  })

  test('503 但码不在已知集合里 → 仍然是"未测试"，且**明说**没归类', () => {
    const b = probeViewFrom({ error: unavailable('PROBE_SOMETHING_NEW') })
    assert.equal(b.tone, 'muted')
    assert.match(b.detail, /不在已知的/)
    assert.ok(!/分类：/.test(b.detail), '不该给它编一个失败分类')
  })

  test('**HTTP 400 的配置错误不许被当成"没探测过"**（那样用户不会去改配置）', () => {
    const b = probeViewFrom({ error: hubErr(400, { ok: false, code: 'MODEL_CONFIG_UNKNOWN_PROVIDER', error: '没有已登记的供应商「openai」。' }) })
    assert.equal(b.tone, 'bad')
    assert.notEqual(b.label, '未测试')
  })

  test('缺分类的失败按 unknown 处理（"别乱重试"），不猜成 transient', () => {
    const b = probeViewFrom({ error: hubErr(400, { ok: false, code: 'MODEL_CONFIG_UNKNOWN_PROVIDER', error: 'x' }) })
    assert.match(b.action, /不能当作暂时问题重试/)
  })

  test('成功路径交给 modelSettings.ts 的 probeBadge（分类只有一份）', () => {
    const b = probeViewFrom({ verdict: { ok: true, code: 'OK', latencyMs: 7, capabilities: { chat: true } } })
    assert.equal(b.tone, 'ok')
    assert.equal(b.label, '通过')
    assert.match(b.detail, /7 ms/)
  })

  test('没有任何结果 → 未测试（"没测过不等于可用"）', () => {
    for (const input of [{}, { verdict: null }]) {
      const b = probeViewFrom(input)
      assert.equal(b.tone, 'muted')
      assert.equal(b.label, '未测试')
      assert.match(b.action, /没测过不等于可用/)
    }
  })
})

// ─────────────────────────────────────── ③ 凭证行：只有元数据

describe('③ 凭证行：值不可能出现在视图里', () => {
  test('喂一条带 value/blob/token 的输入，整个视图里不含那个值', () => {
    const secret = 'sk-live-DEADBEEF'
    const view = secretRowView({
      ref: 'OPENAI_KEY', purpose: '探针', scheme: 'dpapi-user',
      createdAt: '2026-09-11T00:00:00.000Z', updatedAt: null, rotatedAt: null,
      value: secret, blob: secret, token: secret, plaintext: secret,
    })
    const dump = JSON.stringify(view)
    assert.ok(!dump.includes(secret), `值漏进了视图：${dump}`)
    assert.equal(view.ref, 'OPENAI_KEY')
    assert.equal(view.purposeText, '探针')
    assert.equal(view.schemeText, 'dpapi-user')
  })

  test('rotatedAt 为 null = **从未轮换**（不是"轮换失败"，也不是空白）', () => {
    const never = secretRowView({ ref: 'A', rotatedAt: null })
    const rotated = secretRowView({ ref: 'A', rotatedAt: '2026-09-12T03:04:05.000Z' })
    assert.equal(never.rotatedText, null)
    assert.equal(rotated.rotatedText, '最近轮换：2026-09-12 03:04')
    assert.notEqual(never.rotatedText, rotated.rotatedText)
  })

  test('缺字段不崩，且显式说"没有"（不显示空白）', () => {
    const v = secretRowView({})
    assert.equal(v.refText, '（响应里没有引用名）')
    assert.equal(v.purposeText, '（没有用途说明）')
    assert.equal(v.schemeText, '（没有保护方案信息）')
    assert.equal(v.timesText, '（没有时间戳）')
    for (const bad of [null, undefined, 'x', 42, []]) {
      assert.equal(secretRowView(bad).ref, '', `${String(bad)} 不该被当成一条凭证`)
    }
  })
})

describe('③b 文件权限：aclExists 的两种 false 不是一回事', () => {
  test('核验通过 → ok', () => {
    assert.equal(aclView({ aclVerified: true, aclExists: true }).tone, 'ok')
  })

  test('**全新安装（文件还不存在）不是告警**', () => {
    const v = aclView({ aclVerified: false, aclExists: false })
    assert.equal(v.tone, 'muted')
    assert.match(v.text, /全新安装/)
  })

  test('文件在但没能确认权限 → 黄色，且必须与"文件不存在"不同', () => {
    const warn = aclView({ aclVerified: false, aclExists: true, aclNote: '写完之后无法重新核验文件权限：X' })
    const muted = aclView({ aclVerified: false, aclExists: false })
    assert.equal(warn.tone, 'warn')
    assert.notEqual(warn.tone, muted.tone)
    assert.match(warn.text, /没能确认/)
    assert.match(warn.text, /写完之后无法重新核验/)
  })

  test('两个字段都没有 → 不静默：说清"不知道"', () => {
    const v = aclView({})
    assert.equal(v.tone, 'warn')
    assert.match(v.text, /没有说文件是否存在/)
  })
})

// ─────────────────────────────────────── ④ 写回执

describe('④ 写回执：轮换的后果必须说出来', () => {
  test('put 与 rotate 是两种回执', () => {
    const put = secretWriteResultView('put', { secret: { ref: 'K1' }, aclVerified: true, aclExists: true })
    const rot = secretWriteResultView('rotate', { secret: { ref: 'K1' }, aclVerified: true, aclExists: true })
    assert.equal(put.kind, 'written')
    assert.equal(rot.kind, 'rotated')
    assert.notEqual(put.headline, rot.headline)
    // 轮换的语义是"只影响之后创建的运行"——不说这句，用户会以为在跑的那次也换了钥匙
    assert.match(rot.detail, /只影响轮换之后创建的运行/)
  })

  test('写成功但没核验权限 → 仍然算成功，但**必须**带出那条提醒', () => {
    const v = secretWriteResultView('put', {
      secret: { ref: 'K1' }, aclVerified: false, aclExists: true, aclNote: '凭证已写入，但之后无法重新核验文件权限：X',
    })
    assert.equal(v.kind, 'written')
    assert.equal(v.acl.tone, 'warn')
    assert.match(v.acl.text, /无法重新核验/)
  })
})

describe('④b 删除回执：幂等不是失败，但"不知道"也不许并进"本来就不存在"', () => {
  test('removed:true → removed', () => {
    const v = secretDeleteResultView({ removed: true, aclVerified: true, aclExists: true })
    assert.equal(v.kind, 'removed')
  })

  test('removed:false → already-absent，且**不是**失败', () => {
    const v = secretDeleteResultView({ removed: false, aclVerified: true, aclExists: true })
    assert.equal(v.kind, 'already-absent')
    assert.match(v.headline, /本来就不存在/)
    assert.match(v.detail, /幂等/)
    assert.ok(!/删除失败/.test(v.headline), `幂等被说成了失败：${v.headline}`)
  })

  test('**响应里没有 removed 字段时不许并进"本来就不存在"**', () => {
    const absent = secretDeleteResultView({ removed: false })
    const unknown = secretDeleteResultView({})
    assert.equal(unknown.kind, 'already-absent', '既没有删掉也没有"本来就不存在"，但形状上是同一个非失败分支')
    assert.notEqual(unknown.headline, absent.headline, '「不知道」与「本来就不存在」必须能被读出来')
    assert.match(unknown.headline, /没有说/)
  })
})

// ─────────────────────────────────────── ⑤ 凭证错误：码决定下一步

describe('⑤ 凭证错误：每个后端码都有可区分、可行动的文案', () => {
  const cases = [
    ['SECRET_ADMIN_STORE_UNAVAILABLE', 'store-unavailable'],
    ['SECRET_NOT_FOUND', 'not-found'],
    ['SECRET_REF_INVALID', 'bad-request'],
    ['SECRET_VALUE_EMPTY', 'bad-request'],
    ['SECRET_STORE_WRITE_FAILED', 'write-failed'],
  ]

  test('五个真实码 → 各自的 kind、原码与状态码都保留', () => {
    for (const [code, kind] of cases) {
      const v = secretErrorView(hubErr(400, { ok: false, code, error: `错误：${code}`, hint: '看这里' }))
      assert.equal(v.code, code, `${code} 的码必须原样保留`)
      assert.equal(v.kind, kind, `${code} 的 kind`)
      assert.ok(v.detail.includes(code), `详情里要看得到码：${v.detail}`)
      assert.ok(v.detail.includes('看这里'), `hint 必须到达界面：${v.detail}`)
      assert.ok(v.action.length > 0)
    }
  })

  test('**「密钥库打不开」与「引用不存在」的下一步动作完全相反**', () => {
    const store = secretErrorView(hubErr(503, { ok: false, code: 'SECRET_ADMIN_STORE_UNAVAILABLE', error: '密钥库不可用' }))
    const absent = secretErrorView(hubErr(404, { ok: false, code: 'SECRET_NOT_FOUND', error: '没有这个凭证引用：K1' }))
    assert.notEqual(store.kind, absent.kind)
    assert.notEqual(store.action, absent.action)
    // 打不开时**不许**引导用户去重新录入（录入会同样失败）
    assert.match(store.action, /不要重新录入/)
    assert.match(store.headline, /不是「这个引用不存在」/)
    // 而真的不存在时，要指到"新增凭证"这条路
    assert.match(absent.action, /新增凭证/)
    assert.ok(!/不要重新录入/.test(absent.action))
  })

  test('非中枢错误落进 unclassified，且**不写死**一个业务码', () => {
    const v = secretErrorView(new Error('ECONNREFUSED'))
    assert.equal(v.code, null)
    assert.equal(v.status, null)
    assert.equal(v.kind, 'unclassified')
    assert.match(v.headline, /未归类/)
  })

  test('没见过的码走 unclassified 并说出来（不假装认识它）', () => {
    const v = secretErrorView(hubErr(409, { ok: false, code: 'SOME_FUTURE_CODE', error: 'x' }))
    assert.equal(v.code, 'SOME_FUTURE_CODE')
    assert.equal(v.kind, 'unclassified')
    assert.match(v.action, /不猜/)
  })

  test('field 从结构化响应体里带出来（该落到哪个输入框）', () => {
    const v = secretErrorView(hubErr(400, { ok: false, code: 'SECRET_REF_INVALID', error: 'x', field: 'ref' }))
    assert.equal(v.field, 'ref')
  })
})

// ─────────────────────────────────────── ⑥ 密钥库自检

describe('⑥ 自检：ok:false 走 HTTP 200，它不是「没有凭证」', () => {
  test('ok:false → unavailable，且带上后端原码', () => {
    const v = secretStatusView({ ok: false, code: 'SECRET_ADMIN_STORE_UNAVAILABLE', message: '密钥库不可用' })
    assert.equal(v.kind, 'unavailable')
    assert.equal(v.available, false)
    assert.equal(v.code, 'SECRET_ADMIN_STORE_UNAVAILABLE')
    assert.ok(v.detail.includes('SECRET_ADMIN_STORE_UNAVAILABLE'))
    assert.match(v.headline, /不是「没有凭证」/)
  })

  test('**「打不开」与「一条都没有」必须不同**', () => {
    const dead = secretStatusView({ ok: false, code: 'SECRET_ADMIN_STORE_UNAVAILABLE', message: 'x' })
    const empty = secretStatusView({ ok: true, protection: { scheme: 'dpapi-user' }, count: 0, aclVerified: true, aclExists: true })
    assert.equal(empty.kind, 'available')
    assert.notEqual(dead.kind, empty.kind)
    assert.notEqual(dead.countText, empty.countText)
  })

  test('count:null 与 count:0 的文案不同（"没给计数"不是"零条"）', () => {
    const zero = secretStatusView({ ok: true, count: 0, protection: { scheme: 'dpapi-user' }, aclVerified: true, aclExists: true })
    const unknown = secretStatusView({ ok: true, count: null, protection: { scheme: 'dpapi-user' }, aclVerified: true, aclExists: true })
    assert.equal(zero.countText, '已录入 0 条')
    assert.notEqual(zero.countText, unknown.countText)
    assert.match(unknown.countText, /未知/)
  })

  test('没有自检结果 → unknown（第三种状态，不许并进前两种）', () => {
    const v = secretStatusView(null)
    assert.equal(v.kind, 'unknown')
    assert.match(v.detail, /不等于/)
    const kinds = new Set([
      v.kind,
      secretStatusView({ ok: false, code: 'X', message: 'm' }).kind,
      secretStatusView({ ok: true, count: 1, aclVerified: true, aclExists: true }).kind,
    ])
    assert.equal(kinds.size, 3, '三种自检状态必须互不相同')
  })

  test('可用时把保护方案与权限核验结果一起报出来', () => {
    const v = secretStatusView({ ok: true, count: 2, protection: { scheme: 'dpapi-user' }, aclVerified: true, aclExists: true })
    assert.match(v.detail, /dpapi-user/)
    assert.match(v.detail, /已核验/)
  })
})

// ─────────────────────────────────────── ⑦ 配置包计划

describe('⑦ 配置包导入计划：keep 策略下"零冲突"不等于"都导入了"', () => {
  const applicableOk = { ok: true, code: null, reason: null }

  test('keep 策略把冲突变成 skip：**被跳过的必须说出来**', () => {
    const v = bundlePlanView(
      { ok: true, summary: { willWrite: 0, conflicts: 0, keptLocal: 3, needsCredential: 0, danglingRefs: [] } },
      applicableOk,
    )
    assert.equal(v.applicable, true, '"零冲突"时服务端确实说可以应用')
    assert.ok(v.lines.some((l) => /3 条/.test(l) && /不会导入/.test(l)), `必须说清有 3 条没进去：${v.lines.join(' | ')}`)
    assert.doesNotMatch(v.headline, /可以导入/, `一条都不写的时候不能说"可以导入"：${v.headline}`)
  })

  test('未决冲突 → 不能应用，且原因来自服务端的 applicable', () => {
    const v = bundlePlanView(
      { ok: true, summary: { willWrite: 2, conflicts: 2, keptLocal: 0, danglingRefs: [] } },
      { ok: false, code: 'IMPORT_HAS_CONFLICTS', reason: '有 2 处冲突未决：换模型会同时改变成本、质量与数据去向' },
    )
    assert.equal(v.applicable, false)
    assert.match(v.blocked, /2 处冲突未决/)
    assert.notEqual(v.headline, '可以导入')
  })

  test('**"全都没导入"与"有冲突"两种计划的读法必须不同**', () => {
    const kept = bundlePlanView({ ok: true, summary: { willWrite: 0, conflicts: 0, keptLocal: 3, danglingRefs: [] } }, applicableOk)
    const conflict = bundlePlanView({ ok: true, summary: { willWrite: 0, conflicts: 3, keptLocal: 0, danglingRefs: [] } }, { ok: false, code: 'IMPORT_HAS_CONFLICTS', reason: 'r' })
    assert.equal(kept.applicable, true)
    assert.equal(conflict.applicable, false)
    assert.notDeepEqual(kept.lines, conflict.lines)
  })

  test('计划不合法 → 拒绝优先：不再列"将写入 N 条"', () => {
    const v = bundlePlanView({ ok: false, errors: ['profiles[0].model 缺失', 'bindings[1] 引用悬空'] }, null)
    assert.equal(v.applicable, false)
    assert.deepEqual(v.lines, [])
    assert.match(v.blocked, /profiles\[0\]\.model 缺失/)
    assert.match(v.blocked, /bindings\[1\] 引用悬空/)
  })

  test('没有计划 → 不崩，并说清先做什么', () => {
    for (const bad of [null, undefined, 'x', 42]) {
      const v = bundlePlanView(bad, null)
      assert.equal(v.applicable, false)
      assert.match(v.blocked, /先粘贴/)
    }
  })

  test('要凭证的条数被单独说出来（否则导入完"看起来配好了"）', () => {
    const v = bundlePlanView(
      { ok: true, summary: { willWrite: 2, conflicts: 0, keptLocal: 0, needsCredential: 2, danglingRefs: [] } },
      applicableOk,
    )
    assert.equal(v.headline, '可以导入')
    assert.ok(v.lines.some((l) => /需要凭证/.test(l) && /录入/.test(l)), v.lines.join(' | '))
  })

  test('悬空引用被报出来（服务端会因此拒绝应用）', () => {
    const v = bundlePlanView(
      { ok: true, summary: { willWrite: 1, conflicts: 0, keptLocal: 0, danglingRefs: [{ binding: 'default/reviewer', profile: 'gone' }] } },
      { ok: false, code: 'IMPORT_DANGLING_PROFILE_REF', reason: '绑定 default/reviewer 引用了不存在的模型档案 gone' },
    )
    assert.equal(v.applicable, false)
    assert.ok(v.lines.some((l) => /引用了不存在的档案/.test(l)), v.lines.join(' | '))
  })
})

describe('⑦b 迁移计划复用 importPlanView（同一份后端形状，不另写一份读法）', () => {
  test('被拒绝的行与"没有可导入内容"的标题都来自 modelSettings.ts 的实现', () => {
    const v = migrationPlanView({
      ok: true, code: 'MIGRATION_OK', toCreate: [], toUpdate: [], refused: [{ index: 3, reason: 'runtimeType 缺失' }],
    })
    assert.equal(v.ok, true)
    assert.equal(v.needsConfirm, true)
    assert.match(v.headline, /被拒绝/)
    assert.ok(v.lines.some((l) => /runtimeType 缺失/.test(l)))
  })

  test('非法输入 → 与 importPlanView 的非计划分支逐字一致', () => {
    const v = migrationPlanView(null)
    assert.equal(v.ok, false)
    assert.match(v.blocked, /先选择/)
  })
})

// ─────────────────────────────── ⑧ 岗位解析链：真实的字段名与 chainView 认的不一样

describe('⑧ 岗位解析链的形状适配：字段名不对会让被跳过的候选变成「（未知档案）」', () => {
  // 服务端（`orchestrator/model-binding/index.mjs`）的真实形状。
  const raw = {
    ok: true,
    code: null,
    message: '',
    employeeRole: 'reviewer',
    chain: [
      { id: 'p-main', role: 'primary', order: 0, displayName: '主力', provider: 'custom-ds', model: 'deepseek-v4-flash-openai', hasCredential: true },
      { id: 'p-back', role: 'fallback', order: 1, displayName: '备用', provider: 'custom-ds', model: 'deepseek-v4-pro-openai', hasCredential: true },
    ],
    skipped: [
      { id: 'p-gone', role: 'fallback', order: 2, code: 'PROFILE_NOT_FOUND', message: '没有这个模型档案：p-gone（引用打错了，或档案从未建立）' },
    ],
    perRunBudget: null,
    errors: [],
  }

  test('**适配器是承重的**：不映射时被跳过的候选变成「（未知档案）」且没有原因', () => {
    // 真实字段是 `id`/`message`，而 `chainView` 认 `profileId`/`reason`。
    // 可用项还能靠 `displayName` 撑住标签，**被跳过的那一项两样都丢**——
    // 而它恰恰是用户最需要看到的那一条（"我的备用模型为什么不生效"）。
    const naive = chainView(raw.skipped)
    assert.equal(naive[0].label, '（未知档案）', '这正是"不映射"会发生的事（字段名是 id 而不是 profileId）')
    assert.equal(naive[0].note, null, '原因也一起丢了（字段名是 message 而不是 reason）')

    // 可用项的备注同样会丢：真实形状里没有 `reason`。
    assert.equal(chainView(raw.chain)[0].note, null)

    const v = resolutionView(raw)
    assert.deepEqual(v.entries.map((e) => e.label), ['主力', '备用', 'p-gone'])
    assert.notEqual(v.entries[2].label, naive[0].label)
    assert.notEqual(v.entries[2].note, naive[0].note)
  })

  test('被跳过的候选**也要出现**，并带上服务端给的原因', () => {
    const v = resolutionView(raw)
    assert.equal(v.entries.length, 3, '两个可用 + 一个被跳过')
    assert.deepEqual(v.entries.map((e) => e.role), ['primary', 'fallback', 'unusable'])
    assert.match(v.entries[2].note, /没有这个模型档案：p-gone/)
  })

  test('可用项的备注是**事实**（供应商/模型），不是编出来的"为什么选它"', () => {
    const v = resolutionView(raw)
    assert.match(v.entries[0].note, /custom-ds\/deepseek-v4-flash-openai/)
    assert.ok(!/因为|所以/.test(v.entries[0].note), `不该编造理由：${v.entries[0].note}`)
  })

  test('`ok:false`（主档案解析不出来）是**正常响应**，有自己的码与说明', () => {
    const v = resolutionView({
      ok: false, code: 'PRIMARY_UNRESOLVED', message: '主档案 p-nope 不可用（PROFILE_NOT_FOUND）',
      chain: [], skipped: [{ id: 'p-nope', role: 'primary', order: 0, code: 'PROFILE_NOT_FOUND', message: '没有这个模型档案：p-nope' }],
    })
    assert.equal(v.ok, false)
    assert.equal(v.code, 'PRIMARY_UNRESOLVED')
    assert.match(v.message, /不可用/)
    assert.equal(v.entries[0].role, 'unusable', '解析不出来的主档案不能被渲染成一条可用链')
  })

  test('垃圾输入不崩，也不假装解析出了一条链', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      const v = resolutionView(bad)
      assert.equal(v.ok, false)
      assert.deepEqual(v.entries, [])
    }
    assert.deepEqual(resolutionView({ chain: 'x', skipped: 7 }).entries, [])
  })
})

// ─────────────────────── ⑨ 改档案时留空 secretRef：服务端算「清掉」，界面必须说「清掉」

describe('⑨ 留空 secretRef = 清掉引用（服务端 `SET secret_ref=?`，不是"不改动"）', () => {
  test('有凭证 + 留空 → 判定为"会清掉"，且默认拦住保存', () => {
    const v = secretRefEditView({ hasCredential: true, secretRefInput: '' })
    assert.equal(v.clearsCredential, true)
    assert.equal(v.needsExplicitClear, true, '不拦住的话，改个显示名就会顺手销毁凭证')
    assert.equal(v.tone, 'warn')
  })

  test('**文案不许说"不改动"**：这正是原来那行会误导人的字', () => {
    const v = secretRefEditView({ hasCredential: true, secretRefInput: '' })
    assert.ok(!v.notice.includes('不改动'), `这句话必须消失（它正好是反的）：${v.notice}`)
    // 「保持原样」只能以**被否定**的形式出现（"不是「保持原样」"）。
    // 单看 `includes('保持原样')` 会把这个否定句也判成违规——一条会给出错误结论的
    // 断言比没有断言更坏，所以这里连否定一起判。
    if (v.notice.includes('保持原样')) {
      assert.match(v.notice, /不是[「"']?保持原样/, `"保持原样"只允许以被否定的形式出现：${v.notice}`)
    }
    // 正面断言：必须点名"清掉"，并说清为什么（服务端把缺失当成 null）
    assert.ok(v.notice.includes('清掉'), `必须直说清掉：${v.notice}`)
    assert.ok(v.notice.includes('null'), '必须给出服务端语义的依据')
    assert.ok(v.notice.includes('无法') || v.notice.includes('不显示') || v.notice.includes('永远是空的'),
      `必须解释"为什么编辑框是空的"：${v.notice}`)
  })

  test('有凭证 + 填了引用名 → **不是**清除，而是替换', () => {
    const v = secretRefEditView({ hasCredential: true, secretRefInput: 'OPENAI_KEY' })
    assert.equal(v.clearsCredential, false, '填了值就不是销毁，不该要确认框')
    assert.equal(v.needsExplicitClear, false)
    assert.ok(v.notice.includes('替换'), `要说清是替换：${v.notice}`)
    assert.ok(!v.notice.includes('清掉'))
  })

  test('本来就没有凭证 + 留空 → **不是**清除，也不该弹确认框', () => {
    const v = secretRefEditView({ hasCredential: false, secretRefInput: '' })
    assert.equal(v.clearsCredential, false, '没有的东西谈不上被清掉')
    assert.equal(v.needsExplicitClear, false, '每次新建都要先勾一个毫无损失的确认框，会把确认框训练成无脑点击')
    assert.equal(v.tone, 'muted')
    assert.ok(!v.notice.includes('清掉'))
  })

  test('纯空白等于留空（一串空格不许被当成「填了」）', () => {
    for (const blank of ['', ' ', '\t', '\n', '  \t ']) {
      assert.equal(secretRefEditView({ hasCredential: true, secretRefInput: blank }).clearsCredential, true, `空白串 ${JSON.stringify(blank)}`)
      assert.equal(secretRefEditView({ hasCredential: false, secretRefInput: blank }).clearsCredential, false)
    }
    // 前后有空白但中间有内容 → 算填了
    assert.equal(secretRefEditView({ hasCredential: true, secretRefInput: ' K ' }).clearsCredential, false)
  })

  test('三种 `hasCredential × 留空` 的组合**互不相同**（不许有两种情况长得一样）', () => {
    const hasBlank = secretRefEditView({ hasCredential: true, secretRefInput: '' })
    const noneBlank = secretRefEditView({ hasCredential: false, secretRefInput: '' })
    const hasFilled = secretRefEditView({ hasCredential: true, secretRefInput: 'K' })
    const texts = [hasBlank.notice, noneBlank.notice, hasFilled.notice]
    assert.equal(new Set(texts).size, 3, '三句必须不同，否则用户分不清自己在做哪一件事')
    const flags = [hasBlank.needsExplicitClear, noneBlank.needsExplicitClear, hasFilled.needsExplicitClear]
    assert.deepEqual(flags, [true, false, false])
  })
})
