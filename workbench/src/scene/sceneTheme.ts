import type { ScenePreset } from '../types'

/**
 * 场景配色。★ 2026-10-14 从 `Scene3D.tsx` 提出来：办公室**布景**（墙、窗、地毯、绿植、
 * 家具）需要比"地板/桌子/强调色"更多的色号，而把两套色写在一个大组件里，
 * 迟早会出现"墙的色号只在那一个 JSX 分支里"这种没人能复用的局面。
 *
 * 四个预设各一套：同一个办公室，四种氛围。新增预设时这里少一个键，
 * `Record<ScenePreset, …>` 会直接报类型错（而不是静默用默认色）。
 */
export interface SceneTheme {
  /** 地板与网线格。 */
  floor: string
  /** 工位桌子。 */
  desk: string
  /** 强调色（看板灯、屏幕、状态点缀）。 */
  accent: string
  /** 主光颜色（半球光/平行光）。 */
  light: string
  /** 给工具栏看的中文名。 */
  label: string
  /** 墙。 */
  wall: string
  /** 墙的踢脚/边框（比墙深一点，让墙不像一块塑料板）。 */
  wallTrim: string
  /** 地毯。 */
  rug: string
  /** 绿植。 */
  plant: string
  /** 木家具（会议桌、书架、茶水台）。 */
  wood: string
  /** 玻璃/屏幕（窗、水桶）。 */
  glass: string
  /** 金属（柜子、饮水机、椅腿）。 */
  metal: string
}

export const SCENE_THEMES: Record<ScenePreset, SceneTheme> = {
  office: {
    floor: '#15283a', desk: '#41607b', accent: '#5e9ed2', light: '#b9d8ff', label: '办公室',
    wall: '#1e3446', wallTrim: '#2b4a62', rug: '#1b3b55', plant: '#4f9a63', wood: '#6b4f36', glass: '#8fd0ff', metal: '#93a2b2',
  },
  studio: {
    floor: '#30263a', desk: '#765579', accent: '#dc9acb', light: '#f8c8ec', label: '创作室',
    wall: '#3c3048', wallTrim: '#5a4467', rug: '#472f52', plant: '#6fa86f', wood: '#7b5a44', glass: '#f0b6e0', metal: '#b39ec0',
  },
  lab: {
    floor: '#193138', desk: '#3a6972', accent: '#67d9c7', light: '#b2fff1', label: '实验室',
    wall: '#22434c', wallTrim: '#2f6069', rug: '#1f3b42', plant: '#5fa88f', wood: '#5c6f6a', glass: '#a9f0e4', metal: '#9fb3b8',
  },
  operations: {
    floor: '#342a21', desk: '#796443', accent: '#e8bf69', light: '#fff0ba', label: '运营中心',
    wall: '#463826', wallTrim: '#6b5433', rug: '#3d3020', plant: '#8a9a52', wood: '#7a5c35', glass: '#ffdf9e', metal: '#b8a888',
  },
}
