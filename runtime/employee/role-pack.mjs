// runtime/employee/role-pack.mjs
// ============================================================================
// F-19 Employee / Role Pack（spec §4.4）：
//
//   「Manifest 固化 Prompt、技能、工具、权限、模型、连接器和**预算版本**。」
//
// 这句话里的动词是**固化**，而它要求的是七个**版本**。所以这个模块不做别的，
// 只做一件事：把"这个岗位当时是哪一版"变成一个**可复算、可对账**的产物。
//
// ---------------------------------------------------------------------------
// ① 为什么不写版本号就等于没有固化
//
// 最省事的写法是每个岗位只存一份"当前配置"，需要的时候读出来用。
// 它在一个方向上是对的——跑起来很快；而在另一个方向上是错的：
// **"这个岗位当时被冻结成哪一版"事后无从回答**。用户说"上周那个结果不对"，
// 你打开配置看到的是今天的配置，而它看起来完全正常。
//
//   > 一个「只留当前配置」的岗位包，
//   > 与一个「任何一次历史运行都无法复现」的岗位包，是同一个东西——
//   > 只不过前者在配置文件里看起来是有内容的。
//
// 所以七类**每一类**都必须带版本，而且缺一类就是错，**不是** `?? []`：
//
//   > 一个「缺连接器就当没有连接器」的岗位包，
//   > 与一个「作者忘了写连接器、而它静默地没有连接器」的岗位包，
//   > 在运行结果上是同一个东西——而后者在作者眼里是"我明明配了"。
//
// 注意区分两件事：`connectors: []`（**显式**声明"这个岗位不用连接器"）
// 是合法的；**没有 `connectors` 这个键**是非法的。前者是一个决定，
// 后者是一个省略，而省略与决定在默认值之后长得一模一样。
//
// ---------------------------------------------------------------------------
// ② ★ 版本号是**标签**，哈希才是**身份**
//
// 这是本模块最要紧的一条，也是 F-20 那条教训在岗位包上的重演：
//
//   > 接受一份新 manifest 等于允许「同样的版本号配不同的内容」，
//   > 而版本号是账上唯一的身份。
//
// 所以对**承载内容**的四类（prompt / tools / permissions / budget）额外要求
// `hash`。这不是冗余：一个"v3 的提示词"完全可以是两份不同的文本——
// 作者的机器上改过一次却没提版本号，或者两个人各自发了 v3。
//
// 于是对账时必须区分两种漂移，因为它们的严重程度**完全不同**：
//
//   · 版本号变了 → `ROLE_PACK_VERSION_DRIFT`。**显眼**：谁都看得出来变过。
//   · 版本号没变而哈希变了 → `ROLE_PACK_CONTENT_DRIFT`。**阴险**：
//     按版本号比对会报"一致"，而这个岗位已经不是当时冻结的那一个了。
//
//   > 一个「只比版本号」的对账，
//   > 与一个「对'v3 换了个内容'完全无感」的对账，是同一个东西——
//   > 只不过前者的报告上写着"已核对"。
//
// ---------------------------------------------------------------------------
// ③ 岗位包属于 **agent 平面**，所以它不能是强制面
//
// `patch-layer.mjs` 的 `EMPLOYEE_PRESET_CONTRACT` 写着：
// `plane: 'agent'`、`mayCarryEnforcement: false`。岗位包是那个 preset 的
// **冻结描述**，所以同一条纪律原样继承：`permissions` 一节只能是
// **一个指向已有权限预设的版本引用**，不能内联任何判定。
//
//   > 一个「岗位包里写着允许哪些工具」的包，
//   > 与一个「岗位自己给自己发权限」的包，是同一个东西——
//   > 只不过前者看起来像配置。
//
// 因此强制面字段（`hardFloor` / `denyTools` / `approval` / `sandbox` …）
// 在这一层的**每一个嵌套对象**里都被拒绝，而不只是顶层。
// 只查顶层时，`sections.permissions.hardFloor` 就是一个能走通的越权入口。
//
// ---------------------------------------------------------------------------
// ④ 连接器一节**不许出现值**，只许出现引用
//
// 连接器天然带着凭证（token、key、connection string）。岗位包会被导出、
// 会被提交进 Git、会被贴进工单——所以"凭证引用"与"凭证值"必须在
// **结构上**分开，而不是靠约定。
//
//   > 一个「约定不往里写 token」的连接器配置，
//   > 与一个「第一次有人图省事就泄漏了」的连接器配置，是同一个东西。
//
// ============================================================================

import { domainSeparatedHash, canonicalJson } from '../contracts/canonical.mjs'
import { FORBIDDEN_MANIFEST_FIELDS } from '../dsh-composition/employee-manifest.mjs'

/** 归一化后岗位包的形态版本。结构变了必须递增。 */
export const ROLE_PACK_VERSION = 'legion/role-pack@1'

