// workbench/src/components/SecretVaultPanel.tsx
// ============================================================================
// 凭证库面板（spec §6.7 的**写**一半，PRT-507 的界面入口）
//
// 在它之前：`security/secrets/` 有完整实现、有套件覆盖，`team-hub/secret-admin.mjs`
// 与五条 `/api/secrets` 路由也在，而**界面上一个都点不到**——
// `store.put` / `rotate` / `remove` 在整个仓库里零生产调用方。
//
//   > 一个功能没有入口，与这个功能不存在，对用户来说是同一件事。
//
// ---------------------------------------------------------------------------
// 四条渲染纪律（每一条都对应一次具体的误读）
//
// ① **打不开 ≠ 一条都没有。** 列表读失败（503 `SECRET_ADMIN_STORE_UNAVAILABLE`）
//    必须渲染成"读不出来 —— 这不等于你没有"，否则用户会照着"你还没有任何凭证"
//    重新录入一遍——而每一次都会失败，因为密钥库根本打不开。
// ② **自检说打不开是 HTTP 200 + `ok:false`**，不是异常。`secretStatusView`
//    把"可用 / 明确不可用 / 读不出结论"三种状态分开。
// ③ **删除是幂等的。** `removed:false`（引用本来就不存在）不是失败；
//    而轮换一个不存在的引用**是**错误（404 `SECRET_NOT_FOUND`）。
//    两者的下一步动作相反（`secretDeleteResultView` / `secretErrorView`）。
// ④ **值只走请求体，永不进 URL、日志或错误文案。** 输入框是 `type=password`，
//    提交后立刻清空本地状态；界面上的任何提示都只用引用名与元数据。
// ============================================================================

import { useCallback, useEffect, useState } from 'react'
import { deleteSecret, fetchSecrets, fetchSecretStatus, putSecret, rotateSecret } from '../api'
import type { HubSecretEntry, HubSecretStatus } from '../api'
import {
  collectionView, failedState, loadingState, panelErrorFrom, readyState,
  secretDeleteResultView, secretErrorView, secretRowView, secretStatusView, secretWriteResultView,
} from '../modelSettingsUi'
import type {
  AsyncState, CollectionCopy, SecretDeleteView, SecretErrorView, SecretStatusView, SecretWriteView,
} from '../modelSettingsUi'
import { Notice, StateBox } from './settingsBits'

const ACTOR = 'general'

const COPY_SECRETS: CollectionCopy = {
  noun: '凭证引用',
  emptyHint: '这个本机密钥库还是一条都没有。用下面的表单录入第一把钥匙——档案里的 secretRef 指向的就是这里的引用名。',
  readFailedHint: '这不代表"一条都没有"：密钥库这一趟读不出来，**不要**照着重录一遍（重录也会失败）。',
}

type Outcome =
  | { kind: 'write'; view: SecretWriteView }
  | { kind: 'delete'; view: SecretDeleteView }
  | { kind: 'error'; view: SecretErrorView }

