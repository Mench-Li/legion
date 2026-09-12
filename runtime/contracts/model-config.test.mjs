// runtime/contracts/model-config.test.mjs
// ============================================================================
// PRT-252：Workbench 模型配置的产品化校验
//
// 这一组守的是三个**很容易被合并成一个**的区别：
//
//   ① 「校验不了」（读不到档案） ≠ 「配置错了」（供应商/型号不存在）
//   ② 「一个档案都没有」 ≠ 「你选的那个供应商未知」
//   ③ 「合法」 ≠ 「能跑」（缺凭证 / 档案已停用）
//
// 每一条被合并掉，都会产生一种具体的、用户看得见的坏结果：
//   - 合并 ① → 让人去查拼写，而真正的问题是我们根本没查成
//   - 合并 ② → 让人去查拼写，而真正该做的是"先去登记一个模型"
//   - 合并 ③ → **"保存成功"但跑不起来**，而且失败在很久之后、别的地方
//
// 所以下面每一条区分都单独钉一个用例。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MODEL_CONFIG_CODES,
  MODEL_CONFIG_WARNINGS,
  describeModelConfigResult,
  modelConfigErrorFor,
  validateAgentModelSelection,
} from './model-config.mjs'

/** 造一批模型档案（形状与 team-hub `model_profiles` 一致）。 */
const PROFILES = [
  { id: 'p1', displayName: 'DeepSeek Flash', provider: 'custom-ds', model: 'deepseek-v4-flash-openai', secretRef: 'DEEPSEEK_API_KEY' },
  { id: 'p2', displayName: 'DeepSeek Pro', provider: 'custom-ds', model: 'deepseek-v4-pro-openai', secretRef: 'DEEPSEEK_API_KEY' },
  { id: 'p3', displayName: 'GLM 5.1', provider: 'zai-coding-cn', model: 'glm-5.1', secretRef: 'ZAI_API_KEY' },
]

const ok = (r) => validateAgentModelSelection({ provider: 'custom-ds', model: 'deepseek-v4-pro-openai', profiles: PROFILES })

// ------------------------------------------------------------------ 通过

test('合法选择 → ok，且带出命中的档案', () => {
  const r = ok()
  assert.equal(r.ok, true)
  assert.equal(r.code, MODEL_CONFIG_CODES.OK)
  assert.equal(r.profile.id, 'p2')
  assert.deepEqual(r.warnings, [])
})

// ------------------------------------------------------------------ ① 校验不了 ≠ 配置错了

test('**读不到档案 → CANNOT_VALIDATE，而不是"未知供应商"**', () => {
  // 这是最关键的一条。仓储读不到时我们**什么都不知道**；
  // 报"未知供应商"是撒谎——它会让人去查拼写，而真正的问题是我们没查成。
  for (const profiles of [null, undefined, 'oops', 42, {}]) {
    const r = validateAgentModelSelection({ provider: 'custom-ds', model: 'x', profiles })
    assert.equal(r.code, MODEL_CONFIG_CODES.CANNOT_VALIDATE, `profiles=${JSON.stringify(profiles)}`)
    assert.equal(r.ok, false, '**fail closed**："查不了就放行"比没有校验更坏')
    assert.notEqual(r.code, MODEL_CONFIG_CODES.UNKNOWN_PROVIDER)
    assert.match(r.message, /未被验证|无法校验/)
  }
})

test('**一个档案都没有 → NO_PROFILES，而不是"未知供应商"**', () => {
  // 说"未知供应商"会把人引向"我是不是拼错了"，
  // 而真正该做的是"先去登记一个模型"。
  const r = validateAgentModelSelection({ provider: 'custom-ds', model: 'deepseek-v4-pro-openai', profiles: [] })
  assert.equal(r.code, MODEL_CONFIG_CODES.NO_PROFILES)
  assert.notEqual(r.code, MODEL_CONFIG_CODES.UNKNOWN_PROVIDER)
  assert.match(r.hint, /登记/)
})

// ------------------------------------------------------------------ 空选择

test('缺 provider/model → EMPTY_SELECTION，并点名缺哪一个', () => {
  const both = validateAgentModelSelection({ profiles: PROFILES })
  assert.equal(both.code, MODEL_CONFIG_CODES.EMPTY_SELECTION)
  assert.equal(both.field, 'provider/model')

  const noProvider = validateAgentModelSelection({ provider: '  ', model: 'm', profiles: PROFILES })
  assert.equal(noProvider.field, 'provider')

  const noModel = validateAgentModelSelection({ provider: 'custom-ds', model: '', profiles: PROFILES })
  assert.equal(noModel.field, 'model')
})

// ------------------------------------------------------------------ 未知

