// product/launcher/first-run.mjs
// ============================================================================
// PRT-707（接线批）：把首次运行向导接到**真实**的 `init.mjs` / `launcher.mjs` /
// `security/secrets` 上。
//
// ## 这一批补的是什么
//
// `wizard.mjs` 早就交付了六步状态机、40 条用例、以及三条纪律（不许拿"每步都返回 ok"
// 冒充"产品可用"、需要输入的那一步必须真的挡住、断点续跑）。但它的六个动作
// **全部是注入的空值**——`checkEnvironment = null`、`initialize = null`、`start = null`…
//
//   > 一个"六步都对、但没有一步真的连着东西"的向导，
//   > 与一个"只有六个按钮"的界面，在用户第一次运行的时候是同一个东西——
//   > 只不过前者的用例是绿的。
//
// 本模块给出那六个动作的真实实现，并把它们装配成一个可直接 `run()` 的向导。
//
// ## 三条在本模块里真正要紧的判断
//
// ### ① 环境检查必须探测**存在的最近祖先**，不能直接探测目标目录
//
// `environment` 跑在 `initialize` **之前**。在一台干净的机器上 `DataDir` 还不存在，
// 而"对还不存在的目录做可写探测"必然失败——于是这条检查会在**唯一需要它的那一次**
// 报"环境不满足"。
//
//   > 一个"对还不存在的目录做可写探测"的环境检查，
//   > 与一个"环境不满足"的判定，在第一次运行那台干净机器上是同一个东西——
//   > 只不过前者会在唯一需要它的那一次，把一个正常的机器判成不满足。
//
// 所以向上找到最近一个**存在**的目录去探测：那条路径能不能被创建，才是它要说的事。
//
// ### ② `isModelConfigured` 必须**同时**确认档案与密钥
//
// 向导只在它返回**恰好 `true`** 时才允许跳过"配置模型"那一步（那条纪律写在
// `wizard.mjs` 里，理由很硬：跳过之后 `verify` 会失败，而用户此时**已经没有任何
// 地方可以填密钥了**）。
//
// 于是这里的判定必须是"档案能解析出来"**且**"档案指向的那个 `secretRef`
// 真的在密钥库里"。只看档案会得到一个很坏的形态：档案在、密钥不在——
// 界面显示已配置，运行时取不到明文，而向导已经跳过了唯一的录入入口。
//
//   > 一个"只看档案在不在"的已配置判定，
//   > 与一个"档案和密钥都在"的判定，在档案和密钥成对写入时是同一个东西——
//   > 只不过前者会在密钥被单独删掉/拷到别的机器之后，让用户无路可走。
//
// ### ③ 写入顺序：先密钥，后档案
//
// 两个写入都可以失败，中间态不可避免。选顺序的标准是**中间态长什么样**：
//
//   · 先密钥后档案 → 失败在档案那一步时，中间态是一个"没人引用的密钥"
//     （看不见、无害、重试即覆盖）。
//   · 先档案后密钥 → 失败在密钥那一步时，中间态是一份**指向空处的档案**。
//     它会在界面上显示成"已配置"，`/api/model-bindings/resolve` 也会成功返回，
//     而 §② 的判定会说不算——于是两个地方对同一件事给出不同答案。
//
//   > 一个"密钥写了、档案没写"的中间态，与一个"档案写了、密钥没写"的中间态，
//   > 在重试一次之后都会消失——只不过后者在那之前会让产品声称模型已经配好了。
//
// ## 依赖注入的边界
//
// 本目录被 `scripts/ci/dsh-boundary.mjs` 判为 **must-be-zero**：不得出现任何
// DSH 执行面记号。所以这里**不** import 任何 DSH 包——hub 客户端、密钥库、
// 布局解析全部以依赖形式拿进来（缺省实现是真实的那些模块）。
// ============================================================================

import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import { initializeProductDir, probeWritable } from '../init.mjs'
import { productStateOf, startResultIsBlocking } from './launcher.mjs'
import { createWizard } from './wizard.mjs'

export const FIRST_RUN_VERSION = 'legion/first-run@1'

