// team-hub/runtime-credential.mjs
// ============================================================================
// **运行侧（DSH）到底有没有这把钥匙** —— 面板那句"已配置凭证"缺的另一半。
//
// ## 为什么需要它（一次被追问出来的"名不副实"）
//
// 2026-10-12，将军看着「凭证库」页签问："凭证库又是干嘛的"。
// 查完的读数是：Legion 的库**有真实的活**（测试连接、状态），但它**不是运行时钥匙的来源**：
//
//   · 派工那条路只传 `agentOptions: { provider, model }` —— 一个凭证字段都没有；
//   · 真正让 agent 跑起来的钥匙来自 **DSH 自己的** `$DSH_HOME/.credentials.yaml`；
//   · Legion → DSH 的那条写路径（物化）**门是关的**（`LEGION_APPLY_MODEL_CONFIG` 默认 false）。
//
// 于是同一把 `FJD_DS_API_KEY` **在两处各存了一份**，而界面上完全没有一句话说这件事。
// 后果是一个具体的陷阱：往 Legion 里录一把 DSH 没有的钥匙，面板会说"已配置凭证"、
// 连"测试连接"都可能通过（它读 Legion 的库），**而任务跑不起来**。
//
//   > 一个"我这边的库里有"的读数，
//   > 与一个"跑起来真的能用"的读数，在界面上说的是同一句话 ——
//   > 而它们的修法是完全不同的两件事。
//
// ## 为什么这一层能**精确**回答，而不是"猜一个近似"
//
// 因为 DSH 自己的凭证分层是**写在它源码里的四层**（`credentials-local/src/index.ts` 的模块头）：
//
//     宿主环境（继承来的，只读，**赢**）
//     > $DSH_HOME/.credentials.yaml      （provider 管理、可写）
//     > <启动目录>/.env                  （只读回退）
//     > $DSH_HOME/.env                   （只读回退）
//
// 而 Legion 的中枢进程是**由宿主拉起的、带着 `{...process.env}`**（见
// `services-plugin/config-schema.mjs` 的 notes），所以它能拿到**同一个**宿主环境；
// 它也能读**同一个**文件。前两层与第四层因此可以逐一复现，不是近似。
//
// ## ★ 没查的那一层必须说出来（而不是含糊成"没有"）
//
// **第三层 `<启动目录>/.env` 查不了**：那是 DSH **进程的 cwd**，而中枢的 cwd 是另一个目录。
// 所以本模块给出的每一种结论都**逐字写明查了哪两层**，并且 `absent` 的措辞是
// "**这两处**都没有"，不是"DSH 没有" —— 后者在我们没查过第三层时是一句假话。
//
//   本仓对这件事有明确先例：`credential-status.mjs` 的纪律 ①「读不出来 ≠ 没有」。
//   这里多一条同族的：**"我没查那一层"也不能说成"那一层没有"。**
//
// ## 三值，不是布尔
//
// `present` / `absent` / `unknown`。读失败（文件打不开、格式坏）是 `unknown`，
// **绝不是** `absent`：把"我不知道"渲染成"没有"会让用户去补一把其实就在那儿的钥匙。
// `not-needed` 给"这条本来就不要凭证"（本地模型合法）。
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'

/** 运行侧钥匙的状态。`not-needed` = 这个条目本来就不要凭证。 */
export const RUNTIME_KEY_STATES = Object.freeze(['not-needed', 'present', 'absent', 'unknown'])

/** 查过哪两层（进 `detail`，让用户知道这个结论的边界）。 */
export const RUNTIME_KEY_LAYERS = Object.freeze([
  '宿主环境变量',
  'DSH 凭证文件（$DSH_HOME/.credentials.yaml）',
])

/** 本模块**没有查**的那一层。它进 `detail`，因为它决定了 `absent` 这句话的强度。 */
export const RUNTIME_KEY_UNCHECKED = 'DSH 启动目录的 .env'

/**
 * 纯分类：**给定一份读好的两层读数**，判断某个引用名在运行侧有没有。
 *
 * 抽成纯函数与 `credential-status.mjs` 的 `classifyCredential` 同一个理由：
 * "读失败不许说成没有"这条要能被**直接**验，而不必在一台真的读不到文件的机器上制造失败。
 *
 * @param {string|null|undefined} ref 引用名（`null`/空 = 这个条目不要凭证）
 * @param {{ok: boolean, env?: Set<string>, fileRefs?: Set<string>, reason?: string}|null} reading 两层读数
 */
