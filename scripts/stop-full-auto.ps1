# stop-full-auto.ps1 — stop the session-independent autopilot service (global stop / kill switch).
# Signals the running autopilot loop to exit, preserving all durable job state, audit and evidence.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
node (Join-Path $root "services/autopilot/cli.mjs") stop
Write-Host "Autopilot stop requested. Durable state in .ai/autopilot/jobs.json is preserved." -ForegroundColor Green
