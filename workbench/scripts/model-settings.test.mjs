// workbench/scripts/model-settings.test.mjs
// ============================================================================
// PRT-507：模型设置页的纯逻辑
//
// 这一组守的是一条已经被这个仓库反复证明的纪律：
//
//   **后端加了码、前端还是笼统提示 —— 那条码就等于没加。**
//
// 所以每个后端码都必须有**可区分、可行动**的文案，逐条钉住。
//
// 而其中最重要的一条判断是：
//
//   **「没探测过」不是「探测失败」。**
//
// 把 503（密钥库打不开 / 布局不合法 / 没填 endpoint）渲染成"连接失败"，
// 用户会去查网络与供应商状态——**一条完全错误的方向**，
// 而且他会开始怀疑一个其实**从未被验证过**的东西。
// ============================================================================
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  chainView, fieldErrorFrom, importPlanView, probeBadge, profileRowView, suggestCandidates,
} from '../src/modelSettings.ts'

const verdicts = (over = {}) => ({ ok: false, code: 'AUTH_FAILED', class: 'config', ...over })

describe('①「没探测过」与「探测失败」必须渲染成两件不同的事', () => {
  test('unavailable → 灰色「未测试」，而**不是**红色的失败', () => {
    const b = probeBadge({
      ok: false, unavailable: true, code: 'PROBE_SECRETS_UNAVAILABLE',
      message: '无法测试连接：密钥库打不开（SECRETS_STORE_UNPROTECTED）。**这次没有探测过**。',
    })
    assert.equal(b.tone, 'muted', '灰色：这不是一次失败判定')
    assert.equal(b.label, '未测试')
    assert.match(b.detail, /这次没有探测过/)
    assert.match(b.action, /不是"连不上"/)
  })

  test('unavailable **绝不**显示失败分类（那时没有分类可言）', () => {
    const b = probeBadge({ ok: false, unavailable: true, code: 'X', message: 'm' })
    assert.ok(!/分类/.test(b.detail), `未测试不该提分类：${b.detail}`)
    assert.ok(!/fail-closed|transient|config/.test(b.detail))
  })

  test('从未测试 → 也是灰色，且明确说"没测过不等于可用"', () => {
    for (const empty of [null, undefined]) {
      const b = probeBadge(empty)
      assert.equal(b.tone, 'muted')
      assert.equal(b.label, '未测试')
      assert.match(b.action, /没测过不等于可用/)
    }
  })

  test('未测试也要能重试（那正是修好之后要做的事）', () => {
    assert.equal(probeBadge({ unavailable: true, code: 'X' }).canRetry, true)
    assert.equal(probeBadge(null).canRetry, true)
  })
})

describe('② 失败分类决定「该做什么」，未知就是未知', () => {
  test('四种分类给出四句**不同**的下一步', () => {
    const actions = ['fail-closed', 'config', 'transient', 'unknown'].map((cls) => {
      const b = probeBadge(verdicts({ class: cls }))
      assert.equal(b.tone, 'bad')
      return b.action
    })
    assert.equal(new Set(actions).size, 4, '四种分类的动作文案必须互不相同')
  })

  test('fail-closed 明确拦住"去供应商那边换钥匙"这条错误方向', () => {
    const b = probeBadge(verdicts({ class: 'fail-closed', code: 'SECRET_UNAVAILABLE' }))
    assert.match(b.action, /本机凭证库/)
    assert.match(b.action, /不要去供应商控制台/)
  })

  test('config 说明**重试不会变好**（否则用户会一直点重试）', () => {
    const b = probeBadge(verdicts({ class: 'config', code: 'MODEL_NOT_FOUND' }))
    assert.match(b.action, /重试不会变好/)
  })

  test('**unknown 不得被猜成 transient**（那会让人反复重试一个永远不好的东西）', () => {
    const unk = probeBadge(verdicts({ class: 'unknown', code: 'UNCLASSIFIED' }))
    assert.match(unk.action, /不能当作暂时问题重试/)
    const trans = probeBadge(verdicts({ class: 'transient', code: 'TIMEOUT' }))
    assert.notEqual(unk.action, trans.action)
  })

  test('分类缺失时按 unknown 处理，不按 transient（保守方向是"别乱重试"）', () => {
    const b = probeBadge({ ok: false, code: 'AUTH_FAILED' })
    assert.match(b.action, /不能当作暂时问题重试/)
  })
})

