// plugins/tests/hub-read-auth.test.mjs — hub **读**路径必须带鉴权，且读失败不许静默。
//
// 回归来源（2026-10-13，将军："Agent 对话，不能够正常回复消息"）：
//
//   `fetchJson` 从前是 `await fetch(url)`（**不带任何鉴权头**）+ `if (!res.ok) return null`。
//   而中枢设了令牌（`teamHubRemoteAuth=1`）⇒ 不带头的读**一律 401** ⇒ `null`
//   ⇒ 两个调用点把 `null` 读成"这轮没东西"：
//     · `sweepChatReplies()`：`queue?.messages ?? []` ⇒ **恒空** ⇒ 永远不回复；
//     · `answerChatMessage()`：`settings === null` ⇒ 直接 return。
//   症状是**全静默**：守护日志一行都没有，用户的消息 `awaiting` 到 120s 被兜底标
//   `failed`「回复超时」。
//
//   > 一处"我没被授权读"的失败，与一处"确实没有待回复"的空队列，
//   > 在调用方眼里是同一个 `null` —— 而只有前者会每 30 秒安静地重复一次。
//
// 为什么是"读源码"的接线判据：`fetchJson` 是插件工厂内部的闭包，没有导出面
// （与 `rework-plan.test.mjs` 里那批接线判据同一手法）。这里断言的是**源码里
// 那几行的结构性质**，而不是运行时行为 —— 因为这个缺陷的全部内容就是"那几行写错了"。
//
// ⚠ 只读源码、不跑构建，所以它能在 `pnpm build` 之前就红。
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'), 'utf8')

/** 取出 `async function fetchJson` 的函数体（到下一个顶层 `}` 为止，够用且不引依赖）。 */
function fetchJsonBody() {
  const start = SRC.indexOf('async function fetchJson')
  assert.ok(start > 0, '找不到 fetchJson —— 判据要跟着实现走，改名请同步改这里')
  const end = SRC.indexOf('\n  }', start)
  assert.ok(end > start, '取不到 fetchJson 的函数体')
  return SRC.slice(start, end)
}

test('★★★ hub 读请求必须带鉴权头（`hubHeaders()`）—— 不带就是 401 ⇒ 恒空队列', () => {
  const body = fetchJsonBody()
  assert.match(body, /fetch\(\s*url\s*,\s*\{\s*headers:\s*hubHeaders\(\)/,
    'fetchJson 的 fetch 必须带 headers: hubHeaders()；裸 fetch(url) 会被中枢 401 拒掉，'
    + '而调用方只会看到"空队列"（实测：不带头的 GET /api/chat/replies → 401）')
  // 反向锚：**裸** fetch(url) 不许再出现（这正是从前那一行）
  assert.doesNotMatch(body.replace(/fetch\(\s*url\s*,\s*\{\s*headers:\s*hubHeaders\(\)[^)]*\)/, ''),
    /fetch\(\s*url\s*\)/,
    '不许再有裸 fetch(url)：它是这个缺陷的原形')
})

test('★★★ 读失败必须留下痕迹：`!res.ok` 那条路上要有 log（不许只 return null）', () => {
  const body = fetchJsonBody()
  const notOk = body.indexOf('!res.ok')
  assert.ok(notOk > 0, '找不到 !res.ok 分支')
  const after = body.slice(notOk, notOk + 900)
  assert.match(after, /log\(/, '`!res.ok` 之后必须先 log 再 return null —— '
    + '静默返回 null 会让"401 未授权"与"没有待回复"在调用方眼里变成同一个东西')
  // 状态码要说出来（否则拿到了"读失败"也不知道是谁拒的）
  assert.match(after, /res\.status/, '日志里要带 HTTP 状态码')
  // 401/403 要有专门的一句话（否则下一个人还是得从头查一遍）
  assert.match(after + body.slice(0, 400), /401|403/, '401/403 要能被点명（鉴权被拒）')
})

test('★ 节流：失败日志不许每 30 秒刷一次屏（扫单间隔就是 30s）', () => {
  const body = fetchJsonBody()
  assert.match(body, /readFailSeen/, '失败要按 (状态+接口) 节流')
  assert.match(body, /60_000|60000/, '节流窗口至少要 1 分钟')
})

test('★★ 同一条规则的其它读路径仍然带鉴权（防止"只修了一处"再演一次）', () => {
  // 这个缺陷的元凶就是"同一条规则写成两处、只修了一处"。这里把其它 `hubUrl` 请求也钉住。
  // ⚠ 判据取的是**匹配点之后的 400 字符窗口**，不是那一行的剩余部分 ——
  //   `hubPost` 的写法是
  //       await fetch(`${hubUrl}${path}`, {
  //         method: 'POST',
  //         headers: hubHeaders({ 'content-type': 'application/json' }),
  //   只截到第一个 `)` 会把正确的写法判成漏网（第一版就误报了这一条）。
  const offenders = []
  for (const m of SRC.matchAll(/await fetch\(`\$\{hubUrl\}/g)) {
    const window = SRC.slice(m.index, m.index + 400)
    const line = SRC.slice(0, m.index).split('\n').length
    if (!/hubHeaders\(/.test(window) && !/authorization/i.test(window)) {
      offenders.push(`第 ${line} 行：${window.split('\n')[0].slice(0, 90)}`)
    }
  }
  assert.deepEqual(offenders, [],
    '这些 hub 请求没带鉴权头（会被 401 拒掉，而调用方只会看到"空"）：\n' + offenders.join('\n'))
})
