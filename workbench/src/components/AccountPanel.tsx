import { useEffect, useState } from 'react'
import {
  changePassword,
  clearSession,
  createInvite,
  createPasswordReset,
  fetchMe,
  listUsers,
  hasSession,
  IdentityRequestError,
  listSessions,
  logout,
  revokeSession,
} from '../identity'
import type { MeInfo, SessionRow, UserRow } from '../identity'
import { toast } from './Toast'

/**
 * 「连接与令牌」里的**账号**一节。
 *
 * ## 为什么它必须存在
 *
 * 登录页做好之后，指挥台能**进**了——但进不去出不来。没有退出登录，
 * 也没有任何地方能改口令或看"我的账号在哪些设备上"。用户能做的唯一一件事
 * 是去开发者工具里手删 localStorage，而那不是一个产品该给人的操作。
 *
 * ## 只有真的在用账号体系时才渲染
 *
 * 判据是"手上有没有用户会话"（`hasSession()`）。本机单机部署用的是机器令牌，
 * 这里恒为空 ⇒ 整块不出现。这与登录页"只在 Hub 要求鉴权时拦"是同一条纪律：
 * 本机用户不该看到一个与他无关的账号面板，更不该看到一个"退出登录"按钮
 * ——按下去只会让他以为自己把本机 Legion 登出了。
 */
