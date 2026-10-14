import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Grid, Html, Line, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { ScenePreset } from '../types'
import type { SceneAgent, SceneCue } from '../scene/sceneState'
import type { SceneBoardVisit, SceneBoardCard, BoardStaffRow } from '../scene/sceneBoard'
import { BOARD_COLUMNS, STATUS_BAR_COLOR, STATUS_STYLE, boardHeadline, groupTasksByColumn } from '../scene/sceneBoard'
import { layoutScene, framingZoom } from '../scene/sceneLayout'
import type { SceneLayout } from '../scene/sceneLayout'
import { SCENE_BACKGROUND, SCENE_GROUND_BOUNCE, SCENE_THEMES } from '../scene/sceneTheme'
import { Employee3D } from './Employee3D'
import { OfficeDressing } from './OfficeDressing'
import { TaskBoard3D } from './TaskBoard3D'
import { SceneAgentList } from './SceneAgentList'
import '../scene/officeScene.css'

interface Scene3DProps {
  agents: SceneAgent[]; cues: SceneCue[]; preset: ScenePreset; goalLabel: string
  /** 谁现在该去走一趟看板（认领取卡 / 完结贴卡）。与 `cues` 同一次快照的产物。 */
  boardVisits?: SceneBoardVisit[]
  /** 看板上要显示的卡片（本空间**在办**任务 + 归属人）。缺省 ⇒ 只画一块空板，不编数据。 */
  boardTasks?: SceneBoardCard[]
  /** 按员工汇总（顶部统计条与板底那一行）。 */
  boardStaff?: BoardStaffRow[]
  motionEnabled?: boolean; onAgentClick?: (role: string) => void
}

function webglAvailable(): boolean {
  try { const canvas = document.createElement('canvas'); return !!(canvas.getContext('webgl2') || canvas.getContext('webgl')) }
  catch { return false }
}

class SceneBoundary extends Component<{ children: React.ReactNode; fallback: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  render(): React.ReactNode { return this.state.failed ? this.props.fallback : this.props.children }
}

function CameraRig({ layout }: { layout: SceneLayout }): null {
  const { camera, size, invalidate } = useThree()
  useEffect(() => {
    const ortho = camera as THREE.OrthographicCamera
    ortho.position.set(layout.camera.distance * 0.64, layout.camera.distance * 0.75, layout.camera.distance * 0.78)
    ortho.lookAt(0, layout.camera.targetY, 0)
    // ★ 取景是**纯函数**（`framingZoom`）：它决定"房间够不够空间展示"，
    //   搬出组件之后判据才能直接断言"画面里的世界尺寸 ≥ 房间尺寸"（见 scene-layout.test.mjs）。
    ortho.zoom = framingZoom({ width: size.width, height: size.height }, layout)
    ortho.updateProjectionMatrix(); invalidate()
  }, [camera, invalidate, layout, size.width, size.height])
  return null
}

/**
 * 看板前"别跟别人挤同一点"的横向错位：按身份种子确定。
 * 用种子（而不是"到场顺序"）是为了让同一个人每次都站同一个位置 ——
 * 否则同一个人每次办事站的地方都不同，看起来像场景在抖。
 */
export function boardLaneOffset(seed: number, index = 0): number {
  return (((seed + index * 3) % 5) - 2) * 0.52
}

