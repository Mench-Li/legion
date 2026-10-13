import { useEffect, useState } from 'react'
import { hubRequest } from '../api'

// ★ 这一页读写的是 **Legion 自己的模型库**（`/api/model-providers`），
//   不再经过 DSH 的 `/api`（那条路要宿主自己的浏览器会话，见 docs/DECISION-legion-owns-model-config.md）。
//   用户在这一页看到、改动的东西都属于 Legion；把它同步给引擎是 Legion **运行时**的事
//   （P3 的物化，默认关；见页面底部的说明）。
//
//   为什么要写这段注释：这一页**曾经**是"DSH 配置页的代理"（`llm/listConfigurableProviders` +
//   `settings/describe` + `settings/mutate` + `credentials/set`），
//   于是"谁能打开这一页"取决于"谁能登进 DSH"。产品的边界是 Legion，不是引擎。

interface Provider {
  id: string
  displayName: string
  api: string | null
  baseURL: string | null
  /**
   * ★★ **这里没有 `secretRef`**（2026-10-12，BUG-028 已修）。
   *
   *   服务端不再把引用名发出来（"引用名也是可枚举的攻击面"，见 `model-store.mjs` 文件头）。
   *   界面要表达"这条引用了凭证"用下面的 `credentialRequired` / `credential.hasRef`；
   *   要写新钥匙则把**值**交给服务端（`credentialValue`），由它决定写进哪个槽位 ——
   *   因为那可能是个客户端**算不出**的名字（从 DSH 导进来的 `apiKeyEnv`，两侧靠它对齐）。
   *
   *   类型里留一个 `secretRef` 字段会让下一个人以为它还在，而那正是这次要拆掉的东西。
   */
  /** 这条供应商**是否引用了一个凭证**（等价于"库里的 secretRef 非空"，但不给名字）。 */
  credentialRequired?: boolean
  /**
   * ⚠ **这是 P1 从 DSH 导入的标记**，记的是"DSH 那边说它配过"，
   *  **不是**"本机密钥库里有这把钥匙"。界面不许用它下结论（BUG-023）。
   */
  credentialConfigured: boolean
  /**
   * ★ hub **核验过**的凭证状态：`none | ready | missing | unavailable`。
   *   `unavailable` 是"读不到密钥库，因此无法判断"，**不是**"没有"。
   *   老 hub（没这个字段）时保持 `undefined` ⇒ 界面说"无法核验"，也不猜。
   *
   *   ★★ **这里没有引用名**（2026-10-12）：档案那一族已经改成只发 `hasRef`，
   *   引用名是可枚举的攻击面。供应商这一族的 `secretRef` 还在（见 `docs/bugs/BUG-028`），
   *   但界面**不许**依赖核验结果里的名字 —— 它只说"引用了某把钥匙"。
   */
  /**
   * ★★ hub **核验过**的凭证状态：`none | ready | missing | unavailable`。
   *
   *   ★ 这里没有引用名（2026-10-12）：档案那一族已经改成只发 `hasRef`，
   *     供应商这一族也不再整行原样返回 —— 名字是可枚举的攻击面（BUG-028）。
   *
   *   ★★ `runtime` 是**另一件不同的事**（同日）：`state` 问的是 **Legion 自己的库**，
   *     而真正让 agent 跑起来的钥匙来自 **DSH 自己的**凭证文件
   *     （派工只传 `agentOptions: { provider, model }`，一个凭证字段都没有；
   *       Legion → DSH 的写路径"物化"门也是关的）。
   *      只有前一格时，用户会以为"配在这里就够了"。
   *      它同样**不含引用名**，只给结论、来源与一句说明。
   */
  credential?: {
    state?: string
    hasRef?: boolean
    detail?: string | null
    runtime?: { state?: string; layer?: string | null; detail?: string }
  }
  /**
   * ★ `runtimeType`：跟这个供应商说话用哪个运行时。
   *   它**已经上移到供应商一份**（原来每条档案各写一遍）—— 所以模型档案那边不用填。
   */
  runtimeType?: string | null
  /**
   * ★ 档案对账（`team-hub/profile-derivation.mjs`）：
   *   `missing` = 这个供应商清单里**还没有档案**的模型数。保存时已经自动生成，
   *   所以它**大于 0 只意味着"那次没跑成"**（历史数据 / 某条 id 冲突 / 中枢没接档案表），
   *   面板据此显示「补齐」而不是「生成」。
   */
  profiles?: { existing: number; missing: number; orphaned: number }
  models: { id: string; name?: string }[]
  source: string
  version: number
}

