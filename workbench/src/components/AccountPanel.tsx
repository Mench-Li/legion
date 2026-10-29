import { useEffect, useState } from 'react'
import {
  changePassword,
  clearSession,
  createInvite,
  createPasswordReset,
  fetchMe,
  listDevices,
  listUsers,
  hasSession,
  IdentityRequestError,
  listSessions,
  logout,
  revokeSession,
  updateProfile,
} from '../identity'
import type { DeviceRow, MeInfo, SessionRow, UserRow } from '../identity'
import { accountSummary, formatCreatedAt, validateDisplayName } from '../accountProfile'
import { DevicePanel } from './DevicePanel'
import { toast } from './Toast'

/**
 * 「连接与令牌」里的**账号中心**。
 *
 * ## 它回答的四件事
 *
 *   1. 我是谁：显示名 / 用户名 / 用户 ID / 角色 / 注册时间 / 账号状态；
 *   2. 我能改什么：**显示名**可以改，**用户名（登录名）不可改**；
 *   3. 我的账号安全：改口令、看/踢其它登录、退出登录；
 *   4. 我的连接：登录会话与执行设备是**两份**数据，分开管理。
 *
 * ## 只有真的在用账号体系时才渲染
 *
 * 判据是"手上有没有用户会话"（`hasSession()`）。本机单机部署用的是机器令牌，
 * 这里恒为空 ⇒ 整块不出现。本机用户不该看到一个与他无关的账号面板，更不该
 * 看到一个"退出登录"按钮——按下去只会让他以为自己把本机 Legion 登出了。
 *
 * ## 区块独立：一路读取失败不许抹掉整页
 *
 * `/me` / `/sessions` / `/devices` 三路 `Promise.allSettled`，每路只影响
 * 自己那一块，错误态给「重试」。一次读失败把整页清空，会让人以为"账号没了"。
 */
function describeError(e: unknown): string {
  return e instanceof IdentityRequestError ? e.message : String(e)
}

interface SectionErrors {
  me: string | null
  sessions: string | null
  devices: string | null
}

