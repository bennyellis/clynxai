<#
.SYNOPSIS
  Stops the Clynx LAN server. Data (database, installers, Redis) is kept in Docker volumes. Add -Down to also remove the containers (still keeps the data).
  This script never deletes volumes.
#>
param([switch]$Down)
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
$env:LAN_BIND = (Read-EnvFile)["LAN_ADDRESS"]
if ($Down) { Invoke-Compose @("down") } else { Invoke-Compose @("stop") }
Write-Ok "Stopped. Your data is untouched (docker volumes clynx-lan_pg_data, clynx-lan_redis_data, clynx-lan_releases_data)."
