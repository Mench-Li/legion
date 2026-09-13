// workbench/src/modelSettingsUi.ts
// ============================================================================
// PRT-507：设置面的**面板状态**纯逻辑
//
// ## 为什么与 `modelSettings.ts` 分开，而不是把函数塞进去
//
// `modelSettings.ts` 的输入是**已经拿到的东西**：一条探测判定（verdict）、
// 一条档案行、一份计划。它回答"这个东西长什么样"。
//
// 本模块的输入是**还没拿到的东西**：一次异步读取、一次抛出来的错误、
// 一次写回执。它回答"现在到底是哪一种情况"——而这一层错的代价最高，
// 因为界面会把"读不出来"渲染成"你没有"。
//
// 两条纪律写在两个文件里，各自的套件也就各自钉得住：
//   · `modelSettings.ts`：**「没探测过」≠「探测失败」**（"后端加了码、前端笼统提示"那一族）
//   · 本模块：          **「读不出来」≠「是空的」**（故障伪装成空状态那一族）
//
// 后者比前者更坏一点：空状态是**可操作**的——用户看到"你还没有任何凭证"，
// 会照着提示重新录入一遍钥匙，而真相是密钥库打不开，录进去的每一次都会失败。
// 一次故障因此被"修复"成了很多次徒劳的动作，而且现场被搅乱了。
//
// ## 三个必须互不重叠的分支（每一个都能在用例里被钉住）
//
// ① **读取三态**：`loading` / `ready` / `failed`。`ready` 且为空才是"你没有"；
//    `failed` 一律说"读不出来，这不等于你没有"。
// ② **探测的两种"没结果"**：`probe-service.mjs` 内部用 `unavailable:true` 表达
//    "这次没有探测过"，但 `server.mjs` 在 503 分支只把 `error`/`code` 放进错误体
//    （见 `api.ts` 的 `probeModelProfile`）。HTTP 层收不到那个判别字段，
//    所以这里按 **503** 分类，并且**绝不**给它编一个失败分类。
// ③ **写回执的两种"没变化"**：删除一个不存在的引用是**幂等**（`removed:false`），
//    轮换一个不存在的引用是**错误**（404 `SECRET_NOT_FOUND`）。两者的下一步动作相反。
//
// ## 不猜
//
// 本模块不发明任何码、状态码或计数：拿不到就 `null` / 一个显式的 `unknown` 分支，
// 并在文案里说清"不知道"。（少一个状态与多一个编出来的状态，代价一样大。）
// ============================================================================

import { asHubError } from './hub-errors.ts'
import { chainView, fieldErrorFrom, importPlanView, probeBadge } from './modelSettings.ts'
import type { ChainEntryLike, ChainEntryView, ImportPlanLike, ImportPlanView, ProbeBadge, ProbeVerdictLike } from './modelSettings.ts'

/** 从任意值里取一个非空字符串，否则 `null`（**不把 0 / false 转成字符串**）。 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** 只把真正的对象当对象（数组与 null 都不算）。 */
function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

// ────────────────────────────────────────────────────────── ① 读取三态

/**
 * 一次异步读取的结果。
 *
 * `ready` 里的空集合与 `failed` **是两件事**，类型层面就分开，
 * 于是界面不可能"顺手"把 `[]` 当成失败、或把失败当成 `[]`。
 */
export type AsyncState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T }
  | { kind: 'failed'; error: PanelError }

/** 一个已经到达界面的错误。字段全部来自中枢（PRT-252 的契约）或显式的 `null`。 */
export interface PanelError {
  status: number | null
  code: string | null
  /** 该落到哪个输入框；`null` = 整体错误。 */
  field: string | null
  text: string
  hint: string | null
  candidates: string[]
}

/**
 * 把任意异常翻成面板能渲染的错误。
 *
 * `field`/`candidates` 的权威来源是**原始响应体**（PRT-252），所以有 body 时
 * 一定先读 body。非中枢错误（网络异常、超时、代码 bug）**不假装**它有结构：
 * `code`/`field` 留 `null`，而不是把一次 `ECONNREFUSED` 说成"某个字段有问题"。
 */
