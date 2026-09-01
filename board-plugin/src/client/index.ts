/**
 * @dsh-external/dsh-scrum-board — client 面板。
 * 1) conversation.view：iframe 内嵌自托管看板（沿用）；
 * 2) shell.overlay：左下角常驻入口（借鉴 dsh-worktable 的侧栏常驻块），
 *    圆点显示守护心跳（/api/daemon 每 30s 探测），点击在新标签页打开
 *    军团总指挥部（scrum/console.html，独立页面，零 Token 实时总览）。
 * 构建：npm run build:client（tsdown → lib/client.js，react 走 shell 外部）。
 */
import { createElement, useEffect, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'dsh-scrum-board-panel',
    order: 20,
    label: () => 'Scrum 看板',
  }, BoardView))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-scrum-console-entry',
    order: 30,
  }, ConsoleEntry))
}

/** iframe 面板组件：占满会话视图区域，加载自托管看板。 */
function BoardView() {
  return createElement('div', {
    style: {
      width: '100%',
      height: '100%',
      minHeight: 480,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    },
  }, createElement('iframe', {
    src: '/scrum-board/',
    style: {
      width: '100%',
      flex: 1,
      border: 'none',
      minHeight: 480,
    },
  }))
}

/** 左下角常驻入口：点击在新标签页打开军团总指挥部（独立页面）。 */
function ConsoleEntry() {
  const [alive, setAlive] = useState<boolean | null>(null)
  useEffect(() => {
    let disposed = false
    const ping = () => {
      fetch('/scrum-board/api/daemon', { headers: { accept: 'application/json' } })
        .then((r) => { if (!disposed) setAlive(r.ok) })
        .catch(() => { if (!disposed) setAlive(false) })
    }
    ping()
    const timer = setInterval(ping, 30000)
    return () => { disposed = true; clearInterval(timer) }
  }, [])
  const dot = alive === null ? '#5d6a85' : alive ? '#4ade80' : '#f87171'
  return createElement('div', {
    style: { position: 'fixed', left: 16, bottom: 16, zIndex: 1000, pointerEvents: 'auto' },
  }, createElement('button', {
    type: 'button',
    title: '军团总指挥部：守护状态 + 任务实时总览（独立页面）',
    onClick: () => window.open('/scrum-board/console', '_blank', 'noopener'),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      cursor: 'pointer',
      background: 'rgba(17,24,39,0.92)',
      color: '#dbe3f0',
      border: '1px solid #1c2740',
      borderRadius: 999,
      padding: '8px 14px',
      fontSize: 13,
      fontFamily: 'inherit',
      boxShadow: '0 4px 16px rgba(0,0,0,0.45)',
    },
  },
    createElement('span', {
      style: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: dot,
        boxShadow: `0 0 6px ${dot}`,
        display: 'inline-block',
      },
    }),
    '🖥 总指挥部'))
}
