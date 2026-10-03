# resume-full-auto.ps1 — show the next READY work and how to continue.
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
Write-Host "== NEXT ACTIONS ==" -ForegroundColor Cyan
Get-Content (Join-Path $root ".ai/NEXT_ACTIONS.md")
