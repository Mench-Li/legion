// workbench/src/avatar/photo-assets.ts
// 「AI 生成头像」资产表 —— **令牌 key → 图片文件**的唯一出处。
//
// ## 这些图从哪来
//
// 用户提供的 20 张 1254x1254 PNG（原图在 `assets/agent-avatars/`，**不入库**：42.6MB）。
// 本目录里的是**派生产物**：256x256 WebP，质量 82 —— 20 张合计约 159KB（原图 1/274）。
// 两处各存一份（桌面 `workbench/public/avatars/`、手机 `workbench/mobile/avatars/`），
// 由 `avatar-photo.test.mjs` **逐字节**比对，不许漂移（沿用 slots/avatar 的镜像+parity 惯例）。
//
// ## 谁当谁的头像：**分配顺序在这里，改这一处就能换图**
//
// 顺序：① software 流水线 8 个岗位（用户主战场，优先）
//       ② default 空间 3 个 ③ 备用位 s01..s09（gf001 / ozon 的自建岗位）
//
//   · **选人（哪张图配哪个岗位）不是我"看"出来的** —— 我读不到图像像素，
//     网关的 vision 模型也会把图片整个丢掉（实测：248 字节的图仍报 prompt_tokens=39）。
//     所以这是**按文件名顺序的确定性分配**，不是审美判断。
//     要换：把下面两行的 file 对调即可，跑 `avatar-photo.test.mjs` 会告诉你有没有漏。
//   · 20 张图 / 21 个在用令牌 ⇒ `s10`（ozon/soldier-sourcing）没有图，回落矢量头像。
//     复用某张图把 ORDER 补齐到 21 项即可消除这个回落。
//
// ## 为什么用 WebP 而不是原来的 PNG
//
// 同样 256px，照片 PNG 每张约 100KB+，WebP 约 8KB。20 张的差别是 2.4MB 与 159KB。
// 代价：`team-hub/routes/mobile.mjs` 的 MIME 白名单要补 `.webp`（已补）。
import type { AvatarPhoto } from './types'

