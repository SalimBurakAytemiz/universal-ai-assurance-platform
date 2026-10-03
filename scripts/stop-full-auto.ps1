# stop-full-auto.ps1 — global stop / kill switch (scaffold).
# Sets autopilot to IDLE and freezes any automation flag. No long-running worker processes
# are managed yet; when they are, this must stop new jobs, cancel cancellable jobs, revoke
# leases, freeze external actions, and preserve audit + evidence.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $root ".ai/autopilot/STATE.json"
'{ "status": "IDLE", "currentNode": null, "startedAt": null, "stoppedAt": "' + (Get-Date -Format o) + '" }' |
  Set-Content -Encoding utf8 $statePath
Write-Host "Autopilot set to IDLE. Audit and evidence are preserved." -ForegroundColor Green
Write-Host "No managed worker processes are currently running in this build." -ForegroundColor DarkGray
