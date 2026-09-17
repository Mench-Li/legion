// orchestrator/worker/run-inputs.mjs
// ============================================================================
// 「这一次 Attempt 在哪个工作集里、用哪个模型、在哪个目录里跑」——
// 三个 `RunRequest` 必填字段的**唯一取值处**（PRT-253 续批）。
//
// ## 为什么需要这个模块
//
// `defaultRequestFor()` 已经明确拒绝猜这三项（见它的 JSDoc）。而生产链路上
// **没有任何东西给它们**：认领响应（`team-hub/run-store.mjs` 的 `shapeAttempt()`）
// 不带这三列，`WORKER_ENV` 不带这三个键，`product/` 里对它们的引用数是 0。
// 用真实认领形状实测的读数是：
//
//     EXECUTOR_BAD_WIRING  missing=["workspaceId","modelProfileRef","workdir"]
//
// 失效方向是**好的**（具名拒绝，不是静默跑错），但结论仍然是：
// product-runtime 的执行链今天通不了电。
//
//   > 一个"缺了就具名拒绝"的校验，与一个"永远缺、于是永远拒绝"的执行链，
//   > 在只看那条校验的用例里是同一个东西——只不过前者看起来是负责的。
//
// 本模块不发明数据源，只把**已有的**权威来源按优先级列出来，并把"这一项是从
// 哪来的"如实记下来（`sources`）。三种处境必须能分开：
//
//   · 控制面**显式给了**（租约上有值）      → 以它为准，`sources[key] = 'lease'`
//   · 本模块**从权威来源推导出来了**        → 用推导值，`sources[key] = 'derived:…'`
//   · **没有来源**                          → 进 `missing`，由调用方决定怎么办
//
// 第三项**绝不用默认值补**：一个"猜一个目录/猜一个模型"的默认值，会让
// 「这次没有工作集」与「这次的工作集是 X」在请求上长得一模一样，
// 而后者是要写进工具副作用的幂等键与审计的（spec `:672`）。
//
// ## 三个字段各自的权威来源
//
// | 字段 | ① 控制面 | ② 推导 | 依据 |
// | --- | --- | --- | --- |
// | `workspaceId` | `lease.workspaceId` | `lease.scope` | 效果命名空间必须**按 Attempt 稳定**（spec `:672` 把它算进工具副作用的幂等键），而本产品唯一持久的工作集划分就是**空间** |
// | `workdir` | `lease.workdir` | worktree 的 `slotDir`，否则授权的项目目录 | 有隔离时那是这次 Attempt 的独立检出；原地执行时就是授权目录本身 |
// | `modelProfileRef` | `lease.modelProfileRef` | 调用方从员工模型绑定解析出来的那个 | `employee_model_bindings`（PRT-502）。**本模块不自己去查**：它要 hub 客户端，而那是调用方的东西（见 `resolveRunInputs` 的 `modelProfileRef` 入参） |
//
// ## 为什么 `workspaceId` 允许从 `scope` 推导，而另外两项不许"就近凑"
//
// `workdir` 与 `modelProfileRef` 都能**具体到这一次执行**（哪个目录、哪个模型），
// 就近凑一个的后果是改用户的文件 / 花用户的钱；`workspaceId` 不是执行参数，
// 它是**幂等命名空间**——按空间取值既稳定（同一任务每次算出来的都一样）
// 又唯一（不同空间不会撞键），而"没有工作集"这种情形在 Legion 里不存在
// （每条任务都属于一个空间）。这一条是**产品口径的决定**，不是实现细节。
// ============================================================================

/**
 * 本模块负责的三个字段，逐字对应 `runtime/contracts/run.mjs` 的
 * `RUN_REQUEST_REQUIRED` 里那三项「猜不出来」的。
 */
export const RUN_INPUT_FIELDS = Object.freeze(['workspaceId', 'modelProfileRef', 'workdir'])

