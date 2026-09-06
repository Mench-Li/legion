// workbench/src/components/MarkdownDocView.tsx — R-3/S4 自研 markdown 子集渲染器
// 设计约束（REQUIREMENTS.md R-3/AC-R3-4/AC-R3-5 + RESEARCH.md K6-A）：
//  1. React 元素直出、零第三方依赖（仅 react/jsx-runtime）；不注入/不解析任何原始 HTML，
//     正文中的 <script>/<img onerror> 等一律按文本转义显示（不执行）；
//  2. 链接 href 协议白名单集中在 SAFE_PROTOCOLS 一处（http/https/mailto/相对路径/#），
//     javascript:/data:/vbscript: 等一律退化为纯文本；
//  3. 子集语法：标题/段落/粗斜体/行内代码/围栏代码块/有序无序列表（含嵌套）/表格/引用/分割线/链接；
//     不支持的语法按文本原样回退（不抛错、不吞内容）。
import type { ReactElement, ReactNode } from 'react'

/** 链接协议白名单（集中一处便于审计，AC-R3-5 审查面）。相对路径（无 scheme）与 # 锚点天然放行。 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/** 反引号字符（markdown 行内代码/围栏定界符，避免源文件出现裸反引号模板串）。 */
const MD_TICK = String.fromCharCode(96)

/** href 安全校验：返回 null 表示不安全 → 调用方按纯文本渲染。 */
export function safeHref(raw: string): string | null {
  const href = raw.trim()
  if (href === '' || href.startsWith('#') || href.startsWith('/') || href.startsWith('./') || href.startsWith('../')) return href
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)
  if (m !== null) {
    const scheme = m[1].toLowerCase() + ':'
    if (!SAFE_PROTOCOLS.has(scheme)) return null
  }
  return href
}

let uid = 0
function nextKey(): number { uid += 1; return uid }

const CODE_RE = new RegExp('^(?:' + MD_TICK + '+)([^' + MD_TICK + ']+?)(?:' + MD_TICK + '+)')
const FENCE = new RegExp('^(' + MD_TICK + '{3,}|~{3,})\\s*([\\w+.-]*)\\s*$')

/** 行内语法扫描（code/bold/italic/strike/link）。未匹配字符按文本原样前进，绝不丢内容。 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let cursor = 0
  let buf = ''
  const flush = () => { if (buf !== '') { out.push(buf); buf = '' } }
  while (cursor < text.length) {
    const rest = text.slice(cursor)
    const code = CODE_RE.exec(rest)
    if (code) { flush(); out.push(<code key={nextKey()}>{code[1]}</code>); cursor += code[0].length; continue }
    const bold = /^(\*\*|__)([\s\S]+?)\1/.exec(rest)
    if (bold) { flush(); out.push(<strong key={nextKey()}>{inline(bold[2])}</strong>); cursor += bold[0].length; continue }
    const strike = /^(~~)([\s\S]+?)\1/.exec(rest)
    if (strike) { flush(); out.push(<s key={nextKey()}>{inline(strike[2])}</s>); cursor += strike[0].length; continue }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest)
    if (link) {
      flush()
      const label = link[1].trim()
      const href = safeHref(link[2])
      if (href !== null) {
        const isHttp = href.startsWith('http://') || href.startsWith('https://')
        out.push(<a key={nextKey()} href={href} target={isHttp ? '_blank' : undefined} rel={isHttp ? 'noreferrer noopener' : undefined}>{label}</a>)
      } else {
        out.push(<span key={nextKey()}>{label}</span>) // javascript: 等协议 → 纯文本
      }
      cursor += link[0].length
      continue
    }
    const italic = /^([*_])(?!\s)([^*_\n]+?)(?<!\s)\1/.exec(rest)
    if (italic) { flush(); out.push(<em key={nextKey()}>{italic[2]}</em>); cursor += italic[0].length; continue }
    // 图片语法（子集外）→ 原样文本回退（不得解析出可点击链接或 img 标签）
    if (rest.startsWith('![')) {
      const img = /^!\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(rest)
      if (img) { flush(); out.push(img[0]); cursor += img[0].length; continue }
    }
    // 纯文本累积进 buf（相邻文本只产生一个 text node，避免 SSR 注释分隔符干扰可读性断言）
    buf += text[cursor]
    cursor += 1
  }
  flush()
  return out
}

/** 缩进（tab=2 空格）。 */
function indentOf(line: string): number {
  let n = 0
  for (const ch of line) {
    if (ch === ' ') n += 1
    else if (ch === '\t') n += 2
    else break
  }
  return n
}

interface ListItem { indent: number; ordered: boolean; text: string }

/** 有序/无序列表渲染（按缩进递归成嵌套 <ul>/<ol>，深度不限）。 */
function renderListItems(items: ListItem[]): ReactNode[] {
  const els: ReactNode[] = []
  let i = 0
  while (i < items.length) {
    const start = items[i]
    const group: ListItem[] = []
    while (i < items.length && items[i].indent === start.indent && items[i].ordered === start.ordered) {
      group.push(items[i]); i += 1
    }
    const lis: ReactNode[] = []
    for (const item of group) {
      const nested: ListItem[] = []
      while (i < items.length && items[i].indent > item.indent) { nested.push(items[i]); i += 1 }
      lis.push(
        <li key={nextKey()}>
          {inline(item.text)}
          {nested.length > 0 ? renderListItems(nested) : null}
        </li>,
      )
    }
    els.push(start.ordered ? <ol key={nextKey()}>{lis}</ol> : <ul key={nextKey()}>{lis}</ul>)
  }
  return els
}