export function panelErrorFrom(e: unknown): PanelError {
  const h = asHubError(e)
  const rawBody = (e !== null && typeof e === 'object' && 'body' in e) ? (e as { body?: unknown }).body : null
  const bodyObj = obj(rawBody)
  const fromBody = bodyObj === null ? null : fieldErrorFrom(bodyObj)
  return {
    status: typeof h.status === 'number' ? h.status : null,
    code: h.code ?? null,
    field: fromBody?.field ?? h.field ?? null,
    text: h.message ?? fromBody?.text ?? '未知错误',
    hint: fromBody?.hint ?? h.hint ?? null,
    candidates: fromBody !== null && fromBody.candidates.length > 0
      ? fromBody.candidates
      : [...(h.candidates ?? [])],
  }
}

export function loadingState<T>(): AsyncState<T> { return { kind: 'loading' } }
export function readyState<T>(data: T): AsyncState<T> { return { kind: 'ready', data } }
export function failedState<T>(e: unknown): AsyncState<T> { return { kind: 'failed', error: panelErrorFrom(e) } }

/** 一个列表面板该渲染成什么。`kind` 是判据，`headline`/`detail` 是它的话。 */
export interface CollectionView {
  kind: 'loading' | 'rows' | 'empty' | 'unreadable'
  tone: 'muted' | 'ok' | 'bad'
  headline: string
  detail: string
  code: string | null
  canRetry: boolean
}

export interface CollectionCopy {
  /** 名词，例如"凭证"。 */
  noun: string
  /** **只在真的读出来且为空**时才出现的那句提示。 */
  emptyHint: string
  /** 读不出来时补的"该往哪看"。 */
  readFailedHint: string
}

/**
 * 一个列表的状态 → 可渲染的视图。
 *
 * 关键在第四个分支：**读不出来时不许说"你还没有"**。
 * 两条文案在用例里被断言互不出现（`empty` 里没有"读不出来"，
 * `unreadable` 里没有 `emptyHint`）——因为一次故障伪装成空状态，
 * 会把用户送去重新录入一堆其实好端端躺在本机的东西。
 */
export function collectionView<T>(state: AsyncState<readonly T[]>, copy: CollectionCopy): CollectionView {
  if (state.kind === 'loading') {
    return { kind: 'loading', tone: 'muted', headline: `正在读取${copy.noun}…`, detail: '', code: null, canRetry: false }
  }
  if (state.kind === 'failed') {
    const e = state.error
    const parts = [
      e.text,
      e.hint,
      copy.readFailedHint,
      e.code === null ? null : `服务端码：${e.code}`,
    ].filter((x): x is string => typeof x === 'string' && x !== '')
    return {
      kind: 'unreadable',
      tone: 'bad',
      // 标题自己就把最危险的误读挡掉。
      headline: `读不出来${copy.noun} —— 这不等于「你没有」`,
      detail: parts.join('  '),
      code: e.code,
      canRetry: true,
    }
  }
  if (state.data.length === 0) {
    return { kind: 'empty', tone: 'muted', headline: `还没有${copy.noun}`, detail: copy.emptyHint, code: null, canRetry: true }
  }
  return { kind: 'rows', tone: 'ok', headline: `${copy.noun}（${state.data.length}）`, detail: '', code: null, canRetry: true }
}

// ────────────────────────────────────────── ② 探测：没有结果 ≠ 失败

/**
 * 「没探测过」的服务端码，来源 `team-hub/probe-service.mjs` 的
 * `PROBE_UNAVAILABLE_CODES`。**不是探测判定码**——它们没有失败分类可言。
 *
 * 写成一张表而不是 `startsWith('PROBE_')`：前缀匹配会把将来任何一个
 * `PROBE_*` 的**真失败码**也吞成"未测试"，而那正好是这条纪律的反面。
 */
const PROBE_UNAVAILABLE_CODES: Record<string, true> = {
  PROBE_LAYOUT_BLOCKED: true,
  PROBE_SECRETS_UNAVAILABLE: true,
  PROBE_NO_CREDENTIAL_REF: true,
}

