import { failureMessage } from './messages.mjs'

const heading = document.querySelector('#heading')
const detail = document.querySelector('#detail')
const progress = document.querySelector('#progress')
const actions = document.querySelector('#actions')
const setup = document.querySelector('#setup')
const description = document.querySelector('#description')
const workspacePath = document.querySelector('#workspace-path')
const configureWorkspace = document.querySelector('#configure-workspace')

const text = {
  preparing: '检查本机环境…',
  initializing: '正在保存工作区设置…',
  starting: '正在启动后台服务…',
  stopping: '正在停止服务…',
  restarting: '正在重新启动服务…',
  'verifying-bundle': '校验随附的 DSH 文件…',
  'importing-runtime': '正在本地初始化 DSH…',
  'runtime-prepared': 'DSH 已准备完成…',
  'verifying-runtime': '校验初始化后的文件…',
}

function render(state) {
  const failed = state?.state === 'failed'
  const configuring = state?.state === 'setup-required'
  setup.hidden = !configuring || state.phase !== 'workspace'
  description.textContent = configuring ? state.phase === 'workspace'
    ? '先选择一个工作区，再配置执行身份和模型。' : '工作区已保存。执行身份和模型配置完成后，才能运行任务。'
    : '正在准备工作台和后台服务，请稍候。'
  if (configuring) {
    heading.textContent = state.phase === 'workspace' ? '设置 Legion 工作区' : '继续首次设置'
    detail.textContent = state.phase === 'workspace' ? '请选择项目文件夹。' : '尚未完成执行身份和模型验证。'
    workspacePath.textContent = state.workspace ?? '尚未选择文件夹'
    configureWorkspace.disabled = !state.workspace
    progress.hidden = true
    actions.hidden = true
    return
  }
  heading.textContent = failed ? 'Legion 暂时无法启动' : state?.state === 'stopped' ? 'Legion 服务已停止' : '正在启动 Legion'
  detail.textContent = failed ? `错误代码：${state.code ?? 'START_FAILED'}。${failureMessage(state.code)}` : text[state?.phase] ?? '正在检查服务状态…'
  if (!failed && Number.isSafeInteger(state?.completed) && Number.isSafeInteger(state?.total) && state.total > 0 && state.completed >= 0 && state.completed <= state.total) {
    detail.textContent += `（${Math.floor(state.completed * 100 / state.total)}%）`
  }
  progress.hidden = failed || state?.state === 'stopped'
  actions.hidden = !failed && state?.state !== 'stopped'
}

window.legion.onState(render)
window.legion.status().then(render)
document.querySelector('#retry').addEventListener('click', () => window.legion.retry())
document.querySelector('#stop').addEventListener('click', () => window.legion.stop())

async function workspaceCommand(command) {
  const choose = document.querySelector('#choose-workspace')
  choose.disabled = true
  configureWorkspace.disabled = true
  try { render(await window.legion[command]()) }
  catch { detail.textContent = '设置未完成，请稍后重试。' }
  finally { choose.disabled = false }
}
document.querySelector('#choose-workspace').addEventListener('click', () => workspaceCommand('chooseWorkspace'))
configureWorkspace.addEventListener('click', () => workspaceCommand('configureWorkspace'))
