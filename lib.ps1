# Shared helpers for inject.ps1 / cleanup.ps1 / build-agent.ps1.
#
# All file edits go through here so two things stay true across the split
# source tree: line endings are preserved exactly, and UTF-8 files are written
# without a BOM. GmkSplitter parses these files as XML, and a stray BOM or a
# flipped line ending shows up as noise in every future diff.

function Resolve-Gg2Tree([string]$Repo) {
    if (-not (Test-Path $Repo)) { throw "repo not found: $Repo" }
    $full = (Resolve-Path $Repo).Path
    $tree = Join-Path $full 'Source\gg2'
    if (-not (Test-Path (Join-Path $tree 'Objects\_resources.list.xml'))) {
        throw "does not look like a Gang Garrison 2 checkout: $full"
    }
    return $tree
}

function Get-TextRaw([string]$Path) {
    return [System.IO.File]::ReadAllText($Path)
}

function Set-TextRaw([string]$Path, [string]$Text) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Get-Newline([string]$Text) {
    if ($Text -match "`r`n") { return "`r`n" } else { return "`n" }
}

# Insert $Insert immediately before the first line whose trimmed text equals
# $Anchor. Returns $true if the file changed, $false if $Insert was present.
function Add-BeforeLine([string]$Path, [string]$Anchor, [string]$Insert) {
    $text = Get-TextRaw $Path
    if ($text -match [regex]::Escape($Insert.Trim())) { return $false }
    $nl = Get-Newline $text
    $lines = $text -split "`r?`n"
    $out = New-Object System.Collections.Generic.List[string]
    $done = $false
    foreach ($l in $lines) {
        if (-not $done -and $l.Trim() -eq $Anchor) {
            $out.Add($Insert)
            $done = $true
        }
        $out.Add($l)
    }
    if (-not $done) { throw "anchor '$Anchor' not found in $Path" }
    Set-TextRaw $Path ($out -join $nl)
    return $true
}

# Insert $Insert immediately after the first line whose trimmed text equals
# $Anchor. Returns $true if the file changed.
function Add-AfterLine([string]$Path, [string]$Anchor, [string]$Insert) {
    $text = Get-TextRaw $Path
    if ($text -match [regex]::Escape($Insert.Trim())) { return $false }
    $nl = Get-Newline $text
    $lines = $text -split "`r?`n"
    $out = New-Object System.Collections.Generic.List[string]
    $done = $false
    foreach ($l in $lines) {
        $out.Add($l)
        if (-not $done -and $l.Trim() -eq $Anchor) {
            $out.Add($Insert)
            $done = $true
        }
    }
    if (-not $done) { throw "anchor '$Anchor' not found in $Path" }
    Set-TextRaw $Path ($out -join $nl)
    return $true
}

# Remove every line whose trimmed text equals $Line. Returns $true if changed.
function Remove-Line([string]$Path, [string]$Line) {
    if (-not (Test-Path $Path)) { return $false }
    $text = Get-TextRaw $Path
    $nl = Get-Newline $text
    $lines = $text -split "`r?`n"
    $kept = @($lines | Where-Object { $_.Trim() -ne $Line.Trim() })
    if ($kept.Count -eq $lines.Count) { return $false }
    Set-TextRaw $Path ($kept -join $nl)
    return $true
}

function Write-Step([string]$m, [bool]$Quiet = $false) { if (-not $Quiet) { Write-Host "[*] $m" -ForegroundColor Cyan } }
function Write-Ok  ([string]$m, [bool]$Quiet = $false) { if (-not $Quiet) { Write-Host "[+] $m" -ForegroundColor Green } }
function Write-Skip([string]$m, [bool]$Quiet = $false) { if (-not $Quiet) { Write-Host "[=] $m" -ForegroundColor DarkGray } }
function Write-Warn([string]$m)                 { Write-Host "[-] $m" -ForegroundColor Yellow }
function Write-Fail([string]$m)                 { Write-Host "[!] $m" -ForegroundColor Red }
