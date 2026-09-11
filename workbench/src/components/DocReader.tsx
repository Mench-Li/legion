// workbench/src/components/DocReader.tsx — ① 文档放大阅读层（任务详情「产出文档」的放大通道）
// 设计约束：不改变既有内嵌预览语义（R-2/AC-R2-*）与渲染安全纪律（AC-R3-5）——
//  1. 正文一律经 MarkdownDocView 文本节点渲染，本组件不引入 dangerouslySetInnerHTML；
//  2. 单层滚动（本层自己滚），不受 .modal-body max-height 与 .modal{overflow:auto} 裁切（挂在弹层之外、z-index 高于 .modal-mask）；
//  3. 字号通过 --md-zoom 变量整体缩放（正文/标题/表格/代码同比例），Esc 关闭。
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import MarkdownDocView from './MarkdownDocView'
import { toast } from './Toast'

const ZOOM_DEFAULT = 1.35
const ZOOM_MIN = 0.85
const ZOOM_MAX = 2.4
const ZOOM_STEP = 0.15

const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z.toFixed(2))))

export interface DocReaderProps {
  /** 文档标题（条目 title 或文件名）。 */
  title: string
  /** 仓库相对路径（可点击复制）。 */
  path: string
  /** 登记岗位显示名。 */
  by?: string
  /** 登记时间显示串。 */
  at?: string
  /** 文本内容（已由 hub 内容通道按预览上限截断）。 */
  content: string
  /** text/markdown | text/plain。 */
  mime?: string
  /** 服务端截断标记与上限/原文大小（底部脚注提示）。 */
  truncated?: boolean
  limit?: number
  size?: number
  /** worktree = 读取自分支态目录（未合入主分支的最终态）。 */
  source?: string
  onClose: () => void
}

/** 全屏放大阅读层：正文列宽受限居中、单层滚动、字号可调（Esc 关闭）。 */
export default function DocReader(props: DocReaderProps): ReactElement {
  const { title, path, by, at, content, mime, truncated, limit, size, source, onClose } = props
  const [zoom, setZoom] = useState(ZOOM_DEFAULT)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copyText = (text: string, okText: string): void => {
    const pending = navigator.clipboard?.writeText(text)
    if (pending === undefined) { toast('err', '当前环境不支持剪贴板（可改用「下载 .md」）'); return }
    void pending.then(() => toast('ok', okText)).catch(() => toast('err', '复制失败（可改用「下载 .md」）'))
  }
  const copyAll = (): void => copyText(content, '已复制文档全文')
  const download = (): void => {
    const name = path.split('/').pop() ?? 'doc.md'
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }
  const sizeText = size === undefined || size <= 0
    ? ''
    : size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${(size / 1024).toFixed(0)} KB`

  return (
    <div className="doc-reader-mask" onClick={onClose}>
      <div
        className="doc-reader"
        onClick={e => e.stopPropagation()}
        style={{ '--md-zoom': String(zoom) } as CSSProperties}
      >
        <div className="doc-reader-head">
          <div className="doc-reader-heading">
            <div className="doc-reader-title" title={title}>{title}</div>
            <div
              className="doc-reader-path"
              title="点击复制完整路径"
              onClick={() => copyText(path, '已复制完整路径')}
            >
              {path}
            </div>
          </div>
          <div className="doc-reader-tools">
            {by !== undefined && by !== '' && <span className="doc-by">{by}</span>}
            {at !== undefined && at !== '' && <span className="doc-at">{at}</span>}
            {source === 'worktree' && <span className="doc-reader-tag" title="读取自本任务分支态目录（未合入主分支的最终态）">分支态</span>}
            <button className="btn mini" onClick={() => setZoom(z => clampZoom(z - ZOOM_STEP))} title="缩小字号">A−</button>
            <span className="doc-reader-zoom" title="当前字号（相对内嵌预览基准）">{Math.round(zoom * 100)}%</span>
            <button className="btn mini" onClick={() => setZoom(z => clampZoom(z + ZOOM_STEP))} title="放大字号">A+</button>
            <button className="btn mini" onClick={() => setZoom(ZOOM_DEFAULT)} title="恢复默认字号">重置</button>
            <button className="btn mini" onClick={copyAll} title="复制文档全文到剪贴板">复制全文</button>
            <button className="btn mini" onClick={download} title="下载为 .md 文件，离线阅读或打印成 PDF">下载 .md</button>
            <button className="btn mini" onClick={onClose} title="关闭（Esc）">✕ 关闭</button>
          </div>
        </div>
        <div className="doc-reader-body">
          {mime === 'text/plain'
            ? <pre className="doc-plain doc-reader-plain">{content}</pre>
            : <MarkdownDocView content={content} />}
        </div>
        <div className="doc-reader-foot">
          全屏阅读 · Esc 关闭 · A−/A+ 调字号
          {truncated === true && ` · ⚠ 文档过大已截断：仅展示前 ${((limit ?? 512 * 1024) / 1024).toFixed(0)} KB`}
          {sizeText !== '' && ` · 原文 ${sizeText}`}
        </div>
      </div>
    </div>
  )
}