/** 具名错误码。**不笼统归并**：三种"缺"的修复动作不同。 */
export const RUN_INPUT_CODES = Object.freeze({
  /** 连租约都没有——调用方的代码错，不是数据缺。 */
  LEASE_REQUIRED: 'run-inputs-lease-required',
  /** 三项里有缺的。`missing` 逐项列出。 */
  MISSING: 'run-inputs-missing',
})

/**
 * 从 `prepareWorkspace()` 的结果里取"这次 Attempt 在哪个目录里干活"。
 *
 * 两种形态的判据是 `kind`，**不是**"有没有 `slotDir`"：
 * 一个"看字段在不在"的实现，会在某天有人给原地执行也带一个 `slotDir` 时
 * 静默换掉语义；`kind` 是提供者**显式声明**的（与 `workspaceIsolation` 同一条理由，
 * 见 `main.mjs` 的 `inPlaceStages()`）。
 *
 * 返回 `null` 表示"这个阶段的结果说不出目录"——那时由调用方退回授权的项目目录，
 * 而不是在这里编一个。
 */
export function workdirOf(workspace, { projectDir = null } = {}) {
  if (workspace === null || typeof workspace !== 'object') return null
  const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  // ① 有隔离：`slotDir` 是**这次 Attempt** 的独立检出（PRT-306 按 Attempt 分配）。
  if (workspace.kind === 'worktree') return clean(workspace.slotDir)
  // ② 原地：没有独立目录，干活的地方就是那个被授权的项目目录。
  if (workspace.kind === 'in-place') return clean(projectDir)
  // ③ 没见过的 kind：不假装知道它在哪。
  return null
}

/**
 * 把「租约 + 工作区阶段的结果 + 已解析的模型绑定」翻成三个字段。
 *
 * **不抛异常，返回判别式联合。** 理由与 `runWorkerProcess` 那条一样：
 * 一个"有时候抛、有时候返回值"的函数，调用方一定会写出只处理其中一种的代码，
 * 而漏掉的那一种表现为"这次缺字段"——与本模块要消灭的形状同类。
 *
 * @param {object} input
 * @param {object} input.lease 认领响应（`shapeAttempt()` 的形状）
 * @param {object|null} [input.workspace] `prepareWorkspace()` 的结果
 * @param {string|null} [input.projectDir] 用户授权的项目目录（原地执行时的 `workdir`）
 * @param {string|null} [input.modelProfileRef] 调用方已解析出来的模型档案引用
 * @returns {{ok: boolean, code: string|null, message: string|null, inputs: object|null, missing: string[], sources: object}}
 */
export function resolveRunInputs({
  lease = null,
  workspace = null,
  projectDir = null,
  modelProfileRef = null,
} = {}) {
  if (lease === null || typeof lease !== 'object') {
    return Object.freeze({
      ok: false,
      code: RUN_INPUT_CODES.LEASE_REQUIRED,
      message: 'resolveRunInputs 需要认领回来的租约：三个字段里有先以租约上的值为准的那几个，' +
        '而租约不在时「控制面给没给」这个问题本身就无从作答',
      inputs: null,
      missing: Object.freeze([]),
      sources: Object.freeze({}),
    })
  }

  const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  const sources = {}

  /** 取一个字段：控制面优先，其次推导，都没有就记进 `missing`。 */
  const pick = (key, fromLease, derived, label) => {
    const direct = clean(fromLease)
    if (direct !== null) {
      sources[key] = 'lease'
      return direct
    }
    const d = clean(derived)
    if (d !== null) {
      sources[key] = label
      return d
    }
    delete sources[key]
    return null
  }

  const inputs = {
    workspaceId: pick('workspaceId', lease.workspaceId, lease.scope, 'derived:scope'),
    // `workdirOf` 的返回值本身就是"从 workspace 阶段推导出来的目录"这一步的产物，
    // 所以它的来源标签要能看出是 worktree 还是 in-place——排障时这两者该去查的地方不同。
    workdir: pick(
      'workdir',
      lease.workdir,
      workdirOf(workspace, { projectDir }),
      workspace !== null && workspace.kind === 'worktree' ? 'derived:worktree-slot' : 'derived:project-dir',
    ),
    modelProfileRef: pick('modelProfileRef', lease.modelProfileRef, modelProfileRef, 'derived:model-binding'),
  }

  const missing = RUN_INPUT_FIELDS.filter((k) => inputs[k] === null)
  if (missing.length > 0) {
    return Object.freeze({
      ok: false,
      code: RUN_INPUT_CODES.MISSING,
      message: `这次 Attempt 有 ${missing.length} 个运行输入没有来源：${missing.join('、')}。` +
        '它们要么由控制面在租约上给出，要么由本进程从权威来源推导——' +
        '**不猜**：猜一个目录会改到用户没授权的文件，猜一个模型会花用户的钱，' +
        '猜一个幂等命名空间会让两次不同的副作用被判成同一次',
      inputs: null,
      missing: Object.freeze(missing),
      sources: Object.freeze({ ...sources }),
    })
  }

  return Object.freeze({
    ok: true,
    code: null,
    message: null,
    inputs: Object.freeze(inputs),
    missing: Object.freeze([]),
    // ★ 这一栏是给审计/排障的："这三个值里哪几个是控制面给的、哪几个是本进程推出来的"。
    //   只留下一个合并后的 inputs，会让"控制面这次没给"这件事永远查不出来——
    //   而那正是下一次要修的地方。
    sources: Object.freeze({ ...sources }),
  })
}

