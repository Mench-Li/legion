// workbench/src/avatar/AgentAvatar.tsx
// 参数化**圆润吉祥物**头像（内联 SVG、零第三方依赖、零图片资源、零网络请求）。
//
// ## 画风口径（2026-10-13 改版）
//
// 上一版是"扁平几何人像"：椭圆脸 + 眉毛横条 + 鼻梁线 + 脖子 + 肩膀，看起来像
// 通讯录占位图标。用户的原话是**「像豆包那样类似的 AI 头像」**，于是这一版按
// 「圆润吉祥物」重画，具体是这六条（每条都对应一处删除或新增）：
//
//   ① **大头**：头几乎占满画幅（rx≈10.6 / 32），不画脖子、肩膀从底边裁出去；
//   ② **大眼 + 双高光**：眼是竖椭圆（不是小圆点），每只眼一颗主高光 + 一颗次高光，
//      眼神"亮"起来靠这两点，不是靠描边；
//   ③ **腮红**：眼下两块半透明暖粉，可爱感的主要来源；
//   ④ **去掉眉毛与鼻梁**：那两条横线/竖线是人像图标语言，不是吉祥物语言；
//   ⑤ **软光**：左上角一块半透明白圆当柔光；
//   ⑥ **柔和粉彩底色**：背景与上衣改用低饱和色（见 `slots.ts` 的调色板）。
//
// ## ★ 为什么不用 SVG 渐变（明明 `<linearGradient>` 才是标准做法）
//
// 因为本仓有一条既有的判据 `TC-S1-09`：头像源码里**禁止出现 `url(`** ——
// 那条规矩是为"头像不得依赖任何外链资源"立的（`url(#…)` 与 `url(http…)` 在这条
// 判据下同形）。于是"柔和"只能用**分层半透明形状**堆出来：
//
//   > 一条为了防外链而禁掉 `url(` 的判据，与一条"不许用渐变"的判据，
//   > 在**没人想用渐变**的时候是同一个东西——
//   > 直到有人想用，而他得先读懂那条规矩到底在防什么。
//
// 分层堆出来的柔和与真渐变在**小尺寸**（16–32px 的头像实际尺寸）下几乎看不出差别，
// 而它同时保住了"零资源引用"这条底线。
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

/** 眼位（左右与纵向中心）—— 高光与配饰都以它为基准，保证左右对称。 */
const EYE_L = 12.1
const EYE_R = 19.9
const EYE_Y = 15.3

/** 头发：一律是"罩在头顶的一顶软帽"；bob 加两侧发帘、bun 加顶髻、curly 换波浪发际线。 */
function Hair({ slot }: { slot: AvatarSlot }): React.JSX.Element {
  const cap = 'M5.5 13.6C5.5 7.3 10.1 3.8 16 3.8s10.5 3.5 10.5 9.8c-1.9-3-5.7-4.5-10.5-4.5s-8.6 1.5-10.5 4.5z'
  if (slot.hairStyle === 'short') return <path d={cap} fill={slot.hair} />
  if (slot.hairStyle === 'bob') {
    return (
      <g fill={slot.hair}>
        <path d={cap} />
        {/* 两侧发帘：沿脸颊垂到下颌 */}
        <path d="M5.4 13.2c-1.3 4.4-1.1 8.1.5 10.6 1-3.4 1.4-7 1.1-10.6z" />
        <path d="M26.6 13.2c1.3 4.4 1.1 8.1-.5 10.6-1-3.4-1.4-7-1.1-10.6z" />
      </g>
    )
  }
  if (slot.hairStyle === 'bun') {
    return (
      <g fill={slot.hair}>
        <circle cx="16" cy="4.1" r="2.7" />
        <path d={cap} />
      </g>
    )
  }
  // curly：波浪发际线（用几段小弧代替一条直边）
  return (
    <path
      d="M5.5 13.6C5.5 7.3 10.1 3.8 16 3.8s10.5 3.5 10.5 9.8c-1.4-1.6-2.6-2.6-4.2-3.1-.5 1-1.4 1.6-2.5 1.7-.2-1.4-.9-2.4-2-3-.9.9-2.2 1.4-3.8 1.4s-2.7-.5-3.4-1.4c-1.2.5-2.4 1.6-3.6 3.4-.2-1-.7-1.9-1.5-2.4z"
      fill={slot.hair}
    />
  )
}

