import type { ScenePreset } from '../types'

export interface SceneStation { key: string; x: number; z: number; row: number; column: number }
export interface SceneLayout {
  preset: ScenePreset
  stations: SceneStation[]
  floorWidth: number
  floorDepth: number
  goal: { x: number; z: number }
  review: { x: number; z: number }
  help: { x: number; z: number }
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
  return {
    preset, stations, floorWidth, floorDepth,
    goal: { x: 0, z: 0 },
    review: { x: -floorWidth / 2 + 1, z: -floorDepth / 2 + 1 },
    help: { x: floorWidth / 2 - 1, z: -floorDepth / 2 + 1 },
    camera: { distance: span * 1.15, targetY: 0.7, zoom: Math.max(20, 440 / span) },
  }
}