/**
 * 一次"测试连接"的两种输入 → 一个徽标。
 *
 * 成功路径（`verdict`）直接交给 `modelSettings.ts` 的 `probeBadge`——
 * 分类与文案只有那一份，**不在这里复制**。
 *
 * 失败路径（`error`）先做一件事：**把 503 与"判定失败"分开**。
 * 探测路由只在 `verdict.unavailable === true` 时回 503（`server.mjs`），
 * 也就是说 503 的含义是"现在没法提供这项服务"，**不是**"模型连不上"。
 * 把它按 `class: 'unknown'` 渲染成红色失败，用户会去查网络与供应商状态
 * ——一条完全错误的方向，而且他会开始怀疑一个**从未被验证过**的东西。
 *
 * 认不出的 503 也走"未测试"（它是服务不可用，不是判定），
 * 但在详情里**明说**这个码不在已知集合内——一个沉默的降级等于把
 * "我们没归类"记成"它就是这样"。
 */
export function probeViewFrom(input: { verdict?: ProbeVerdictLike | null; error?: unknown }): ProbeBadge {
  const { verdict, error } = input
  if (error !== undefined && error !== null) {
    const h = asHubError(error)
    const code = h.code ?? null
    if (h.status === 503) {
      const known = code !== null && PROBE_UNAVAILABLE_CODES[code] === true
      const base = h.message ?? '这次没有探测过。'
      return probeBadge({
        ok: false,
        unavailable: true,
        code: code ?? 'UNCLASSIFIED',
        message: known || code === null
          ? base
          : `${base}（**这个码不在已知的"没探测过"集合里**，请按服务不可用处理，不要当成探测判定。）`,
      })
    }
    return probeBadge({
      ok: false,
      code: code ?? 'UNCLASSIFIED',
      // **不给分类**：`probeBadge` 会把缺分类按 `unknown` 处理（"别乱重试"），
      // 而不是替它猜一个 `transient`。
      message: h.message,
    })
  }
  return probeBadge(verdict ?? null)
}

// ────────────────────────────────────────── ③ 凭证：只有元数据，永远没有值

/**
 * 一条凭证在列表里长什么样。
 *
 * ## 这个函数的结构本身就是纪律
 *
 * 它从输入里**逐字段取**（ref/purpose/scheme/时间戳），而不是展开整行——
 * 于是即使响应里混进了 `value` / `blob` / `token`，也**结构上不可能**出现在
 * 返回值里。用例把这一点钉住：喂一条带 `value` 的输入，断言整个视图的
 * JSON 里不含那个值。
 *
 * `rotatedAt: null` 是**从未轮换**，不是"轮换失败"——两者都显示成空
 * 会让用户以为自己轮换过。
 */
export interface SecretRowView {
  /** 引用名；缺失时为空串（**不猜一个名字**）。 */
  ref: string
  refText: string
  purposeText: string
  schemeText: string
  /** 轮换状态：`null` 表示从未轮换。 */
  rotatedText: string | null
  timesText: string
}

/** 只取 `YYYY-MM-DD HH:mm` 这一段；格式不认识就原样返回（不编造时间）。 */
function shortTime(v: unknown): string | null {
  const s = str(v)
  if (s === null) return null
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(s)
  return m === null ? s : `${m[1]} ${m[2]}`
}

export function secretRowView(entry: unknown): SecretRowView {
  const e = obj(entry) ?? {}
  const ref = str(e.ref) ?? ''
  const purpose = str(e.purpose)
  const scheme = str(e.scheme)
  const created = shortTime(e.createdAt)
  const updated = shortTime(e.updatedAt)
  const rotated = shortTime(e.rotatedAt)

  const times: string[] = []
  if (created !== null) times.push(`录入于 ${created}`)
  if (updated !== null && updated !== created) times.push(`更新于 ${updated}`)

  return {
    ref,
    refText: ref === '' ? '（响应里没有引用名）' : ref,
    purposeText: purpose ?? '（没有用途说明）',
    schemeText: scheme ?? '（没有保护方案信息）',
    rotatedText: rotated === null ? null : `最近轮换：${rotated}`,
    timesText: times.length === 0 ? '（没有时间戳）' : times.join('　'),
  }
}

