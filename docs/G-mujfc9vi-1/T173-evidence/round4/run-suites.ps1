# round4/run-suites.ps1 — T-173 devops：在干净 main 快照树 .ci-main 上逐文件直跑套件
#
# 为什么逐文件直跑：run-ci 的 test 阶段在能找到 DSH 检出时会先跑
# scripts/ci/build-external-package.mjs 建 junction/符号链接，而本会话 DSH 沙箱
# 禁止创建 reparse point（EPERM），因此该阶段在沙箱里结构性不可执行（已在
# 04-ci-full-summary.txt 中如实登记）。这里用「逐文件独立 Node 进程」复现同一批
# 测试文件的隔离语义（与 node --test <单文件> 等价）。
#
# 沙箱适配（非产品代码、不落进 .ci-main，不改动被发布树）：
#   -sandbox-pipe-shim.cjs   把子进程 stdio:'pipe' 改写为临时文件 fd
#   --test-isolation=none    让 node --test 在同进程内跑，避开运行器自身 spawn
$ErrorActionPreference = 'Continue'
$worktree = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$tree     = Join-Path $worktree '.ci-main'
$shim     = (Resolve-Path (Join-Path $PSScriptRoot '..\sandbox-pipe-shim.cjs')).Path
Set-Location $tree
$env:NODE_OPTIONS = '--require "' + ($shim -replace '\\','/') + '" --test-isolation=none'

$files = @(
  # —— 本批（T-170 / G-mujfc9vi-1）特性与回归套件 ——
  'packages/shared/test/path-domain.test.mjs',
  'packages/shared/test/repo-identity.test.mjs',
  'team-hub/write-intent-store.test.mjs',
  'team-hub/claim-policy.test.mjs',
  'team-hub/git-plumbing.test.mjs',
  'team-hub/delivery-store.test.mjs',
  'team-hub/integration-worker.test.mjs',
  'team-hub/integration-runner.test.mjs',
  'team-hub/write-intent-routes.test.mjs',
  'team-hub/delivery-routes.test.mjs',
  'team-hub/metrics.test.mjs',
  'team-hub/claim-reservation.e2e.test.mjs',
  'team-hub/delivery-submit.e2e.test.mjs',
  'team-hub/verify-config.test.mjs',
  'plugins/tests/write-eligibility.test.mjs',
  'plugins/tests/legacy-convergence.test.mjs',
  'plugins/tests/production-write-guard.test.mjs',
  'plugins/tests/workflow-test-runner.test.mjs',
  'workbench/scripts/delivery-ui.test.mjs',
  # —— L0 基线代表集（run-ci test 阶段清单的子集）——
  'team-hub/chat.test.mjs',
  'team-hub/skills.test.mjs',
  'team-hub/calendar.test.mjs',
  'workbench/scripts/files-api.test.mjs',
  'workbench/scripts/web.test.mjs',
  'tests/contract/contracts.test.mjs',
  'scripts/config/config.test.mjs'
)

$lines = New-Object System.Collections.ArrayList
[void]$lines.Add('# T-173 round4 套件逐文件直跑（干净 main 快照树 .ci-main）@ ' + (Get-Date -Format o))
[void]$lines.Add('# tree=' + $tree)
[void]$lines.Add('# tree HEAD=' + (& git rev-parse HEAD) + '  tree status 条目=' + (@(& git status --porcelain).Count))
[void]$lines.Add('# 说明：本树内容 == main 30bacf09（tracked 集 2974/2974 一致）；node=' + (& node --version))
[void]$lines.Add('# 沙箱适配：sandbox-pipe-shim.cjs + --test-isolation=none（不改被发布树）')
[void]$lines.Add('')
$totalPass = 0; $totalFail = 0; $badFiles = 0
foreach ($f in $files) {
  $o = & node --test $f 2>&1
  $code = $LASTEXITCODE
  $text = ($o | Out-String)
  $mp = [regex]::Match($text, '(?m)^\s*\S*\s*pass (\d+)')
  $mf = [regex]::Match($text, '(?m)^\s*\S*\s*fail (\d+)')
  if ($mp.Success) { $p = [int]$mp.Groups[1].Value } else { $p = -1 }
  if ($mf.Success) { $fl = [int]$mf.Groups[1].Value } else { $fl = -1 }
  if ($p -gt 0) { $totalPass += $p }
  if ($fl -gt 0) { $totalFail += $fl }
  if ($code -ne 0 -or $fl -ne 0) { $badFiles++ }
  [void]$lines.Add(("{0,-52} exit={1,-3} pass={2,-4} fail={3}" -f $f, $code, $p, $fl))
  if ($code -ne 0) {
    [void]$lines.Add('  --- tail ---')
    foreach ($t in @($o | Select-Object -Last 14)) { [void]$lines.Add('  | ' + [string]$t) }
  }
}
[void]$lines.Add('')
[void]$lines.Add('TOTAL pass=' + $totalPass + ' fail=' + $totalFail + ' badFiles=' + $badFiles + ' files=' + $files.Count)
$outFile = Join-Path $PSScriptRoot '03-suites.txt'
$lines | Set-Content -LiteralPath $outFile -Encoding utf8
Write-Output ('WROTE ' + $outFile)
Write-Output ('TOTAL pass=' + $totalPass + ' fail=' + $totalFail + ' badFiles=' + $badFiles)