test('供应商不存在 → UNKNOWN_PROVIDER，文案里给出**实际登记过**的供应商', () => {
  const r = validateAgentModelSelection({ provider: 'openai', model: 'gpt-4', profiles: PROFILES })
  assert.equal(r.code, MODEL_CONFIG_CODES.UNKNOWN_PROVIDER)
  assert.equal(r.field, 'provider')
  assert.deepEqual(r.candidates, ['custom-ds', 'zai-coding-cn'])
  assert.match(r.hint, /custom-ds/)
  // 只列出**存在**的，不把用户输入的那个混进候选里
  assert.ok(!r.candidates.includes('openai'))
})

test('供应商对、型号错 → UNKNOWN_MODEL，候选只列该供应商下的型号', () => {
  const r = validateAgentModelSelection({ provider: 'custom-ds', model: 'deepseek-v9', profiles: PROFILES })
  assert.equal(r.code, MODEL_CONFIG_CODES.UNKNOWN_MODEL)
  assert.equal(r.field, 'model')
  assert.deepEqual(r.candidates, ['deepseek-v4-flash-openai', 'deepseek-v4-pro-openai'])
  // **不得**把别的供应商的型号混进来（那会让用户以为换供应商就行）
  assert.ok(!r.candidates.includes('glm-5.1'))
})

test('型号**不做模糊匹配**（拼错就是拼错，不能被近似接受）', () => {
  // 刻意不做"看起来像"的近似：那会让一个拼错的型号被悄悄接受，
  // 然后在运行时以另一种面目失败。
  for (const bad of ['deepseek-v4-pro', 'DeepSeek-V4-Pro-OpenAI', 'glm-5.1 ', 'deepseek v4 pro']) {
    const r = validateAgentModelSelection({ provider: bad.startsWith('glm') ? 'zai-coding-cn' : 'custom-ds', model: bad.trim(), profiles: PROFILES })
    // 允许前后空白被 trim 后命中；其余一律拒绝
    if (r.ok) assert.equal(bad.trim(), 'glm-5.1', `不该接受：${bad}`)
    else assert.ok([MODEL_CONFIG_CODES.UNKNOWN_MODEL].includes(r.code), `${bad} → ${r.code}`)
  }
})

test('档案里缺 provider/model 的残项被跳过，不会制造幽灵候选', () => {
  const dirty = [...PROFILES, { id: 'bad1' }, { id: 'bad2', provider: 'x' }, null, 'nope']
  const r = validateAgentModelSelection({ provider: 'x', model: 'y', profiles: dirty })
  // `{provider:'x'}` 没有 model → 不进目录 → 'x' 仍是未知供应商
  assert.equal(r.code, MODEL_CONFIG_CODES.UNKNOWN_PROVIDER)
  assert.deepEqual(r.candidates, ['custom-ds', 'zai-coding-cn'])
})

// ------------------------------------------------------------------ ③ 合法 ≠ 能跑

test('**缺凭证 → ok 但仍必须给出警告**（不允许"看起来成功了但跑不了"）', () => {
  // "先登记模型、后补凭证"是合法顺序，拒绝它会把正常路径堵死；
  // 但静默通过也不行——用户会以为配好了。
  const profiles = [{ id: 'n1', displayName: '无凭证', provider: 'custom-ds', model: 'm1', secretRef: null }]
  const r = validateAgentModelSelection({ provider: 'custom-ds', model: 'm1', profiles })
  assert.equal(r.ok, true, '合法顺序不该被拒绝')
  assert.equal(r.warnings.length, 1)
  assert.equal(r.warnings[0].code, MODEL_CONFIG_WARNINGS.NO_CREDENTIAL)
  assert.match(r.warnings[0].message, /运行会失败/)
})

test('档案已停用 → 同样是警告（能保存，但要说清跑不起来）', () => {
  const profiles = [{ id: 'd1', displayName: '停用的', provider: 'p', model: 'm', secretRef: 'K', enabled: false }]
  const r = validateAgentModelSelection({ provider: 'p', model: 'm', profiles })
  assert.equal(r.ok, true)
  assert.deepEqual(r.warnings.map((w) => w.code), [MODEL_CONFIG_WARNINGS.PROFILE_DISABLED])
})

test('descriptor 形态（`hasCredential`）也认，且不误报缺凭证', () => {
  // 仓储的 descriptor 带 `hasCredential` 布尔而不是 `secretRef`。
  const withCred = [{ id: 'a', displayName: 'A', provider: 'p', model: 'm', hasCredential: true }]
  assert.deepEqual(validateAgentModelSelection({ provider: 'p', model: 'm', profiles: withCred }).warnings, [])

  const noCred = [{ id: 'b', displayName: 'B', provider: 'p', model: 'm', hasCredential: false }]
  const r = validateAgentModelSelection({ provider: 'p', model: 'm', profiles: noCred })
  assert.equal(r.warnings[0].code, MODEL_CONFIG_WARNINGS.NO_CREDENTIAL)
})

