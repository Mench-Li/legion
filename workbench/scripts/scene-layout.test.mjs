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
