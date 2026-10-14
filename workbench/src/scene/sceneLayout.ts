import type { ScenePreset } from '../types'

export interface SceneStation { key: string; x: number; z: number; row: number; column: number }
/** 任务看板（微缩进场景的那一块）：中心点、尺寸，以及人应当站在它前面的位置。 */
export interface SceneBoard {
  x: number
  z: number
  /** 板面中心高度。 */
  y: number
  width: number
  height: number
  /** 人站到板前办事时的落脚 z（板面往前一点，避免半个身子插进墙里）。 */
  standZ: number
}
export interface SceneLayout {
  preset: ScenePreset
  stations: SceneStation[]
  floorWidth: number
  floorDepth: number
  goal: { x: number; z: number }
  review: { x: number; z: number }
  help: { x: number; z: number }
  board: SceneBoard
  /** 布景尺寸：墙高/墙厚（办公室布景与看板都挂在后墙上，所以两者取自同一个 layout）。 */
  dressing: { wallHeight: number; wallThickness: number }
  camera: { distance: number; targetY: number; zoom: number }
}

/** The roster order fixes workstations. Task status never enters this calculation. */
export function layoutScene(agentKeys: readonly string[], preset: ScenePreset): SceneLayout {
  const count = agentKeys.length
  const columns = count > 12 ? 6 : Math.max(1, Math.ceil(count / 2))
  const rows = Math.max(2, Math.ceil(count / columns))
  const spacingX = 2.45
  const spacingZ = 3.1
  /**
   * ★ 2026-10-14（将军："确保办公室场景有足够的空间展示"）：四周余量从 3.5 加到 **6.5**。
   *
   * 3.5 是"只有工位"时的尺寸：刚好裹住桌椅。布景进来之后就紧了 ——
   * 后墙要挂看板（板宽最大 8.6）、两侧要放书架与茶水台（各占约 0.5 进深）、
   * 前面要摆会议桌 + 一圈椅子（半径 1.72）。这些只能在**工位之外**落脚，
   * 3.5 装不下 ⇒ 家具挤到工位线上（表现为人物穿模桌子，且只在某些人数下出现）。
   */
  const floorWidth = Math.max(18, columns * spacingX + 6.5)
  const floorDepth = Math.max(14, rows * spacingZ + 6.5)
  const stations = agentKeys.map((key, index) => {
    const row = Math.floor(index / columns)
    const column = index % columns
    return { key, row, column, x: (column - (columns - 1) / 2) * spacingX, z: (row - (rows - 1) / 2) * spacingZ }
  })
  const span = Math.max(floorWidth, floorDepth)
  /**
   * ★ 看板贴**后墙**、居中，宽随房间取（`floorWidth * 0.52`，夹在 5.4–8.6 之间）。
   *
   * 位置是三个约束一起定的，改任何一个都要回来重算：
   *   ① 必须**在地板内**（否则板子悬在房间外，人走过去会走出地板）；
   *   ② 必须在**最后一排工位之后**（留 1.5 以上），否则人转身就撞到同事的桌子；
   *   ③ 板面高度让最下面一排卡片在 1.2 左右 —— 站着的人的视线高度，
   *      而不是贴在天花板上（那样在这个俯视机位里会被裁掉一半）。
   */
  /**
   * ★ 2026-10-14（将军："看板放大，可以标注具体的任务编号"）：板子从 5.4–8.6 放大到 **6.6–10.4**、
   *   高 2.6 → **3.0**、板面抬到 2.25；渲染侧每列也从 10 张放到 12 张。
   *
   * 放大是"能标出编号"的前提：列宽从约 2.15 变到约 2.6，卡片上写 `T-123` 才不挤。
   * 两条约束仍不许破（`scene-layout.test.mjs` 钉着）：板面连边框要在地板内、
   * 要在最后一排工位之后 ≥1.5。所以板宽**随房间宽**取（房间上一轮已从 12 加宽到 18），
   * 而不是写死一个大数 —— 写死会在"人少、房间小"时把板子伸出墙外。
   */
  const boardWidth = Math.min(10.4, Math.max(6.6, floorWidth * 0.58))
  const boardHeight = 3.0
  const backWallZ = -floorDepth / 2
  const boardZ = backWallZ + 0.42
  return {
    preset, stations, floorWidth, floorDepth,
    goal: { x: 0, z: 0 },
    review: { x: -floorWidth / 2 + 1, z: -floorDepth / 2 + 1 },
    help: { x: floorWidth / 2 - 1, z: -floorDepth / 2 + 1 },
    board: { x: 0, z: boardZ, y: 2.25, width: boardWidth, height: boardHeight, standZ: boardZ + 1.15 },
    dressing: { wallHeight: 4.4, wallThickness: 0.3 },
    camera: { distance: span * 1.25, targetY: 1.0, zoom: Math.max(20, 440 / span) },
  }
}

/**
 * 正交相机的缩放：**让整个房间（含墙高与家具）带边距地落进画布**。
 *
 * ★ 2026-10-14（将军："确保办公室场景有足够的空间展示"）：这段原来是 `CameraRig` 里
 *   写死的一行（`size.width / (floorWidth * 1.2)`）—— 而它恰恰是"够不够空间"的**唯一**决定式，
 *   埋在组件里就没法判据化（没有浏览器就测不到）。搬到这里成为纯函数后，
 *   `scene-layout.test.mjs` 能直接断言"画面里的世界尺寸 ≥ 房间尺寸"。
 *
 * 两个方向各留一份边距，取值来自实测：
 *   · 水平 1.45：两侧要放书架/茶水台，贴到画面边缘会显得房间被切掉；
 *   · 垂直 1.42：相机是斜俯视，地板深度会被压缩约 0.8，但同时墙高要占掉上方空间，
 *     两者相抵后 1.42 能让后墙的看板标题与吊灯都在画面内。
 *
 * ⚠ 下限 11（原来是 14）：14 在**窄而矮**的画布上会把房间撑出画面 —— 而那正是
 *   面板收起员工列表之前的样子。宁可略远一点，也不要让看板或人出画。
 */
export function framingZoom(canvas: { width: number; height: number }, layout: SceneLayout): number {
  const horizontal = canvas.width / (layout.floorWidth * 1.45)
  const vertical = canvas.height / (layout.floorDepth * 1.42)
  return Math.max(11, Math.min(75, horizontal, vertical))
}
