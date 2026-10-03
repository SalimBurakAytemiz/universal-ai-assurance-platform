# status-full-auto.ps1 — print honest local status (git + build graph + last test run).
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== STATUS ==" -ForegroundColor Cyan
Write-Host "-- git --" -ForegroundColor DarkGray
git branch --show-current
git status --short
git log --oneline -3

$graphPath = Join-Path $root ".ai/BUILD_GRAPH.json"
if (Test-Path $graphPath) {
  $g = Get-Content $graphPath -Raw | ConvertFrom-Json
  $by = @{}
  foreach ($n in $g.nodes) { $by[$n.status] = 1 + ($by[$n.status] | ForEach-Object { $_ }) }
  Write-Host "-- build graph --" -ForegroundColor DarkGray
  Write-Host ("nodes: {0}" -f $g.nodes.Count)
  $g.nodes | Group-Object status | ForEach-Object { Write-Host ("  {0}: {1}" -f $_.Name, $_.Count) }
}
Write-Host "-- active security validation --" -ForegroundColor DarkGray
$m = Get-Content (Join-Path $root ".ai/MASTER_STATE.json") -Raw | ConvertFrom-Json
Write-Host ("  {0}" -f $m.activeSecurityValidation.state)
