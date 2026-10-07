// product/server/phone-act.test.mjs
// ============================================================================
// `_phone-act.mjs` 的参数解码。
//
// ## 它守的是一个**不报错**的缺陷
//
// `verify-experience.sh` 的 `phone()` 原来把参数用 `$*` 拼进 ssh 命令串，
// 远端 shell 再分词一次 —— 于是带空格的参数在**第一个空格**处被切开，
// `_phone-act.mjs` 只拿到前半句。
//
// 实测的物证：服务器上留下的任务标题是「端到端验收：请写一个」——
// 而原文是「端到端验收：请写一个 greet 函数并跑一次测试」。
// 任务照建、照跑、照完成，**哪里都不报错**，只是目标少了一半。
//
//   > 一个"参数在传输层被悄悄切开"的脚本，
//   > 与一个"用户只写了半句话"的脚本，在日志里是同一个东西——
//   > 只不过前者永远修不好，因为没有人会去怀疑自己的参数。
//
// ## 为什么是黑盒（跑子进程）
//
// `_phone-act.mjs` 顶层就有 `await`（登录、找 Agent、开会话），import 它就等于
// 发一轮真实 HTTP。所以这里**跑它**，而不是 import 它 —— 断言它的**行为**：
// 坏参数必须**当场**具名退出，而不是先跑一趟网络再报一个不相干的错。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '_phone-act.mjs')

/** 跑一次脚本；HUB 指向一个必然连不上的地址，于是"过了参数校验"= 会报 fetch 类错误。 */
function run(args) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-phone-act-'))
  const pw = join(dir, 'pw.txt')
  writeFileSync(pw, 'dummy-password')
  try {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HUB: 'http://127.0.0.1:1', PW_FILE: pw },
      timeout: 30000,
    })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

const enc = (s) => Buffer.from(s, 'utf8').toString('base64')

test('★ 解不开的 base64 **当场**具名退出（exit 2），不去跑网络', () => {
  // 空串解出来是空 —— 不合法。必须在网络之前拦下：
  // 跑一趟网络再告诉你参数不对，与先校验再动手，是"慢且看不懂"与"当场就懂"的差别。
  const r = run(['--b64', '', enc('测试')])
  assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}；输出：${r.out.slice(0, 200)}`)
  assert.match(r.out, /--b64 的第 1 个参数解出来是空的/)
  // 关键：**没有**走到网络
  assert.doesNotMatch(r.out, /fetch|bad port/, '参数校验必须在网络之前')
})

test('正确的 base64 过得去参数这一关（失败只可能来自网络）', () => {
  const r = run(['--b64', enc('create'), enc('端到端验收：请写一个 greet 函数并跑一次测试')])
  assert.doesNotMatch(r.out, /解出来是空的/, '合法参数不该被参数校验拦下')
  assert.match(r.out, /fetch|bad port/i, '应当前进到网络那一步')
})

test('不带 --b64 的老写法仍然可用（向后兼容）', () => {
  const r = run(['timeline'])
  assert.doesNotMatch(r.out, /--b64/, '老写法不该被新分支影响')
  assert.match(r.out, /fetch|bad port/i)
})

test('★ 带空格的参数经 base64 往返**逐字不变**', () => {
  // 这是那个缺陷的核心：`$*` 会把「端到端验收：请写一个 greet 函数并跑一次测试」
  // 切成好几段。base64 之后它是一段无空格的串，怎么分词都不会变。
  const msg = '端到端验收：请写一个 greet 函数并跑一次测试'
  const packed = enc(msg)
  assert.doesNotMatch(packed, /\s/, 'base64 产物里不该有空白，否则仍会被分词')
  assert.equal(Buffer.from(packed, 'base64').toString('utf8'), msg)
  // 反证：旧写法下它会被切成这样（也正是服务器上那个截断标题的来源）
  assert.deepEqual(('create ' + msg).split(' ').slice(1, 3), ['端到端验收：请写一个', 'greet'])
})
