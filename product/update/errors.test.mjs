// product/update/errors.test.mjs
// ============================================================================
// 错误码表的两条**结构性**判据
//
// ## 为什么单独测这个
//
// `ERROR_TEXT` 是一张"码 → 给用户看的一句话"的表，而它的失败方式是**无声的**：
// 漏登记一个码不会抛、不会崩，只是让用户看到兜底那句
// 「更新过程中出现未知问题，请稍后重试或联系管理员。」
//
// 也就是说：**这张表的缺陷，只有在这张表自己身上才看得出来**。任何走真实
// 路径的用例都不会红——它们拿到的 `reason` 仍然是合法字符串，只是那句话
// 对用户没有任何用处。
//
// 本轮就撞上过一次：⑭ 加的 `update-unsupported-platform` 一直没有文案，
// 而它在**每一台 Windows build 太低的机器上**都会显形。
//
// ## 两条判据
//
// ① 每个客户端码都有专属文案（不许落到兜底）。
// ② 兜底那句本身必须"看起来像兜底"——否则判据 ① 无法区分
//    "有文案"与"文案恰好等于兜底"。
// ============================================================================

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ERROR_TEXT, ERRORS_CHECKED, RETRYABLE_CODES, UPDATE_CODES_CLIENT, describeError, isRetryable } from './errors.mjs'
import { TRANSPORT_CODES } from './transport.mjs'
import { ENVELOPE_CODES } from './envelope.mjs'
import { FEED_CODES } from './feed.mjs'
import { RELEASE_CODES } from './release.mjs'

/** `describeError` 在码上没有文案时用的那一句。 */
const FALLBACK = describeError('一个绝对不存在的码', '')

/**
 * **非错误**的用户可见族码：它们是"结论"而不是"失败"，所以没有文案是对的。
 *
 * ★ 这是豁免名单，也就是上面那条判据的**全部漏洞面**：往里塞一个其实是
 *   错误的码，就等于把那条判据悄悄关掉。所以每一项都要写清为什么，
 *   而且下面有一条用例逐项复核（"还活着吗"、"是不是既有文案又在名单里"）。
 */
const NON_ERROR_CODES = new Set([
  // `selectCandidate` 的**成功**结论（`verdict: 'newer'`，还带着 candidate）。
  // 它永远不会进 `describeError`：那个函数只在 `!judgement.accept` 那一支
  // 被调用，而"发现新版本"从来不是一次拒绝。
  'feed-newer-available',
])

test('★ 兜底那句确实是兜底（判据 ① 的前提）', () => {
  // 如果兜底那句与某条真文案一模一样，下面那条"不许落到兜底"的判据就会
  // 无法区分两者——它会放过恰好等于兜底的那条。
  assert.equal(Object.values(ERROR_TEXT).includes(FALLBACK), false,
    `兜底文案「${FALLBACK}」与表里某一条重复：判据 ① 因此失去分辨力`)
  assert.match(FALLBACK, /未知问题/, `兜底文案变了：${FALLBACK}`)
  // 不存在的码确实落到兜底（这条同时证明判据 ① 的探针有效）。
  assert.equal(describeError('update-nope-nope', ''), FALLBACK)
})

test('★★★ 用户可见的码都有文案（漏一个 = 用户看到一句没用的话）', () => {
  // ★ 边界是这样定下来的：**会被交给 `describeError` 的族**。
  //
  //   `client.mjs` 有五处调用它，码分别来自
  //   `verifyEnvelope`（ENVELOPE）、`validateFeedPayload` / `judgeSequence`
  //   （FEED）、`validateRelease`（RELEASE）、`transport.fetchBytes`（TRANSPORT），
  //   加上客户端自己那族（UPDATE_CODES_CLIENT）。
  //
  //   其余各族（closure/extract/health/helper/credential/cache/barrier/journal/
  //   install）的码**不直接给用户看**：它们在 helper 或安装事务内部，用户
  //   看到的是外层那句中文 `reason`，或者外层的 `helper-*` / `install-*` 码。
  //   给它们逐个编文案会把这张表变成倾倒场，而这张表的全部意义是
  //   "**用户会读到这一句**"。
  const userFacing = {
    UPDATE_CODES_CLIENT, TRANSPORT_CODES, ENVELOPE_CODES, RELEASE_CODES, FEED_CODES,
  }
  const missing = []
  for (const [family, codes] of Object.entries(userFacing)) {
    for (const [name, code] of Object.entries(codes)) {
      if (typeof code !== 'string' || code === '') continue
      if (NON_ERROR_CODES.has(code)) continue
      if (!(code in ERROR_TEXT)) missing.push(`${family}.${name} = ${code}`)
    }
  }
  assert.deepEqual(missing, [],
    '这些用户可见的码没有文案。请在 `product/update/errors.mjs` 的 `ERROR_TEXT` 里补上，'
    + '并写清"用户该做什么"；若它是**非错误**的结论，加进本文件的 `NON_ERROR_CODES` 并写明理由')
})

test('★ `NON_ERROR_CODES` 里的每一项都真的不是错误，且都还在被用', () => {
  // 豁免名单是这份判据的**全部漏洞面**：往里面塞一个其实是错误的码，
  // 就等于把那条判据悄悄关掉。所以这里逐项复核。
  const allCodes = new Set([
    ...Object.values(UPDATE_CODES_CLIENT), ...Object.values(TRANSPORT_CODES),
    ...Object.values(ENVELOPE_CODES), ...Object.values(RELEASE_CODES), ...Object.values(FEED_CODES),
  ])
  for (const code of NON_ERROR_CODES) {
    assert.ok(allCodes.has(code), `NON_ERROR_CODES 里的 ${code} 已经不存在了：删掉它（豁免名单不该留垃圾）`)
    assert.equal(code in ERROR_TEXT, false,
      `${code} 既有文案又在豁免名单里：豁免是多余的，删掉名单那一项`)
  }
  // `feed-newer-available` 是 `selectCandidate` 的**成功**结论
  // （`verdict: 'newer'`），它永远不会被交给 `describeError`——
  // `describeError` 只在 `!judgement.accept` 那一支被调用。
  assert.ok(NON_ERROR_CODES.has('feed-newer-available'))
})

test('模块自检全绿', () => {
  assert.equal(ERRORS_CHECKED.ok, true, JSON.stringify(ERRORS_CHECKED.problems))
})