/** 文件权限的核验结果。`aclVerified:false` 的**两种**原因必须分开说。 */
export interface AclView {
  tone: 'ok' | 'warn' | 'muted'
  text: string
}

/**
 * `aclVerified` / `aclExists` / `aclNote` → 一句话。
 *
 * `product/secrets.mjs` 把 `aclExists` 单独回出来，就是为了区分：
 *   · `aclVerified:false` + `aclExists:false` → 全新安装还没建文件，
 *     **没什么可保护的**（不是告警；把它渲染成黄色警告会让用户去查一个不存在的问题）
 *   · `aclVerified:false` + `aclExists:true`  → 文件在，但没能确认它只有所有者可读
 *     （**这才是要提醒的**：写入会重置权限，所以这确实可能发生）
 */
export function aclView(r: { aclVerified?: unknown; aclExists?: unknown; aclNote?: unknown } | null | undefined): AclView {
  const src = obj(r) ?? {}
  const note = str(src.aclNote)
  if (src.aclVerified === true) {
    return { tone: 'ok', text: '文件权限已核验（仅所有者可读）。' }
  }
  if (src.aclExists === false) {
    return { tone: 'muted', text: '密钥库文件还不存在，因此没有可核验的权限（全新安装的常态，不是故障）。' }
  }
  if (src.aclExists === true) {
    return {
      tone: 'warn',
      text: `密钥库文件在，但**没能确认**它只有所有者可读。${note ?? ''}`.trim(),
    }
  }
  return { tone: 'warn', text: `没能核验密钥库文件的权限，而且响应里没有说文件是否存在。${note ?? ''}`.trim() }
}

/** 一次写入（新增/轮换）的回执视图。 */
export interface SecretWriteView {
  op: 'put' | 'rotate'
  kind: 'written' | 'rotated'
  headline: string
  detail: string
  acl: AclView
}

/**
 * 写回执。
 *
 * 轮换的后果必须**说出来**：`spec §6.7` 的语义是"只影响轮换之后创建的 Run"。
 * 一句"已轮换"会让用户以为正在跑的那次运行也换了钥匙。
 *
 * `aclVerified:false` 时**仍然算成功**（凭证已经写进去了；此时报"失败"会让人
 * 以为要重做一遍），但"没核验过"这件事必须出现在回执里——
 * 一条默认静默的检查等于没有检查。
 */
export function secretWriteResultView(op: 'put' | 'rotate', result: unknown): SecretWriteView {
  const r = obj(result) ?? {}
  const meta = obj(r.secret)
  const ref = str(meta?.ref) ?? '（响应里没有引用名）'
  const acl = aclView(r)
  if (op === 'rotate') {
    return {
      op, kind: 'rotated',
      headline: `已轮换凭证 ${ref}`,
      detail: '引用名不变，值已替换。**只影响轮换之后创建的运行**：已经在跑的那一次仍然用它开始时取到的那把。',
      acl,
    }
  }
  return {
    op, kind: 'written',
    headline: `已保存凭证 ${ref}`,
    detail: '同名的引用是**更新**（值被替换），不会新建第二条。',
    acl,
  }
}

/** 一次删除的回执视图。 */
export interface SecretDeleteView {
  kind: 'removed' | 'already-absent'
  headline: string
  detail: string
  acl: AclView
}

/**
 * 删除回执。
 *
 * `removed:false`（引用本来就不存在）**不是错误**：删除的意图是"让它不存在"，
 * 而它已经不存在了。把它渲染成红色失败，用户会重试一次注定同样结果的删除。
 * 代码里刻意与轮换分开（轮换一个不存在的引用**是**错误，见 `secretErrorView`）。
 */
export function secretDeleteResultView(result: unknown): SecretDeleteView {
  const r = obj(result) ?? {}
  const acl = aclView(r)
  if (r.removed === false) {
    return {
      kind: 'already-absent',
      headline: '这个引用本来就不存在（不是失败）',
      detail: '删除是幂等的：目标是「让它不存在」，而它已经不存在了。这次没有删掉任何东西，**不需要重试**。',
      acl,
    }
  }
  if (r.removed !== true) {
    // 既不是 true 也不是 false：响应里没有这个字段。**不猜**是哪一种。
    return {
      kind: 'already-absent',
      headline: '响应里没有说删掉了没有',
      detail: '这既不是"删掉了"也不是"本来就不存在"：**不猜**。请刷新列表确认当前状态。',
      acl,
    }
  }
  return {
    kind: 'removed',
    headline: '已删除引用',
    detail: '这**不会**去检查有没有模型档案在用这个引用——用它取凭证的档案会在运行时取不到，而不是在这里报错。',
    acl,
  }
}

