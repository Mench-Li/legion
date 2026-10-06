$ErrorActionPreference="Continue"
$root='D:\project\DSH\legion\.legion-worktrees\T-189'
Set-Location $root
$tmp = Join-Path $root ".t189-tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$summary = Join-Path $tmp "summary.txt"
"=== START $(Get-Date -Format o) ===" | Out-File -Encoding utf8 $summary
$all = @()
$suites = @(@{n='model-api'; f=@('workbench/scripts/model-api.test.mjs')},@{n='can-read'; f=@('orchestrator/worker/can-read-authorization-source.test.mjs')},@{n='e2e-assembly'; f=@('runtime/dsh-composition/e2e-assembly.test.mjs')},@{n='employee-preset'; f=@('runtime/dsh-composition/employee-preset.test.mjs','runtime/dsh-composition/employee-preset-mount-dsh-process.test.mjs')},@{n='secret-store'; f=@('security/secrets/secrets.test.mjs','security/secrets/run-credentials.test.mjs','security/secrets/credential-materializer.test.mjs')},@{n='acceptance-routes'; f=@('team-hub/acceptance-routes.test.mjs')},@{n='handoff-routes'; f=@('team-hub/handoff-routes.test.mjs')},@{n='run-events'; f=@('team-hub/run-events.test.mjs')},@{n='route-family'; f=@('team-hub/activity-routes.test.mjs','team-hub/agent-intake-routes.test.mjs','team-hub/artifact-content-routes.test.mjs','team-hub/comment-routes.test.mjs','team-hub/config-routes.test.mjs','team-hub/content-reads-routes.test.mjs','team-hub/create-routes.test.mjs','team-hub/employee-manifests-routes.test.mjs','team-hub/exec-routes.test.mjs','team-hub/feedback-heartbeat-routes.test.mjs','team-hub/goal-lifecycle-routes.test.mjs','team-hub/goal-slices-routes.test.mjs','team-hub/members-routes.test.mjs','team-hub/model-bindings-by-path-routes.test.mjs','team-hub/model-bindings-routes.test.mjs','team-hub/model-migration-routes.test.mjs','team-hub/models-routes.test.mjs','team-hub/read-models-routes.test.mjs','team-hub/run-budget-may-switch-model-routes.test.mjs','team-hub/run-budget-routes.test.mjs','team-hub/runtime-lease-routes.test.mjs','team-hub/runtime-verification-routes.test.mjs','team-hub/skill-source-routes.test.mjs','team-hub/skills-documents-routes.test.mjs','team-hub/space-config-routes.test.mjs','team-hub/space-operations-routes.test.mjs','team-hub/task-lifecycle-routes.test.mjs','team-hub/task-records-routes.test.mjs','team-hub/team-plan-read-routes.test.mjs','team-hub/team-plans-routes.test.mjs','team-hub/team-views-routes.test.mjs','team-hub/web-routes.test.mjs')})
foreach($s in $suites){
  foreach($file in $s.f){
    $log = & node $file 2>&1 | Out-String
    $code = $LASTEXITCODE
    $leaf = (Split-Path $file -Leaf)
    $log | Out-File -Encoding utf8 (Join-Path $tmp ($s.n + "__" + $leaf + ".log"))
    function LastNum($txt, $pat) { $m = [regex]::Matches($txt, $pat); if($m.Count -eq 0){ return "-1" } return $m[$m.Count-1].Groups[1].Value }
    $t = LastNum $log "tests (\d+)"; $p = LastNum $log "pass (\d+)"; $fl = LastNum $log "fail (\d+)"; $sk = LastNum $log "skipped (\d+)"
    $line = "$($s.n)|$leaf|exit=$code|tests=$t|pass=$p|fail=$fl|skipped=$sk"
    $line | Out-File -Encoding utf8 -Append $summary
    Write-Output $line
  }
}
"=== END $(Get-Date -Format o) ===" | Out-File -Encoding utf8 -Append $summary