function OfficeWorld({ agents, cues, boardVisits = [], boardTasks = [], boardStaff = [], layout, preset, goalLabel, motion, compact, onAgentClick }: Scene3DProps & { layout: SceneLayout; motion: boolean; compact: boolean }): React.JSX.Element {
  const theme = SCENE_THEMES[preset]
  const stations = new Map(layout.stations.map(station => [station.key, station]))
  const names = useMemo(() => new Map(agents.map(agent => [agent.role, agent.name])), [agents])
  const liveCues = cues.filter(cue => cue.expiresAtMs > Date.now())
  /**
   * 板上高亮哪张卡：取**最早过期**的那一条（= 最早出发的那一位）。
   * 同时有两个人来办事时板面只报一件 —— 报两件会互相盖住，
   * 而"谁在办哪张卡"在他自己的气泡与板底那一行里仍然分别可见。
   */
  const activeVisit = boardVisits.filter(visit => visit.expiresAtMs > Date.now())
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs)[0] ?? null
  return <>
    {/* ★ 明亮的背景（将军："办公室场景还是需要明亮的背景色"）：见 sceneTheme 里那段明度关系 */}
    <color attach="background" args={[SCENE_BACKGROUND]} />
    <ambientLight intensity={1.45} />
    <hemisphereLight color={theme.light} groundColor={SCENE_GROUND_BOUNCE} intensity={1.05} />
    <directionalLight position={[8, 14, 10]} intensity={1.75} color={theme.light} castShadow />
    <CameraRig layout={layout} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.025, 0]} receiveShadow>
      <planeGeometry args={[layout.floorWidth, layout.floorDepth]} /><meshStandardMaterial color={theme.floor} roughness={1} />
    </mesh>
    {/* 网格线用 `wallTrim`（比地板深一档）：亮地板配浅网格线会看不见 */}
    <Grid position={[0, 0, 0]} args={[layout.floorWidth, layout.floorDepth]} cellSize={0.5} cellColor={theme.wallTrim}
      sectionSize={2} sectionColor={theme.accent} sectionThickness={0.5} infiniteGrid={false} fadeDistance={80} />
    {/* 办公室布景：墙、窗、吊灯、地毯、会议桌、书架、茶水角、绿植（只落在安全带里，见其文件头） */}
    <OfficeDressing layout={layout} theme={theme} />
    {layout.stations.map(station => <group key={station.key} position={[station.x, 0, station.z]}>
      <mesh position={[0, 0.48, -0.76]} castShadow><boxGeometry args={[1.55, 0.14, 0.74]} /><meshStandardMaterial color={theme.desk} roughness={0.85} /></mesh>
      <mesh position={[0, 0.77, -0.95]} castShadow><boxGeometry args={[0.62, 0.48, 0.07]} /><meshStandardMaterial color="#18293a" emissive={theme.accent} emissiveIntensity={0.25} /></mesh>
      <mesh position={[0, 0.52, -0.38]}><boxGeometry args={[0.42, 0.025, 0.16]} /><meshStandardMaterial color="#192535" /></mesh>
      {/* 桌下的机箱：让工位看起来"有人用过"，也补上桌下的空档 */}
      <mesh position={[0, 0.3, -0.4]}><boxGeometry args={[0.34, 0.6, 0.34]} /><meshStandardMaterial color="#243447" /></mesh>
    </group>)}
    <group>
      <mesh position={[0, 0.2, 0]}><boxGeometry args={[1.2, 0.4, 1.2]} /><meshStandardMaterial color={theme.desk} /></mesh>
      <mesh position={[0, 0.57, 0]}><boxGeometry args={[0.72, 0.36, 0.72]} /><meshStandardMaterial color={theme.accent} emissive={theme.accent} emissiveIntensity={0.2} /></mesh>
      <Html center position={[0, 1.02, 0]} zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}><div className="pixel-goal-label">🎯 {goalLabel}</div></Html>
    </group>
    {[layout.review, layout.help].map((place, index) => <group key={index} position={[place.x, 0, place.z]}>
      <mesh position={[0, 0.36, 0]}><boxGeometry args={[1.05, 0.7, 0.5]} /><meshStandardMaterial color={theme.desk} /></mesh>
      {preset === 'studio' ? <mesh position={[0, 1, -0.08]} rotation={[0, index ? 0.3 : -0.3, 0]}>
        <boxGeometry args={[0.7, 0.8, 0.08]} /><meshStandardMaterial color="#eed3a9" />
      </mesh> : preset === 'lab' ? <mesh position={[0, 0.98, -0.08]}>
        <boxGeometry args={[0.72, 0.56, 0.14]} /><meshStandardMaterial color="#8bded0" emissive="#329b90" emissiveIntensity={0.25} />
      </mesh> : preset === 'operations' ? <mesh position={[0, 0.94, -0.08]}>
        <boxGeometry args={[0.82, 0.42, 0.1]} /><meshStandardMaterial color="#e5b95f" emissive="#9b6c25" emissiveIntensity={0.3} />
      </mesh> : <mesh position={[0, 0.95, -0.08]}>
        <boxGeometry args={[0.65, 0.48, 0.14]} /><meshStandardMaterial color="#bed8ec" />
      </mesh>}
    </group>)}
    {/* 微缩任务看板：Agent 认领/完结时会走到它前面办一下 */}
    <TaskBoard3D cards={boardTasks} staff={boardStaff} names={names} board={layout.board} activeVisit={activeVisit} />
    {agents.map(agent => {
      const station = stations.get(agent.key)
      if (!station) return null
      const celebrating = motion && liveCues.some(cue => cue.kind === 'completed' && cue.fromRole === agent.role)
      const visit = boardVisits.find(item => item.role === agent.role && item.expiresAtMs > Date.now()) ?? null
      const lane = boardLaneOffset(agent.appearanceSeed, station.column)
      return <Employee3D key={agent.key} agent={agent} x={station.x} z={station.z} motion={motion} celebrate={celebrating} compact={compact}
        onSelect={() => onAgentClick?.(agent.role)} boardVisit={visit}
        blockedCount={boardStaff.find(row => row.role === agent.role)?.blocked ?? 0}
        boardStandX={layout.board.x + lane} boardStandZ={layout.board.standZ} />
    })}
    {motion && liveCues.filter(cue => cue.kind === 'handoff').map(cue => {
      const from = agents.find(agent => agent.role === cue.fromRole)
      const to = agents.find(agent => agent.role === cue.toRole)
      const a = from && stations.get(from.key), b = to && stations.get(to.key)
      return a && b ? <Line key={cue.id} points={[[a.x, 1.3, a.z], [b.x, 1.3, b.z]]} color={theme.accent} lineWidth={3} dashed /> : null
    })}
    <OrbitControls target={[0, layout.camera.targetY, 0]} enablePan={false} enableDamping={motion} minPolarAngle={0.35} maxPolarAngle={Math.PI / 2.2} minZoom={14} maxZoom={95} />
  </>
}