/** 内容哈希的 domain separator。与包内容、审批、快照都不同（spec §6.5）。 */
export const ROLE_PACK_DOMAIN = 'legion.role-pack.v1'

/** 内容哈希覆盖的条目 schema 版本。 */
export const ROLE_PACK_SCHEMA_VERSION = 1

/**
 * 七类，**一个不多一个不少**。
 *
 * 顺序是刻意的：前三类是 agent 平面上的"岗位长什么样"（§6.9 line 489），
 * 后四类是"它用哪一版的东西"。**列表本身也被用例钉住**——
 * 少一类就是少了一个"事后能不能复现"的答案。
 */
export const ROLE_PACK_SECTIONS = Object.freeze([
  'prompt', 'skills', 'tools', 'permissions', 'model', 'connectors', 'budget',
])

/**
 * 承载**内容**的四类，必须带 `hash`（见文件头 ②）。
 *
 * 另外三类（skills / model / connectors）是**引用表**：它们的身份就是
 * `(id, version)` 本身，再加上条目级的 `hash` 反而是噪声——
 * 一个 skill 的内容由它自己的 id+version 定义，岗位包不该复制一份它的哈希
 * （那会变成两个地方各自漂移）。
 */
export const ROLE_PACK_HASHED_SECTIONS = Object.freeze(['prompt', 'tools', 'permissions', 'budget'])

/** 条目型的两类：一个数组，每项是 `{ id, version }`。 */
export const ROLE_PACK_LIST_SECTIONS = Object.freeze(['skills', 'connectors'])

