import { useMemo, useRef, useState } from 'react'
import { Html } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { SceneBoard } from '../scene/sceneLayout'
import { BOARD_COLUMNS, MOOD_STYLE, STATUS_STYLE, columnCounter, groupTasksByColumn } from '../scene/sceneBoard'
import type { BoardStaffRow, SceneBoardCard, SceneBoardVisit } from '../scene/sceneBoard'

/**
 * 微缩任务看板 —— 挂在后墙上的那块板，与办公室里那块真板子同构：
 * 五列（待办 / 进行中 / 待验收 / 受阻 / 完成）、卡片按状态着色、每列一个计数。
 *
 * ## 为什么卡片是"没有字的色块 + 悬浮才出字"
 *
 * 一块板上可能有上百张卡。给每张卡都挂一个 `Html`（drei 的 DOM 覆盖层）会让
 * 每帧同步上百个 DOM 节点 —— 3D 还跑得动，但在低配机器上滚动会明显掉帧，
 * 而掉帧没人会归因到"看板上的字太多"。
 *
 * 所以：**色块常驻**（几何体，几乎不要钱），**文字按需**（悬浮哪张看哪张，
 * 同时只有一个 tooltip）。要看某个人的全部任务，用他头顶的气泡（那里是"按人"看，
 * 这里是"按列"看，两个视角互补）。
 *
 * ## 认领/完结时会发生什么
 *
 * 走过来的那个人会碰的那张卡（`activeVisit.taskId`）会**高亮并脉动**：
 * 取卡时它闪着出现，贴卡时它闪着落到"完成"列。颜色就是它所在列的颜色 ——
 * 于是"他做了什么"不需要读文字也看得出来。
 */
