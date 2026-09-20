// team-hub/routes/secrets.mjs
// ============================================================================
// 路由层第 6 族：**密钥库（secrets）：状态只读 + 列表 + 写入 + 轮换 + 删除（引用名走 URL）** —— PRT-316 切片 6
//
// 缝在 `team-hub/router.mjs`（切片 1 立的）；本文件是搬进那个家的第 6 族。
//
// ## 本文件是**生成**的
//
// 生成器：`.worktrees/_prt-handoff/gen-family.mjs`，源头是
// `git show 045e57f:team-hub/server.mjs` 的 `/api/secrets` 段落。
//
//   > 逐字保真应该是**构造出来的**，而不是"我抄的时候小心一点"。
//
// ## 本族 5 条的形态分布（生成器算的，不是抄的）
//
//   ×  3  `path === '…'`
//   ×  1  `path.startsWith('…')`
//   ×  1  `path.startsWith('…') && path.endsWith('…')`
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

// ============================================================================
// 以下 36 行是 `server.mjs` 原文的**段首说明**，逐字搬来（未改写）。
// 提取代码时最容易丢掉的就是这一段：它写的是"为什么"，而对拍只比函数体。
// ============================================================================
// ── 凭证管理（spec §6.7 的**写**一半） ──
//
// 在 PRT-505 / PRT-254 之前，密钥库只有**读**被接上
// （`runtime/probe/secret-resolver.mjs`）；`store.put` / `rotate` / `remove`
// 在整个仓库里**零生产调用方**，也没有任何路由。于是：
//
//   · `secretRef` 只能指向别人（手写的文件、DSH 的凭证文件）放进去的东西；
//   · spec §6.7 要求的"新增/更新/轮换/删除写审计记录"——四个动作一个都发不出来。
//
//   > 一个功能没有入口，与这个功能不存在，对用户来说是同一件事。
//
// 四条纪律，逐条都能追到一次具体的失败：
//
// ① **响应里永远没有值。** 返回的是 `freezeMeta` 的产物（ref/purpose/
//    scheme/时间戳），不含 blob、不含明文。错误对象由 `SecretStoreError`
//    构造，它的上下文本身就是白名单（ref/platform/cause）——所以
//    "顺手把密钥塞进错误里"这条路在类型层面就不成立。
//
// ② **打不开就 fail closed，没有降级开关。** `requireProtected: true`
//    在 `secret-admin.mjs` 里写死。读路径上明文后端只是让人看到不该看的
//    东西；写路径上它会**把用户的真实密钥明文落盘**。
//
// ③ **写成功之后必须让探测缓存失效**（§6.7）。`probe-service.mjs:39`
//    早就写了 `invalidate()` 给"轮换/修改凭证的路径"用，而它**从来没有
//    被调用过**——因为写路径不存在，两条线一直在互相等。不失效的后果很具体：
//    轮换完密钥、界面点"测试连接"，拿到的还是**用旧钥匙得出的旧结论**，
//    而它看起来完全像一次新的验证。
//
// ④ **每次写完都重新核验文件权限。** 写入走 `写临时文件 + rename`，
//    而 Windows 上 `mode:0o600` 基本被忽略、新文件的 ACE 继承自目录——
//    也就是说上一次加固出来的"仅所有者可读"会被**每一次写入**重置。
//    详见 `team-hub/secret-admin.mjs` 的文件头。
//
// 路径一律用**字面量**（不用常量）：`scripts/prt/baseline-snapshot.mjs`
// 的抽取器只认字符串字面量，用常量写会让这些路由**静默地**不进平台契约基线，
// 而基线照样报"与已记录一致"。


/**
 * 造密钥库（secrets）：状态只读 + 列表 + 写入 + 轮换 + 删除（引用名走 URL）族路由。
 *
 * @param {object} deps 全部由 `server.mjs` 注入
 */
