#Requires -Version 5.1
<#
.SYNOPSIS
    typora-plugin-lite · Windows installer
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

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DistDir   = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $ScriptDir))) 'dist'

# --- Check admin ------------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Warn "Not running as administrator. Some installations may fail."
    Write-Warn "Right-click PowerShell and 'Run as Administrator' if needed."
}

# --- Find Typora ------------------------------------------------------------
function Find-Typora {
    $candidates = @(
        'C:\Program Files\Typora'
        'C:\Program Files (x86)\Typora'
        "$env:LOCALAPPDATA\Programs\Typora"
    )

    # Also check registry
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
        if (Test-Path $candidate -PathType Container) {
            return $candidate
        }
    }
    return $null
}

if ([string]::IsNullOrEmpty($Path)) {
    $Path = Find-Typora
    if (-not $Path) {
        Write-Err "Cannot find Typora. Please specify with -Path 'C:\path\to\Typora'"
        exit 1
    }
}

if (-not (Test-Path $Path -PathType Container)) {
    Write-Err "Typora path does not exist: $Path"
    exit 1
}
Write-Info "Found Typora: $Path"

# --- Find window.html -------------------------------------------------------
function Find-Html {
    param($TyporaRoot)
    $candidates = @(
        "$TyporaRoot\resources\app\window.html"
        "$TyporaRoot\resources\appsrc\window.html"
        "$TyporaRoot\resources\window.html"
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate -PathType Leaf) {
            return $candidate
        }
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

# --- Check dist exists (before modifying anything) -------------------------
if (-not (Test-Path $DistDir -PathType Container)) {
    Write-Err "dist\ directory not found at $DistDir"
    Write-Err "Please run 'pnpm build' first."
    exit 1
}

# --- Check if already installed ---------------------------------------------
$ScriptTag = '<script src="./tpl/loader.js" defer="defer"></script>'
$content = Get-Content $HtmlFile -Raw -Encoding UTF8

if ($content.Contains($ScriptTag)) {
    Write-Warn "Plugin already installed. Re-installing..."
    $content = $content.Replace($ScriptTag, '')
}

# --- Backup -----------------------------------------------------------------
$BackupFile = "$HtmlFile.tpl-backup"
if (-not (Test-Path $BackupFile)) {
    Copy-Item $HtmlFile $BackupFile
    Write-Ok "Backup created: $BackupFile"
} else {
    Write-Info "Backup already exists, skipping"
}

# --- Inject script tag ------------------------------------------------------
if ($content.Contains('</body>')) {
    $content = $content.Replace('</body>', "$ScriptTag`n</body>")
} elseif ($content.Contains('</html>')) {
    $content = $content.Replace('</html>', "$ScriptTag`n</html>")
} else {
    $content += "`n$ScriptTag"
}

Set-Content $HtmlFile -Value $content -Encoding UTF8 -NoNewline
Write-Ok "Script tag injected"

# --- Copy dist → tpl\ -------------------------------------------------------
$TplDir = Join-Path $HtmlDir 'tpl'
$PluginsDir = Join-Path $TplDir 'plugins'
if (-not (Test-Path $TplDir)) { New-Item -ItemType Directory -Path $TplDir | Out-Null }
if (-not (Test-Path $PluginsDir)) { New-Item -ItemType Directory -Path $PluginsDir | Out-Null }

# Clean stale builtin plugins only (preserve user-installed third-party plugins)
$Manifest = Join-Path $DistDir 'builtin-plugins.json'
$OldManifest = Join-Path $TplDir 'builtin-plugins.json'
foreach ($mf in @($Manifest, $OldManifest)) {
    if (Test-Path $mf) {
        $builtins = Get-Content $mf -Raw | ConvertFrom-Json
        foreach ($name in $builtins) {
            $pluginPath = Join-Path $PluginsDir $name
            if (Test-Path $pluginPath) {
                Remove-Item $pluginPath -Recurse -Force
            }
        }
    }
}

# Copy core files
foreach ($f in @('loader.js', 'loader.js.map', 'core.js', 'core.js.map', 'builtin-plugins.json')) {
    $src = Join-Path $DistDir $f
    if (Test-Path $src) { Copy-Item $src -Destination $TplDir -Force }
}

# Copy plugin bundles
$DistPlugins = Join-Path $DistDir 'plugins'
if (Test-Path $DistPlugins) {
    Get-ChildItem $DistPlugins -Directory | ForEach-Object {
        Copy-Item $_.FullName -Destination $PluginsDir -Recurse -Force
    }
}
Write-Ok "Plugin files copied to $TplDir"

# --- Done -------------------------------------------------------------------
Write-Host ""
Write-Ok "typora-plugin-lite installed successfully!"
Write-Info "Restart Typora to activate plugins."
Write-Host ""
