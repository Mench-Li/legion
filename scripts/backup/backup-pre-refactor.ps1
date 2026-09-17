# legion pre-refactor backup
# Layers: (1) git tag freeze  (2) offline git bundle of ALL refs + stashes
#         (3) cold robocopy snapshot incl .git + runtime state  (4) verify + restore drill
# NOTE: target must live OUTSIDE the repo (beside it, not inside), otherwise robocopy
#       would recurse into its own output.
#
# PS 5.1 note: do NOT use $ErrorActionPreference='Stop' here. git legitimately writes
# progress/verify text to stderr, and 2>&1 turns that into a terminating ErrorRecord.

$src  = 'D:\project\DSH\legion'
$dsh  = 'D:\project\DSH\dsh\deepseek-harness'
$ts   = Get-Date -Format 'yyyyMMdd-HHmmss'
$root = "D:\project\DSH\_legion-backup\legion-$ts"

New-Item -ItemType Directory -Force -Path $root | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root 'runtime-state\team-hub') | Out-Null
$log = Join-Path $root '_backup.log'
Set-Content -Path $log -Value "legion pre-refactor backup / stamp $ts" -Encoding utf8

function Say([string]$m) { Write-Host $m; Add-Content -Path $log -Value $m -Encoding utf8 }
function G([string[]]$a) { $o = & git @a 2>&1 | ForEach-Object { $_.ToString() }; return ,$o }
function Log([object]$o) { ($o | Out-String) | Add-Content -Path $log -Encoding utf8 }

Say "source : $src"
Say "target : $root"

# ---------- 1) freeze pointer ----------
$tag = "backup/pre-refactor-$ts"
Log (G @('-C', $src, 'tag', '-a', $tag, '-m', "legion pre-refactor snapshot ($ts)"))
$mainHead = ((G @('-C', $src, 'rev-parse', 'HEAD')) -join '').Trim()
Say "[1] tag $tag -> $mainHead"

# ---------- 2) portable offline archive: every branch, tag and stash ----------
$bundle = Join-Path $root 'legion-allrefs.bundle'
Log (G @('-C', $src, 'bundle', 'create', $bundle, '--all', 'refs/stash'))
if (-not (Test-Path $bundle)) { throw "bundle create failed" }
$verify = G @('-C', $src, 'bundle', 'verify', $bundle)
Log $verify
$okVerify = ($verify -join ' ') -match 'is okay'
Say "[2] bundle: $([math]::Round((Get-Item $bundle).Length/1MB,2)) MB  verify-ok=$okVerify"

# ---------- 3) manifest ----------
$mf = Join-Path $root 'MANIFEST.txt'
$lines = @()
$lines += "legion pre-refactor backup"
$lines += "stamp        : $ts"
$lines += "source       : $src"
$lines += "target       : $root"
$lines += "main HEAD    : $mainHead"
$lines += "tag          : $tag"
$lines += "origin/main  : $(((G @('-C', $src, 'rev-parse', 'origin/main')) -join '').Trim())"
$lines += "dsh checkout : $dsh"
$lines += "dsh HEAD     : $(((G @('-C', $dsh, 'rev-parse', 'HEAD')) -join '').Trim())"
$lines += "dsh branch   : $(((G @('-C', $dsh, 'branch', '--show-current')) -join '').Trim())"
$lines += "dsh dirty    : $((G @('-C', $dsh, 'status', '--porcelain')).Count) files"
$lines += ""
$lines += "== local branches (name sha upstream) =="
$lines += (G @('-C', $src, 'for-each-ref', '--format=%(refname:short) %(objectname) %(upstream:short)', 'refs/heads'))
$lines += ""
$lines += "== stashes =="
$lines += (G @('-C', $src, 'stash', 'list'))
$lines += ""
$lines += "== main working tree status =="
$lines += (G @('-C', $src, 'status', '--porcelain'))
$lines += ""
$lines += "== dirty worktrees =="
foreach ($w in (G @('-C', $src, 'worktree', 'list', '--porcelain'))) {
  if ($w -notlike 'worktree *') { continue }
  $p = ($w -replace '^worktree ', '').Trim()
  $st = G @('-C', $p, 'status', '--porcelain')
  if ($st) { $lines += "--- $p ($($st.Count) files)"; $lines += $st }
}
Set-Content -Path $mf -Value ($lines -join "`n") -Encoding utf8

# tracked WIP as a patch (binary-safe)
& git -C $src diff HEAD --binary 2>$null | Set-Content -Path (Join-Path $root 'wip-main-tracked.patch') -Encoding utf8
Say "[3] manifest + WIP patch written"

# ---------- 4) consistent sqlite snapshot of live runtime state (best effort) ----------
$mjs    = Join-Path $root '_vacuum.mjs'
$target = ((Join-Path $root 'runtime-state\team-hub\team.db') -replace '\\', '/')
$code = @"
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:/project/DSH/legion/team-hub/team.db', { readOnly: true });
db.exec("VACUUM INTO '$target'");
console.log('vacuum-into ok');
"@
Set-Content -Path $mjs -Value $code -Encoding ascii
$vac = & node $mjs 2>&1 | ForEach-Object { $_.ToString() }
Log $vac
if (Test-Path (Join-Path $root 'runtime-state\team-hub\team.db')) {
  Say "[4] team.db consistent snapshot OK ($([math]::Round((Get-Item (Join-Path $root 'runtime-state\team-hub\team.db')).Length/1MB,2)) MB)"
} else { Say "[4] team.db VACUUM INTO failed -- cold copy still holds db+wal+shm" }
Remove-Item $mjs -Force -ErrorAction SilentlyContinue

