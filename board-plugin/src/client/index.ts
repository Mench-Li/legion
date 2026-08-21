/**
 * @dsh-external/dsh-scrum-board — client 面板（conversation.view slot）。
 * 渲染 iframe 指向 host 侧自托管的看板路由 /scrum-board/。
 * 构建：npm run build:client（tsdown → lib/client.js）。
 */
import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'

type ClientContext = {
  slots: SlotsService
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: 'dsh-scrum-board-panel',
      label: () => 'Scrum 看板',
      component: () => ({
        render() {
          const wrap = document.createElement('div')
          wrap.style.cssText = 'width:100%;height:100%;min-height:560px;display:flex;flex-direction:column;overflow:hidden;'
          const iframe = document.createElement('iframe')
          iframe.src = '/scrum-board/'
          iframe.style.cssText = 'width:100%;flex:1;border:none;min-height:560px;'
          wrap.appendChild(iframe)
          return wrap
        },
      }),
    }),
  ), 'dsh-scrum-board: panel')
}
