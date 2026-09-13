// workbench/src/components/ModelProfilesPanel.tsx
// ============================================================================
// 模型档案面板（PRT-501 的界面一半）
//
// 后端 `/api/model-profiles` 的 CRUD 与 `/probe` 一直是完整实现 + 有套件覆盖，
// 而界面上**一次都调不到**。这个面板把它们接上。
//
// 三条渲染纪律（每一条都对应一次具体的误读）：
//
// ① **读不出来 ≠ 一条都没有**：列表走 `AsyncState`，失败时渲染
//    "读不出来 —— 这不等于你没有"，而不是一个空列表。
// ② **没探测过 ≠ 探测失败**：徽标来自 `probeViewFrom`，它把 503
//    （密钥库打不开/布局不合法/没填 endpoint）渲染成灰色"未测试"。
//    自己在这里判断 `ok === false` 就会把后者画成红色失败。
// ③ **失败落到具体字段**：`panelErrorFrom` 给出 `field`/`hint`/`candidates`，
//    输入框高亮 + 候选可点。一句通用 toast 会把"错在哪个框"这条信息丢掉。
// ④ **留空 secretRef = 清掉引用**（不是"不改动"）：服务端的 update 是一句
//    `SET secret_ref=?`，请求里不带就是 `null`。而列表里的 descriptor **不含引用名**，
//    所以编辑框永远预填不出来——有凭证的档案默认**拦住**保存，必须显式确认清除。
//    这一条是本轮改出来的：原来的界面上写的是「留空 = 不改动本机引用」，
//    **那是反的**，而且正好错在"引导用户去销毁一个东西"这个方向上。
// ============================================================================

import { useCallback, useEffect, useState } from 'react'
import {
  createModelProfile, deleteModelProfile, fetchModelProfiles, probeModelProfile, updateModelProfile,
} from '../api'
import type { HubModelProfile } from '../api'
import { probeBadge, profileRowView, suggestCandidates } from '../modelSettings'
import type { ProbeBadge, ProbeVerdictLike } from '../modelSettings'
import { failedState, collectionView, loadingState, panelErrorFrom, probeViewFrom, readyState, secretRefEditView } from '../modelSettingsUi'
import type { AsyncState, CollectionCopy, PanelError } from '../modelSettingsUi'
import { Notice, ProbeChip, StateBox } from './settingsBits'

/** 列表文案。**空状态提示与"读不出来"的补充说明是两句不同的话**——
 *  它们分别只在"真的读出来了且为空"和"读不出来"时出现（见 `collectionView`）。 */
const COPY_PROFILES: CollectionCopy = {
  noun: '模型档案',
  emptyHint: '一条档案都没有。用下面的表单建第一条——档案是岗位绑定与探测的共同底色。',
  readFailedHint: '这不代表"一条档案都没有"：中枢这一趟没答上来，可能只是暂时读不到。',
}

/**
 * 操作者身份。
 *
 * `api.ts` 的 `hubPost` 默认写 `by: 'general'`，模型配置的审计也用它。
 * 界面**不提供**选择操作者——所以这里是一个常量，而不是一个假的输入框。
 */
const ACTOR = 'general'

interface FormState {
  id: string
  displayName: string
  /** **不设默认值**：`first-run.mjs` 明确写着「runtimeType 不许猜」——
   *  猜错会让档案看起来配好了，直到第一次运行。 */
  runtimeType: string
  provider: string
  model: string
  endpoint: string
  secretRef: string
  reasoningEffort: string
}

const EMPTY_FORM: FormState = {
  id: '', displayName: '', runtimeType: '', provider: '', model: '',
  endpoint: '', secretRef: '', reasoningEffort: 'medium',
}

/** 表单 → 请求体。**空的可选字段不发送**（发送空串会被判成"给了一个空 endpoint"）。 */
function formToProfile(f: FormState): Record<string, unknown> {
  const p: Record<string, unknown> = {
    id: f.id.trim(),
    displayName: f.displayName.trim(),
    runtimeType: f.runtimeType.trim(),
    provider: f.provider.trim(),
    model: f.model.trim(),
    reasoningEffort: f.reasoningEffort,
  }
  if (f.endpoint.trim() !== '') p.endpoint = f.endpoint.trim()
  if (f.secretRef.trim() !== '') p.secretRef = f.secretRef.trim()
  return p
}

