# start-full-auto.ps1 — local control-plane entry point.
# Safe by design: installs dependencies if needed, runs the full verification
# (validate + typecheck + tests), and prints honest status. It does NOT perform any
# external action, create a GitHub repo, push, or start active security validation.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\start-full-auto.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== Universal AI Assurance Platform :: start-full-auto ==" -ForegroundColor Cyan
Write-Host "Primary UX is the desktop app. This launcher verifies the local core." -ForegroundColor DarkGray

node --version | ForEach-Object { Write-Host "node $_" }
if (-not (Test-Path (Join-Path $root "node_modules"))) {
  Write-Host "Installing dependencies..." -ForegroundColor Yellow
  npm install
}

Write-Host "Running verification (validate -> typecheck -> test)..." -ForegroundColor Yellow
npm run verify
if ($LASTEXITCODE -ne 0) { Write-Host "VERIFY FAILED." -ForegroundColor Red; exit $LASTEXITCODE }

Write-Host ""
Write-Host "Verification PASSED." -ForegroundColor Green
Write-Host "Desktop control plane:  npm run desktop:dev" -ForegroundColor Cyan
Write-Host "Active security validation remains LOCKED_BY_DESIGN (no authorization on file)." -ForegroundColor DarkYellow
Write-Host ""
Write-Host "Starting session-independent autopilot (recover -> start). Ctrl+C detaches; state persists." -ForegroundColor Cyan
node (Join-Path $root "services/autopilot/cli.mjs") recover
node (Join-Path $root "services/autopilot/cli.mjs") start