/** 配饰：沿用契约里的五档，但画法改软（半透明、无直线鼻梁、无硬描边）。 */
function Accessory({ slot }: { slot: AvatarSlot }): React.JSX.Element | null {
  if (slot.accessory === 'glasses') {
    return (
      <g fill="none" stroke="#33415a" strokeWidth="0.75">
        <circle cx={EYE_L} cy={EYE_Y} r="3.1" />
        <circle cx={EYE_R} cy={EYE_Y} r="3.1" />
        <path d="M15.2 15.1h1.6" strokeLinecap="round" />
      </g>
    )
  }
  if (slot.accessory === 'beard') {
    // 半透明：压在脸上像一层阴影，而不是贴一块深色形状
    return <path d="M9.6 15.6c-.4 4.6 2 8.2 6.4 8.2s6.8-3.6 6.4-8.2c-1.1 2.6-3.3 4-6.4 4s-5.3-1.4-6.4-4z" fill={slot.hair} fillOpacity="0.42" />
  }
  if (slot.accessory === 'earring') {
    return <circle cx="5.9" cy="17.2" r="1" fill="#f2c56a" />
  }
  if (slot.accessory === 'cap') {
    return (
      <g fill={slot.top}>
        <path d="M5.6 12.8C5.6 6.8 10.2 3.7 16 3.7s10.4 3.1 10.4 9.1l-.3 1.5H5.9z" />
        <path d="M18.6 13.4h7.2c.9 0 1.5.8 1.2 1.6l-.5 1.3h-7.9z" />
      </g>
    )
  }
  return null
}

export default function AgentAvatar(props: AgentAvatarProps): React.JSX.Element {
  const { token, size, className } = props
  const slot = resolveSlot(token) ?? PLACEHOLDER_SLOT
  const px = clampSize(size)
  const cls = className ? 'agent-avatar-svg ' + className : 'agent-avatar-svg'
  return (
    <svg className={cls} width={px} height={px} viewBox="0 0 32 32" role="img" aria-label="成员头像">
      {/* 底色 + 左上柔光（用分层半透明代替渐变，理由见文件头那段） */}
      <rect x="0" y="0" width="32" height="32" rx="9" fill={slot.background} />
      <circle cx="9" cy="6.5" r="12.5" fill="#ffffff" fillOpacity="0.34" />
      {/* 肩膀：从底边裁出去，不画脖子 */}
      <path d="M4.2 32c0-6.4 5.3-9.8 11.8-9.8s11.8 3.4 11.8 9.8z" fill={slot.top} />
      {/* 大头 */}
      <ellipse cx="16" cy="14.3" rx="10.6" ry="10.2" fill={slot.skin} />
      <Hair slot={slot} />
      {/* 腮红 */}
      <ellipse cx="9.3" cy="17.9" rx="2.4" ry="1.5" fill="#ff8fa6" fillOpacity="0.42" />
      <ellipse cx="22.7" cy="17.9" rx="2.4" ry="1.5" fill="#ff8fa6" fillOpacity="0.42" />
      {/* 大眼 + 双高光（"亮"靠高光，不靠描边） */}
      <ellipse cx={EYE_L} cy={EYE_Y} rx="1.85" ry="2.3" fill="#2b3445" />
      <ellipse cx={EYE_R} cy={EYE_Y} rx="1.85" ry="2.3" fill="#2b3445" />
      <circle cx={EYE_L - 0.6} cy={EYE_Y - 0.85} r="0.78" fill="#ffffff" />
      <circle cx={EYE_R - 0.6} cy={EYE_Y - 0.85} r="0.78" fill="#ffffff" />
      <circle cx={EYE_L + 0.7} cy={EYE_Y + 1} r="0.4" fill="#ffffff" fillOpacity="0.6" />
      <circle cx={EYE_R + 0.7} cy={EYE_Y + 1} r="0.4" fill="#ffffff" fillOpacity="0.6" />
      {/* 嘴：一小段微笑弧 */}
      <path d="M14.6 19.4c.85.8 2.35.8 3.2 0" stroke="#a4553f" strokeWidth="0.85" fill="none" strokeLinecap="round" />
      <Accessory slot={slot} />
    </svg>
  )
}