export function Scene3D({ agents, cues, preset, goalLabel, boardVisits = [], boardTasks = [], boardStaff = [], motionEnabled = true, onAgentClick }: Scene3DProps): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(1000)
  const keys = agents.map(agent => agent.key).join('\n')
  const layout = useMemo(() => layoutScene(agents.map(agent => agent.key), preset), [keys, preset])
  const [available] = useState(webglAvailable)
  const [motionOn, setMotionOn] = useState(true)
  const [reduced, setReduced] = useState(false)
  const [visible, setVisible] = useState(true)
  /** 底部员工列表是否展开（默认展开：第一次进来要看得见有谁）。 */
  const [listOpen, setListOpen] = useState(true)
  const [cueTick, setCueTick] = useState(0)
  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => setReduced(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  useEffect(() => {
    // 提示与"走看板"都会过期：按**两者中更早**的那个到期时间安排一次重渲染。
    // 只盯 `cues` 的话，最后一位走回工位后会僵在板前 —— 画面里没人动，也没人报错。
    const expiries = [...cues.map(cue => cue.expiresAtMs), ...boardVisits.map(visit => visit.expiresAtMs)]
      .filter(expiry => expiry > Date.now()).sort((a, b) => a - b)
    const nextExpiry = expiries[0]
    if (nextExpiry === undefined) return
    const timer = window.setTimeout(() => setCueTick(value => value + 1), Math.max(0, nextExpiry - Date.now()))
    return () => window.clearTimeout(timer)
  }, [cues, boardVisits, cueTick])
  const motion = motionEnabled && motionOn && !reduced && visible
  const fallback = <div className="scene-webgl-fallback">3D 场景暂不可用，可从下面的员工列表查看状态{onAgentClick ? '与任务' : ''}。</div>
  /** 看板全景读数（顶部条与"悬浮看板"面板共用一份算好的数）。 */
  const grouped = groupTasksByColumn(boardTasks)
  const boardSnapshot = {
    total: boardTasks.length,
    staff: boardStaff.length,
    blocked: boardTasks.filter(card => card.status === 'blocked').length,
    busiest: boardStaff[0] ? { name: boardStaff[0].name, total: boardStaff[0].total } : null,
  }
  return <div className="pixel-scene-content" ref={container}>
    {/*
      ★★ 2026-10-14（将军："任务看板 0项统计可以固定在场景顶部，不随场景旋转"）：
        这一条是**屏幕空间的 DOM**（不是 3D 里的 `<Html>`）⇒ 它钉在画布顶部，转场景时纹丝不动。
        内容按列给出"在办任务"的分布：百分比条 + 数字。
    */}
    <div className="scene-status-bar">
      <span className="scene-status-title">{boardHeadline(boardSnapshot)}</span>
      <span className="scene-status-bars">
        {BOARD_COLUMNS.map(column => {
          const count = grouped.get(column.key)?.length ?? 0
          const share = boardSnapshot.total === 0 ? 0 : Math.round((count / boardSnapshot.total) * 100)
          return <span className="scene-status-item" key={column.key} title={`${column.label} ${count} 项`}>
            <i style={{ background: STATUS_BAR_COLOR[column.key] ?? STATUS_BAR_COLOR.todo }} />
            {column.label} {count}
            <b style={{ width: `${share}%` }} />
          </span>
        })}
      </span>
    </div>
    <div className="pixel-scene-canvas">
      {available ? <SceneBoundary fallback={fallback}><Canvas orthographic shadows frameloop={motion ? 'always' : 'demand'} dpr={[1, 1.5]}>
        <OfficeWorld agents={agents} cues={cues} boardVisits={boardVisits} boardTasks={boardTasks} boardStaff={boardStaff}
          preset={preset} goalLabel={goalLabel}
          motion={motion} compact={agents.length > 12 || width < 700} onAgentClick={onAgentClick} layout={layout} />
      </Canvas></SceneBoundary> : fallback}
      {/*
        ★ 悬停看板时把读数钉在画布上（也在屏幕空间，不随旋转）。
          为什么另做一个而不是只靠 3D 里那些 `<Html>`：那些会随场景旋转/缩放，
          而这正是将军要摆脱的行为。这里用 `<details>` 做"点开/收起"，不需要额外状态。
      */}
      {boardTasks.length > 0 && <details className="scene-board-tip">
        <summary>📋 看板 {boardTasks.length} 项 · 悬停看明细</summary>
        <div className="scene-board-tip-body">
          {BOARD_COLUMNS.map(column => {
            const columnTasks = grouped.get(column.key) ?? []
            if (columnTasks.length === 0) return null
            return <div className="scene-board-tip-group" key={column.key}>
              <b style={{ color: STATUS_BAR_COLOR[column.key] ?? STATUS_BAR_COLOR.todo }}>{column.label} {columnTasks.length}</b>
              {columnTasks.slice(0, 8).map(task => <span className="scene-board-tip-row" key={task.id}>
                <i style={{ background: STATUS_STYLE[task.status].color }} />
                <code>{task.id}</code>
                <em>{task.role ? (agents.find(agent => agent.role === task.role)?.name ?? task.role) : '未认领'}</em>
                <span title={task.title}>{task.title}</span>
              </span>)}
              {columnTasks.length > 8 && <span className="scene-board-tip-more">还有 {columnTasks.length - 8} 项…</span>}
            </div>
          })}
        </div>
      </details>}
    </div>
    <div className="pixel-scene-toolbar">
      <span>{SCENE_THEMES[preset].label} · {agents.length} 位员工</span>
      <div className="pixel-scene-toolbar-actions">
        {/*
          ★ 2026-10-14（将军："底部办公室员工可以收起"）：员工列表占着 68px 高，
            收起后那一段**全部给画面**（canvas 是 flex:1，于是自动吃掉这份空间）——
            这也是"确保办公室场景有足够的空间展示"最直接的一步。
            默认展开（第一次进来要看得见有谁），之后的选择由人自己定。
        */}
        <button type="button" onClick={() => setListOpen(value => !value)} aria-expanded={listOpen}>
          {listOpen ? '收起员工列表' : `展开员工列表（${agents.length}）`}
        </button>
        <button type="button" onClick={() => setMotionOn(value => !value)} aria-pressed={motionOn}>{motionOn ? '暂停动画' : '开启动画'}</button>
      </div>
    </div>
    {listOpen && <SceneAgentList agents={agents} onAgentClick={onAgentClick} />}
  </div>
}

export default Scene3D