// ════════════════════════════════════════════════════════════════════════════
// `modelProfileRef` 的权威来源：员工的**模型绑定**（PRT-502）
// ════════════════════════════════════════════════════════════════════════════

/** 模型档案解析的具名码。四种"没能解析出来"要分得开，因为修法不同。 */
export const MODEL_PROFILE_CODES = Object.freeze({
  /** 没有 hub 读口——**不从环境变量猜一个模型**。 */
  HUB_REQUIRED: 'model-profile-hub-required',
  /** 缺 scope 或 role："该用哪个模型"没有主语。 */
  ROLE_REQUIRED: 'model-profile-role-required',
  /** 这个岗位没有绑定（404）。要去**建绑定**，不是去建档案。 */
  BINDING_NOT_FOUND: 'model-profile-binding-not-found',
  /** 有绑定，但主档案解析不出来（PRT-502 §①：**不许 fallback 悄悄顶替**）。 */
  PRIMARY_UNRESOLVED: 'model-profile-primary-unresolved',
  /** 问过了但没问到（5xx / 网络）。与 404 是**两件事**：这个要重试，那个要去配。 */
  UNREACHABLE: 'model-profile-hub-unreachable',
  /** 响应形状不认识。不从这里"努力理解"一个模型出来。 */
  BAD_SHAPE: 'model-profile-bad-shape',
})

/**
 * 问 team-hub「这个岗位（scope/role）现在该用哪个模型」，取出**主档案 id**。
 *
 * ## 为什么必须是 `chain[0].role === 'primary'`
 *
 * PRT-502 §① 的全部要点是：**主档案解析不出来时不许 fallback 悄悄顶替**。
 * 那条规则在库里的形状是 `ok: false` 且 `chain[0].role` 仍是 `'fallback'`
 * （`binding-store.mjs:293` 把 `resolveModelChain` 的结果原样铺开）。
 *
 * 于是只读 `chain[0].id` 的实现会把一次**配置错误**变成一次"照跑不误、
 * 只是换了个模型"的运行——而这正是 spec §6.6「不得在未获用户批准时自动切换
 * 到更昂贵模型」要禁止的事。所以这里两个条件都要：`ok === true` **且**
 * 第一位真的是 primary。
 *
 *   > 一个"取链首"的实现，与一个"主档案配错了就用备用顶上"的实现，
 *   > 在配置一直正确的时候是同一个东西。
 *
 * @param {object} input
 * @param {(path: string) => Promise<{status: number, body: object}>} input.get hub 读口
 * @param {string} input.scope
 * @param {string} input.role
 * @returns {Promise<{ok: boolean, code: string|null, message: string|null, modelProfileRef: string|null, chainRole: string|null, retryable: boolean}>}
 */
