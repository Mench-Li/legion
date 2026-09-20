// team-hub/routes/space-operations.mjs
// ============================================================================
// 路由层第 37 族：**工作空间的运维面：删除预检（影响面，只读）/ 开通 / 删除（含附件目录清理）** —— PRT-316 切片 39
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 37 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show accae77:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 3 条的形态分布（生成器算的，不是抄的）
//
//   ×  3  `path === '…'`
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
// 3 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

/**
 * 造工作空间的运维面：删除预检（影响面，只读）/ 开通 / 删除（含附件目录清理）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createSpaceOperationsRoutes({
  json,
  handleWrite, audit, db,
  now, withTx, SCOPE_KEY_RE,
  readPipeline, pipelineWarnings, UPLOADS_ROOT,
  existsSync, readFileSync, join,
  rmSync,
}) {
  const deps = { json,
    handleWrite, audit, db,
    now, withTx, SCOPE_KEY_RE,
    readPipeline, pipelineWarnings, UPLOADS_ROOT,
    existsSync, readFileSync, join,
    rmSync,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createSpaceOperationsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/spaces/impact',
      async run(req, res, { url }) {
        // 删除预检（只读，AC-R3-1）：返回该空间将影响的数据面计数 + 在办执行状态；调用不产生 audit/SSE。
        try {
          const id = url.searchParams.get('id') ?? ''
          if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('空间 id 非法：小写字母/数字开头，可含连字符，≤64 字符')
          const existing = db.prepare('SELECT id FROM spaces WHERE id = ?').get(id)
          if (!existing) throw new Error(`未知空间 ${id}`)
          const countOf = (sql) => db.prepare(sql).get(id).c
          const counts = {
            tasks: countOf('SELECT COUNT(*) AS c FROM tasks WHERE scope = ?'),
            roster: countOf('SELECT COUNT(*) AS c FROM roster WHERE scope = ?'),
            agentModels: countOf('SELECT COUNT(*) AS c FROM agent_models WHERE scope = ?'),
            execRequests: countOf('SELECT COUNT(*) AS c FROM exec_requests WHERE scope = ?'),
            skills: countOf('SELECT COUNT(*) AS c FROM skills WHERE scope = ?'),
            goal: countOf('SELECT COUNT(*) AS c FROM goal WHERE scope = ?'),
            execState: countOf('SELECT COUNT(*) AS c FROM exec_state WHERE scope = ?'),
            conversations: countOf('SELECT COUNT(*) AS c FROM conversations WHERE scope = ?'),
            messages: countOf('SELECT COUNT(*) AS c FROM messages WHERE scope = ?'),
            calendarEvents: countOf('SELECT COUNT(*) AS c FROM calendar_events WHERE scope = ?'),
            members: countOf('SELECT COUNT(*) AS c FROM members WHERE scope = ?'),
            chatReplySettings: countOf('SELECT COUNT(*) AS c FROM chat_reply_settings WHERE scope = ?'),
            chatAttachments: countOf('SELECT COUNT(*) AS c FROM chat_attachments WHERE scope = ?'),
            rules: countOf('SELECT COUNT(*) AS c FROM rules WHERE scope = ?'),
            skillSources: countOf('SELECT COUNT(*) AS c FROM skill_sources WHERE scope = ?'),
            spaceStages: countOf('SELECT COUNT(*) AS c FROM space_stages WHERE scope = ?'),
            spaceRuntime: countOf('SELECT COUNT(*) AS c FROM space_runtime WHERE scope = ?'),
          }
          const running = db.prepare("SELECT id, title, status FROM tasks WHERE scope = ? AND status IN ('in_progress','in_review','blocked') ORDER BY id").all(id)
          json(res, 200, { id, counts, running: { tasks: running } })
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/spaces/provision',
      async run(req, res, { url }) {
        // SP-P0 开通预检（只读，不产生 audit/SSE）：把「这个空间现在能不能自动循环」变成一份可执行清单。
        // 直接对治 T-127 现场：目标发布成功、链也建对了，却因为「没有绑定的守护实例 / 编队与流水线不一致」
        // 静默停在 todo 十几小时，而指挥台没有任何提示。
        try {
          const id = (url.searchParams.get('id') ?? '').trim()
          if (!SCOPE_KEY_RE.test(id)) throw new Error('空间 id 非法（字母/数字/下划线/连字符，≤64 字符）')
          const space = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id)
          const roster = db.prepare('SELECT role, name FROM roster WHERE scope = ? ORDER BY sort, role').all(id)
          const view = readPipeline(id)
          const checks = []
          const add = (level, code, message, fix = null) => checks.push({ level, code, message, fix })

          // 1) 空间注册（warn 而非 error：未注册的 scope 仍可跑通循环——夹具 __p13fixture__ 即如此；
          //    真正的后果是「无工作区绑定 → 回落注入默认仓库」，由下面的 workspace-unbound 一并说明）
          if (!space) add('warn', 'space-missing', `空间 ${id} 未注册（spaces 表无记录）——无工作区绑定，守护会回落到注入的默认仓库根`, `POST /api/spaces {id:"${id}", name:"…", localDir:"<仓库路径>"}`)

          // 2) 编队
          if (roster.length === 0) add('warn', 'roster-empty', '该空间编队为空——发布目标无法生成任何阶段任务', '指挥台「空间设置 → 智能体」选人入编')

          // 3) 流水线（含编队一致性）
          if (view.stages.length === 0) {
            add('error', 'pipeline-missing', '该空间未配置流水线——守护按角色过滤时会跳过全部任务（或建链退回全编队造成死锁）',
              `POST /api/pipeline {scope:"${id}", stages:[…]}（或 node team-hub/scripts/seed-pipeline.mjs --scope ${id} --file <roles.json>）`)
          } else {
            add('ok', 'pipeline-configured', `流水线 ${view.activeRoles.length} 环：${view.activeRoles.join(' → ')}（version ${view.version}）`)
          }
          // pipelineWarnings 会在「流水线为空且编队非空」时再报一次 pipeline-missing：
          // 上面那条已给出可执行的修复命令（seed-pipeline），故此处按 code 去重（含前面已加入的项），
          // 避免清单里出现两条同名阻塞项。
          const addedCodes = new Set(checks.map(c => c.code))
          for (const w of pipelineWarnings(id, view)) {
            if (addedCodes.has(w.code)) continue
            addedCodes.add(w.code)
            add(w.level, w.code, w.message, null)
          }

          // 4) 执行配置
          if (!view.runtime.enabled) {
            add('warn', 'runtime-disabled', '该空间执行配置未开启（space_runtime.enabled=false）——P1 起守护据此跳过该空间', `POST /api/pipeline {scope:"${id}", runtime:{enabled:true}}`)
          }

          // 5) 守护实例在线（当前部署形态：一个空间一个守护实例/scope）
          const nowMs = Date.now()
          const workers = db.prepare("SELECT id, lastSeenAt FROM members WHERE kind = 'worker' AND scope = ?").all(id)
          const online = workers.filter(w => nowMs - new Date(w.lastSeenAt ?? 0).getTime() < 60000)
          if (online.length === 0) {
            add('error', 'daemon-offline', workers.length > 0
              ? `守护实例过期心跳（最后 ${workers[0].lastSeenAt}）——目标链不会被认领`
              : `该空间没有守护实例（无 scope=${id} 的 worker 心跳）——这是目标停在 todo 的最常见原因`,
            `在 DSH profile 的 cordis.patch.yml 增加一行 legion-scrum-worker-${id}（scope:"${id}"、rolesFile 指向该空间流水线导出文件）`)
          } else {
            add('ok', 'daemon-online', `守护实例在线：${online.map(w => w.id).join('、')}`)
          }

          // 6) 工作区绑定（隔离 worktree / 合入都依赖它）
          const localDir = space?.local_dir ?? ''
          if (localDir.length === 0) {
            add('warn', 'workspace-unbound', '未绑定本地文件夹（localDir）——守护会回落到注入的默认仓库根，产物可能落在错误目录', `POST /api/spaces {id:"${id}", name:"…", localDir:"<仓库路径>"}`)
          } else if (!existsSync(localDir)) {
            add('error', 'workspace-missing', `绑定的本地文件夹不存在：${localDir}`, '修正 localDir 或先 clone 该仓库')
          } else if (!existsSync(join(localDir, '.git'))) {
            add('warn', 'workspace-not-git', `绑定的文件夹不是 git 仓库：${localDir}——无法做 w/<任务ID> 隔离与自动合入`, '绑定一个 git 仓库（或使用 P2 的无仓库模式）')
          } else {
            let ignoreWarn = null
            try {
              const gi = readFileSync(join(localDir, '.gitignore'), 'utf8')
              if (!gi.includes('.legion-worktrees')) ignoreWarn = '绑定仓库的 .gitignore 未忽略 .legion-worktrees/（隔离工作树会污染 git status）'
            } catch { ignoreWarn = '绑定仓库没有 .gitignore（建议忽略 .legion-worktrees/）' }
            if (ignoreWarn !== null) add('warn', 'worktree-not-ignored', ignoreWarn, '在绑定仓库 .gitignore 追加一行 .legion-worktrees/')
            else add('ok', 'workspace-bound', `工作区绑定可用：${localDir}（git 仓库）`)
          }

          // 7) 在办任务可见性
          const running = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE scope = ? AND status IN ('in_progress','in_review')").get(id).c
          const todo = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE scope = ? AND status = 'todo'").get(id).c
          if (todo > 0 && online.length === 0) add('error', 'queue-stalled', `有 ${todo} 个 todo 任务但没有在线守护——队列不会前进`)
          else add('ok', 'queue-visible', `队列：todo ${todo} / 在办 ${running}`)

          json(res, 200, {
            id,
            name: space?.name ?? id,
            ok: !checks.some(c => c.level === 'error'),
            checkedAt: now(),
            pipeline: { version: view.version, stages: view.stages.length, activeRoles: view.activeRoles },
            runtime: view.runtime,
            checks,
          })
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/spaces/delete',
      async run(req, res) {
         // 删除工作空间及其 scope 数据（级联所有 scope 表 + uploads/<scope> 文件；audit 行保留供追溯）。
        // 安全护栏：software/default 等受保护空间一律拒绝；调用方须显式 confirm=`delete-space:<id>`。
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('空间 id 非法：小写字母/数字开头，可含连字符，≤64 字符')
          if (id === 'software' || id === 'default') throw new Error(`受保护空间 ${id} 不可删除`)
          if (body.confirm !== `delete-space:${id}`) throw new Error('缺少确认：confirm 须为 delete-space:<id>（该操作会删除该空间全部任务/目标/编队/模型/技能/对话/日程数据）')
          if (by !== 'general' && body.forceGeneral !== true) throw new Error('删除空间仅允许 general 执行')
          const existing = db.prepare('SELECT id FROM spaces WHERE id = ?').get(id)
          if (!existing) throw new Error(`未知空间 ${id}`)
          const removed = withTx(() => {
            const counts = {}
            for (const [key, sql] of [
              ['tasks', 'DELETE FROM tasks WHERE scope = ?'],
              ['roster', 'DELETE FROM roster WHERE scope = ?'],
              ['agentModels', 'DELETE FROM agent_models WHERE scope = ?'],
              ['execRequests', 'DELETE FROM exec_requests WHERE scope = ?'],
              ['skills', 'DELETE FROM skills WHERE scope = ?'],
              ['goal', 'DELETE FROM goal WHERE scope = ?'],
              ['execState', 'DELETE FROM exec_state WHERE scope = ?'],
               ['conversations', 'DELETE FROM conversations WHERE scope = ?'],
               ['messages', 'DELETE FROM messages WHERE scope = ?'],
               ['calendarEvents', 'DELETE FROM calendar_events WHERE scope = ?'],
               ['members', 'DELETE FROM members WHERE scope = ?'],
               ['chatReplySettings', 'DELETE FROM chat_reply_settings WHERE scope = ?'],
               ['chatAttachments', 'DELETE FROM chat_attachments WHERE scope = ?'],
               ['rules', 'DELETE FROM rules WHERE scope = ?'],
               ['skillSources', 'DELETE FROM skill_sources WHERE scope = ?'],
               ['spaceStages', 'DELETE FROM space_stages WHERE scope = ?'],
               ['spaceRuntime', 'DELETE FROM space_runtime WHERE scope = ?'],
             ]) counts[key] = db.prepare(sql).run(id).changes
             db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
             return counts
           })
           // scope 已通过严格正则校验；附件路径约定为 uploads/<scope>/<sha1>，删除整个空间目录以清理孤儿文件。
           const scopeUploads = join(UPLOADS_ROOT, id)
           try { rmSync(scopeUploads, { recursive: true, force: true }) } catch { /* 文件清理失败不回滚已完成的 DB 删除 */ }
           audit(by, id, 'space:delete', null, { space: id, removed })
          return { id, removed }
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
    id: 'space-operations',
    routes,
    /** 3 条；顺序与 `handle` 里原来那 3 条 `if` 相同。 */
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
