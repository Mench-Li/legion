// workbench/scripts/reject-path.test.mjs
// ============================================================================
// 打回（`in_review → todo`）这条路 —— **理由必须真的送达执行者**
//
// ## 它坏在两个地方，症状各不相同，但同一个成因
//
//   ① `HubSchedulerModal`（🗓 任务调度弹窗，中枢模式）：
//      `window.prompt` 收回来的 `reason` **只出现在 toast 文案里**，一次都没发给服务端。
//      将军写「头像有黑边」→ 界面回「已打回：头像有黑边」→ worker 拿到一个光秃秃的 todo。
//      于是他会按原样再交一次，然后将军再打回一次。
//
//   ② `rejectTask()`（`api.ts`）打的是 `/api/reject`，而**那个端点没有任何服务端在实现**：
//      v1 看板取消时跟着没了，v2 中枢从来没有。再叠加 `SchedulerModal` 在中枢模式下
//      **挂得出来**（`CommandBar`：`hubMode && scope ? HubSchedulerModal : board ? SchedulerModal`，
//      所以「全部空间」走这一支），将军点「打回」拿到的是
//      `POST /api/reject 404：{"error":"not found: ..."}` —— 读起来像路径拼错了。
//      同一件事 board-plugin 早就说清了（501：「v2 hub 不支持 reject…请用 transition + comment」），
//      workbench 这一面漏了同一句话。
//
//   > 一个"把理由显示给自己看"的按钮，与一个"把理由交给执行者"的按钮，
//   > 在按下它的那一刻长得完全一样——区别要到下一轮交付时才看得见，
//   > 而那时它表现为"这个 agent 怎么老是不改"。
//
// ## 这一份同时守两件事
//
//   · **行为**（运行时）：`rejectTask` 真的发了 comment 再发 transition，
//     顺序对不对、带没带 ifVersion、空理由是不是**在发请求之前**就被拒；
//   · **接线**（静态读源码）：弹窗是真的接上了，而不是"修了底层、按钮还走老路"——
//     底层对而没接上，与底层错是同一个结果，这正是上一批（`rework-plan.test.mjs`）的教训。
//
// 运行：node --experimental-strip-types --test workbench/scripts/reject-path.test.mjs
// ============================================================================
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8')

/** 剥掉整行注释（与 `no-classic-board.test.mjs` 同法）：文件头要能放心讲这段历史。 */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

// api.ts 在模块顶层读 window / localStorage（hubBase 与 token）⇒ 先设全局再动态导入
globalThis.window = { location: { search: '' } }
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)) },
  removeItem: (k) => { store.delete(k) },
}
store.set('legion.workbench.hub', 'http://hub.test')

const api = await import('../src/api.ts')

let calls = []
const realFetch = globalThis.fetch
const fakeResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})

before(() => {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    return fakeResponse(200, { ok: true })
  }
})
after(() => { globalThis.fetch = realFetch })
beforeEach(() => { calls = [] })

const paths = () => calls.map(c => `${c.method} ${c.url.replace('http://hub.test', '')}`)

describe('① rejectTask 的行为：评论 + 归还待办，两件事一起做', () => {
  it('先写评论、再迁移；理由进评论正文', async () => {
    await api.rejectTask({ id: 'T-199', by: 'general', reason: '头像裁切有黑边' })
    assert.deepEqual(paths(), ['POST /api/comment', 'POST /api/transition'], '顺序不能反：退回后守护可能立刻认领')
    assert.equal(calls[0].body.id, 'T-199')
    assert.match(calls[0].body.text, /头像裁切有黑边/, '理由必须真的进评论——这是 worker 下一轮唯一的输入')
    assert.equal(calls[1].body.to, 'todo')
    assert.equal(calls[1].body.id, 'T-199')
  })

  it('★ 绝不打 `/api/reject`（那个端点没有任何服务端在实现）', async () => {
    await api.rejectTask({ id: 'T-1', by: 'general', reason: 'x' })
    assert.equal(paths().some(p => p.includes('/api/reject')), false,
      'v1 的 /api/reject 已退役；再打过去只会得到一句像"路径拼错了"的 404')
  })

  it('ifVersion 必须带出去（乐观锁：将军看到的版本 vs 现在的版本）', async () => {
    await api.rejectTask({ id: 'T-1', by: 'general', reason: 'x', ifVersion: 7 })
    assert.equal(calls[1].body.ifVersion, 7)
    calls = []
    await api.rejectTask({ id: 'T-1', by: 'general', reason: 'x' })
    assert.equal('ifVersion' in calls[1].body, false, '没给版本就不许编一个')
  })

  it('by 由调用方决定（看板拖拽传绑定者、调度弹窗传 general）', async () => {
    await api.rejectTask({ id: 'T-1', by: 'coder', reason: 'x' })
    assert.equal(calls[1].body.by, 'coder')
  })

  it('★ 空理由在**发请求之前**就被拒，且是具名错误（不是 404，也不是"无理由"三个字）', async () => {
    for (const bad of ['', '   ', '\n\t ']) {
      calls = []
      await assert.rejects(
        () => api.rejectTask({ id: 'T-1', by: 'general', reason: bad }),
        (e) => {
          assert.equal(e.code, 'REJECT_REASON_REQUIRED')
          assert.match(e.message, /理由/)
          assert.doesNotMatch(e.message, /404/, '这是本地校验，不该长得像一个 HTTP 错误')
          return true
        },
        JSON.stringify(bad),
      )
      assert.deepEqual(calls, [], '被拒时一个请求都不该发出（半个打回比不打回更坏：评论写了但没退回）')
    }
  })
})

