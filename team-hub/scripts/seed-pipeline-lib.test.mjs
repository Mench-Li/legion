// team-hub/scripts/seed-pipeline-lib.test.mjs
// BUG-049 的另一半：`seed-pipeline.mjs` 的**鉴权**与**失败措辞**。
//
// 现场（2026-11-20）：界面在"空间不会自动开工"时给的修复命令正是这个脚本，
// 而它在开着 `LEGION_REMOTE_AUTH=1` 的中枢上第一条 GET 就 401 ——
// 脚本一个 Authorization 头都不带，输出只有「读取现值失败：HTTP 401」。
//
// 这一组钉住四件事：① 参数解析（含 `--name=value`）；② 令牌来源的**优先级**；
// ③ 没有令牌时**不伪造** Authorization；④ 401/403 的话必须可执行（说清怎么带令牌），
// 且**不打印令牌值**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { argOf, authHeaders, explainFailure, hasFlag, resolveAuth } from './seed-pipeline-lib.mjs'

const SECRET = 's3cr3t-hub-token-value'
const script = readFileSync(new URL('./seed-pipeline.mjs', import.meta.url), 'utf8')

// ══════════════════════ ① 参数解析 ══════════════════════

test('① ★★ `--name value` 与 `--name=value` 都认；下一个开关不算值；缺值不算"真"', () => {
  assert.equal(argOf(['--scope', 'opc'], 'scope', ''), 'opc')
  assert.equal(argOf(['--scope=opc'], 'scope', ''), 'opc')
  assert.equal(argOf(['--scope'], 'scope', '<none>'), '<none>', '★ 缺值要走 fallback（旧实现会给字符串 true）')
  assert.equal(argOf(['--scope', '--dry-run'], 'scope', '<none>'), '<none>', '★ 下一个开关不是这个参数的值')
  assert.equal(argOf([], 'scope', '<none>'), '<none>')
  assert.equal(argOf(['--file', 'roles.json', '--scope', 'x'], 'scope', ''), 'x', '★ 顺序无关')
  assert.equal(hasFlag(['--dry-run'], 'dry-run'), true)
  assert.equal(hasFlag(['--dry-run'], 'apply'), false)
})

// ══════════════════════ ② 令牌来源与优先级 ══════════════════════

test('② ★★★ 令牌优先级：`--token` > LEGION_HUB_TOKEN > TEAM_HUB_TOKEN；空白一律当没有', () => {
  const env = { LEGION_HUB_TOKEN: 'from-legion-env', TEAM_HUB_TOKEN: 'from-team-env' }
  assert.deepEqual(resolveAuth({ argv: ['--token', 'from-flag'], env }), { token: 'from-flag', source: 'flag' })
  assert.deepEqual(resolveAuth({ argv: [], env }), { token: 'from-legion-env', source: 'env:LEGION_HUB_TOKEN' })
  assert.deepEqual(resolveAuth({ argv: [], env: { TEAM_HUB_TOKEN: 'team-only' } }), { token: 'team-only', source: 'env:TEAM_HUB_TOKEN' })
  assert.deepEqual(resolveAuth({ argv: [], env: {} }), { token: '', source: 'none' })
  // 空串/纯空白不算"给了令牌"——否则会送出一个 `Bearer `，得到一个 401，
  // 而"我明明给了令牌"会让排查往错的方向走一大步。
  assert.deepEqual(resolveAuth({ argv: ['--token', '   '], env: { LEGION_HUB_TOKEN: '  ' } }), { token: '', source: 'none' })
  assert.deepEqual(resolveAuth({ argv: ['--token=from-eq'], env: {} }), { token: 'from-eq', source: 'flag' })
})

// ══════════════════════ ③ 鉴权头 ══════════════════════

test('③ ★★★ 没有令牌 ⇒ **空头**（不伪造 Bearer）；有令牌 ⇒ 只放 authorization', () => {
  assert.deepEqual(authHeaders(''), {}, '★ 空令牌不许发出 "Bearer "')
  assert.deepEqual(authHeaders('   '), {})
  assert.deepEqual(authHeaders(undefined), {})
  assert.deepEqual(authHeaders(SECRET), { authorization: 'Bearer ' + SECRET })
})

// ══════════════════════ ④ 失败措辞 ══════════════════════

test('④ ★★★ 401/403 必须是**可执行**的话：说清开了远程鉴权、怎么带令牌、去哪儿拿', () => {
  for (const status of [401, 403]) {
    const msg = explainFailure({ status, body: '{"error":"未授权"}', scope: 'opc' })
    assert.match(msg, /远程鉴权/, `HTTP ${status} 要说清这不是"中枢没起来"`)
    assert.match(msg, /--token/)
    assert.match(msg, /LEGION_HUB_TOKEN/)
    assert.match(msg, /teamHubToken/, '★ 要告诉人去哪儿拿令牌')
    assert.match(msg, /--scope opc/, '★ 给的命令要能直接粘（带真实 scope）')
    assert.match(msg, /未授权/, '★ 服务端说的话要保留')
  }
})

test('⑤ ★★ 200 时返回 null（调用方不用改口）；404/400 各有说法，不冒充鉴权问题', () => {
  assert.equal(explainFailure({ status: 200 }), null)
  assert.match(explainFailure({ status: 404, hub: 'http://h' }), /404/)
  const bad = explainFailure({ status: 400, body: '{"error":"流水线 stage 非法"}' })
  assert.match(bad, /HTTP 400/)
  assert.match(bad, /stage 非法/)
  assert.ok(!/远程鉴权/.test(bad), '★ 400 不许被说成鉴权问题')
})

test('⑥ ★ 措辞里**不许出现令牌值**（它会被贴进聊天与 issue）', () => {
  const msg = explainFailure({ status: 401, scope: 'opc', body: '' })
  assert.ok(!msg.includes(SECRET))
  // 说明里只出现**变量名**与"profile 里的 teamHubToken"，不出现任何值
  assert.ok(!/=ey|=Bearer [A-Za-z0-9]/.test(msg))
})

// ══════════════════════ ⑦ 接线：脚本真的用了这些 ══════════════════════

test('⑦ ★★★ 接线：脚本从 lib 取令牌、每次请求都带鉴权头、失败走 explainFailure', () => {
  assert.match(script, /from '\.\/seed-pipeline-lib\.mjs'/, '★ 必须用抽出来的 lib')
  assert.match(script, /resolveAuth\(\{ argv: ARGV, env: process\.env \}\)/, '★★ 令牌要真的解析')
  assert.match(script, /headers: \{ \.\.\.HEADERS, \.\.\.\(init\.headers \?\? \{\}\) \}/,
    '★★ api() 每一次都要带鉴权头（漏一次就等于这条命令在中枢上"有时能跑有时不能"）')
  assert.ok(!/console\.log\([^)]*auth\.token/.test(script), '★★ 不许把令牌打进日志')
  assert.equal((script.match(/explainFailure\(/g) ?? []).length >= 2, true, '★ 读现值与写入两处失败都要用可执行措辞')
  // 旧的那两句裸 HTTP 状态码输出不许回来
  assert.ok(!script.includes('读取现值失败：HTTP ${before.status}'), '★ 旧文案（裸 401）已删除')
  assert.ok(!script.includes('写入失败：HTTP ${r.status}'), '★ 旧文案（裸 4xx）已删除')
})
