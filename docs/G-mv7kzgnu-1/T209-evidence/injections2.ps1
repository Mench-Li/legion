$ErrorActionPreference = 'Continue'
$dir = 'docs/G-mv7kzgnu-1/T209-evidence'

function Apply-Edits($edits) {
  $byFile = @{}
  foreach ($e in $edits) { if (-not $byFile.ContainsKey($e.File)) { $byFile[$e.File] = @() }; $byFile[$e.File] += ,$e }
  $backups = @{}
  foreach ($f in $byFile.Keys) {
    $p = (Resolve-Path $f).Path
    $bytes = [System.IO.File]::ReadAllBytes($p)
    $backups[$p] = $bytes
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    foreach ($e in $byFile[$f]) {
      if (-not $text.Contains($e.Find)) { throw "anchor not found in $f : $($e.Find)" }
      $text = $text.Replace($e.Find, $e.Replace)
    }
    [System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))
  }
  return $backups
}
function Restore-All($backups) {
  foreach ($p in $backups.Keys) { [System.IO.File]::WriteAllBytes($p, $backups[$p]) }
  $ok = $true
  foreach ($p in $backups.Keys) {
    $now = [System.IO.File]::ReadAllBytes($p)
    if ($now.Length -ne $backups[$p].Length) { $ok = $false } else { for ($i = 0; $i -lt $now.Length; $i++) { if ($now[$i] -ne $backups[$p][$i]) { $ok = $false; break } } }
  }
  return $ok
}

$b = Apply-Edits @(
  @{ File='team-hub/routes/team-views.mjs'; Find='const avatar = externalAvatarFor(soldier, usedTokens)'; Replace='const avatar = externalAvatarFor(soldier, usedTokens); db.prepare("INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ''INJ'', ''ai'', ?, 99)").run(scope, soldier, avatar)' }
)
$out = (& cmd /c "node docs/G-mv7kzgnu-1/T209-evidence/probe-e2e.mjs 2>&1" | Out-String)
$code = $LASTEXITCODE
$r = Restore-All $b
$obj = $null; try { $obj = $out | ConvertFrom-Json } catch { }
if ($obj) {
  $red = ($obj.e2e6.rosterCountAfter -gt $obj.e2e6.rosterCountBefore)
  $verdict = if ($red) { 'PASS' } else { 'FAIL(仍绿)' }
  $inj1 = ("[TC-S1-16] expect=red actual_red={0} exit={1} rosterCount {2}->{3} mismatch={4} restored={5} verdict={6}" -f $red, $code, $obj.e2e6.rosterCountBefore, $obj.e2e6.rosterCountAfter, $obj.e2e6.agentCountMismatch.Count, $r, $verdict)
  Write-Output $inj1
} else {
  $inj1 = ("[TC-S1-16] probe parse failed exit=$code restored=$r raw=" + $out.Substring(0, [Math]::Min(400,$out.Length)))
  Write-Output $inj1
}

$b2 = Apply-Edits @(
  @{ File='workbench/README.md'; Find='不再是齿轮 emoji / 灰阶占位。'; Replace='仍是齿轮 emoji / 灰阶占位，且零图片资源。' }
)
$out2 = (& cmd /c "node scripts/ci/check-docs.mjs 2>&1" | Out-String)
$code2 = $LASTEXITCODE
$scan = (& cmd /c "node docs/G-mv7kzgnu-1/T209-evidence/check-readme-wording.mjs 2>&1" | Out-String)
$code3 = $LASTEXITCODE
$r2 = Restore-All $b2
$gateRed = ($code2 -ne 0)
$scanRed = ($code3 -ne 0)
$v2 = if ($gateRed) { 'PASS' } else { 'FAIL(文档口径门禁未检出/无此门禁)' }
$inj2 = ("[TC-S5-09] check-docs exit={0} gate_red={1} manual_scan_red={2} scan_exit={3} restored={4} verdict={5}" -f $code2, $gateRed, $scanRed, $code3, $r2, $v2)
Write-Output $inj2
Write-Output ("  manual scan: " + $scan.Trim())
$lines = @($inj1, $inj2)
$lines | Out-File -Encoding utf8 -Append "$dir/30-injections.log"
Write-Output '--- git status ---'
& cmd /c "git status --short"