# ---------- 5) cold snapshot ----------
$copy = Join-Path $root 'worktree'
Say "[5] robocopy -> $copy ..."
& robocopy $src $copy /MIR /XJ /XD node_modules /R:1 /W:1 /NFL /NDL /NP /LOG+:$log | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) { throw "robocopy FAILED exit=$rc (see $log)" }
Say "[5] robocopy ok (exit $rc)"

# ---------- 6) verify the copy against the source ----------
$srcRefs   = (G @('-C', $src,  'for-each-ref')).Count
$copyRefs  = (G @('-C', $copy, 'for-each-ref')).Count
$srcStash  = (G @('-C', $src,  'stash', 'list')).Count
$copyStash = (G @('-C', $copy, 'stash', 'list')).Count
$srcDirty  = (G @('-C', $src,  'status', '--porcelain')).Count
$copyDirty = (G @('-C', $copy, 'status', '--porcelain')).Count
$copyHead  = ((G @('-C', $copy, 'rev-parse', 'HEAD')) -join '').Trim()
Say "[6] copy HEAD   : $copyHead (source $mainHead) match=$($copyHead -eq $mainHead)"
Say "[6] refs        : copy $copyRefs / source $srcRefs"
Say "[6] stashes     : copy $copyStash / source $srcStash"
Say "[6] dirty files : copy $copyDirty / source $srcDirty"
$fsck = G @('-C', $copy, 'fsck', '--no-progress', '--no-dangling')
Log $fsck
Say "[6] git fsck on copy: $($fsck.Count) line(s) -> _backup.log"

# ---------- 7) restore drill: clone the bundle, restore the stash ref ----------
$test = Join-Path $root '_bundle-test'
Log (G @('clone', '--quiet', $bundle, $test))
$tHead = ((G @('-C', $test, 'rev-parse', 'HEAD')) -join '').Trim()
$tRefs = (G @('-C', $test, 'for-each-ref', 'refs/remotes')).Count
Log (G @('-C', $test, 'fetch', '--quiet', $bundle, 'refs/stash:refs/stash'))
$tStash = (G @('-C', $test, 'stash', 'list')).Count
Say "[7] bundle clone HEAD $tHead (match=$($tHead -eq $mainHead)) remote-refs $tRefs stash-restored $tStash/$srcStash"

# ---------- 8) restore instructions ----------
$md = @"
# legion pre-refactor backup ($ts)

Restore target of record: main @ $mainHead   (tag: $tag)

## What is here

| Path | Content |
|---|---|
| ``legion-allrefs.bundle`` | offline git archive: ALL local branches, the tag, and all stashes. |
| ``worktree\`` | cold byte-for-byte copy of the whole repo at backup time, incl. ``.git``, all worktrees, untracked files and runtime state. ``node_modules`` excluded (junction farm into worktree T-051 / the DSH checkout; reinstall instead). |
| ``runtime-state\team-hub\team.db`` | consistent SQLite snapshot of the live hub DB (VACUUM INTO). |
| ``MANIFEST.txt`` | HEAD, branch list, stash list, dirty files, DSH checkout revision. |
| ``wip-main-tracked.patch`` | ``git diff HEAD --binary`` of main's uncommitted tracked changes. |

## Restore

### A. Full cold restore (simplest -- the "exactly as it was" path)

    robocopy "$root\worktree" "D:\project\DSH\legion-restored" /MIR /XJ /XD node_modules /R:1 /W:1

Then re-install deps in board-plugin, plugins, team-hub, workbench (pnpm/junction based, intentionally not backed up).

### B. Git-only restore from the bundle (no dependency on the cold copy)

    git clone "$bundle" D:\project\DSH\legion-restored
    cd D:\project\DSH\legion-restored
    git fetch "$bundle" "refs/stash:refs/stash"      # brings back all stashes
    git branch -a                                     # all branches present as origin/*

Turn a bundled branch back into a local branch:

    git branch w/T-118 origin/w/T-118

### C. Recover just main's uncommitted work

    cd D:\project\DSH\legion-restored
    git apply --binary "$root\wip-main-tracked.patch"

Dirty worktrees (T-117 / T-065 / dual-write-race / prt-runtime) exist only in the cold copy:
take them from ``worktree\.legion-worktrees\...`` and ``worktree\.worktrees\...``.

### D. Runtime state

    copy "$root\runtime-state\team-hub\team.db" D:\project\DSH\legion\team-hub\team.db

## Important

* The tag ``$tag`` lives in this local repo, but pushing was impossible at backup time
  (``git ls-remote`` -> ``SEC_E_NO_CREDENTIALS``). It IS inside the bundle.
* 34 of 39 branches (all ``w/*`` slice branches and 4 ``codex/*`` branches) had no remote
  counterpart. This bundle is their only archive.
* The DSH checkout revision this build ran against is recorded in MANIFEST.txt; the backup
  does NOT contain the DSH checkout itself.
"@
Set-Content -Path (Join-Path $root 'RESTORE.md') -Value $md -Encoding utf8
Copy-Item $PSCommandPath (Join-Path $root 'backup-pre-refactor.ps1') -Force -ErrorAction SilentlyContinue

Say ""
Say "DONE. backup root: $root"
$total = (Get-ChildItem $root -Recurse -File -Force | Measure-Object Length -Sum)
Say "size: $([math]::Round($total.Sum/1MB,1)) MB / $($total.Count) files"
