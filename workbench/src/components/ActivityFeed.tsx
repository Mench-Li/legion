import type { ActivityEvent } from '../types'

interface ActivityFeedProps {
  events: ActivityEvent[]
}

function fmtTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function ActivityFeed({ events }: ActivityFeedProps): React.JSX.Element {
  return (
    <div className="panel">
      <div className="panel-title">
        <span className="live-dot" />
        实时动态
        <span className="badge">SSE</span>
      </div>
      <div className="activity-feed">
        {events.length === 0 && (
          <div style={{ padding: 14, color: 'var(--muted-2)', fontSize: 12 }}>
            暂无动态（守护派工后这里实时滚动）
          </div>
        )}
        {events.map((ev, idx) => (
          <div key={`${ev.ts}-${idx}`} className="activity-item">
            <span className="time">{fmtTime(ev.ts)}</span>
            <span className="kind">{ev.kind}</span>
            <span className="txt">
              {ev.taskId ? `[${ev.taskId}] ` : ''}
              {ev.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
