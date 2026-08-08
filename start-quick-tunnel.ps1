$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cloudflaredPath = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$envPath = Join-Path $projectDir '.env'
$runtimeDir = Join-Path $projectDir '.runtime'

if (-not (Test-Path -LiteralPath $cloudflaredPath)) {
  throw "cloudflared was not found at: $cloudflaredPath"
}
if (-not (Test-Path -LiteralPath $envPath)) {
  throw ".env was not found at: $envPath"
}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

Write-Host 'Stopping the previous Quick Tunnel (if any)...' -ForegroundColor Cyan
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq 'cloudflared.exe' -and
    $_.CommandLine -match 'tunnel\s+--url\s+http://localhost:3000'
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$tunnelOutLog = Join-Path $runtimeDir "cloudflared-$stamp.out.log"
$tunnelErrLog = Join-Path $runtimeDir "cloudflared-$stamp.err.log"

Write-Host 'Creating a new trycloudflare.com URL...' -ForegroundColor Cyan
Start-Process -FilePath $cloudflaredPath `
  -ArgumentList @('tunnel', '--url', 'http://localhost:3000', '--no-autoupdate') `
  -WindowStyle Hidden `
  -RedirectStandardOutput $tunnelOutLog `
  -RedirectStandardError $tunnelErrLog | Out-Null

$publicUrl = $null
for ($attempt = 1; $attempt -le 45 -and -not $publicUrl; $attempt++) {
  Start-Sleep -Seconds 1
  $tunnelOutput = ''
  if (Test-Path -LiteralPath $tunnelOutLog) {
    $tunnelOutput += Get-Content -LiteralPath $tunnelOutLog -Raw -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $tunnelErrLog) {
    $tunnelOutput += Get-Content -LiteralPath $tunnelErrLog -Raw -ErrorAction SilentlyContinue
  }
  $urlMatch = [regex]::Match($tunnelOutput, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($urlMatch.Success) { $publicUrl = $urlMatch.Value }
}

if (-not $publicUrl) {
  Write-Host "Cloudflare log: $tunnelErrLog" -ForegroundColor Yellow
  throw 'Cloudflare did not return a Quick Tunnel URL within 45 seconds.'
}

$envContent = [IO.File]::ReadAllText($envPath)
if ($envContent -match '(?m)^PUBLIC_URL=.*$') {
  $envContent = [regex]::Replace($envContent, '(?m)^PUBLIC_URL=.*$', "PUBLIC_URL=$publicUrl")
} else {
  $envContent = $envContent.TrimEnd() + [Environment]::NewLine + "PUBLIC_URL=$publicUrl" + [Environment]::NewLine
}
[IO.File]::WriteAllText($envPath, $envContent, [Text.UTF8Encoding]::new($false))

Write-Host "PUBLIC_URL updated: $publicUrl" -ForegroundColor Green
Write-Host 'Restarting the Node server...' -ForegroundColor Cyan

$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $processes = Get-CimInstance Win32_Process
  $byId = @{}
  foreach ($process in $processes) { $byId[[int]$process.ProcessId] = $process }
  $idsToStop = [Collections.Generic.List[int]]::new()
  $currentId = [int]$listener.OwningProcess
  for ($depth = 0; $depth -lt 5 -and $currentId -gt 0; $depth++) {
    $process = $byId[$currentId]
    if (-not $process) { break }
    $command = [string]$process.CommandLine
    if ($depth -eq 0 -or $command -match 'src/server\.js|nodemon|npm-cli\.js.+run dev') {
      $idsToStop.Add($currentId)
      $currentId = [int]$process.ParentProcessId
    } else {
      break
    }
  }
  foreach ($processId in $idsToStop) {
    Stop-Process -Id $processId -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
}

$serverOutLog = Join-Path $runtimeDir "server-$stamp.out.log"
$serverErrLog = Join-Path $runtimeDir "server-$stamp.err.log"
Start-Process -FilePath 'C:\Program Files\nodejs\npm.cmd' `
  -ArgumentList @('run', 'dev') `
  -WorkingDirectory $projectDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $serverOutLog `
  -RedirectStandardError $serverErrLog | Out-Null

$serverReady = $false
for ($attempt = 1; $attempt -le 30 -and -not $serverReady; $attempt++) {
  Start-Sleep -Seconds 1
  $serverReady = [bool](Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
}

if (-not $serverReady) {
  Write-Host "Server log: $serverErrLog" -ForegroundColor Yellow
  throw 'The Node server did not start on port 3000.'
}

Write-Host ''
Write-Host 'Application and Telegram webhook are ready.' -ForegroundColor Green
Write-Host "Employee link: $publicUrl" -ForegroundColor Green
Write-Host 'Sending the new link to the configured Telegram accounts...' -ForegroundColor Cyan
& 'C:\Program Files\nodejs\node.exe' (Join-Path $projectDir 'src\scripts\notifyTunnelUrl.js') $publicUrl
if ($LASTEXITCODE -ne 0) {
  Write-Host 'The application is running, but one or more link notifications failed. Check the messages above.' -ForegroundColor Yellow
}
Write-Host "Runtime logs: $runtimeDir" -ForegroundColor DarkGray