export async function resolveModelProfileRef({ get = null, scope = null, role = null } = {}) {
  const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  const refuse = (code, message, { retryable = false } = {}) => Object.freeze({
    ok: false, code, message, modelProfileRef: null, chainRole: null, retryable,
  })

  // 没有读口就**不猜**：一个从环境变量读出来的模型档案与"用户选过的那个"
  // 只差一次抄错，而后果是花用户的钱用一个没人批准过的模型。
  if (typeof get !== 'function') {
    return refuse(MODEL_PROFILE_CODES.HUB_REQUIRED,
      '没有 hub 读口，无法解析这次 Run 该用哪个模型档案。' +
      '**不回落成默认模型**：模型决定了花谁的钱、用哪份凭证，猜一个等于替用户做了一次没被批准的选择')
  }
  const s = clean(scope)
  const r = clean(role)
  if (s === null || r === null) {
    return refuse(MODEL_PROFILE_CODES.ROLE_REQUIRED,
      `解析模型绑定需要 scope 与 role：收到 scope=${JSON.stringify(scope)}、role=${JSON.stringify(role)}。` +
      '绑定是 (scope, role) 二元的——缺任何一个，"该用哪个模型"都没有主语')
  }

  let res
  try {
    res = await get(`/api/model-bindings/resolve?scope=${encodeURIComponent(s)}&role=${encodeURIComponent(r)}`)
  } catch (e) {
    // 网络层抛错 = 没问到，与 404（问过了，它说没有）不是一件事。
    return refuse(MODEL_PROFILE_CODES.UNREACHABLE,
      `模型绑定的解析路由不可达：${e?.message ?? e}`, { retryable: true })
  }
  const status = res?.status ?? 0
  const body = res?.body ?? null
  if (status === 404) {
    return refuse(MODEL_PROFILE_CODES.BINDING_NOT_FOUND,
      `岗位 ${s}/${r} 没有模型绑定（${body?.code ?? '无码'}）：${body?.error ?? '无说明'}。` +
      '要做的动作是**去建绑定**，不是去建档案')
  }
  if (status !== 200) {
    return refuse(MODEL_PROFILE_CODES.UNREACHABLE,
      `模型绑定解析返回 HTTP ${status}（${body?.code ?? '无码'}）：${body?.error ?? '无说明'}`,
      { retryable: status >= 500 })
  }
  const resolution = body?.resolution
  if (body?.ok !== true || resolution === null || typeof resolution !== 'object') {
    return refuse(MODEL_PROFILE_CODES.BAD_SHAPE,
      `模型绑定解析的响应形状不认识：body.ok=${JSON.stringify(body?.ok)}、resolution 是 ${typeof resolution}`)
  }
  if (resolution.ok !== true) {
    // ★ 这一条是 PRT-502 §① 的落点：`ok: false` 时**备用仍然在链上**，
    //   而它**不许**被当成主档案用。
    return refuse(MODEL_PROFILE_CODES.PRIMARY_UNRESOLVED,
      `岗位 ${s}/${r} 的主档案解析不出来（${resolution.code ?? '无码'}）：${resolution.message ?? '无说明'}。` +
      '**不自动降级到备用**——备用是为"运行时连不上"准备的，不是为"配置写错了"准备的；' +
      '让它顶班会用一个没人选过的模型跑完这次运行，而且不报错')
  }
  const first = Array.isArray(resolution.chain) ? resolution.chain[0] : null
  const id = clean(first?.id)
  const chainRole = clean(first?.role)
  if (id === null || chainRole !== 'primary') {
    return refuse(MODEL_PROFILE_CODES.PRIMARY_UNRESOLVED,
      `岗位 ${s}/${r} 的解析说 ok=true，但链首不是主档案（role=${JSON.stringify(first?.role)}、id=${JSON.stringify(first?.id)}）。` +
      '取链首的实现会把"主档案配错了、备用顶上"读成一次正常运行')
  }
  return Object.freeze({
    ok: true,
    code: null,
    message: null,
    modelProfileRef: id,
    chainRole,
    retryable: false,
  })
}

