// workbench/mobile/avatar.mjs
// 手机端的人形头像渲染（零依赖、零网络）—— 位面表的**镜像**。
//
// 唯一真源是 `workbench/src/avatar/slots.ts`（桌面端）。手机端是独立静态根
// （见 routes/mobile.mjs），运行期 import 不到 TS 源，所以这里必须自带一份；
// 而"两份表会漂移"这个风险由 `avatar-parity.test.mjs` 逐项比对 key 来守住（BR-13）。
//
// 为什么成员选择不能用 <option>：HTML 的 <option> 只能渲染纯文本，
// 于是手机上成员列表与桌面的"人形头像 + 名字"不是同一个东西——
// 而「给 Agent 人性化头像」这件事在手机上就等于没做。见 app.mjs 的 renderTargets()。
export const BUILTIN_ROLE_KEYS = [
  'requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops',
  'market-analyst', 'content-planner', 'ad-optimizer', 'growth-hacker', 'brand-copy',
  'product-manager', 'ux-designer', 'ui-designer', 'user-researcher', 'data-analyst',
  'ops-specialist', 'campaign-planner', 'support-lead', 'data-ops',
  'assistant', 'research-assistant', 'writer',
]

export const SPARE_KEYS = Array.from({ length: 15 }, (_, i) => 's' + String(i + 1).padStart(2, '0'))

// 调色板：必须与 `workbench/src/avatar/slots.ts` **逐字相同**
// （`avatar-parity.test.mjs` 的 TC-S6-01b 逐 key 比对两端位面字段，一漂就红）。
const SKINS = ['#f7d9bd', '#efc49c', '#dca876', '#bd8557']
const HAIRS = ['#33405a', '#5f4030', '#8a5a2b', '#3a3a44', '#7d4d6e']
const STYLES = ['short', 'bob', 'bun', 'curly']
const TOPS = ['#84b6e8', '#b6a0e2', '#63c8bc', '#f0aa86', '#a3c47e', '#e6a0bd']
const ACCESSORIES = ['none', 'glasses', 'beard', 'earring', 'cap']
const BACKGROUNDS = ['#e8eff8', '#f1eaf8', '#e3f2f0', '#faf0e3', '#eaeffb', '#f8e9f1']

export const SLOT_KEYS = [...BUILTIN_ROLE_KEYS, ...SPARE_KEYS]

/**
 * 令牌 key → 头像图片文件（**镜像** `src/avatar/photo-assets.ts`）。
 *
 * 与位面表同样的规矩：两份表会漂移，所以由 `avatar-photo.test.mjs` **逐项比对**
 * （key 集合 + 文件名 + 文件存在 + 两端文件逐字节相同）。
 * 只改一端 = 手机上看到的脸与桌面上不是同一张。
 */
export const AVATAR_PHOTOS = Object.freeze({
  requirement: 'agent-avatar-01.webp',
  researcher: 'agent-avatar-02.webp',
  breaker: 'agent-avatar-03.webp',
  'test-designer': 'agent-avatar-04.webp',
  coder: 'agent-avatar-05.webp',
  reviewer: 'agent-avatar-06.webp',
  tester: 'agent-avatar-07.webp',
  devops: 'agent-avatar-08.webp',
  assistant: 'agent-avatar-09.webp',
  'research-assistant': 'agent-avatar-10.webp',
  writer: 'agent-avatar-11.webp',
  s01: 'agent-avatar-12.webp',
  s02: 'agent-avatar-13.webp',
  s03: 'agent-avatar-14.webp',
  s04: 'agent-avatar-15.webp',
  s05: 'agent-avatar-16.webp',
  s06: 'agent-avatar-17.webp',
  s07: 'agent-avatar-18.webp',
  s08: 'agent-avatar-19.webp',
  s09: 'agent-avatar-20.webp',
  s11: 'agent-avatar-21.webp',
  s12: 'agent-avatar-22.webp',
  s13: 'agent-avatar-23.webp',
  s14: 'agent-avatar-24.webp',
  s15: 'agent-avatar-25.webp',
  s10: 'agent-avatar-26.webp',
})

