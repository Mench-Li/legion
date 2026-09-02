import { useEffect, useState } from 'react'
import { apiBase, setApiBase, setHubBase, setToken, getToken } from '../api'
import { statusCounts } from '../missions'
import type { BoardData } from '../types'
import { toast } from './Toast'

interface SysInfo {
  cpus: number
  memoryGb: string
  network: string
}

function useSysInfo(): SysInfo {
  const [network, setNetwork] = useState<string>(() => {
    const conn = (navigator as { connection?: { effectiveType?: string } }).connection
    return navigator.onLine ? (conn?.effectiveType ?? '在线') : '离线'
  })

  useEffect(() => {
    const conn = (navigator as {
      connection?: { effectiveType?: string; addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void }
    }).connection
    const update = (): void => {
      setNetwork(navigator.onLine ? (conn?.effectiveType ?? '在线') : '离线')
    }
    conn?.addEventListener?.('change', update)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      conn?.removeEventListener?.('change', update)
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  return {
    cpus: navigator.hardwareConcurrency ?? 0,
    memoryGb: ((navigator as { deviceMemory?: number }).deviceMemory ?? 0).toFixed(0),
    network,
  }
}

interface KpiBarProps {
  board: BoardData | null
  paused: boolean
  hubMode: boolean
  hubBase: string
  /** 中枢模式下：当前工作空间的编队人数（team-hub roster）；null 时回退 v1 看板士兵数。 */
  staffCount?: number | null
}

export function KpiBar({ board, paused, hubMode, hubBase, staffCount }: KpiBarProps): React.JSX.Element {
  const sys = useSysInfo()
  const counts = board ? statusCounts(board) : null
  // 中枢模式显示当前空间编队人数，而非 v1 看板静态士兵列表
  const staff = staffCount ?? (board ? board.soldiers.length : '–')

  const changeApi = (): void => {
    const next = window.prompt('数据源（serve.mjs 地址）', apiBase())
    if (next && next.trim() && next.trim() !== apiBase()) {
      setApiBase(next.trim())
      window.location.reload()
    }
  }

  const changeToken = (): void => {
    const next = window.prompt('写操作令牌（serve.mjs --token）', getToken())
    if (next !== null) {
      setToken(next.trim())
      toast('ok', next.trim() ? '令牌已保存' : '令牌已清空')
    }
  }

  const changeHub = (): void => {
    const next = window.prompt('team-hub v2 地址（SQLite 任务池，真 scope 分区）', hubBase)
    if (next !== null) {
      if (next.trim() && next.trim() !== hubBase) {
        setHubBase(next.trim())
        window.location.reload()
      } else if (!next.trim()) {
        localStorage.removeItem('legion.workbench.hub')
        window.location.reload()
      }
    }
  }

  return (
    <div className="kpi-bar">
      <div className="kpi">
        <div className="num">
          {counts ? counts.inProgress + counts.inReview : '–'}
          <small>进行中</small>
        </div>
        <div className="label">今日任务</div>
      </div>
      <div className="kpi">
        <div className="num">
          {counts ? counts.done : '–'}
          <small>已完成</small>
        </div>
        <div className="label">累计完成</div>
      </div>
      <div className="kpi">
        <div className="num">
          {counts ? counts.todo + counts.blocked + counts.backlog : '–'}
          <small>待处理</small>
        </div>
        <div className="label">等待处理</div>
      </div>
      <div className="kpi">
        <div className="num">
          {staff}
          <small>名</small>
        </div>
        <div className="label">AI 员工</div>
        <div className={`sub${paused ? ' dim' : ''}`}>
          {hubMode ? `● ${staffCount ?? 0} 名编队` : paused ? '⏸ 全局暂停中' : '● 全部在线'}
        </div>
      </div>
      <div className="kpi kpi-resource">
        <div className="resource-item">
          <span className="v">{sys.cpus} 核</span>
          <span className="k">CPU</span>
        </div>
        <div className="resource-item">
          <span className="v">{sys.memoryGb} GB</span>
          <span className="k">内存</span>
        </div>
        <div className="resource-item">
          <span className="v">{sys.network}</span>
          <span className="k">网络</span>
        </div>
        <div className="resource-item">
          <span className="v dim" style={{ color: 'var(--muted-2)' }}>客户端</span>
          <span className="k">本机指标</span>
        </div>
      </div>
      <div className="kpi-tools">
        <button className="btn ghost" onClick={changeHub} title="team-hub v2 地址（真 scope 分区任务池）">
          🧭 中枢{hubMode ? ' ✓' : ' ✗'}
        </button>
        <button className="btn ghost" onClick={changeApi} title="数据源地址">
          ⚙ {apiBase().replace(/^https?:\/\//, '')}
        </button>
        <button className="btn ghost" onClick={changeToken} title="写操作令牌">
          🔑 令牌
        </button>
      </div>
    </div>
  )
}