export function SecretVaultPanel(): React.JSX.Element {
  const [status, setStatus] = useState<SecretStatusView | null>(null)
  const [rawStatus, setRawStatus] = useState<HubSecretStatus | null>(null)
  const [list, setList] = useState<AsyncState<HubSecretEntry[]>>(loadingState())
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)

  // 新增表单
  const [ref, setRef] = useState('')
  const [purpose, setPurpose] = useState('')
  const [value, setValue] = useState('')

  // 轮换：同一时刻只允许一个引用处于"等待输入新值"的状态
  const [rotateFor, setRotateFor] = useState<string | null>(null)
  const [rotateValue, setRotateValue] = useState('')

  // 删除确认（两步：点一次进入确认态，再点一次才真的删）
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setList(loadingState())
    try {
      const s = await fetchSecretStatus()
      setRawStatus(s)
      setStatus(secretStatusView(s))
    } catch (e) {
      // 自检这一趟**抛**了（中枢不可达/代理 503）：这也是一种"读不出结论"，
      // 而不是"密钥库有问题"。状态视图给 unknown，并附上原始错误。
      setRawStatus(null)
      setStatus({
        kind: 'unknown', available: false,
        headline: '读不出密钥库状态',
        detail: `${panelErrorFrom(e).text} **这不等于「密钥库是好的」，也不等于「密钥库里没有凭证」**。`,
        code: panelErrorFrom(e).code,
        countText: '条目数未知',
      })
    }
    try {
      setList(readyState((await fetchSecrets()).secrets))
    } catch (e) {
      setList(failedState(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const doPut = async (): Promise<void> => {
    setBusy(true)
    setOutcome(null)
    const submitRef = ref.trim()
    const submitValue = value
    // 立刻把值从本地状态里拿掉：它只应该存在到这次请求发出去为止。
    setValue('')
    try {
      const r = await putSecret({ ref: submitRef, value: submitValue, purpose: purpose.trim() === '' ? undefined : purpose.trim(), actor: ACTOR })
      setOutcome({ kind: 'write', view: secretWriteResultView('put', r) })
      setRef('')
      setPurpose('')
      await load()
    } catch (e) {
      setOutcome({ kind: 'error', view: secretErrorView(e) })
    } finally {
      setBusy(false)
    }
  }

  const doRotate = async (target: string): Promise<void> => {
    setBusy(true)
    setOutcome(null)
    const submitValue = rotateValue
    setRotateValue('')
    setRotateFor(null)
    try {
      const r = await rotateSecret(target, { value: submitValue, actor: ACTOR })
      setOutcome({ kind: 'write', view: secretWriteResultView('rotate', r) })
      await load()
    } catch (e) {
      // 这里最常见的两种是 **相反** 的：404 SECRET_NOT_FOUND（引用不存在 → 去新增）
      // 与 503 STORE_UNAVAILABLE（密钥库打不开 → 别去重新录入）。码已经分开了。
      setOutcome({ kind: 'error', view: secretErrorView(e) })
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async (target: string): Promise<void> => {
    setBusy(true)
    setOutcome(null)
    setConfirmDel(null)
    try {
      const r = await deleteSecret(target, ACTOR)
      setOutcome({ kind: 'delete', view: secretDeleteResultView(r) })
      await load()
    } catch (e) {
      setOutcome({ kind: 'error', view: secretErrorView(e) })
    } finally {
      setBusy(false)
    }
  }

  const aclVerified = rawStatus?.aclVerified === true
  const aclExists = rawStatus?.aclExists === true

  return (
    <div className="set-panel">
      <div className="mc-tip">
        💡 这里保存的是**钥匙本身**（加密后落盘），档案里保存的只是引用名（`secretRef`）。
        界面**只会**显示引用名与元数据——**任何响应里都没有值**，所以也不存在"显示成星号的值"。
      </div>

      {status !== null && (
        <Notice
          tone={status.kind === 'available' ? (aclVerified ? 'ok' : 'warn') : status.kind === 'unavailable' ? 'bad' : 'warn'}
          title={status.headline}
          text={status.detail}
          lines={[status.countText]}
        />
      )}

      <div className="set-row-space">
        <button className="btn small" onClick={() => void load()}>重新读取</button>
        {rawStatus !== null && (
          <span className="mc-legend">
            文件：{rawStatus.path ?? '（未报告路径）'}　·　权限核验：{aclVerified ? '已核验' : aclExists ? '文件在但没能确认' : '文件还不存在'}
          </span>
        )}
      </div>

      <StateBox view={collectionView(list, COPY_SECRETS)} onRetry={() => void load()} />

      {list.kind === 'ready' && list.data.map((raw, i) => {
        const row = secretRowView(raw)
        const key = row.ref === '' ? `#${i}` : row.ref
        return (
          <div key={key} className="set-card">
            <div className="set-card-head">
              <span className="mc-name">{row.refText}</span>
              {row.rotatedText === null && <span className="chip muted">从未轮换</span>}
            </div>
            <div className="set-card-sub">用途：{row.purposeText}　·　保护方案：{row.schemeText}</div>
            {row.rotatedText !== null && <div className="set-card-sub">{row.rotatedText}</div>}
            <div className="set-card-sub">{row.timesText}</div>
            <div className="set-card-actions">
              {rotateFor === row.ref && row.ref !== '' ? (
                <>
                  <input className="set-input" type="password" autoComplete="off" value={rotateValue}
                    placeholder="新的值（不会显示，也不会进 URL）" onChange={e => setRotateValue(e.target.value)} />
                  <button className="btn small primary" disabled={busy || rotateValue === ''} onClick={() => void doRotate(row.ref)}>确认轮换</button>
                  <button className="btn small" onClick={() => { setRotateFor(null); setRotateValue('') }}>取消</button>
                </>
              ) : (
                <button className="btn small" disabled={busy || row.ref === ''}
                  title={row.ref === '' ? '这一行没有引用名，无法轮换' : '轮换：引用名不变、值替换；只影响轮换之后创建的运行'}
                  onClick={() => { setRotateFor(row.ref); setRotateValue(''); setOutcome(null) }}>轮换</button>
              )}
              {confirmDel === row.ref && row.ref !== '' ? (
                <>
                  <button className="btn small danger" disabled={busy} onClick={() => void doDelete(row.ref)}>确认删除 {row.ref}</button>
                  <button className="btn small" onClick={() => setConfirmDel(null)}>取消</button>
                </>
              ) : (
                <button className="btn small danger" disabled={busy || row.ref === ''}
                  title={row.ref === '' ? '这一行没有引用名，无法删除' : '删除引用（幂等：不存在也算达成目标）'}
                  onClick={() => { setConfirmDel(row.ref); setOutcome(null) }}>删除</button>
              )}
            </div>
            {confirmDel === row.ref && row.ref !== '' && (
              <div className="mc-legend">
                删除**不会**去检查有没有档案在用这个引用：用了它的档案会在运行时取不到凭证，而不是在这里报错。
              </div>
            )}
          </div>
        )
      })}

      <div className="set-form">
        <div className="set-form-title">新增 / 更新一把钥匙</div>
        <div className="mc-legend">
          同名的引用是**更新**（值被替换），不会新建第二条。引用名的合法性由密钥库自己判（`assertSecretRef` 是唯一判据）。
        </div>
        <div className="set-grid">
          <label className="field"><span>引用名 secretRef</span>
            <input className="set-input" value={ref} onChange={e => setRef(e.target.value)} placeholder="例如 OPENAI_API_KEY" autoComplete="off" />
          </label>
          <label className="field"><span>用途（可空）</span>
            <input className="set-input" value={purpose} onChange={e => setPurpose(e.target.value)} placeholder="例如 探针 / 生产" autoComplete="off" />
          </label>
          <label className="field"><span>值（只进请求体）</span>
            <input className="set-input" type="password" autoComplete="off" value={value}
              onChange={e => setValue(e.target.value)} placeholder="提交后立刻从界面状态中清除" />
          </label>
        </div>
        <div className="set-row-space">
          <button className="btn primary" disabled={busy || ref.trim() === '' || value === ''} onClick={() => void doPut()}>
            {busy ? '提交中…' : '保存'}
          </button>
        </div>
      </div>

      {outcome !== null && outcome.kind === 'write' && (
        <Notice tone="ok" title={outcome.view.headline} text={outcome.view.detail}
          lines={[outcome.view.acl.text]} />
      )}
      {outcome !== null && outcome.kind === 'delete' && (
        // `already-absent` 也是**中性**的：它是幂等达成，不是失败。
        <Notice tone={outcome.view.kind === 'removed' ? 'ok' : 'muted'} title={outcome.view.headline}
          text={outcome.view.detail} lines={[outcome.view.acl.text]} />
      )}
      {outcome !== null && outcome.kind === 'error' && (
        <Notice tone="bad" title={outcome.view.headline} text={outcome.view.detail}
          action={outcome.view.action} field={outcome.view.field}
          lines={outcome.view.code === null ? [] : [`服务端码：${outcome.view.code}`]} />
      )}
    </div>
  )
}