export const ROLE_PACK_CODES = Object.freeze({
  /** 结构不合法（缺字段、类型不对）。 */
  BAD_PACK: 'role-pack-malformed',
  /** 七类里缺了一类。**不是**默认空——见文件头 ①。 */
  SECTION_MISSING: 'role-pack-section-missing',
  /** 出现了七类之外的键。 */
  SECTION_UNKNOWN: 'role-pack-section-unknown',
  /** 某一节里的字段不在闭合名单里。 */
  FIELD_UNKNOWN: 'role-pack-field-unknown',
  /** 岗位包里出现了强制面字段——一个能写这些字段的包就是一个能给自己发权限的包。 */
  ENFORCEMENT_ON_AGENT_PLANE: 'role-pack-enforcement-field',
  /** 引用没有版本号。 */
  REF_UNPINNED: 'role-pack-reference-unpinned',
  /** 版本号写成 `latest` / `*` / 空串——那不叫固化。 */
  REF_FLOATING: 'role-pack-reference-floating',
  /** 版本号的**形态**不认识。它与"浮动"是两件事，修法也不同：浮动是"写了个会变的词"，
   *  形态不认识多半是拼错或一种没人约定过的新写法。 */
  REF_VERSION_SHAPE: 'role-pack-reference-version-shape',
  /** 承载内容的节缺 `hash`：版本号是标签，哈希才是身份。 */
  HASH_MISSING: 'role-pack-hash-missing',
  /** 声明的 `contentHash` 与**算出来的**不一致。 */
  CONTENT_HASH_MISMATCH: 'role-pack-content-hash-mismatch',
  /** 条目表里有重复 id（同名两版会让"用哪一版"取决于顺序）。 */
  REF_DUPLICATE: 'role-pack-reference-duplicate',
  /** 版本号不是语义版本或整数序号。 */
  REF_BAD_VERSION: 'role-pack-reference-bad-version',
  /** 连接器一节里出现了疑似凭证**值**。 */
  SECRET_VALUE_IN_CONNECTORS: 'role-pack-connector-secret-value',
  /** 对账时：版本号不同。 */
  VERSION_DRIFT: 'role-pack-version-drift',
  /** 对账时：★ 版本号**相同**而内容哈希不同——最阴险的那一种。 */
  CONTENT_DRIFT: 'role-pack-content-drift',
  /** 对账时：世界那边根本没有这个东西。 */
  REF_MISSING_IN_WORLD: 'role-pack-reference-missing',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

/** 顶层允许出现的字段（两个方向都查）。 */
export const ROLE_PACK_FIELDS = Object.freeze([
  'manifestVersion', 'rolePackId', 'role', 'version', 'sections', 'contentHash', 'notes',
])

/** 必须有值的顶层字段。缺一个就不是一份完整的岗位包，而不是"用默认值"。 */
export const REQUIRED_ROLE_PACK_FIELDS = Object.freeze([
  'manifestVersion', 'rolePackId', 'role', 'version', 'sections', 'contentHash',
])

/**
 * 每一节允许出现的字段。
 *
 * `prompt` / `tools` / `permissions` / `budget` 是**引用**：`{ id, version, hash }`。
 * `skills` / `connectors` 是**条目表**：见 `ROLE_PACK_LIST_SECTIONS`。
 * `model` 是 `{ profileId, version }` —— 模型档案的身份就是这两项。
 */
export const ROLE_PACK_SECTION_FIELDS = Object.freeze({
  prompt: Object.freeze(['id', 'version', 'hash']),
  tools: Object.freeze(['id', 'version', 'hash']),
  permissions: Object.freeze(['presetId', 'version', 'hash']),
  budget: Object.freeze(['policyId', 'version', 'hash']),
  model: Object.freeze(['profileId', 'version']),
  skills: Object.freeze(['id', 'version']),
  connectors: Object.freeze(['id', 'version']),
})

/** 各节的"身份字段"名（它在哪一列上带 id）。 */
const SECTION_ID_FIELD = Object.freeze({
  prompt: 'id', tools: 'id', permissions: 'presetId', budget: 'policyId',
  model: 'profileId', skills: 'id', connectors: 'id',
})

/**
 * 浮动版本号：写这些等于没固化，而且看起来像固化了。
 *
 * 这张表**只用来分诊**（决定报 `REF_FLOATING` 还是 `REF_VERSION_SHAPE`），
 * **不**参与"合不合法"的判断——合法性完全由 `PINNED_VERSION_SHAPES` 决定。
 *
 * ★ 为什么必须这么说清楚：这两个判断如果各写一份，就会有一份**永远跑不到**，
 *   而"两份判断、只有一份生效"与"一份判断"在测试上的区别是——
 *   前者看起来覆盖得更全。实测：早先两处都写了浮动检查，
 *   于是把其中一处改成恒假，用例**一条都没红**。
 */
const FLOATING_VERSIONS = Object.freeze(['latest', '*', 'head', 'current', 'dev', 'edge', 'next', 'stable', 'master', 'main'])

/**
 * 固定版本号的**形态**（封闭集合，每一种都能说出它为什么是固定的）。
 *
 *   · `3`                      —— 纯整数序号（提示词常用）
 *   · `1.2.3` / `1.2.3-rc.1`   —— 语义版本
 *   · `2024-01-01`             —— 日期。★ 它**是**固定的：它不指向"当前是什么"，
 *                                 它就是一个名字。把它拒掉会逼人改写成 `2024.1.1`，
 *                                 而那样写除了满足正则之外什么都没多出来
 *                                 （**一条过严的规则会制造"为了过规则而说谎"的压力**）
 *   · `sha256:<64hex>` / `a1b2c3d` —— 内容摘要
 *   · `gpt-4-0613` / `claude-3-20240229` —— 名字 + 固定后缀。模型快照的常见写法
 *
 * ★ 诚实地说明这条守卫**不做**什么：它不证明版本号**有意义**——
 *   `my-thing-2024` 也会通过。它拦的是"会变的东西"（`latest` / `*` / 空），
 *   以及拼错的形态；这两类恰好是"看起来固化了、实际没有"的全部来源。
 */
const PINNED_VERSION_SHAPES = Object.freeze([
  /^\d+$/,
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  /^\d{4}-\d{2}-\d{2}$/,
  /^sha256:[0-9a-f]{64}$/,
  /^[0-9a-f]{7,64}$/,
  /^[A-Za-z][A-Za-z0-9._-]*-[0-9]{4,8}$/,
])

/**
 * 一个可接受的版本号：形态是上面六种之一。
 *
 * 空串与浮动词**自然**落在这里之外（六种形态没有一个能匹配 `latest` 或 `''`），
 * 所以这里不做额外的"是不是浮动"判断——那会是同一件事的第二份实现，
 * 而第二份实现永远不会被单独测到。
 */
function isPinnedVersion(v) {
  if (typeof v !== 'string') return false
  const t = v.trim()
  if (t === '') return false
  return PINNED_VERSION_SHAPES.some((re) => re.test(t))
}

/**
 * 连接器一节里**不许**出现的键。
 *
 * 它们不是"我们不推荐"，是"一旦出现就已经泄漏了"。既然泄漏发生在
 * 写进去的那一刻，检查就必须发生在写进去之前——即在 `normalizeRolePack` 里。
 */
export const FORBIDDEN_CONNECTOR_KEYS = Object.freeze([
  'token', 'accessToken', 'access_token', 'secret', 'clientSecret', 'client_secret',
  'password', 'passwd', 'apiKey', 'api_key', 'apikey', 'key', 'credentials',
  'connectionString', 'connection_string', 'dsn', 'privateKey', 'private_key',
  'authorization', 'bearer', 'cookie',
])

/** 顶层字段闭合检查。 */
export function assertRolePackFieldsClosed(pack) {
  const seen = Object.keys(pack ?? {})
  const forbidden = seen.filter((k) => FORBIDDEN_MANIFEST_FIELDS.includes(k))
  if (forbidden.length > 0) {
    throw fail(
      ROLE_PACK_CODES.ENFORCEMENT_ON_AGENT_PLANE,
      `岗位包里出现了强制面字段 ${JSON.stringify(forbidden)}。` +
      '岗位包是 agent 平面 preset 的冻结描述（`EMPLOYEE_PRESET_CONTRACT`：' +
      '`mayCarryEnforcement: false`），而强制面属于 host 组合——' +
      '一个能写这些字段的岗位包就是一个能给自己发权限的岗位包',
    )
  }
  const unknown = seen.filter((k) => !ROLE_PACK_FIELDS.includes(k))
  if (unknown.length > 0) {
    throw fail(
      ROLE_PACK_CODES.FIELD_UNKNOWN,
      `岗位包里出现了不认识的字段 ${JSON.stringify(unknown)}。不忽略——` +
      '一个"忽略不认识字段"的岗位包，与一个"多打的一个字母让整条限制静默失效"的岗位包，是同一个东西',
    )
  }
  return Object.freeze({ fields: Object.freeze(seen) })
}

/** 递归查强制面字段：嵌套对象上也要查（只查顶层时 `sections.permissions.hardFloor` 就是入口）。 */
function assertNoEnforcementAnywhere(value, path = '$') {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoEnforcementAnywhere(v, `${path}[${i}]`))
    return
  }
  const hit = Object.keys(value).filter((k) => FORBIDDEN_MANIFEST_FIELDS.includes(k))
  if (hit.length > 0) {
    throw fail(
      ROLE_PACK_CODES.ENFORCEMENT_ON_AGENT_PLANE,
      `${path} 上出现了强制面字段 ${JSON.stringify(hit)}。强制面属于 host 组合，` +
      '岗位包的每一层都不能承载它——只查顶层时，`sections.permissions` 就是一个能走通的越权入口',
    )
  }
  for (const [k, v] of Object.entries(value)) assertNoEnforcementAnywhere(v, `${path}.${k}`)
}