describe('② rejectTask 是"打回"的唯一实现（不许在别处再拼一遍）', () => {
  it('api.ts 的 rejectTask 里就是 comment + transition，没有第二条路', () => {
    const api = codeOnly(read('src/api.ts'))
    const at = api.indexOf('export function rejectTask')
    assert.ok(at > 0, '找不到 rejectTask')
    const body = api.slice(at, at + 1600)
    assert.match(body, /hubComment\(/, '必须先写评论')
    assert.match(body, /hubTransition\(/, '再归还待办')
    assert.ok(body.indexOf('hubComment(') < body.indexOf('hubTransition('), '顺序：评论在前')
    assert.equal(body.includes("post('/api/reject'"), false, '不许再打那条已退役的端点')
  })

  it('★ 打回那条路上没有第二份"评论 + 迁移"（两份实现会漂成两句不一样的话）', () => {
    // TaskCenterView 与 ReworkModal 的打回都**只剩**转发：它们连 hubComment 都不该再 import。
    // （HubSchedulerModal 里还有 hubComment —— 那是「💬 评论」按钮，不是打回；下面单独钉它的 reject。）
    for (const f of ['src/components/ReworkModal.tsx', 'src/components/TaskCenterView.tsx']) {
      const code = codeOnly(read(f))
      assert.equal(/hubComment\(/.test(code), false,
        `${f} 自己拼了评论 —— 打回的唯一实现是 rejectTask()，别处再拼一遍就会漂`)
    }
    const rejectLine = codeOnly(read('src/components/HubSchedulerModal.tsx'))
      .split('\n').find(l => l.trim().startsWith('const reject ='))
    assert.ok(rejectLine, '找不到 HubSchedulerModal 的 reject')
    assert.match(rejectLine, /setRejectAsk\(t\)/, '打回只负责把任务交给弹框')
    assert.doesNotMatch(rejectLine, /prompt|hubComment|hubTransition/,
      '打回那一行不许自己收理由或自己发请求 —— 它当年就是这么把理由丢掉的')
  })
})

describe('③ 接线判据（静态读源码）：修了底层还得真的接上', () => {
  it('★ HubSchedulerModal 的打回不再用 window.prompt 收理由，而是弹必填框', () => {
    const full = read('src/components/HubSchedulerModal.tsx')
    const src = codeOnly(full)
    // 只钉**打回**这一段：这个文件里「💬 评论」与「转派」仍然用 prompt（那是另外两件事，不在本次范围）。
    const at = full.indexOf('const reject = (t: HubTask)')
    assert.ok(at > 0, '找不到 reject 的定义')
    const rejectBody = full.slice(at, full.indexOf('const returnTodo', at))
    assert.doesNotMatch(rejectBody, /window\.prompt/, '打回理由不许再用 prompt（单行、不校验、可被静默屏蔽）')
    assert.match(rejectBody, /setRejectAsk\(t\)/)
    assert.match(src, /import \{ ReworkModal \} from '\.\/ReworkModal'/)
    assert.match(src, /<ReworkModal/, '弹框必须真的渲染出来')
    assert.match(src, /intent="return"/, '调度弹窗里的打回是"同一目标内退回"，不是重做')
  })

  it('★ 两个弹窗都把 ifVersion 与 by 交给弹框（乐观锁与操作者不能丢）', () => {
    const hub = codeOnly(read('src/components/HubSchedulerModal.tsx'))
    assert.match(hub, /ifVersion=\{rejectAsk\.version\}/)
    assert.match(hub, /by=\{bindOf\(rejectAsk\)\}/)
    const board = codeOnly(read('src/components/SchedulerModal.tsx'))
    assert.match(board, /rejectTask\(\{ id, by: 'general', reason: reason\.trim\(\), ifVersion: version \}\)/)
    assert.match(board, /void reject\(card\.id, card\.version\)/, '按钮必须把版本传进来，否则乐观锁形同虚设')
  })

  it('★ SchedulerModal 的成功文案不许再说"worktree 已回滚"（v2 没有那件事）', () => {
    const src = codeOnly(read('src/components/SchedulerModal.tsx'))
    assert.equal(/worktree 已回滚/.test(src), false,
      'v2 没有 w/<id> 分支纪律 ⇒ 没有"回滚"；board-plugin 的 501 说明里逐字写着"已退役"')
    assert.match(src, /已打回待办/, '照实说：打回了，理由进了评论')
  })

  it('★ ReworkModal 的打回分支调 rejectTask（不是自己拼两个请求）', () => {
    const src = codeOnly(read('src/components/ReworkModal.tsx'))
    assert.match(src, /import \{ hubRework, rejectTask \} from '\.\.\/api'/)
    assert.match(src, /await rejectTask\(\{/)
    assert.match(src, /by: by \?\? 'general'/)
  })

  it('★ 看板拖拽那条路仍然必填（上一批的判据不能被这次改动弄松）', () => {
    const plan = read('scripts/rework-plan.test.mjs')
    assert.match(plan, /重做\/打回必须弹必填框/, 'rework-plan 里那条判据还在')
    const view = codeOnly(read('src/components/TaskCenterView.tsx'))
    assert.match(view, /by=\{bindOf\(dropAsk\.item\)\}/, '看板拖拽也要把操作者交给弹框')
  })
})
