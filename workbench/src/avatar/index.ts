// workbench/src/avatar/index.ts
// 头像基座的对外入口：展示面只从这里取组件，保证样式随组件一起被加载。
export { default as AgentAvatar } from './AgentAvatar'
export type { AgentAvatarProps } from './AgentAvatar'
export { resolveSlot, slotKeys, assertSlotTable, BUILTIN_ROLE_KEYS, SPARE_KEYS, SLOT_KEYS, PLACEHOLDER_SLOT } from './slots'
export type { AvatarSlot } from './types'
import './avatar.css'
