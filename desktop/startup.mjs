import { failureMessage } from './messages.mjs'

const heading = document.querySelector('#heading')
const detail = document.querySelector('#detail')
const progress = document.querySelector('#progress')
const actions = document.querySelector('#actions')

const text = {
  preparing: '检查本机环境…',
  starting: '正在启动后台服务…',
  stopping: '正在停止服务…',
  restarting: '正在重新启动服务…',
  'verifying-bundle': '校验随附的 DSH 文件…',
  'importing-runtime': '正在本地初始化 DSH…',
  'runtime-prepared': 'DSH 已准备完成…',
}

function render(state) {
  const failed = state?.state === 'failed'
  heading.textContent = failed ? 'Legion 暂时无法启动' : state?.state === 'stopped' ? 'Legion 服务已停止' : '正在启动 Legion'
  detail.textContent = failed ? `错误代码：${state.code ?? 'START_FAILED'}。${failureMessage(state.code)}` : text[state?.phase] ?? '正在检查服务状态…'
  progress.hidden = failed || state?.state === 'stopped'
  actions.hidden = !failed && state?.state !== 'stopped'
}

window.legion.onState(render)
window.legion.status().then(render)
document.querySelector('#retry').addEventListener('click', () => window.legion.retry())
document.querySelector('#stop').addEventListener('click', () => window.legion.stop())
