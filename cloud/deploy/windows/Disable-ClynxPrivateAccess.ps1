<#
.SYNOPSIS
  Puts the Clynx server back to the Phase 11 behaviour (open website, open registration, no proxy assumptions). A copy of the settings is kept first. Does not touch accounts or data.
  Also run Set-ClynxTunnel.ps1 -Action Stop if a tunnel is on: with the gate off, the website would be public.
#>
param([switch]$Force)
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
$e = Read-EnvFile
if (-not $Force -and $e.Contains("PUBLIC_URL") -and $e["PUBLIC_URL"] -like "https://*") {
  Stop-Script "A public https address is configured ($($e['PUBLIC_URL'])). Stop the tunnel first (Set-ClynxTunnel.ps1 -Action Stop), then run this again with -Force."
}
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $script:EnvFile "$script:EnvFile.bak-$stamp"
try { & icacls "$script:EnvFile.bak-$stamp" /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null } catch { }
$lan = "http://$($e['LAN_ADDRESS']):$($e['LAN_PORT'])"
$hostName = $env:COMPUTERNAME.ToLower()
$port = $e["LAN_PORT"]
$origins = @("http://$($e['LAN_ADDRESS']):$port", "http://${hostName}:$port", "http://${hostName}.local:$port", "http://localhost:$port", "http://127.0.0.1:$port") -join ","
Set-EnvValues @{ ACCESS_MODE = "open"; REGISTRATION = "open"; TRUST_PROXY = "false"; PUBLIC_URL = $lan; ALLOWED_ORIGINS = $origins }
$env:LAN_BIND = $e["LAN_ADDRESS"]
$env:LAN_PORT = $port
$env:TRUST_PROXY = "false"
Invoke-Compose @("up", "-d", "--force-recreate", "--no-build", "api", "worker")
if (Wait-Healthy (Get-ServerBase) 120) { Write-Host "Back to the open home-network behaviour. Previous settings: .env.lan.bak-$stamp" -ForegroundColor Yellow } else { Stop-Script "Not healthy; restore with Copy-Item `"$script:EnvFile.bak-$stamp`" `"$script:EnvFile`" and run .\Start-ClynxLan.ps1 -NoBuild" }