export function classifyRuntimeKey(ref, reading) {
  const cleanRef = typeof ref === 'string' && ref.trim() !== '' ? ref.trim() : null
  if (cleanRef === null) {
    return Object.freeze({
      state: 'not-needed',
      layer: null,
      detail: '这个条目没有配置凭证引用（不需要鉴权的模型是合法的）',
    })
  }
  if (reading === null || reading === undefined || reading.ok !== true) {
    const why = typeof reading?.reason === 'string' && reading.reason !== '' ? `：${reading.reason}` : ''
    return Object.freeze({
      state: 'unknown',
      layer: null,
      detail: `没读到运行侧的凭证来源（${RUNTIME_KEY_LAYERS.join(' / ')}），因此**无法判断** `
        + `DSH 有没有这把钥匙（这不等于"没有"）${why}`,
    })
  }
  if (reading.env instanceof Set && reading.env.has(cleanRef)) {
    return Object.freeze({
      state: 'present',
      layer: '宿主环境变量',
      detail: 'DSH 自己会先看继承来的宿主环境，而那里有这个引用 —— 运行时能用上它',
    })
  }
  if (reading.fileRefs instanceof Set && reading.fileRefs.has(cleanRef)) {
    return Object.freeze({
      state: 'present',
      layer: 'DSH 凭证文件',
      detail: 'DSH 凭证文件（$DSH_HOME/.credentials.yaml）里有这个引用 —— 运行时能用上它'
        // ★ 路径若是**按默认推出来的**（宿主环境没设 `DSH_HOME`），必须说出来：
        //   否则用户会以为我们查的是他设的那个位置。
        + (reading.homeSource === 'default' ? '（这个位置是按 DSH 的默认 `~/.dsh` 推出来的：宿主环境里没有 `DSH_HOME`）' : ''),
    })
  }
  return Object.freeze({
    state: 'absent',
    // ★ 措辞要精确到"查了哪两层"。写成"DSH 没有这把钥匙"是**我们没有资格说**的话：
    //   第三层（DSH 启动目录的 .env）我们没查，而它确实能供一把钥匙。
    layer: null,
    detail: `运行侧**这两处**都没有找到它：${RUNTIME_KEY_LAYERS.join(' / ')}。`
      + (reading.homeSource === 'default' ? '（凭证文件的位置是按 DSH 的默认 `~/.dsh` 推出来的：宿主环境里没有 `DSH_HOME`。）' : '')
      + `（没有查 ${RUNTIME_KEY_UNCHECKED} —— 那是 DSH 进程的 cwd，中枢看不到。）`
      + '物化（LEGION_APPLY_MODEL_CONFIG）没开时，Legion 这边的值**不会**自动送过去，'
      + '因此这条现在很可能跑不起来。',
  })
}

/** 状态 → 一句话（面板与诊断共用同一份口径，避免两处各写一遍）。 */
export const RUNTIME_KEY_STATE_TEXT = Object.freeze({
  'not-needed': '无需凭证',
  present: '运行侧有这把钥匙',
  absent: '运行侧没找到这把钥匙',
  unknown: '无法核验运行侧',
})

/**
 * 读 `$DSH_HOME/.credentials.yaml` 里的引用名。**只读名字，不读值。**
 *
 * 解析交给 `security/secrets/dsh-credentials.mjs`（那份格式的唯一实现）。
 * 它抛错/读不出来 ⇒ `{ ok: false }`，由 `classifyRuntimeKey` 变成 `unknown`
 * —— **绝不**降级成"空集"（空集会被读成"一个都没有"）。
 */
