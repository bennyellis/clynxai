<#
.SYNOPSIS
  Changes the LAN address the Clynx server listens on (use when your router gave this computer a new address). Updates .env.lan; then run Start-ClynxLan.ps1.
  Every desktop app must then be pointed at the new address - which is why a DHCP reservation in the router (a fixed address for this computer) is strongly recommended.
#>
param([Parameter(Mandatory = $true)][string]$Address)
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-EnvFile
$present = @(Get-LanAddresses | ForEach-Object { $_.Address })
if ($present -notcontains $Address) { Stop-Script "This computer does not have the address $Address (it has: $($present -join ', '))." }
$e = Read-EnvFile
$port = $e["LAN_PORT"]
$hostName = $env:COMPUTERNAME.ToLower()
$origins = @("http://${Address}:$port", "http://${hostName}:$port", "http://${hostName}.local:$port", "http://localhost:$port", "http://127.0.0.1:$port") -join ","
Set-EnvValues @{ LAN_ADDRESS = $Address; PUBLIC_URL = "http://${Address}:$port"; ALLOWED_ORIGINS = $origins }
Write-Ok "Now http://${Address}:$port . Run .\Start-ClynxLan.ps1"
