<#
.SYNOPSIS
    Inject the agent bridge into a clean Gang Garrison 2 checkout.

.DESCRIPTION
    Copies the AgentBridge object and its scripts into the split source tree and
    makes the three one-line edits the tree needs to see them:

      Objects/_resources.list.xml   register the object
      Scripts/_resources.list.xml   register the script group
      Scripts/Game/game_init.gml    create the instance at startup

    Idempotent: running it twice is harmless. Reverse it with cleanup.ps1.

.EXAMPLE
    .\inject.ps1
    .\inject.ps1 -Repo D:\code\Gang-Garrison-2
#>
param(
    [string]$Repo = (Join-Path $PSScriptRoot '..\Gang-Garrison-2'),
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$gg2 = Resolve-Gg2Tree $Repo
Write-Step "Injecting agent bridge into $gg2" $Quiet

$payload = Join-Path $PSScriptRoot 'payload'

# --- 1. copy the payload ---------------------------------------------------
Copy-Item (Join-Path $payload 'Objects\AgentBridge.xml') (Join-Path $gg2 'Objects') -Force
Copy-Item (Join-Path $payload 'Objects\AgentBridge.events') (Join-Path $gg2 'Objects') -Recurse -Force
Copy-Item (Join-Path $payload 'Scripts\AgentBridge') (Join-Path $gg2 'Scripts') -Recurse -Force
Write-Ok "copied object, events and scripts" $Quiet

# --- 2. register the resources --------------------------------------------
$objList = Join-Path $gg2 'Objects\_resources.list.xml'
if (Add-BeforeLine $objList '</resources>' '  <resource name="AgentBridge" type="RESOURCE"/>') {
    Write-Ok "registered object in Objects/_resources.list.xml" $Quiet
} else {
    Write-Skip "object already registered" $Quiet
}

$scrList = Join-Path $gg2 'Scripts\_resources.list.xml'
if (Add-BeforeLine $scrList '</resources>' '  <resource name="AgentBridge" type="GROUP"/>') {
    Write-Ok "registered script group in Scripts/_resources.list.xml" $Quiet
} else {
    Write-Skip "script group already registered" $Quiet
}

# --- 3. create the instance at startup -------------------------------------
$init = Join-Path $gg2 'Scripts\Game\game_init.gml'
if (Add-AfterLine $init 'loadplugins();' '    instance_create(0, 0, AgentBridge);') {
    Write-Ok "added instance_create to game_init.gml" $Quiet
} else {
    Write-Skip "game_init.gml already patched" $Quiet
}

Write-Step "Injected. Build with build-agent.ps1, or remove with cleanup.ps1." $Quiet
