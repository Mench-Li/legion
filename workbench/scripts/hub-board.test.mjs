import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { boardFromHubTasks } from '../src/hubBoard.ts'

describe('team-hub v2 → Workbench BoardData 投影', () => {
  it('按状态映射任务列并计算 KPI 总数，不依赖 v1 board.json', () => {
    const board = boardFromHubTasks([
      { id: 'T-1', title: '进行中', description: '', acceptance: [], priority: 'high', status: 'in_progress', version: 1, soldier: 'coder', role: 'coder', blocks: [], blockedBy: [], comments: [], evidence: [], patches: [], artifacts: [] },
      { id: 'T-2', title: '已完成', description: '', acceptance: [], priority: 'medium', status: 'done', version: 1, soldier: 'tester', role: 'tester', blocks: [], blockedBy: [], comments: [], evidence: [], patches: [], artifacts: [] },
    ])
    assert.equal(board.totals.total, 2)
    assert.equal(board.totals.open, 1)
    assert.equal(board.totals.done, 1)
    assert.equal(board.columns.find(c => c.id === 'in_progress').cards[0].id, 'T-1')
    assert.equal(board.columns.find(c => c.id === 'done').cards[0].id, 'T-2')
  })
})
