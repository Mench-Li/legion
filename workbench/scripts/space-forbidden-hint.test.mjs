// workbench/scripts/space-forbidden-hint.test.mjs
// BUG-048 的**界面**那一半：403 空间越权与"中枢不可达"是相反的两件事，
// 而它们从前共用一句提示（「请确认 team-hub v2（:8787）已启动并选中有效工作空间」）。
//
// 对着一个「你在这个空间里没有角色」的 403 说"去确认中枢起没起"，人只会去重启中枢
// —— 重启一万次也还是 403。这与 `isAuthFailure` 那条现场同形（401 被当成不可达，
// 于是重连了一整夜），所以判据同样只认**具名码**，不做"403 就一定是越权"的外推。
//
// 跑法：node --experimental-strip-types --test workbench/scripts/space-forbidden-hint.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { HubError, hubErrorFromBody, isAuthFailure, isSpaceForbidden } from '../src/hub-errors.ts'

const here = new URL('../', import.meta.url)
const component = readFileSync(new URL('./src/components/TaskCenterView.tsx', here), 'utf8')

// ══════════════════════ ① 判据：只认具名码 / 那一句具名文案 ══════════════════════

test('① ★★★ 403 SPACE_FORBIDDEN ⇒ 是空间越权；401 凭据失败 ⇒ **不是**（两者处置相反）', () => {
  const forbidden = hubErrorFromBody(403, '{"error":"无权访问空间「personal-profile」","code":"SPACE_FORBIDDEN"}',
    { error: '无权访问空间「personal-profile」', code: 'SPACE_FORBIDDEN' })
  assert.equal(isSpaceForbidden(forbidden), true)
  assert.equal(isAuthFailure(forbidden), false, '★ 空间越权不是登录过期（否则界面会去重登/重连）')

  const expired = hubErrorFromBody(401, '{"error":"访问令牌已过期","code":"IDENTITY_TOKEN_EXPIRED"}',
    { error: '访问令牌已过期', code: 'IDENTITY_TOKEN_EXPIRED' })
  assert.equal(isSpaceForbidden(expired), false)
  assert.equal(isAuthFailure(expired), true, '★ 反过来也不许被空间判据吃掉')
})

test('② ★★ 只剩文案的 403（老中枢 / 响应体不是 JSON）也必须认出来', () => {
  // 现场那一行的原文（`team-hub/server.mjs` 里只有这一处产生它）。
  assert.equal(isSpaceForbidden(new Error('403：无权访问空间「personal-profile」')), true)
  // 有结构时更稳：状态码 + 文案
  assert.equal(isSpaceForbidden(new HubError({ status: 403, message: '403：无权访问空间「ozon」' })), true)
})

test('③ ★★ 不做"403 就一定是越权"的外推：别的 403 / 别的状态码都**不是**', () => {
  assert.equal(isSpaceForbidden(new HubError({ status: 403, message: '403：模型配置仅限本机访问' })), false)
  assert.equal(isSpaceForbidden(new HubError({ status: 401, message: '401：无权访问空间「x」' })), false,
    '★ 不是 403 却带着这句话 ⇒ 不认识的形状，不归类')
  assert.equal(isSpaceForbidden(new Error('Failed to fetch')), false, '★ 中枢不可达不是空间越权（那句提示语要留给它）')
  assert.equal(isSpaceForbidden(null), false)
})

// ══════════════════════ ④ 接线：面板真的按它分岔 ══════════════════════

test('④ ★★★ 任务中心的读取失败面板按 `isSpaceForbidden` 分岔，且**存的是错误对象**', () => {
  // ① 存错误本身，不是一句字符串 —— 字符串里没有 code，分不了岔。
  assert.match(component, /setLoadErr\(e\)/,
    '★★ 必须存错误对象：压成 `${e.message}` 之后 code 就没了（正是 hub-errors.ts 文件头那条断链）')
  assert.ok(!/setLoadErr\(e instanceof Error \? e\.message/.test(component),
    '★★ 不许再压成字符串')

  // ② 面板读的是 `isSpaceForbidden(loadErr)`，不是靠字符串 includes 猜。
  assert.match(component, /isSpaceForbidden\(loadErr\)/)

  // ③ 两句提示各自成立：越权那一句说清"没有角色 + 怎么办"，
  //    中枢不可达那句**只**留在 else 分支里。
  assert.match(component, /空间级授权要求至少 viewer/)
  assert.match(component, /:\s*'（请确认 team-hub v2（:8787）已启动并选中有效工作空间）'/,
    '★★ "请确认中枢已启动"必须退回 else 分支 —— 对 403 说这句话就是把人指到错的地方')

  // ④ 正文用 `hubErrorText` 拼（带上后端给的 hint），不是把裸错误塞进界面。
  assert.match(component, /读取失败：\{hubErrorText\(loadErr\)\}/)
})
