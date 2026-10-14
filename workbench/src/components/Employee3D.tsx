import { useEffect, useMemo, useRef, useState } from 'react'
import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { SceneAgent } from '../scene/sceneState'
import { BOARD_VISIT_MS, MOOD_STYLE, STATUS_STYLE } from '../scene/sceneBoard'
import type { SceneBoardVisit } from '../scene/sceneBoard'
import { AgentBubble } from './AgentBubble'

const BOX = new THREE.BoxGeometry(1, 1, 1)
const PALETTES = ['#4e84be', '#9472bd', '#44a99c', '#cf8764', '#7d9b60', '#b47197']

/**
 * 像素员工：站姿、工位光环、头顶气泡，以及"认领/完结时走向看板"的那一趟。
 *
 * ## 走看板是一条**时间轴**，不是一个布尔值
 *
 * `boardVisit` 只在派生那一刻有效（窗口 = `BOARD_VISIT_MS`）。动画把这段时间分成三段：
 *
 *   `0 → 0.34` 走向看板 → `0.34 → 0.66` 在板前**办事**（抬手取卡/贴卡）→ `0.66 → 1` 走回工位
 *
 * 用"距开始多久"而不是"有没有提示"来驱动，是因为**提示会在半路过期**：
 * 若按"有提示就站在板前、没有就回工位"，一个刚好在 2.7 秒时到达的人会被瞬移回工位。
 * 所以起点时间被记在 `startedAt` 里，走完全程与提示是否还在无关。
 *
 * ★ 总时长与提示有效期取自**同一个常量** `BOARD_VISIT_MS`：分成两个数就会出现
 *   "人还在路上，提示已经过期"这种抖动，而它没人会归因到两个常量不同步。
 *
 * ## 为什么光环、气泡、看板卡片共用一张颜色表
 *
 * 三处都从 `sceneBoard.ts` 取色。此前 `Employee3D` 自己写了一份 `STATUS`/`LABEL`，
 * 与看板那份迟早会漂移 —— 症状是**同一件任务在同一画面里两种颜色**，不报错。
 */
