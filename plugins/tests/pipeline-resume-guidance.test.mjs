import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// BUG-010 回归：**异常路径的恢复指引与停摆读数不许被删掉**。
//
// 现场（2026-10-05）：T-178 是 coder、stage.next=reviewer。它被文件域闸门拦下后停在 in_review，
// 而闸门评论只说了"手动合入"或"丢弃"，**没说要把任务推进 done**。人按评论合入之后：
//   · 任务仍停在 in_review；
//   · "4. 流水线 done 补流转"那道扫单**只处理 status===done**，看不到它；
//   · 于是 reviewer / tester 两环**永远不会被派**，代码进了 main 却没经过审查；
//   · 而没有任何读数会说话 —— 链看起来像走完了。
//
// 这组用例按**源码**钉住两件事（与 model-config 的 routeAssemblySource 同一手法）：
//   ① 闸门评论必须写全恢复路径（含"推进 done"这一步）—— 它是人唯一能看到的指引；
//   ② 扫单必须有一条针对"停在 in_review 但分支已合入"的**可见读数**（把静默的事说出来）。
// 两者都不会被 tsc / 任何行为测试拦住，所以只能这样钉。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'plugins', 'src', 'index.ts'), 'utf8')

test('① 文件域闸门的评论必须写全恢复路径：合入 → **推进 done** → 下一环才会被派', () => {
  const at = SRC.indexOf('⛔ 文件域越界（合入被机器闸门拦截）')
  assert.ok(at > 0, '找不到闸门评论（是不是被搬走或改写了？）')
  // 只取**评论本身**：到下一条语句 `await transitionTo(...)` 为止。
  // （早先这里用固定 2000 字符切片，把评论之后的 log 行也框了进来 —— 而那行也含"推进 done"，
  //   于是"把评论里的指引删掉"这个变异测不出来。测试的边界必须与它断言的东西对齐。）
  const end = SRC.indexOf("await transitionTo(t.id, 'in_review')", at)
  assert.ok(end > at, '找不到评论之后的 transitionTo（结构变了，请重新对齐这段判据）')
  const comment = SRC.slice(at, end)
  assert.match(comment, /推进到 done|推进 done/,
    '评论必须含"推进 done"这一步：漏掉它 = 人合入后下游被静默跳过（T-178 现场）')
  assert.match(comment, /补流转|才会派出下一环|下一环/,
    '评论要说清"为什么必须推 done"——否则它看起来只是一句多余的手续')
})

test('② 必须有"停在 in_review 但分支已合入"的可见读数（把静默停摆说出来）', () => {
  assert.match(SRC, /merge-base', '--is-ancestor', `w\/\$\{t\.id\}`, 'HEAD'/,
    '缺少"分支是否已并入 HEAD"的判定 —— 没有它就无法区分"停着等人工"与"已合入却没往下走"')
  assert.match(SRC, /补流转扫单只看 done/,
    '警告文案必须点出根因（扫单只看 done），否则读日志的人不知道该怎么修')
  assert.match(SRC, /停在 in_review 但分支/, '缺少那条停摆警告本身')
})

test('③ 闸门岗（gate=true）必须被排除，否则会误报 requirement/researcher', () => {
  const at = SRC.indexOf('停在 in_review 但分支')
  assert.ok(at > 0)
  const around = SRC.slice(Math.max(0, at - 1200), at)
  assert.match(around, /sigStage\.gate === true/,
    '人工闸门岗合法地停在 in_review 等将军，必须排除；否则每轮都会为它们报一次假警告')
  assert.match(around, /sigStage\.next == null/,
    '没有下一环的角色不该进这个检查（它的"停"不是链断）')
})

test('④ 那条读数必须是**只读**的（不许顺手改任务状态）', () => {
  // 锚点用**唯一**的那句话：文件里有两处 `// ★ BUG-010`（闸门评论那处 + 扫单这处），
  // 抓第一个会把闸门自己那句 `transitionTo(...)` 也算进来 —— 那是误判测试，不是误判产品。
  const from = SRC.indexOf('// ★ BUG-010：上面那道补流转')
  assert.ok(from > 0, '找不到扫单里那段 BUG-010（锚点失效说明它被改写或搬走了）')
  const to = SRC.indexOf('// 4.2 / 4.3 / 4.4 / 4.5a', from)
  assert.ok(to > from, '找不到这一段之后的 4.2 标记')
  const block = SRC.slice(from, to)
  assert.equal(/transitionTo\(/.test(block), false,
    '这一段不许改任务状态：它的价值在于"报告"，替人做决定会把"等人工裁决"变成"自动放行"')
  assert.equal(/advancePipeline\(/.test(block), false,
    '补流转由上面那道扫单负责（它只看 done）；这里再调一次会让"没推 done"也被悄悄接上，与设计相反')
})
