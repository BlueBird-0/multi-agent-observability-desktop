# Claude Observability Desktop — installer (Windows)
#
# Downloads the original project from its author's GitHub (pinned to a tested commit), applies this
# repository's patch (new look, per-session lanes, desktop window mode), installs packages and sets up
# Claude Code hooks plus desktop / Start menu shortcuts.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-InstallDir <path>] [-SourceApp <name>] [-NoSetup]
param(
    [string]$InstallDir = (Join-Path $env:USERPROFILE 'claude-observability'),
    [string]$SourceApp = $env:COMPUTERNAME,
    [switch]$NoSetup   # build only: skip hooks and shortcuts (for testing)
)
$ErrorActionPreference = 'Stop'

$Upstream = 'https://github.com/disler/claude-code-hooks-multi-agent-observability.git'
$UpstreamCommit = '8a6e5cf795df50767cea7123703751282a819697'
$Here = $PSScriptRoot

function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "'$cmd' is required. $hint" }
}
Need git 'Install Git for Windows: https://git-scm.com/download/win'
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Need npm 'Install Node.js (https://nodejs.org) or Bun (https://bun.sh), then run this again.'
    Write-Host 'Installing Bun with npm...'
    npm install -g bun | Out-Host
}
$bun = (Get-Command bun).Source

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
