# Multi-Agent Observability Desktop - installer (Windows)
#
# Downloads the original project from its author's GitHub (pinned to a tested commit), applies this
# repository's patch (new look, per-session lanes, desktop window mode), installs packages and sets up
# Claude Code hooks plus desktop / Start menu shortcuts.
#
# From a clone:   powershell -ExecutionPolicy Bypass -File install.ps1 [options]
# One line:       & ([scriptblock]::Create((irm https://raw.githubusercontent.com/OWNER/multi-agent-observability-desktop/main/install.ps1)))
# Options:        -InstallDir <path>  -SourceApp <name>  -NoSetup (build only, no hooks/shortcuts)
param(
    [string]$InstallDir = (Join-Path $env:USERPROFILE 'claude-observability'),
    [string]$SourceApp = $env:COMPUTERNAME,
    [switch]$NoSetup,
    # Where this repository lives; used when the script runs without its files around it (one-line install).
    [string]$OverlayRepo = 'https://github.com/OWNER/multi-agent-observability-desktop.git'
)
$ErrorActionPreference = 'Stop'

$Upstream = 'https://github.com/disler/claude-code-hooks-multi-agent-observability.git'
$UpstreamCommit = '8a6e5cf795df50767cea7123703751282a819697'

function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "'$cmd' is required. $hint" }
}
Need git 'Install Git for Windows: https://git-scm.com/download/win'

# Bun: use it if present, otherwise install it with npm. Always call real executables (bun.exe, npm.cmd):
# npm's *.ps1 shims are blocked by Windows' default execution policy.
function Find-Bun {
    $npmBun = Join-Path $env:APPDATA 'npm\node_modules\bun\bin\bun.exe'
    $onPath = Get-Command bun.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    if (Test-Path $npmBun) { return $npmBun }
    $home_ = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
    if (Test-Path $home_) { return $home_ }
    return $null
}
$bun = Find-Bun
if (-not $bun) {
    $npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $npm) { throw 'Bun is required. Install Node.js (https://nodejs.org) or Bun (https://bun.sh), then run this again.' }
    Write-Host 'Installing Bun with npm...'
    & $npm.Source install -g bun | Out-Host
    $bun = Find-Bun
}
if (-not $bun) { throw 'Bun was not found after installation. Open a new terminal and run this again.' }

# This repository's files: next to the script, or a fresh download for the one-line install
$Here = $PSScriptRoot
if (-not $Here -or -not (Test-Path (Join-Path $Here 'patches\observability-desktop.patch'))) {
    $Here = Join-Path $env:TEMP ("multi-agent-observability-desktop-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    Write-Host "Downloading installer files from $OverlayRepo ..."
    git clone --quiet --depth 1 $OverlayRepo $Here
    if ($LASTEXITCODE -ne 0) { throw "Could not download $OverlayRepo" }
}

# 1) Original project at the tested commit
if (Test-Path (Join-Path $InstallDir '.git')) {
    Write-Host "Using existing checkout: $InstallDir"
    git -C $InstallDir fetch --quiet origin
    git -C $InstallDir checkout --quiet -- .
} else {
    Write-Host "Downloading original project into $InstallDir ..."
    git clone --quiet $Upstream $InstallDir
}
git -C $InstallDir checkout --quiet --detach $UpstreamCommit
if ($LASTEXITCODE -ne 0) { throw "Could not check out upstream commit $UpstreamCommit" }

# 2) This repository's changes
Write-Host 'Applying patch...'
git -C $InstallDir apply --whitespace=nowarn (Join-Path $Here 'patches\observability-desktop.patch')
if ($LASTEXITCODE -ne 0) { throw 'Patch did not apply (upstream changed?). Please report an issue.' }
$desktop = Join-Path $InstallDir 'apps\desktop'
New-Item -ItemType Directory -Force $desktop | Out-Null
Copy-Item -Recurse -Force (Join-Path $Here 'desktop\*') $desktop

# 3) Packages
Write-Host 'Installing packages (bun install)...'
& $bun install --cwd (Join-Path $InstallDir 'apps\server') | Out-Host
& $bun install --cwd (Join-Path $InstallDir 'apps\client') | Out-Host

# 4) Build + hooks + shortcuts
if ($NoSetup) {
    Push-Location (Join-Path $InstallDir 'apps\client')
    try { & $bun x vite build | Out-Host } finally { Pop-Location }
    Write-Host "Built only (no hooks, no shortcuts): $InstallDir"
} else {
    & $bun (Join-Path $desktop 'main.ts') --install --source-app $SourceApp
    if ($LASTEXITCODE -ne 0) { throw 'Setup failed.' }
}