describe('③ 每个判定码都有可区分文案（码是总的）', () => {
  test('全部 13 个判定码都能渲染，且文案互不重复', () => {
    const codes = ['OK', 'SECRET_UNAVAILABLE', 'SECRET_REF_MISSING', 'AUTH_FAILED',
      'ENDPOINT_UNREACHABLE', 'TLS_FAILED', 'RATE_LIMITED', 'MODEL_NOT_FOUND',
      'PROVIDER_ERROR', 'BAD_RESPONSE', 'TIMEOUT', 'CAPABILITY_MISSING', 'UNCLASSIFIED']
    const texts = codes.map((code) => probeBadge(verdicts({ code })).detail)
    for (const [i, t] of texts.entries()) {
      assert.ok(!/没有对应的说明/.test(t), `${codes[i]} 缺文案：${t}`)
    }
    assert.equal(new Set(texts).size, codes.length, '每个码的文案必须互不相同')
  })

  test('**未列出的码走 unknown 分支并说出来**（不假装认识它）', () => {
    const b = probeBadge({ ok: false, code: 'SOME_FUTURE_CODE', class: 'config' })
    assert.match(b.detail, /未归类/)
    assert.equal(b.tone, 'bad')
  })

  test('通过时把延迟与能力都报出来', () => {
    const b = probeBadge({ ok: true, code: 'OK', latencyMs: 42, capabilities: { chat: true, tools: true, vision: false } })
    assert.equal(b.tone, 'ok')
    assert.match(b.detail, /42 ms/)
    assert.match(b.detail, /chat/)
    assert.match(b.detail, /tools/)
    assert.ok(!b.detail.includes('vision'), 'false 的能力不该被列成已具备')
  })

  test('**空能力表不等于"什么都不支持"**（必须说出来）', () => {
    const b = probeBadge({ ok: true, code: 'OK', latencyMs: 5, capabilities: {} })
    assert.match(b.detail, /没有报告任何能力/)
    assert.match(b.detail, /不等于.*什么都不支持/)
  })

  test('缺能力是**黄色**，不是红色（连接本身是好的）', () => {
    const b = probeBadge({ ok: false, code: 'CAPABILITY_MISSING', class: 'config', missingCapabilities: ['tools'] })
    assert.equal(b.tone, 'warn')
    assert.match(b.detail, /tools/)
  })
})

describe('④ 档案行：凭证状态必须显式', () => {
  test('hasCredential 三态各有不同文案', () => {
    const yes = profileRowView({ id: 'a', hasCredential: true })
    const no = profileRowView({ id: 'b', hasCredential: false })
    assert.equal(yes.credential.tone, 'ok')
    assert.equal(no.credential.tone, 'warn')
    assert.match(no.credential.text, /运行会失败/)
    assert.notEqual(yes.credential.text, no.credential.text)
  })

  test('**凭证状态未知时不说"没有"**（猜"没有"会制造永远不对的提示）', () => {
    const unknown = profileRowView({ id: 'c', provider: 'p', model: 'm' })
    assert.equal(unknown.credential.tone, 'muted')
    assert.match(unknown.credential.text, /未知/)
    assert.ok(!/没有凭证/.test(unknown.credential.text))
  })

  test('有引用名只报"引用了名字"，**不**断言它有效', () => {
    const r = profileRowView({ id: 'd', secretRef: 'SOME_KEY' })
    assert.equal(r.credential.tone, 'ok')
    assert.match(r.credential.text, /是否有效要看测试结果/)
  })

  test('缺字段不崩，且显式说"未填"（而不是显示空白）', () => {
    const r = profileRowView({})
    assert.equal(r.title, '（未命名档案）')
    assert.match(r.subtitle, /未填供应商/)
    assert.match(r.subtitle, /未填模型/)
    assert.equal(r.endpointText, '（未填地址）')
    assert.equal(profileRowView(null).id, '')
  })

  test('displayName 为空时退回 id；两者都没有才说未命名', () => {
    assert.equal(profileRowView({ id: 'x', displayName: '' }).title, 'x')
    assert.equal(profileRowView({ id: '', displayName: '' }).title, '（未命名档案）')
  })

  test('停用状态被单独标出', () => {
    assert.equal(profileRowView({ id: 'e', enabled: false }).disabled, true)
    assert.equal(profileRowView({ id: 'e', status: 'disabled' }).disabled, true)
    assert.equal(profileRowView({ id: 'e' }).disabled, false)
  })
})

