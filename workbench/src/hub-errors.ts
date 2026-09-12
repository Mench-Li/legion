// workbench/src/hub-errors.ts
// ============================================================================
// 中枢错误的**结构化**载体
//
// ## 为什么需要这个文件（这是一处真实的断链）
//
// `api.ts` 的 `hubPost` 原本这样处理失败：
//
//     if (!res.ok) {
//       const text = await res.text().catch(() => '')
//       throw new Error(`${res.status}${text ? `：${text}` : ''}`)
//     }
//
// 它把响应体**压成了一句字符串**。而后端（PRT-252）明明返回了：
//
//     { error, code, field, hint, candidates }
//
// 于是 `field`（该落到哪个输入框）、`hint`（下一步做什么）、`candidates`
// （实际登记过的供应商有哪些）**在到达界面之前就没了**。
//
// 这正是本仓库反复记过的那条：
//
//   **后端加了码、前端还是笼统提示 —— 那条码就等于没加。**
//
// 而且它比"没加"更坏一点：`code`/`field` 在后端**有测试守着**，
// 所以看起来是"已经做了"。链路上唯一少的那一环，在两者之间。
//
// ## 设计约束
//
// ① **消息文案的形态保持不变**（`${status}：...`），但内容有一处**刻意的变化**：
//    * 响应体**不是** JSON（HTML 错误页、纯文本）→ 与旧行为**逐字相同**；
//    * 响应体**是** JSON → 旧行为把**整段 JSON 原样**塞进界面
//      （`400：{"ok":false,"error":"没有已登记的供应商…","code":"…"}`），
//      现在改用其中可读的 `error` 字段（`400：没有已登记的供应商…`）。
//    这是界面文案的一处改善，因此**必须被说出来**，而不是声称"完全没变"——
//    一句关于行为的错误描述，比没有描述更坏。
// ② 响应体不是 JSON 时**不编造结构**：`code`/`field` 保持 `null`。
//    把一段 HTML 错误页猜成"某个字段有问题"比什么都不说更坏。
// ③ `candidates` 只接受字符串数组。混进非字符串会让界面渲染出 `undefined`。
// ============================================================================

/** 一个带结构的中枢错误。`message` 保持 `${status}：...` 的形态（见文件头 ①）。 */
export class HubError extends Error {
  readonly status: number
  readonly code: string | null
  readonly field: string | null
  readonly hint: string | null
  readonly candidates: readonly string[]
  readonly errors: readonly string[]
  /** 完整响应体，供调用方取自己认识的字段（**不要**直接渲染它）。 */
  readonly body: unknown

  constructor(init: {
    status: number
    message: string
    code?: string | null
    field?: string | null
    hint?: string | null
    candidates?: readonly string[]
    errors?: readonly string[]
    body?: unknown
  }) {
    super(init.message)
    this.name = 'HubError'
    this.status = init.status
    this.code = init.code ?? null
    this.field = init.field ?? null
    this.hint = init.hint ?? null
    this.candidates = init.candidates ?? []
    this.errors = init.errors ?? []
    this.body = init.body
  }
}

/** 把任意一个响应体**谨慎地**读成结构。不认识的一律给 null，不猜。 */
export function hubErrorFromBody(status: number, rawText: string, parsed: unknown): HubError {
  const b = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
    ? parsed as Record<string, unknown>
    : null

  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

  // 消息：优先用后端的 `error`，否则退回原始正文（可能是一段 HTML 错误页）。
  const message = str(b?.error) ?? rawText
  const flat = `${status}${message ? `：${message}` : ''}`

  const candidates = Array.isArray(b?.candidates)
    ? (b!.candidates as unknown[]).filter((c): c is string => typeof c === 'string' && c !== '')
    : []
  const errors = Array.isArray(b?.errors)
    ? (b!.errors as unknown[]).filter((c): c is string => typeof c === 'string' && c !== '')
    : []

  return new HubError({
    status,
    // 形态与旧行为一致（`${status}：...`）；JSON 响应时用可读的 `error` 而非整段 JSON。
    message: flat,
    code: str(b?.code),
    field: str(b?.field),
    hint: str(b?.hint),
    candidates,
    errors,
    body: parsed,
  })
}

/** `HubError` 的最小结构面（供不引入类的调用方使用）。 */
export interface HubErrorLike {
  status?: number
  message?: string
  code?: string | null
  field?: string | null
  hint?: string | null
  candidates?: readonly string[]
}

/**
 * 从任意错误里取结构化信息。
 *
 * 非 `HubError`（网络异常、超时、代码 bug）时 `code`/`field` 为 `null`，
 * `message` 原样带出——**不假装它是一个中枢错误**。
 */
export function asHubError(e: unknown): HubErrorLike {
  if (e instanceof HubError) return e
  if (e !== null && typeof e === 'object' && 'status' in e && typeof (e as HubErrorLike).status === 'number') {
    return e as HubErrorLike
  }
  return { status: undefined, message: e instanceof Error ? e.message : String(e), code: null, field: null, hint: null, candidates: [] }
}

/**
 * 一句给人看的错误说明。
 *
 * 有 `hint` 时把它接在后面——`hint` 回答的是"下一步做什么"，
 * 而光有一句"没有已登记的供应商「openai」"用户仍然不知道该干什么。
 */
export function hubErrorText(e: unknown): string {
  const h = asHubError(e)
  const base = h.message ?? '未知错误'
  if (typeof h.hint === 'string' && h.hint !== '' && !base.includes(h.hint)) {
    return `${base} ${h.hint}`
  }
  return base
}
