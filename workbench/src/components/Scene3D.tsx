import { Component, useEffect, useMemo, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Grid, Html, Line, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { ScenePreset } from '../types'
import type { SceneAgent, SceneCue } from '../scene/sceneState'
import { layoutScene } from '../scene/sceneLayout'
import type { SceneLayout } from '../scene/sceneLayout'
import { Employee3D } from './Employee3D'
import { SceneAgentList } from './SceneAgentList'

interface Scene3DProps {
  agents: SceneAgent[]; cues: SceneCue[]; preset: ScenePreset; goalPercent: number
  motionEnabled?: boolean; onAgentClick?: (role: string) => void
}

const PRESETS: Record<ScenePreset, { floor: string; desk: string; accent: string; light: string; label: string }> = {
  office: { floor: '#15283a', desk: '#41607b', accent: '#5e9ed2', light: '#b9d8ff', label: '办公室' },
  studio: { floor: '#30263a', desk: '#765579', accent: '#dc9acb', light: '#f8c8ec', label: '创作室' },
  lab: { floor: '#193138', desk: '#3a6972', accent: '#67d9c7', light: '#b2fff1', label: '实验室' },
  operations: { floor: '#342a21', desk: '#796443', accent: '#e8bf69', light: '#fff0ba', label: '运营中心' },
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
    ortho.zoom = Math.max(14, Math.min(75, size.width / (layout.floorWidth * 1.2), size.height / (layout.floorDepth * 1.2)))
    ortho.updateProjectionMatrix(); invalidate()
  }, [camera, invalidate, layout, size.width, size.height])
  return null
}

function OfficeWorld({ agents, cues, layout, preset, goalPercent, motion, onAgentClick }: Scene3DProps & { layout: SceneLayout; motion: boolean }): React.JSX.Element {
  const theme = PRESETS[preset]
  const stations = new Map(layout.stations.map(station => [station.key, station]))
  const liveCues = cues.filter(cue => cue.expiresAtMs > Date.now())
  return <>
    <color attach="background" args={['#0b111a']} />
    <ambientLight intensity={1.3} />
    <hemisphereLight color={theme.light} groundColor="#17202a" intensity={1.5} />
    <directionalLight position={[8, 14, 10]} intensity={2.5} color={theme.light} castShadow />
    <CameraRig layout={layout} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.025, 0]} receiveShadow>
      <planeGeometry args={[layout.floorWidth, layout.floorDepth]} /><meshStandardMaterial color={theme.floor} roughness={1} />
    </mesh>
    <Grid position={[0, 0, 0]} args={[layout.floorWidth, layout.floorDepth]} cellSize={0.5} cellColor={theme.desk}
      sectionSize={2} sectionColor={theme.accent} sectionThickness={0.5} infiniteGrid={false} fadeDistance={80} />
    {layout.stations.map(station => <group key={station.key} position={[station.x, 0, station.z]}>
      <mesh position={[0, 0.48, -0.76]} castShadow><boxGeometry args={[1.55, 0.14, 0.74]} /><meshStandardMaterial color={theme.desk} roughness={0.85} /></mesh>
      <mesh position={[0, 0.77, -0.95]} castShadow><boxGeometry args={[0.62, 0.48, 0.07]} /><meshStandardMaterial color="#18293a" emissive={theme.accent} emissiveIntensity={0.25} /></mesh>
      <mesh position={[0, 0.52, -0.38]}><boxGeometry args={[0.42, 0.025, 0.16]} /><meshStandardMaterial color="#192535" /></mesh>
    </group>)}
    <group>
      <mesh position={[0, 0.2, 0]}><boxGeometry args={[1.2, 0.4, 1.2]} /><meshStandardMaterial color={theme.desk} /></mesh>
      <mesh position={[0, 0.57, 0]}><boxGeometry args={[0.72, 0.36, 0.72]} /><meshStandardMaterial color={theme.accent} emissive={theme.accent} emissiveIntensity={0.2} /></mesh>
      <Html center position={[0, 1.02, 0]} zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}><div className="pixel-goal-label">🎯 目标 {goalPercent}%</div></Html>
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
    {agents.map(agent => {
      const station = stations.get(agent.key)
      if (!station) return null
      const celebrating = motion && liveCues.some(cue => cue.kind === 'completed' && cue.fromRole === agent.role)
      return <Employee3D key={agent.key} agent={agent} x={station.x} z={station.z} motion={motion} celebrate={celebrating} compact={agents.length > 12} onSelect={() => onAgentClick?.(agent.role)} />
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

export function Scene3D({ agents, cues, preset, goalPercent, motionEnabled = true, onAgentClick }: Scene3DProps): React.JSX.Element {
  const keys = agents.map(agent => agent.key).join('\n')
  const layout = useMemo(() => layoutScene(agents.map(agent => agent.key), preset), [keys, preset])
  const [available] = useState(webglAvailable)
  const [motionOn, setMotionOn] = useState(true)
  const [reduced, setReduced] = useState(false)
  const [visible, setVisible] = useState(true)
  const [, setCueTick] = useState(0)
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
    if (!cues.length) return
    const timer = window.setTimeout(() => setCueTick(value => value + 1), Math.max(0, Math.min(...cues.map(cue => cue.expiresAtMs)) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [cues])
  const motion = motionEnabled && motionOn && !reduced && visible
  const fallback = <div className="scene-webgl-fallback">3D 场景暂不可用，可从下面的员工列表查看任务。</div>
  return <div className="pixel-scene-content">
    <div className="pixel-scene-canvas">
      {available ? <SceneBoundary fallback={fallback}><Canvas orthographic shadows frameloop={motion ? 'always' : 'demand'} dpr={[1, 1.5]}>
        <OfficeWorld agents={agents} cues={cues} preset={preset} goalPercent={goalPercent} motion={motion} onAgentClick={onAgentClick} layout={layout} />
      </Canvas></SceneBoundary> : fallback}
    </div>
    <div className="pixel-scene-toolbar"><span>{PRESETS[preset].label} · {agents.length} 位员工</span>
      <button type="button" onClick={() => setMotionOn(value => !value)} aria-pressed={motionOn}>{motionOn ? '暂停动画' : '开启动画'}</button>
    </div>
    <SceneAgentList agents={agents} onAgentClick={onAgentClick} />
  </div>
}

export default Scene3D
