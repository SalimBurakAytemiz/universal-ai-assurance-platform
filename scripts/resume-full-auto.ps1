# resume-full-auto.ps1 — recover durable state and resume the session-independent autopilot.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "== Autopilot recover + resume ==" -ForegroundColor Cyan
node (Join-Path $root "services/autopilot/cli.mjs") recover
node (Join-Path $root "services/autopilot/cli.mjs") resume
Write-Host "Starting the autopilot loop (Ctrl+C to detach; state persists)..." -ForegroundColor Yellow
node (Join-Path $root "services/autopilot/cli.mjs") start
