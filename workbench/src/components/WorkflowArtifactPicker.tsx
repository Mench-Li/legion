import { useState } from 'react'
import { toggleArtifact } from '../agentWorkflowDag'

interface Props {
  label: string
  value: string[]
  options: string[]
  placeholder: string
  allowCreate?: boolean
  onChange: (value: string[]) => void
}

export function WorkflowArtifactPicker({ label, value, options, placeholder, allowCreate = false, onChange }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const available = [...new Set([...options, ...value])]
  const normalizedQuery = query.trim()
  const visible = available.filter(option => option.toLocaleLowerCase().includes(normalizedQuery.toLocaleLowerCase()))
  const canCreate = allowCreate && normalizedQuery.length > 0
    && !available.some(option => option.toLocaleLowerCase() === normalizedQuery.toLocaleLowerCase())

  const addCustomArtifact = (): void => {
    if (!canCreate) return
    onChange([...value, normalizedQuery])
    setQuery('')
  }

  return <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
    <span>{label}</span>
    <details style={{ position: 'relative' }}>
      <summary aria-label={`${label}，已选 ${value.length} 项`} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        minHeight: 38, padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 6,
        background: 'var(--surface-1, #fff)', cursor: 'pointer', listStyle: 'none', boxSizing: 'border-box',
      }}>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 }}>
          {value.length === 0
            ? <span style={{ color: 'var(--muted-2)' }}>{placeholder}</span>
            : value.map(artifact => <span key={artifact} style={{ padding: '1px 6px', borderRadius: 10, background: 'var(--surface-2, #f2f4f7)', overflowWrap: 'anywhere' }}>{artifact}</span>)}
        </span>
        <span aria-hidden="true">⌄</span>
      </summary>
      <div style={{
        position: 'absolute', zIndex: 30, top: 'calc(100% + 4px)', left: 0, right: 0,
        display: 'grid', gap: 6, padding: 8, border: '1px solid var(--line)', borderRadius: 7,
        background: 'var(--surface-1, #fff)', boxShadow: '0 8px 24px rgba(0,0,0,.16)',
      }}>
        <input
          aria-label={`${label}搜索${allowCreate ? '或新增' : ''}`}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && canCreate) { event.preventDefault(); addCustomArtifact() } }}
          placeholder={allowCreate ? '搜索已有产物，或输入名称新增' : '搜索上游已交付的产物'}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'grid', gap: 2, maxHeight: 180, overflowY: 'auto' }}>
          {visible.map(option => <label key={option} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 2px', overflowWrap: 'anywhere' }}>
            <input type="checkbox" checked={value.includes(option)} onChange={() => onChange(toggleArtifact(value, option))} />
            <span>{option}</span>
          </label>)}
          {visible.length === 0 && !canCreate && <span style={{ color: 'var(--muted-2)', padding: 4 }}>没有匹配的产物</span>}
        </div>
        {canCreate && <button type="button" className="btn ghost" onClick={addCustomArtifact} style={{ justifySelf: 'start' }}>
          ＋ 新增“{normalizedQuery}”
        </button>}
        {value.length > 0 && <button type="button" className="btn ghost" onClick={() => onChange([])} style={{ justifySelf: 'start' }}>
          清空选择
        </button>}
      </div>
    </details>
  </div>
}
