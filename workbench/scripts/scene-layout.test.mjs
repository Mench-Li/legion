import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutScene } from '../src/scene/sceneLayout.ts'

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
