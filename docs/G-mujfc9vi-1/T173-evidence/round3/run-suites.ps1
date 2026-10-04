# T-173 round3：并行任务冲突控制（G-mujfc9vi-1）特性/回归套件逐文件直跑
# 沙箱适配（非产品代码）：sandbox-pipe-shim.cjs 把 stdio:'pipe' 改写为临时文件 fd；
# --test-isolation=none 让 node --test 在同进程内跑，避开运行器自身 spawn。
$ErrorActionPreference = 'Continue'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$shim = (Resolve-Path (Join-Path $PSScriptRoot '..\sandbox-pipe-shim.cjs')).Path
Set-Location $root
$env:NODE_OPTIONS = '--require "' + ($shim -replace '\\','/') + '" --test-isolation=none'

$files = @(
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
  'workbench/scripts/delivery-ui.test.mjs'
)

$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("# T-173 round3 套件直跑 @ " + (Get-Date -Format o) + "  root=" + $root)
[void]$lines.Add("# node=" + (& node --version) + "  git-head=" + (& git rev-parse HEAD))
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
    [void]$lines.Add("  --- tail ---")
    foreach ($t in @($o | Select-Object -Last 12)) { [void]$lines.Add("  | " + [string]$t) }
  }
}
[void]$lines.Add("")
[void]$lines.Add("TOTAL pass=" + $totalPass + " fail=" + $totalFail + " badFiles=" + $badFiles + " files=" + $files.Count)
$outFile = Join-Path $PSScriptRoot 'suites-output.txt'
$lines | Set-Content -LiteralPath $outFile -Encoding utf8
Write-Output ("WROTE " + $outFile)
Write-Output ("TOTAL pass=" + $totalPass + " fail=" + $totalFail + " badFiles=" + $badFiles)
