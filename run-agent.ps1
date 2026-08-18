<#
.SYNOPSIS
    Launch the built game with the agent bridge listening.

.DESCRIPTION
    Starts the game through tools/gg2_agent.ahk, which stays resident and
    dismisses GM8 message boxes. Then waits for the bridge to accept
    connections, so the script only returns once the game is actually driveable.

.EXAMPLE
    .\run-agent.ps1
    .\run-agent.ps1 -Port 17777
#>
param(
    [string]$Repo = (Join-Path $PSScriptRoot '..\Gang-Garrison-2'),
    [int]$Port = 17777,
    [string]$Ahk = 'C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe',
    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$exe = Join-Path (Resolve-Path $Repo).Path 'Source\build\Gang Garrison 2.exe'
if (-not (Test-Path $exe)) { throw "game not built: $exe (run build-agent.ps1 first)" }
if (-not (Test-Path $Ahk)) { throw "AutoHotkey v2 not found: $Ahk" }

# Wait for any previous instance to fully exit. Launching while the old process
# is still dying gives a sharing violation on the exe.
Get-Process -Name 'Gang Garrison 2' -ErrorAction SilentlyContinue | Stop-Process -Force
for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-Process -Name 'Gang Garrison 2' -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
}

$launcher = Join-Path $PSScriptRoot 'tools\gg2_agent.ahk'
Write-Step "Launching $exe"
# Quote explicitly: Windows PowerShell joins an -ArgumentList array with spaces
# and does not quote the elements, which splits the exe path at "Gang Garrison".
Start-Process $Ahk -ArgumentList "`"$launcher`" `"$exe`" -agentport $Port"

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $c.Connect('127.0.0.1', $Port)
        $c.Close()
        Write-Ok "bridge is accepting connections on 127.0.0.1:$Port"
        exit 0
    } catch {
        # not up yet
    } finally {
        $c.Dispose()
    }
}

Write-Fail "bridge did not come up within ${TimeoutSeconds}s"
$build = Join-Path (Resolve-Path $Repo).Path 'Source\build'
foreach ($n in 'agent_launcher.log', 'agent_bridge.log', 'game_errors.log') {
    $p = Join-Path $build $n
    if (Test-Path $p) { Write-Host "--- $n ---"; Get-Content $p -Tail 20 }
}
exit 1
