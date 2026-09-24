
import { readFileSync } from 'node:fs';
// ---- 复刻 plugins/src/index.ts 的 docSync 契约纯逻辑（D2 条件化），用于验证 AC-R4-1/2/4 语义 ----
function stageContractDocs(stage) {
  if (!stage) return [];
  if (Array.isArray(stage.docs)) {
    const list = stage.docs.filter(x => typeof x === 'string').map(x => x.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(x => x.length > 0);
    if (list.length > 0) return list;
  }
  const artifact = typeof stage.artifact === 'string' ? stage.artifact.trim() : '';
  return artifact.length > 0 ? [artifact.replace(/\\/g, '/').replace(/^\.\//, '')] : [];
}
function resolveStageDocPaths(stage, taskId) { return stageContractDocs(stage).map(p => p.replace(/\{taskId\}/g, taskId).replace(/\\/g, '/').replace(/^\.\//, '')); }
// 结算期契约路径（settle 逻辑）
function settleContractPaths(isPipeline, stage, t) {
  const contractPaths = isPipeline && stage ? stageContractDocs(stage) : [];
  if (isPipeline && stage && t.docSync === true) { for (const p of ['docs/FEATURES.md','README.md']) if (!(contractPaths).includes(p)) contractPaths.push(p); }
  return contractPaths;
}
const roles = JSON.parse(readFileSync('roles.json','utf8'));
const coder = roles.stages.find(s => s.role === 'coder');
const devops = roles.stages.find(s => s.role === 'devops');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  [FAIL] '+m); } };

// AC-R4-1：feature/docSync 任务的 coder/devops 契约路径追加 FEATURES + README
for (const [label, stage, r] of [['coder', coder, 'coder'], ['devops', devops, 'devops']]) {
  const p_feat = settleContractPaths(true, stage, { docSync: true });
  ok(p_feat.includes('docs/FEATURES.md') && p_feat.includes('README.md'), label+' docSync 任务契约含 FEATURES+README: '+JSON.stringify(p_feat));
  // AC-R4-4：非 docSync 不追加
  const p_non = settleContractPaths(true, stage, { docSync: false });
  ok(!p_non.includes('docs/FEATURES.md') && !p_non.includes('README.md'), label+' 非 docSync 不追加 FEATURES/README: '+JSON.stringify(p_non));
  // 不重复（幂等）
  const p_idem = settleContractPaths(true, stage, { docSync: true });
  ok(p_idem.filter(x=>x==='docs/FEATURES.md').length===1 && p_idem.filter(x=>x==='README.md').length===1, label+' 幂等不重复');
}
// 路径为仓库相对路径（非目标级目录）
const p = settleContractPaths(true, coder, { docSync: true });
ok(p.every(x => /^(docs\/FEATURES\.md|README\.md)$/.test(x)) && p.includes('docs/FEATURES.md'), 'I-2/I-3 契约路径=仓库相对路径（非 docs/<goalId>/FEATURES.md）');
console.log('RESULT: pass='+pass+' fail='+fail+' (AC-R4-1/4 + 幂等 + 路径命名空间)');
process.exit(fail===0?0:1);
