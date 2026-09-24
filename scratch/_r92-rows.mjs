// scratch/_r92-rows.mjs —— 第 92 轮：那 21 条**至少三个原因**（"逐条读"第二轮），并且**反向对照**那一类修法不同
import { readFileSync, writeFileSync } from 'node:fs'

const I = 'D:/project/DSH/legion/docs/superpowers/prt/PRT-HUMAN-INTERVENTION-2026-09-20.md'
let t = readFileSync(I, 'utf8')
const eol = t.includes('\r\n') ? '\r\n' : '\n'
const bad = []
const sub = (from, to) => {
  const f = from.split('\n').join(eol)
  const tt = to.split('\n').join(eol)
  const n = t.split(f).length - 1
  if (n !== 1) { bad.push(`  x 命中 ${n} 次：${from.slice(0, 46)}`); return }
  t = t.replace(f, tt)
}
sub('**第 91 轮结束时的读数**（全部可复跑）：', '**第 92 轮结束时的读数**（全部可复跑）：')

const ANCHOR = '#### ★★★★★ 第 91 轮：**更正第 63/85 轮**'
const at = t.indexOf(ANCHOR)
if (at < 0) bad.push('  x 找不到第 91 轮那节的锚点')
else {
  const SEC = [
    '#### ★★★★★ 第 92 轮：接着"逐条读" —— 那 21 条**至少三个原因**，而且**第三个的修法完全不同**',
    '',
    '第 91 轮我逐条读失败标题，拆出 19 + 2。本轮把**那 19 条**也逐条读了 —— 又拆出一种。',
    '',
    '#### 量到的第三条（本轮新）：**反向对照的前提没了**',
    '',
    '`runtime-contract-cross-process.test.mjs` 的 **B.** 是一条**反向对照**：',
    '',
    '```js',
    'guarded(\'B. ★★ 反向对照：**不挂**契约行 → 服务 absent，worker 无 URL → 老读数一字不变\', async (t) => {',
    '  const r = await scenario(\'noRow\')',
    '  assert.equal(svc.ok, \'absent\', `不挂那一行却读到了服务：${JSON.stringify(svc)}`)',
    '```',
    '',
    '它**今天读到了服务**：`{"ok":"1","code":"none","listening":"1","port":"51609","tokenConfigured":"1",…}`',
    '（期望 `absent`）。',
    '',
    '★ 去读 `noRow` 是怎么"不挂"的（`SCENARIOS.noRow`，L488）：它的补丁列表里放的是',
    '`NO_SERVERROW_PATCH_SRC`，而那个字面量（L347-351）是：',
    '',
    '```yaml',
    '- insert:',
    '    - id: "prt253ct-placeholder"',
    '      name: "./prt253ct-services.mjs"',
    '      disabled: true',
    '```',
    '',
    '⇒ 它**什么都没删**，只是"**不多插那一张补丁**"。',
    '',
    '★★★ 而 `2f5a4b3` 已把 `runtime-contract-server` 那一行放进 **`PATCH_LAYER_ROWS`（产品内建的补丁层）** ——',
    '**那一层永远挂着** ⇒ 那个场景**再也排除不掉它** ⇒ B. 的 `absent` 前提**在今天的架构里不可表达**。',
    '',
    '#### ⇒ 于是那 21 条至少是**三个**原因，而第三个的修法**不是"改期望"**',
    '',
    '| 簇 | 是什么 | 修法 |',
    '|---|---|---|',
    '| **自检恒不兼容**（设计常量） | 断言"自检通过 / `boundRunning() === true` / 解除阻塞"这类**构造上不可达**的状态 | 改**期望**（那是裁决 **Ⅰ** 的甲） |',
    '| **路由抽取器只读一个文件** | `extractRoutes(server.mjs)` 看不见已搬进族模块的路由 | 改**工具**（并行会话的搬运工作） |',
    '| **反向对照的前提没了** | B. / ④ / ⑥ 这一类："**不挂**它就该 absent" —— 而它现在**默认就挂着** | ★★ **不能改期望**：`absent` 在新架构里**不可表达**；要么**换一种"不挂"的办法**（真能把它摘掉的场景），要么**承认这条对照失效并删掉** |',
    '',
    '★★★★★ **这一点对您裁 Ⅰ 很要紧**：',
    '',
    '> "把那 21 条改成断言不兼容"这句话，对**第一簇**成立；',
    '> 对**第三簇**（反向对照）**不成立** —— 它们的期望不是"绑上了"而是"**不挂就该没有**"，',
    '> 而那个状态在今天**已经不存在了**。',
    '',
    '★ 所以 Ⅰ 的甲**不是一次机械改写**，而是：**大多数改期望 + 几条要重新设计它们的对照条件**。',
    '',
    '★★ 而本轮的方法仍然是第 91 轮那一句：**逐条读失败标题与它的输入**。',
    '第 91 轮逐条读、拆出 2 条；本轮接着逐条读、又拆出 1 条。',
    '**两次都是读完才发现上一轮的"一个原因"是错的。**',
    '',
    '> 一个"总数一样、所以是同一件事"的印象，与一个"至少三个原因、修法各不相同"的事实，',
    '> 在我**没有把每一条的输入也读一遍**的时候是同一个东西。',
    '',
  ].join('\n')
  t = t.slice(0, at) + SEC + t.slice(at)
  console.log('  OK §三之三 已插入第 92 轮那节')
}

