import { useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { SceneLayout } from '../scene/sceneLayout'
import type { SceneTheme } from '../scene/sceneTheme'

/**
 * 办公室布景 —— 让"3D 场景"看起来真的是一间办公室，而不是一块地板加几张桌子。
 *
 * ## 一条硬约束：布景**不许**碰工位与人
 *
 * 所有家具的位置都从 `layout` 推导，并且只落在两个**安全带**里：
 *
 *   · **后带**（最后一排工位之后、后墙之前）：看板、绿植、后墙装饰；
 *   · **前带**（最后一排工位之前 ≥1.9）：地毯、会议桌、边角绿植；
 *   · **两侧贴墙**（x 靠到墙根）：书架、文件柜、茶水角。
 *
 * 工位由 `layoutScene` 按编队顺序固定，布景**只读不写**。任何"看着好看就往前挪一点"
 * 的改动都会撞进工位 —— 而那种碰撞不会报错，只会让人物穿模，且只在某个特定人数下出现。
 *
 * ## 为什么全是几何体、没有模型文件
 *
 * 一条 `boxGeometry` 几乎不要钱，而引入 `.glb` 资产要处理加载/缓存/失败降级三件事，
 * 且会让首屏多一个网络往返。这里的取向是：**用体块与色号把"办公室"讲清楚**，
 * 与既有的像素员工（`Employee3D`）是同一套语言。
 */
export function OfficeDressing({ layout, theme }: { layout: SceneLayout; theme: SceneTheme }): React.JSX.Element {
  const g = useMemo(() => {
    const { floorWidth, floorDepth, dressing, board } = layout
    const half = { x: floorWidth / 2, z: floorDepth / 2 }
    const stationZ = layout.stations.map(station => station.z)
    const backRow = stationZ.length > 0 ? Math.min(...stationZ) : -floorDepth / 4
    const frontRow = stationZ.length > 0 ? Math.max(...stationZ) : floorDepth / 4
    // 前带中心：在最后一排工位前面留 1.9，且不越出地板
    const front = Math.min(half.z - 1.5, frontRow + 2.1)
    return {
      half, dressing, board, front, backRow,
      // 贴墙家具的 x：从墙根往里 0.45（墙厚之外），保证不与最外侧工位争夺同一块地
      leftX: -half.x + dressing.wallThickness + 0.3,
      rightX: half.x - dressing.wallThickness - 0.3,
    }
  }, [layout])

  const { wall, wallTrim, wood, metal, plant, glass, rug, accent } = theme
  const { floorWidth, floorDepth, dressing, board } = layout
  const { half, front } = g

  /** 一盏吊灯：灯杆 + 灯罩（发光的那个面朝下）。 */
  const Lamp = ({ x, z }: { x: number; z: number }): React.JSX.Element => <group position={[x, 0, z]}>
    <mesh position={[0, dressing.wallHeight - 0.35, 0]}><boxGeometry args={[0.05, 0.7, 0.05]} /><meshStandardMaterial color={metal} /></mesh>
    <mesh position={[0, dressing.wallHeight - 0.72, 0]}><boxGeometry args={[0.78, 0.1, 0.5]} /><meshStandardMaterial color={wallTrim} /></mesh>
    <mesh position={[0, dressing.wallHeight - 0.79, 0]}><boxGeometry args={[0.66, 0.04, 0.4]} /><meshStandardMaterial color={glass} emissive={glass} emissiveIntensity={0.85} /></mesh>
  </group>

  /** 一盆绿植：陶盆 + 两三丛叶子。 */
  const Plant = ({ x, z, scale = 1 }: { x: number; z: number; scale?: number }): React.JSX.Element => <group position={[x, 0, z]} scale={scale}>
    <mesh position={[0, 0.2, 0]} castShadow><boxGeometry args={[0.44, 0.4, 0.44]} /><meshStandardMaterial color={wood} /></mesh>
    <mesh position={[0, 0.62, 0]} castShadow><boxGeometry args={[0.62, 0.46, 0.62]} /><meshStandardMaterial color={plant} flatShading /></mesh>
    <mesh position={[0.16, 0.94, -0.1]} rotation={[0, 0.4, 0]}><boxGeometry args={[0.34, 0.3, 0.34]} /><meshStandardMaterial color={plant} flatShading /></mesh>
  </group>

  /** 椅子：坐面 + 靠背 + 四条腿。`facing` 让它朝向桌子中心。 */
  const Chair = ({ x, z, facing }: { x: number; z: number; facing: number }): React.JSX.Element => <group position={[x, 0, z]} rotation={[0, facing, 0]}>
    <mesh position={[0, 0.46, 0]} castShadow><boxGeometry args={[0.42, 0.08, 0.42]} /><meshStandardMaterial color={metal} /></mesh>
    <mesh position={[0, 0.72, -0.2]}><boxGeometry args={[0.42, 0.42, 0.07]} /><meshStandardMaterial color={metal} /></mesh>
    {[[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]].map(([dx, dz]) => <mesh key={`${dx},${dz}`} position={[dx, 0.22, dz]}>
      <boxGeometry args={[0.05, 0.44, 0.05]} /><meshStandardMaterial color="#2b3742" />
    </mesh>)}
  </group>

  const wallX = half.x + dressing.wallThickness / 2
  const wallZ = half.z + dressing.wallThickness / 2
  const walls = {
    back: useRef<THREE.Mesh>(null), front: useRef<THREE.Mesh>(null),
    left: useRef<THREE.Mesh>(null), right: useRef<THREE.Mesh>(null),
  }
  useFrame(({ camera }) => {
    const show = (ref: RefObject<THREE.Mesh | null>, visible: boolean): void => {
      if (ref.current && ref.current.visible !== visible) ref.current.visible = visible
    }
    // 相机在墙的哪一侧，就隐去哪一面（阈值 12% 房间尺寸，避免俯视时反复闪）
    show(walls.back, camera.position.z > -half.z * 0.12)
    show(walls.front, camera.position.z < half.z * 0.12)
    show(walls.left, camera.position.x > -half.x * 0.12)
    show(walls.right, camera.position.x < half.x * 0.12)
  })

  return <group>
    {/* ── 墙与踢脚 ─────────────────────────────────────────────────────────
        ★ 剖视（cutaway）：相机背后的墙**自动隐去**。这不是偷懒 —— 相机在 +x/+z 一侧
        俯视，若四面墙都实心，靠相机那两面就会把整个房间挡在外面（画面上只剩一堵墙）。
        做法是每帧看相机在墙的哪一侧：站错边的墙隐去，于是绕到任何角度都能看进房间。
        （只调 `visible`，不重建几何体；阈值取房间尺寸的 12%，避免正上方时来回闪。） */}
    <mesh ref={walls.back} position={[0, dressing.wallHeight / 2, -wallZ]} receiveShadow>
      <boxGeometry args={[floorWidth + dressing.wallThickness * 2, dressing.wallHeight, dressing.wallThickness]} />
      <meshStandardMaterial color={wall} roughness={1} />
    </mesh>
    <mesh ref={walls.front} position={[0, dressing.wallHeight / 2, wallZ]} receiveShadow>
      <boxGeometry args={[floorWidth + dressing.wallThickness * 2, dressing.wallHeight, dressing.wallThickness]} />
      <meshStandardMaterial color={wall} roughness={1} />
    </mesh>
    <mesh ref={walls.left} position={[-wallX, dressing.wallHeight / 2, 0]} receiveShadow>
      <boxGeometry args={[dressing.wallThickness, dressing.wallHeight, floorDepth]} />
      <meshStandardMaterial color={wall} roughness={1} />
    </mesh>
    <mesh ref={walls.right} position={[wallX, dressing.wallHeight / 2, 0]} receiveShadow>
      <boxGeometry args={[dressing.wallThickness, dressing.wallHeight, floorDepth]} />
      <meshStandardMaterial color={wall} roughness={1} />
    </mesh>
    <mesh position={[0, 0.14, -half.z + 0.04]}><boxGeometry args={[floorWidth, 0.28, 0.08]} /><meshStandardMaterial color={wallTrim} /></mesh>

    {/* ── 后墙装饰：挂钟、门、两侧标语（都不许压到看板） ───────────────────── */}
    <group position={[-Math.max(board.width / 2 + 1.35, half.x - 1.5), 3.25, -half.z + 0.14]}>
      <mesh rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.3, 0.3, 0.07, 16]} /><meshStandardMaterial color="#dbe6f2" /></mesh>
      <mesh position={[0, 0.08, 0.06]}><boxGeometry args={[0.03, 0.18, 0.02]} /><meshStandardMaterial color="#25313f" /></mesh>
      <mesh position={[0.07, 0, 0.06]} rotation={[0, 0, Math.PI / 2]}><boxGeometry args={[0.03, 0.14, 0.02]} /><meshStandardMaterial color="#25313f" /></mesh>
    </group>
    {board.width / 2 + 0.75 < half.x - 1.0 && <group position={[half.x - 1.35, 1.15, -half.z + 0.12]}>
      <mesh><boxGeometry args={[1.0, 2.3, 0.08]} /><meshStandardMaterial color="#2a3d4f" /></mesh>
      <mesh position={[0.42, 0.1, 0.06]}><boxGeometry args={[0.07, 0.07, 0.05]} /><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.6} /></mesh>
    </group>}
    {[-1, 1].map(side => <group key={side} position={[side * Math.max(board.width / 2 + 1.4, half.x - 2.5), 2.35, -half.z + 0.1]}>
      <mesh><boxGeometry args={[1.15, 0.85, 0.06]} /><meshStandardMaterial color={wallTrim} /></mesh>
      <mesh position={[0, 0, 0.04]}><boxGeometry args={[1.0, 0.7, 0.02]} /><meshStandardMaterial color={side > 0 ? accent : glass} emissive={side > 0 ? accent : glass} emissiveIntensity={0.18} /></mesh>
    </group>)}

    {/* ── 侧墙的窗（自然光从两侧进来，不跟后墙的看板抢位置） ───────────────── */}
    {[-1, 1].map(side => [-2.5, 2.5].map(z => <group key={`${side}:${z}`} position={[side * (half.x - 0.02), 2.7, z]}>
      <mesh rotation={[0, side * Math.PI / 2, 0]}><boxGeometry args={[1.9, 1.35, 0.06]} /><meshStandardMaterial color={wallTrim} /></mesh>
      <mesh position={[side * -0.04, 0, 0]} rotation={[0, side * Math.PI / 2, 0]}>
        <boxGeometry args={[1.7, 1.15, 0.03]} />
        <meshStandardMaterial color={glass} emissive={glass} emissiveIntensity={0.6} />
      </mesh>
      {/* 光柱：把"光是从窗户来的"讲出来（半透明面片，不参与阴影，几乎不要钱） */}
      <mesh position={[side * -1.6, -1.0, 0]} rotation={[0, 0, side * 0.5]}>
        <planeGeometry args={[1.5, 2.6]} />
        <meshBasicMaterial color={glass} transparent opacity={0.06} side={THREE.DoubleSide} />
      </mesh>
    </group>))}

    {/* ── 吊灯 ───────────────────────────────────────────────────────────── */}
    {[-floorWidth / 4, floorWidth / 4].map(x => [-floorDepth / 4, floorDepth / 4].map(z => <Lamp key={`${x}:${z}`} x={x} z={z} />))}

    {/* ── 后带：看板两侧的绿植（与看板同一带，视觉上把板子"框"起来） ────────── */}
    {[-1, 1].map(side => <Plant key={side} x={side * (board.width / 2 + 0.55)} z={board.z + 0.8} scale={0.95} />)}

    {/* ── 前带：地毯 + 会议桌 + 椅子 ─────────────────────────────────────── */}
    <mesh position={[0, 0.012, front]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[4.6, 3.1]} /><meshStandardMaterial color={rug} roughness={1} />
    </mesh>
    <mesh position={[0, 0.02, front]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[4.1, 2.6]} /><meshStandardMaterial color={wallTrim} roughness={1} />
    </mesh>
    <group position={[0, 0, front]}>
      <mesh position={[0, 0.74, 0]} castShadow><cylinderGeometry args={[1.05, 1.05, 0.1, 20]} /><meshStandardMaterial color={wood} /></mesh>
      <mesh position={[0, 0.36, 0]}><cylinderGeometry args={[0.14, 0.18, 0.72, 12]} /><meshStandardMaterial color={metal} /></mesh>
      {/* 桌上：一台笔记本 + 两份文件（会议桌得看得出"在用"） */}
      <mesh position={[0.28, 0.83, -0.16]} rotation={[0, -0.5, 0]}><boxGeometry args={[0.42, 0.26, 0.03]} /><meshStandardMaterial color="#1b2836" emissive={accent} emissiveIntensity={0.35} /></mesh>
      <mesh position={[-0.34, 0.8, 0.18]} rotation={[0, 0.4, 0]}><boxGeometry args={[0.3, 0.02, 0.22]} /><meshStandardMaterial color="#e6eef7" /></mesh>
      {[0, 1, 2, 3, 4, 5].map(index => {
        const angle = (index / 6) * Math.PI * 2
        return <Chair key={index} x={Math.sin(angle) * 1.72} z={Math.cos(angle) * 1.72} facing={Math.atan2(-Math.sin(angle), -Math.cos(angle))} />
      })}
    </group>

    {/* ── 两侧贴墙家具：书架 + 文件柜（左）、茶水角 + 饮水机（右） ───────────── */}
    <group position={[g.leftX, 0, 0.2]}>
      <mesh position={[0, 0.95, 0]} castShadow><boxGeometry args={[0.5, 1.9, 1.9]} /><meshStandardMaterial color={wood} /></mesh>
      {[0.5, 0.95, 1.4].map(y => <mesh key={y} position={[0.02, y, 0]}><boxGeometry args={[0.44, 0.05, 1.8]} /><meshStandardMaterial color={wallTrim} /></mesh>)}
      {/* 书：一排小色块，最省的做法让"书架上真的有书" */}
      {[-0.78, -0.5, -0.2, 0.14, 0.44, 0.72].map((z, index) => <mesh key={z} position={[0.08, [0.66, 1.11, 1.56][index % 3], z]}>
        <boxGeometry args={[0.22, 0.3, 0.14]} />
        <meshStandardMaterial color={['#c8705f', '#5f8fc8', '#c8b25f', '#7fc8a5', '#a97fc8', '#5fc8c0'][index % 6]} />
      </mesh>)}
    </group>
    <group position={[g.leftX, 0, -2.1]}>
      <mesh position={[0, 0.5, 0]} castShadow><boxGeometry args={[0.5, 1.0, 1.2]} /><meshStandardMaterial color={metal} /></mesh>
      {[-0.32, 0.32].map(y => <mesh key={y} position={[0.27, 0.5 + y, 0]}><boxGeometry args={[0.03, 0.06, 0.7]} /><meshStandardMaterial color="#2b3742" /></mesh>)}
    </group>
    <group position={[g.rightX, 0, -0.4]}>
      <mesh position={[0, 0.45, 0]} castShadow><boxGeometry args={[0.55, 0.9, 2.4]} /><meshStandardMaterial color={wood} /></mesh>
      <mesh position={[-0.3, 0.45, 0]}><boxGeometry args={[0.03, 0.86, 2.36]} /><meshStandardMaterial color={wallTrim} /></mesh>
      {/* 咖啡机 + 杯子 */}
      <mesh position={[-0.02, 1.05, -0.6]}><boxGeometry args={[0.34, 0.4, 0.34]} /><meshStandardMaterial color="#2b3742" /></mesh>
      <mesh position={[-0.2, 0.98, -0.6]}><boxGeometry args={[0.03, 0.14, 0.2]} /><meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.5} /></mesh>
      {[-0.15, 0.1, 0.35].map(z => <mesh key={z} position={[-0.08, 0.96, z]}><cylinderGeometry args={[0.06, 0.05, 0.1, 10]} /><meshStandardMaterial color="#e6eef7" /></mesh>)}
    </group>
    <group position={[g.rightX, 0, 1.6]}>
      <mesh position={[0, 0.5, 0]} castShadow><boxGeometry args={[0.42, 1.0, 0.42]} /><meshStandardMaterial color={metal} /></mesh>
      <mesh position={[0, 1.28, 0]}><cylinderGeometry args={[0.17, 0.2, 0.56, 14]} /><meshStandardMaterial color={glass} emissive={glass} emissiveIntensity={0.25} transparent opacity={0.85} /></mesh>
      <mesh position={[-0.24, 0.62, 0]}><boxGeometry args={[0.05, 0.1, 0.14]} /><meshStandardMaterial color={accent} /></mesh>
    </group>

    {/* ── 前带两角的绿植（把前景也"住"起来，否则近处是空的） ───────────────── */}
    {[-1, 1].map(side => <Plant key={`front${side}`} x={side * (half.x - 0.95)} z={front + 1.25} scale={1.05} />)}
  </group>
}

export default OfficeDressing
