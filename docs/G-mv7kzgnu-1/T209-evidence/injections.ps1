$ErrorActionPreference = 'Continue'
$dir = 'docs/G-mv7kzgnu-1/T209-evidence'
$gear = ([string][char]0x2699) + [string][char]0xFE0F
$gearOnly = [string][char]0x2699
$guan = [string][char]0x7BA1
$logPath = "$dir/30-injections.log"
if (Test-Path $logPath) { Remove-Item $logPath }
$script:lines = @()

function Invoke-Case {
  param([string]$Name, [string]$Expect, [array]$Edits, [string]$Command)
  $byFile = @{}
  foreach ($e in $Edits) {
    if (-not $byFile.ContainsKey($e.File)) { $byFile[$e.File] = @() }
    $byFile[$e.File] += ,$e
  }
  $backups = @{}
  $anchorFail = $false
  foreach ($f in $byFile.Keys) {
    $p = (Resolve-Path $f).Path
    $bytes = [System.IO.File]::ReadAllBytes($p)
    $backups[$p] = $bytes
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    foreach ($e in $byFile[$f]) {
      if (-not $text.Contains($e.Find)) { Write-Host "!!! [$Name] anchor not found in $f : $($e.Find)"; $anchorFail = $true; break }
      $text = $text.Replace($e.Find, $e.Replace)
    }
    if ($anchorFail) { break }
    [System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))
  }
  $code = 99
  $fail = 'n/a'
  $out = ''
  if (-not $anchorFail) {
    $out = (& cmd /c "$Command 2>&1" | Out-String)
    $code = $LASTEXITCODE
    $m = [regex]::Match($out, 'fail (\d+)')
    if ($m.Success) { $fail = $m.Groups[1].Value }
  }
  foreach ($p in $backups.Keys) { [System.IO.File]::WriteAllBytes($p, $backups[$p]) }
  $restored = $true
  foreach ($p in $backups.Keys) {
    $now = [System.IO.File]::ReadAllBytes($p)
    if ($now.Length -ne $backups[$p].Length) { $restored = $false }
    else { for ($i = 0; $i -lt $now.Length; $i++) { if ($now[$i] -ne $backups[$p][$i]) { $restored = $false; break } } }
  }
  $red = ($code -ne 0) -or ($fail -ne 'n/a' -and [int]$fail -gt 0)
  $verdict = if ($anchorFail) { 'ANCHOR-MISS' } elseif ($Expect -eq 'green-is-gap') { if ($red) { 'PASS' } else { 'FAIL(无门禁/仍绿)' } } else { if ($red) { 'PASS' } else { 'FAIL(仍绿)' } }
  $line = "[$Name] expect=$Expect actual_red=$red exit=$code fail=$fail restored=$restored verdict=$verdict"
  Write-Output $line
  $script:lines += $line
}

$tv = 'node team-hub/team-views-routes.test.mjs'
$parity = 'node workbench/scripts/external-avatar-parity.test.mjs'
$surf = 'node workbench/scripts/agent-avatar-surfaces.test.mjs'
$set = 'node workbench/scripts/agent-avatar-settings.test.mjs'

