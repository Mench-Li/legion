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
  const floorWidth = Math.max(12, columns * spacingX + 3.5)
  const floorDepth = Math.max(10, rows * spacingZ + 3.5)
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
  const boardWidth = Math.min(8.6, Math.max(5.4, floorWidth * 0.52))
  const boardHeight = 2.6
  const backWallZ = -floorDepth / 2
  const boardZ = backWallZ + 0.42
  return {
    preset, stations, floorWidth, floorDepth,
    goal: { x: 0, z: 0 },
    review: { x: -floorWidth / 2 + 1, z: -floorDepth / 2 + 1 },
    help: { x: floorWidth / 2 - 1, z: -floorDepth / 2 + 1 },
    board: { x: 0, z: boardZ, y: 2.02, width: boardWidth, height: boardHeight, standZ: boardZ + 1.15 },
    dressing: { wallHeight: 4.4, wallThickness: 0.3 },
    camera: { distance: span * 1.15, targetY: 0.7, zoom: Math.max(20, 440 / span) },
  }
}