export function createSecretsRoutes({
  json,
  secretAdmin, handleRun, audit,
  readScope,
}) {
  const deps = { json,
    secretAdmin, handleRun, audit,
    readScope,
  }
  for (const [k, v] of Object.entries(deps)) {
    if (v === undefined || v === null) throw new TypeError(`createSecretsRoutes 缺注入项：${k}`)
  }

  const routes = [
    {
      method: 'GET',
      match: 'exact',
      path: '/api/secrets/status',
      async run(req, res) {
        await handleRun(req, res, async () => {
          const s = await secretAdmin().describe()
          // 自检形态的只读结果：**只有计数，没有引用名**。
          // 引用名能画出"这台机器配了哪些供应商"，而这个结果会被显示与记录
          // （与 `product/secrets.mjs` ④ 同一条纪律）。要列名请走 GET /api/secrets。
          return { status: s }
        })
      },
    },
    {
      method: 'GET',
      match: 'exact',
      path: '/api/secrets',
      async run(req, res) {
        await handleRun(req, res, async () => {
          const r = await secretAdmin().list()
          return { secrets: r.entries, aclVerified: r.aclVerified }
        })
      },
    },
    {
      method: 'POST',
      match: 'exact',
      path: '/api/secrets',
      async run(req, res) {
        await handleRun(req, res, async (body) => {
          // `ref` / `value` 的缺失与形态由密钥库自己判（`assertSecretRef` 是唯一判据）。
          // API 层不重复校验——重复的后果不是多一道防线，而是两处判据会漂移。
          const r = await secretAdmin().put({ ref: body?.ref, value: body?.value, purpose: body?.purpose })
          audit(body?.actor ?? body?.member ?? 'unknown', readScope(body ?? {}), 'secret:put', null,
            { ref: r.meta?.ref ?? null, purpose: r.meta?.purpose ?? null, aclVerified: r.aclVerified })
          // 只回元数据（ref/purpose/scheme/时间戳）。**永远没有值**。
          // `aclVerified` 与 `aclNote` 必须一起给出：文件权限在每一次写入之后
          // 都会被重置再加固，而"没核验过"不能看起来像"已确认安全"。
          return {
            secret: r.meta,
            aclVerified: r.aclVerified,
            acl: r.acl,
            aclNote: r.aclNote,
          }
        })
      },
    },
    {
      method: 'POST',
      match: 'prefix+suffix',
      path: '/api/secrets/',
      suffix: '/rotate',
      async run(req, res, { path }) {
        const rawRef = path.slice('/api/secrets/'.length, path.length - '/rotate'.length)
        if (rawRef === '') { json(res, 400, { ok: false, error: '缺少 secretRef', code: 'MISSING_PARAM' }); return }
        let rotateRef
        try {
          rotateRef = decodeURIComponent(rawRef)
        } catch {
          json(res, 400, { ok: false, error: 'secretRef 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return
        }
        await handleRun(req, res, async (body) => {
          const r = await secretAdmin().rotate({ ref: rotateRef, value: body?.value, purpose: body?.purpose })
          audit(body?.actor ?? body?.member ?? 'unknown', readScope(body ?? {}), 'secret:rotate', null,
            { ref: r.meta?.ref ?? null, purpose: r.meta?.purpose ?? null, aclVerified: r.aclVerified })
          // 只回元数据（ref/purpose/scheme/时间戳）。**永远没有值**。
          // `aclVerified` 与 `aclNote` 必须一起给出：文件权限在每一次写入之后
          // 都会被重置再加固，而"没核验过"不能看起来像"已确认安全"。
          return {
            secret: r.meta,
            aclVerified: r.aclVerified,
            acl: r.acl,
            aclNote: r.aclNote,
          }
        })
      },
    },
    {
      method: 'DELETE',
      match: 'prefix',
      path: '/api/secrets/',
      async run(req, res, { path }) {
        const rawRef = path.slice('/api/secrets/'.length)
        if (rawRef === '') { json(res, 400, { ok: false, error: '缺少 secretRef', code: 'MISSING_PARAM' }); return }
        let delRef
        try {
          delRef = decodeURIComponent(rawRef)
        } catch {
          json(res, 400, { ok: false, error: 'secretRef 不是合法的 URL 编码', code: 'BAD_ID_ENCODING' }); return
        }
        if (delRef.includes('/')) {
          // 多段路径不是引用名：明确拒绝，不去猜用户想要哪一个。
          json(res, 400, { ok: false, error: 'secretRef 不能包含斜杠', code: 'BAD_ID_ENCODING' }); return
        }
        await handleRun(req, res, async (body) => {
          const r = await secretAdmin().remove(delRef)
          audit(body?.actor ?? body?.member ?? 'unknown', readScope(body ?? {}), 'secret:delete', null,
            { ref: delRef, removed: r.removed, aclVerified: r.aclVerified })
          return { removed: r.removed, aclVerified: r.aclVerified, acl: r.acl, aclNote: r.aclNote }
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
    id: 'secrets',
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
