$ErrorActionPreference="Continue"
Set-Location "D:\project\DSH\legion\.legion-worktrees\T-189"
foreach($f in @("team-hub/zz-t189-prefix-acceptance.test.mjs","team-hub/zz-t189-prefix-handoff.test.mjs","team-hub/zz-t189-prefix-runevents.test.mjs")){
  foreach($run in 1..2){
    $log = & node $f 2>&1 | Out-String
    $code = $LASTEXITCODE
    $t = ([regex]::Matches($log, "tests (\d+)")); $t = $t[$t.Count-1].Groups[1].Value
    $p = ([regex]::Matches($log, "pass (\d+)")); $p = $p[$p.Count-1].Groups[1].Value
    $fl = ([regex]::Matches($log, "fail (\d+)")); $fl = $fl[$fl.Count-1].Groups[1].Value
    Write-Output ("PREFIX " + $f + " run" + $run + " exit=" + $code + " tests=" + $t + " pass=" + $p + " fail=" + $fl)
    if($run -eq 1){ $log | Out-File -Encoding utf8 (".t189-review/prefix-" + (Split-Path $f -Leaf) + ".log") }
  }
}