/** 该 key 有没有配图；没有返回 null（调用方回落矢量人形）。 */
export function photoFileFor(key) {
  const hit = AVATAR_PHOTOS[key]
  return hit === undefined ? null : hit
}

/** 把颜色按比例压暗 —— 必须与 `src/avatar/slots.ts` 的 `shade()` **逐字同式**。 */
export function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => Math.max(0, Math.min(255, Math.round(v * factor))))
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('')
}

function slotAt(index) {
  const skin = SKINS[index % SKINS.length]
  const hair = HAIRS[Math.floor(index / 4) % HAIRS.length]
  const hairStyle = STYLES[Math.floor(index / 20) % STYLES.length]
  const top = TOPS[index % TOPS.length]
  const accessory = ACCESSORIES[Math.floor(index / 8) % ACCESSORIES.length]
  const background = BACKGROUNDS[index % BACKGROUNDS.length]
  return {
    key: SLOT_KEYS[index] ?? ('slot-' + index),
    skin, hair, hairStyle, top, accessory, background,
    // 系数必须与桌面端一致（这三个是位面字段，TC-S6-01b 逐 key deepEqual）
    skinShade: shade(skin, 0.84),
    hairShade: shade(hair, 0.78),
    topShade: shade(top, 0.82),
  }
}

const SLOTS = SLOT_KEYS.map((_, i) => slotAt(i))
const BY_KEY = new Map(SLOTS.map(slot => [slot.key, slot]))

/** 确定性占位人形：令牌缺失/非法/旧 emoji 时使用（回退只是渲染态，不写回 roster）。 */
export const PLACEHOLDER_SLOT = {
  key: 'placeholder', skin: '#cbd3dc', hair: '#8a95a3', hairStyle: 'short',
  top: '#9aa7b5', accessory: 'none', background: '#eef1f4',
  skinShade: shade('#cbd3dc', 0.84),
  hairShade: shade('#8a95a3', 0.78),
  topShade: shade('#9aa7b5', 0.82),
}

const TOKEN_RE = /^human:[a-z0-9][a-z0-9-]*$/

export function slotKeys() { return [...SLOT_KEYS] }

export function resolveSlot(token) {
  if (typeof token !== 'string') return null
  const value = token.trim()
  if (!TOKEN_RE.test(value)) return null
  return BY_KEY.get(value.slice('human:'.length)) ?? null
}

/** 降级显示：令牌缺失/非法时只显示纯名称（不抛错、不显示 emoji）。 */
export function avatarLabel(token, name) {
  return typeof name === 'string' ? name : ''
}

const EYE_L = 12.1
const EYE_R = 19.9
const EYE_Y = 15.3

/** 渐变 id：必须与桌面端的 `gid()` 同式（同 key ⇒ 同 id，重复定义内容也相同）。 */
function gid(key, part) { return 'av-' + key + '-' + part }

/** 渐变定义（与桌面端 `Defs` 同一份）。移动端要拼字符串，所以手写成 HTML。 */
function defsMarkup(slot) {
  const k = slot.key
  return '<defs>'
    + '<radialGradient id="' + gid(k, 'face') + '" cx="0.36" cy="0.30" r="0.85">'
    + '<stop offset="0%" stop-color="' + slot.skin + '" /><stop offset="62%" stop-color="' + slot.skin + '" />'
    + '<stop offset="100%" stop-color="' + slot.skinShade + '" /></radialGradient>'
    + '<linearGradient id="' + gid(k, 'hair') + '" x1="0.25" y1="0" x2="0.7" y2="1">'
    + '<stop offset="0%" stop-color="' + slot.hair + '" /><stop offset="100%" stop-color="' + slot.hairShade + '" /></linearGradient>'
    + '<linearGradient id="' + gid(k, 'top') + '" x1="0" y1="0" x2="1" y2="0.55">'
    + '<stop offset="0%" stop-color="' + slot.top + '" /><stop offset="100%" stop-color="' + slot.topShade + '" /></linearGradient>'
    + '<linearGradient id="' + gid(k, 'bg') + '" x1="0" y1="0" x2="0.8" y2="1">'
    + '<stop offset="0%" stop-color="#ffffff" /><stop offset="42%" stop-color="' + slot.background + '" />'
    + '<stop offset="100%" stop-color="' + slot.background + '" /></linearGradient>'
    + '<radialGradient id="' + gid(k, 'blush') + '" cx="0.5" cy="0.5" r="0.5">'
    + '<stop offset="0%" stop-color="#ff8fa6" stop-opacity="0.55" />'
    + '<stop offset="100%" stop-color="#ff8fa6" stop-opacity="0" /></radialGradient>'
    + '</defs>'
}

