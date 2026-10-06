$ErrorActionPreference="Continue"
Set-Location "D:\project\DSH\legion\.legion-worktrees\T-189"
$baseline = Get-Content "docs/superpowers/prt/prt-007-baseline.json" -Raw | ConvertFrom-Json
$files = @("team-hub/server.mjs","team-hub/write-intent-store.mjs","team-hub/routes/agents.mjs","team-hub/routes/write-intent.mjs","team-hub/routes/delivery.mjs")
foreach($f in $files){
  $base = $baseline.sources.$f
  $cur = (Get-FileHash -Algorithm SHA256 $f).Hash.ToLower()
  $parentPath = ".t189-review/parent/" + $f
  $par = if(Test-Path $parentPath){ (Get-FileHash -Algorithm SHA256 $parentPath).Hash.ToLower() } else { "MISSING" }
  $againstParent = if($par -eq $base){ "MATCH" } else { "DRIFT" }
  $againstCur = if($cur -eq $base){ "MATCH" } else { "DRIFT" }
  "$f | baseline=$($base.Substring(0,12)) | parent=$($par.Substring(0,[Math]::Min(12,$par.Length)))($againstParent) | current=$($cur.Substring(0,12))($againstCur)"
}