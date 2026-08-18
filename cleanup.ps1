<#
.SYNOPSIS
    Remove the agent bridge from a Gang Garrison 2 checkout.

.DESCRIPTION
    Exactly reverses inject.ps1: deletes the copied object and scripts, and
    removes the three inserted lines. Edits are surgical rather than a git
    checkout, so any unrelated work in progress in those files survives.

    Verifies the result with git status and reports anything left behind.

.EXAMPLE
    .\cleanup.ps1
    .\cleanup.ps1 -Repo D:\code\Gang-Garrison-2
#>
param(
    [string]$Repo = (Join-Path $PSScriptRoot '..\Gang-Garrison-2'),
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$gg2 = Resolve-Gg2Tree $Repo
Write-Step "Removing agent bridge from $gg2" $Quiet

# --- 1. undo the three line edits ------------------------------------------
if (Remove-Line (Join-Path $gg2 'Scripts\Game\game_init.gml') 'instance_create(0, 0, AgentBridge);') {
    Write-Ok "removed instance_create from game_init.gml" $Quiet
} else { Write-Skip "game_init.gml already clean" $Quiet }

if (Remove-Line (Join-Path $gg2 'Objects\_resources.list.xml') '<resource name="AgentBridge" type="RESOURCE"/>') {
    Write-Ok "unregistered object" $Quiet
} else { Write-Skip "object already unregistered" $Quiet }

if (Remove-Line (Join-Path $gg2 'Scripts\_resources.list.xml') '<resource name="AgentBridge" type="GROUP"/>') {
    Write-Ok "unregistered script group" $Quiet
} else { Write-Skip "script group already unregistered" $Quiet }

# --- 2. delete the payload --------------------------------------------------
$targets = @(
    (Join-Path $gg2 'Objects\AgentBridge.xml'),
    (Join-Path $gg2 'Objects\AgentBridge.events'),
    (Join-Path $gg2 'Scripts\AgentBridge')
)
foreach ($t in $targets) {
    if (Test-Path $t) {
        Remove-Item $t -Recurse -Force
        Write-Ok "deleted $(Split-Path $t -Leaf)" $Quiet
    } else {
        Write-Skip "$(Split-Path $t -Leaf) not present" $Quiet
    }
}

# --- 3. prove the checkout is clean ----------------------------------------
Push-Location (Resolve-Path $Repo).Path
try {
    $status = @(git status --porcelain 2>$null)
} finally {
    Pop-Location
}

if ($status.Count -eq 0) {
    Write-Ok "git status clean" $Quiet
} else {
    Write-Warn "checkout is not clean; remaining changes:"
    $status | ForEach-Object { Write-Host "      $_" }
    $stray = @($status | Where-Object { $_ -match 'AgentBridge|agent_bridge' })
    if ($stray.Count -gt 0) {
        Write-Fail "bridge artefacts still present - cleanup did not fully reverse"
        exit 1
    }
    Write-Ok "no bridge artefacts remain (changes above are unrelated)" $Quiet
}
