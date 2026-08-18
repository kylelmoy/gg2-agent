<#
.SYNOPSIS
    Assemble a distributable build.zip, the way upstream's build.bat does.

.DESCRIPTION
    Copies the licences, readme, music, extension packages and the reassembled
    .gmk alongside the built executable, then zips the result with the 7za that
    ships in the game's own Included Files.

    Only needed for a release-shaped artefact. The normal agent loop just wants
    the exe, so build-agent.ps1 skips this unless -Package is passed.

.EXAMPLE
    .\package.ps1
#>
param(
    [string]$Repo = (Join-Path $PSScriptRoot '..\Gang-Garrison-2')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

$repoFull = (Resolve-Path $Repo).Path
$source   = Join-Path $repoFull 'Source'
$build    = Join-Path $source 'build'
$exe      = Join-Path $build 'Gang Garrison 2.exe'

if (-not (Test-Path $exe)) { throw "nothing to package: $exe not found" }

# --- top-level text files ---------------------------------------------------
$texts = @(
    '7zip.license.txt', 'How To Play.txt', 'miniupnp.license.txt',
    'MPL-2.0.txt', 'Readme.txt', 'sampleMapRotation.txt'
)
foreach ($t in $texts) {
    $src = Join-Path $repoFull $t
    if (Test-Path $src) { Copy-Item $src $build -Force } else { Write-Warn "missing $t" }
}
Write-Ok "copied text files"

# --- Source/: the gmk, the extension packages, the uuid helper --------------
$pkgSource = Join-Path $build 'Source'
New-Item -ItemType Directory -Path $pkgSource -Force | Out-Null

$uuid = Join-Path $repoFull 'UUIDGenerator.html'
if (Test-Path $uuid) { Copy-Item $uuid $pkgSource -Force }

$ext = Join-Path $repoFull 'Extensions'
if (Test-Path $ext) {
    Get-ChildItem $ext -Filter '*.gex' | ForEach-Object { Copy-Item $_.FullName $pkgSource -Force }
}

$gmk = Join-Path $build 'gg2.gmk'
if (Test-Path $gmk) { Move-Item $gmk (Join-Path $pkgSource 'Gang Garrison 2.gmk') -Force }
Write-Ok "copied source files"

# --- music ------------------------------------------------------------------
$music = Join-Path $repoFull 'Music'
if (Test-Path $music) {
    Copy-Item $music (Join-Path $build 'Music') -Recurse -Force
    Write-Ok "copied music"
}

# --- zip --------------------------------------------------------------------
$zipTool = Join-Path $source 'gg2\Included Files\7za.exe'
$zipOut = Join-Path $source 'build.zip'
if (Test-Path $zipOut) { Remove-Item $zipOut -Force }

if (Test-Path $zipTool) {
    Invoke-Native $zipTool @('a', '-tzip', $zipOut, (Join-Path $build '*')) $source
} else {
    Write-Warn "7za.exe not found, falling back to Compress-Archive"
    Compress-Archive -Path (Join-Path $build '*') -DestinationPath $zipOut -Force
}

Write-Ok "packaged $zipOut ($([math]::Round((Get-Item $zipOut).Length / 1MB, 1)) MB)"
