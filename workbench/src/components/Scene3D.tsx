import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Grid, Html, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'

export type AgentMode = 'busy' | 'review' | 'blocked' | 'idle'

export interface AgentPose {
  id: string
  name: string
  mode: AgentMode
  tasks: number
  avatar?: string
}

interface Scene3DProps {
  agents: AgentPose[]
  goalPercent: number
  /** 点击某个智能体（身体或名牌）→ 打开它的任务清单。 */
  onAgentClick?: (id: string) => void
}

const MODE_COLOR: Record<AgentMode, string> = {
  busy: '#40ffa0',
  review: '#ffd54a',
  blocked: '#ff5c5c',
  idle: '#5b8cff',
}

const MODE_TEXT: Record<AgentMode, string> = {
  busy: '进行中',
  review: '待验收',
  blocked: '受阻',
  idle: '待命',
}

/** 一名 AI 员工：身体 + 发光头部（状态色）+ 悬浮名牌，头部带轻微呼吸动画。点击身体或名牌可查看其任务。 */
function AgentFigure({ pose, index, count, onSelect }: { pose: AgentPose; index: number; count: number; onSelect?: () => void }): React.JSX.Element {
  const head = useRef<THREE.Mesh>(null)
  const color = MODE_COLOR[pose.mode]
  const angle = (index / Math.max(count, 1)) * Math.PI * 2
  // 围桌半径随编队人数自适应（3～14 人）
  const radius = Math.max(2.6, Math.min(count, 14) * 0.62)
  const x = Math.sin(angle) * radius
  const z = Math.cos(angle) * radius

  useFrame(({ clock }) => {
    if (head.current) {
      head.current.position.y = 1.34 + Math.sin(clock.elapsedTime * 1.6 + index * 1.7) * 0.045
    }
  })

  const hoverCursor = (on: boolean) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    document.body.style.cursor = on ? 'pointer' : 'default'
  }

  return (
    <group
      position={[x, 0, z]}
      rotation={[0, -angle + Math.PI / 2, 0]}
      onClick={e => {
        e.stopPropagation()
        onSelect?.()
      }}
      onPointerOver={hoverCursor(true)}
      onPointerOut={hoverCursor(false)}
    >
      {/* 底座 */}
      <mesh position={[0, 0.06, 0]}>
        <cylinderGeometry args={[0.44, 0.5, 0.12, 24]} />
        <meshStandardMaterial color="#101a26" roughness={0.8} />
      </mesh>
      {/* 身体 */}
      <mesh position={[0, 0.66, 0]}>
        <cylinderGeometry args={[0.3, 0.36, 1.1, 20]} />
        <meshStandardMaterial color="#1d2a3a" roughness={0.65} metalness={0.15} />
      </mesh>
      {/* 头（状态色发光） */}
      <mesh ref={head} position={[0, 1.34, 0]}>
        <sphereGeometry args={[0.27, 24, 24]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={pose.mode === 'blocked' ? 0.6 : 0.3}
          roughness={0.35}
        />
      </mesh>
      {/* 名牌（zIndexRange 限到 40，避免穿透盖到弹窗/浮层之上；可点击查看任务） */}
      <Html position={[0, 1.92, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
        <div
          className="agent-tag clickable"
          title={`查看 ${pose.name} 的任务（进行中/待办/完成）`}
          onClick={e => {
            e.stopPropagation()
            onSelect?.()
          }}
        >
          <div className="agent-tag-name">
            {pose.avatar ? <span className="agent-tag-avatar">{pose.avatar}</span> : null}
            {pose.name}
          </div>
          <div className={`agent-tag-chip ${pose.mode}`}>
            {MODE_TEXT[pose.mode]}
            {pose.tasks > 0 ? ` · ${pose.tasks}` : ''}
          </div>
        </div>
      </Html>
    </group>
  )
}

/** 会议桌旁的空椅子。 */
function Chair({ angle }: { angle: number }): React.JSX.Element {
  const r = 1.55
  const x = Math.sin(angle) * r
  const z = Math.cos(angle) * r
  return (
    <group position={[x, 0, z]} rotation={[0, -angle, 0]}>
      <mesh position={[0, 0.32, 0]}>
        <boxGeometry args={[0.52, 0.08, 0.5]} />
        <meshStandardMaterial color="#1a2533" roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.66, -0.2]}>
        <boxGeometry args={[0.52, 0.7, 0.06]} />
        <meshStandardMaterial color="#1a2533" roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.64, 0]}>
        <cylinderGeometry args={[0.05, 0.05, 0.62, 10]} />
        <meshStandardMaterial color="#101a26" roughness={0.8} />
      </mesh>
    </group>
  )
}

export function Scene3D({ agents, goalPercent, onAgentClick }: Scene3DProps): React.JSX.Element {
  return (
    <Canvas
      camera={{ position: [7.4, 6.4, 8.6], fov: 38 }}
      gl={{ antialias: true }}
      dpr={[1, 1.8]}
      style={{ position: 'absolute', inset: 0 }}
    >
      <color attach="background" args={['#0b1017']} />

      {/* 灯光 */}
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 9, 4]} intensity={1.15} />
      <directionalLight position={[-5, 4, -4]} intensity={0.35} color="#7fb0ff" />

      {/* 地板 + 网格 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[16, 12]} />
        <meshStandardMaterial color="#0d1219" roughness={1} />
      </mesh>
      <Grid
        position={[0, 0, 0]}
        args={[16, 12]}
        cellSize={0.5}
        cellThickness={0.6}
        cellColor="#1b2839"
        sectionSize={2.5}
        sectionThickness={1.1}
        sectionColor="#233a56"
        fadeDistance={26}
        fadeStrength={1.6}
        infiniteGrid={false}
      />

      {/* 会议桌 */}
      <group>
        <mesh position={[0, 0.13, 0]} receiveShadow>
          <cylinderGeometry args={[1.75, 1.75, 0.26, 48]} />
          <meshStandardMaterial color="#17222f" roughness={0.45} metalness={0.4} />
        </mesh>
        <mesh position={[0, 0.27, 0]}>
          <torusGeometry args={[1.75, 0.025, 8, 64]} />
          <meshStandardMaterial color="#2b4a6b" emissive="#2b4a6b" emissiveIntensity={0.5} />
        </mesh>
        <Html position={[0, 0.78, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
          <div className="table-goal">🎯 目标 {goalPercent}%</div>
        </Html>
      </group>

      {/* 空椅子一圈 */}
      {Array.from({ length: 8 }, (_, i) => (
        <Chair key={`c${i}`} angle={(i / 8) * Math.PI * 2 + Math.PI / 8} />
      ))}

      {/* AI 员工（绕桌一圈，状态实时投影；点击查看任务） */}
      {agents.map((a, i) => (
        <AgentFigure key={a.id} pose={a} index={i} count={agents.length} onSelect={() => onAgentClick?.(a.id)} />
      ))}
      {agents.length === 0 && (
        <Html position={[0, 1.6, 0]} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
          <div className="table-goal">暂无智能体任务（发布 goal 后士兵就位）</div>
        </Html>
      )}

      <OrbitControls
        target={[0, 1.1, 0]}
        minDistance={5}
        maxDistance={26}
        maxPolarAngle={Math.PI / 2.12}
        enablePan={false}
        autoRotate={agents.length > 0}
        autoRotateSpeed={0.45}
      />
    </Canvas>
  )
}

export default Scene3D