/** 凭证管理面的错误视图。`kind` 决定下一步动作，`code` 保留后端原码。 */
export interface SecretErrorView {
  status: number | null
  code: string | null
  kind: 'store-unavailable' | 'not-found' | 'bad-request' | 'write-failed' | 'unclassified'
  headline: string
  detail: string
  action: string
  field: string | null
}

/** 后端码 → 类别。**合并其中任何两个都会让两种修法看起来一样。** */
const SECRET_CODE_KIND: Record<string, SecretErrorView['kind']> = {
  SECRET_ADMIN_STORE_UNAVAILABLE: 'store-unavailable',
  SECRET_NOT_FOUND: 'not-found',
  SECRET_REF_INVALID: 'bad-request',
  SECRET_VALUE_EMPTY: 'bad-request',
  SECRET_STORE_WRITE_FAILED: 'write-failed',
}

/** 类别 → 该做什么。这张表就是"用户下一步"的全部来源。 */
const SECRET_KIND_ACTION: Record<SecretErrorView['kind'], string> = {
  // 本机的问题：**不要去重新录入一把其实好端端躺着的钥匙**
  'store-unavailable': '这是**本机密钥库**的问题（布局不合法 / 平台不支持 / 明文后端被拒 / 文件坏）。不要把它当成"这把钥匙不存在"，也不要重新录入一遍——录入会同样失败。',
  'not-found': '要轮换的那个引用从来没录入过。改用「新增凭证」把它建出来；轮换只对已存在的引用有意义（删除才是幂等的）。',
  'bad-request': '请求里的引用名或值不合法。判据在密钥库（`assertSecretRef` 是唯一判据），请按后端给出的说明改，不要在客户端再猜一套规则。',
  'write-failed': '写入密钥库失败（磁盘/权限）。凭证**没有**写进去，重试之前先确认密钥库文件所在目录可写。',
  unclassified: '这个码没有对应的界面说明——**不猜**它属于上面哪一类。请看详细信息与中枢日志。',
}

const SECRET_KIND_HEADLINE: Record<SecretErrorView['kind'], string> = {
  'store-unavailable': '密钥库不可用（不是「这个引用不存在」）',
  'not-found': '没有这个引用',
  'bad-request': '请求不合法',
  'write-failed': '写入失败',
  unclassified: '未归类的失败',
}

/**
 * 凭证操作失败 → 可渲染的错误。
 *
 * 这正是本仓库反复记的那条纪律的落点：**后端加了码、前端还是笼统提示，
 * 那条码就等于没加**。所以 `code` 原样保留、类别由码决定、
 * 而 `field`/`hint` 来自 PRT-252 的结构化响应体（`panelErrorFrom`）。
 */
export function secretErrorView(e: unknown): SecretErrorView {
  const p = panelErrorFrom(e)
  const kind = p.code === null ? 'unclassified' : (SECRET_CODE_KIND[p.code] ?? 'unclassified')
  const parts = [
    p.text,
    p.hint,
    p.code === null ? null : `服务端码：${p.code}`,
    p.status === null ? null : `HTTP ${p.status}`,
  ].filter((x): x is string => typeof x === 'string' && x !== '')
  return {
    status: p.status,
    code: p.code,
    kind,
    headline: SECRET_KIND_HEADLINE[kind],
    detail: parts.join('  '),
    action: SECRET_KIND_ACTION[kind],
    field: p.field,
  }
}

/** 密钥库自检视图。三态：可用 / 明确不可用 / 读不出结论。 */
export interface SecretStatusView {
  kind: 'available' | 'unavailable' | 'unknown'
  available: boolean
  headline: string
  detail: string
  code: string | null
  /**
   * 条目数文案。**`count: null` 与 `count: 0` 必须不同**：
   * 前者是"自检没给计数"，后者是"确实一条都没有"。
   */
  countText: string
}