function hairPath(slot) {
  const fill = 'url(#' + gid(slot.key, 'hair') + ')'
  const cap = 'M5.5 13.6C5.5 7.3 10.1 3.8 16 3.8s10.5 3.5 10.5 9.8c-1.9-3-5.7-4.5-10.5-4.5s-8.6 1.5-10.5 4.5z'
  if (slot.hairStyle === 'short') return '<path d="' + cap + '" fill="' + fill + '" />'
  if (slot.hairStyle === 'bob') {
    return '<g fill="' + fill + '"><path d="' + cap + '" />'
      + '<path d="M5.4 13.2c-1.3 4.4-1.1 8.1.5 10.6 1-3.4 1.4-7 1.1-10.6z" />'
      + '<path d="M26.6 13.2c1.3 4.4 1.1 8.1-.5 10.6-1-3.4-1.4-7-1.1-10.6z" /></g>'
  }
  if (slot.hairStyle === 'bun') {
    return '<g fill="' + fill + '"><circle cx="16" cy="4.1" r="2.7" /><path d="' + cap + '" /></g>'
  }
  return '<path d="M5.5 13.6C5.5 7.3 10.1 3.8 16 3.8s10.5 3.5 10.5 9.8c-1.4-1.6-2.6-2.6-4.2-3.1-.5 1-1.4 1.6-2.5 1.7-.2-1.4-.9-2.4-2-3-.9.9-2.2 1.4-3.8 1.4s-2.7-.5-3.4-1.4c-1.2.5-2.4 1.6-3.6 3.4-.2-1-.7-1.9-1.5-2.4z" fill="' + fill + '" />'
}

function accessoryMarkup(slot) {
  if (slot.accessory === 'glasses') {
    return '<circle cx="' + EYE_L + '" cy="' + EYE_Y + '" r="3.15" fill="#ffffff" fill-opacity="0.30" />'
      + '<circle cx="' + EYE_R + '" cy="' + EYE_Y + '" r="3.15" fill="#ffffff" fill-opacity="0.30" />'
      + '<g fill="none" stroke="#33415a" stroke-width="0.7"><circle cx="' + EYE_L + '" cy="' + EYE_Y + '" r="3.15" />'
      + '<circle cx="' + EYE_R + '" cy="' + EYE_Y + '" r="3.15" />'
      + '<path d="M15.25 15.1h1.5" stroke-linecap="round" /></g>'
  }
  if (slot.accessory === 'beard') return '<path d="M9.6 15.6c-.4 4.6 2 8.2 6.4 8.2s6.8-3.6 6.4-8.2c-1.1 2.6-3.3 4-6.4 4s-5.3-1.4-6.4-4z" fill="url(#' + gid(slot.key, 'hair') + ')" fill-opacity="0.52" />'
  if (slot.accessory === 'earring') return '<circle cx="5.9" cy="17.2" r="1" fill="#f2c56a" stroke="#d9a83f" stroke-width="0.25" />'
  if (slot.accessory === 'cap') {
    return '<path d="M5.6 12.8C5.6 6.8 10.2 3.7 16 3.7s10.4 3.1 10.4 9.1l-.3 1.5H5.9z" fill="url(#' + gid(slot.key, 'top') + ')" />'
      + '<path d="M18.6 13.4h7.2c.9 0 1.5.8 1.2 1.6l-.5 1.3h-7.9z" fill="' + slot.topShade + '" />'
  }
  return ''
}

function clampSize(size) {
  if (typeof size !== 'number' || !Number.isFinite(size)) return 32
  const rounded = Math.round(size)
  if (rounded < 12 || rounded > 512) return 32
  return rounded
}