describe('⑤ 表单错误要落到**具体字段**上（PRT-252 的另一半）', () => {
  test('消费 field / hint / candidates', () => {
    const e = fieldErrorFrom({
      error: '没有已登记的供应商「openai」。',
      code: 'MODEL_CONFIG_UNKNOWN_PROVIDER',
      field: 'provider',
      hint: '已登记的供应商：custom-ds、zai-coding-cn。',
      candidates: ['custom-ds', 'zai-coding-cn'],
    })
    assert.equal(e.field, 'provider')
    assert.match(e.text, /openai/)
    assert.match(e.hint, /custom-ds/)
    assert.deepEqual(e.candidates, ['custom-ds', 'zai-coding-cn'])
  })

  test('没有 field 的失败落在**表单顶部**（不是随便找个框塞进去）', () => {
    const e = fieldErrorFrom({ error: '缺少 provider 或 model' })
    assert.equal(e.field, null)
    assert.equal(e.hint, null)
    assert.deepEqual(e.candidates, [])
  })

  test('响应体是垃圾时不崩，且不编造原因', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      const e = fieldErrorFrom(bad)
      assert.equal(e.field, null)
      assert.equal(typeof e.text, 'string')
      assert.ok(e.text.length > 0)
    }
    assert.match(fieldErrorFrom({}).text, /没有给出原因/)
  })

  test('候选建议**去重**，且**不把用户已经填的值混进去**', () => {
    // 把用户输入的那个混进候选，看起来像"系统认可了你填的"，而它并不存在。
    const out = suggestCandidates(['custom-ds', 'custom-ds', 'openai', 'zai-coding-cn', ''], 'openai')
    assert.deepEqual(out, ['custom-ds', 'zai-coding-cn'])
    assert.ok(!out.includes('openai'))
  })
})

describe('⑥ fallback 链：不可用的候选也要显示，并带上原因', () => {
  test('可选 / 被跳过都出现，角色可区分', () => {
    const view = chainView([
      { profileId: 'p1', displayName: '主', reason: '绑定的主模型' },
      { profileId: 'p2', displayName: '备', reason: '同一供应商，成本更低' },
      { profileId: 'p3', displayName: '废', skipped: true, reason: '没有凭证' },
    ])
    assert.equal(view.length, 3, '被跳过的**也要**显示——只显示能用的会让用户以为链条更短')
    assert.deepEqual(view.map((v) => v.role), ['primary', 'fallback', 'unusable'])
    assert.match(view[2].note, /没有凭证/)
  })

  test('原因永远显示（可用项也一样）——「为什么是它」同样重要', () => {
    const view = chainView([{ profileId: 'p1', reason: '因为 X' }])
    assert.equal(view[0].note, '因为 X')
  })

  test('原因缺失时为 null，不编造一句', () => {
    const view = chainView([{ profileId: 'p1' }])
    assert.equal(view[0].note, null)
  })

  test('空链/非法输入 → 空数组（不崩，也不假装有一段链）', () => {
    for (const bad of [null, undefined, 'x', 42]) assert.deepEqual(chainView(bad), [])
  })

  test('名字缺失时退回 id，两者都没有才说未知', () => {
    assert.equal(chainView([{ profileId: 'p9' }])[0].label, 'p9')
    assert.equal(chainView([{}])[0].label, '（未知档案）')
  })
})

