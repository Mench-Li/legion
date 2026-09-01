/**
 * @dsh-external/dsh-scrum-board — client 面板。
 * 1) conversation.view：iframe 内嵌自托管看板（沿用）；
 * 2) sidebar.footer.action：侧栏底部常驻块（借鉴 dsh-worktable 的「工作台」区块，
 *    非悬浮层、不遮挡设置按钮），圆点显示守护心跳（/api/daemon 每 30s 探测），
 *    点击在新标签页打开军团总指挥部（scrum/console.html，独立页面，零 Token 实时总览）。
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
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'dsh-scrum-console',
    order: 20,
  }, ConsoleSection))
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

/** 侧栏「总指挥部」常驻块：圆点守护心跳，点击在新标签页打开总指挥部独立页面。 */
function ConsoleSection() {
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
  const stateText = alive === null ? '守护状态未知' : alive ? '守护在线' : '守护未自述'
  return createElement('div', {
    style: { padding: '6px 10px' },
  }, createElement('button', {
    type: 'button',
    title: '军团总指挥部：守护状态 + 任务实时总览（独立页面）',
    onClick: () => window.open('/scrum-board/console', '_blank', 'noopener'),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      cursor: 'pointer',
      width: '100%',
      background: 'rgba(17,24,39,0.92)',
      color: '#dbe3f0',
      border: '1px solid #1c2740',
      borderRadius: 8,
      padding: '8px 10px',
      fontSize: 13,
      fontFamily: 'inherit',
    },
  },
    createElement('span', {
      style: {
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: dot,
        display: 'inline-block',
        flex: 'none',
      },
    }),
    createElement('span', { style: { flex: 1, textAlign: 'left' } }, '🖥 总指挥部'),
    createElement('span', { style: { fontSize: 11, color: '#7d8aa3', flex: 'none' } }, stateText)))
}
