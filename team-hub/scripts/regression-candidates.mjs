#!/usr/bin/env node
// team-hub/scripts/regression-candidates.mjs
// ============================================================================
// F9 · 失败聚类 CLI（设计稿 §8.4 / M7-1）
//
//   node team-hub/scripts/regression-candidates.mjs [--since=ISO] [--top=5] [--save]
//
// 默认**只读**（打印 top 失败簇）；加 `--save` 才落 `regression_cases` 草稿。
// 落下来的草稿一律是 `draft` —— 晋升成 active 必须由人（I-9.1），这条不在这里开口子。
// ============================================================================
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

import { ensureDecisionSchema } from '../decisions.mjs'
import {
  ensureRegressionSchema,
  clusterFailures,
  draftCaseFor,
  saveDraft,
} from '../regression-store.mjs'

const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? null : hit.slice(`--${name}=`.length)
}

const dbFile = argOf('db') ?? process.env.TEAM_HUB_DB ?? join(process.cwd(), 'team.db')
const since = argOf('since')
const top = Number(argOf('top') ?? 5)
const save = process.argv.includes('--save')

const db = new DatabaseSync(dbFile)
try {
  // 只建缺失的表；不改任何既有数据
  ensureDecisionSchema(db)
  ensureRegressionSchema(db)

  const clusters = clusterFailures(db, { since }).slice(0, Math.max(1, top))
  const drafts = []
  if (save) {
    for (const cluster of clusters) {
      const draft = saveDraft(db, draftCaseFor(cluster))
      drafts.push({ id: draft.id, clusterKey: draft.cluster_key, state: draft.state })
    }
  }
  process.stdout.write(JSON.stringify({
    db: dbFile,
    since: since ?? null,
    saved: save,
    clusters: clusters.map((c) => ({
      clusterKey: c.clusterKey, count: c.count, samples: c.samples.slice(0, 5), reason: c.reason,
    })),
    drafts,
    at: new Date().toISOString(),
  }, null, 2) + '\n')
} catch (error) {
  process.stderr.write(`regression-candidates 失败：${error?.message ?? error}\n`)
  process.exitCode = 1
} finally {
  try { db.close() } catch { /* 已关闭 */ }
}