export function AccountPanel(): React.JSX.Element | null {
  const [me, setMe] = useState<MeInfo | null>(null)
  const [sessions, setSessions] = useState<{ rows: SessionRow[]; currentId: string | null }>({ rows: [], currentId: null })
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [invite, setInvite] = useState('')
  const [users, setUsers] = useState<UserRow[] | null>(null)
  const [reset, setReset] = useState<{ code: string; userName: string; expiresAtMs: number } | null>(null)
  const [loaded, setLoaded] = useState(false)

  const active = hasSession()

  async function reload(): Promise<void> {
    if (!active) { setLoaded(true); return }
    try {
      const [info, s] = await Promise.all([fetchMe(), listSessions()])
      setMe(info)
      setSessions({ rows: s.sessions.filter(r => r.revoked !== true), currentId: s.currentSessionId })
      // 用户列表只对系统管理员有意义，也只有他们读得到——非管理员去读会 403，
      // 而那会污染这一节的错误提示（"我的会话"是好的，只是用户列表读不到）。
      if (info.systemRole === 'admin') setUsers(await listUsers().catch(() => null))
    } catch (e) {
      // 一次读失败不该把这一节整个抹掉——那会让人以为"我的账号没了"。
      // 说清楚读不到，并留着上一次的读数。
      toast('err', e instanceof IdentityRequestError ? e.message : String(e))
    } finally { setLoaded(true) }
  }

  useEffect(() => { void reload() }, [])

  // 本机单机部署：整块不渲染。见文件头。
  if (!active && loaded) return null

  async function submitPassword(): Promise<void> {
    if (current.length === 0 || next.length === 0) { toast('err', '请填写当前口令与新口令'); return }
    setBusy(true)
    try {
      const r = await changePassword(current, next)
      setCurrent(''); setNext('')
      // 把"别处被踢掉几个"说出来：做这件事的动机多半就是怀疑别人在用他的账号，
      // 而"改成功了"与"改成功了并且那个人已经掉线"是两句不同的话。
      toast('ok', `口令已改。其它设备上的 ${r.revokedOtherSessions} 个登录已退出，这台仍然有效。`)
      await reload()
    } catch (e) { toast('err', e instanceof IdentityRequestError ? e.message : String(e)) } finally { setBusy(false) }
  }

  async function revoke(sessionId: string): Promise<void> {
    setBusy(true)
    try { await revokeSession(sessionId); await reload() }
    catch (e) { toast('err', e instanceof IdentityRequestError ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  async function makeInvite(): Promise<void> {
    setBusy(true)
    try {
      const space = me?.roles[0]?.space ?? 'default'
      setInvite(await createInvite(space, 'member'))
      toast('ok', `邀请码已生成，只能用一次；对方在注册页填它即可加入「${space}」。`)
    } catch (e) { toast('err', e instanceof IdentityRequestError ? e.message : String(e)) } finally { setBusy(false) }
  }

  async function issueReset(userId: string): Promise<void> {
    setBusy(true)
    try {
      setReset(await createPasswordReset(userId))
      setInvite('')
      toast('ok', '重置码已生成，只能用一次。把它给到那个人。')
    } catch (e) { toast('err', e instanceof IdentityRequestError ? e.message : String(e)) } finally { setBusy(false) }
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
    <>
      <section className="panel settings-card">
        <h2>账号</h2>
        {me === null
          ? <p className="settings-runtime-status">正在读取账号…</p>
          : <>
            <p><strong>{me.name}</strong>　{me.systemRole === 'admin' ? '系统管理员' : '普通成员'}</p>
            <p className="settings-runtime-status">
              空间：{me.roles.length === 0 ? '还没有加入任何空间' : me.roles.map(r => `${r.space}（${r.role}）`).join('、')}
            </p>
            {/* 这条口径与手机端一致，也与服务端一致：系统管理员管的是"造邀请 / 停用账号"，
                不是"看所有数据"。合并这两件事会让"给某人管理权"顺带把全部数据交出去。 */}
            {me.systemRole === 'admin' && (
              <p className="settings-runtime-status">系统管理员不自动能读所有空间；要读某个空间需要那个空间里的角色。</p>
            )}
          </>}
        <button className="btn" disabled={busy} onClick={() => void signOut()}>退出登录</button>
      </section>

      {me !== null && (
        <section className="panel settings-card">
          <h2>改口令</h2>
          <label>当前口令<input type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} /></label>
          <label>新口令<input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></label>
          <p className="settings-runtime-status">至少 8 个字符。改完会把**其它**设备上的登录踢掉，这台保留。</p>
          <button className="btn primary" disabled={busy} onClick={() => void submitPassword()}>改口令</button>
        </section>
      )}

      {me !== null && (
        <section className="panel settings-card">
          <h2>登录中的设备（{sessions.rows.length}）</h2>
          {sessions.rows.length === 0 && <p className="settings-runtime-status">没有可显示的会话。</p>}
          {sessions.rows.map(s => (
            <div key={s.sessionId} className="settings-session-row">
              <div>
                <strong>{s.label || '未命名设备'}</strong>
                <p className="settings-runtime-status">
                  登录于 {s.createdAt ?? '—'}　最近使用 {s.lastSeenAt ?? '—'}
                </p>
              </div>
              {s.sessionId === sessions.currentId
                // 「这台」不给按钮：服务端文档里没有"撤销当前会话"之外的动作，
                // 而一个点了就把自己踢掉的按钮，用户按下去只会以为出错了。
                // 要离开请用上面的「退出登录」。
                ? <span className="settings-runtime-status">这台（现在）</span>
                : <button className="btn" disabled={busy} onClick={() => void revoke(s.sessionId)}>退出这台</button>}
            </div>
          ))}
        </section>
      )}

      {me?.systemRole === 'admin' && (
        <section className="panel settings-card">
          <h2>口令重置</h2>
          <p className="settings-runtime-status">
            有人忘了口令时，在这里签发一枚**一次性**重置码，把它给到那个人
            （Hub 没有邮件通道，怎么给他由你决定）。他用它自己设新口令，
            改完**他名下所有登录都会退出**。
          </p>
          <p className="settings-runtime-status">
            码只有 30 分钟有效，且只能用一次；签发**本身不改变**账号的启用状态——
            要恢复一个被停用的账号，请单独把它启用。
          </p>
          {/* 停用的账号也列出来：给停用的人签发重置码是合法动作
              （正是"想让他回来"时要做的那一步），而**签发本身不解停用**。 */}
          {(users ?? []).map(u => (
            <div key={u.userId} className="settings-session-row">
              <div>
                <strong>{u.name}</strong>
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
        </section>
      )}

      {me?.systemRole === 'admin' && (
        <section className="panel settings-card">
          <h2>邀请新成员</h2>
          <p className="settings-runtime-status">
            生成一个邀请码发给对方，他在注册页填上即可加入「{me.roles[0]?.space ?? 'default'}」。邀请码只能用一次。
          </p>
          <button className="btn" disabled={busy} onClick={() => void makeInvite()}>生成邀请码</button>
          {invite.length > 0 && <label>邀请码<input readOnly value={invite} onFocus={e => e.target.select()} /></label>}
        </section>
      )}
    </>
  )
}