/** 令牌 key → 图片。缺 key = 该岗位没有照片，渲染矢量头像（不是坏图）。 */
export const AVATAR_PHOTOS: Readonly<Record<string, AvatarPhoto>> = Object.freeze({
  'requirement': { file: 'agent-avatar-01.webp', from: 'assets/agent-avatars/agent-avatar-01.png', srcSize: '1254x1254', sha256: '2e35f19df9ccda7c' },
  'researcher': { file: 'agent-avatar-02.webp', from: 'assets/agent-avatars/agent-avatar-02.png', srcSize: '1254x1254', sha256: 'f693285d9f72568c' },
  'breaker': { file: 'agent-avatar-03.webp', from: 'assets/agent-avatars/agent-avatar-03.png', srcSize: '1254x1254', sha256: '343fd614a6bc53a4' },
  'test-designer': { file: 'agent-avatar-04.webp', from: 'assets/agent-avatars/agent-avatar-04.png', srcSize: '1254x1254', sha256: 'c1a1d410642ee85e' },
  'coder': { file: 'agent-avatar-05.webp', from: 'assets/agent-avatars/agent-avatar-05.png', srcSize: '1254x1254', sha256: 'd2d6fb2bff52b2fa' },
  'reviewer': { file: 'agent-avatar-06.webp', from: 'assets/agent-avatars/agent-avatar-06.png', srcSize: '1254x1254', sha256: '063f86b921ff0362' },
  'tester': { file: 'agent-avatar-07.webp', from: 'assets/agent-avatars/agent-avatar-07.png', srcSize: '1254x1254', sha256: '4ef2710904ff5620' },
  'devops': { file: 'agent-avatar-08.webp', from: 'assets/agent-avatars/agent-avatar-08.png', srcSize: '1254x1254', sha256: '24339f4268843e8b' },
  'assistant': { file: 'agent-avatar-09.webp', from: 'assets/agent-avatars/agent-avatar-09.png', srcSize: '1254x1254', sha256: '38ea63b3bb7a4efd' },
  'research-assistant': { file: 'agent-avatar-10.webp', from: 'assets/agent-avatars/agent-avatar-10.png', srcSize: '1254x1254', sha256: 'c96c433f78f2ef50' },
  'writer': { file: 'agent-avatar-11.webp', from: 'assets/agent-avatars/agent-avatar-11.png', srcSize: '1254x1254', sha256: '0bae270192c33625' },
  's01': { file: 'agent-avatar-12.webp', from: 'assets/agent-avatars/agent-avatar-12.png', srcSize: '1254x1254', sha256: 'c048e70ac0c0dc56' },
  's02': { file: 'agent-avatar-13.webp', from: 'assets/agent-avatars/agent-avatar-13.png', srcSize: '1254x1254', sha256: '050d0beac5227f45' },
  's03': { file: 'agent-avatar-14.webp', from: 'assets/agent-avatars/agent-avatar-14.png', srcSize: '1254x1254', sha256: '29f297837258c5a4' },
  's04': { file: 'agent-avatar-15.webp', from: 'assets/agent-avatars/agent-avatar-15.png', srcSize: '1254x1254', sha256: '030524fa8c3b3313' },
  's05': { file: 'agent-avatar-16.webp', from: 'assets/agent-avatars/agent-avatar-16.png', srcSize: '1254x1254', sha256: 'c4e0789c7c3c97a0' },
  's06': { file: 'agent-avatar-17.webp', from: 'assets/agent-avatars/agent-avatar-17.png', srcSize: '1254x1254', sha256: 'b834cb7e9711dcb6' },
  's07': { file: 'agent-avatar-18.webp', from: 'assets/agent-avatars/agent-avatar-18.png', srcSize: '1254x1254', sha256: '6d316ed81b39f291' },
  's08': { file: 'agent-avatar-19.webp', from: 'assets/agent-avatars/agent-avatar-19.png', srcSize: '1254x1254', sha256: 'fc6e7d07a844f826' },
  's09': { file: 'agent-avatar-20.webp', from: 'assets/agent-avatars/agent-avatar-20.png', srcSize: '1254x1254', sha256: 'a71994d95874ccfb' },
  's11': { file: 'agent-avatar-21.webp', from: 'assets/agent-avatars/agent-avatar-21.png', srcSize: '1254x1254', sha256: '1fcc404d0113bc47' },
  's12': { file: 'agent-avatar-22.webp', from: 'assets/agent-avatars/agent-avatar-22.png', srcSize: '1254x1254', sha256: '566c585eab926ef8' },
  's13': { file: 'agent-avatar-23.webp', from: 'assets/agent-avatars/agent-avatar-23.png', srcSize: '1254x1254', sha256: 'ff1f9c6fa6e16924' },
  's14': { file: 'agent-avatar-24.webp', from: 'assets/agent-avatars/agent-avatar-24.png', srcSize: '1254x1254', sha256: 'eb0825fc0eff1451' },
  's15': { file: 'agent-avatar-25.webp', from: 'assets/agent-avatars/agent-avatar-25.png', srcSize: '1254x1254', sha256: '3be9f68aa25d6803' },
})

/** 图片资产的公开路径前缀（相对 index.html；桌面与手机同构）。 */
export const AVATAR_PHOTO_BASE = './avatars/'

/** 查一个位面 key 有没有照片；没有返回 null（调用方回落到矢量头像）。 */
export function photoFileFor(key: string): string | null {
  const hit = AVATAR_PHOTOS[key]
  return hit === undefined ? null : hit.file
}

/** 资产表的 key 列表（测试用）。 */
export function photoKeys(): string[] {
  return Object.keys(AVATAR_PHOTOS)
}