Invoke-Case -Name 'TC-S1-14' -Expect 'red' -Command $tv -Edits @(
  @{ File='team-hub/routes/team-views.mjs'; Find='externalAvatarFor(soldier, usedTokens)'; Replace=("'" + $gear + "'") }
)
Invoke-Case -Name 'TC-S1-15' -Expect 'red' -Command $tv -Edits @(
  @{ File='team-hub/agent-avatars.mjs'; Find="'soldier-b': 'human:s13',"; Replace="'soldier-b': 'human:s12'," }
)
Invoke-Case -Name 'TC-S1-20' -Expect 'red' -Command $tv -Edits @(
  @{ File='team-hub/agent-avatars.mjs'; Find='return candidates[fnv1a(key) % candidates.length]'; Replace='return candidates[Math.floor(Math.random() * candidates.length)]' }
)
Invoke-Case -Name 'TC-S2-11' -Expect 'red' -Command $parity -Edits @(
  @{ File='workbench/src/avatar/external-agents.ts'; Find="'soldier-b': 'human:s13',"; Replace="'soldier-b': 'human:s10'," }
)
Invoke-Case -Name 'TC-S2-15' -Expect 'red' -Command $parity -Edits @(
  @{ File='team-hub/agent-avatars.mjs'; Find="general: 'human:s11',"; Replace="general: 'human:general'," },
  @{ File='workbench/src/avatar/external-agents.ts'; Find="general: 'human:s11',"; Replace="general: 'human:general'," }
)
Invoke-Case -Name 'TC-S3-09' -Expect 'red' -Command $surf -Edits @(
  @{ File='workbench/src/components/Sidebar.tsx'; Find='<div className="user-avatar"><AgentAvatar token={externalAvatarToken(''general'')} size={30} /></div>'; Replace=('<div className="user-avatar">' + $gearOnly + '</div>') },
  @{ File='workbench/src/components/WorkspaceNavigation.tsx'; Find='<span className="workspace-user" title="空间管理员"><AgentAvatar token={externalAvatarToken(''general'')} size={30} /></span>'; Replace=('<span className="workspace-user" title="空间管理员">' + $guan + '</span>') }
)
Invoke-Case -Name 'TC-S3-10' -Expect 'red' -Command $surf -Edits @(
  @{ File='workbench/src/components/Sidebar.tsx'; Find="import { externalAvatarToken } from '../avatar/external-agents'"; Replace='/* INJECTED: import removed */' },
  @{ File='workbench/src/components/Sidebar.tsx'; Find='<div className="user-avatar"><AgentAvatar token={externalAvatarToken(''general'')} size={30} /></div>'; Replace='<div className="user-avatar"><AgentAvatar token={''human:s12''} size={30} /></div>' }
)
Invoke-Case -Name 'TC-S4-08' -Expect 'red' -Command $set -Edits @(
  @{ File='workbench/src/components/SkillsPanel.tsx'; Find='<AgentAvatar token={a?.avatar || externalAvatarToken(m)} /> {memberLabel(m)}'; Replace='{a && <AgentAvatar token={a.avatar} />} {memberLabel(m)}' }
)
Invoke-Case -Name 'TC-S2-12' -Expect 'red' -Command 'node docs/G-mv7kzgnu-1/T209-evidence/check-suite-registered.mjs' -Edits @(
  @{ File='scripts/ci/run-ci.mjs'; Find="files: ['workbench/scripts/external-avatar-parity.test.mjs'], cwd: ROOT },"; Replace="files: [], cwd: ROOT }," }
)
Invoke-Case -Name 'TC-S2-14' -Expect 'green-is-gap' -Command ($surf + ' & ' + $set) -Edits @(
  @{ File='workbench/src/avatar/external-agents.ts'; Find='export const EXTERNAL_AGENT_AVATARS'; Replace=("const AVATARS = { a: 'fake', b: 'fake2' }" + [char]10 + 'export const EXTERNAL_AGENT_AVATARS') }
)
Invoke-Case -Name 'TC-S5-08' -Expect 'red' -Command 'node scripts/ci/evidence-banner.mjs --check' -Edits @(
  @{ File='docs/G-mv7kzgnu-1/REQUIREMENTS.md'; Find='<!-- evidence-banner:start -->'; Replace='<!-- injected: banner start removed -->' },
  @{ File='docs/G-mv7kzgnu-1/REQUIREMENTS.md'; Find='<!-- evidence-banner:end -->'; Replace='<!-- injected: banner end removed -->' }
)

Write-Output '--- suite registration positive check (TC-S2-06) ---'
$out = (& cmd /c "node docs/G-mv7kzgnu-1/T209-evidence/check-suite-registered.mjs 2>&1" | Out-String)
$pos = "[TC-S2-06] expect=green actual_exit=" + $LASTEXITCODE + " :: " + $out.Trim() + " verdict=" + $(if ($LASTEXITCODE -eq 0) { 'PASS' } else { 'FAIL' })
Write-Output $pos
$script:lines += $pos

$script:lines | Out-File -Encoding utf8 $logPath
Write-Output '--- git status after all injections ---'
& cmd /c "git status --short"