export function ModelProfilesPanel(): React.JSX.Element {
  const [list, setList] = useState<AsyncState<HubModelProfile[]>>(loadingState())
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const [badges, setBadges] = useState<Record<string, ProbeBadge>>({})
  const [probing, setProbing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<{ id: string; version: number; hasCredential: boolean } | null>(null)
  const [clearCred, setClearCred] = useState(false)
  const [formError, setFormError] = useState<PanelError | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad' | 'warn'; title: string; text: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setList(loadingState())
    try {
      setList(readyState(await fetchModelProfiles({ includeDeleted })))
    } catch (e) {
      setList(failedState(e))
    }
  }, [includeDeleted])

  useEffect(() => { void load() }, [load])

  const set = (k: keyof FormState, v: string): void => setForm(prev => ({ ...prev, [k]: v }))

  const submit = async (): Promise<void> => {
    // 有凭证的档案 + 留空引用 = 一次**销毁**。默认拦住，必须显式勾选。
    // 判定与文案在 `modelSettingsUi.secretRefEditView` 里（那里钉着服务端的真实语义）。
    if (editView !== null && editView.needsExplicitClear && !clearCred) {
      setFormError({
        status: null, code: null, field: 'secretRef',
        text: '这次保存会清掉档案上的凭证引用，还没有确认。',
        hint: editView.notice, candidates: [],
      })
      return
    }
    setBusy(true)
    setFormError(null)
    setNotice(null)
    const profile = formToProfile(form)
    try {
      if (editing === null) {
        await createModelProfile(profile, ACTOR)
        setNotice({ tone: 'ok', title: `已创建档案 ${String(profile.id)}`, text: '它现在可以用于岗位绑定。' })
      } else {
        // CAS：**必须**回传读到的那个版本。不回传＝静默覆盖别人的修改。
        await updateModelProfile(editing.id, profile, editing.version, ACTOR)
        setNotice({
          tone: 'ok',
          title: `已保存档案 ${editing.id}`,
          text: `写入时用的是版本 ${editing.version}（服务端会把它 +1）。` +
            (editView?.clearsCredential === true ? '这一次**清掉了**凭证引用。' : ''),
        })
      }
      setForm(EMPTY_FORM)
      setEditing(null)
      setClearCred(false)
      await load()
    } catch (e) {
      // 具体失败：field / hint / candidates 都留着，落到对应输入框。
      setFormError(panelErrorFrom(e))
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (p: HubModelProfile): void => {
    setFormError(null)
    setNotice(null)
    setClearCred(false)
    setEditing({
      id: p.id,
      version: typeof p.version === 'number' ? p.version : Number.NaN,
      hasCredential: p.hasCredential === true,
    })
    setForm({
      id: p.id,
      displayName: p.displayName ?? '',
      runtimeType: p.runtimeType ?? '',
      provider: p.provider ?? '',
      model: p.model ?? '',
      endpoint: p.endpoint ?? '',
      // descriptor **不含 secretRef**（只给 hasCredential），所以这里**不预填**——
      // 预填一个猜出来的引用名等于把一把不存在的钥匙写回档案。
      secretRef: '',
      reasoningEffort: typeof p.reasoningEffort === 'string' ? p.reasoningEffort : 'medium',
    })
    if (typeof p.version !== 'number') {
      setFormError({
        status: null, code: null, field: null,
        text: '这个档案没有版本号，无法安全地修改（服务端用 version 做并发保护）。请重新读取列表。',
        hint: null, candidates: [],
      })
    }
  }

  const doProbe = async (id: string): Promise<void> => {
    setProbing(id)
    try {
      const r = await probeModelProfile(id)
      setBadges(prev => ({ ...prev, [id]: probeViewFrom({ verdict: r.probe as ProbeVerdictLike }) }))
    } catch (e) {
      // 关键：503 走"未测试"，**不是**红色失败。分类逻辑在 modelSettings.ts 里只有一份。
      setBadges(prev => ({ ...prev, [id]: probeViewFrom({ error: e }) }))
    } finally {
      setProbing(null)
    }
  }

  const doDelete = async (p: HubModelProfile): Promise<void> => {
    if (typeof p.version !== 'number') {
      setNotice({ tone: 'bad', title: '不能删除', text: '这一行没有版本号：服务端要求 CAS 版本，猜一个版本号会删掉别人刚改的东西。请重新读取列表。' })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      await deleteModelProfile(p.id, p.version, ACTOR)
      setNotice({ tone: 'ok', title: `已删除档案 ${p.id}`, text: '它变成墓碑（默认列表不再显示）。同名重建会被服务端单独报出来，不会看起来像一次干净的首次创建。' })
      await load()
    } catch (e) {
      const err = panelErrorFrom(e)
      setNotice({ tone: 'bad', title: `删除 ${p.id} 失败`, text: `${err.text}${err.code === null ? '' : ` 服务端码：${err.code}`}` })
    } finally {
      setBusy(false)
    }
  }

  const candidates = formError?.field === 'provider' ? suggestCandidates(formError.candidates, form.provider) : []
  const fieldCls = (name: keyof FormState): string => (formError?.field === name ? 'set-input invalid' : 'set-input')
  // 「留空 = ？」的判定只在 `secretRefEditView` 里有一份（那里钉着服务端的 UPDATE 语义）。
  const editView = editing === null
    ? null
    : secretRefEditView({ hasCredential: editing.hasCredential, secretRefInput: form.secretRef })
  const clearBlocked = editView !== null && editView.needsExplicitClear && !clearCred

  return (
    <div className="set-panel">
      <div className="mc-tip">
        💡 模型档案是**岗位绑定**与**连通性探测**的共同底色：先有一条档案，才谈得上"这个岗位用它"和"它现在能不能用"。
        凭证**不存在档案里**，档案只保存 `secretRef`（引用名）——真正的钥匙在「凭证库」页录入。
      </div>

      <div className="set-row-space">
        <label className="set-check">
          <input type="checkbox" checked={includeDeleted} onChange={e => setIncludeDeleted(e.target.checked)} />
          连墓碑一起显示（默认不显示：会让界面上出现选不了的模型）
        </label>
        <button className="btn small" onClick={() => void load()}>重新读取</button>
      </div>

      <StateBox view={collectionView(list, COPY_PROFILES)} onRetry={() => void load()} />

      {list.kind === 'ready' && list.data.map(p => {
        const row = profileRowView(p)
        const badge = badges[p.id] ?? probeBadge(null)
        return (
          <div key={p.id} className="set-card">
            <div className="set-card-head">
              <span className="mc-name">{row.title}</span>
              {row.disabled && <span className="chip muted">已停用</span>}
              <ProbeChip tone={badge.tone} label={badge.label} />
            </div>
            <div className="set-card-sub">{row.subtitle}　·　{row.endpointText}</div>
            <div className="set-card-sub">{row.credential.text}　·　版本 {typeof p.version === 'number' ? p.version : '未知'}</div>
            <div className="set-card-detail">{badge.detail}</div>
            {badge.action !== null && <div className="set-card-action">下一步：{badge.action}</div>}
            <div className="set-card-actions">
              <button className="btn small" disabled={probing === p.id} onClick={() => void doProbe(p.id)}>
                {probing === p.id ? '测试中…' : '测试连接'}
              </button>
              <button className="btn small" onClick={() => startEdit(p)}>编辑</button>
              <button className="btn small danger" disabled={busy} onClick={() => void doDelete(p)}>删除</button>
            </div>
          </div>
        )
      })}

      <div className="set-form">
        <div className="set-form-title">{editing === null ? '新建档案' : `编辑档案 ${editing.id}`}</div>
        <div className="set-grid">
          <label className="field"><span>id</span>
            <input className={fieldCls('id')} value={form.id} disabled={editing !== null}
              onChange={e => set('id', e.target.value)} placeholder="字母数字与 . _ -，1..64" />
          </label>
          <label className="field"><span>显示名</span>
            <input className={fieldCls('displayName')} value={form.displayName} onChange={e => set('displayName', e.target.value)} />
          </label>
          <label className="field"><span>runtimeType（必填，**不猜**）</span>
            <input className={fieldCls('runtimeType')} value={form.runtimeType} onChange={e => set('runtimeType', e.target.value)}
              placeholder="例如 dsh / openai-compatible" />
          </label>
          <label className="field"><span>provider</span>
            <input className={fieldCls('provider')} value={form.provider} onChange={e => set('provider', e.target.value)} placeholder="例如 custom-ds" />
          </label>
          <label className="field"><span>模型名</span>
            <input className={fieldCls('model')} value={form.model} onChange={e => set('model', e.target.value)} />
          </label>
          <label className="field"><span>endpoint（可空）</span>
            <input className={fieldCls('endpoint')} value={form.endpoint} onChange={e => set('endpoint', e.target.value)}
              placeholder="http(s)://…，**不得内嵌账号密码**" />
          </label>
          <label className="field"><span>secretRef（引用名，可空）</span>
            <input className={fieldCls('secretRef')} value={form.secretRef} onChange={e => set('secretRef', e.target.value)}
              placeholder="名字，不是钥匙本身" />
          </label>
          <label className="field"><span>推理强度</span>
            <select value={form.reasoningEffort} onChange={e => set('reasoningEffort', e.target.value)}>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
        </div>

        {formError !== null && (
          <Notice
            tone="bad"
            title="保存失败"
            text={formError.text}
            action={formError.hint}
            field={formError.field}
            lines={candidates.length > 0 ? [`已登记的候选：${candidates.join('、')}（点一下填进 provider）`] : []}
          />
        )}
        {candidates.length > 0 && (
          <div className="set-row-space">
            {candidates.map(c => (
              <button key={c} className="btn small" onClick={() => set('provider', c)}>{c}</button>
            ))}
          </div>
        )}

        <div className="set-row-space">
          <button className="btn primary" disabled={busy || clearBlocked} onClick={() => void submit()}>
            {busy ? '提交中…' : editing === null ? '创建档案' : '保存修改'}
          </button>
          {editing !== null && (
            <button className="btn" onClick={() => { setEditing(null); setForm(EMPTY_FORM); setFormError(null); setClearCred(false) }}>取消编辑</button>
          )}
        </div>
        {editView !== null && (
          <div className={editView.tone === 'warn' ? 'set-notice warn' : 'set-notice muted'}>
            <div className="set-notice-text">{editView.notice}</div>
            {editView.needsExplicitClear && (
              <label className="set-check">
                <input type="checkbox" checked={clearCred} onChange={e => setClearCred(e.target.checked)} />
                我确认要清掉这条档案上的凭证引用
              </label>
            )}
          </div>
        )}
      </div>

      {notice !== null && <Notice tone={notice.tone} title={notice.title} text={notice.text} />}
    </div>
  )
}
