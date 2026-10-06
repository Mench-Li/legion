import { useEffect, useState } from 'react'
import {
  createPairingCode,
  hasSession,
  IdentityRequestError,
  listDevices,
  revokeDevice,
  rotateDeviceToken,
} from '../identity'
import type { DeviceRow } from '../identity'
import { toast } from './Toast'

/**
 * 「执行设备」一节：把电脑接到这台 Hub 上，以及撤销一台丢了的。
 *
 * ## 它补的是哪条断链
 *
 * 在这之前，把一台电脑接到 Hub 上**只有一条路**：在服务器上跑
 * `product/server/make-pairing-code.sh`。于是刚在手机上注册完的用户，
 * 没有任何办法让自己电脑上的 Legion 连上来——他能看见空间、能看见 Agent，
 * 而任务永远停在"等电脑领取"，界面上的措辞还全是对的。
 *
 *   > 一个"能注册、能登录、但永远连不上自己电脑"的产品，
 *   > 与一个还没做完的产品，在用户那边是同一个东西——
 *   > 只不过前者每一步看起来都成功了。
 *
 * 另一半是**撤销**。丢了笔记本的人在这里能立刻把那台设备踢下线；
 * 会话那一节能踢"登录"，但踢不掉"这台机器可以领任务"这件事——它们是两件事。
 *
 * ## 只在真的用账号体系时出现
 *
 * 与 `AccountPanel` 同一条纪律：判据是"手上有没有用户会话"。本机单机部署
 * 用的是机器令牌，这一节不渲染——那里的设备管理走的是本机文件，不是这一套。
 */
export function DevicePanel(): React.JSX.Element | null {
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [nodeName, setNodeName] = useState('')
  const [busy, setBusy] = useState(false)
  const [pairing, setPairing] = useState<{ code: string; nodeName: string; expiresAtMs: number } | null>(null)
  const [rotated, setRotated] = useState<{ nodeId: string; token: string } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const active = hasSession()

  async function reload(): Promise<void> {
    if (!active) { setLoaded(true); return }
    try { setDevices(await listDevices()) }
    catch (e) { toast('err', e instanceof IdentityRequestError ? e.message : String(e)) }
    finally { setLoaded(true) }
  }

  useEffect(() => { void reload() }, [])

  // 本机单机部署：不渲染。见文件头。
  if (!active && loaded) return null

  async function makeCode(): Promise<void> {
    if (nodeName.trim().length === 0) { toast('err', '给这台电脑起个名字（比如"我的台式机"），撤销时你才认得出它是哪一台'); return }
    setBusy(true)
    try {
      setPairing(await createPairingCode(nodeName.trim()))
      setRotated(null)
    } catch (e) { toast('err', e instanceof IdentityRequestError ? e.message : String(e)) } finally { setBusy(false) }
  }

  async function rotate(nodeId: string): Promise<void> {
    setBusy(true)
    try {
      const token = await rotateDeviceToken(nodeId)
      setRotated({ nodeId, token })
      setPairing(null)
      toast('ok', '已换新令牌。那台电脑上的旧令牌**立刻失效**，要用新令牌重连。')
      await reload()
    } catch (e) { toast('err', e instanceof IdentityRequestError ? e.message : String(e)) } finally { setBusy(false) }
  }

  async function revoke(nodeId: string): Promise<void> {
    setBusy(true)
    try {
      await revokeDevice(nodeId)
      toast('ok', '已撤销。那台设备不能再连本 Hub，也不会再领到任务。')
      await reload()
    } catch (e) { toast('err', e instanceof IdentityRequestError ? e.message : String(e)) } finally { setBusy(false) }
  }

  return (
    <>
      <section className="panel settings-card">
        <h2>连接一台电脑</h2>
        <p className="settings-runtime-status">
          在你**要干活的那台电脑**上装好 Legion 之后，在这里生成一个配对码，把它填进那台电脑的配对提示里。
          配对码只能用一次，默认 10 分钟后失效。
        </p>
        <label>这台电脑叫什么
          <input value={nodeName} placeholder="我的台式机" onChange={e => setNodeName(e.target.value)} />
        </label>
        <button className="btn primary" disabled={busy} onClick={() => void makeCode()}>生成配对码</button>
        {pairing !== null && (
          <>
            <label>配对码（只能用一次）
              <input readOnly value={pairing.code} onFocus={e => e.target.select()} />
            </label>
            <p className="settings-runtime-status">
              {pairing.nodeName} · 有效至 {new Date(pairing.expiresAtMs).toLocaleTimeString()}
            </p>
          </>
        )}
      </section>

      <section className="panel settings-card">
        <h2>执行设备（{devices.filter(d => !d.revoked).length}）</h2>
        {devices.filter(d => !d.revoked).length === 0 && (
          <p className="settings-runtime-status">
            还没有设备。任务会一直停在「等电脑领取」——那不是故障，是还没有电脑接上来。
          </p>
        )}
        {devices.filter(d => !d.revoked).map(d => (
          <div key={d.nodeId} className="settings-session-row">
            <div>
              <strong>{d.name}</strong>
              {/* 三种状态，**不是两种**："在线 / 离线 / 还没连过"。
                  刚配好对、还没启动那台电脑上的 Legion 时显示"离线"，会让人
                  以为配对失败了，然后去重配一次——而那一遍会造出第二台设备。
                  与手机端 `deriveConnectionState` 里"没有设备时是未知而不是离线"
                  是同一条纪律。 */}
              <p className="settings-runtime-status">
                {d.presence?.lastHeartbeatAt == null
                  ? '还没连过'
                  : d.presence.online === true ? '在线' : '离线'}
                {d.platform ? `　${d.platform}` : ''}
                {d.presence?.lastHeartbeatAt != null ? `　最近心跳 ${d.presence.lastHeartbeatAt}` : ''}
              </p>
              <p className="settings-runtime-status">{d.nodeId}</p>
            </div>
            <div className="settings-row-actions">
              <button className="btn" disabled={busy} onClick={() => void rotate(d.nodeId)}>换令牌</button>
              <button className="btn" disabled={busy} onClick={() => void revoke(d.nodeId)}>撤销</button>
            </div>
          </div>
        ))}
        {rotated !== null && (
          <>
            <label>这台设备的新令牌（只显示这一次）
              <input readOnly value={rotated.token} onFocus={e => e.target.select()} />
            </label>
            <p className="settings-runtime-status">把它填进那台电脑的配置里。旧令牌已经失效。</p>
          </>
        )}
      </section>
    </>
  )
}
