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
  collectionView, failedState, loadingState,
  panelErrorFrom, probeViewFrom, readyState, resolutionView,
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

// ★★ 2026-10-12：这里原本是「③ 凭证行：值不可能出现在视图里」（3 条）与
//   「③b 文件权限：aclExists 的两种 false 不是一回事」（4 条）两块 —— 它们测的
//   `secretRowView` / `aclView` 只被「🔑 凭证库」面板（`SecretVaultPanel.tsx`）用，
//   那个页签拆了，两个视图与这 7 条用例一起删除。
//
//   为什么拆：架构决定变了 —— 钥匙由用户在「供应商与模型」页**填一次**，Legion 存下来后
//   写进 DSH（运行时），用户**不需要再看见**那个库；凭证库那一页是"写进 DSH"还没接通时
//   的脚手架。底层存储与后端路由**原样保留**（写入要用），所以那两块钉住的**后端语义**
//   （`aclExists` 的两种 false）仍然成立 —— 它们现在由 `team-hub/secret-routes.test.mjs`
//   （含 `BUG-029` 的判据）守着，而不是由这一层界面守着。

// ★★ 2026-10-12：这里原本是「④ 写回执：轮换的后果必须说出来」（2 条）、
//   「④b 删除回执：幂等不是失败…」（3 条）、「⑤ 凭证错误：每个后端码都有可区分、
//   可行动的文案」（5 条）、「⑥ 自检：ok:false 走 HTTP 200…」（5 条）四块，共 15 条 ——
//   它们测的 `secretWriteResultView` / `secretDeleteResultView` / `secretErrorView` /
//   `secretStatusView` 只被「🔑 凭证库」面板（`SecretVaultPanel.tsx`）用，
//   那个页签拆了，四个视图与这 15 条用例一起删除。
//
//   这四块钉的**后端语义**一条都没有变（删除幂等、`SECRET_*` 码决定下一步、
//   自检失败是 HTTP 200 + `ok:false`）——判据现在在 `team-hub/secret-routes.test.mjs`
//   （含 `BUG-029`）与 `team-hub/secret-admin.test.mjs` 里。

// ★★ 2026-10-12：这里原本是「⑦ 配置包导入计划」整块（7 条用例，测 `bundlePlanView`）——
//   随「配置包」（PRT-508）整体删除。理由不是"没人用"，而是**它在单机部署里没有用**：
//   包里那 27 行（模型档案 + 岗位绑定）本来就在 `team.db` 里 ⇒ 每一次整库备份都已经带着它们；
//   而凭证值从来不在包里（在本机 DPAPI 密钥库）⇒ 换机器无论如何都要重填。
//   现在"配置能不能搬"由**备份/恢复**负责（`product/server/backup.mjs`）。
//
//   那一块里值得留住的两条**读法纪律**没有随它消失，而是被它们原本该在的地方继承了：
//     · "被跳过的必须说出来" ⇒ `bundlePlanView` 的对象没了，但同一条纪律在
//       `provider-store.update` 的"没给 vs 给 null"上活着（判据见 `team-hub/model-secret-leak.test.mjs` ②）；
//     · "计划不合法 → 拒绝优先，不再列将会做什么" ⇒ 见 `team-hub/routes/model-providers.mjs`
//       的 `credentialIntent`（写凭证失败必须**具名拒**，不许"面板说成功、钥匙没进去"）。


// ★ 2026-10-12：这里原有「⑦b 迁移计划复用 importPlanView」两块用例 —— 随「配置迁移」
//   一起删掉了（`migrationPlanView` 与它复用的 `importPlanView` 都已移除）。
//   理由见 `docs/bugs/BUG-026` / `BUG-027`。

// ★★ 2026-10-12：这里原本是上一轮加的「⑧ 凭证库：**没有任何供应商指向它**的条目要标出来」
//   整块（4 条用例，测 `secretRowView` 的孤儿标记 `orphanText` / `isOrphan`）——
//   它随「🔑 凭证库」页签（`SecretVaultPanel.tsx`）一起拆除：那个视图只被那一页用。
//
//   孤儿这件事**本身没有消失**：删供应商默认不动密钥（服务端语义一个字没改），
//   所以库里仍然会有"没有任何供应商指向它"的条目。变的是**它不再需要被渲染成一栏**——
//   那一页已经没有了。想清掉孤儿的出口留在删供应商那一格（`DshProvidersPanel.tsx`
//   的「同时删掉它的钥匙」），后端判据见 `team-hub/secret-routes.test.mjs`。

