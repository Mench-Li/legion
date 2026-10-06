$ErrorActionPreference="Continue"
$files = @(
 'orchestrator/worker/can-read-authorization-source.test.mjs',
 'runtime/dsh-composition/e2e-assembly.test.mjs',
 'runtime/dsh-composition/employee-preset.test.mjs',
 'security/secrets/credential-materializer.test.mjs',
 'team-hub/acceptance-routes.test.mjs',
 'team-hub/goal-lifecycle-routes.test.mjs',
 'team-hub/handoff-routes.test.mjs',
 'team-hub/run-events.test.mjs',
 'workbench/scripts/model-api.test.mjs'
)
$parent='6bcbcc7e^'
$child='6bcbcc7e'
"file|assertParent|assertChild|assertDelta|testParent|testChild|skipAddedLines"
foreach($f in $files){
  $a = (git show ($parent + ":" + $f) 2>$null) -join "`n"
  $b = (git show ($child + ":" + $f) 2>$null) -join "`n"
  $ca = ([regex]::Matches($a,'assert\.')).Count
  $cb = ([regex]::Matches($b,'assert\.')).Count
  $ta = ([regex]::Matches($a,"(?m)^\s*(test|it)\(")).Count
  $tb = ([regex]::Matches($b,"(?m)^\s*(test|it)\(")).Count
  $added = (git diff $parent $child -- $f | Select-String -Pattern '^\+.*(\.skip\(|t\.skip|\.only\(|skip:\s*true)' ).Count
  "$f|$ca|$cb|$($cb-$ca)|$ta|$tb|$added"
}