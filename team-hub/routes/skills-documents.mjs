// team-hub/routes/skills-documents.mjs
// ============================================================================
// 路由层第 30 族：**技能仓库与文档库的写入面（注册 / 复审 / 授权 / 撤销；建文 / 删文）** —— PRT-316 切片 32
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 30 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 17f0ccc:team-hub/server.mjs` 的 这一段区间（显式路径表）。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 6 条的形态分布（生成器算的，不是抄的）
//
//   ×  6  `path === '…'`
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
// 6 条路由的函数体与 `server.mjs` 原文逐字节相同（仅缩进 +2）。
// 依赖全部由调用方注入，本模块不 import 任何 hub 内部件。
// ============================================================================

// ============================================================================
// 以下 1 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── 技能（scope-owned + grant，借鉴 QM shared skills）──


/**
 * 造技能仓库与文档库的写入面（注册 / 复审 / 授权 / 撤销；建文 / 删文）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createSkillsDocumentsRoutes({
  json,
  registerSkill, reviewSkill, grantSkill,
  revokeSkill, registerDocument, deleteDocument,
  getSkill, checkPermission, getDocument,
  audit, handleWrite,
}) {
  const deps = { json,
    registerSkill, reviewSkill, grantSkill,
    revokeSkill, registerDocument, deleteDocument,
    getSkill, checkPermission, getDocument,
    audit, handleWrite,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createSkillsDocumentsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'POST',
      match: 'exact',
      path: '/api/skills/register',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          const name = body.name
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof name !== 'string' || name.trim().length === 0) throw new Error('缺少参数 name')
          const skill = registerSkill({
            id: id.trim(), name: name.trim(), description: body.description,
            main: body.main, config: body.config, scripts: body.scripts, cases: body.cases,
            prompt: body.prompt, // 兼容旧单文本提交（映射为 bundle.main）
            scope: body.scope ?? scope, owner: by,
          })
          // register 不设 general 门禁（任意成员可提交 pending 草稿，D-2）；审计归到技能归属空间。
          audit(by, skill.scope, 'skill:submit', id, { name: skill.name, version: skill.version, skillScope: skill.scope })
          return skill
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/skills/review',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          // 门禁（D-2/AC-R1-3）：复审仅 general 可执行；register 不在此列（维持现状）。
          if (by !== 'general') throw new Error('仅允许 general 执行技能复审（skill:review）')
          const id = body.id
          const action = body.action
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (typeof action !== 'string' || action.length === 0) throw new Error('缺少参数 action')
          const skill = reviewSkill(id, action)
          audit(by, skill.scope, 'skill:review', id, { action, status: skill.status, skillScope: skill.scope })
          return skill
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/skills/grant',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          // 门禁（D-2/AC-R1-3）：授权仅 general 可执行。
          if (by !== 'general') throw new Error('仅允许 general 执行技能授权（skill:grant）')
          const id = body.id
          const grants = body.grants
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (!Array.isArray(grants) || grants.length === 0) throw new Error('缺少参数 grants')
          if (body.unattended === true || body.permissionRequestId) {
            const skillForPermission = getSkill(id)
            if (!skillForPermission) throw new Error('技能不存在')
            const permission = checkPermission({ scope: skillForPermission.scope, actor: by, action: 'skill:grant', target: grants.map(String).sort().join(','), taskId: body.taskId, unattended: false, metadata: { unattended: body.unattended === true }, permissionRequestId: body.permissionRequestId })
            if (permission.status === 'pending') { const err = new Error('权限审批待处理'); err.statusCode = 202; err.permission = permission; throw err }
            if (!permission.allowed) throw new Error(`权限拒绝：${permission.reason}`)
          }
          const skill = grantSkill(id, grants.map(String))
          // 审计 detail 携带技能归属空间与目标空间（AC-R1-4）：audit.scope = 技能归属空间（跨空间操作不归错 scope）。
          audit(by, skill.scope, 'skill:grant', id, { grants: grants.map(String), skillScope: skill.scope })
          return skill
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/skills/revoke',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          // 门禁（D-2/AC-R1-3）：撤销仅 general 可执行。
          if (by !== 'general') throw new Error('仅允许 general 执行技能授权撤销（skill:revoke）')
          const id = body.id
          const targets = body.targets
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          if (!Array.isArray(targets) || targets.length === 0) throw new Error('缺少参数 targets')
          const skill = revokeSkill(id, targets.map(String))
          audit(by, skill.scope, 'skill:revoke', id, { targets: targets.map(String), skillScope: skill.scope })
          return skill
        })
      },
    },
    // ============================================================================
    // 原文的子段说明（9 行，逐字搬来、未改写）
    // ============================================================================
    // ── PRT-406：显式文档的写面（登记 / 删除）──
    //
    // 与技能写面的一处**刻意不同**：这里**没有 review 路由**。
    // 技能走「登记 → 复审 → 发布」，因为它会被员工当指令执行；文档是参考资料，
    // 登记即生效。给它加一道复审队列只会让人以为"文档也需要批准"——
    // 而审批的真实边界是 ToolGuard 与权限栈，不是这张表。
    //
    // ⚠️ `origin` **不由 body 决定**（registerDocument 里写死 'member'）：
    //   否则任何拿得到 token 的成员都能把自己的文档标成系统内容。
    {
      method: 'POST',
      match: 'exact',
      path: '/api/documents',
      async run(req, res, { path }) {
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          const doc = registerDocument({
            id: id.trim(),
            title: body.title,
            path: body.path,
            body: body.body,
            // 归属空间：显式 body.scope 优先，否则用写路径解析出来的 scope
            // （与 registerSkill 同口径）。
            scope: body.scope ?? scope,
          })
          // ★ 审计的 detail 里**不带正文**：审计是"谁改了什么"的记录，
          //   把 body 塞进去等于给每一份文档另存一份全文（还包括被删掉的那些）。
          audit(by, doc.scope, 'document:register', doc.id, {
            title: doc.title, path: doc.path, version: doc.version, sha256: doc.sha256,
            docScope: doc.scope, bodyBytes: Buffer.byteLength(doc.body, 'utf8'),
          })
          return doc
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/documents/delete',
      async run(req, res) {
        await handleWrite(req, res, (body, by, scope) => {
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) throw new Error('缺少参数 id')
          // 删除前先读一次：审计要记的是"删掉了什么"，而删完之后再读就没有了。
          let before = null
          try { before = getDocument(id) } catch { before = null }
          const out = deleteDocument(id.trim())
          audit(by, before?.scope ?? scope, 'document:delete', id.trim(), {
            deleted: out.deleted, title: before?.title ?? null, version: before?.version ?? null,
          })
          return out
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
    id: 'skills-documents',
    routes,
    /** 6 条；顺序与 `handle` 里原来那 6 条 `if` 相同。 */
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