describe('⑦ 导入计划：拒绝优先，跳过也要说', () => {
  test('**拒绝优先**：包不可用时不再列"将会更新 N 项"（那会让人以为反正能导）', () => {
    const v = importPlanView({
      ok: false, message: '包里含密钥字段，已拒绝导入', toUpdate: ['a', 'b', 'c'],
    })
    assert.equal(v.ok, false)
    assert.match(v.blocked, /含密钥/)
    assert.deepEqual(v.lines, [], '被拒绝时不该再列变更项')
    assert.equal(v.needsConfirm, false)
  })

  test('可用时把新建/更新/**保留本机**都列出来', () => {
    const v = importPlanView({ ok: true, toCreate: ['a'], toUpdate: ['b', 'c'], keptLocal: ['x'] })
    assert.equal(v.ok, true)
    assert.equal(v.needsConfirm, true)
    assert.ok(v.lines.some((l) => /新建 1/.test(l)))
    assert.ok(v.lines.some((l) => /更新 2/.test(l)))
    // 跳过的必须说出来，否则用户以为导入把一切都覆盖了
    assert.ok(v.lines.some((l) => /保留本机现有设置 1/.test(l)), v.lines.join(' | '))
  })

  test('冲突数被与"更新"分开报（冲突不等于会更新）', () => {
    const v = importPlanView({ ok: true, toUpdate: ['b'], conflicts: ['x', 'y'] })
    assert.ok(v.lines.some((l) => /冲突 2/.test(l)))
  })

  test('没有任何变更时**不需要确认**（别让用户点一个什么也不做的按钮）', () => {
    const v = importPlanView({ ok: true, toCreate: [], toUpdate: [] })
    assert.equal(v.needsConfirm, false)
    assert.match(v.headline, /没有需要变更的内容/)
  })

  test('没有计划时不崩，并要求先选文件', () => {
    for (const bad of [null, undefined]) {
      const v = importPlanView(bad)
      assert.equal(v.ok, false)
      assert.match(v.blocked, /先选择/)
    }
  })

  test('**被拒绝的行必须说出来**（否则一次静默的部分导入看起来像全成功）', () => {
    // 后端形状：`ok: true` 与 `refused` 非空**可以同时成立**——
    // `model-migration.mjs` 只在"源里出现密钥"时才因 refused 拒绝整个计划，
    // 单纯的行级拒绝（不是对象、档案字段非法）会与 OK 并存。
    // 之前 `importPlanView` 读了 `refused` 却从不使用（TS6133 指的就是这里），
    // 于是界面会说"可以导入 · 新建 7 个"，而另外 3 行**无声消失**。
    const v = importPlanView({
      ok: true,
      toCreate: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      refused: [
        { index: 2, code: 'MIGRATION_BAD_SOURCE', reason: '这一行不是对象' },
        { index: 5, code: 'MIGRATION_INVALID_PROFILE', reason: 'runtimeType 缺失' },
      ],
    })
    assert.equal(v.ok, true, '整包仍然可用')
    const refusedLines = v.lines.filter((l) => /被拒绝/.test(l))
    assert.equal(refusedLines.length, 2, `两条拒绝各要说一次；实际：${v.lines.join(' | ')}`)
    assert.ok(refusedLines.some((l) => /不是对象/.test(l)), '理由要带出来')
    assert.ok(refusedLines.some((l) => /runtimeType 缺失/.test(l)))
    assert.ok(refusedLines.every((l) => /不会导入/.test(l)), '必须说清这些行不会进去')
    // 有拒绝行时仍然需要确认——确认框是用户看到这些硬话的最后机会
    assert.equal(v.needsConfirm, true)
  })

  test('拒绝项是字符串（旧数据）时也能读，且空理由不产生空话', () => {
    const v = importPlanView({ ok: true, toUpdate: ['a'], refused: ['字段非法', ''] })
    const lines = v.lines.filter((l) => /被拒绝/.test(l))
    assert.equal(lines.length, 2)
    assert.ok(lines.some((l) => /字段非法/.test(l)))
    // 没有理由时只说"有 1 行被拒绝"，而不是拼出一个冒号后面什么都没有的句子
    assert.ok(lines.some((l) => l === '有 1 行被拒绝，不会导入'), lines.join(' | '))
  })

  test('**每一行都被拒绝时，标题不能说"没有需要变更的内容"**', () => {
    // 这是 `refused.length` 参与 `needsConfirm` 唯一真正起作用的场景：
    // 没有任何可导入项、但每一行都被拒绝。少算 `refused` 的话，
    // `needsConfirm` 变成 false，界面就成了"没有变更要确认"的样子——
    // 用户以为包是空的，而真实情况是他给的每一行都没能进来。
    const v = importPlanView({ ok: true, toCreate: [], toUpdate: [], refused: [{ reason: '不是对象' }] })
    assert.equal(v.ok, true)
    assert.equal(v.needsConfirm, true, '有被拒绝的行时必须让用户确认')
    assert.doesNotMatch(v.headline, /没有需要变更的内容/, `标题在说谎：${v.headline}`)
    assert.match(v.headline, /被拒绝/)
    assert.ok(v.lines.some((l) => /不是对象/.test(l)))
  })
})