/**
 * 自检结果 → 视图。
 *
 * `GET /api/secrets/status` 的失败是 **HTTP 200 + `ok:false`**（它是"报告"，
 * 不是一次失败请求）。读成"空"就完了：一次密钥库故障会显示成
 * "你还没有任何凭证"，用户会照着提示重新录入。
 */
export function secretStatusView(status: unknown): SecretStatusView {
  const s = obj(status)
  if (s === null) {
    return {
      kind: 'unknown', available: false,
      headline: '读不出密钥库状态',
      detail: '没有收到自检结果。**这不等于「密钥库是好的」，也不等于「密钥库里没有凭证」**——两件事都不知道。',
      code: null, countText: '条目数未知',
    }
  }
  if (s.ok !== true) {
    const code = str(s.code)
    const message = str(s.message)
    return {
      kind: 'unavailable', available: false,
      headline: '密钥库不可用（不是「没有凭证」）',
      detail: [message ?? '自检说密钥库打不开。', code === null ? null : `服务端码：${code}`]
        .filter((x): x is string => x !== null).join('  '),
      code,
      countText: '条目数未知（密钥库打不开）',
    }
  }
  const protection = obj(s.protection)
  const scheme = str(protection?.scheme)
  const acl = aclView(s)
  return {
    kind: 'available', available: true,
    headline: '密钥库可用',
    detail: [scheme === null ? '保护方案未知' : `保护方案：${scheme}`, acl.text].join('  '),
    code: str(s.code),
    countText: typeof s.count === 'number' ? `已录入 ${s.count} 条` : '条目数未知（自检没有给计数）',
  }
}

// ────────────────────────────────────────── ④ 配置包导入计划

/**
 * `POST /api/config-bundle/plan` 的计划视图。
 *
 * 与 `modelSettings.ts` 的 `importPlanView` **不是**同一份计划：那边是
 * `model-migration.mjs` 的 `toCreate/toUpdate/refused`，这边是
 * `runtime/contracts/config-bundle.mjs` 的 `actions/summary`。两份都读一遍
 * 才是"看得懂"的，混用会让字段名对不上而**静默**少列一行。
 *
 * 两个容易漏的点：
 *   · `keptLocal`（策略 `keep` 下因为内容不同被跳过）与 `conflicts` 相加
 *     才是"包里有但没进去"的总数。只报 `conflicts` 时，`keep` 策略看起来
 *     是"零冲突、全成功"，而实际一条都没导入。
 *   · `applicable` 由服务端算（`assertApplicable`）——界面不重算一遍
 *     "有没有冲突/悬空引用"，两份判定必然漂移。
 */
export interface BundlePlanView {
  applicable: boolean
  headline: string
  lines: string[]
  blocked: string | null
}

export function bundlePlanView(plan: unknown, applicable: unknown): BundlePlanView {
  const p = obj(plan)
  if (p === null) {
    return { applicable: false, headline: '没有导入计划', lines: [], blocked: '先粘贴或选择一个配置文件，然后点「预演导入」。' }
  }
  if (p.ok !== true) {
    const errors = Array.isArray(p.errors)
      ? p.errors.filter((x): x is string => typeof x === 'string' && x !== '')
      : []
    return {
      applicable: false,
      headline: '这个包不能导入',
      lines: [],
      blocked: errors.length > 0 ? errors.join('；') : (str(p.message) ?? '包的内容不适用。'),
    }
  }

  const summary = obj(p.summary) ?? {}
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const willWrite = num(summary.willWrite)
  const conflicts = num(summary.conflicts)
  const keptLocal = num(summary.keptLocal)
  const needsCredential = num(summary.needsCredential)
  const dangling = Array.isArray(summary.danglingRefs) ? summary.danglingRefs.length : 0

  const lines: string[] = []
  if (willWrite > 0) lines.push(`将写入 ${willWrite} 条（新建 + 更新）`)
  if (conflicts > 0) lines.push(`有 ${conflicts} 处冲突未决`)
  if (keptLocal > 0) lines.push(`包里有 ${keptLocal} 条与本机不同、**不会导入**（保留本机现有设置）`)
  if (needsCredential > 0) lines.push(`其中 ${needsCredential} 条档案需要凭证：导入之后要在「凭证」页录入对应引用，否则它们跑不起来`)
  if (dangling > 0) lines.push(`有 ${dangling} 条绑定引用了不存在的档案`)
  if (lines.length === 0) lines.push('包里没有需要变更的内容')

  const gate = obj(applicable)
  if (gate === null || gate.ok !== true) {
    return {
      applicable: false,
      headline: '这份计划还不能执行',
      lines,
      blocked: (gate === null ? null : (str(gate.reason) ?? str(gate.code))) ?? '服务端没有说明为什么不能执行。',
    }
  }

  return {
    applicable: true,
    // 有可写入项才是"可以导入"；一条都不写时**不能**说可以导入——
    // 那会让用户以为这份包带来了什么。
    headline: willWrite > 0 ? '可以导入' : '包里没有要写入的内容',
    lines,
    blocked: null,
  }
}

