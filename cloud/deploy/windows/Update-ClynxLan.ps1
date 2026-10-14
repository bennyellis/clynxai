<#
.SYNOPSIS
  Updates the Clynx LAN server to the code in this folder: backup, build a new image, restart, check health, and go back automatically to the previous image if the new one is not healthy.
.PARAMETER Pull
  Run `git pull --ff-only` first (only if this folder is a git checkout).
.NOTES
  Database migrations are additive (they only add tables/columns), so the previous image keeps working against the upgraded database. The backup taken first is the way back if ever needed.
#>
param([switch]$Pull)
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
$e = Read-EnvFile
$env:LAN_BIND = $e["LAN_ADDRESS"]
$env:LAN_PORT = $e["LAN_PORT"]

Write-Step "Backup before the update"
& (Join-Path $PSScriptRoot "Backup-ClynxLan.ps1") -Label "pre-update" -Keep 30

if ($Pull) {
  Write-Step "git pull"
  & git -C $script:CloudDir pull --ff-only
  if ($LASTEXITCODE -ne 0) { Stop-Script "git pull did not fast-forward; resolve that first. Nothing was changed on the server." }
}

Write-Step "Remembering the current image so we can go back"
& docker image inspect clynx-lan-api:latest *> $null
$hadImage = ($LASTEXITCODE -eq 0)
if ($hadImage) { & docker tag clynx-lan-api:latest clynx-lan-api:previous; Write-Ok "tagged clynx-lan-api:previous" }

Write-Step "Building and restarting"
try {
  Invoke-Compose @("build", "api")
  Invoke-Compose @("up", "-d")
} catch { Write-Warn2 "Build or start failed: $_" }

if (Wait-Healthy (Get-ServerBase) 150) {
  $i = Invoke-RestMethod -Uri "$(Get-ServerBase)/server/info" -TimeoutSec 5
  Write-Host "Updated. Server version $($i.serverVersion), healthy." -ForegroundColor Green
  exit 0
}

Write-Warn2 "The updated server is not healthy."
if ($hadImage) {
  Write-Step "Going back to the previous image"
  & docker tag clynx-lan-api:previous clynx-lan-api:latest
  Invoke-Compose @("up", "-d", "--no-build")
  if (Wait-Healthy (Get-ServerBase) 120) { Write-Host "Rolled back: the previous version is running again. Your data was not touched (backup: backups\lan)." -ForegroundColor Yellow } else { Stop-Script "Still not healthy after rolling back. Run .\Get-ClynxLanStatus.ps1 and see docs; your latest backup is in backups\lan." }
} else { Stop-Script "There was no previous image to go back to. Check the logs: docker compose -f docker-compose.lan.yml logs api" }
exit 1
