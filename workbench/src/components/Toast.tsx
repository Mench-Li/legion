import { useEffect, useState } from 'react'

export type ToastKind = 'ok' | 'err' | 'info'

interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

let push: ((kind: ToastKind, text: string) => void) | null = null

/** 模块级轻量事件总线：任意组件可直接 toast('ok', '已创建')。 */
export function toast(kind: ToastKind, text: string): void {
  push?.(kind, text)
}

export function ToastHost(): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    push = (kind, text) => {
      const id = Date.now() + Math.random()
      setItems(prev => [...prev, { id, kind, text }])
      setTimeout(() => setItems(prev => prev.filter(i => i.id !== id)), 4200)
    }
    return () => {
      push = null
    }
  }, [])

  return (
    <div className="toast-host">
      {items.map(i => (
        <div key={i.id} className={`toast ${i.kind}`}>
          {i.text}
        </div>
      ))}
    </div>
  )
}