function readDshCredentialRefs(file, source) {
  if (typeof file !== 'string' || file === '') {
    return {
      ok: false,
      reason: '不知道 DSH 的凭证文件在哪（`DSH_HOME` 没设，且拿不到操作系统家目录，因此连默认位置也推不出来）',
    }
  }
  if (!existsSync(file)) {
    // ★ 「文件不存在」是一个**确定**的读数，不是失败：一台从没用过 DSH
    //   Models 页的机器就是这个形状（`dsh-credentials.mjs` 的 `load()` 同一条口径）。
    //   ⚠ 但"文件不存在"与"路径推错了"在这里长得一样 —— 所以 `source` 要一路带出去，
    //   界面才能说"我们按默认位置找的"。
    return { ok: true, refs: new Set(), source }
  }
  try {
    const text = readFileSync(file, 'utf8')
    // 延后 import：本模块被中枢的**路由**加载，而路由在启动路径上；
    // 让一个纯解析模块拖慢启动没有意义（与 `probe-service.mjs` 的软取同一做法）。
    const { parseDshCredentialsDocument } = parseModule
    const doc = parseDshCredentialsDocument(text)
    const refs = new Set()
    // `refs` 是 POSIX 标识符 → 值的映射；供应商的 `secretRef` 用的就是这一套命名。
    for (const key of doc?.refs?.keys?.() ?? []) refs.add(key)
    // `records` 是 `<scope>/<id>` 形态。它**不是**供应商引用的形状（那边不许带斜杠），
    // 但一起收进来不会有假阳性：两者名字空间不重叠（`parseCredentialKey` 的语法）。
    for (const key of doc?.records?.keys?.() ?? []) refs.add(key)
    return { ok: true, refs, source }
  } catch (e) {
    // 只带结构信息：文件正文可能含密钥，异常正文可能含路径与账户名。
    return { ok: false, reason: `${e?.name ?? 'Error'}${e?.code === undefined ? '' : `/${e.code}`}` }
  }
}

/** 解析模块的**惰性**句柄（见 `readDshCredentialRefs` 里那句注释）。 */
let parseModule = null
async function loadParseModule() {
  if (parseModule === null) {
    parseModule = await import('../security/secrets/dsh-credentials.mjs')
  }
  return parseModule
}

/**
 * 造一个"运行侧钥匙"读取器。
 *
 * @param {object} deps
 * @param {object} [deps.env] 进程环境（默认 `process.env`；用例注入）
 * @param {(env: object, osHome: string|null) => {file: string|null, source: string|null}} [deps.dshCredentialsFileForStatus]
 *        由 `product/dsh-location.mjs` 提供（**唯一**的路径来源；本模块不自己拼路径）。
 *        它允许回落到 `~/.dsh`（DSH 自己的默认），因为这里回答的是状态而不是读值。
 * @param {string|null} [deps.osHome] 操作系统家目录（`osHomeFacts(env).homeDir`）。
 * @param {(file: string, source: string|null) => {ok: boolean, refs?: Set<string>, reason?: string}} [deps.readRefs]
 *        文件读取（用例注入）
 */
export function createRuntimeCredentialProbe({
  env = process.env,
  dshCredentialsFileForStatus = null,
  osHome = null,
  readRefs = null,
} = {}) {
  if (typeof dshCredentialsFileForStatus !== 'function') {
    throw new TypeError('createRuntimeCredentialProbe 需要 dshCredentialsFileForStatus：路径只能在 product/dsh-location.mjs 里定义一次')
  }
  const read = readRefs ?? readDshCredentialRefs

  return Object.freeze({
    /**
     * 取一份读数。**一次列表共用一份**（与 `credential-status.mjs` 的纪律 ② 同）：
     * 20 个供应商不该产生 20 次读盘。
     */
    async snapshot() {
      await loadParseModule()
      const { file, source } = dshCredentialsFileForStatus(env, osHome)
      const fileReading = read(file, source)
      // 宿主环境层：只收**非空**的值。空串在 DSH 那边不算"配了"（`configured:false`）。
      const envRefs = new Set()
      for (const [k, v] of Object.entries(env ?? {})) {
        if (typeof v === 'string' && v !== '') envRefs.add(k)
      }
      const snap = fileReading.ok === true
        ? { ok: true, env: envRefs, fileRefs: fileReading.refs ?? new Set(), reason: null, file, homeSource: source }
        : { ok: false, env: envRefs, fileRefs: new Set(), reason: fileReading.reason ?? null, file, homeSource: source }
      return Object.freeze({
        ok: snap.ok,
        reason: snap.reason,
        /** 找到（或推出来）的那个路径；`null` = 连默认位置都推不出来。 */
        file: snap.file,
        /** `'env'` = `$DSH_HOME` 给的；`'default'` = 按 `~/.dsh` 推的；`null` = 推不出来。 */
        homeSource: snap.homeSource,
        of: (ref) => classifyRuntimeKey(ref, snap),
      })
    },
  })
}
