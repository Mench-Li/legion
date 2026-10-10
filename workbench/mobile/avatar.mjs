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

const SKINS = ['#f2d3b3', '#e9bd93', '#d6a06f', '#b57f52']
const HAIRS = ['#28364b', '#5b3a29', '#8a5a2b', '#3d3d42', '#7a4a6b']
const STYLES = ['short', 'bob', 'bun', 'curly']
const TOPS = ['#4e84be', '#9472bd', '#44a99c', '#cf8764', '#7d9b60', '#b47197']
const ACCESSORIES = ['none', 'glasses', 'beard', 'earring', 'cap']
const BACKGROUNDS = ['#e3e9f0', '#eee6f5', '#dfeeed', '#f3ead9', '#e9eef9', '#f0e6ee']

export const SLOT_KEYS = [...BUILTIN_ROLE_KEYS, ...SPARE_KEYS]

function slotAt(index) {
  const skin = SKINS[index % SKINS.length]
  const hair = HAIRS[Math.floor(index / 4) % HAIRS.length]
  const hairStyle = STYLES[Math.floor(index / 20) % STYLES.length]
  const top = TOPS[index % TOPS.length]
  const accessory = ACCESSORIES[Math.floor(index / 8) % ACCESSORIES.length]
  const background = BACKGROUNDS[index % BACKGROUNDS.length]
  return { key: SLOT_KEYS[index] ?? ('slot-' + index), skin, hair, hairStyle, top, accessory, background }
}

const SLOTS = SLOT_KEYS.map((_, i) => slotAt(i))
const BY_KEY = new Map(SLOTS.map(slot => [slot.key, slot]))

/** 确定性占位人形：令牌缺失/非法/旧 emoji 时使用（回退只是渲染态，不写回 roster）。 */
export const PLACEHOLDER_SLOT = {
  key: 'placeholder', skin: '#cbd3dc', hair: '#8a95a3', hairStyle: 'short',
  top: '#9aa7b5', accessory: 'none', background: '#eef1f4',
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

function hairPath(slot) {
  if (slot.hairStyle === 'short') return '<path d="M8.6 11.4c.5-4 3.4-6.2 7.4-6.2s6.8 2.2 7.2 6.2c-1.6-1.7-4-2.4-7.2-2.4s-5.8.7-7.4 2.4z" fill="' + slot.hair + '" />'
  if (slot.hairStyle === 'bob') return '<path d="M8.2 13c0-4.6 3.2-7.6 7.8-7.6s7.8 3 7.8 7.6l-.9 6.6c-1.2-2.6-1.6-5.2-1.3-7.6-1.7.9-3.7 1.3-5.6 1.3s-3.9-.4-5.6-1.3c.3 2.4-.1 5-1.3 7.6z" fill="' + slot.hair + '" />'
  if (slot.hairStyle === 'bun') return '<circle cx="16" cy="4.4" r="2.6" fill="' + slot.hair + '" /><path d="M8.7 12c0-4.3 3.1-6.8 7.3-6.8s7.3 2.5 7.3 6.8c-1.6-1.8-4-2.6-7.3-2.6s-5.7.8-7.3 2.6z" fill="' + slot.hair + '" />'
  return '<path d="M8.4 12.2c-.6-1 .2-2.2 1.3-2.2-.6-1.1.4-2.3 1.6-2.1-.3-1.2.9-2.1 2-1.6.2-1.2 1.7-1.7 2.6-.8.9-.9 2.4-.4 2.6.8 1.1-.5 2.3.4 2 1.6 1.2-.2 2.2 1 1.6 2.1 1.1 0 1.9 1.2 1.3 2.2-1.4-1.4-3.6-2.2-7.5-2.2s-6.1.8-7.5 2.2z" fill="' + slot.hair + '" />'
}

function accessoryMarkup(slot) {
  if (slot.accessory === 'glasses') return '<g fill="none" stroke="#28364b" stroke-width="0.7"><circle cx="13" cy="13" r="2.6" /><circle cx="19" cy="13" r="2.6" /><rect x="15.4" y="12.6" width="1.2" height="0.6" fill="#28364b" stroke="none" /></g>'
  if (slot.accessory === 'beard') return '<path d="M10.4 14.4c0 4.5 2.5 7.2 5.6 7.2s5.6-2.7 5.6-7.2c-1.5 2.1-3.4 3-5.6 3s-4.1-.9-5.6-3z" fill="' + slot.hair + '" opacity="0.85" />'
  if (slot.accessory === 'earring') return '<circle cx="9.2" cy="15.4" r="0.9" fill="#f1c766" />'
  if (slot.accessory === 'cap') return '<path d="M8.4 9.6c0-3.6 3.2-5.4 7.6-5.4s7.6 1.8 7.6 5.4l-.2 1.2H8.6z" fill="' + slot.top + '" />'
  return ''
}

function clampSize(size) {
  if (typeof size !== 'number' || !Number.isFinite(size)) return 32
  const rounded = Math.round(size)
  if (rounded < 12 || rounded > 512) return 32
  return rounded
}

/** 渲染内联 SVG 人形（纯字符串，无网络请求、无文本节点）。 */
export function renderAvatar(token, size) {
  const slot = resolveSlot(token) ?? PLACEHOLDER_SLOT
  const px = clampSize(size)
  return '<svg class="agent-avatar-svg" width="' + px + '" height="' + px + '" viewBox="0 0 32 32" role="img" aria-label="成员头像">'
    + '<rect x="0" y="0" width="32" height="32" rx="9" fill="' + slot.background + '" />'
    + '<path d="M6 30c0-5 4.5-8 10-8s10 3 10 8z" fill="' + slot.top + '" />'
    + '<rect x="13.4" y="18.6" width="5.2" height="4.4" rx="2" fill="' + slot.skin + '" />'
    + '<ellipse cx="16" cy="13" rx="7" ry="7.5" fill="' + slot.skin + '" />'
    + hairPath(slot)
    + '<rect x="11.6" y="10.8" width="2.8" height="0.6" rx="0.3" fill="' + slot.hair + '" />'
    + '<rect x="17.6" y="10.8" width="2.8" height="0.6" rx="0.3" fill="' + slot.hair + '" />'
    + '<circle cx="13" cy="13" r="0.95" fill="#253344" />'
    + '<circle cx="19" cy="13" r="0.95" fill="#253344" />'
    + '<path d="M14.4 16.6c.9.7 2.3.7 3.2 0" stroke="#b66e63" stroke-width="0.9" fill="none" stroke-linecap="round" />'
    + accessoryMarkup(slot)
    + '</svg>'
}