/**
 * 本模块自己的诊断码。**不复用向导的码**：向导说的是"六步的结论"，
 * 这里说的是"接线这一层看到了什么"，混在一起就没法从一条码反推出该看哪儿。
 *
 * 只列**真的有产出方**的。第一版还写了 `NO_LAYOUT` / `NO_HUB` /
 * `BAD_MODEL_INPUT` / `NO_ENVIRONMENT_PROBE` 四个——它们一次都没被引用过：
 * 前提不成立时走的是 `firstRunPreconditions` 的 `key`（`layout`/`hub`/`secrets`），
 * 输入非法时走的是 `message`。
 *
 *   > 一个导出但永远不会产生的诊断码，
 *   > 与一个"这条路径已经被覆盖了"的宣告，在读代码的时候是同一个东西——
 *   > 只不过运维会照着它去 grep 日志，然后什么也找不到。
 */
export const FIRST_RUN_CODES = Object.freeze({
  SECRETS_UNAVAILABLE: 'FIRST_RUN_SECRETS_UNAVAILABLE',
  SECRET_WRITE_FAILED: 'FIRST_RUN_SECRET_WRITE_FAILED',
  PROFILE_WRITE_FAILED: 'FIRST_RUN_PROFILE_WRITE_FAILED',
  BINDING_WRITE_FAILED: 'FIRST_RUN_BINDING_WRITE_FAILED',
})

/** 密钥库里模型密钥的名字空间。与 `security/secrets/ref.mjs` 的 `legion/` 一致。 */
export const MODEL_SECRET_PREFIX = 'legion/model/'

/** 首次运行建的档案 id。用户可以后来改名，但第一次要有一个确定的名字。 */
export const DEFAULT_MODEL_PROFILE_ID = 'default'

/**
 * 支持的最低 Node 主版本。
 *
 * 定在 22 而不是"能跑就行"：`node:sqlite` 的 `DatabaseSync` 在 22 才可用，
 * 而 team-hub 的库就是它。低版本上的表现不是"报一个清晰的错"，
 * 而是 `import 'node:sqlite'` 直接失败——那个错离"你的 Node 太旧了"很远。
 */
export const MIN_NODE_MAJOR = 22

/** 一个档案 id 对应的密钥库引用。 */
export function modelSecretRefFor(profileId) {
  const id = String(profileId ?? '').trim()
  if (id === '') throw new TypeError('modelSecretRefFor 需要 profileId')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new TypeError(`档案 id 只能是 [A-Za-z0-9._-]，且以字母数字开头：收到 ${JSON.stringify(profileId)}`)
  }
  return `${MODEL_SECRET_PREFIX}${id}`
}

/**
 * 向上找最近一个**存在**的目录（含自身）。都不存在时返回 null。
 *
 * 存在的理由见文件头 §①：`environment` 跑在 `initialize` 之前，
 * 目标目录此时**本来就不该存在**。
 */
export function nearestExistingDir(dir, { exists = existsSync, maxHops = 64 } = {}) {
  if (typeof dir !== 'string' || dir === '') return null
  let cur = dir
  for (let i = 0; i < maxHops; i += 1) {
    if (exists(cur)) return cur
    const up = dirname(cur)
    if (up === cur) return null
    cur = up
  }
  return null
}

/**
 * 真实的环境探测：Node 版本 + 目录可写性（探测**存在的最近祖先**）。
 *
 * 返回 `{ok, message, nodeMajor, unwritable[]}`。`ok` 为 `false` 时 `message`
 * 要说清**是哪一条**不满足——"环境不满足"这句本身没有下一步。
 */
