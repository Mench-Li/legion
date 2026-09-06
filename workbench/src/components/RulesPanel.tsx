import { useCallback, useEffect, useState } from 'react'
import { fetchRule, hubBase, saveRule } from '../api'
import type { SpaceInfo } from '../types'
import { toast } from './Toast'

const MAX_RULES_LEN = 3000

const REPO_NORM_FILES = ['LEGION.md', 'AGENTS.md', 'agent.md']

interface RulesPanelProps {
  scope: string | null
  hubMode: boolean
  spaces?: SpaceInfo[]
  onOpenFiles?: () => void
}

export function RulesPanel({ scope, hubMode, spaces = [], onOpenFiles }: RulesPanelProps): React.JSX.Element {
  const [content, setContent] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const rule = await fetchRule('global')
      setContent(rule.content ?? '')
      setLastSavedAt(rule.updatedAt)
    } catch (e) {
      toast('err', `全局规范加载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    setLoaded(false)
    void load()
  }, [load])

  const save = async (): Promise<void> => {
    if (content.length > MAX_RULES_LEN) {
      toast('err', `全局规范超长：当前 ${content.length} 字，上限 ${MAX_RULES_LEN} 字（保存会被后端拒绝）`)
      return
    }
    setSaving(true)
    try {
      await saveRule('global', content)
      setDirty(false)
      setLastSavedAt(new Date().toISOString())
      toast('ok', `全局规范已保存（${content.length} 字）；守护下一轮派工即注入全局层规范段`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('401') ? '令牌无效或缺失：请在右上角「🔑 令牌」设置' : `保存失败：${msg}`)
    } finally {
      setSaving(false)
    }
  }

  if (!hubMode) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span style={{ color: 'var(--yellow)' }}>📜 规范中心需要 team-hub v2（中枢）</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            启动 <code>node team-hub/server.mjs</code>（:8787）后本面板自动可用
          </span>
        </div>
      </div>
    )
  }

  const currentSpace = scope !== null ? spaces.find(s => s.id === scope) ?? null : null
  const repoDir = currentSpace?.localDir ?? ''

  return (
    <div className="center-col">
      <div className="panel goal-card">
        <span className="tag" style={{ color: 'var(--muted)', fontSize: 11 }}>📜 规范中心 · 分层项目规范（R-2）</span>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>
          {scope ? `空间「${scope}」` : '全局（未选空间）'}
        </span>
      </div>

      <div className="panel">
        <div className="rules-section-head">
          <b>🌐 全局规范层（rules 表 · 跨空间适用）</b>
          <span style={{ color: 'var(--muted-2)', fontSize: 11 }}>
            团队级制度/质量标准；空间/项目层文件族与全局层冲突时，空间层优先
          </span>
        </div>
        {!loaded ? (
          <div className="scene-loading" style={{ position: 'static', padding: 20 }}>⏳ 正在读取全局规范…</div>
        ) : (
          <>
            <textarea
              className="rules-global-input"
              rows={10}
              value={content}
              placeholder="在这里维护跨空间统一规范（≤3000 字）。例如：所有任务拆分必须含验收标准；状态流转需附证据…"
              onChange={e => {
                setContent(e.target.value)
                setDirty(true)
              }}
            />
            <div className="rules-input-bar">
              <span style={{ fontSize: 10, color: content.length > MAX_RULES_LEN ? '#ff8f8f' : 'var(--muted-2)' }}>
                {content.length}/{MAX_RULES_LEN}{content.length > MAX_RULES_LEN ? '（超长，保存会被拒绝）' : ''}
                {lastSavedAt ? ` · 最近保存：${new Date(lastSavedAt).toLocaleString('zh-CN')}` : ' · 尚未保存'}
              </span>
              <span style={{ marginLeft: 'auto' }}>
                <button className="btn ghost" disabled={saving || !dirty} onClick={() => void load()}>还原</button>
                <button className="btn primary" disabled={saving || (!dirty && content.length === 0)} onClick={() => void save()}>
                  {saving ? '保存中…' : '保存全局规范'}
                </button>
              </span>
            </div>
          </>
        )}
      </div>

      <div className="panel">
        <div className="rules-section-head">
          <b>🗂 空间层规范载体（仓库文件族 · 项目/空间专属）</b>
          <span style={{ color: 'var(--muted-2)', fontSize: 11 }}>
            优先于全局层；在对应空间绑定的仓库内维护，守护扫单时自动读取并注入（空间层后置 + 优先级声明）
          </span>
        </div>
        <div className="rules-file-family">
          {REPO_NORM_FILES.map(f => (
            <div key={f} className="rules-file-row">
              <code>{repoDir ? `${repoDir}\${f}` : f}</code>
              <span style={{ color: 'var(--muted-2)', fontSize: 11 }}>
                {f === 'LEGION.md' ? '军团规章（默认读取，最优先）' : f === 'AGENTS.md' ? '智能体协同约定' : 'agent 工作说明'}
              </span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.8 }}>
          {scope === null ? (
            <>在左侧选择一个具体工作空间后，这里会列出该空间绑定仓库下的规范文件路径（文件在仓库内编辑，不在本面板直改）。</>
          ) : !currentSpace || !repoDir ? (
            <>空间「{scope}」尚未绑定本地仓库。请在空间行 ⚙ 设置中绑定「本地文件夹 + 远程仓库」，即可在该仓库根目录维护 LEGION.md / AGENTS.md / agent.md。</>
          ) : (
            <>规范文件位于空间仓库根目录：<code>{repoDir}</code>。请用文件中心或仓库编辑器维护以上三文件；
            {onOpenFiles ? (<button className="btn small" onClick={onOpenFiles}>📁 打开文件中心</button>) : '保存后守护下一轮自动读取。'}</>
          )}
        </div>
      </div>

      <div className="panel" style={{ fontSize: 11, color: 'var(--muted-2)', lineHeight: 1.9 }}>
        <b style={{ color: 'var(--muted)' }}>📐 规范载体职责总纲（分层 · 按优先级注入）</b>
        <div>① 空间/项目层仓库文件族（LEGION.md / AGENTS.md / agent.md）= 仓库规则（空间专属，优先于全局）</div>
        <div>② 全局层（rules 表，本面板维护）= 跨空间统一规范（次优先）</div>
        <div>③ skills（技能中心）= 技能内容（士兵按 scope/授权执行任务时注入）</div>
        <div>④ roles.json stage.prompt / stage-standards（角色配置）= 岗位职责与阶段交付模板</div>
        <div>数据源：team-hub v2（{hubBase()}）· POST /api/rules 审计 rules:update + SSE 实时广播</div>
      </div>
    </div>
  )
}
