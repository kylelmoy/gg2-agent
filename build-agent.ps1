<#
.SYNOPSIS
    Build a Gang Garrison 2 executable with the agent bridge compiled in.

.DESCRIPTION
    Owns the whole pipeline, so the game repo stays pristine:

      1. inject the agent bridge into the split source tree
      2. gmksplit    reassemble Source/gg2 into a .gmk
      3. gm8_build   drive the Game Maker 8 IDE to compile it   (~35s)
      4. gm8x_fix    patch the resulting executable
      5. package     optional: copy music/licences and zip      (-Package)
      6. cleanup     remove the bridge again

    Step 6 runs from a finally block, so an interrupted or failed build still
    leaves the checkout clean.

    The upstream build.bat is never called or modified. It stops at a manual
    "File > Create Executable" step in the IDE, which is exactly the gap
    gm8_build.ahk closes.

.PARAMETER KeepInjected
    Leave the bridge in the tree afterwards. Useful while iterating on the
    bridge's own GML; run cleanup.ps1 before committing anything.

.PARAMETER Package
    Also produce build.zip with music, licences and extensions, the way a
    release is assembled. Off by default: a dev loop only needs the exe.

.EXAMPLE
    .\build-agent.ps1
    .\build-agent.ps1 -KeepInjected
    .\build-agent.ps1 -Package
#>
param(
    [string]$Repo = (Join-Path $PSScriptRoot '..\Gang-Garrison-2'),
    [switch]$KeepInjected,
    [switch]$Package
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$repoFull = (Resolve-Path $Repo).Path
$source   = Join-Path $repoFull 'Source'
$build    = Join-Path $source 'build'
$exeOut   = Join-Path $build 'Gang Garrison 2.exe'
$gmkOut   = Join-Path $build 'gg2.gmk'

# gmksplit / gm8x_fix may sit in this repo's tools directory or, following the
# game's own convention, in its Source directory.
$gmksplit = Find-Tool 'gmksplit.exe' @((Join-Path $PSScriptRoot 'tools'), $source)
$gm8x     = Find-Tool 'gm8x_fix.exe' @((Join-Path $PSScriptRoot 'tools'), $source)
$builder  = Join-Path $PSScriptRoot 'tools\gm8_build.ahk'
$ahk      = Find-AutoHotkey

Write-Step "Building $repoFull"

Push-Location $repoFull
try { $before = @(git status --porcelain 2>$null) } finally { Pop-Location }
if ($before.Count -gt 0) {
    Write-Warn "checkout has uncommitted changes before injecting:"
    $before | ForEach-Object { Write-Host "      $_" }
    Write-Warn "continuing, but cleanup will only remove bridge files"
}

& (Join-Path $PSScriptRoot 'inject.ps1') -Repo $repoFull

try {
    # --- clear the build directory ----------------------------------------
    # A game still shutting down, or an open log, keeps a handle here.
    for ($try = 1; $try -le 5 -and (Test-Path $build); $try++) {
        try { Remove-Item $build -Recurse -Force -ErrorAction Stop }
        catch { Write-Skip "build dir busy, retry $try"; Start-Sleep -Seconds 1 }
    }
    if (Test-Path $build) { throw "could not clear $build - is the game still running?" }
    New-Item -ItemType Directory -Path $build | Out-Null

    # --- 2. reassemble the split tree --------------------------------------
    Write-Step "Reassembling source tree"
    Invoke-Native $gmksplit @('gg2', (Join-Path 'build' 'gg2.gmk')) $source
    if (-not (Test-Path $gmkOut)) { throw "gmksplit produced no $gmkOut" }
    Write-Ok "gg2.gmk ($((Get-Item $gmkOut).Length) bytes)"

    # --- 3. compile in the Game Maker 8 IDE --------------------------------
    Write-Step "Compiling in Game Maker 8 (this is the slow part)"
    Invoke-Native $ahk @($builder, $gmkOut, $exeOut) $source
    if (-not (Test-Path $exeOut)) { throw "Game Maker produced no $exeOut" }
    Write-Ok "compiled ($((Get-Item $exeOut).Length) bytes)"

    # --- 4. patch the executable -------------------------------------------
    Write-Step "Patching executable"
    Invoke-Native $gm8x @('-nb', '-s', $exeOut) $source
    Write-Ok "patched"

    # --- 5. package --------------------------------------------------------
    if ($Package) {
        Write-Step "Packaging"
        & (Join-Path $PSScriptRoot 'package.ps1') -Repo $repoFull
    }
}
finally {
    if ($KeepInjected) {
        Write-Warn "leaving bridge injected (-KeepInjected); run cleanup.ps1 before committing"
    } else {
        & (Join-Path $PSScriptRoot 'cleanup.ps1') -Repo $repoFull
    }
}

Write-Step "Done. Launch it with run-agent.ps1"