export function probeEnvironment({
  layout,
  nodeMajor = Number(String(process.versions?.node ?? '0').split('.')[0]),
  minNodeMajor = MIN_NODE_MAJOR,
  dirs = null,
  exists = existsSync,
  probe = probeWritable,
} = {}) {
  const targets = dirs ?? [layout?.dataDir, layout?.logDir, layout?.cacheDir]
    .filter((d) => typeof d === 'string' && d !== '')
  // 去重：三个目录常常共用同一个祖先，报三遍同一件事会让"三个问题"的错觉。
  const seen = new Set()
  const unwritable = []
  for (const dir of targets) {
    const probeDir = nearestExistingDir(dir, { exists })
    if (probeDir === null) {
      unwritable.push({ dir, probeDir: null, message: `${dir} 及其所有祖先目录都不存在，无法判断可写性` })
      continue
    }
    if (seen.has(probeDir)) continue
    seen.add(probeDir)
    const r = probe(probeDir)
    if (r?.writable !== true) unwritable.push({ dir, probeDir, message: r?.message ?? `${probeDir} 不可写` })
  }
  const parts = []
  if (!(nodeMajor >= minNodeMajor)) {
    parts.push(`Node 版本过低：需要 ${minNodeMajor} 或更高（当前 ${process.versions?.node ?? '未知'}）`
      + '；team-hub 的库用 node:sqlite，低版本上它的报错离"Node 太旧"很远')
  }
  if (unwritable.length > 0) parts.push(...unwritable.map((u) => u.message))
  return Object.freeze({
    ok: parts.length === 0,
    message: parts.length === 0 ? '运行环境满足要求' : parts.join('；'),
    nodeMajor,
    unwritable: Object.freeze(unwritable),
  })
}

/**
 * 首次运行的前提。**在向导第一步之前**判定（见 `wizard.mjs` 的 `preconditions`）。
 *
 * 只列三类"在后面某一步会以另一个面孔出现"的问题：
 *
 *   · **布局未定** → 后面不知道密钥库、日志、数据目录在哪，报出来的会是别的东西。
 *   · **没有 hub**（地址或令牌缺一个）→ `configure-model` 写不进模型档案，
 *     而用户会在 `verify` 看到"模型没有通过解析"，于是去查自己本来没错的 key。
 *   · **密钥库打不开/不受保护** → 同上，用户的 key 会被拒在一个看不出原因的地方。
 *
 * 故意**不**把"Node 太旧""目录不可写"放进来：那两条正是 `environment` 那一步
 * 要说的事，提前在这里报会让第一步永远显示"没跑过"。
 */
export function firstRunPreconditions({
  layout = null,
  layoutDiagnostics = [],
  hubUrl = null,
  hubToken = null,
  secrets = null,
} = {}) {
  const unmet = []
  const blocking = (Array.isArray(layoutDiagnostics) ? layoutDiagnostics : [])
    .filter((d) => d?.severity === 'error')
  if (layout === null || layout === undefined || blocking.length > 0) {
    unmet.push({
      key: 'layout',
      message: '产品目录布局未确定'
        + (blocking.length > 0 ? `（${blocking.map((d) => d.code ?? '未知').join('、')}）` : '')
        + '：不知道数据目录与密钥库在哪，后面的步骤报出来的会是别的东西',
    })
  }
  const hasUrl = typeof hubUrl === 'string' && hubUrl.trim() !== ''
  const hasToken = typeof hubToken === 'string' && hubToken.trim() !== ''
  if (!hasUrl || !hasToken) {
    const which = !hasUrl && !hasToken ? '地址与令牌都没有'
      : (!hasUrl ? '没有地址' : '没有令牌')
    unmet.push({
      key: 'hub',
      message: `team-hub ${which}：模型档案要写进 hub，缺它时你的密钥会在后面被报成"模型不可用"`
        + '（而密钥本身是对的）',
    })
  }
  // `secrets` 为 null = 没探测过（尚未接线）；明确说"没探测"而不是当成通过。
  if (secrets !== null && secrets !== undefined && secrets.ok !== true) {
    unmet.push({
      key: 'secrets',
      message: `密钥库不可用（${secrets.code ?? '未知'}）：${secrets.message ?? '没有说明'}`,
    })
  }
  return Object.freeze({
    ok: unmet.length === 0,
    unmet: Object.freeze(unmet.map((u) => Object.freeze(u))),
  })
}

/**
 * 装配首次运行向导。
 *
 * 所有外部效果都可注入；缺省是**真实实现**。默认参数只覆盖"能安全默认"的那些：
 * 需要用户/部署提供的东西（布局、hub 地址与令牌、密钥库、launcher）一律要求显式传入——
 * 缺省成空值会让"没接线"看起来像"接线了"。
 */
