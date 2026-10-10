// workbench/scripts/goal-stall-warning.test.mjs
// ============================================================================
// BUG-016/A：发布目标之后，界面必须**立刻**说清「这个空间现在会不会自动开工」
//
// 实测（业主那台机器，2026-10-10）：目标发布成功、8 条链任务也建对了，
// 却因为「空间未开通执行 + 没有守护实例服务这个空间」静默停在 todo 十几个小时，
// 而界面只说了一句「🎯 已发布目标」。将军能看到的只有"发布成功了"。
//
//   > 一个"发布成功但不会开工"的界面，
//   > 与一个"发布失败"的界面，对将军来说是同一件事——
//   > 只不过前者让他以为可以走了。
//
// 这一组守两件事：
//   ① 判定的**来源**是服务端的开通预检（`GET /api/spaces/provision`），不是界面里另写一套；
//   ② 有 error 级阻塞项时，说出来的话**不是**那句"已发布目标"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/** 剥掉**整行注释**再断言（本仓的教训：注释里引用旧代码会让"不该出现"的判据永远为假）。 */
const codeOnly = (src) => src
  .split('\n')
  .filter((line) => {
    const t = line.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  })
  .join('\n')

const API = read('workbench/src/api.ts')
const APP = read('workbench/src/App.tsx')
const APP_CODE = codeOnly(APP)

test('① ★ 判定来自服务端的开通预检（不在这里另写一套"能不能跑"的判定）', () => {
  assert.match(API, /export async function fetchProvision/, 'api.ts 要有一个只读的预检函数')
  assert.match(API, /\/api\/spaces\/provision\?id=/, '打的是中枢那条权威预检端点')
  assert.match(APP_CODE, /fetchProvision\(/, '发布流程要用它')
  // ★ 反向护栏：界面不许自己"猜"这个空间能不能跑（那会与服务端口径分叉）
  for (const banned of ['todoCount', 'noDaemon', 'daemonOnline ===']) {
    assert.equal(APP_CODE.includes(banned), false,
      `界面里出现了自造的停滞判定：\`${banned}\` —— 两套判定迟早给出不同答案，而将军只能看到其中一个`)
  }
})

test('② ★★ 有 error 级阻塞项时，说的话**不是**"已发布目标"', () => {
  // 发布成功那条 toast 必须**在有阻塞项时不出现**（否则将军看到的就是"一切正常"）
  assert.match(APP_CODE, /blocked\.length > 0/, '要先看有没有阻塞项')
  assert.match(APP_CODE, /这个空间现在不会自动开工|不会自动开工/,
    '要说人话：这个空间现在不会自动开工')
  assert.match(APP_CODE, /c\.level === 'error'|level === 'error'/, '只认 error 级（warn 不该吓唬人）')
  // ★ 判据用**第一次**出现的位置，并且要求只出现一次 —— 两次实测：
  //   用 lastIndexOf 抓不住"提前多弹一条成功提示"（后一条还在，比较仍然成立）；
  //   而不查次数就抓不住"两条一起弹"（那等于什么都没说）。
  const idxWarn = APP_CODE.indexOf('不会自动开工')
  const idxOk = APP_CODE.indexOf('🎯 已发布目标')
  const okCount = APP_CODE.split('🎯 已发布目标').length - 1
  assert.equal(okCount, 1, `★ "已发布目标"只许出现一次（实测 ${okCount} 次）——两条一起弹等于什么都没说`)
  assert.ok(idxWarn > 0 && idxOk > idxWarn,
    '★ "已发布目标"那句必须排在阻塞提示**之后**（前面那条要 return）')
})

test('③ ★ 说清"链任务已经建好了，不必重发"（否则将军会去重发一遍）', () => {
  assert.match(APP_CODE, /不必重发|链任务已建好|不会重发/,
    '要让将军知道：任务已经在队列里等着，开通之后会自动认领')
  // 并且给得出可执行的修复动作（预检的 fix 字段）
  assert.match(APP_CODE, /\.fix/, '要把服务端给的修复命令透出来（照做就能通）')
})

test('④ 预检拿不到时**不吓唬人**（目标确实已经发布成功了，两件事要分开说）', () => {
  assert.match(APP_CODE, /catch[\s\S]{0,200}blocked = \[\]/,
    '取不到预检 ⇒ 当"没有阻塞项"处理，而不是报一个"可能有问题"')
})

test('⑤ 开关的读数就是守护的读数（BUG-016/B 的前端一面）', () => {
  // `fetchExec` 的类型要带上 maxWorkers/isolate —— 它们来自 space_runtime 那一行
  assert.match(API, /maxWorkers\?: number \| null/, 'fetchExec 要能拿到并发')
  assert.match(API, /isolate\?: boolean \| null/, 'fetchExec 要能拿到隔离形态')
  assert.match(API, /space_runtime/, '读数的来源要写在代码里（守护读的同一张表）')
})
