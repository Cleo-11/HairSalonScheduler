# Starts the database, the backend and the website, then opens the browser.
# Run by double-clicking start.cmd. Close the two new windows to stop.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'Backend'
$frontend = Join-Path $root 'Frontend'

if (-not (Test-Path (Join-Path $backend '.env')) -or -not (Test-Path (Join-Path $frontend 'node_modules'))) {
  Write-Host 'Setup has not been run yet. Double-click setup.cmd first.' -ForegroundColor Red
  exit 1
}

cmd /c 'docker info >nul 2>&1'
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Docker Desktop is not running. Open it, wait until it says "Engine running", then try again.' -ForegroundColor Red
  exit 1
}

Write-Host 'Starting the database...'
Push-Location $backend
cmd /c 'docker compose up -d'
Pop-Location

function Open-Window($title, $dir, $command) {
  $ps = "`$host.UI.RawUI.WindowTitle = '$title'; Set-Location '$dir'; $command"
  Start-Process powershell -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $ps | Out-Null
}

Write-Host 'Starting the backend (sign-in codes appear in its window)...'
# Apply any new database changes first (safe to repeat), retrying while the database finishes starting.
Open-Window 'Kataar backend - sign-in codes show here' $backend 'for ($i = 0; $i -lt 30; $i++) { npm run db:migrate; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Seconds 2 }; npm run dev'

Write-Host 'Starting the website...'
Open-Window 'Kataar website' $frontend 'npm run dev'

Write-Host 'Waiting for the website to come up' -NoNewline
$up = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    Invoke-WebRequest -Uri 'http://localhost:3001/login' -UseBasicParsing -TimeoutSec 5 | Out-Null
    $up = $true; break
  } catch { Write-Host '.' -NoNewline; Start-Sleep -Seconds 2 }
}
Write-Host ''
if ($up) {
  Start-Process 'http://localhost:3001'
  Start-Process 'http://localhost:3001/staff/login'
  Write-Host ''
  Write-Host 'Running. Two browser tabs are open:' -ForegroundColor Green
  Write-Host '  Customer app : http://localhost:3001  (the 6-digit code shows in the backend window)'
  Write-Host '  Dashboard    : http://localhost:3001/staff/login  desk@demo-salon.test / salon-demo-1234'
  Write-Host ''
  Write-Host 'To stop: close the "Kataar backend" and "Kataar website" windows.'
} else {
  Write-Host 'The website did not start within 2 minutes. Check the "Kataar website" and "Kataar backend" windows for red errors and send them to Claude.' -ForegroundColor Red
}
