$ErrorActionPreference='Continue'
$env:GIT_INDEX_FILE="$PWD\.git-local-index"
$shim = "$PWD\docs\G-mujfc9vi-1\T173-evidence\sandbox-pipe-shim.cjs"
$env:NODE_OPTIONS = "--require $shim --test-isolation=none"
$files = @(
 'packages/shared/test/path-domain.test.mjs','packages/shared/test/repo-identity.test.mjs',
 'team-hub/write-intent-store.test.mjs','team-hub/claim-policy.test.mjs','team-hub/claim-reservation.e2e.test.mjs',
 'team-hub/git-plumbing.test.mjs','team-hub/delivery-store.test.mjs','team-hub/integration-worker.test.mjs',
 'team-hub/integration-runner.test.mjs','team-hub/write-intent-routes.test.mjs','team-hub/delivery-routes.test.mjs',
 'team-hub/delivery-submit.e2e.test.mjs','team-hub/event-delivery.test.mjs','team-hub/event-delivery-wiring.test.mjs',
 'team-hub/metrics.test.mjs','plugins/tests/write-eligibility.test.mjs','plugins/tests/legacy-convergence.test.mjs',
 'workbench/scripts/delivery-ui.test.mjs' )
$total=0;$pass=0;$fail=0;$rows=@()
foreach ($f in $files) {
  if (-not (Test-Path $f)) { $rows += ('MISSING  ' + $f); continue }
  $out = (& node $f 2>&1 | Out-String)
  $code = $LASTEXITCODE
  $t = [regex]::Match($out, 'tests (\d+)').Groups[1].Value
  $p = [regex]::Match($out, 'pass (\d+)').Groups[1].Value
  $fl = [regex]::Match($out, 'fail (\d+)').Groups[1].Value
  if ($t -eq '') { $t='?'; $p='?'; $fl='?' } else { $total+=[int]$t; $pass+=[int]$p; $fail+=[int]$fl }
  $rows += (('exit={0,-3} tests={1,-4} pass={2,-4} fail={3,-4}  {4}' -f $code,$t,$p,$fl,$f))
  if ($code -ne 0) { $rows += ('   FAIL-LINES: ' + (($out -split "`n" | Where-Object { $_ -match '^not ok|# fail|Error:' } | Select-Object -First 4) -join ' | ')) }
}
$rows | ForEach-Object { $_ }
echo "TOTAL files=$($files.Count) tests=$total pass=$pass fail=$fail"