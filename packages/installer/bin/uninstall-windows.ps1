#Requires -Version 5.1
<#
.SYNOPSIS
    typora-plugin-lite · Windows uninstaller
.PARAMETER Path
    Custom Typora installation path
.PARAMETER Silent
    Suppress prompts
#>
param(
    [Alias('p')]
    [string] $Path,
    [switch] $Silent
)

$ErrorActionPreference = 'Stop'

function Write-Info  { param($m) Write-Host "[info]  $m" -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host "[ok]    $m" -ForegroundColor Green }
function Write-Warn  { param($m) Write-Host "[warn]  $m" -ForegroundColor Yellow }
function Write-Err   { param($m) Write-Host "[error] $m" -ForegroundColor Red }

# --- Find Typora ------------------------------------------------------------
function Find-Typora {
    $candidates = @(
        'C:\Program Files\Typora'
        'C:\Program Files (x86)\Typora'
        "$env:LOCALAPPDATA\Programs\Typora"
    )
    $regPaths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($regPath in $regPaths) {
        try {
            Get-ItemProperty $regPath -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -like '*Typora*' } |
                ForEach-Object {
                    if ($_.InstallLocation) { $candidates += $_.InstallLocation }
                }
        } catch {}
    }
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate -PathType Container) { return $candidate }
    }
    return $null
}

if ([string]::IsNullOrEmpty($Path)) {
    $Path = Find-Typora
    if (-not $Path) {
        Write-Err "Cannot find Typora. Use -Path to specify."
        exit 1
    }
}

# --- Find window.html -------------------------------------------------------
function Find-Html {
    param($TyporaRoot)
    $candidates = @(
        "$TyporaRoot\resources\app\window.html"
        "$TyporaRoot\resources\appsrc\window.html"
        "$TyporaRoot\resources\window.html"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c -PathType Leaf) { return $c }
    }
    return $null
}

$HtmlFile = Find-Html -TyporaRoot $Path
if (-not $HtmlFile) {
    Write-Err "Cannot find Typora window.html in $Path"
    exit 1
}
$HtmlDir = Split-Path -Parent $HtmlFile
Write-Info "Found HTML: $HtmlFile"

# --- Restore from backup or remove script tag --------------------------------
$BackupFile = "$HtmlFile.tpl-backup"
$ScriptTag  = '<script src="./tpl/loader.js" defer="defer"></script>'

if (Test-Path $BackupFile) {
    Copy-Item $BackupFile $HtmlFile -Force
    Remove-Item $BackupFile
    Write-Ok "Restored from backup"
} else {
    $content = Get-Content $HtmlFile -Raw -Encoding UTF8
    if ($content.Contains($ScriptTag)) {
        $content = $content.Replace($ScriptTag, '')
        Set-Content $HtmlFile -Value $content -Encoding UTF8 -NoNewline
        Write-Ok "Script tag removed"
    } else {
        Write-Info "No injected script tag found"
    }
}

# --- Remove tpl\ directory --------------------------------------------------
$TplDir = Join-Path $HtmlDir 'tpl'
if (Test-Path $TplDir) {
    Remove-Item $TplDir -Recurse -Force
    Write-Ok "Removed $TplDir"
}

Write-Host ""
Write-Ok "typora-plugin-lite uninstalled successfully!"
Write-Info "Restart Typora to complete."
Write-Host ""
