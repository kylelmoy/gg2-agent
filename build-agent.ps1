<#
.SYNOPSIS
    Build a Gang Garrison 2 executable with the agent bridge compiled in.

.DESCRIPTION
    Injects the bridge, runs the public build.bat unchanged, then removes the
    bridge again. The upstream checkout is left exactly as it was found, so the
    public fork never carries the bridge and build.bat stays PR-clean.

    Cleanup runs in a finally block, so a failed or interrupted build still
    leaves the tree clean.

.PARAMETER KeepInjected
    Leave the bridge in the tree after building. Useful while iterating on the
    GML itself; remember to run cleanup.ps1 before committing.

.EXAMPLE
    .\build-agent.ps1
    .\build-agent.ps1 -KeepInjected
#>
param(
    [string]$Repo = (Join-Path $PSScriptRoot '..\Gang-Garrison-2'),
    [switch]$KeepInjected
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$repoFull = (Resolve-Path $Repo).Path
$source = Join-Path $repoFull 'Source'
if (-not (Test-Path (Join-Path $source 'build.bat'))) { throw "build.bat not found in $source" }

# Refuse to start from a dirty tree: cleanup afterwards would be ambiguous.
Push-Location $repoFull
try { $before = @(git status --porcelain 2>$null) } finally { Pop-Location }
if ($before.Count -gt 0) {
    Write-Warn "checkout has uncommitted changes before injecting:"
    $before | ForEach-Object { Write-Host "      $_" }
    Write-Warn "continuing, but cleanup will only remove bridge files"
}

& (Join-Path $PSScriptRoot 'inject.ps1') -Repo $repoFull

try {
    # build.bat's own "rmdir /S /Q build" fails silently if anything still holds
    # a handle there - a game process shutting down, or an open log file - and
    # the build then dies on "A subdirectory or file build already exists".
    $buildDir = Join-Path $source 'build'
    for ($try = 1; $try -le 5 -and (Test-Path $buildDir); $try++) {
        try { Remove-Item $buildDir -Recurse -Force -ErrorAction Stop }
        catch { Write-Skip "build dir busy, retry $try"; Start-Sleep -Seconds 1 }
    }
    if (Test-Path $buildDir) { throw "could not clear $buildDir - is the game still running?" }

    Write-Step "Running build.bat"
    Push-Location $source
    try {
        # build.bat resolves its tools from the current directory; a shell with
        # NoDefaultCurrentDirectoryInExePath set would break that.
        $env:NoDefaultCurrentDirectoryInExePath = ''
        # build.bat writes progress to stderr. Under ErrorActionPreference=Stop
        # PowerShell turns native stderr into a terminating NativeCommandError,
        # so relax it here and judge the result by the exit code instead.
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            cmd /c ".\build.bat < nul" 2>&1 | Out-Null
            $code = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $prev
        }
    } finally {
        Pop-Location
    }

    if ($code -ne 0) { throw "build.bat failed with exit code $code" }

    $exe = Join-Path $source 'build\Gang Garrison 2.exe'
    if (-not (Test-Path $exe)) { throw "build reported success but $exe is missing" }
    Write-Ok "built $exe ($((Get-Item $exe).Length) bytes)"
}
finally {
    if ($KeepInjected) {
        Write-Warn "leaving bridge injected (-KeepInjected); run cleanup.ps1 before committing"
    } else {
        & (Join-Path $PSScriptRoot 'cleanup.ps1') -Repo $repoFull
    }
}

Write-Step "Done. Launch it with run-agent.ps1"