test('**两种字段都没有时不报缺凭证**（不知道就不说，否则是永远不对的警告）', () => {
  // 猜"没有"会制造一条永远不对的警告；按本项目已记过的那条，
  // **一条永远不对的告警，和没有告警，是同一件事**。
  const unknown = [{ id: 'c', displayName: 'C', provider: 'p', model: 'm' }]
  const r = validateAgentModelSelection({ provider: 'p', model: 'm', profiles: unknown })
  assert.equal(r.ok, true)
  assert.deepEqual(r.warnings, [])
})

test('缺凭证 + 已停用 → 两条警告都要有（不能被前一条吃掉）', () => {
  const profiles = [{ id: 'x', displayName: 'X', provider: 'p', model: 'm', secretRef: null, status: 'disabled' }]
  const r = validateAgentModelSelection({ provider: 'p', model: 'm', profiles })
  assert.equal(r.warnings.length, 2)
})

// ------------------------------------------------------------------ 用户可见

test('`describeModelConfigResult` 给出**一行、可读、带下一步**的话', () => {
  const bad = validateAgentModelSelection({ provider: 'openai', model: 'gpt-4', profiles: PROFILES })
  const line = describeModelConfigResult(bad)
  assert.match(line, /openai/)
  assert.match(line, /custom-ds/)     // 下一步该选哪个
  assert.ok(!line.includes('MODEL_CONFIG_'), '不给用户看内部码')

  const good = ok()
  assert.equal(describeModelConfigResult(good), '模型配置有效。')

  // 有警告时，describe 必须把警告说出来（否则"成功"两个字会掩盖跑不起来）
  const warned = validateAgentModelSelection({
    provider: 'p', model: 'm', profiles: [{ id: 'w', displayName: 'W', provider: 'p', model: 'm', secretRef: null }],
  })
  assert.match(describeModelConfigResult(warned), /运行会失败/)
})

test('`modelConfigErrorFor` 带出 400 + 结构化字段（前端能落到具体输入框上）', () => {
  const r = validateAgentModelSelection({ provider: 'openai', model: 'gpt-4', profiles: PROFILES })
  const err = modelConfigErrorFor(r)
  assert.equal(err.statusCode, 400)
  assert.equal(err.code, MODEL_CONFIG_CODES.UNKNOWN_PROVIDER)
  assert.equal(err.field, 'provider')
  assert.ok(!String(err.message).includes('MODEL_CONFIG_'))
})

test('结果对象不可变（避免下游顺手改写 code 把失败变成成功）', () => {
  const r = ok()
  assert.equal(Object.isFrozen(r), true)
  assert.throws(() => { r.ok = false }, TypeError)
})

// ------------------------------------------------------------------ 全部码都是总的

test('每个码都可达（不存在"定义了但永远不会出现"的分支）', () => {
  const seen = new Set([
    validateAgentModelSelection({ profiles: PROFILES }).code,
    validateAgentModelSelection({ provider: 'a', model: 'b', profiles: null }).code,
    validateAgentModelSelection({ provider: 'a', model: 'b', profiles: [] }).code,
    validateAgentModelSelection({ provider: 'nope', model: 'b', profiles: PROFILES }).code,
    validateAgentModelSelection({ provider: 'custom-ds', model: 'nope', profiles: PROFILES }).code,
    validateAgentModelSelection({ provider: 'custom-ds', model: 'deepseek-v4-pro-openai', profiles: PROFILES }).code,
  ])
  const all = Object.values(MODEL_CONFIG_CODES)
  for (const code of all) assert.ok(seen.has(code), `这个码不可达：${code}`)
})

// ------------------------------------------------------------------ 接线

test('**路由真的接上了校验**（这条守的是"接线被拔掉"）', async () => {
  // 这一组上面的用例全都只测"怎么判"，不测"有没有被判"。
  // **一个没被调用到的判定，和一个不存在的判定，在输出上完全一样。**
  //
  // 这是一条**源码断言**，它比行为用例弱——但它恰好能抓住那个真实的失败模式：
  // 有人把 `throw modelConfigErrorFor(verdict)` 删掉，于是 `POST /api/models`
  // 退回"什么都校验、什么都存"，而上面 16 条用例**依然全绿**。
  //
  // 真正的行为验证在 `scripts/prt/` 的端到端冒烟里（真起 hub、真发请求，
  // 断言 400 + 可读文案）；这里只做一道防回退的闸门。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../../team-hub/server.mjs', import.meta.url), 'utf8')
  assert.match(src, /validateAgentModelSelection\(\{ provider, model, profiles: modelStore\.list\(\) \}\)/,
    'POST /api/models 必须调用产品化校验')
  assert.match(src, /throw modelConfigErrorFor\(verdict\)/,
    '校验不通过必须抛出结构化错误，而不是继续写库')
  // 结构化字段也要真的走到响应体里，否则前端拿不到 field/hint
  assert.match(src, /if \(typeof e\?\.field === 'string'\) extra\.field = e\.field/,
    'handleWrite 必须把 field 带进响应体')
})
