// workbench/src/avatar/AgentAvatar.tsx
// 成员头像：**有图用图，没图用矢量**（两条来源，优先级明确）。
//
// ## 两级来源（2026-10-13 第二版）
//
//   ① `photo-assets.ts` 给这个位面 key 配了图 ⇒ 渲染 `<img>`（用户提供的写实/插画头像）
//   ② 没配 ⇒ 渲染下面的**内联 SVG 矢量人形**（原本那条路径，一行未删）
//
// 判据放在**资产表**而不是运行时：查表就知道走哪条 ⇒ 不会先闪一张破图再回退。
// 资产是否存在由 `avatar-photo.test.mjs` 在**提交时**守住（比运行时容错更早暴露问题）。
//
// ## 矢量那一路的画风口径（它是"没图"时的正式外观，不是临时占位）
//
// 下面是矢量路径的历史与口径，仍然有效。
//
// ## 画风口径（2026-10-13 第二版：扁平 → 有明暗）
//
// 第一版做成"圆润吉祥物"后，用户拿另一款产品的头像对照，说看不出改观。
// 我把两张图**量了一遍**（同一尺寸下每张头像的**颜色数**，它是"明暗层次"的可测代理）：
//
//     参考图（32–36px）  528 / 536 / 550 / 620 / 731 色
//     第一版（36px）     114 / 130 / 153 / 158 / 185 / 198 / 202 / 203 色
//
//   > 一组能证明"每个头像都不一样"的用例，
//   > 与一组能证明"这些头像看起来是不是同一种东西"的用例，
//   > 区别不在用例写得够不够细，而在**判据里能不能放下一双眼睛**。
//
// 差 3–5 倍的直接原因是：**纯色平涂**没有中间层次。所以这一版加的是明暗——
// 用真正的 SVG 渐变给脸、头发、衣服、背景各上一层光，再补下巴阴影与额头高光。
//
// ## ★ 为什么现在能用 `url(#…)` 了（第一版是我把自己挡住的）
//
// 第一版文件头写着"不能用渐变，因为 TC-S1-09 禁 `url(`"，于是只能拿分层半透明硬凑。
// 但那条判据的**本意**是「头像不得依赖**外链**资源」——`url(#face)` 是**同文档片段**，
// 根本不是外链。是"禁外链"被写成了"禁 `url(`"。
//
// 已把判据收回到本意（外链形式继续禁：`url(http` / `url(//` / `url(data:` …），
// 并用 `TC-S1-09b` 两侧对照钉住边界。**渐变 id 必须逐实例唯一**（见 `gid()`），
// 否则同页面多个头像会抢同一个 id、颜色串台。
import { resolveSlot, PLACEHOLDER_SLOT } from './slots'
import { photoFileFor, AVATAR_PHOTO_BASE } from './photo-assets'
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

/**
 * 渐变 id：**按位面 key 派生**，同一位面在任何页面都得到同一个 id。
 *
 * ★ 为什么不是 `useId()` 或随机：`slots.ts` 这条渲染链是纯函数（`TC-S1-04` 禁随机/时钟），
 *   而且要能被**字符串化**（移动端 `renderAvatar()` 就是同一份图形）。
 *   同 id 的重复定义内容**完全相同**（颜色只由这个 key 决定），浏览器取第一个即可。
 */
function gid(key: string, part: string): string {
  return `av-${key}-${part}`
}

/** 渐变定义；每个头像只定义自己用到的那几个。 */
function Defs({ slot }: { slot: AvatarSlot }): React.JSX.Element {
  const k = slot.key
  return (
    <defs>
      {/* 脸：光从左上，右下略暗 —— "有体积"的主来源 */}
      <radialGradient id={gid(k, 'face')} cx="0.36" cy="0.30" r="0.85">
        <stop offset="0%" stopColor={slot.skin} />
        <stop offset="62%" stopColor={slot.skin} />
        <stop offset="100%" stopColor={slot.skinShade} />
      </radialGradient>
      {/* 头发：顶部亮、发根暗 */}
      <linearGradient id={gid(k, 'hair')} x1="0.25" y1="0" x2="0.7" y2="1">
        <stop offset="0%" stopColor={slot.hair} />
        <stop offset="100%" stopColor={slot.hairShade} />
      </linearGradient>
      {/* 衣服：左亮右暗 */}
      <linearGradient id={gid(k, 'top')} x1="0" y1="0" x2="1" y2="0.55">
        <stop offset="0%" stopColor={slot.top} />
        <stop offset="100%" stopColor={slot.topShade} />
      </linearGradient>
      {/* 背景：左上偏白，右下回到底色（粉彩，去掉"图标底色"的平涂感） */}
      <linearGradient id={gid(k, 'bg')} x1="0" y1="0" x2="0.8" y2="1">
        <stop offset="0%" stopColor="#ffffff" />
        <stop offset="42%" stopColor={slot.background} />
        <stop offset="100%" stopColor={slot.background} />
      </linearGradient>
      {/* 腮红：径向淡出（比纯椭圆自然） */}
      <radialGradient id={gid(k, 'blush')} cx="0.5" cy="0.5" r="0.5">
        <stop offset="0%" stopColor="#ff8fa6" stopOpacity="0.55" />
        <stop offset="100%" stopColor="#ff8fa6" stopOpacity="0" />
      </radialGradient>
    </defs>
  )
}