/** 派生读数（保存/导入的响应里带的，或「补齐」端点的返回）。 */
interface DeriveResult {
  ok?: boolean
  code?: string
  message?: string
  summary?: string
  created?: string[]
  failed?: { id: string; message?: string }[]
  existing?: string[]
  conflicts?: { model: string; reason?: string }[]
  orphaned?: { profileId: string; model: string }[]
  runtimeType?: string
  runtimeTypeFrom?: string
  plan?: { create?: { id: string; model: string; displayName: string }[] }
  dryRun?: boolean
}

/** 凭证状态 → 界面读法（与 `team-hub/credential-status.mjs` 同口径）。 */
function credentialView(p: Provider): { cls: string; label: string; title: string; ready: boolean } {
  const state = p.credential?.state
  // ★★ 2026-10-12（BUG-028 收口）：核验结果与供应商行里**都没有引用名**了。
  //   界面只需知道"这一条引用了某把钥匙"（`hasRef` / `credentialRequired`），
  //   而不需要知道它叫什么 —— 名字是可枚举的攻击面，而且客户端算不出它
  //   （可能是个从 DSH 导进来的名字）。所以这里不再拼名字，只描述状态。
  const hasRef = p.credential?.hasRef === true || p.credentialRequired === true
  if (state === 'ready') {
    return { cls: ' ready', label: '密钥已核验', title: `${hasRef ? '本机密钥库里已有这条凭证' : '这条凭证已核验'} · ${p.models.length} 个模型`, ready: true }
  }
  if (state === 'missing') {
    return {
      cls: ' missing', label: '密钥不在库里', ready: false,
      title: '这一条引用了凭证，但本机密钥库里**没有**它：钥匙从未存进来，或者它被删掉了（面板会显示"已配置"是另一件事，那是从运行环境导入的标记）',
    }
  }
  if (state === 'unavailable') {
    return {
      cls: ' unknown', label: '无法核验', ready: false,
      title: '读不到本机密钥库，因此**无法判断**这条凭证在不在（这不等于"没有"）',
    }
  }
  if (state === 'none') {
    return { cls: ' ready', label: '无需密钥', title: `${p.models.length} 个模型 · 这个供应商没有配置凭证引用`, ready: p.models.length > 0 }
  }
  // 没有核验结果（老 hub / 请求失败）：**不猜**。
  return {
    cls: ' unknown', label: '未核验', ready: false,
    title: hasRef ? '这一条引用了凭证，但这次没有核验它在不在库里' : '还没有填密钥',
  }
}

/**
 * ★★ **运行侧**（DSH）有没有这把钥匙 → 界面读法（2026-10-12）。
 *
 * 它与 `credentialView` **并列而不是替代**，因为两者回答的是不同的问题：
 *
 *   · `credentialView`：**Legion 自己的库**里有吗（"测试连接"读的就是它）；
 *   · `runtimeKeyView`：**跑起来的那个进程**取得到吗（真正决定任务成不成）。
 *
 * 为什么这一格必须有（将军问"凭证库又是干嘛的"追问出来的）：一次实测里，
 * Legion 的库有 3 条、其中一条没有任何供应商指向它、而且 **DSH 那边根本没有**。
 * 在那之前界面只有前者的读数 —— 于是往 Legion 里录一把 DSH 没有的钥匙，
 * 面板会说"已核验"、连测试连接都可能过，**而任务跑不起来**。
 *
 *   > 一个"我这边的库里有"的读数，
 *   > 与一个"跑起来真的能用"的读数，在界面上说的是同一句话 ——
 *   > 而它们的修法是完全不同的两件事。
 *
 * 三种状态**照实说**，尤其 `absent` 不许越权说成"DSH 没有"：
 * 服务端只查了宿主环境与 DSH 凭证文件两层，**没查** DSH 启动目录的 `.env`
 * （详见 `team-hub/runtime-credential.mjs` 的文件头）。
 */