/** 迁移计划的视图：**复用** `modelSettings.ts` 的 `importPlanView`（同一份后端计划形状）。 */
export function migrationPlanView(plan: unknown): ImportPlanView {
  // `planModelMigration` 的产物就是 `ImportPlanLike`：`toCreate`/`toBind`/
  // `needsAttention`/`refused`/`conflicts`/`ok`/`code`/`message`。
  // 这里只做一次形状收窄，**不重新解释字段**——两份读法必然漂移。
  return importPlanView(obj(plan) as ImportPlanLike | null)
}

// ────────────────────────── ⑤ 改档案时「留空 secretRef」到底意味着什么

/** 一次"保存档案时 `secretRef` 留空"的判定。 */
export interface SecretRefEditView {
  /** 这次保存会不会**清掉**这条档案已有的凭证引用。 */
  clearsCredential: boolean
  /** 需要用户显式确认后才允许保存（默认拦住）。 */
  needsExplicitClear: boolean
  notice: string
  tone: 'muted' | 'warn'
}

/**
 * 「留空 = ？」，这个问号是本页最危险的一处。
 *
 * ## 服务端的真实语义（不是猜的）
 *
 * `runtime/contracts/model.mjs` 的 `validateProfile`：
 *
 *     let secretRef = null
 *     if (profile.secretRef !== undefined && profile.secretRef !== null && profile.secretRef !== '') { … }
 *
 * 而 `model-store.mjs` 的 `update` 是一句 **UPDATE … SET secret_ref=?**，落的就是
 * 这个 `p.secretRef`。也就是说：**请求里不带 `secretRef`，档案的引用就被写成 `null`**。
 * 留空 ≠ 保持原样，留空 = **删掉引用**。
 *
 * ## 为什么这行字必须被钉住
 *
 * 界面上原本写着「留空 = 不改动本机引用」——**那句话是反的**，而且反得正好在
 * 最坏的方向上：用户照着它做（改个显示名 → 保存），得到的是"档案看起来配好了、
 * 但运行时取不到凭证"。这不是把一件事显示错了，而是**引导用户去销毁一个东西**。
 *
 * 更麻烦的是列表里的 descriptor **不含 `secretRef`**（`toModelDescriptor` 刻意只给
 * `hasCredential`，引用名本身也是可枚举的攻击面）。于是编辑框**无法预填**——
 * 除非用户自己记得引用名并重新敲一遍，任何一次保存都会清掉它。
 *
 * 所以这里有凭证的档案默认**拦住**：必须显式勾选"确认清除"才允许保存。
 * 「本来就没有凭证」的档案不算清除（`hasCredential:false`），
 * 否则每一次新建都要先勾一个毫无损失的确认框——那会把确认框训练成无脑点击。
 */