export function TaskBoard3D({ cards, staff = [], names, board, activeVisit }: {
  /** 看板上的卡片（在办任务 + 归属人）。 */
  cards: readonly SceneBoardCard[]
  /** 按员工汇总（板底那一行）；缺省 ⇒ 只报"暂无/待认领"。 */
  staff?: readonly BoardStaffRow[]
  /** 岗位名 → 显示名（悬浮提示里把 `coder` 写成"编码工程师"）。 */
  names: ReadonlyMap<string, string>
  board: SceneBoard
  activeVisit?: SceneBoardVisit | null
}): React.JSX.Element {
  const tasks = cards
  const grouped = useMemo(() => groupTasksByColumn(tasks), [tasks])
  const [tip, setTip] = useState<{ id: string; title: string; status: SceneBoardCard['status']; role: string | null } | null>(null)
  const highlight = useRef<THREE.Mesh>(null)
  const columnWidth = board.width / BOARD_COLUMNS.length
  /** 一列最多画几张：再多就折成"+N"。★ 板子加高到 3.0 后放到 12 张。 */
  const maxCards = 12

  useFrame(({ clock }) => {
    if (!highlight.current) return
    // 脉动：让它在一片静态色块里"被看见"，而不是要求人去找哪一张变了
    const beat = 0.5 + Math.abs(Math.sin(clock.elapsedTime * 5)) * 0.5
    highlight.current.scale.setScalar(1 + beat * 0.18)
    const material = highlight.current.material as THREE.MeshStandardMaterial | undefined
    if (material) material.emissiveIntensity = 0.35 + beat * 0.9
  })

  return (
    <group position={[board.x, 0, board.z]}>
      {/* 边框与板面：板子本身要像一块挂在墙上的实体，而不是一张浮空的贴图 */}
      <mesh position={[0, board.y, 0.02]} castShadow>
        <boxGeometry args={[board.width + 0.22, board.height + 0.22, 0.09]} />
        <meshStandardMaterial color="#26364a" roughness={0.9} />
      </mesh>
      <mesh position={[0, board.y, 0.075]}>
        <boxGeometry args={[board.width, board.height, 0.04]} />
        <meshStandardMaterial color="#101a26" roughness={1} />
      </mesh>
      {/* 顶部横题 */}
      <Html position={[0, board.y + board.height / 2 + 0.26, 0.12]} center zIndexRange={[24, 0]} style={{ pointerEvents: 'none' }}>
        <div className="task-board-title">📋 任务看板 · {tasks.length} 项</div>
      </Html>
      {/* 两盏小射灯：把板面从背景里"抬"出来（几何体，不是真光源，避免再多两个 shadow map） */}
      {[-board.width / 3, board.width / 3].map(x => <mesh key={x} position={[x, board.y + board.height / 2 + 0.5, 0.3]}>
        <boxGeometry args={[0.5, 0.1, 0.16]} />
        <meshStandardMaterial color="#dfe9f5" emissive="#b9d8ff" emissiveIntensity={0.7} />
      </mesh>)}
      {BOARD_COLUMNS.map((column, index) => {
        const columnTasks = grouped.get(column.key) ?? []
        const x = -board.width / 2 + columnWidth * (index + 0.5)
        const accent = columnTasks[0] ? STATUS_STYLE[columnTasks[0].status].color : '#42546b'
        const shown = columnTasks.slice(0, maxCards)
        const top = board.y + board.height / 2 - 0.62
        return <group key={column.key} position={[x, 0, 0.1]}>
          {/* 列底：一格淡淡的竖条，让人一眼看出"板子分了五列" */}
          <mesh position={[0, board.y - 0.02, 0]}>
            <planeGeometry args={[columnWidth - 0.1, board.height - 0.5]} />
            <meshStandardMaterial color="#16222f" transparent opacity={0.85} />
          </mesh>
          <Html position={[0, board.y + board.height / 2 - 0.3, 0.06]} center zIndexRange={[24, 0]} style={{ pointerEvents: 'none' }}>
            <div className="task-board-column">
              <b style={{ color: accent }}>{column.label}</b>
              <i>{columnCounter(columnTasks, tasks.length)}</i>
            </div>
          </Html>
          {shown.map((task, cardIndex) => {
            const style = STATUS_STYLE[task.status]
            const y = top - cardIndex * 0.2
            const active = activeVisit?.taskId === task.id
            const who = task.role ? (names.get(task.role) ?? task.role) : null
            return <group key={task.id} position={[0, y, 0.05]}>
              <mesh
                onPointerOver={event => { event.stopPropagation(); setTip({ id: task.id, title: task.title, status: task.status, role: task.role }) }}
                onPointerOut={() => setTip(current => (current?.id === task.id ? null : current))}>
                <planeGeometry args={[columnWidth - 0.3, 0.16]} />
                <meshStandardMaterial color={style.color} emissive={style.color}
                  emissiveIntensity={active ? 0.9 : 0.22} roughness={0.7} />
              </mesh>
              {/*
                ★ 2026-10-14（"显示任务编号即可，悬停看完整内容" + "看板放大，可以标注具体编号"）：
                  卡片上只写**编号**；板子放大后列宽约 2.6，`T-123` 一眼可读。
                  编号是 DOM 覆盖层里的像素文字，`pointerEvents: 'none'` 让悬浮事件仍落在卡片网格上
                  （否则文字会挡住它自己的提示）。一列最多 12 张（`maxCards`）⇒ 全板最多 48 个文字节点，
                  这是"看得见编号"能接受的上限；再多应改成按列折叠，而不是继续加字。
              */}
              <Html position={[0, 0, 0.02]} center zIndexRange={[23, 0]} style={{ pointerEvents: 'none' }}>
                <span className="task-board-card-id" style={{ color: style.color }}>{task.id}</span>
              </Html>
              {/* 高亮框：只有"正被认领/完结"的那张卡才挂，且挂在同一个 group 里跟着走 */}
              {active && <mesh ref={highlight} position={[0, 0, -0.01]}>
                <planeGeometry args={[columnWidth - 0.2, 0.26]} />
                <meshStandardMaterial color={style.color} emissive={style.color} emissiveIntensity={0.8} transparent opacity={0.5} />
              </mesh>}
              {tip?.id === task.id && <Html position={[0, 0.24, 0.1]} center zIndexRange={[26, 0]} style={{ pointerEvents: 'none' }}>
                <div className="task-board-tip">
                  <b style={{ color: style.color }}>{style.label}</b> {task.id}
                  {/* 归属人：板子放大之后，"这张编号是谁的活"要能一眼看到 */}
                  <span className="task-board-tip-role">{who ?? '未认领'}</span>
                  <div className="task-board-tip-title">{task.title}</div>
                </div>
              </Html>}
            </group>
          })}
          {columnTasks.length > shown.length && <Html position={[0, top - shown.length * 0.2 - 0.06, 0.06]} center zIndexRange={[24, 0]} style={{ pointerEvents: 'none' }}>
            <div className="task-board-column"><i>+{columnTasks.length - shown.length}</i></div>
          </Html>}
        </group>
      })}
      {/*
        ★ 2026-10-14（"任务看板 0项统计可以固定在场景顶部，不随场景旋转"）：
          板底这一行从"每列计数"改成**按员工汇总**（谁身上几件）——列计数已经写在每列抬头里，
          同一份数字写两遍、改一处就会不一致。屏幕上那条不随旋转的读数在 `BoardStatusBar`。
      */}
      <Html position={[0, board.y - board.height / 2 - 0.3, 0.12]} center zIndexRange={[24, 0]} style={{ pointerEvents: 'none' }}>
        <div className="task-board-footer">
          {activeVisit
            ? `${activeVisit.kind === 'claim' ? '🫳 取卡' : '✅ 贴卡'} · ${activeVisit.taskId} · ${activeVisit.title}`
            : staff.length === 0
              ? (tasks.length === 0 ? '暂无在办任务' : `${tasks.length} 项待认领`)
              : staff.slice(0, 4).map(row => <span className="task-board-footer-staff" key={row.role}>
                <i style={{ background: MOOD_STYLE[row.mood].color }} />{row.name} {row.total}
              </span>)}
        </div>
      </Html>
    </group>
  )
}

export default TaskBoard3D