export function AccountPanel(): React.JSX.Element | null {
  const [me, setMe] = useState<MeInfo | null>(null)
  const [sessions, setSessions] = useState<{ rows: SessionRow[]; currentId: string | null }>({ rows: [], currentId: null })
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [sectionErrors, setSectionErrors] = useState<SectionErrors>({ me: null, sessions: null, devices: null })
  const [draftDisplayName, setDraftDisplayName] = useState('')
  const [announce, setAnnounce] = useState('')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [invite, setInvite] = useState('')
  const [reset, setReset] = useState<{ code: string; userName: string; expiresAtMs: number } | null>(null)
  const [loaded, setLoaded] = useState(false)

  const active = hasSession()

  /** 播报用：页内 role=status 负责读屏，toast 负责视觉。 */
  function notify(kind: 'ok' | 'err', message: string): void {
    setAnnounce(message)
    toast(kind, message)
  }

  async function reload(): Promise<void> {
    if (!active) { setLoaded(true); return }
    const [meRes, sessRes, devRes] = await Promise.allSettled([fetchMe(), listSessions(), listDevices()])
    if (meRes.status === 'fulfilled') {
      const info = meRes.value
      setMe(info)
      setDraftDisplayName(info.displayName)
      setSectionErrors(prev => ({ ...prev, me: null }))
      // 用户列表只对系统管理员有意义，也只有他们读得到——非管理员去读会 403，
      // 而那会污染这一节的错误提示（"我的会话"是好的，只是用户列表读不到）。
      if (info.systemRole === 'admin') setUsers(await listUsers().catch(() => null))
      else setUsers(null)
    } else {
      setSectionErrors(prev => ({ ...prev, me: describeError(meRes.reason) }))
      setUsers(null)
    }
    if (sessRes.status === 'fulfilled') {
      setSessions({ rows: sessRes.value.sessions.filter(r => r.revoked !== true), currentId: sessRes.value.currentSessionId })
      setSectionErrors(prev => ({ ...prev, sessions: null }))
    } else {
      // 保留上一次的读数，只把"这一块读不到"说出来。
      setSectionErrors(prev => ({ ...prev, sessions: describeError(sessRes.reason) }))
    }
    if (devRes.status === 'fulfilled') {
      setDevices(devRes.value)
      setSectionErrors(prev => ({ ...prev, devices: null }))
    } else {
      setSectionErrors(prev => ({ ...prev, devices: describeError(devRes.reason) }))
    }
    setLoaded(true)
  }

  useEffect(() => { void reload() }, [])

  // 本机单机部署：整块不渲染。见文件头。
  if (!active && loaded) return null

  const summary = accountSummary(me, sessions, devices)
  const statusText = me === null ? '—' : me.disabled ? '已停用' : '正常'
  const roleText = me === null ? '—' : me.systemRole === 'admin' ? '系统管理员' : '普通成员'
  const spaceText = me === null
    ? '—'
    : me.roles.length === 0 ? '还没有加入任何空间' : me.roles.map(r => `${r.space}（${r.role}）`).join('、')

  async function saveDisplayName(): Promise<void> {
    // 防重复提交：忙碌时直接返回（按钮同时 disabled）。
    if (busy) return
    const checked = validateDisplayName(draftDisplayName)
    if (checked.ok !== true) { notify('err', checked.message); return }
    setBusy(true)
    try {
      const user = await updateProfile({ displayName: checked.value })
      // ★ 以**服务端返回的最终值**回填，而不是假设本地草稿一定生效
      //   （并发保存是"后写覆盖"）。
      setMe(prev => (prev === null ? prev : { ...prev, ...user }))
      setDraftDisplayName(user.displayName)
      notify('ok', `显示名已保存为「${user.displayName}」`)
    } catch (e) {
      notify('err', describeError(e))
    } finally { setBusy(false) }
  }

  function cancelDisplayName(): void {
    if (busy) return
    setDraftDisplayName(me?.displayName ?? '')
    setAnnounce('已取消修改')
  }

  async function submitPassword(): Promise<void> {
    if (current.length === 0 || next.length === 0) { notify('err', '请填写当前口令与新口令'); return }
    setBusy(true)
    try {
      const r = await changePassword(current, next)
      setCurrent(''); setNext('')
      // 把"别处被踢掉几个"说出来：做这件事的动机多半就是怀疑别人在用他的账号。
      notify('ok', `口令已改。其它设备上的 ${r.revokedOtherSessions} 个登录已退出，这台仍然有效。`)
      await reload()
    } catch (e) { notify('err', describeError(e)) } finally { setBusy(false) }
  }

  async function revoke(sessionId: string): Promise<void> {
    setBusy(true)
    try {
      await revokeSession(sessionId)
      setAnnounce('已退出那台设备。')
      await reload()
    } catch (e) {
      // 撤销失败不得从列表移除，也不得显示成功。
      notify('err', describeError(e))
    } finally { setBusy(false) }
  }

  async function makeInvite(): Promise<void> {
    setBusy(true)
    try {
      const space = me?.roles[0]?.space ?? 'default'
      setInvite(await createInvite(space, 'member'))
      notify('ok', `邀请码已生成，只能用一次；对方在注册页填它即可加入「${space}」。`)
    } catch (e) { notify('err', describeError(e)) } finally { setBusy(false) }
  }

  async function issueReset(userId: string): Promise<void> {
    setBusy(true)
    try {
      setReset(await createPasswordReset(userId))
      setInvite('')
      notify('ok', '重置码已生成，只能用一次。把它给到那个人。')
    } catch (e) { notify('err', describeError(e)) } finally { setBusy(false) }
  }

  async function signOut(): Promise<void> {
    setBusy(true)
    try { await logout() } finally {
      clearSession()
      // 整页重载：与登录同一条理由——十几个数据 effect 都带着刚失效的令牌跑过，
      // 就地复位会让它们停在半路。
      window.location.reload()
    }
  }

  return (
    <div className="account-page">
      <p className="settings-runtime-status" role="status" aria-live="polite">{announce}</p>

      {me === null ? (
        <section className="panel settings-card">
          <h2>账号摘要</h2>
          {loaded
            ? <>
              <p className="settings-runtime-status">账号读取失败：{sectionErrors.me ?? '未知错误'}</p>
              <button className="btn" disabled={busy} onClick={() => void reload()}>重试</button>
            </>
            : <p className="settings-runtime-status">正在读取账号…</p>}
        </section>
      ) : (
        <>
          <section className="panel settings-card">
            <h2>账号摘要</h2>
            <p>
              <strong className="account-display-name">{me.displayName}</strong>
              <span className="settings-runtime-status">（{me.name}）</span>
            </p>
            <p className="settings-runtime-status">{roleText}</p>
            {me.systemRole === 'admin' && (
              <p className="settings-runtime-status">系统管理员不自动能读所有空间；要读某个空间需要那个空间里的角色。</p>
            )}
          </section>

          <section className="panel settings-card">
            <h2>基础信息</h2>
            <label htmlFor="account-display-name">显示名</label>
            <input
              id="account-display-name"
              value={draftDisplayName}
              maxLength={64}
              disabled={busy}
              onChange={e => setDraftDisplayName(e.target.value)}
            />
            <div className="settings-row-actions">
              <button className="btn primary" disabled={busy} onClick={() => void saveDisplayName()}>保存显示名</button>
              <button className="btn" disabled={busy} onClick={cancelDisplayName}>取消</button>
            </div>
            <p className="settings-runtime-status">
              用户名（登录名）：{me.name}。登录名不可修改，登录时仍然用它；显示名只影响展示，不要求唯一。
            </p>
          </section>

          <section className="panel settings-card">
            <h2>账号信息</h2>
            <dl className="account-facts">
              <div><dt>用户 ID</dt><dd>{me.userId || '—'}</dd></div>
              <div><dt>用户名（登录名）</dt><dd>{me.name || '—'}</dd></div>
              <div><dt>显示名</dt><dd>{me.displayName || '—'}</dd></div>
              <div><dt>系统角色</dt><dd>{roleText}</dd></div>
              <div><dt>账号状态</dt><dd>{statusText}</dd></div>
              <div><dt>注册时间</dt><dd>{formatCreatedAt(me.createdAt)}</dd></div>
              <div><dt>空间与角色</dt><dd>{spaceText}</dd></div>
              <div><dt>当前会话</dt><dd>{summary.currentSession === null ? '—' : (summary.currentSession.label || '未命名设备')}</dd></div>
              <div><dt>活跃会话数</dt><dd>{sectionErrors.sessions !== null ? '读取失败' : loaded ? summary.activeSessionCount : '—'}</dd></div>
              <div><dt>执行设备数</dt><dd>{sectionErrors.devices !== null ? '读取失败' : loaded ? summary.deviceCount : '—'}</dd></div>
            </dl>
          </section>

          <section className="panel settings-card">
            <h2>账号安全</h2>
            <label htmlFor="account-current-password">当前口令</label>
            <input id="account-current-password" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />
            <label htmlFor="account-new-password">新口令</label>
            <input id="account-new-password" type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
            <p className="settings-runtime-status">至少 8 个字符。改完会把**其它**设备上的登录踢掉，这台保留。</p>
            <button className="btn primary" disabled={busy} onClick={() => void submitPassword()}>改口令</button>
            <button className="btn" disabled={busy} onClick={() => void signOut()}>退出登录</button>
          </section>
        </>
      )}

      {loaded && (
        <>
      <section className="panel settings-card">
        <h2>登录中的设备</h2>
        {sectionErrors.sessions !== null && (
          <p className="settings-runtime-status">
            会话读取失败：{sectionErrors.sessions}
            <button className="btn" disabled={busy} onClick={() => void reload()}>重试</button>
          </p>
        )}
        {summary.activeSessions.length === 0 && sectionErrors.sessions === null && (
          <p className="settings-runtime-status">没有可显示的会话。</p>
        )}
        {summary.activeSessions.map(s => (
          <div key={s.sessionId} className="settings-session-row">
            <div>
              <strong>{s.label || '未命名设备'}</strong>
              <p className="settings-runtime-status">
                登录于 {s.createdAt ?? '—'}　最近使用 {s.lastSeenAt ?? '—'}
              </p>
            </div>
            {s.sessionId === sessions.currentId
              // 「这台」不给按钮：一个点了就把自己踢掉的按钮，用户按下去只会以为出错了。
              // 要离开请用「退出登录」。
              ? <span className="settings-runtime-status">这台（现在）</span>
              : <button className="btn" disabled={busy} onClick={() => void revoke(s.sessionId)}>退出这台</button>}
          </div>
        ))}
      </section>

      <section className="panel settings-card">
        <h2>执行设备</h2>
        {sectionErrors.devices !== null && (
          <p className="settings-runtime-status">
            设备读取失败：{sectionErrors.devices}
            <button className="btn" disabled={busy} onClick={() => void reload()}>重试</button>
          </p>
        )}
        <DevicePanel devices={devices} onReload={reload} />
      </section>

      {me?.systemRole === 'admin' && (
        <section className="panel settings-card">
          <h2>账号管理</h2>
          <p className="settings-runtime-status">只有系统管理员看得到这一块。普通成员不会请求 /api/identity/users。</p>

          <h3>口令重置</h3>
          <p className="settings-runtime-status">
            有人忘了口令时，在这里签发一枚**一次性**重置码，把它给到那个人
            （Hub 没有邮件通道，怎么给他由你决定）。他用它自己设新口令，
            改完**他名下所有登录都会退出**。
          </p>
          <p className="settings-runtime-status">
            码只有 30 分钟有效，且只能用一次；签发**本身不改变**账号的启用状态——
            要恢复一个被停用的账号，请单独把它启用。
          </p>
          {(users ?? []).map(u => (
            <div key={u.userId} className="settings-session-row">
              <div>
                <strong>{u.displayName ?? u.name}（{u.name}）</strong>
                <p className="settings-runtime-status">
                  {u.systemRole === 'admin' ? '系统管理员' : '普通成员'}{u.disabled ? '　已停用' : ''}
                </p>
              </div>
              <div className="settings-row-actions">
                <button className="btn" disabled={busy} onClick={() => void issueReset(u.userId)}>生成重置码</button>
              </div>
            </div>
          ))}
          {(users ?? []).length === 0 && <p className="settings-runtime-status">读不到用户列表。</p>}
          {reset !== null && (
            <>
              <label>{reset.userName} 的重置码（只显示这一次）
                <input readOnly value={reset.code} onFocus={e => e.target.select()} />
              </label>
              <p className="settings-runtime-status">
                有效至 {new Date(reset.expiresAtMs).toLocaleTimeString()}，只能用一次。
              </p>
            </>
          )}

          <h3>邀请新成员</h3>
          <p className="settings-runtime-status">
            生成一个邀请码发给对方，他在注册页填上即可加入「{me.roles[0]?.space ?? 'default'}」。邀请码只能用一次。
          </p>
          <button className="btn" disabled={busy} onClick={() => void makeInvite()}>生成邀请码</button>
          {invite.length > 0 && <label>邀请码<input readOnly value={invite} onFocus={e => e.target.select()} /></label>}
        </section>
      )}
        </>
      )}
    </div>
  )
}