/**
 * 未知字段的**分诊**：先看它是不是强制面字段。
 *
 * ★ 顺序很要紧。`hardFloor` 既"不在这一节的闭包名单里"、又"是强制面字段"，
 * 两条都成立——而先报"字段不认识"会把**最要警惕的那一类**说成一次拼写问题：
 *
 *   > 一个把「`permissions` 里写着 `hardFloor`」报成"字段不认识"的校验，
 *   > 与一个把越权报成手滑的校验，是同一个东西——
 *   > 只不过前者的报错里有个合法的字段名单，读起来像在帮忙。
 *
 * 所以强制面字段必须**先**被认出来，再谈闭包。
 */
function classifyUnknownKeys({ keys, allowed, path }) {
  const enforcement = keys.filter((k) => FORBIDDEN_MANIFEST_FIELDS.includes(k))
  if (enforcement.length > 0) {
    throw fail(
      ROLE_PACK_CODES.ENFORCEMENT_ON_AGENT_PLANE,
      `${path} 上出现了强制面字段 ${JSON.stringify(enforcement)}。` +
      '强制面属于 host 组合，岗位包的**每一层**都不能承载它——' +
      '一个能写这些字段的岗位包就是一个能给自己发权限的岗位包',
    )
  }
  if (keys.length > 0) {
    throw fail(
      ROLE_PACK_CODES.FIELD_UNKNOWN,
      `${path} 出现了不认识的字段 ${JSON.stringify(keys)}（合法：${allowed.join(' / ')}）。` +
      '不忽略——`version` 拼成 `ver` 会让这条引用**静默地没有版本**，而那正是"没有固化"',
    )
  }
}

