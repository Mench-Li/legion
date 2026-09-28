import { useEffect, useMemo, useRef, useState } from 'react'
import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { SceneAgent } from '../scene/sceneState'

const BOX = new THREE.BoxGeometry(1, 1, 1)
const PALETTES = ['#4e84be', '#9472bd', '#44a99c', '#cf8764', '#7d9b60', '#b47197']
const STATUS = { idle: '#5b8cff', busy: '#40ffa0', review: '#ffd54a', blocked: '#ff5c5c' }
const LABEL = { idle: '待命', busy: '进行中', review: '待验收', blocked: '受阻' }

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

export function Employee3D({ agent, x, z, motion, celebrate, compact, onSelect }: {
  agent: SceneAgent; x: number; z: number; motion: boolean; celebrate: boolean; compact: boolean; onSelect: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const root = useRef<THREE.Group>(null)
  const leftArm = useRef<THREE.Mesh>(null)
  const rightArm = useRef<THREE.Mesh>(null)
  const previousMode = useRef(agent.mode)
  const walkStart = useRef<number | null>(null)
  const face = useMemo(faceTexture, [])
  const tone = agent.external ? '#586879' : PALETTES[agent.appearanceSeed % PALETTES.length]
  const shirt = useMemo(() => shirtTexture(tone), [tone])
  const status = STATUS[agent.mode]
  useEffect(() => () => face.dispose(), [face])
  useEffect(() => () => shirt.dispose(), [shirt])
  useEffect(() => {
    if (previousMode.current === 'idle' && agent.mode === 'busy' && motion) walkStart.current = performance.now()
    previousMode.current = agent.mode
  }, [agent.mode, motion])
  useEffect(() => {
    if (motion) return
    if (root.current) root.current.position.set(0, 0, 0)
    if (leftArm.current) leftArm.current.rotation.x = 0
    if (rightArm.current) rightArm.current.rotation.x = 0
  }, [motion])
  useEffect(() => () => { document.body.style.cursor = '' }, [])
  useFrame(({ clock }) => {
    if (!motion || !root.current) return
    const t = clock.elapsedTime * 2 + (agent.appearanceSeed % 11)
    const working = agent.mode === 'busy'
    if (walkStart.current !== null) {
      const progress = Math.min(1, (performance.now() - walkStart.current) / 750)
      root.current.position.z = (1 - progress) * 0.8
      if (progress === 1) walkStart.current = null
    } else root.current.position.z = 0
    root.current.position.y = celebrate ? Math.abs(Math.sin(t * 3)) * 0.24 : working ? Math.sin(t * 2) * 0.018 : Math.sin(t) * 0.025
    if (leftArm.current) leftArm.current.rotation.x = celebrate ? Math.sin(t * 4) * 0.6 - 0.6 : working ? Math.sin(t * 2) * 0.22 : 0
    if (rightArm.current) rightArm.current.rotation.x = celebrate ? -Math.sin(t * 4) * 0.6 - 0.6 : working ? -Math.sin(t * 2) * 0.22 : agent.mode === 'blocked' ? -0.45 : 0
  })
  const part = (key: string, color: string, position: [number, number, number], scale: [number, number, number]) => (
    <mesh key={key} geometry={BOX} position={position} scale={scale} castShadow>
      <meshStandardMaterial color={color} roughness={1} flatShading />
    </mesh>
  )
  return (
    <group position={[x, 0, z]} dispose={null}
      onClick={event => { event.stopPropagation(); onSelect() }}
      onPointerOver={event => { event.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
      onPointerOut={event => { event.stopPropagation(); setHovered(false); document.body.style.cursor = '' }}>
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
        {part('left-leg', '#24364c', [-0.17, 0.23, 0], [0.2, 0.46, 0.25])}
        {part('right-leg', '#24364c', [0.17, 0.23, 0], [0.2, 0.46, 0.25])}
        {part('left-shoe', '#172130', [-0.17, 0.055, 0.08], [0.23, 0.11, 0.34])}
        {part('right-shoe', '#172130', [0.17, 0.055, 0.08], [0.23, 0.11, 0.34])}
        {agent.external && part('temporary', '#f1c766', [0, 1.17, 0.18], [0.25, 0.08, 0.03])}
        {part('tool', agent.mode === 'review' ? '#f1c766' : '#98c6d9', [0.52, 0.57, 0.16], [0.12, 0.28, 0.05])}
        {agent.mode === 'review' && part('review-sheet', '#ffe19a', [0.52, 0.75, 0.24], [0.34, 0.4, 0.035])}
        {agent.mode === 'blocked' && part('help-sign', '#ff6b6b', [0, 2.03, 0], [0.14, 0.28, 0.08])}
      </group>
      {(!compact || hovered) && <Html position={[0, 2.09, 0]} center zIndexRange={[30, 0]}>
        <button className={`pixel-employee-label ${hovered ? 'expanded' : ''}`} onClick={event => { event.stopPropagation(); onSelect() }}
          title={`${agent.name} · ${LABEL[agent.mode]} · ${agent.focusTitle ?? '暂无任务'}`}>
          <strong>{agent.name.length > 6 ? `${agent.name.slice(0, 5)}…` : agent.name}</strong><span style={{ color: status }}>◆</span>
          {hovered && <small>{agent.name} · {LABEL[agent.mode]} · {agent.focusTitle ?? '暂无任务'} · {agent.taskCount} 项</small>}
        </button>
      </Html>}
    </group>
  )
}
