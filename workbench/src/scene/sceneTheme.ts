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

/**
 * ★★★ 2026-10-14（将军："办公室场景还是需要明亮的背景色"）：**整套配色改亮**。
 *
 * 原来地板 `#15283a`、墙 `#1e3446` —— 关着灯的仓库，家具再齐也看不出是办公室。
 * 现在按同一个明度关系重排（这个关系是"看起来亮"的关键，不是随便挑浅色）：
 *
 *     地板 < 背景 < 墙          （地板略暗于背景 ⇒ 房间有"地"；墙比背景更亮 ⇒ 房间有"围合"）
 *     地板/墙 > 家具 > 强调色    （家具压在中明度，才不会糊成一片白）
 *
 * ⚠ 只把背景调亮而不动家具，会得到"白底上飘着几个黑影"；只把家具调亮而不动背景，
 *   会得到"灰底上一团灰"。所以这张表是**一起**改的，并有判据钉住明度关系
 *   （见 `scene-theme.test.mjs`：背景与墙的亮度必须 ≥ 阈值，且家具必须比墙暗）。
 */
export const SCENE_THEMES: Record<ScenePreset, SceneTheme> = {
  office: {
    floor: '#d5e0ea', desk: '#a9bccf', accent: '#2f6fae', light: '#ffffff', label: '办公室',
    wall: '#fbfdff', wallTrim: '#cdd9e6', rug: '#bccfe2', plant: '#5f9e63', wood: '#c39a6b', glass: '#e6f4ff', metal: '#a7b3c2',
  },
  studio: {
    floor: '#e7dced', desk: '#c0a8c8', accent: '#9c4f8b', light: '#fffafd', label: '创作室',
    wall: '#fdf8ff', wallTrim: '#ded0e6', rug: '#d6c2de', plant: '#679f6a', wood: '#c8a37f', glass: '#fae7f7', metal: '#b0a2b8',
  },
  lab: {
    floor: '#d7eaed', desk: '#a8c6cc', accent: '#1f8f7d', light: '#f7fffe', label: '实验室',
    wall: '#f7fdfe', wallTrim: '#c8dfe3', rug: '#bdd9dd', plant: '#549f78', wood: '#b8a88f', glass: '#e4fbf7', metal: '#a3b6b9',
  },
  operations: {
    floor: '#eae0cd', desk: '#c9b691', accent: '#b0781f', light: '#fffdf7', label: '运营中心',
    wall: '#fffcf4', wallTrim: '#e0d3ba', rug: '#dccdae', plant: '#7d994d', wood: '#c19a63', glass: '#fff4d9', metal: '#bcae92',
  },
}

/** 场景背景（Canvas 的清屏色）：中性亮灰蓝 —— 比地板亮、比墙暗，房间才"立"得起来。 */
export const SCENE_BACKGROUND = '#e9eff6'

/** 半球光的"地面反弹色"：亮场景下不能用近黑，否则家具底面会脏。 */
export const SCENE_GROUND_BOUNCE = '#b9c6d4'
