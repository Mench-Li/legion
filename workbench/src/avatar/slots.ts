// workbench/src/avatar/slots.ts
// 编队成员「人性化头像」位面表 —— 本文件是位面表的**唯一真源**（移动端只做镜像 + parity 测试）。
//
// 设计口径（对齐 RESEARCH 方案 A 与 TASK_BREAKDOWN §7 冻结契约）：
//   · 令牌 = `human:<key>`；25 个内置岗位 key = role；备用池 s01..s15（共 >= 40 个位面）。
//   · 位面 = 一组人形特征（肤色/发色/发型/上衣/配饰/底色）；由索引以混合进制生成，
//     **构造性地两两不同**（assertSlotTable() 会当场量一遍，不靠"应该不会撞"）。
//   · 纯函数、零随机、零时钟、零网络：同一 token 恒得同一位面（AC-R3-4）。
//   · 旧 emoji / 未知 / 缺失令牌 → 确定性灰阶占位人形（R-9），不显示名称首字。
import type { AvatarSlot } from './types'

/** 25 个内置岗位 role（与 roles.json 的 software 流水线 + 各空间职业一致）。 */
export const BUILTIN_ROLE_KEYS = [
  'requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops',
  'market-analyst', 'content-planner', 'ad-optimizer', 'growth-hacker', 'brand-copy',
  'product-manager', 'ux-designer', 'ui-designer', 'user-researcher', 'data-analyst',
  'ops-specialist', 'campaign-planner', 'support-lead', 'data-ops',
  'assistant', 'research-assistant', 'writer',
] as const

/** 备用位面 key：自建/空间专属 role 由接口层按该空间最小未占用者分配。 */
export const SPARE_KEYS = Array.from({ length: 15 }, (_, i) => 's' + String(i + 1).padStart(2, '0'))

// 调色板（2026-10-13 改版）：低饱和粉彩 —— 「圆润吉祥物」画风的一半靠它。
// ★★ 改这里必须**同步改 `workbench/mobile/avatar.mjs` 的同名常量**：
//    `avatar-parity.test.mjs` 的 TC-S6-01b 会逐 key 比对两端位面字段，一漂就红
//    （那条规矩存在，正是因为"只改一端的长相"曾经差点上线）。
const SKINS = ['#f7d9bd', '#efc49c', '#dca876', '#bd8557']
const HAIRS = ['#33405a', '#5f4030', '#8a5a2b', '#3a3a44', '#7d4d6e']
const STYLES: ReadonlyArray<AvatarSlot['hairStyle']> = ['short', 'bob', 'bun', 'curly']
const TOPS = ['#84b6e8', '#b6a0e2', '#63c8bc', '#f0aa86', '#a3c47e', '#e6a0bd']
const ACCESSORIES: ReadonlyArray<AvatarSlot['accessory']> = ['none', 'glasses', 'beard', 'earring', 'cap']
const BACKGROUNDS = ['#e8eff8', '#f1eaf8', '#e3f2f0', '#faf0e3', '#eaeffb', '#f8e9f1']

/** 全量位面 key（25 岗位 + s01..s15），顺序即索引顺序。 */
export const SLOT_KEYS: readonly string[] = [...BUILTIN_ROLE_KEYS, ...SPARE_KEYS]

/**
 * 把颜色按比例压暗（纯函数、确定性）。
 *
 * ★ 放在 `slots.ts` 而不是渲染组件里：明暗要成为**位面字段**，才能被
 *   `TC-S6-01b`（两端位面逐 key `deepEqual`）守着。见 `types.ts` 的 `skinShade` 注释。
 *
 * 直接乘 sRGB 系数（不做线性空间转换）：这些色只用于**小尺寸头像的柔和明暗**，
 * 要的是"同色系里更深一点"，不是物理正确的光照。
 */
export function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => Math.max(0, Math.min(255, Math.round(v * factor))))
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('')
}

function slotAt(index: number): AvatarSlot {
  const skin = SKINS[index % SKINS.length]
  const hair = HAIRS[Math.floor(index / 4) % HAIRS.length]
  const hairStyle = STYLES[Math.floor(index / 20) % STYLES.length]
  const top = TOPS[index % TOPS.length]
  const accessory = ACCESSORIES[Math.floor(index / 8) % ACCESSORIES.length]
  const background = BACKGROUNDS[index % BACKGROUNDS.length]
  return {
    key: SLOT_KEYS[index] ?? ('slot-' + index),
    skin, hair, hairStyle, top, accessory, background,
    // 暗端 = 基色 × 系数（脸颊/发根/衣褶的阴影）。系数在两端**必须一致** ——
    // 它是位面字段，会被 parity 判据逐 key 比对。
    skinShade: shade(skin, 0.84),
    hairShade: shade(hair, 0.78),
    topShade: shade(top, 0.82),
  }
}

const SLOTS: readonly AvatarSlot[] = SLOT_KEYS.map((_, i) => slotAt(i))
const BY_KEY = new Map<string, AvatarSlot>(SLOTS.map(slot => [slot.key, slot]))

/** 确定性占位人形：令牌缺失/非法/旧 emoji 时使用（不写回 roster，只做渲染态）。 */
export const PLACEHOLDER_SLOT: AvatarSlot = {
  key: 'placeholder', skin: '#cbd3dc', hair: '#8a95a3', hairStyle: 'short',
  top: '#9aa7b5', accessory: 'none', background: '#eef1f4',
  // 占位也用同一套系数压暗（它必须与解析成功的那条路**用同一种画法**，
  // 否则"回退的人形"与"正常的人形"会长得不是一个东西）。
  skinShade: shade('#cbd3dc', 0.84),
  hairShade: shade('#8a95a3', 0.78),
  topShade: shade('#9aa7b5', 0.82),
}

const TOKEN_RE = /^human:[a-z0-9][a-z0-9-]*$/

/** 解析令牌 → 位面；未命中返回 null（由调用方决定占位人形）。 */
export function resolveSlot(token: string | null | undefined): AvatarSlot | null {
  if (typeof token !== 'string') return null
  const value = token.trim()
  if (!TOKEN_RE.test(value)) return null
  return BY_KEY.get(value.slice('human:'.length)) ?? null
}

/** 位面表 key 集合（测试与移动端 parity 的唯一口径）。 */
export function slotKeys(): string[] {
  return [...SLOT_KEYS]
}

/** 位面表自检：规模、覆盖、两两不同（构造性唯一，不靠哈希）。 */
export function assertSlotTable(): void {
  const keys = slotKeys()
  if (keys.length < 40) throw new Error('位面表不足 40 个：' + keys.length)
  if (new Set(keys).size !== keys.length) throw new Error('位面表存在重复 key')
  for (const role of BUILTIN_ROLE_KEYS) if (!BY_KEY.has(role)) throw new Error('缺少岗位位面：' + role)
  for (const spare of SPARE_KEYS) if (!BY_KEY.has(spare)) throw new Error('缺少备用位面：' + spare)
  const seen = new Set<string>()
  for (const slot of SLOTS) {
    const sig = [slot.skin, slot.hair, slot.hairStyle, slot.top, slot.accessory, slot.background].join('|')
    if (seen.has(sig)) throw new Error('位面重复（构造性唯一被破坏）：' + slot.key)
    seen.add(sig)
  }
}

assertSlotTable()
