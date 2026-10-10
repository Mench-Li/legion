import { useEffect, useState } from 'react'

export type ToastKind = 'ok' | 'err' | 'info'

interface ToastItem {
  id: number
  kind: ToastKind
  text: string
  /** 可选：点这条提醒要做的事（例如跳到通知中心）。不传就是纯提示、不可点。 */
  onClick?: () => void
}

let push: ((kind: ToastKind, text: string, onClick?: () => void) => void) | null = null

/**
 * 模块级轻量事件总线：任意组件可直接 toast('ok', '已创建')。
 *
 * `onClick` 是给**提醒**用的（BUG-021 的右下角弹框）：一条"叫你过来处理"的消息如果点不动，
 * 用户还得自己去侧栏找那个面板——那正是这条提醒本想省掉的那一步。
 */
export function toast(kind: ToastKind, text: string, onClick?: () => void): void {
  push?.(kind, text, onClick)
}

export function ToastHost(): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    push = (kind, text, onClick) => {
      const id = Date.now() + Math.random()
      setItems(prev => [...prev, { id, kind, text, onClick }])
      setTimeout(() => setItems(prev => prev.filter(i => i.id !== id)), 4200)
    }
    return () => {
      push = null
    }
  }, [])

  return (
    <div className="toast-host">
      {items.map(i => (
        <div
          key={i.id}
          className={`toast ${i.kind}${i.onClick ? ' clickable' : ''}`}
          role={i.onClick ? 'button' : undefined}
          title={i.onClick ? '点击前往处理' : undefined}
          onClick={i.onClick
            ? () => { i.onClick?.(); setItems(prev => prev.filter(x => x.id !== i.id)) }
            : undefined}
        >
          {i.text}
        </div>
      ))}
    </div>
  )
}