function runtimeKeyView(p: Provider): { cls: string; label: string; title: string; bad: boolean } {
  const rt = p.credential?.runtime
  const state = rt?.state
  const detail = rt?.detail ?? ''
  if (state === 'present') {
    return {
      cls: ' ready', label: '运行侧可用', bad: false,
      title: `运行时会用上它${rt?.layer ? `（来源：${rt.layer}）` : ''}。${detail}`,
    }
  }
  if (state === 'absent') {
    return {
      cls: ' missing', label: '运行侧没有', bad: true,
      title: detail || '运行侧的宿主环境与 DSH 凭证文件里都没有找到这把钥匙。',
    }
  }
  if (state === 'unknown') {
    return { cls: ' unknown', label: '运行侧未核验', bad: false, title: detail || '没读到运行侧的凭证来源，因此无法判断。' }
  }
  // `not-needed`：这条本来就不要凭证（本地模型合法）。
  if (state === 'not-needed') {
    return { cls: ' ready', label: '运行侧无需密钥', bad: false, title: '这个供应商没有配置凭证引用。' }
  }
  // 没有这一格（老 hub）：**不猜**，也不装作核验过。
  return { cls: ' unknown', label: '运行侧未核验', bad: false, title: '这次没有核验运行侧有没有这把钥匙。' }
}

interface Form { provider: string; name: string; endpoint: string; protocol: string; models: string; key: string; runtimeType: string }
const empty: Form = { provider: '', name: '', endpoint: '', protocol: 'openai-completions', models: '', key: '', runtimeType: 'dsh' }

// ★ `defaultKeyRef()` 已删除（BUG-028）：槽位名不再由客户端算 ——
//   从 DSH 导进来的行，其引用名是 DSH 侧的 `apiKeyEnv`，派生名与它不一定相同。
//   写凭证时把**值**交给服务端（`credentialValue`），由它用那一行已有的名字。
function asProviders(v: unknown): Provider[] {
  const list = (v as { providers?: unknown })?.providers
  return Array.isArray(list) ? list as Provider[] : []
}