/** 校验一个引用对象（`{ id, version, hash? }`）。 */
function normalizeRef({ raw, section, where }) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fail(ROLE_PACK_CODES.BAD_PACK, `${where} 必须是一个对象（收到 ${JSON.stringify(raw)}）`)
  }
  const allowed = ROLE_PACK_SECTION_FIELDS[section]
  classifyUnknownKeys({
    keys: Object.keys(raw).filter((k) => !allowed.includes(k)), allowed, path: where,
  })
  const idField = SECTION_ID_FIELD[section]
  const id = String(raw[idField] ?? '').trim()
  if (id === '') throw fail(ROLE_PACK_CODES.BAD_PACK, `${where} 缺少 ${idField}`)

  const version = String(raw.version ?? '').trim()
  if (version === '' && (raw.version === undefined || raw.version === null || raw.version === '')) {
    throw fail(
      ROLE_PACK_CODES.REF_UNPINNED,
      `${where} 没有版本号。**不固化版本 = 没有固化**（见 role-pack.mjs 文件头 ①）：` +
      '事后问"当时用的是哪一版"会读到今天的配置，而它看起来完全正常',
    )
  }
  if (!isPinnedVersion(version)) {
    // ★ 先分"浮动"与"形态不认识"：两者都拒绝，但**修法不同**，
    //   而这正是"具名码"存在的理由。浮动是"写了个会变的词"，
    //   形态不认识多半是拼错、或者一种没人约定过的新写法。
    if (FLOATING_VERSIONS.includes(String(raw.version ?? '').trim().toLowerCase())) {
      throw fail(
        ROLE_PACK_CODES.REF_FLOATING,
        `${where} 的版本号是 ${JSON.stringify(raw.version)}，不是固定版本。` +
        '`latest` / `*` / `head` / `dev` / 空串**看起来像固化了**，而它们指向的是' +
        '"运行时恰好是什么"——一个写着 latest 的岗位包，与一个没写版本的岗位包，是同一个东西',
      )
    }
    throw fail(
      ROLE_PACK_CODES.REF_VERSION_SHAPE,
      `${where} 的版本号 ${JSON.stringify(raw.version)} 形态不认识。` +
      '可接受的固定写法：整数序号 / 语义版本 / 日期 `YYYY-MM-DD` / 内容摘要 / ' +
      '`名字-固定后缀`（如 `gpt-4-0613`）。' +
      '★ 这条守卫**不**判断版本号有没有意义，它拦的是"会变的东西"与拼错的形态——' +
      '而那两类恰好是"看起来固化了、实际没有"的全部来源',
    )
  }

  const out = { [idField]: id, version }
  if (ROLE_PACK_HASHED_SECTIONS.includes(section)) {
    const hash = raw.hash === undefined || raw.hash === null ? '' : String(raw.hash).trim()
    if (hash === '') {
      throw fail(
        ROLE_PACK_CODES.HASH_MISSING,
        `${where} 只有版本号、没有 \`hash\`。★ 版本号是**标签**，哈希才是**身份**：` +
        '一份"v3 的提示词"完全可以是两份不同的文本（作者的机器上改过却没提版本号，' +
        '或者两个人各自发了 v3）。只比版本号的对账会对这种变化完全无感，而报告上写着"已核对"',
      )
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw fail(ROLE_PACK_CODES.HASH_MISSING, `${where} 的 hash ${JSON.stringify(hash)} 不是 sha256:<64hex>`)
    }
    out.hash = hash
  }
  return Object.freeze(out)
}

