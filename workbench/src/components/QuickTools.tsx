import { openKanban } from '../api'
import { toast } from './Toast'

interface QuickToolsProps {
  onRefresh: () => void
  refreshing: boolean
}

const DSH_TOOLS = [
  { id: 'files', icon: '📁', name: '文件浏览', desc: 'DSH 文件工具' },
  { id: 'browser', icon: '🌐', name: '打开浏览器', desc: '看板/网页' },
  { id: 'ocr', icon: '📸', name: '截图 OCR', desc: 'DSH 视觉工具' },
  { id: 'voice', icon: '🎙', name: '语音输入', desc: 'DSH 语音工具' },
]

export function QuickTools({ onRefresh, refreshing }: QuickToolsProps): React.JSX.Element {
  const click = (id: string): void => {
    if (id === 'browser') {
      openKanban()
      return
    }
    toast('info', `「${DSH_TOOLS.find(t => t.id === id)?.name}」需接入 DSH 工具面（转型第 2/3 步）`)
  }

  return (
    <div className="panel">
      <div className="panel-title">
        快捷工具
        <span className="badge">工具面</span>
      </div>
      <div className="quick-tools">
        {DSH_TOOLS.map(t => (
          <div key={t.id} className="qt" onClick={() => click(t.id)} title={t.desc}>
            <span className="ico">{t.icon}</span>
            <span>{t.name}</span>
          </div>
        ))}
        <div className="qt" onClick={onRefresh} title="重新拉取看板与动态">
          <span className="ico">🔄</span>
          <span>{refreshing ? '刷新中…' : '刷新数据'}</span>
        </div>
        <div className="qt" onClick={() => toast('info', '技能中心经 team-hub /api/skills 拉取（第 2 步）')} title="团队共享技能">
          <span className="ico">🧩</span>
          <span>共享技能</span>
        </div>
      </div>
    </div>
  )
}
