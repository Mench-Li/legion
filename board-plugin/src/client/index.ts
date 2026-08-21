/**
 * @dsh-external/dsh-scrum-board — client 面板（conversation.view slot）。
 * 参照 ui-trajectory：register(options, Component)，Component 是 React 组件，
 * 渲染 iframe 指向 host 侧自托管的看板路由 /scrum-board/。
 * 构建：npm run build:client（tsdown → lib/client.js，react 走 shell 外部）。
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'

export const inject = ['slots']

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'dsh-scrum-board-panel',
    order: 20,
    label: () => 'Scrum 看板',
  }, BoardView))
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