export function DshProvidersPanel(): React.JSX.Element {
  const [providers, setProviders] = useState<Provider[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<Provider | null>(null)
  /** ★ 2026-10-12：删供应商时**要不要连钥匙一起删**（默认不勾：那是不可逆的）。 */
  const [deleteKeyWithProvider, setDeleteKeyWithProvider] = useState(false)
  const [form, setForm] = useState<Form>(empty)
  /** 密钥库的可用性（`GET /api/secrets/status`）。`null` = 还没问出来。 */
  const [keyStore, setKeyStore] = useState<{ ok: boolean; message: string } | null>(null)
  /** 服务端给的"能跑的运行时"（`GET /api/model-providers` 的 `runtimeTypes`）。 */
  const [runtimeTypes, setRuntimeTypes] = useState<{ id: string; label: string }[]>([{ id: 'dsh', label: 'dsh（Legion 原生的运行时）' }])
  /**
   * ★ 「补齐」对话框 —— **只在异常时出现**。
   *
   * 正常路径上模型档案是**保存供应商时自动生成**的（将军："添加完自动生成供应商档案，
   * 而不是 1.需要手工点生成"）。这个对话框留给两种"那次没跑成"：
   * 本轮改动之前建的历史供应商，或某一次派生部分失败（比如算出来的 id 撞了）。
   * 打开时先 `dryRun` 一次，让用户在写库前看到"将新建哪几条"。
   */
  const [repairing, setRepairing] = useState<Provider | null>(null)
  const [repairResult, setRepairResult] = useState<DeriveResult | null>(null)
  const [repairBusy, setRepairBusy] = useState(false)

  /** 把一次派生的读数说成一句人话（保存后与补齐后共用，免得两处措辞漂移）。 */
  function derivedNotice(who: string, d: DeriveResult | undefined): string {
    if (d === undefined) return `已保存「${who}」。`
    if (d.ok !== true) {
      return `已保存「${who}」，但**没能自动生成模型档案**：${d.message ?? d.code ?? '原因未知'}`
    }
    const failed = d.failed ?? []
    const conflicts = d.conflicts ?? []
    let text = `已保存「${who}」，模型档案：${d.summary ?? ''}`
    if (conflicts.length > 0) text += `；有 ${conflicts.length} 个模型的档案 id 被别人占用，没有覆盖它们`
    if (failed.length > 0) text += `；其中 ${failed.length} 条写入失败`
    if ((d.orphaned ?? []).length > 0) text += `；清单里已没有的模型有 ${(d.orphaned ?? []).length} 条档案（**没有动它们**）`
    return text + '。'
  }

  async function openRepair(p: Provider): Promise<void> {
    setRepairing(p); setRepairResult(null); setError(''); setNotice('')
    setRepairBusy(true)
    try {
      const r = await hubRequest('POST', `/api/model-providers/${encodeURIComponent(p.id)}/derive-profiles`,
        { actor: 'general', dryRun: true }) as DeriveResult
      setRepairResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setRepairBusy(false) }
  }

  async function confirmRepair(): Promise<void> {
    if (!repairing) return
    setRepairBusy(true); setError('')
    try {
      const r = await hubRequest('POST', `/api/model-providers/${encodeURIComponent(repairing.id)}/derive-profiles`,
        { actor: 'general' }) as DeriveResult
      setNotice(derivedNotice(repairing.displayName, r))
      setRepairing(null); setRepairResult(null)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setRepairBusy(false) }
  }

  async function load(): Promise<void> {
    setLoading(true); setError('')
    try {
      const raw = await hubRequest('GET', '/api/model-providers') as { providers?: unknown; runtimeTypes?: unknown }
      setProviders(asProviders(raw))
      if (Array.isArray(raw?.runtimeTypes) && raw.runtimeTypes.length > 0) {
        setRuntimeTypes(raw.runtimeTypes as { id: string; label: string }[])
      }
      // ★ 顺带问一次密钥库能不能用，**在用户动手之前**。
      //   实测（2026-10-09 真实部署）：`GET /api/secrets` → 503 `SECRETS_LAYOUT_BLOCKED`
      //   （产品目录布局未确定 ⇒ 不知道密钥库在哪）。那时"填密钥"这条路是坏的，
      //   而只在保存时吐一段 503 会让人以为是自己的输入有问题。
      //   提前显示 = 用户在打字之前就知道这一栏现在存不了。
      try {
        const s = await hubRequest('GET', '/api/secrets/status') as { status?: { ok?: boolean; message?: string } }
        setKeyStore({ ok: s?.status?.ok === true, message: String(s?.status?.message ?? '') })
      } catch { setKeyStore(null) }
    } catch (e) {
      // 失败就如实说。**不给**"连接某个服务"的按钮 —— 那是把引擎的鉴权搬到产品表面（BUG-014 第二版）。
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const set = (key: keyof Form, value: string): void => setForm(previous => ({ ...previous, [key]: value }))

  function edit(provider: Provider): void {
    setEditing(provider); setNotice(''); setError(''); setOpen(true)
    setForm({
      provider: provider.id,
      name: provider.displayName,
      endpoint: provider.baseURL ?? '',
      protocol: provider.api ?? 'openai-completions',
      models: provider.models.map(m => m.id).join('\n'),
      key: '',
      runtimeType: provider.runtimeType ?? runtimeTypes[0]?.id ?? 'dsh',
    })
  }

  async function remove(): Promise<void> {
    if (!removing) return
    setBusy(true); setError('')
    try {
      // ★★ 2026-10-12：`deleteCredential` 只在用户**明确勾选**时发。
      //   默认不删：删钥匙不可逆，而"我删了这个供应商"不等于"我要毁掉那把钥匙"
      //   （同一个引用可能正被别的东西指着）。服务端还会再拦一道（共享引用），
      //   见 `routes/model-providers.mjs` 的 DELETE 那一段。
      const r = await hubRequest('DELETE', `/api/model-providers/${encodeURIComponent(removing.id)}`, {
        actor: 'general', version: removing.version,
        ...(deleteKeyWithProvider ? { deleteCredential: true } : {}),
      }) as { credential?: { deleted?: boolean; code?: string; message?: string } }
      const c = r?.credential
      // 照实说结果：这里会出现"供应商删掉了、钥匙没删掉"这种**成功了一半**的情况
      // （比如别的供应商还指着同一把钥匙）。把它说成"已删除"会让人以为钥匙也没了。
      const suffix = c === undefined
        ? ''
        : c.deleted === true
          ? '那把钥匙也一起删掉了。'
          : `⚠ 那把钥匙**没有**删掉：${c.message ?? c.code ?? '未知原因'}`
      setRemoving(null); setDeleteKeyWithProvider(false)
      setNotice(`供应商已删除。${suffix}`); await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setRemoving(null) }
    finally { setBusy(false) }
  }

  async function discover(): Promise<void> {
    setBusy(true); setError(''); setNotice('')
    try {
      // ★★★ 2026-10-12（将军实测报的 401）：把**这条供应商的 id** 一起发出去。
      //
      //   从前只发 `baseURL` + （表单里刚填的）`apiKey`。编辑**已有**供应商时表单那格
      //   是空的（界面故意不回显值，BUG-028）⇒ **不带钥匙**去问 `GET {baseURL}/models`
      //   ⇒ 网关回 401，而界面把 401 原样显示 ⇒ 读起来像"你的钥匙不对"。
      //
      //   现在服务端拿到 id 后**自己去库里取那把钥匙**（`probeService().readCredentialValue`），
      //   于是"编辑一下已有供应商再点获取"这条正常路径不再需要手填钥匙。
      //
      //   ⚠ 表单里刚填的 `form.key` 仍然最优先 —— 那是"我要换一把"的意图。
      const result = await hubRequest('POST', '/api/model-providers/discover', {
        actor: 'general',
        provider: form.provider.trim(),
        baseURL: form.endpoint.trim(),
        ...(form.key ? { apiKey: form.key } : {}),
      }) as { models?: { id: string }[]; credentialFrom?: string; credentialNote?: string }
      const ids = (result.models ?? []).map(m => m.id)
      // ★ 如实说清这次到底带没带钥匙、从哪来的（**不含值**）——
      //   否则"读了 3 个模型"与"没带钥匙也能读"在界面上是同一句话。
      const keyNote = result.credentialFrom === 'request' ? '（用你刚填的那把钥匙）'
        : result.credentialFrom === 'vault' ? '（用了本机密钥库里存的那把）'
          : result.credentialFrom === 'unavailable' ? `（⚠ 没能取到库里那把钥匙：${result.credentialNote ?? '原因未知'}）`
            : ''
      if (!ids.length) { setNotice(`供应商未返回模型目录，请手动填写模型 ID。${keyNote}`); return }
      setForm(previous => ({ ...previous, models: [...new Set([...previous.models.split('\n').map(id => id.trim()).filter(Boolean), ...ids])].join('\n') }))
      setNotice(`已读取 ${ids.length} 个模型${keyNote}，保存供应商后生效。`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function save(): Promise<void> {
    setBusy(true); setError(''); setNotice('')
    // 服务端会告诉我们这次是"新建"还是"复活了一条同名墓碑"（见下面的 setNotice）
    let revived = false
    let derived: DeriveResult | undefined
    let savedName = ''
    try {
      const id = form.provider.trim()
      if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new Error('供应商 ID 须以小写字母开头，仅包含小写字母、数字、横线或下划线。')
      const ids = [...new Set(form.models.split('\n').map(x => x.trim()).filter(Boolean))]
      if (!ids.length) throw new Error('请至少填写一个模型 ID。')
      if (!form.endpoint.trim()) throw new Error('自定义供应商需要 API 地址。')
      const endpoint = new URL(form.endpoint.trim())
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
        throw new Error('API 地址需使用 HTTP(S)，且不能内嵌账号密码。')
      }
      // ★★ 2026-10-12（BUG-028）：面板**不再需要**引用名。
      //
      //   旧写法是 `editing?.secretRef ?? defaultKeyRef(id)` —— 它读的是响应里的引用名。
      //   读侧现在不给了（引用名是可枚举的攻击面），而且那是**对的**：
      //   槽位名该由服务端决定，因为它可能是从 DSH 导进来的 `apiKeyEnv`
      //   （两侧靠那个名字对齐），客户端**算不出**它。客户端自己算派生名的话，
      //   "新钥匙写进另一个槽位、这一行仍指旧槽位"会表现成"保存成功但认证失败"。
      //
      //   所以：值随 `credentialValue` 一起发给供应商那条写路由，由服务端落槽位。
      //   面板从头到尾不知道槽位叫什么，也不需要知道。

      // 顺序仍是**先钥匙、后供应商** —— 反过来的话"供应商写成功、钥匙写失败"
      // 会留下一条**声称有密钥、其实没有**的配置（旧实现的部分成功状态）。
      // 现在这一步与写供应商在**同一个请求**里由服务端完成，所以它天然原子：
      // 钥匙写不进去就整次失败，什么都不会落库。
      savedName = form.name.trim() || id
      const provider = {
        id, displayName: savedName, api: form.protocol,
        baseURL: form.endpoint.trim(),
        // ⚠ 这里**不发 `secretRef`**：没给 = 保留原值（`provider-store.update` 的语义），
        //   而"清掉凭证"必须走显式的 `clearCredential`。
        //   运行时在这里选一次、**记在供应商行上**：档案继承它，所以模型档案那页不用填。
        //   选项来自服务端（`runtimeTypes`），不写死。
        runtimeType: form.runtimeType,
        credentialConfigured: Boolean(form.key) || editing?.credentialConfigured === true,
        models: ids.map(modelId => editing?.models.find(m => m.id === modelId) ?? { id: modelId }),
      }
      // 用户这次填了密钥 ⇒ 把**值**交给服务端（它决定槽位）；没填 ⇒ 不带这个字段。
      const credentialValue = form.key ? form.key : null
      if (editing) {
        const r = await hubRequest('POST', `/api/model-providers/${encodeURIComponent(id)}`, {
          actor: 'general', version: editing.version, provider,
          ...(credentialValue === null ? {} : { credentialValue }),
        }) as { profilesDerived?: DeriveResult }
        derived = r?.profilesDerived
      } else {
        // ★ 同名墓碑会**复活**（服务端返回 `revived`）。说"已恢复"而不是"已保存"：
        //   用户刚做过一次删除，他需要知道"那条又回来了"，而不是"又新建了一条"。
        const created = await hubRequest('POST', '/api/model-providers', {
          actor: 'general', provider,
          ...(credentialValue === null ? {} : { credentialValue }),
        }) as { revived?: boolean; profilesDerived?: DeriveResult }
        revived = created?.revived === true
        derived = created?.profilesDerived
      }

      setForm(empty); setOpen(false); setEditing(null)
      // ★ 保存的读数里**带上"档案自动生成了几条"** ——
      //   否则用户会去找"生成"按钮（而它已经不需要了），或者以为没生效。
      setNotice((revived ? '已**恢复**同名供应商（它此前被删除过）；' : '') + derivedNotice(savedName, derived))
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const modelCount = providers.reduce((sum, p) => sum + p.models.length, 0)
  // ★ 从前这里是 `providers.filter(p => p.credentialConfigured).length` ——
  //   那个字段是**从运行环境导入的标记**，实测在一把钥匙都不在库里的机器上仍然为真，
  //   于是界面说"已填密钥"。现在只数**核验通过**的（`ready`；`none` = 本就不需要密钥）。
  const readyCount = providers.filter(p => {
    const v = credentialView(p)
    return v.ready
  }).length
  const missingCount = providers.filter(p => p.credential?.state === 'missing').length
  const unknownCount = providers.filter(p => p.credential?.state === 'unavailable').length
  // ★★ 运行侧那一格的两个计数（2026-10-12）。它们才是"任务能不能跑"的读数：
  //   上面那两个数说的是 Legion 自己的库。
  const runtimeAbsent = providers.filter(p => p.credential?.runtime?.state === 'absent')
  const runtimeUnknownCount = providers.filter(p => p.credential?.runtime?.state === 'unknown').length

  return <div className="set-panel dsh-providers-panel">
    <div className="model-config-intro"><div><h2>模型</h2><p>填入模型供应商的 API 密钥即可使用其模型。配置适用于所有空间。</p></div><button className="btn" disabled={loading || busy} onClick={() => void load()}>刷新配置</button></div>
    {loading && <p>正在读取模型配置…</p>}
    {error && <div className="set-notice bad" role="alert">{error}</div>}
    {notice && <div className="set-notice ok" role="status">{notice}</div>}
    {keyStore?.ok === false && <div className="set-notice warn" role="status">
      <p><strong>密钥暂时存不进来</strong>：模型的密钥要存进 Legion 自己的受保护密钥库，而这台机器上它现在打不开。</p>
      <p>{keyStore.message || '密钥库的存放位置还没有确定。'}</p>
      <p>供应商的名称、地址与模型列表**不受影响**，可以正常保存；等密钥库就绪后再回来补密钥即可。</p>
    </div>}
    {!loading && !error && <p className="model-catalog-summary">
      已配置 {providers.length} 个供应商 · {modelCount} 个模型 · 密钥已核验 {readyCount} 个
      {missingCount > 0 && <span className="provider-cred-warn"> · {missingCount} 个引用的钥匙不在库里</span>}
      {unknownCount > 0 && <span className="provider-cred-unknown"> · {unknownCount} 个无法核验（读不到密钥库）</span>}
      {runtimeAbsent.length > 0 && <span className="provider-cred-warn"> · {runtimeAbsent.length} 个**运行侧**取不到钥匙</span>}
      {runtimeUnknownCount > 0 && <span className="provider-cred-unknown"> · {runtimeUnknownCount} 个运行侧未核验</span>}
    </p>}
    {/* ★★ 把规则讲清楚（2026-10-12）。不写这段时，上面那些"已核验"会被读成
        "任务一定跑得起来" —— 而运行时取钥匙的地方是 DSH 自己，不是这里。 */}
    {!loading && !error && runtimeAbsent.length > 0 && <div className="set-notice warn" role="status">
      <p><strong>有 {runtimeAbsent.length} 个供应商在**运行侧**取不到钥匙。</strong>
        {runtimeAbsent.length === 1 ? `「${runtimeAbsent[0].displayName}」` : '它们在'}的凭证只在 Legion 这边有这个引用，
        而真正跑任务的进程（DSH）在自己的凭证库里找不到它。</p>
      <p>钥匙的两处不是同一件事：这里存的那份给"测试连接"用；**任务要跑，靠的是 DSH 自己的凭证库**。
        两边现在各存一份、且没有自动同步（把 Legion 的配置写进 DSH 的开关默认是关的）。</p>
      <p>要做的是**在 DSH 那边也配上这把钥匙**（DSH 的模型设置页），而不是在这里再填一遍。</p>
    </div>}
    <div className="provider-settings-list">
      {!loading && providers.map(p => {
        const cred = credentialView(p)
        return <div className="provider-settings-row" key={p.id}>
        <strong>{p.displayName}</strong>
        {p.source === 'dsh-import' && <span className="provider-custom-badge">自运行环境导入</span>}
        <span className={`provider-state-dot${cred.cls}`} role="img" aria-label={cred.label} title={cred.title} />
        <span className="provider-cred-label" title={cred.title}>{cred.label}</span>
        {/* ★★ 运行侧那一格（2026-10-12）。它与上面那一格**都显示**：一个说"这个库里有"，
            一个说"跑起来取得到"。缺了后者，用户以为"配在这里就够了"。 */}
        {p.credential?.runtime !== undefined && (() => {
          const rt = runtimeKeyView(p)
          return <>
            <span className={`provider-state-dot${rt.cls}`} role="img" aria-label={rt.label} title={rt.title} />
            <span className={`provider-cred-label${rt.bad ? ' provider-cred-warn' : ''}`} title={rt.title}>{rt.label}</span>
          </>
        })()}
        {/* ★ 档案是**保存时自动生成**的（将军："添加完自动生成供应商档案"）。
            所以这里不再有"生成"按钮：`missing > 0` 只意味着**那次没跑成**
            （历史数据 / 某条 id 冲突），于是说的是"补齐"而不是"生成"。 */}
        {p.profiles !== undefined && p.profiles.missing > 0 &&
          <button className="btn small provider-derive" disabled={busy || repairBusy}
            title={`这个供应商的清单里有 ${p.profiles.missing} 个模型还没有模型档案。档案本应在保存时自动生成，所以这一条意味着那次没跑成（历史数据，或某个模型的档案 id 被占用）。点一下按「供应商 + 模型」补齐，已存在的不会被动。`}
            onClick={() => void openRepair(p)}>补齐 {p.profiles.missing} 个档案</button>}
        {p.profiles !== undefined && p.profiles.missing === 0 &&
          <span className="provider-cred-label" title={`这个供应商的 ${p.profiles.existing} 个模型都已经有档案（保存时自动生成的）`}>档案已生成</span>}
        {p.profiles !== undefined && p.profiles.orphaned > 0 &&
          <span className="provider-cred-unknown" title={`有 ${p.profiles.orphaned} 条档案的模型已经不在这个供应商的清单里（**没有动它们**：删档案是不可逆方向的动作，且可能正被岗位绑定引用）`}>
            {p.profiles.orphaned} 条档案已不在清单里
          </span>}
        <button className="btn" disabled={busy} onClick={() => edit(p)}>编辑</button>
        <button className="btn provider-delete" disabled={busy} onClick={() => setRemoving(p)}>删除</button>
      </div>})}
      <button className="provider-add" disabled={busy} onClick={() => { setEditing(null); setForm({ ...empty, runtimeType: runtimeTypes[0]?.id ?? 'dsh' }); setOpen(true); setNotice(''); setError('') }}>＋ 添加模型供应商</button>
    </div>
    {repairing && <div className="provider-editor-mask"><div className="provider-editor-dialog" role="dialog" aria-label={`补齐 ${repairing.displayName} 的模型档案`}>
      <h3>补齐「{repairing.displayName}」的模型档案</h3>
      <p>模型档案是"选了哪个模型"的登记（岗位绑定与运行历史都要一个稳定的引用），
        它在**保存供应商时就已经自动生成**。你看到这一条，是因为这个供应商的那次保存
        发生在这段逻辑存在之前，或者某一条当时没建成功。</p>
      {repairBusy && <p>正在算计划…</p>}
      {repairResult?.plan && <div className="provider-derive-plan">
        <p><strong>{repairResult.summary}</strong></p>
        {repairResult.plan.create && repairResult.plan.create.length > 0 && <ul>
          {repairResult.plan.create.map(c => <li key={c.id}><code>{c.id}</code> ← {c.model}</li>)}
        </ul>}
        {(repairResult.plan.create?.length ?? 0) === 0 && <p>没有需要新建的模型档案。</p>}
      </div>}
      <div className="set-row-space">
        <button className="btn primary" disabled={repairBusy || (repairResult?.plan?.create?.length ?? 0) === 0} onClick={() => void confirmRepair()}>
          {repairBusy ? '处理中…' : `补齐这 ${repairResult?.plan?.create?.length ?? 0} 个档案`}
        </button>
        <button className="btn" disabled={repairBusy} onClick={() => { setRepairing(null); setRepairResult(null) }}>取消</button>
      </div>
    </div></div>}
    {removing && <div className="provider-editor-mask"><div className="provider-editor-dialog" role="alertdialog" aria-label="删除供应商"><h3>删除 {removing.displayName}？</h3><p>删除后，使用该供应商的岗位需要重新选择模型。</p>
      {/* ★★ 2026-10-12：孤儿钥匙的出口。删供应商从前**完全不碰密钥**，于是库里会攒下
          "没有任何供应商指向它"的条目（实测这台机器上就有一条）。这里给一个**明确**的出口，
          但**默认不勾** —— 删钥匙不可逆，而且它可能正被别的东西用着。 */}
      {removing.credentialRequired === true && <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={deleteKeyWithProvider} disabled={busy} onChange={e => setDeleteKeyWithProvider(e.target.checked)} />
        <span>同时删掉它的钥匙（不可撤销）</span>
      </label>}
      {removing.credentialRequired === true && <p className="set-notice muted">不勾选时，钥匙会留在本机密钥库里 —— 如果这个供应商是最后一个用它的，它就成了一个**没有任何供应商指向它**的孤儿（界面上不再有单独管这个库的入口，所以想清掉它就在这一格勾上）。</p>}
      <button className="btn provider-delete" disabled={busy} onClick={() => void remove()}>确认删除</button><button className="btn" disabled={busy} onClick={() => { setRemoving(null); setDeleteKeyWithProvider(false) }}>取消</button></div></div>}
    {open && <div className="provider-editor-mask"><form role="dialog" aria-modal="true" aria-label={editing ? `编辑 ${editing.displayName}` : '添加模型供应商'} className="set-form model-provider-form" onSubmit={e => { e.preventDefault(); void save() }}><h3>{editing ? `编辑 ${editing.displayName}` : '添加自定义供应商'}</h3>{error && <div className="set-notice bad" role="alert">{error}</div>}{notice && <div className="set-notice ok" role="status">{notice}</div>}<div className="set-grid">
      <label className="field"><span>供应商 ID</span><input className="set-input" value={form.provider} disabled={!!editing || busy} onChange={e => set('provider', e.target.value)} required placeholder="例如 company-gateway" /></label>
      <label className="field"><span>显示名称</span><input className="set-input" value={form.name} disabled={busy} onChange={e => set('name', e.target.value)} /></label>
      <label className="field"><span>API 地址</span><input className="set-input" value={form.endpoint} disabled={busy} onChange={e => set('endpoint', e.target.value)} placeholder="https://gateway.example/v1" /></label>
      <label className="field"><span>API 协议</span><select className="set-input" value={form.protocol} disabled={busy} onChange={e => set('protocol', e.target.value)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>
      {/* ★ 运行时（"用哪个运行时跟这个供应商说话"）：**选一次，记在供应商行上**，
          模型档案继承它 —— 所以档案页不用填这个字段。
          选项来自服务端（`runtimeTypes`）：写死在面板里的那份会在加上第二个适配器时静默落后。 */}
      <label className="field"><span>运行时</span>
        <select className="set-input" value={form.runtimeType} disabled={busy} onChange={e => set('runtimeType', e.target.value)}>
          {runtimeTypes.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      <label className="field"><span>API 密钥（留空保留原凭证）</span><input type="password" autoComplete="new-password" className="set-input" value={form.key} disabled={busy} onChange={e => set('key', e.target.value)} placeholder="密钥安全存储，保存后不回显" /></label>
    </div><label className="field"><span>模型 ID（每行一个）</span><textarea aria-label="模型 ID（每行一个）" className="set-textarea" value={form.models} disabled={busy} onChange={e => set('models', e.target.value)} rows={5} placeholder="填写该供应商实际支持的模型 ID" /></label><div className="set-row-space"><button className="btn" type="button" disabled={busy || !form.endpoint.trim()} onClick={() => void discover()}>获取可用模型</button><button className="btn primary" disabled={busy} type="submit">{busy ? '正在保存…' : '保存供应商'}</button><button className="btn" type="button" disabled={busy} onClick={() => { setOpen(false); setForm(empty) }}>取消</button></div></form></div>}
  </div>
}