export function Employee3D({ agent, x, z, motion, celebrate, compact, onSelect, boardVisit, blockedCount = 0, boardStandX, boardStandZ }: {
  agent: SceneAgent; x: number; z: number; motion: boolean; celebrate: boolean; compact: boolean; onSelect: () => void
  /** 现在该不该去走一趟看板（认领取卡 / 完结贴卡）；过期后为 null。 */
  boardVisit?: SceneBoardVisit | null
  /** 他手上受阻的件数（气泡上的红标用它）。 */
  blockedCount?: number
  /** 看板前他该站的位置（含"别跟别人挤同一点"的横向错位，由 Scene3D 按种子算好）。 */
  boardStandX?: number
  boardStandZ?: number
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const root = useRef<THREE.Group>(null)
  const leftArm = useRef<THREE.Mesh>(null)
  const rightArm = useRef<THREE.Mesh>(null)
  const leftLeg = useRef<THREE.Group>(null)
  const rightLeg = useRef<THREE.Group>(null)
  const card = useRef<THREE.Mesh>(null)
  const previousMode = useRef(agent.mode)
  const walkStart = useRef<number | null>(null)
  /** 本趟走看板的起点时刻（毫秒）。只在这一趟开始那一刻写一次，之后由它算进度。 */
  const visitStartedAt = useRef(0)
  const visitRef = useRef<SceneBoardVisit | null>(null)
  const face = useMemo(faceTexture, [])
  const tone = agent.external ? '#586879' : PALETTES[agent.appearanceSeed % PALETTES.length]
  const shirt = useMemo(() => shirtTexture(tone), [tone])
  const mood = MOOD_STYLE[agent.mode]
  const status = mood.color
  useEffect(() => () => face.dispose(), [face])
  useEffect(() => () => shirt.dispose(), [shirt])
  useEffect(() => {
    if (previousMode.current === 'idle' && agent.mode === 'busy' && motion) walkStart.current = performance.now()
    previousMode.current = agent.mode
  }, [agent.mode, motion])
  // 新的一趟看板：记下起点（用 id 判"是不是同一趟"，避免同一提示重复重置进度）
  useEffect(() => {
    if (!boardVisit) return
    if (visitRef.current?.id === boardVisit.id) return
    visitRef.current = boardVisit
    visitStartedAt.current = performance.now()
  }, [boardVisit])
  useEffect(() => {
    if (motion) return
    if (root.current) root.current.position.set(0, 0, 0)
    for (const ref of [leftArm, rightArm]) if (ref.current) ref.current.rotation.x = 0
    for (const ref of [leftLeg, rightLeg]) if (ref.current) ref.current.rotation.x = 0
  }, [motion])
  useEffect(() => () => { document.body.style.cursor = '' }, [])
  useFrame(({ clock }) => {
    if (!motion || !root.current) return
    const t = clock.elapsedTime * 2 + (agent.appearanceSeed % 11)
    const working = agent.mode === 'busy'
    const visit = visitRef.current
    let walking = false
    let acting = false
    // ① 走看板这一趟（若在窗口内）
    if (visit && motion) {
      const progress = Math.min(1, (performance.now() - visitStartedAt.current) / BOARD_VISIT_MS)
      const outbound = Math.min(1, progress / 0.34)
      const inbound = progress < 0.66 ? 0 : Math.min(1, (progress - 0.66) / 0.34)
      const travel = outbound - inbound
      const dx = (boardStandX ?? x) - x
      const dz = (boardStandZ ?? z) - z
      root.current.position.x = dx * travel
      root.current.position.z = dz * travel
      walking = progress < 0.34 || progress > 0.66
      acting = progress >= 0.34 && progress <= 0.66
      if (progress >= 1) visitRef.current = null
    } else if (walkStart.current !== null) {
      // ② 平时"起身走向工位"的那一步（原有行为，保留）
      const progress = Math.min(1, (performance.now() - walkStart.current) / 750)
      root.current.position.x = 0
      root.current.position.z = (1 - progress) * 0.8
      walking = progress < 1
      if (progress === 1) walkStart.current = null
    } else {
      root.current.position.x = 0
      root.current.position.z = 0
    }
    // ⚠ 这里只加"小幅起伏"：`acting` 是站着抬手贴/取卡，**不是**把人抬起来
    root.current.position.y = celebrate ? Math.abs(Math.sin(t * 3)) * 0.24
      : walking ? Math.abs(Math.sin(t * 5)) * 0.05
        : acting ? Math.abs(Math.sin(t * 6)) * 0.03
          : working ? Math.sin(t * 2) * 0.018 : Math.sin(t) * 0.025
    // 走路时迈腿：绕髋部摆腿（腿与鞋在同一个 group 里，所以是一起摆的）
    const step = walking ? Math.sin((performance.now() / 1000) * 9 + (agent.appearanceSeed % 7)) * 0.55 : 0
    if (leftLeg.current) leftLeg.current.rotation.x = step
    if (rightLeg.current) rightLeg.current.rotation.x = -step
    if (leftArm.current) leftArm.current.rotation.x = celebrate ? Math.sin(t * 4) * 0.6 - 0.6
      : acting ? -1.15 : walking ? -step * 0.8 : working ? Math.sin(t * 2) * 0.22 : 0
    if (rightArm.current) rightArm.current.rotation.x = celebrate ? -Math.sin(t * 4) * 0.6 - 0.6
      : acting ? -1.15 : walking ? step * 0.8 : working ? -Math.sin(t * 2) * 0.22 : agent.mode === 'blocked' ? -0.45 : 0
    // 手上那张卡：办事时出现（取卡=拿起来，贴卡=递上去），其余时刻收起来
    if (card.current) {
      card.current.visible = acting
      card.current.position.set(0.52, acting ? 1.62 + Math.sin(t * 6) * 0.03 : 0.57, 0.3)
    }
  })
  const part = (key: string, color: string, position: [number, number, number], scale: [number, number, number]) => (
    <mesh key={key} geometry={BOX} position={position} scale={scale} castShadow>
      <meshStandardMaterial color={color} roughness={1} flatShading />
    </mesh>
  )
  return (
    <group position={[x, 0, z]} dispose={null}
      onClick={event => { event.stopPropagation(); onSelect() }}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.025, 0]}>
        <ringGeometry args={[0.42, 0.5, 4]} />
        <meshBasicMaterial color={status} side={THREE.DoubleSide} />
      </mesh>
      <group ref={root}>
        {part('torso', tone, [0, 0.83, 0], [0.58, 0.7, 0.32])}
        <mesh geometry={BOX} position={[0, 0.83, 0.168]} scale={[0.51, 0.62, 0.012]}>
          <meshBasicMaterial map={shirt} />
        </mesh>
        {part('belt', '#253344', [0, 0.46, 0.02], [0.6, 0.1, 0.34])}
        {part('head', '#e9bd93', [0, 1.47, 0], [0.56, 0.53, 0.5])}
        {part('hair', agent.external ? '#596b7b' : '#28364b', [0, 1.76, -0.015], [0.62, 0.13, 0.54])}
        <mesh geometry={BOX} position={[0, 1.47, 0.255]} scale={[0.48, 0.46, 0.015]}>
          <meshBasicMaterial map={face} />
        </mesh>
        {part('badge', status, [0.18, 0.98, 0.18], [0.16, 0.16, 0.025])}
        <mesh ref={leftArm} geometry={BOX} position={[-0.41, 0.83, 0]} scale={[0.18, 0.6, 0.23]} castShadow>
          <meshStandardMaterial color={tone} roughness={1} />
        </mesh>
        <mesh ref={rightArm} geometry={BOX} position={[0.41, 0.83, 0]} scale={[0.18, 0.6, 0.23]} castShadow>
          <meshStandardMaterial color={tone} roughness={1} />
        </mesh>
        {part('left-hand', '#e9bd93', [-0.41, 0.47, 0], [0.18, 0.14, 0.23])}
        {part('right-hand', '#e9bd93', [0.41, 0.47, 0], [0.18, 0.14, 0.23])}
        {/* 腿与鞋成组挂在髋部：走路时整条腿绕髋摆动（几何位置与从前逐字一致） */}
        <group ref={leftLeg} position={[-0.17, 0.62, 0]}>
          {part('left-leg', '#24364c', [0, -0.39, 0], [0.2, 0.46, 0.25])}
          {part('left-shoe', '#172130', [0, -0.565, 0.08], [0.23, 0.11, 0.34])}
        </group>
        <group ref={rightLeg} position={[0.17, 0.62, 0]}>
          {part('right-leg', '#24364c', [0, -0.39, 0], [0.2, 0.46, 0.25])}
          {part('right-shoe', '#172130', [0, -0.565, 0.08], [0.23, 0.11, 0.34])}
        </group>
        {agent.external && part('temporary', '#f1c766', [0, 1.17, 0.18], [0.25, 0.08, 0.03])}
        {part('tool', agent.mode === 'review' ? '#f1c766' : '#98c6d9', [0.52, 0.57, 0.16], [0.12, 0.28, 0.05])}
        {agent.mode === 'review' && part('review-sheet', '#ffe19a', [0.52, 0.75, 0.24], [0.34, 0.4, 0.035])}
        {agent.mode === 'blocked' && part('help-sign', '#ff6b6b', [0, 2.03, 0], [0.14, 0.28, 0.08])}
        {/* 办事时手里那张卡：颜色 = 他正在处理的这件事的状态（与看板卡片同色） */}
        <mesh ref={card} visible={false} position={[0.52, 0.57, 0.3]} rotation={[0, 0, 0.18]}>
          <planeGeometry args={[0.34, 0.24]} />
          <meshStandardMaterial color={STATUS_STYLE[boardVisit?.status ?? 'todo'].color}
            emissive={STATUS_STYLE[boardVisit?.status ?? 'todo'].color} emissiveIntensity={0.55} side={THREE.DoubleSide} />
        </mesh>
      </group>
      {/* 头顶气泡：常驻（人多时压成最小样式），悬浮展开他的全部任务 */}
      <Html position={[0, 2.62, 0]} center zIndexRange={[30, 0]}>
        <AgentBubble agent={agent} expanded={hovered} minimal={compact && !hovered} blocked={blockedCount}
          onHoverChange={value => { setHovered(value); document.body.style.cursor = value ? 'pointer' : '' }}
          onSelect={onSelect} />
      </Html>
    </group>
  )
}

function faceTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 8
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#e9bd93'; ctx.fillRect(0, 0, 8, 8)
  ctx.fillStyle = '#253344'; ctx.fillRect(2, 3, 1, 1); ctx.fillRect(5, 3, 1, 1)
  ctx.fillStyle = '#b66e63'; ctx.fillRect(3, 5, 2, 1)
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function shirtTexture(tone: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 8
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = tone; ctx.fillRect(0, 0, 8, 8)
  ctx.fillStyle = '#dbe9f1'; ctx.fillRect(1, 1, 6, 1); ctx.fillRect(3, 2, 2, 2)
  ctx.fillStyle = '#203245'; ctx.fillRect(3, 4, 2, 3)
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
