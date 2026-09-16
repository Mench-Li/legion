import { useState } from 'react'
import { revealFileLocation } from '../api'
import { toast } from './Toast'

interface RevealButtonProps {
  /** 目标所属工作空间 id（null/undefined = 未知空间：按钮禁用，避免点了没反应）。 */
  scope: string | null | undefined
  /** 空间根内相对路径（文件或目录；'' = 空间根目录本身）。 */
  path: string
  /** 按钮文案（默认「📂 位置」）。 */
  label?: string
  /** 按钮样式类（默认 `btn mini`，用于列表行内）。 */
  className?: string
  /** 成功提示里显示的名字（默认取路径末段）。 */
  what?: string
}

/** 取路径末段（兼容 / 与 \）。 */
function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf(String.fromCharCode(92)))
  return i >= 0 ? p.slice(i + 1) : p
}

/**
 * 「打开所在位置」——把产出文件/目录一键交给本机文件管理器定位
 * （Windows 资源管理器选中该文件；macOS Finder；Linux 打开所在目录）。
 *
 * 走 workbench 本地服务 `POST /api/files/reveal`（仅回环 + 写令牌）：服务端把 scope 解析成空间绑定的
 * 本地文件夹，并在根内做越界 / 符号链接逃逸 / .git 校验——界面只传相对路径，绝不传绝对路径。
 * 目标已不存在时（产物登记后 worktree 被回收是常态）服务端回落到最近的既有上级目录并回传 missing，
 * 这里如实提示「已定位到最近位置」，而不是报一个用户无能为力的错误。
 */
export function RevealButton({ scope, path, label = '📂 位置', className = 'btn mini', what }: RevealButtonProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const doReveal = async (): Promise<void> => {
    if (!scope) return
    setBusy(true)
    try {
      const r = await revealFileLocation(scope, path)
      const name = what ?? (path.length > 0 ? baseName(path) : '空间根目录')
      if (r.missing) toast('info', `原文件已不在（可能已合入或被回收）——已打开最近位置：${r.dir ?? ''}`)
      else toast('ok', `已打开所在位置：${name}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      toast('err', msg.includes('401') ? '打开所在位置失败：令牌无效或缺失（右上角「🔑 令牌」）' : `打开所在位置失败：${msg}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      className={className}
      disabled={busy || !scope}
      title={scope ? `在本机文件管理器中定位：${path.length > 0 ? path : '（空间根目录）'}` : '该条目未关联工作空间，无法定位本地位置'}
      onClick={() => void doReveal()}
    >
      {busy ? '定位中…' : label}
    </button>
  )
}
