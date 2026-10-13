// workbench/src/avatar/types.ts
/** 一个「人性化头像」位面：一组确定性的人形特征。 */
export interface AvatarSlot {
  /** 位面 key（= 令牌 `human:<key>` 的 <key> 部分）。 */
  readonly key: string
  readonly skin: string
  readonly hair: string
  readonly hairStyle: 'short' | 'bob' | 'bun' | 'curly'
  readonly top: string
  readonly accessory: 'none' | 'glasses' | 'beard' | 'earring' | 'cap'
  readonly background: string
  /**
   * 明暗三色（2026-10-13 加）—— **渐变的暗端**。
   *
   * ★ 它们是**位面字段**而不是渲染时才算的临时值：`avatar-parity.test.mjs` 的
   *   TC-S6-01b 会逐 key 把两端的位面对象 `deepEqual` 一遍 ⇒ 放进字段里，
   *   移动端的明暗调色板就自动被那条判据守着；放在组件里各算一次则不受保护。
   *   （这一版要加明暗，而"加了明暗后两端画得一样吗"必须有人管。）
   */
  readonly skinShade: string
  readonly hairShade: string
  readonly topShade: string
}

/**
 * 一张「AI 生成头像」资产（2026-10-13 加）。
 *
 * 头像现在有**两条来源**，优先级是图片在前、矢量在后：
 *   ① 这条记录存在 ⇒ 渲染 `<img>`（用户提供的写实/插画头像）；
 *   ② 不存在 ⇒ 回落内联 SVG 矢量人形（原路径，未受影响）。
 * 这样"没配图的岗位"与"配了图的岗位"能在同一个界面里共存，且**不会出现破图**。
 */
export interface AvatarPhoto {
  /** 文件名（相对 `AVATAR_PHOTO_BASE`）。 */
  readonly file: string
  /** 来源（原图相对路径）—— 留痕用，便于回溯是谁提供的。 */
  readonly from: string
  /** 原图尺寸（形如 `1254x1254`）。 */
  readonly srcSize: string
  /** 派生文件 sha256 前 16 位，用于两端一致性判据。 */
  readonly sha256: string
}