if (!/^\| 92 \|/m.test(t)) {
  const ROW = '| 92 | ★★★★★ **接着"逐条读"：那 21 条至少三个原因，而第三个的修法完全不同** —— '
    + '第 91 轮逐条读失败标题拆出 19 + 2；本轮把**那 19 条**也逐条读（连**输入**一起读），又拆出一种。'
    + '★ 新量到的第三条：**反向对照的前提没了**。`runtime-contract-cross-process.test.mjs` 的 **B.** 是反向对照'
    + '「**不挂**契约行 → 服务 absent」——它**今天读到了服务**（`{"ok":"1","listening":"1","port":"51609",…}`，期望 `absent`）。'
    + '去读它怎么"不挂"（`SCENARIOS.noRow` L488）：它放的是 `NO_SERVERROW_PATCH_SRC`，而那个字面量（L347-351）'
    + '只是 `- insert: [{id: "prt253ct-placeholder", disabled: true}]` ⇒ **什么都没删**，只是"不多插那一张补丁"。'
    + '而 `2f5a4b3` 已把 `runtime-contract-server` 放进 **`PATCH_LAYER_ROWS`（产品内建补丁层，永远挂着）** ⇒ '
    + '那个场景**再也排除不掉它** ⇒ B. 的 `absent` 前提**在今天的架构里不可表达**。'
    + '⇒ **三个簇、三种修法**：① 自检恒不兼容（设计常量）⇒ 改**期望**（裁决 Ⅰ 的甲）；'
    + '② 路由抽取器只读一个文件 ⇒ 改**工具**（并行会话的搬运）；'
    + '③ **反向对照的前提没了**（B./④/⑥ 这一类）⇒ ★★ **不能改期望** —— `absent` 在新架构里不可表达，'
    + '要么**换一种真能摘掉它的"不挂"办法**，要么**承认这条对照失效并删掉**。'
    + '★★★★★ **这对您裁 Ⅰ 很要紧**：「把那 21 条改成断言不兼容」对**第一簇**成立，对**第三簇不成立** —— '
    + '它们的期望不是"绑上了"而是"**不挂就该没有**"，而那个状态**今天已经不存在**。'
    + '★ 所以 Ⅰ 的甲**不是一次机械改写**，而是"大多数改期望 + 几条要重新设计对照条件"。'
    + '★★ 方法仍是第 91 轮那一句：**逐条读失败标题与它的输入** —— 两次都是读完才发现上一轮的"一个原因"是错的。'
    + '> 一个"总数一样、所以是同一件事"的印象，与一个"至少三个原因、修法各不相同"的事实，'
    + '> 在我**没有把每一条的输入也读一遍**的时候是同一个东西。 |'
  const lines = t.split('\n')
  const i91 = lines.findIndex((l) => /^\| 91 \|/.test(l))
  if (i91 < 0) bad.push('  x 找不到 | 91 |')
  else { lines.splice(i91 + 1, 0, ROW); t = lines.join('\n'); console.log('  OK 家族表加第 92 行') }
}

if (bad.length > 0) { for (const b of bad) console.log(b); process.exit(1) }
writeFileSync(I, t)
const m = /⇒ \S*套件合计 \*\*(\d+) 通过 \/ 0 失败\*\*/.exec(t)
const head = t.slice(0, m.index)
const block = head.slice(head.lastIndexOf('结束时的读数'))
let sum = 0
for (const x of block.matchAll(/\*\*(\d+)\/(\d+)\*\*/g)) sum += Number(x[1])
console.log(`  逐项求和 = ${sum}；声明 ${m[1]}  ${sum === Number(m[1]) ? 'OK 一致' : 'x 不一致'}`)
process.exit(sum === Number(m[1]) ? 0 : 1)