/** 头发：罩在头顶的一顶软帽；bob 加两侧发帘、bun 加顶髻、curly 换波浪发际线。 */
function Hair({ slot }: { slot: AvatarSlot }): React.JSX.Element {
  const fill = `url(#${gid(slot.key, 'hair')})`
  const cap = 'M5.5 13.6C5.5 7.3 10.1 3.8 16 3.8s10.5 3.5 10.5 9.8c-1.9-3-5.7-4.5-10.5-4.5s-8.6 1.5-10.5 4.5z'
  if (slot.hairStyle === 'short') return <path d={cap} fill={fill} />
  if (slot.hairStyle === 'bob') {
    return (
      <g fill={fill}>
        <path d={cap} />
        <path d="M5.4 13.2c-1.3 4.4-1.1 8.1.5 10.6 1-3.4 1.4-7 1.1-10.6z" />
        <path d="M26.6 13.2c1.3 4.4 1.1 8.1-.5 10.6-1-3.4-1.4-7-1.1-10.6z" />
      </g>
    )
  }
  if (slot.hairStyle === 'bun') {
    return (
      <g fill={fill}>
        <circle cx="16" cy="4.1" r="2.7" />
        <path d={cap} />
      </g>
    )
  }
  return (
    <path
      d="M5.5 13.6C5.5 7.3 10.1 3.8 16 3.8s10.5 3.5 10.5 9.8c-1.4-1.6-2.6-2.6-4.2-3.1-.5 1-1.4 1.6-2.5 1.7-.2-1.4-.9-2.4-2-3-.9.9-2.2 1.4-3.8 1.4s-2.7-.5-3.4-1.4c-1.2.5-2.4 1.6-3.6 3.4-.2-1-.7-1.9-1.5-2.4z"
      fill={fill}
    />
  )
}

/** 配饰：五档沿用契约，画法统一为"有明暗"（眼镜带半透明镜片）。 */
function Accessory({ slot }: { slot: AvatarSlot }): React.JSX.Element | null {
  if (slot.accessory === 'glasses') {
    return (
      <g>
        <circle cx={EYE_L} cy={EYE_Y} r="3.15" fill="#ffffff" fillOpacity="0.30" />
        <circle cx={EYE_R} cy={EYE_Y} r="3.15" fill="#ffffff" fillOpacity="0.30" />
        <g fill="none" stroke="#33415a" strokeWidth="0.7">
          <circle cx={EYE_L} cy={EYE_Y} r="3.15" />
          <circle cx={EYE_R} cy={EYE_Y} r="3.15" />
          <path d="M15.25 15.1h1.5" strokeLinecap="round" />
        </g>
      </g>
    )
  }
  if (slot.accessory === 'beard') {
    return <path d="M9.6 15.6c-.4 4.6 2 8.2 6.4 8.2s6.8-3.6 6.4-8.2c-1.1 2.6-3.3 4-6.4 4s-5.3-1.4-6.4-4z" fill={`url(#${gid(slot.key, 'hair')})`} fillOpacity="0.52" />
  }
  if (slot.accessory === 'earring') {
    return <circle cx="5.9" cy="17.2" r="1" fill="#f2c56a" stroke="#d9a83f" strokeWidth="0.25" />
  }
  if (slot.accessory === 'cap') {
    return (
      <g>
        <path d="M5.6 12.8C5.6 6.8 10.2 3.7 16 3.7s10.4 3.1 10.4 9.1l-.3 1.5H5.9z" fill={`url(#${gid(slot.key, 'top')})`} />
        <path d="M18.6 13.4h7.2c.9 0 1.5.8 1.2 1.6l-.5 1.3h-7.9z" fill={slot.topShade} />
      </g>
    )
  }
  return null
}