function splitCells(line: string): string[] {
  let l = line.trim()
  if (l.startsWith('|')) l = l.slice(1)
  if (l.endsWith('|')) l = l.slice(0, -1)
  return l.split('|').map(s => s.trim())
}

const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$/

const H1_RE = /^(#{1,6})\s+/
const IS_LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+/
const HR_RE = /^(?:[-*_][ \t]*){3,}$/

/** 块级解析主循环：行流 → React 节点数组。 */
function parseBlocks(markdown: string): ReactNode[] {
  const text = String(markdown).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = text.split('\n')
  const nodes: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '') { i += 1; continue }
    // 围栏代码块
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const opener = fence[1]
      const lang = fence[2]
      const buf: string[] = []
      i += 1
      let closed = false
      while (i < lines.length) {
        if (lines[i].trim().startsWith(opener[0])) { i += 1; closed = true; break }
        buf.push(lines[i]); i += 1
      }
      const codeText = buf.join('\n')
      nodes.push(<pre key={nextKey()}><code className={lang.length > 0 ? 'language-' + lang : undefined}>{codeText}</code></pre>)
      if (!closed) break
      continue
    }
    // 标题
    if (H1_RE.test(line)) {
      const level = (H1_RE.exec(line)?.[1].length ?? 1)
      const content = line.slice(level).replace(/^\s+/, '')
      const Tag = ('h' + Math.min(level, 6)) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      const key = nextKey()
      nodes.push(Tag === 'h1' ? <h1 key={key}>{inline(content)}</h1>
        : Tag === 'h2' ? <h2 key={key}>{inline(content)}</h2>
        : Tag === 'h3' ? <h3 key={key}>{inline(content)}</h3>
        : Tag === 'h4' ? <h4 key={key}>{inline(content)}</h4>
        : Tag === 'h5' ? <h5 key={key}>{inline(content)}</h5>
        : <h6 key={key}>{inline(content)}</h6>)
      i += 1
      continue
    }
    // 分割线
    if (HR_RE.test(trimmed)) { nodes.push(<hr key={nextKey()} />); i += 1; continue }
    // 引用块
    if (trimmed.startsWith('>')) {
      const buf: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, '')); i += 1
      }
      nodes.push(<blockquote key={nextKey()}>{inline(buf.join(' '))}</blockquote>)
      continue
    }
    // 列表
    if (IS_LIST_LINE.test(line)) {
      const items: ListItem[] = []
      while (i < lines.length && IS_LIST_LINE.test(lines[i])) {
        const raw = lines[i]
        const indent = indentOf(raw)
        const m = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw.trim())
        if (m === null) break
        items.push({ indent, ordered: /^\d+[.)]/.test(raw.trim()), text: m[1] })
        i += 1
      }
      nodes.push(...renderListItems(items))
      continue
    }
    // 表格：行含 | 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].trim())) {
      const header = splitCells(line)
      i += 2 // 跳过表头与分隔行
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitCells(lines[i])); i += 1
      }
      const cols = Math.max(header.length, ...rows.map(r => r.length))
      const ths = Array.from({ length: cols }, (_, c) => <th key={c}>{inline(header[c] ?? '')}</th>)
      const bodyRows = rows.map((r, ri) => (
        <tr key={ri}>{Array.from({ length: cols }, (_, c) => <td key={c}>{inline(r[c] ?? '')}</td>)}</tr>
      ))
      nodes.push(
        <table key={nextKey()}>
          <thead><tr>{ths}</tr></thead>
          <tbody>{bodyRows}</tbody>
        </table>,
      )
      continue
    }
    // 段落：连续非空行聚合（内部软换行按空格处理）
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '') {
      const l = lines[i]
      if (H1_RE.test(l)) break
      if (FENCE.test(l)) break
      if (l.trim().startsWith('>')) break
      if (IS_LIST_LINE.test(l)) break
      if (HR_RE.test(l.trim())) break
      if (l.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].trim())) break
      para.push(l.trim()); i += 1
    }
    nodes.push(<p key={nextKey()}>{inline(para.join(' '))}</p>)
  }
  return nodes
}

export interface MarkdownDocViewProps {
  /** 原始 markdown 文本（不可信输入：原始 HTML / 危险协议均按文本安全处理）。 */
  content: string
  className?: string
  /** 最大可视高度（px），超出内部滚动；缺省不限制。 */
  maxHeight?: number
}

/** 文档内容渲染（任务详情「产出文档」区预览用）。 */
export default function MarkdownDocView({ content, className, maxHeight }: MarkdownDocViewProps): ReactElement {
  return (
    <div
      className={className ?? ''}
      data-md-view=""
      style={maxHeight !== undefined ? { maxHeight: maxHeight, overflowY: 'auto' } : undefined}
    >
      {parseBlocks(content)}
    </div>
  )
}
