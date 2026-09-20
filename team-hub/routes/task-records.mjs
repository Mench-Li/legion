// team-hub/routes/task-records.mjs
// ============================================================================
// 路由层第 39 族：**任务上的五张记录表：进度 / 改动补丁 / 逐文件验收意见 / 产物 / 测试报告（都走 handleWrite，都 version+1）** —— PRT-316 切片 41
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 39 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 9d00dbd:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 5 条的形态分布（生成器算的，不是抄的）
//
//   ×  5  `path === '…'`
//   ×  0  `path.startsWith('…')`
//   ×  0  `path.startsWith('…') && path.endsWith('…')`
//
// 生成器在切片 5 修正过一次**静默漏取**：切片 4 的版本只认等值那一种，
// 会静默跳过另外 48 条（旧自检只为"一条都没取到"准备，所以不会响）。
//
//   > 一个"按前缀取族、却只认一种写法"的生成器，
//   > 与一个"把这一族搬走一半"的提交，在 `node --check` 通过时是同一个东西。
//
// 生成器在切片 6 修正过第二次：ctx 成员**按体逐条绑定**（旧版一律允许
// `path`/`url`、却只解构 `url` ⇒ 体里用 `path` 的族会拿到 `undefined`）。
//
//   > 一个"把名字登记成可用"的白名单，与一个"真的把它绑进来"的解构，
//   > 在没人用那个名字的时候是同一个东西。
//
// ## 零注入改写
//
// 5 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造任务上的五张记录表：进度 / 改动补丁 / 逐文件验收意见 / 产物 / 测试报告（都走 handleWrite，都 version+1）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createTaskRecordsRoutes({
  json,
  handleWrite, getTask, db,
  now, parseJson, audit,
}) {
  const deps = { json,
    handleWrite, getTask, db,
    now, parseJson, audit,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createTaskRecordsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/progress',
      async run(req, res) {
        // 守护进度心跳（v1 遗留缺口补平，见 docs/P0-CONFIRMATION.md §5）：租约保鲜 + 遥测。
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const t = getTask(id)
          if (t.status !== 'in_progress') throw new Error(`仅 in_progress 任务可上报进度（当前 ${t.status}）`)
          db.prepare('UPDATE tasks SET claimedAt=?, updatedAt=?, version=version+1 WHERE id=?').run(now(), now(), id)
          audit(by, t.scope, 'progress', id, { percent: Number.isFinite(Number(body.percent)) ? Number(body.percent) : 0 }, t.goalId)
          return getTask(id)
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/patch',
      async run(req, res, { path }) {
        // hub 版 diff 登记（v1 taskctl patch 的等价物）：守护 recordPatch 在 hub 模式下调用。
        // L1 审计：files 支持结构化数组 [{path,status,add,del}]（守护 numstat 解析）；兼容旧 string。
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const t = getTask(id)
          const diff = typeof body.diff === 'string' ? body.diff : ''
          if (diff.length > 200000) throw new Error('diff 过大（>200KB），拒绝登记')
          let files
          if (Array.isArray(body.files)) {
            files = body.files.slice(0, 200).map(f => {
              const path = typeof f?.path === 'string' ? f.path.slice(0, 500) : ''
              if (!path) return null
              const status = typeof f.status === 'string' && /^[AMDRCUX]$/.test(f.status) ? f.status : 'M'
              const add = Number.isFinite(Number(f.add)) ? Math.max(0, Number(f.add)) : 0
              const del = Number.isFinite(Number(f.del)) ? Math.max(0, Number(f.del)) : 0
              return { path, status, add, del }
            }).filter(Boolean)
          } else {
            files = (typeof body.files === 'string' ? body.files.slice(0, 2000) : '')
              .split(',').map(s => s.trim()).filter(Boolean)
              .map(path => ({ path, status: 'M', add: 0, del: 0 }))
          }
          const list = parseJson(t.patches ?? '[]', [])
          list.push({ by, at: now(), summary: typeof body.summary === 'string' ? body.summary.slice(0, 200) : '', files, diff })
          if (list.length > 40) list.splice(0, list.length - 40)
          db.prepare('UPDATE tasks SET patches=?, version=version+1, updatedAt=? WHERE id=?').run(JSON.stringify(list), now(), id)
          audit(by, t.scope, 'patch', id, { files: files.map(f => f.path).join(',') }, t.goalId)
          return getTask(id)
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/review-notes',
      async run(req, res) {
        // L2 审计批注：任务（或任务内某文件）的 OK/问题 标记。file='*' = 整体结论；verdict=clear 清除。
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const t = getTask(id)
          if (!t) throw new Error(`未知任务 ${id}`)
          const file = typeof body.file === 'string' && body.file.trim() ? body.file.trim().slice(0, 500) : '*'
          const verdict = body.verdict
          if (verdict !== 'ok' && verdict !== 'issue' && verdict !== 'clear') throw new Error('verdict 必须是 ok|issue|clear')
          if (typeof body.note !== 'string') throw new Error('缺少参数 note')
          const note = body.note.trim().slice(0, 2000)
          const list = parseJson(t.review_notes ?? '[]', [])
          const others = list.filter(x => x.file !== file)
          if (verdict !== 'clear') others.push({ file, verdict, note, by, at: now() })
          db.prepare('UPDATE tasks SET review_notes=?, version=version+1, updatedAt=? WHERE id=?')
            .run(JSON.stringify(others), now(), id)
          audit(by, t.scope, 'review-note', id, { file, verdict, note: note.slice(0, 200) }, t.goalId)
          return getTask(id)
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/artifact',
      async run(req, res) {
        // hub 版产物登记（html/file/url），与 v1 taskctl artifact 等价。
        // ★★★ 这里原本生成成了 `async run(req, res, { path, url })` —— **两个都没用**：
        //   `path` 下面第 8 行就被 `const path = body.path` **遮蔽**了，
        //   而 `url` 从头到尾没出现 —— 它只出现在**下行那句注释**的「html/file/url」里。
        //   生成器解析标识符时**没有剥掉注释**，于是把一个注释里的词当成了真正的依赖。
        //   `check-free-identifiers` 抓到了它（`node --check` 与逐字对拍都看不见）。
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const t = getTask(id)
          const kind = body.kind
          const path = body.path
          if (typeof kind !== 'string' || (kind !== 'html' && kind !== 'file' && kind !== 'url')) throw new Error('kind 必须是 html|file|url')
          if (typeof path !== 'string' || path.length === 0) throw new Error('缺少产物路径 path')
          const list = parseJson(t.artifacts ?? '[]', [])
          const entry = { by, at: now(), kind, path, title: typeof body.title === 'string' ? body.title.slice(0, 120) : '' }
          // S2 契约登记幂等：守护登记时带内容 sha256 digest，服务端原样落库（v1 无 digest → 读取期缺省不比对）。
          if (typeof body.digest === 'string' && /^[0-9a-f]{16,}$/.test(body.digest)) entry.digest = body.digest
          list.push(entry)
          db.prepare('UPDATE tasks SET artifacts=?, version=version+1, updatedAt=? WHERE id=?').run(JSON.stringify(list), now(), id)
          audit(by, t.scope, 'artifact', id, { kind, path, digest: entry.digest ? 1 : 0 }, t.goalId)
          return getTask(id)
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/test-report',
      async run(req, res) {
        // tester worker 结构化报告（D7' 机器闸门的输入，见 docs/ORCHESTRATION-V3.md §4/§10）：仅 tester 任务可写。
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const t = getTask(id)
          if (t.role !== 'tester') throw new Error(`test-report 仅 tester 任务可写（role=${t.role}）`)
          if (t.status !== 'in_progress' && t.status !== 'in_review') throw new Error(`仅 in_progress/in_review 可写报告（当前 ${t.status}）`)
          const passed = body.passed === true
          const failures = Array.isArray(body.failures)
            ? body.failures.map(f => (f && typeof f === 'object')
                ? { name: String(f.name ?? '').slice(0, 200), log: String(f.log ?? '').slice(0, 4000), repro: String(f.repro ?? '').slice(0, 2000) }
                : { name: String(f).slice(0, 200), log: '', repro: '' }).slice(0, 200)
            : []
          if (!passed && failures.length === 0) throw new Error('passed=false 时必须给出 failures')
          const report = { passed, failures, summary: typeof body.summary === 'string' ? body.summary.slice(0, 2000) : '', at: now(), by }
          db.prepare('UPDATE tasks SET testReport=?, version=version+1, updatedAt=? WHERE id=?').run(JSON.stringify(report), now(), id)
          audit(by, t.scope, 'test-report', id, { passed, failures: failures.length }, t.goalId)
          return getTask(id)
        })
      },
    },
  ]

  const matches = (r, path) => {
    if (r.match === 'exact') return path === r.path
    if (r.match === 'prefix') return path.startsWith(r.path)
    if (r.match === 'prefix+suffix') return path.startsWith(r.path) && path.endsWith(r.suffix)
    return false
  }

  return {
    id: 'task-records',
    routes,
    /** 5 条；顺序与 `handle` 里原来那 5 条 `if` 相同。 */
    async dispatch(req, res, ctx) {
      for (const r of routes) {
        if (req.method !== r.method || !matches(r, ctx.path)) continue
        await r.run(req, res, ctx)
        return true
      }
      return false
    },
  }
}
