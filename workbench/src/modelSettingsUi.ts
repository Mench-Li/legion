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
// ③ **档案上留空 `secretRef` 的两种含义**（`secretRefEditView`）：服务端把"没带
//    这个字段"落成 `null` ⇒ **留空 = 清掉引用**，不是"保持原样"。
//
// ★★ 2026-10-12：这里原本还有一个 ③ —— **写回执的两种"没变化"**（删一个不存在的
//    引用是幂等 `removed:false`，轮换一个不存在的引用是错误 404 `SECRET_NOT_FOUND`）。
//    它随「🔑 凭证库」页签一起删掉了（那一族视图只被那个面板用），
//    但那条**后端语义**没有变，判据留在 `team-hub/secret-routes.test.mjs` 里。
//
// ## 不猜
//
// 本模块不发明任何码、状态码或计数：拿不到就 `null` / 一个显式的 `unknown` 分支，
// 并在文案里说清"不知道"。（少一个状态与多一个编出来的状态，代价一样大。）
// ============================================================================

import { asHubError } from './hub-errors.ts'
import { chainView, fieldErrorFrom, probeBadge } from './modelSettings.ts'
import type { ChainEntryLike, ChainEntryView, ProbeBadge, ProbeVerdictLike } from './modelSettings.ts'

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

// ────────────────────────────────────────── ③ 凭证：面板已拆 ⇒ 视图随之删除

// ★★ 2026-10-12：「🔑 凭证库」页签（`SecretVaultPanel.tsx`）拆除了，这一节原本的
//   六个视图 —— `secretRowView` / `aclView` / `secretWriteResultView` /
//   `secretDeleteResultView` / `secretErrorView` / `secretStatusView` —— **只被它一个消费者用**，
//   因此一并删除；六个接口（`SecretRowView` / `AclView` / `SecretWriteView` /
//   `SecretDeleteView` / `SecretErrorView` / `SecretStatusView`）与只服务于 `secretRowView`
//   的 `shortTime` 同去。
//
//   为什么拆：架构决定变了 —— 钥匙由用户在「供应商与模型」页**填一次**，Legion 存下来后
//   写进 DSH（运行时），用户**不需要再看见**那个库。这一页是"写进 DSH"还没接通时的脚手架。
//
//   ⚠ 删的只是**界面这一层**：底层存储与后端路由原样保留（写入正要用它），
//     所以这些视图描述的**后端语义**（删除幂等、`SECRET_*` 码、`aclExists` 的两种 false）
//     仍然成立 —— 它们现在由 `team-hub/secret-routes.test.mjs`（含 `BUG-029` 的判据）守着，
//     而不是由这一层界面守着。
//
//   ⑤ 的 `secretRefEditView` 与这一节无关（它讲的是**档案**上留空 `secretRef` 意味着什么，
//   消费者是 `ModelProfilesPanel.tsx`），因此保留。

// ★★ 2026-10-12：这一节原本是「④ 配置包导入计划」（`BundlePlanView` / `bundlePlanView`），
//   随「配置包」（PRT-508）整体删除。理由不是"没人用"，而是**它在单机部署里没有用**：
//   包里那 27 行（模型档案 + 岗位绑定）本来就在 `team.db` 里 ⇒ 每一次整库备份都已经带着它们；
//   而凭证值从来不在包里（在本机 DPAPI 密钥库）⇒ 换机器无论如何都要重填。
//   现在"配置能不能搬"由**备份/恢复**负责（`product/server/backup.mjs`）。
//
//   上一轮这里还删过一个 `migrationPlanView`（「配置迁移」PRT-506 的视图）：
//   它把 `agent_models` 搬成岗位绑定，而绑定当时没有活的消费者。
//   两份视图的删除是同一件事的两半，理由见 `docs/bugs/BUG-026` / `BUG-027`。


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
      '要保留它，请先取消编辑——引用名在界面上**不显示**（只给「有没有」），所以编辑框里永远是空的，' +
      '填不回来；留空保存就会清掉它。',
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
