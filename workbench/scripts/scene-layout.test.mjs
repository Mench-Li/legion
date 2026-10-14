import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutScene, framingZoom } from '../src/scene/sceneLayout.ts'

for (const count of [0, 1, 8, 12, 24]) {
  test(`${count} 名员工工位唯一且全部位于地板内`, () => {
    const keys = Array.from({ length: count }, (_, i) => `lab\0agent-${i}`)
    const layout = layoutScene(keys, 'office')
    assert.equal(layout.stations.length, count)
    assert.equal(new Set(layout.stations.map(station => `${station.x},${station.z}`)).size, count)
    for (const station of layout.stations) {
      assert.ok(Math.abs(station.x) < layout.floorWidth / 2 - 0.5)
      assert.ok(Math.abs(station.z) < layout.floorDepth / 2 - 0.5)
    }
    assert.ok(layout.camera.distance > 0)
  })
}

test('12 人双排，24 人扩展排数；任务状态无关且工位稳定', () => {
  const keys = Array.from({ length: 24 }, (_, i) => String(i))
  const twelve = layoutScene(keys.slice(0, 12), 'lab')
  const many = layoutScene(keys, 'lab')
  assert.equal(new Set(twelve.stations.map(station => station.z)).size, 2)
  assert.ok(new Set(many.stations.map(station => station.z)).size > 2)
  assert.deepEqual(layoutScene(keys, 'lab').stations, many.stations)
  assert.ok(many.floorDepth > twelve.floorDepth)
})

// ── 看板（微缩进场景的那一块）的几何约束 ────────────────────────────────────
// 这三条守的是"人走过去会不会走出地板/撞到桌子/半个身子插进墙里"：
// 板子放错位置不会报错，只会让人**走到房间外面**或**站在同事桌子里**。
for (const count of [0, 1, 8, 12, 24]) {
  test(`${count} 人：看板在地板内、在最后一排工位之后、人站得下`, () => {
    const keys = Array.from({ length: count }, (_, i) => `lab\0agent-${i}`)
    const layout = layoutScene(keys, 'office')
    const board = layout.board
    assert.ok(board.width > 0 && board.height > 0, '板子得有面积')
    // ① 板面完全在地板内（左右各留出墙厚，不然板子会插进侧墙）
    assert.ok(Math.abs(board.x) + board.width / 2 < layout.floorWidth / 2 - layout.dressing.wallThickness)
    assert.ok(Math.abs(board.z) < layout.floorDepth / 2, '板子必须在地板深度以内')
    // ② 在**最后一排工位之后**（留 1.5 以上）：人转身不该撞到同事的桌子
    const backMost = Math.min(...layout.stations.map(station => station.z))
    assert.ok(board.z < backMost - 1.5, `看板 z=${board.z} 应明显在最后一排工位 z=${backMost} 之后`)
    // ③ 人站的位置在板子**前面**（更大的 z）且仍在地板内
    assert.ok(board.standZ > board.z, '人是站到板前，不是站进墙里')
    assert.ok(board.standZ < layout.floorDepth / 2 - 0.5, '站的位置也得在地板内')
    // ④ 站立点与所有梯位的落点不重合（否则会有"人叠人"）
    for (const station of layout.stations) {
      assert.ok(Math.abs(station.z - board.standZ) > 0.35 || Math.abs(station.x - board.x) > board.width / 2 + 0.35,
        '看板前的落脚点不许压在别人的梯位上')
    }
    assert.ok(board.y > 0.8 && board.y < layout.dressing.wallHeight, '板面高度在墙内、也在可读高度上')
  })
}

// ══════════════════════════════════════════════════════════════════════════
// 空间与取景（将军 2026-10-14：「确保办公室场景有足够的空间展示」）
//
// 这条要求有两个落点，各有一组判据：
//   ① **房间够大**：工位之外的余量要装得下布景（看板、两侧书架/茶水台、前面会议桌+椅子）；
//   ② **取景够远**：整个房间（含墙高）要带边距地落进画布。
// ②是原来埋在 `CameraRig` 里的一行算式，搬出来成 `framingZoom` 之后才测得到。
// ══════════════════════════════════════════════════════════════════════════

