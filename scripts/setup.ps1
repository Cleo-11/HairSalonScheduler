# One-time setup for running Kataar on this computer.
# Run by double-clicking setup.cmd in the HairSalonScheduler folder.
# Safe to run again: it skips anything already done.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root 'Backend'
$frontend = Join-Path $root 'Frontend'

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host ""; Write-Host "PROBLEM: $msg" -ForegroundColor Red; exit 1 }
function Run($what) {
  # Runs a command line and stops with a clear message if it fails.
  cmd /c $what
  if ($LASTEXITCODE -ne 0) { Fail "'$what' failed (exit code $LASTEXITCODE). Copy the red text above and send it to Claude." }
}
function RandomHex {
  $bytes = New-Object byte[] 32
  (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
  return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}
function WriteUtf8($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

Step 'Checking Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js is not installed. Install the LTS version from https://nodejs.org, then run setup.cmd again.' }
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 22) { Fail "Node.js $(node -v) is too old. Install version 22 or newer from https://nodejs.org." }
Write-Host "Node.js $(node -v) OK"

Step 'Checking Docker'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop, open it, then run setup.cmd again.' }
cmd /c 'docker info >nul 2>&1'
if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop is installed but not running. Open Docker Desktop, wait until it says "Engine running", then run setup.cmd again.' }
Write-Host 'Docker OK'

Step 'Backend settings (.env)'
$envFile = Join-Path $backend '.env'
if (-not (Test-Path $envFile)) {
  $text = [System.IO.File]::ReadAllText((Join-Path $backend '.env.example'))
  $text = $text -replace '(?m)^JWT_SECRET=[ \t]*(?=\r?$)', ("JWT_SECRET=" + (RandomHex))
  $text = $text -replace '(?m)^OTP_HMAC_SECRET=[ \t]*(?=\r?$)', ("OTP_HMAC_SECRET=" + (RandomHex))
  WriteUtf8 $envFile $text
  Write-Host 'Created Backend\.env with fresh secrets (sign-in codes will show in the backend window).'
} else {
  Write-Host 'Backend\.env already exists, leaving it as is.'
}

Step 'Starting the database (first time downloads about 400 MB)'
Push-Location $backend
Run 'docker compose up -d'
Write-Host 'Waiting for the database to be ready' -NoNewline
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  cmd /c 'docker compose exec -T db pg_isready -U salon -d salon_dev >nul 2>&1'
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Write-Host '.' -NoNewline
  Start-Sleep -Seconds 2
}
Write-Host ''
if (-not $ready) { Fail 'The database did not start. In Docker Desktop, check the "backend-db" container logs. If port 5432 is in use, another Postgres is already running on this computer.' }
Write-Host 'Database ready'

Step 'Installing backend packages'
Run 'npm install --no-fund --no-audit'

Step 'Creating tables and demo data'
Run 'npm run db:migrate'
Run 'npm run db:seed -- --demo-queue'
Pop-Location

Step 'Website settings and packages'
Push-Location $frontend
if (-not (Test-Path '.env.local')) { Copy-Item '.env.example' '.env.local'; Write-Host 'Created Frontend\.env.local' }
Run 'npm install --no-fund --no-audit'
Pop-Location

Write-Host ''
Write-Host 'All set. Now double-click start.cmd to run the app.' -ForegroundColor Green