export function createFirstRun({
  layout,
  layoutDiagnostics = [],
  hubUrl = null,
  hubToken = null,
  /** `{ read(path), call(path, body) }`。缺省为 null；必须显式给。 */
  hub = null,
  /**
   * **附加**前提（叠加在内置的布局/hub/密钥库三条之上，不替换它们）。
   *
   * 部署方要加自己的一条（例如"许可证已接受"）时用它。返回 `{ok, unmet}` 或
   * 直接返回 `[{key,message}]` 都认；抛错算不成立。
   */
  extraPreconditions = null,
  /** `async () => openProductSecrets(...)` 的产物。必须显式给（密钥库要显式打开）。 */
  openSecrets = null,
  /** 缺省 `initializeProductDir`。 */
  initializeImpl = null,
  /** `async () => launcher`。必须显式给（拉进程是最重的副作用，不该有默认）。 */
  launcherFactory = null,
  /** 缺省 `probeEnvironment`。 */
  environmentProbe = null,
  /** 模型档案所属的 scope / role。绑定是 (scope, role) 二元的。 */
  scope = 'default',
  role = 'worker',
  profileId = DEFAULT_MODEL_PROFILE_ID,
  /** 档案的 provider / runtimeType；`runtimeType` 不许猜，所以由调用方给。 */
  provider = null,
  runtimeType = null,
  endpoint = null,
  displayName = null,
  productVersion = null,
  /** hub 写操作的 actor（审计要）。 */
  actor = 'first-run-wizard',
  stateFile = null,
  fs = null,
  now = () => Date.now(),
  logger = null,
} = {}) {
  if (typeof hub !== 'object' || hub === null
    || typeof hub.read !== 'function' || typeof hub.call !== 'function' || typeof hub.patch !== 'function') {
    // `patch` 也要求：重跑向导是**正常路径**，那时档案已存在、必须走更新端点。
    // 少它的后果不是"重跑报错"那么清楚——是"重跑时档案悄悄停在旧值"。
    throw new TypeError('createFirstRun 需要 hub（{ read, call, patch }）：模型档案与绑定都要写进 hub，重跑要走更新端点')
  }
  if (typeof openSecrets !== 'function') {
    throw new TypeError('createFirstRun 需要 openSecrets：模型密钥要写进密钥库，没有它就无处可写')
  }
  const secretRef = modelSecretRefFor(profileId)

  /** 打开密钥库并缓存；`invalidate()` 供轮换后重开。 */
  let opened = null
  async function ensureSecrets() {
    if (opened !== null) return opened
    let r = null
    try {
      r = await openSecrets()
    } catch (e) {
      // 打开密钥库抛错**不算能写**：一个"打不开就当空库"的实现会把密钥写丢。
      r = { ok: false, code: FIRST_RUN_CODES.SECRETS_UNAVAILABLE, message: `打开密钥库时出错：${String(e?.message ?? e)}` }
    }
    if (r === null || r === undefined || r.ok !== true || r.store === null || r.store === undefined) {
      opened = {
        ok: false,
        code: r?.code ?? FIRST_RUN_CODES.SECRETS_UNAVAILABLE,
        message: r?.message ?? '打开密钥库没有给出可用的存储',
      }
      return opened
    }
    opened = { ok: true, store: r.store, path: r.path ?? null }
    return opened
  }

  // ── 六个动作的真实实现 ────────────────────────────────────────────────────

  async function checkEnvironment() {
    const r = await (environmentProbe ?? (() => probeEnvironment({ layout })))()
    if (r === null || r === undefined || typeof r.ok !== 'boolean') {
      return { ok: false, message: '环境探测没有给出可判读的结果（要 `{ok, message}`）' }
    }
    return { ok: r.ok === true, message: r.message ?? (r.ok === true ? '运行环境满足要求' : '运行环境不满足要求') }
  }

  async function initialize() {
    const run = initializeImpl ?? initializeProductDir
    const r = run(layout, { productVersion })
    if (r?.ok !== true) {
      const errs = (r?.diagnostics ?? []).filter((d) => d?.severity === 'error')
      return {
        ok: false,
        message: `初始化未完成（${r?.phase ?? '未知阶段'}）：`
          + (errs.length > 0 ? errs.map((d) => d.message).join('；') : '没有给出原因'),
      }
    }
    // 幂等：已经建好的目录会被跳过，这不等于"什么都没做"，要如实说。
    const made = Array.isArray(r.created) ? r.created.length : 0
    const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0
    return {
      ok: true,
      message: made === 0 && skipped > 0
        ? `产品目录已经就绪（${skipped} 项已存在，无需重建）`
        : `已建立 ${made} 个目录`,
    }
  }

  async function start() {
    const L = await launcherFactory()
    if (L === null || L === undefined || typeof L.start !== 'function') {
      return { ok: false, message: '没有可用的启动器：拿不到 start()，无法启动组件' }
    }
    const r = await L.start()
    // ★ 用 launcher 自己的判据，不自己看 `ok`：`ok:false` 但 `phase:null` 的形态
    // 是"部分起来了、还能用"，把它当失败会让向导停在一步本来已经过去了的地方。
    if (startResultIsBlocking(r) === true) {
      const errs = (r?.diagnostics ?? []).filter((d) => d?.severity === 'error')
      return {
        ok: false,
        message: `组件没有启动成功（${r?.phase ?? '未知阶段'}）：`
          + (errs.length > 0 ? errs.map((d) => d.message).join('；') : '没有给出原因'),
      }
    }
    return { ok: true, message: '组件已启动并就绪' }
  }

  /**
   * 把用户给的模型配置落下来：**先密钥，后档案，最后绑定**（理由见文件头 §③）。
   */
  async function submitModelConfig(value) {
    const v = value === null || value === undefined ? {} : value
    const apiKey = typeof v.apiKey === 'string' ? v.apiKey.trim() : ''
    const model = typeof v.model === 'string' && v.model.trim() !== '' ? v.model.trim() : null
    if (apiKey === '') {
      return { ok: false, message: '缺少模型密钥' }
    }
    if (model === null) {
      return { ok: false, message: '缺少模型名（`model`）：只写密钥进库，产品仍然不知道该用哪个模型' }
    }
    const providerName = (typeof v.provider === 'string' && v.provider.trim() !== '' ? v.provider.trim() : provider)
    const rt = (typeof v.runtimeType === 'string' && v.runtimeType.trim() !== '' ? v.runtimeType.trim() : runtimeType)
    if (typeof providerName !== 'string' || providerName === '') {
      return { ok: false, message: '缺少 provider：协议不同会让请求以错误的形态发出去，所以不猜' }
    }
    if (typeof rt !== 'string' || rt === '') {
      return { ok: false, message: '缺少 runtimeType：它与 provider 不是同一件事，猜错会让档案看起来配好了直到第一次运行' }
    }
    const ep = (typeof v.endpoint === 'string' && v.endpoint.trim() !== '' ? v.endpoint.trim() : endpoint)

    // ① 密钥
    const store = await ensureSecrets()
    if (store.ok !== true) {
      return { ok: false, code: FIRST_RUN_CODES.SECRETS_UNAVAILABLE, message: store.message }
    }
    try {
      await store.store.put(secretRef, apiKey, { purpose: `model:${profileId}` })
    } catch (e) {
      return {
        ok: false,
        code: FIRST_RUN_CODES.SECRET_WRITE_FAILED,
        message: `密钥没有写成：${String(e?.message ?? e)}`,
      }
    }

    // ② 档案。已存在时**改成新的**而不是失败——重跑向导是正常路径。
    const profile = {
      id: profileId,
      displayName: displayName ?? `${providerName}/${model}`,
      provider: providerName,
      model,
      runtimeType: rt,
      endpoint: ep ?? null,
      secretRef,
    }
    let created = null
    try {
      created = await hub.call('/api/model-profiles', { profile, actor })
    } catch (e) {
      if (e?.status !== 409) {
        return {
          ok: false,
          code: FIRST_RUN_CODES.PROFILE_WRITE_FAILED,
          message: `模型档案没有写成：${String(e?.message ?? e)}`,
        }
      }
      created = null
    }
    if (created === null) {
      // 409 = 已经有一份同 id 的档案。走 PATCH（乐观锁要 `version`，它在 body 顶层）。
      //
      // ★ 用 `patch` 而不是 `call`：`call` 发的是 POST，而更新端点是 PATCH。
      // 打错的后果不是 405 那么清楚——它会落到别的路由上，报出一个与
      // "要改档案"毫无关系的错。
      try {
        const existing = await hub.read(`/api/model-profiles/${encodeURIComponent(profileId)}`)
        const version = existing?.profile?.version ?? null
        if (version === null) {
          return {
            ok: false,
            code: FIRST_RUN_CODES.PROFILE_WRITE_FAILED,
            message: `档案 ${profileId} 已存在，但读不到它的 version，无法安全改写`,
          }
        }
        await hub.patch(`/api/model-profiles/${encodeURIComponent(profileId)}`, {
          profile: { ...profile, version }, actor, version,
        })
      } catch (e) {
        return {
          ok: false,
          code: FIRST_RUN_CODES.PROFILE_WRITE_FAILED,
          message: `模型档案没有改写成：${String(e?.message ?? e)}`,
        }
      }
    }

    // ③ 绑定：没有绑定，`resolve(scope, role)` 会 404，而"没有绑定"与"没有可用模型"
    //    在下游看起来一样——后者要人建档案，前者要人建绑定，两件事。
    //
    //    字段名是 hub 的契约：`employeeRole` / `primaryProfile`（**不是** role/profileId）。
    try {
      await hub.call('/api/model-bindings', {
        scope, employeeRole: role, primaryProfile: profileId, fallbackProfiles: [], actor,
      })
    } catch (e) {
      return {
        ok: false,
        code: FIRST_RUN_CODES.BINDING_WRITE_FAILED,
        message: `模型绑定没有写成（档案已在，但岗位没指向它）：${String(e?.message ?? e)}`,
      }
    }
    return { ok: true, message: `模型已配置：${providerName}/${model}（密钥存进密钥库，未写进配置文件）` }
  }

  /**
   * 该检查哪个档案：绑定指向的那个优先，否则是向导自己要建的那个。
   *
   * 绑定优先的理由：用户可能早就配过别的档，那时再问一遍密钥是没必要的打扰。
   */
  async function configuredProfileId() {
    try {
      const r = await hub.read(
        `/api/model-bindings/resolve?scope=${encodeURIComponent(scope)}&role=${encodeURIComponent(role)}`,
      )
      const res = r?.resolution ?? null
      if (res !== null && res !== undefined && res.ok === true) {
        const id = res.primaryProfile ?? res.chain?.[0]?.id ?? null
        if (typeof id === 'string' && id !== '') return id
      }
    } catch { /* 没有绑定 / 解析失败 → 用向导自己的档案 id */ }
    return profileId
  }

  /**
   * 档案**且**密钥都在，才返回 `true`。理由见文件头 §②。
   *
   * ★ **密钥引用是算出来的，不是读出来的。** hub 的单条档案读取
   * （`GET /api/model-profiles/<id>`）返回的是 descriptor，它**有意不含**
   * `secretRef`——`model-store.mjs` 的文件头写着理由：引用名本身是可枚举的
   * 攻击面，"知道引用名就离猜到密钥库里的条目更近一步"。
   *
   * 于是这里走的是另一条路：档案 id → `modelSecretRefFor(id)` → 问密钥库
   * `has()`。这不但绕开了那个（正确的）信息隐藏，还比读回来更强——
   * 它检验的正是"引用名确实按命名约定生成"这件事。
   *
   *   > 一个"从 API 读回 secretRef 再去库里查"的实现，
   *   > 与一个"按约定算出 secretRef 再去库里查"的实现，
   *   > 在库是按约定写入时是同一个东西——只不过前者在 API 决定不再暴露
   *   > 这个字段的那一天，会静默地永远返回 false（于是每次都要重配密钥），
   *   > 或者更坏：永远返回 true。
   *
   * 任何异常一律 `false`：这个函数的唯一作用是"要不要跳过唯一的密钥录入入口"，
   * 而"判断出错"绝不该导致跳过。
   */
  async function isModelConfigured() {
    const id = await configuredProfileId()
    // 档案在不在：读不到（404/抛错）一律算不在。
    try {
      const r = await hub.read(`/api/model-profiles/${encodeURIComponent(id)}`)
      if (r?.ok !== true || r?.profile === null || r?.profile === undefined) return false
    } catch {
      return false
    }
    // 密钥在不在。`modelSecretRefFor` 对非法 id 会抛——那也算"不算配置好"。
    let ref = null
    try {
      ref = modelSecretRefFor(id)
    } catch {
      return false
    }
    const store = await ensureSecrets()
    if (store.ok !== true) return false
    try {
      return (await store.store.has(ref)) === true
    } catch {
      return false
    }
  }

  /**
   * **独立观测**——不是汇总前面几步的返回值。
   *
   * `runtimeState` 取自 launcher 的真实状态（不是"start() 返回了 ok"），
   * `modelResolved` 取自已配置判定（不是"submitModelConfig 返回了 ok"）。
   */
  async function observe() {
    let state = null
    let detail = null
    try {
      const L = await launcherFactory()
      const st = L?.status?.() ?? null
      state = st?.state ?? null
      detail = st?.stateText ?? null
    } catch (e) {
      return { runtimeState: null, modelResolved: false, detail: `读取产品状态时出错：${String(e?.message ?? e)}` }
    }
    const modelResolved = await isModelConfigured()
    return { runtimeState: state, modelResolved, detail }
  }

  /** 前提：每次 `run()` 重算，且顺带把密钥库打开一次（结论会被 §② 复用）。 */
  async function preconditionsFn() {
    const secrets = await ensureSecrets()
    const builtin = firstRunPreconditions({
      layout, layoutDiagnostics, hubUrl, hubToken,
      secrets: secrets.ok === true ? secrets : { ok: false, code: secrets.code, message: secrets.message },
    })
    if (extraPreconditions === null || extraPreconditions === undefined) return builtin
    // ★ 附加前提**叠加**在内置之上，不是替换。
    //
    // 换掉的话，一个为了加"许可证已接受"这一条而传进来的前提函数，会**顺手**
    // 把布局/hub/密钥库三条检查全删掉——而它看起来只是"多了一条"。
    //
    //   > 一个"附加前提替换掉内置前提"的接口，
    //   > 与一个"附加前提叠加在内置之上"的接口，
    //   > 在调用方只想多加一条的时候是同一个东西——
    //   > 只不过前者会让那次改动同时删掉三条没人打算删的检查。
    let raw = null
    try {
      raw = typeof extraPreconditions === 'function' ? await extraPreconditions() : extraPreconditions
    } catch (e) {
      return Object.freeze({
        ok: false,
        unmet: Object.freeze([...builtin.unmet, Object.freeze({
          key: 'extra-precondition-error',
          message: `附加前提判断出错，按不成立处理：${String(e?.message ?? e)}`,
        })]),
      })
    }
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.unmet) ? raw.unmet : [])
    const extra = list.filter((u) => u !== null && u !== undefined).map((u) => Object.freeze({
      key: typeof u?.key === 'string' && u.key !== '' ? u.key : 'unnamed',
      message: typeof u?.message === 'string' && u.message !== '' ? u.message : '附加前提不成立（没有说明）',
    }))
    const unmet = [...builtin.unmet, ...extra]
    return Object.freeze({ ok: unmet.length === 0, unmet: Object.freeze(unmet) })
  }

  const wizard = createWizard({
    checkEnvironment,
    initialize,
    start,
    submitModelConfig,
    isModelConfigured,
    observe,
    preconditions: preconditionsFn,
    stateFile,
    fs,
    now,
    logger,
  })

  return Object.freeze({
    version: FIRST_RUN_VERSION,
    wizard,
    secretRef,
    profileId,
    scope,
    role,
    // 单独导出让运维/界面能在不走向导的情况下问同一批问题（与 wizard 内用的是同一份实现，
    // 不是复制品——复制品会在其中一处被改的那天开始漂移）。
    checkEnvironment,
    initialize,
    start,
    submitModelConfig,
    isModelConfigured,
    observe,
    preconditions: preconditionsFn,
    /** 密钥库换过之后（轮换）让缓存失效。 */
    invalidateSecrets() { opened = null },
    /** 产品态（供界面展示，与 observation 同源）。 */
    productState(processes, needsAttention = [], opts = {}) {
      return productStateOf(processes, needsAttention, opts)
    },
  })
}