/**
 * 渲染成员头像：**有图用图，没图用矢量**（与桌面 `AgentAvatar` 同一条判据）。
 *
 * 返回的是一段 HTML 字符串（调用方直接 `innerHTML`），所以两条路都能返回，
 * 上层三处调用（成员药丸条、头部、任务列表）**一行都不用改**。
 *
 * `src` 用相对路径 `./avatars/…`：手机页面的静态根是 `/mobile/`（`static-tree.mjs`
 * 会把无尾斜杠的 `/mobile` 重定向过去），于是它解析成 `/mobile/avatars/…`。
 * **只允许同源相对路径** —— 头像不许引外链（`avatar-photo.test.mjs` 守着这一条）。
 */
export function renderAvatar(token, size) {
  const slot = resolveSlot(token) ?? PLACEHOLDER_SLOT
  const px = clampSize(size)
  const photo = photoFileFor(slot.key)
  if (photo !== null) {
    // `alt=""`：装饰性头像（旁边总有成员名），空 alt 让读屏器跳过，避免名字被念两遍。
    return '<img class="agent-avatar-img" src="./avatars/' + photo + '" width="' + px + '" height="' + px
      + '" alt="" draggable="false" loading="lazy" decoding="async" />'
  }
  return renderVectorAvatar(slot, px)
}

/** 内联 SVG 矢量人形（纯字符串，无网络请求、无文本节点）。 */
function renderVectorAvatar(slot, px) {
  const k = slot.key
  return '<svg class="agent-avatar-svg" width="' + px + '" height="' + px + '" viewBox="0 0 32 32" role="img" aria-label="成员头像">'
    + defsMarkup(slot)
    + '<rect x="0" y="0" width="32" height="32" rx="9" fill="url(#' + gid(k, 'bg') + ')" />'
    + '<circle cx="9" cy="6.5" r="12.5" fill="#ffffff" fill-opacity="0.30" />'
    + '<path d="M4.2 32c0-6.4 5.3-9.8 11.8-9.8s11.8 3.4 11.8 9.8z" fill="url(#' + gid(k, 'top') + ')" />'
    + '<ellipse cx="16" cy="14.3" rx="10.6" ry="10.2" fill="url(#' + gid(k, 'face') + ')" />'
    + '<path d="M9.2 20.4c1.2 2.6 3.7 4 6.8 4s5.6-1.4 6.8-4c-2 1.5-4.2 2.2-6.8 2.2s-4.8-.7-6.8-2.2z" fill="' + slot.skinShade + '" fill-opacity="0.55" />'
    + '<ellipse cx="12.6" cy="8.4" rx="3.6" ry="2.2" fill="#ffffff" fill-opacity="0.22" transform="rotate(-18 12.6 8.4)" />'
    + hairPath(slot)
    + '<ellipse cx="9.3" cy="17.9" rx="2.8" ry="2.0" fill="url(#' + gid(k, 'blush') + ')" />'
    + '<ellipse cx="22.7" cy="17.9" rx="2.8" ry="2.0" fill="url(#' + gid(k, 'blush') + ')" />'
    + '<ellipse cx="' + EYE_L + '" cy="' + EYE_Y + '" rx="1.85" ry="2.3" fill="#2b3445" />'
    + '<ellipse cx="' + EYE_R + '" cy="' + EYE_Y + '" rx="1.85" ry="2.3" fill="#2b3445" />'
    + '<circle cx="' + (EYE_L - 0.6) + '" cy="' + (EYE_Y - 0.85) + '" r="0.78" fill="#ffffff" />'
    + '<circle cx="' + (EYE_R - 0.6) + '" cy="' + (EYE_Y - 0.85) + '" r="0.78" fill="#ffffff" />'
    + '<circle cx="' + (EYE_L + 0.7) + '" cy="' + (EYE_Y + 1) + '" r="0.4" fill="#ffffff" fill-opacity="0.6" />'
    + '<circle cx="' + (EYE_R + 0.7) + '" cy="' + (EYE_Y + 1) + '" r="0.4" fill="#ffffff" fill-opacity="0.6" />'
    + '<path d="M14.6 19.4c.85.8 2.35.8 3.2 0" stroke="#a4553f" stroke-width="0.85" fill="none" stroke-linecap="round" />'
    + accessoryMarkup(slot)
    + '</svg>'
}
