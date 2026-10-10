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
}
