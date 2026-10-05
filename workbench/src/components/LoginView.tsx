import { useEffect, useState } from 'react'
import {
  IdentityRequestError,
  lastName,
  login,
  probeIdentity,
  register,
  rememberName,
  saveSession,
} from '../identity'
import type { IdentityStatus } from '../identity'

/**
 * 指挥台的登录 / 注册页。
 *
 * ## 为什么这一页必须存在
 *
 * 在它之前，指挥台只有一把「写操作令牌」——那是**机器**的凭据，由启动器
 * 塞进 localStorage。放在自己电脑上用没问题；一旦 Hub 在服务器上、用浏览器
 * 从外面访问，用户拿到的就是一片 401，而页面上没有任何地方能让他登录。
 *
 * ## 三处刻意的克制
 *
 * ① **只在 Hub 要的时候出现。** 判据是能力发现里的 `remoteAuthRequired`。
 *    本机单机部署时它是 false，这一页根本不会渲染——把人挡在一个他本来就有权
 *    进的地方外面，与不让他进去是同一种坏。
 * ② **注册入口只在策略允许时出现。** `closed` 时整块不显示，而不是给一个
 *    点下去必然 403 的按钮。用户会以为是自己哪里点错了，然后反复试。
 * ③ **口令框永远是 password 类型，且不预填。** 这一页没有"记住我"，
 *    因为凭据的活由 `identity.ts` 管（访问令牌在 sessionStorage、刷新凭据在
 *    localStorage），这里只负责取一次。
 */
interface LoginViewProps {
  /** Hub 能力发现的结果。父组件已经拿到，这里不重复探测。 */
  status: IdentityStatus
  /** 登录/注册成功。父组件据此把会话标记为"已登录"并重新拉数据。 */
  onSignedIn: (name: string) => void
}

export function LoginView({ status, onSignedIn }: LoginViewProps): React.JSX.Element {
  const canRegister = status.registration === 'open' || status.registration === 'invite'
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState(lastName())
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [space, setSpace] = useState('default')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // 策略变了（比如管理员刚把注册关掉）而这一页还开在注册模式上时，退回登录。
  useEffect(() => {
    if (mode === 'register' && !canRegister) setMode('login')
  }, [canRegister, mode])

  async function submit(): Promise<void> {
    setError('')
    setNotice('')
    if (name.trim().length === 0 || password.length === 0) {
      setError('请填写用户名与口令')
      return
    }
    setBusy(true)
    try {
      const session = mode === 'register'
        // 空间留空时**不传**这个字段，让服务端解析——见上面输入框那段注释。
        // 传一个硬编码的 'default' 会在一个不叫 default 的 Hub 上必然失败，
        // 而失败信息只有"空间不存在"。
        ? await register({
          name: name.trim(), password,
          ...(space.trim() ? { space: space.trim() } : {}),
          ...(code.trim() ? { code: code.trim() } : {}),
        })
        : await login(name.trim(), password)
      // ★ 先落盘再回调：父组件一旦把界面切成主界面，它发出的每一个请求都
      //   立刻需要这个令牌。反过来（先切界面再存）会有一帧的 401。
      saveSession({ accessToken: session.accessToken, refreshToken: session.refreshToken })
      rememberName(session.name)
      onSignedIn(session.name)
    } catch (e) {
      // 服务端的具名码在这里不翻译成别的话——`IDENTITY_INVALID_CREDENTIALS`
      // 的原文「用户名或口令不正确」已经是对用户最准确的一句。
      setError(e instanceof IdentityRequestError ? e.message : e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <h1>Legion</h1>
        <p className="login-tagline">
          {status.bootstrapped
            ? '登录后即可查看空间看板、Agent 对话与任务进展。'
            : '这台 Hub 还没有第一个账号：请先在服务器上完成初始化。'}
        </p>

        {status.bootstrapped && (
          <>
            <label className="login-field">
              <span>用户名</span>
              <input
                value={name}
                autoComplete="username"
                autoCapitalize="off"
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void submit() }}
              />
            </label>
            <label className="login-field">
              <span>口令</span>
              <input
                type="password"
                value={password}
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void submit() }}
              />
            </label>

            {mode === 'register' && (
              <>
                <p className="login-hint">口令至少 8 个字符。</p>
                {status.registration === 'invite' && (
                  <label className="login-field">
                    <span>邀请码</span>
                    <input value={code} autoCapitalize="off" onChange={e => setCode(e.target.value)} />
                  </label>
                )}
                {status.registration === 'open' && (
                  <label className="login-field">
                    {/* 留空 = 让服务端解析。Hub 上只有一个空间时它自己选；
                        有多个时会具名拒绝并要求说清是哪一个——**不**静默挑一个，
                        挑错会把用户此后做的每件事都落在他没想要的空间里。 */}
                    <span>加入的空间（可留空）</span>
                    <input value={space} autoCapitalize="off" placeholder="只有一个空间时留空即可"
                      onChange={e => setSpace(e.target.value)} />
                  </label>
                )}
              </>
            )}

            <button className="login-submit" disabled={busy} onClick={() => void submit()}>
              {busy ? '处理中…' : mode === 'register' ? '注册并登录' : '登录'}
            </button>

            {canRegister && (
              <button
                className="login-switch"
                onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setError('') }}
              >
                {mode === 'register' ? '已有账号，去登录' : '注册新账号'}
              </button>
            )}
          </>
        )}

        {error && <div className="login-error">{error}</div>}
        {notice && <div className="login-notice">{notice}</div>}
      </div>
    </div>
  )
}

/**
 * 会话门。
 *
 * 它只做**一次**探测（能力发现），然后按结果决定渲染 `LoginView` 还是
 * `children`。刻意不在这里做"令牌有效性"的预检：那需要一次带令牌的请求，
 * 而真正需要令牌的调用（`api.ts` 那些）本来就会如实报 401，
 * 多一次往返换来的只是一句更早出现的同一句话。
 */
export function useIdentityGate(): { status: IdentityStatus | null; needsLogin: boolean } {
  const [status, setStatus] = useState<IdentityStatus | null>(null)
  useEffect(() => {
    let alive = true
    void probeIdentity().then(s => { if (alive) setStatus(s) })
    return () => { alive = false }
  }, [])
  return {
    status,
    // `null`（还没探测完）时**不**弹登录：先渲染主界面，探到了再说。
    // 反过来的话，每次刷新都会闪一下登录页——而绝大多数访问是已登录的。
    needsLogin: status !== null && status.remoteAuthRequired === true && status.enabled === true,
  }
}