export function secretRefEditView(input: { hasCredential: boolean; secretRefInput: string }): SecretRefEditView {
  if (input.secretRefInput.trim() !== '') {
    return {
      clearsCredential: false,
      needsExplicitClear: false,
      tone: 'muted',
      notice: '保存会用这个引用名**替换**档案上的凭证引用（引用名换了，档案指的那把钥匙也就换了）。',
    }
  }
  if (!input.hasCredential) {
    return {
      clearsCredential: false,
      needsExplicitClear: false,
      tone: 'muted',
      notice: '留空 = 这条档案不引用任何凭证（本地模型或不需要鉴权的端点就是这样）。',
    }
  }
  return {
    clearsCredential: true,
    needsExplicitClear: true,
    tone: 'warn',
    notice: '⚠️ 留空 = **清掉**这条档案上的凭证引用：服务端把「没有 secretRef」当成 null 落库，' +
      '不是「保持原样」。清掉之后这条档案在运行时会取不到凭证。' +
      '要保留它，请先取消编辑、去「凭证库」页核对引用名，再在这里填回来——' +
      '列表**不显示**引用名（只给「有没有」），所以编辑框里永远是空的。',
  }
}

// ────────────────────────────────────────── ⑥ 岗位解析链的形状适配

/** 一次岗位解析的结果视图。`entries` 由 `chainView` 渲染（不可用项也显示）。 */
export interface ResolutionView {
  ok: boolean
  code: string | null
  message: string | null
  entries: ChainEntryView[]
}

/**
 * `GET /api/model-bindings/resolve` 的产物 → 可渲染的解析链。
 *
 * ## 这个适配器为什么必须存在（一个真实的字段名错配）
 *
 * 服务端（`orchestrator/model-binding/index.mjs` 的 `resolveModelChain`）给的是：
 *
 *     chain:   [{ id, role, order, displayName, provider, model, hasCredential, … }]
 *     skipped: [{ id, role, order, code, message }]
 *
 * 而 `chainView` 认的是 `{ profileId, displayName, skipped, reason }`。
 * 把 `chain` **直接**丢给 `chainView` 会发生什么：
 *
 *   · 可用项：`displayName` 侥幸同名，标签还对；但 `reason` 取不到，
 *     于是每一项的备注都是空的（"这条候选是谁"没了）；
 *   · **被跳过的那一项：`id` 与 `message` 两个字段名都不对**，
 *     于是它渲染成「（未知档案）」且没有原因——而它恰恰是用户最需要看到的那条
 *     （"我的备用模型为什么不生效"）。
 *
 * 这种错不会报错、不会崩，只会安静地少一样东西。
 *
 * 所以这里显式映射，并由用例把"不映射就错"这件事钉住：
 * 同一份输入，`chainView(res.skipped)` 的标签是「（未知档案）」、备注是 `null`，
 * 而 `resolutionView(res).entries` 里那条是真实的 id + 服务端给的原因。
 *
 * `ok:false`（主档案解析不出来）也是一种**正常响应**（HTTP 200）：
 * 它不是"读失败"，而是"这条绑定现在跑不起来"——两者要分开说。
 */
export function resolutionView(res: unknown): ResolutionView {
  const r = obj(res)
  if (r === null) {
    return { ok: false, code: null, message: '解析结果不是对象。', entries: [] }
  }
  const rawChain = Array.isArray(r.chain) ? r.chain : []
  const rawSkipped = Array.isArray(r.skipped) ? r.skipped : []

  const entries: ChainEntryLike[] = []
  for (const c of rawChain) {
    const e = obj(c)
    if (e === null) continue
    // 备注是**事实**（这条候选是谁），不是编出来的"为什么选它"。
    const provider = str(e.provider) ?? '（未填供应商）'
    const model = str(e.model) ?? '（未填模型）'
    const cred = e.hasCredential === false ? ' · 没有凭证' : ''
    entries.push({
      profileId: str(e.id),
      displayName: str(e.displayName),
      skipped: false,
      reason: `${provider}/${model}${cred}`,
    })
  }
  for (const s of rawSkipped) {
    const e = obj(s)
    if (e === null) continue
    // 不可用项**必须**显示并带上原因：只显示能用的会让用户以为链条比实际短。
    entries.push({
      profileId: str(e.id),
      displayName: null,
      skipped: true,
      reason: str(e.message) ?? str(e.code),
    })
  }

  return {
    ok: r.ok === true,
    code: str(r.code),
    message: str(r.message),
    entries: chainView(entries),
  }
}