/** 校验一个条目表（skills / connectors）。 */
function normalizeList({ raw, section, where }) {
  if (!Array.isArray(raw)) {
    throw fail(ROLE_PACK_CODES.BAD_PACK, `${where} 必须是一个数组（收到 ${JSON.stringify(raw)}）`)
  }
  const seen = new Set()
  const out = []
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    const at = `${where}[${i}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw fail(ROLE_PACK_CODES.BAD_PACK, `${at} 必须是一个对象`)
    }
    const allowed = ROLE_PACK_SECTION_FIELDS[section]
    const unknown = Object.keys(item).filter((k) => !allowed.includes(k))
    if (unknown.length > 0) {
      // 连接器这一条要单独说：出现了疑似凭证**值**的键，那不是"字段不认识"，
      // 是"已经泄漏了"——而泄漏发生在写进去的那一刻。
      const leaked = unknown.filter((k) => FORBIDDEN_CONNECTOR_KEYS.includes(k))
      if (section === 'connectors' && leaked.length > 0) {
        throw fail(
          ROLE_PACK_CODES.SECRET_VALUE_IN_CONNECTORS,
          `${at} 里出现了疑似凭证字段 ${JSON.stringify(leaked)}。连接器一节**只许出现引用**` +
          '（`{ id, version }`）：岗位包会被导出、提交进 Git、贴进工单，' +
          '所以"凭证引用"与"凭证值"必须在**结构上**分开，而不是靠约定',
        )
      }
      // 然后是强制面，最后才是笼统的"字段不认识"。
      classifyUnknownKeys({ keys: unknown, allowed, path: at })
    }
    const ref = normalizeRef({ raw: item, section, where: at })
    const id = ref.id
    if (seen.has(id)) {
      throw fail(
        ROLE_PACK_CODES.REF_DUPLICATE,
        `${where} 里 ${id} 出现了两次。同一个 id 两版会让"到底用哪一版"**取决于数组顺序**——` +
        '而顺序是没有人维护的东西，它今天恰好是对的',
      )
    }
    seen.add(id)
    out.push(ref)
  }
  // 排序：哈希必须与**写法顺序**无关，否则同两份条目、换个顺序就是两个身份。
  return Object.freeze(out.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
}

/**
 * 计算内容哈希：覆盖**七节的全部内容**。
 *
 * 不含顶层 `contentHash` 自己（那是循环），也不含 `notes`
 * （一段说明文字不该改变"这个岗位是哪一版"）。
 */
export function rolePackContentHash(sections) {
  return domainSeparatedHash(ROLE_PACK_DOMAIN, ROLE_PACK_SCHEMA_VERSION, sections)
}

/**
 * 归一化并校验一份岗位包。**只校验、不算权限**（合并见 `employee-manifest.mjs`）。
 *
 * 顺序是刻意的：先查顶层字段闭合 → 再查嵌套强制面 → 再逐节固化 → 最后比对哈希。
 * 哈希放最后，因为它只有在其余都合法时才有意义。
 */
export function normalizeRolePack(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw fail(ROLE_PACK_CODES.BAD_PACK, 'normalizeRolePack 需要一份岗位包对象')
  }
  assertRolePackFieldsClosed(input)
  assertNoEnforcementAnywhere(input)

  const missingTop = REQUIRED_ROLE_PACK_FIELDS.filter((f) => input[f] === undefined || input[f] === null)
  if (missingTop.length > 0) {
    throw fail(
      ROLE_PACK_CODES.BAD_PACK,
      `岗位包缺少必填字段 ${JSON.stringify(missingTop)}。不给默认值——` +
      '一个"缺字段就用默认值"的解析，与一个"作者以为写了、而实际上没有"的岗位包，是同一个东西',
    )
  }
  if (input.manifestVersion !== ROLE_PACK_VERSION) {
    throw fail(
      ROLE_PACK_CODES.BAD_PACK,
      `manifestVersion 是 ${JSON.stringify(input.manifestVersion)}，期望 ${ROLE_PACK_VERSION}。` +
      '形态版本对不上时**不猜**：结构变过之后，旧包按新规则读出来的字段含义可能已经不同',
    )
  }
  const rolePackId = String(input.rolePackId ?? '').trim()
  if (rolePackId === '') throw fail(ROLE_PACK_CODES.BAD_PACK, '岗位包缺少 rolePackId')
  const role = String(input.role ?? '').trim()
  if (role === '') throw fail(ROLE_PACK_CODES.BAD_PACK, `${rolePackId} 缺少 role`)
  if (!isPinnedVersion(String(input.version ?? ''))) {
    throw fail(ROLE_PACK_CODES.REF_BAD_VERSION, `${rolePackId} 的 version ${JSON.stringify(input.version)} 不是固定版本`)
  }

  const rawSections = input.sections
  if (rawSections === null || typeof rawSections !== 'object' || Array.isArray(rawSections)) {
    throw fail(ROLE_PACK_CODES.BAD_PACK, `${rolePackId} 的 sections 必须是一个对象`)
  }
  // ① 七类**一个都不能少**，而且**不能多**。
  const present = Object.keys(rawSections)
  const missing = ROLE_PACK_SECTIONS.filter((s) => !present.includes(s))
  if (missing.length > 0) {
    throw fail(
      ROLE_PACK_CODES.SECTION_MISSING,
      `${rolePackId} 的 sections 缺少 ${JSON.stringify(missing)}。` +
      '**不给默认空值**：一个"缺连接器就当没有连接器"的岗位包，与一个' +
      '"作者忘了写连接器、而它静默地没有连接器"的岗位包，在运行结果上是同一个东西——' +
      '而后者在作者眼里是"我明明配了"。确实不用连接器时写 `connectors: []`，' +
      '那是一个**决定**，与一个省略不是一回事',
    )
  }
  const extra = present.filter((s) => !ROLE_PACK_SECTIONS.includes(s))
  if (extra.length > 0) {
    throw fail(
      ROLE_PACK_CODES.SECTION_UNKNOWN,
      `${rolePackId} 的 sections 里出现了七类之外的东西 ${JSON.stringify(extra)}。` +
      '不忽略——一个"多出来一节没人读"的岗位包，会让人以为它固化了某样东西',
    )
  }

  const sections = {}
  for (const s of ROLE_PACK_SECTIONS) {
    const where = `${rolePackId}.sections.${s}`
    sections[s] = ROLE_PACK_LIST_SECTIONS.includes(s)
      ? normalizeList({ raw: rawSections[s], section: s, where })
      : normalizeRef({ raw: rawSections[s], section: s, where })
  }

  // ② ★ 内容哈希是**算出来的**，声明的那个只能用来对账。
  const computed = rolePackContentHash(sections)
  const declared = String(input.contentHash ?? '').trim()
  if (declared !== computed) {
    throw fail(
      ROLE_PACK_CODES.CONTENT_HASH_MISMATCH,
      `${rolePackId} 声明的 contentHash 与算出来的不一致（声明 ${declared || '(空)'}，实际 ${computed}）。` +
      '账上记的必须是**算出来的**那一个：抄作者的声明等于让"改了一节却没改哈希"这件事无法被发现',
    )
  }

  return Object.freeze({
    manifestVersion: ROLE_PACK_VERSION,
    rolePackId,
    role,
    version: String(input.version).trim(),
    sections: Object.freeze(sections),
    contentHash: computed,
    ...(input.notes === undefined ? {} : { notes: String(input.notes) }),
  })
}

/**
 * 建一份岗位包（算好哈希再套 `normalizeRolePack`，于是返回值一定是合法的）。
 *
 * 存在的理由：让调用方**没有机会**手写一个哈希。手写时它要么抄错、
 * 要么先写包再补哈希——而"先写包再补哈希"正是那个会让漂移溜过去的顺序。
 */
export function buildRolePack({ rolePackId, role, version, sections, notes } = {}) {
  if (sections === null || typeof sections !== 'object' || Array.isArray(sections)) {
    throw fail(ROLE_PACK_CODES.BAD_PACK, 'buildRolePack 需要 sections 对象')
  }
  const missing = ROLE_PACK_SECTIONS.filter((s) => sections[s] === undefined)
  if (missing.length > 0) {
    throw fail(
      ROLE_PACK_CODES.SECTION_MISSING,
      `sections 缺少 ${JSON.stringify(missing)}——七类必须**全部**显式给出，` +
      '包括"这一类就是空的"（写 `[]`）',
    )
  }
  // 先归一化一次拿到排序/闭包后的七节，再用**它**算哈希。
  // 直接用入参算会让 `[a,b]` 与 `[b,a]` 得到两个哈希，而它们是同一份岗位包。
  const normalizedSections = {}
  for (const s of ROLE_PACK_SECTIONS) {
    const where = `${rolePackId ?? '(未命名)'}.sections.${s}`
    normalizedSections[s] = ROLE_PACK_LIST_SECTIONS.includes(s)
      ? normalizeList({ raw: sections[s], section: s, where })
      : normalizeRef({ raw: sections[s], section: s, where })
  }
  const contentHash = rolePackContentHash(normalizedSections)
  return normalizeRolePack({
    manifestVersion: ROLE_PACK_VERSION, rolePackId, role, version,
    sections: normalizedSections, contentHash,
    ...(notes === undefined ? {} : { notes }),
  })
}

/**
 * 把岗位包对账到"世界现在实际是什么"。
 *
 * ## 为什么需要它
 *
 * 固化这件事只有在**能被证伪**的时候才成立。一份写着"prompt v3"的岗位包，
 * 配上今天的运行，只有在对账之后才能说"跑的还是当时那一版"。
 * 没有对账时，"岗位包固化了版本"与"岗位包上写着一行版本号"是同一个东西。
 *
 * ## `world` 的形状
 *
 * 与 `sections` **同形**，但值是"世界现在给得出什么"：
 *   · 引用型（prompt/tools/permissions/budget）：`{ id?, hash? , version? }`
 *   · 条目型（skills/connectors）：数组 `[{ id, version }]`
 *   · model：`{ profileId, version }`
 *
 * 世界那边**缺一样东西时返回 `null`**，而不是省略那一节——
 * "世界说没有"与"调用方忘了传"必须分得开（前者是对账结论，后者是调用错误）。
 *
 * ## 两种漂移必须分开报
 *
 * 见文件头 ②：版本号变了是**显眼**的，版本号没变而内容变了是**阴险**的。
 * 合成一个 `drift: true` 会让报告失去唯一有用的信息——"要不要立刻停下"。
 */
export function verifyRolePack({ pack, world } = {}) {
  const normalized = normalizeRolePack(pack)
  if (world === null || typeof world !== 'object' || Array.isArray(world)) {
    throw fail(ROLE_PACK_CODES.BAD_PACK, 'verifyRolePack 需要一个 world 对象（七节同形）')
  }
  const drifts = []

  for (const section of ROLE_PACK_SECTIONS) {
    const expected = normalized.sections[section]
    const actual = Object.prototype.hasOwnProperty.call(world, section) ? world[section] : undefined
    if (actual === undefined) {
      throw fail(
        ROLE_PACK_CODES.BAD_PACK,
        `world 里没有 ${section} 一节。**"世界说没有"与"调用方忘了传"必须分得开**：` +
        '前者（`null`）是一个对账结论，后者是一个调用错误——把它们混起来时，' +
        '一个漏传的字段会被报成"这个东西不存在"',
      )
    }
    if (actual === null) {
      drifts.push(Object.freeze({
        section, code: ROLE_PACK_CODES.REF_MISSING_IN_WORLD,
        expected: summarize(expected), actual: null,
        detail: `${section} 在世界那边不存在`,
      }))
      continue
    }

    if (ROLE_PACK_LIST_SECTIONS.includes(section)) {
      const actualList = Array.isArray(actual) ? actual : []
      const byId = new Map(actualList.map((x) => [String(x?.id ?? ''), x]))
      for (const want of expected) {
        const got = byId.get(want.id)
        if (got === undefined) {
          drifts.push(Object.freeze({
            section, id: want.id, code: ROLE_PACK_CODES.REF_MISSING_IN_WORLD,
            expected: want.version, actual: null,
            detail: `${section} 里的 ${want.id} 在世界那边不存在`,
          }))
        } else if (String(got.version ?? '') !== want.version) {
          drifts.push(Object.freeze({
            section, id: want.id, code: ROLE_PACK_CODES.VERSION_DRIFT,
            expected: want.version, actual: String(got.version ?? ''),
            detail: `${section}.${want.id} 的版本从 ${want.version} 变成了 ${got.version}`,
          }))
        }
      }
      continue
    }

    // 引用型
    const idField = SECTION_ID_FIELD[section]
    const actualVersion = String(actual.version ?? '')
    const idMismatch = actual[idField] !== undefined && String(actual[idField]) !== expected[idField]
    if (idMismatch) {
      drifts.push(Object.freeze({
        section, code: ROLE_PACK_CODES.REF_MISSING_IN_WORLD,
        expected: expected[idField], actual: String(actual[idField]),
        detail: `${section} 指向的是 ${actual[idField]}，而岗位包固化的是 ${expected[idField]}`,
      }))
      continue
    }
    // ★ 先比哈希再比版本：**版本相同而哈希不同**是最阴险的那一种，
    //   它必须有自己的码，否则报告里与"版本变了"长得一样。
    if (expected.hash !== undefined) {
      const actualHash = actual.hash === undefined || actual.hash === null ? null : String(actual.hash)
      if (actualHash === null) {
        drifts.push(Object.freeze({
          section, code: ROLE_PACK_CODES.CONTENT_DRIFT,
          expected: expected.hash, actual: null,
          detail: `${section} 在世界那边拿不出内容哈希，无法确认它还是不是当时那一版`,
        }))
        continue
      }
      if (actualHash !== expected.hash) {
        const sameVersion = actualVersion === expected.version
        drifts.push(Object.freeze({
          section, code: sameVersion ? ROLE_PACK_CODES.CONTENT_DRIFT : ROLE_PACK_CODES.VERSION_DRIFT,
          expected: expected.hash, actual: actualHash,
          expectedVersion: expected.version, actualVersion,
          detail: sameVersion
            ? `★ ${section} 的版本号还是 ${expected.version}，但内容变了（${expected.hash} → ${actualHash}）。` +
              '按版本号比对会报"一致"，而这个岗位已经不是当时冻结的那一个了'
            : `${section} 的版本从 ${expected.version} 变成了 ${actualVersion}`,
        }))
        continue
      }
    }
    if (actualVersion !== expected.version) {
      drifts.push(Object.freeze({
        section, code: ROLE_PACK_CODES.VERSION_DRIFT,
        expected: expected.version, actual: actualVersion,
        detail: `${section} 的版本从 ${expected.version} 变成了 ${actualVersion}`,
      }))
    }
  }

  return Object.freeze({
    ok: drifts.length === 0,
    rolePackId: normalized.rolePackId,
    version: normalized.version,
    contentHash: normalized.contentHash,
    drifts: Object.freeze(drifts),
    // ★ 单独给出"有没有那种阴险的漂移"：调用方要据此决定是"提醒"还是"停下"。
    contentDrifted: drifts.some((d) => d.code === ROLE_PACK_CODES.CONTENT_DRIFT),
  })
}

function summarize(section) {
  if (Array.isArray(section)) return section.map((x) => `${x.id}@${x.version}`)
  const idField = ['presetId', 'policyId', 'profileId'].find((f) => section[f] !== undefined)
    ?? 'id'
  return `${section[idField]}@${section.version}`
}

/** 一份岗位包固化住的东西的**清单**（给界面/CLI 一个读出口，不含任何凭证值）。 */
export function describeRolePack(pack) {
  const n = normalizeRolePack(pack)
  return Object.freeze({
    rolePackId: n.rolePackId,
    role: n.role,
    version: n.version,
    contentHash: n.contentHash,
    sections: Object.freeze(ROLE_PACK_SECTIONS.map((s) => Object.freeze({
      section: s,
      summary: summarize(n.sections[s]),
      pinned: true,
    }))),
  })
}

/**
 * 两个岗位包在"固化住的东西"上的差异。
 *
 * 用途是回答"这次升级到底动了什么"——没有它，一次岗位包升级的读数
 * 只有"版本从 1.0.0 变成 1.1.0"，而那句话没有告诉任何人任何事。
 */
export function diffRolePacks({ before, after } = {}) {
  const a = normalizeRolePack(before)
  const b = normalizeRolePack(after)
  const changed = []
  for (const s of ROLE_PACK_SECTIONS) {
    const left = canonicalJson(a.sections[s])
    const right = canonicalJson(b.sections[s])
    if (left !== right) {
      changed.push(Object.freeze({
        section: s, before: summarize(a.sections[s]), after: summarize(b.sections[s]),
      }))
    }
  }
  return Object.freeze({
    sameContent: a.contentHash === b.contentHash,
    beforeVersion: a.version,
    afterVersion: b.version,
    changed: Object.freeze(changed),
  })
}
