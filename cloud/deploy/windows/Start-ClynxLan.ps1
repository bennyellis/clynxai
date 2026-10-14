<#
.SYNOPSIS
  Starts (building the first time) the Clynx LAN server: API + website, workers, PostgreSQL, Redis. Existing data is kept.
.PARAMETER NoBuild
  Do not rebuild the image (faster restart).
#>
param([switch]$NoBuild)
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile

$e = Read-EnvFile
$port = if ($e.Contains("LAN_PORT")) { $e["LAN_PORT"] } else { "8788" }
$configured = $e["LAN_ADDRESS"]

# The server listens ONLY on the address stored in .env.lan (never on every network adapter). If this computer's address changed (DHCP), say so instead of silently listening elsewhere.
$present = @(Get-LanAddresses | ForEach-Object { $_.Address })
if ($present -notcontains $configured -and $configured -ne "127.0.0.1") {
  Write-Warn2 "This computer no longer has the address $configured (it now has: $($present -join ', '))."
  Write-Warn2 "Set a fixed address (a DHCP reservation in your router), or run:  .\Set-ClynxLanAddress.ps1 -Address <new address>"
  Stop-Script "Not starting, so the server is not exposed on an unintended address."
}

Write-Step "Starting Clynx LAN server on ${configured}:$port"
$env:LAN_BIND = $configured
$env:LAN_PORT = $port
$extra = @("up", "-d")
if (-not $NoBuild) { $extra += "--build" }
Invoke-Compose $extra

Write-Step "Waiting for the server to become healthy"
$base = "http://${configured}:$port"
if (-not (Wait-Healthy $base 180)) {
  Invoke-Compose @("ps") -AllowFail
  Invoke-Compose @("logs", "--tail", "40", "api") -AllowFail
  Stop-Script "The server did not become healthy within 3 minutes (logs above)."
}
Write-Ok "Healthy: $base"
try { $info = Invoke-RestMethod -Uri "$base/server/info" -TimeoutSec 5; Write-Ok ("{0} version {1}; shared AI: {2}; updates: {3}" -f $info.name, $info.serverVersion, $info.services.sharedAi, $info.services.updates) } catch { }
Write-Host ""
Write-Host "Other computers on your network connect to:   $base" -ForegroundColor Green
Write-Host "Website (this or any computer on the network): $base" -ForegroundColor Green
Write-Host "In the Clynx desktop app: sign-in screen > Advanced > Server address > $base > Test connection." -ForegroundColor Green