/** 矢量人形（原路径）：**所有**位面 key 都能渲，因此它同时是"没配图"的显示与"永远画得出来"的底。 */
function VectorAvatar({ slot, px, cls }: { slot: AvatarSlot; px: number; cls: string }): React.JSX.Element {
  return (
    <svg className={cls} width={px} height={px} viewBox="0 0 32 32" role="img" aria-label="成员头像">
      <Defs slot={slot} />
      {/* 背景（渐变）+ 左上柔光 */}
      <rect x="0" y="0" width="32" height="32" rx="9" fill={`url(#${gid(slot.key, 'bg')})`} />
      <circle cx="9" cy="6.5" r="12.5" fill="#ffffff" fillOpacity="0.30" />
      {/* 肩膀（渐变衣服）：从底边裁出去，不画脖子 */}
      <path d="M4.2 32c0-6.4 5.3-9.8 11.8-9.8s11.8 3.4 11.8 9.8z" fill={`url(#${gid(slot.key, 'top')})`} />
      {/* 大头（径向渐变 = 体积感的主来源） */}
      <ellipse cx="16" cy="14.3" rx="10.6" ry="10.2" fill={`url(#${gid(slot.key, 'face')})`} />
      {/* 下巴阴影：一条压在下缘的柔和暗弧，避免"纸片脸" */}
      <path d="M9.2 20.4c1.2 2.6 3.7 4 6.8 4s5.6-1.4 6.8-4c-2 1.5-4.2 2.2-6.8 2.2s-4.8-.7-6.8-2.2z"
        fill={slot.skinShade} fillOpacity="0.55" />
      {/* 额头高光 */}
      <ellipse cx="12.6" cy="8.4" rx="3.6" ry="2.2" fill="#ffffff" fillOpacity="0.22" transform="rotate(-18 12.6 8.4)" />
      <Hair slot={slot} />
      {/* 腮红（径向淡出） */}
      <ellipse cx="9.3" cy="17.9" rx="2.8" ry="2.0" fill={`url(#${gid(slot.key, 'blush')})`} />
      <ellipse cx="22.7" cy="17.9" rx="2.8" ry="2.0" fill={`url(#${gid(slot.key, 'blush')})`} />
      {/* 大眼 + 双高光 */}
      <ellipse cx={EYE_L} cy={EYE_Y} rx="1.85" ry="2.3" fill="#2b3445" />
      <ellipse cx={EYE_R} cy={EYE_Y} rx="1.85" ry="2.3" fill="#2b3445" />
      <circle cx={EYE_L - 0.6} cy={EYE_Y - 0.85} r="0.78" fill="#ffffff" />
      <circle cx={EYE_R - 0.6} cy={EYE_Y - 0.85} r="0.78" fill="#ffffff" />
      <circle cx={EYE_L + 0.7} cy={EYE_Y + 1} r="0.4" fill="#ffffff" fillOpacity="0.6" />
      <circle cx={EYE_R + 0.7} cy={EYE_Y + 1} r="0.4" fill="#ffffff" fillOpacity="0.6" />
      {/* 嘴 */}
      <path d="M14.6 19.4c.85.8 2.35.8 3.2 0" stroke="#a4553f" strokeWidth="0.85" fill="none" strokeLinecap="round" />
      <Accessory slot={slot} />
    </svg>
  )
}

/**
 * 头像：**有图用图，没图用矢量**。
 *
 * ★ 判据不是"运行时发现图挂了再回退"（那会先闪一下破图），而是**查资产表**：
 *   `photoFileFor(key)` 有值才走 `<img>`。表里没写的 key（例如 20 张图覆盖不到的 `s10`）
 *   直接走矢量 —— 于是"缺图"这件事在**渲染之前**就已经定了，界面上不会出现破图。
 *
 * ★ 资产本身的存在性由 `workbench/scripts/avatar-photo.test.mjs` 在**提交时**守住
 *   （每个映射都必须能在桌面与手机两处找到、且逐字节一致）。这比"运行时容错"
 *   更早发现问题：图没了是**构建期**的错，不是用户屏幕上的错。
 */
export default function AgentAvatar(props: AgentAvatarProps): React.JSX.Element {
  const { token, size, className } = props
  const slot = resolveSlot(token) ?? PLACEHOLDER_SLOT
  const px = clampSize(size)
  const file = photoFileFor(slot.key)
  if (file !== null) {
    // `alt=""`：这是**装饰性**头像（旁边总有成员名文本），空 alt 让读屏器跳过它，
    // 避免"头像 + 名字"被念两遍。不写 alt 反而会暴露文件名。
    return (
      <img
        className={className ? 'agent-avatar-img ' + className : 'agent-avatar-img'}
        src={AVATAR_PHOTO_BASE + file}
        width={px}
        height={px}
        alt=""
        draggable={false}
        loading="lazy"
        decoding="async"
      />
    )
  }
  const cls = className ? 'agent-avatar-svg ' + className : 'agent-avatar-svg'
  return <VectorAvatar slot={slot} px={px} cls={cls} />
}
