// workbench/src/avatar/AgentAvatar.tsx
// 参数化人形内联 SVG 头像（零第三方依赖、零图片资源、零网络请求）。
//
// 与 3D 场景的 Employee3D 同一套视觉语言（肤色 #e9bd93、发色 #28364b、6 色上衣），
// 但**不消费** 3D 的 appearanceSeed —— 头像只由 role 派生的令牌决定（AC-R5-1、O-3 不联动）。
import { resolveSlot, PLACEHOLDER_SLOT } from './slots'
import type { AvatarSlot } from './types'

export interface AgentAvatarProps {
  /** 头像令牌（`human:<key>`）；缺失/非法/旧 emoji 都渲染确定性占位人形。 */
  token?: string | null
  /** 成员展示名（保留在契约里；不参与渲染，回退也不用名称首字）。 */
  name?: string
  /** 像素尺寸，缺省 32；非法值归一到 32。 */
  size?: number
  className?: string
}

function clampSize(size: number | undefined): number {
  if (typeof size !== 'number' || !Number.isFinite(size)) return 32
  const rounded = Math.round(size)
  if (rounded < 12 || rounded > 512) return 32
  return rounded
}

function Hair({ slot }: { slot: AvatarSlot }): React.JSX.Element | null {
  if (slot.hairStyle === 'short') return <path d="M8.6 11.4c.5-4 3.4-6.2 7.4-6.2s6.8 2.2 7.2 6.2c-1.6-1.7-4-2.4-7.2-2.4s-5.8.7-7.4 2.4z" fill={slot.hair} />
  if (slot.hairStyle === 'bob') return <path d="M8.2 13c0-4.6 3.2-7.6 7.8-7.6s7.8 3 7.8 7.6l-.9 6.6c-1.2-2.6-1.6-5.2-1.3-7.6-1.7.9-3.7 1.3-5.6 1.3s-3.9-.4-5.6-1.3c.3 2.4-.1 5-1.3 7.6z" fill={slot.hair} />
  if (slot.hairStyle === 'bun') return <g><circle cx="16" cy="4.4" r="2.6" fill={slot.hair} /><path d="M8.7 12c0-4.3 3.1-6.8 7.3-6.8s7.3 2.5 7.3 6.8c-1.6-1.8-4-2.6-7.3-2.6s-5.7.8-7.3 2.6z" fill={slot.hair} /></g>
  return <path d="M8.4 12.2c-.6-1 .2-2.2 1.3-2.2-.6-1.1.4-2.3 1.6-2.1-.3-1.2.9-2.1 2-1.6.2-1.2 1.7-1.7 2.6-.8.9-.9 2.4-.4 2.6.8 1.1-.5 2.3.4 2 1.6 1.2-.2 2.2 1 1.6 2.1 1.1 0 1.9 1.2 1.3 2.2-1.4-1.4-3.6-2.2-7.5-2.2s-6.1.8-7.5 2.2z" fill={slot.hair} />
}

function Accessory({ slot }: { slot: AvatarSlot }): React.JSX.Element | null {
  if (slot.accessory === 'glasses') return <g fill="none" stroke="#28364b" strokeWidth="0.7"><circle cx="13" cy="13" r="2.6" /><circle cx="19" cy="13" r="2.6" /><rect x="15.4" y="12.6" width="1.2" height="0.6" fill="#28364b" stroke="none" /></g>
  if (slot.accessory === 'beard') return <path d="M10.4 14.4c0 4.5 2.5 7.2 5.6 7.2s5.6-2.7 5.6-7.2c-1.5 2.1-3.4 3-5.6 3s-4.1-.9-5.6-3z" fill={slot.hair} opacity="0.85" />
  if (slot.accessory === 'earring') return <circle cx="9.2" cy="15.4" r="0.9" fill="#f1c766" />
  if (slot.accessory === 'cap') return <path d="M8.4 9.6c0-3.6 3.2-5.4 7.6-5.4s7.6 1.8 7.6 5.4l-.2 1.2H8.6z" fill={slot.top} />
  return null
}

export default function AgentAvatar(props: AgentAvatarProps): React.JSX.Element {
  const { token, size, className } = props
  const slot = resolveSlot(token) ?? PLACEHOLDER_SLOT
  const px = clampSize(size)
  const cls = className ? 'agent-avatar-svg ' + className : 'agent-avatar-svg'
  return (
    <svg className={cls} width={px} height={px} viewBox="0 0 32 32" role="img" aria-label="成员头像">
      <rect x="0" y="0" width="32" height="32" rx="9" fill={slot.background} />
      <path d="M6 30c0-5 4.5-8 10-8s10 3 10 8z" fill={slot.top} />
      <rect x="13.4" y="18.6" width="5.2" height="4.4" rx="2" fill={slot.skin} />
      <ellipse cx="16" cy="13" rx="7" ry="7.5" fill={slot.skin} />
      <Hair slot={slot} />
      <rect x="11.6" y="10.8" width="2.8" height="0.6" rx="0.3" fill={slot.hair} />
      <rect x="17.6" y="10.8" width="2.8" height="0.6" rx="0.3" fill={slot.hair} />
      <circle cx="13" cy="13" r="0.95" fill="#253344" />
      <circle cx="19" cy="13" r="0.95" fill="#253344" />
      <path d="M14.4 16.6c.9.7 2.3.7 3.2 0" stroke="#b66e63" strokeWidth="0.9" fill="none" strokeLinecap="round" />
      <Accessory slot={slot} />
    </svg>
  )
}