/**
 * 把"从租约取到该用哪个模型"整条链封成一个端口，交给 `createWorker({ modelProfileRefFor })`。
 *
 * ## 为什么要多一跳：岗位（role）**不在租约上**
 *
 * 认领响应（`shapeAttempt()`）没有 `role` 这一列，而模型绑定是 `(scope, role)` 二元的。
 * 岗位写着**任务**上，所以要先读一次 `/api/task?id=`。
 *
 * 口径与 `sources-loader.mjs:579` **逐字一致**（`task.role ?? lease.employeeRole ?? lease.role`）：
 * 两处各写一遍"这个 Attempt 是谁的岗位"，会在某一天只改其中一份——
 * 而那一天的表现为"清单取的是 A 岗位、模型用的是 B 岗位的"。
 *
 * ★ 这里**不猜**：读不到任务、或任务上没有 role，就返回 `ROLE_REQUIRED`
 *   而不是回落到某个默认模型。猜错岗位等于用别人的模型花别人的钱。
 *
 * @param {object} input
 * @param {(path: string) => Promise<{status:number, body:object}>} input.get
 * @returns {(lease: object) => Promise<object>} 端口实现
 */
export function createModelProfileRefResolver({ get = null } = {}) {
  return async function modelProfileRefFor(lease) {
    const clean = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
    if (typeof get !== 'function') {
      return Object.freeze({
        ok: false, code: MODEL_PROFILE_CODES.HUB_REQUIRED,
        message: '没有 hub 读口：既读不出任务的岗位，也解析不了模型绑定',
        modelProfileRef: null, chainRole: null, retryable: false,
      })
    }
    const leaseRole = clean(lease?.employeeRole) ?? clean(lease?.role)
    if (leaseRole !== null) {
      // 租约上恰好带着岗位时不必多读一次——但它只是**回落**，不是主来源。
      return resolveModelProfileRef({ get, scope: lease?.scope, role: leaseRole })
    }

    const taskId = clean(lease?.taskId)
    if (taskId === null) {
      return Object.freeze({
        ok: false, code: MODEL_PROFILE_CODES.ROLE_REQUIRED,
        message: '租约上没有 taskId，也没有岗位：读不出这次 Attempt 是哪个岗位在干活，' +
          '而"用哪个模型"正是按岗位定的',
        modelProfileRef: null, chainRole: null, retryable: false,
      })
    }

    let res
    try {
      res = await get(`/api/task?id=${encodeURIComponent(taskId)}`)
    } catch (e) {
      return Object.freeze({
        ok: false, code: MODEL_PROFILE_CODES.UNREACHABLE,
        message: `读任务 ${taskId} 失败：${e?.message ?? e}`, modelProfileRef: null, chainRole: null, retryable: true,
      })
    }
    if ((res?.status ?? 0) !== 200) {
      return Object.freeze({
        ok: false, code: MODEL_PROFILE_CODES.UNREACHABLE,
        message: `读任务 ${taskId} 返回 HTTP ${res?.status ?? 0}（${res?.body?.code ?? '无码'}）`,
        modelProfileRef: null, chainRole: null, retryable: (res?.status ?? 0) >= 500,
      })
    }
    const role = clean(res?.body?.role)
    if (role === null) {
      return Object.freeze({
        ok: false, code: MODEL_PROFILE_CODES.ROLE_REQUIRED,
        message: `任务 ${taskId} 上没有岗位（role）：没有岗位就没有"该用哪个模型"的主语。` +
          '**不回落到平台默认**——那会用上一个没人给这个岗位选过的模型',
        modelProfileRef: null, chainRole: null, retryable: false,
      })
    }
    return resolveModelProfileRef({ get, scope: lease?.scope, role })
  }
}