test('★ 房间给布景留了余量：四周至少各留 3（不再是"刚好裹住桌椅"的 1.75）', () => {
  for (const count of [0, 8, 12, 24]) {
    const keys = Array.from({ length: count }, (_, i) => String(i))
    const layout = layoutScene(keys, 'office')
    const minX = Math.min(0, ...layout.stations.map(station => station.x))
    const maxX = Math.max(0, ...layout.stations.map(station => station.x))
    const minZ = Math.min(0, ...layout.stations.map(station => station.z))
    const maxZ = Math.max(0, ...layout.stations.map(station => station.z))
    assert.ok(minX - (-layout.floorWidth / 2) >= 3, `${count} 人：左侧余量不足（书架/茶水台放不下）`)
    assert.ok(layout.floorWidth / 2 - maxX >= 3, `${count} 人：右侧余量不足`)
    // 后侧要装下看板 + 板前的落脚点，前侧要装下会议桌与其一圈椅子（半径 1.72）
    assert.ok(minZ - (-layout.floorDepth / 2) >= 3.2, `${count} 人：后侧余量不足（看板放不下）`)
    assert.ok(layout.floorDepth / 2 - maxZ >= 3.5, `${count} 人：前侧余量不足（会议桌 + 椅子放不下）`)
  }
})

test('★ 取景：画面里的世界尺寸必须 ≥ 房间尺寸（整间屋子都要在画里）', () => {
  // 三档画布：宽扁（面板矮）、窄高、以及收起员工列表之后变高的那一档
  const canvases = [
    { width: 1200, height: 420, note: '宽扁' },
    { width: 700, height: 300, note: '窄小' },
    { width: 1200, height: 560, note: '收起员工列表后' },
  ]
  for (const count of [0, 12, 24]) {
    const keys = Array.from({ length: count }, (_, i) => String(i))
    const layout = layoutScene(keys, 'office')
    for (const canvas of canvases) {
      const zoom = framingZoom(canvas, layout)
      const visibleWidth = canvas.width / zoom
      const visibleHeight = canvas.height / zoom
      assert.ok(zoom >= 11, `${count} 人/${canvas.note}：缩放低于下限（房间会被撑出画面）`)
      assert.ok(visibleWidth >= layout.floorWidth, `${count} 人/${canvas.note}：横向装不下（可见 ${visibleWidth.toFixed(1)} < 房间 ${layout.floorWidth.toFixed(1)}）`)
      // 垂直方向：相机是斜俯视，地板深度被压缩约 0.8；墙高要占上方 ⇒ 两边相抵后的预算
      assert.ok(visibleHeight >= layout.floorDepth * 0.8,
        `${count} 人/${canvas.note}：纵向装不下（可见 ${visibleHeight.toFixed(1)} < 需要 ${(layout.floorDepth * 0.8).toFixed(1)}）`)
    }
  }
})

test('★ 取景是单调的：画布越大越近（缩小或放大都不会突然反转）', () => {
  const layout = layoutScene(Array.from({ length: 12 }, (_, i) => String(i)), 'office')
  const small = framingZoom({ width: 700, height: 300 }, layout)
  const large = framingZoom({ width: 1400, height: 600 }, layout)
  assert.ok(large > small, '画布变大 ⇒ 缩放应变大（看得更近）')
  // 同一个画布上，人越多房间越大 ⇒ 缩放不能更大（不然会挤）
  const few = framingZoom({ width: 1200, height: 420 }, layoutScene(['a'], 'office'))
  const many = framingZoom({ width: 1200, height: 420 }, layoutScene(Array.from({ length: 24 }, (_, i) => String(i)), 'office'))
  assert.ok(many <= few, '房间变大 ⇒ 取景不能更近')
})
