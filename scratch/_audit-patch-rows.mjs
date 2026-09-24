// scratch/_audit-patch-rows.mjs —— 列出 PATCH_LAYER_ROWS 的 id/module（**不提交**）
import { PATCH_LAYER_ROWS } from '../runtime/dsh-composition/patch-layer.mjs'
console.log(`共 ${PATCH_LAYER_ROWS.length} 行：`)
for (const r of PATCH_LAYER_ROWS) {
  console.log(`  ${r.id.padEnd(34)} plane=${String(r.plane).padEnd(9)} kind=${String(r.kind).padEnd(18)} ${r.module ?? ''}`)
}
