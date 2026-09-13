// workbench/src/components/settingsBits.tsx
// ============================================================================
// 模型设置页的**共享小件**
//
// 存在理由只有一条：三个面板都要把"读取状态"和"一次操作的结果"渲染成
// **不同的东西**，而如果每个面板各写一遍，就会出现三套颜色语义——
// 在其中一个面板里"读不出来"是红的、在另一个里是灰的，用户学不到任何东西。
//
// 颜色语义在这里被写死一次：
//   · `muted` —— 中性事实（空状态、加载中、全新安装还没建文件）
//   · `ok`    —— 确认过的好消息
//   · `warn`  —— 需要看一眼，但事情可能已经做成了（例如写完没能复核权限）
//   · `bad`   —— 真的没做成 / 读不出来
//
// 其中 `bad` 与 `muted` 的区别是本工作最要紧的一处：
// **「读不出来」不许长得像「是空的」。**
// ============================================================================

import type { CollectionView } from '../modelSettingsUi'

export type Tone = 'ok' | 'warn' | 'bad' | 'muted'

export interface NoticeProps {
  tone: Tone
  title: string
  /** 主要说明；可以为空。 */
  text?: string | null
  /** 逐条要说的硬话（例如"有 3 条不会导入"）。 */
  lines?: readonly string[]
  /** 下一个动作。 */
  action?: string | null
  /** 结构化错误里的 `field`：说清该改哪个输入框。 */
  field?: string | null
  /** 重试回调用；不传就不显示按钮。 */
  onRetry?: () => void
  retryLabel?: string
}

/** 一块提示。`text`/`lines`/`action` 都显式渲染——**不合并成一句话**。 */
export function Notice(props: NoticeProps): React.JSX.Element {
  const { tone, title, text, lines, action, field, onRetry, retryLabel } = props
  return (
    <div className={`set-notice ${tone}`}>
      <div className="set-notice-title">{title}</div>
      {typeof text === 'string' && text !== '' && <div className="set-notice-text">{text}</div>}
      {(lines ?? []).map((l, i) => (
        <div key={i} className="set-notice-line">· {l}</div>
      ))}
      {typeof action === 'string' && action !== '' && <div className="set-notice-action">下一步：{action}</div>}
      {typeof field === 'string' && field !== '' && <div className="set-notice-field">相关字段：{field}</div>}
      {onRetry !== undefined && (
        <button className="btn small" style={{ marginTop: 6 }} onClick={onRetry}>{retryLabel ?? '重试'}</button>
      )}
    </div>
  )
}

/** 一个读取状态 → 一块提示。`kind` 决定颜色，**不是**由调用方随手挑的。 */
export function StateBox({ view, onRetry }: { view: CollectionView; onRetry?: () => void }): React.JSX.Element | null {
  // `rows` 没有可显示的状态说明（列表本身就是它的话）。
  if (view.kind === 'rows') return null
  const tone: Tone = view.tone === 'bad' ? 'bad' : view.tone === 'ok' ? 'ok' : 'muted'
  return (
    <Notice
      tone={tone}
      title={view.headline}
      text={view.detail}
      onRetry={view.canRetry ? onRetry : undefined}
      retryLabel={view.kind === 'unreadable' ? '重新读取' : undefined}
    />
  )
}

/** 一行键值对（档案/凭证的元数据都长这样）。 */
export function Kv({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <div className="set-kv">
      <span className="set-kv-k">{k}</span>
      <span className="set-kv-v">{v}</span>
    </div>
  )
}

/** 探测徽标。语气来自 `modelSettings.ts` 的 `probeBadge`/`modelSettingsUi.ts` 的 `probeViewFrom`。 */
export function ProbeChip({ tone, label }: { tone: 'ok' | 'warn' | 'bad' | 'muted'; label: string }): React.JSX.Element {
  const cls = tone === 'ok' ? 'green' : tone === 'warn' ? 'yellow' : tone === 'bad' ? 'red' : 'muted'
  return <span className={`chip ${cls}`}>{label}</span>
}
