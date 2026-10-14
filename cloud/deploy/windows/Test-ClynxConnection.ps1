<#
.SYNOPSIS
  Run this on the OTHER computer (it needs only Windows PowerShell - no Docker, no Node) to find out why it cannot reach the Clynx server.
.EXAMPLE
  .\Test-ClynxConnection.ps1 -Server http://10.0.0.81:8788
#>
param([Parameter(Mandatory = $true)][string]$Server)
$ErrorActionPreference = "Continue"
$uri = [Uri]($(if ($Server -match "^https?://") { $Server } else { "http://$Server" }))
Write-Host "Server: $uri"
Write-Host "1. Name/address lookup ..." -NoNewline
try { $ips = [System.Net.Dns]::GetHostAddresses($uri.Host); Write-Host " OK ($($ips -join ', '))" -ForegroundColor Green } catch { Write-Host " FAILED - the name '$($uri.Host)' is not known on this network. Use the numeric address (like 10.0.0.81) instead." -ForegroundColor Red; exit 1 }
Write-Host "2. Can this computer reach the port ..." -NoNewline
$t = Test-NetConnection -ComputerName $uri.Host -Port $uri.Port -WarningAction SilentlyContinue
if ($t.TcpTestSucceeded) { Write-Host " OK" -ForegroundColor Green } else {
  Write-Host " FAILED" -ForegroundColor Red
  Write-Host "   - Is the server computer on, with Docker running and 'Start-ClynxLan.ps1' done?"
  Write-Host "   - Are both computers on the SAME Wi-Fi/network (not a guest network)? Guest networks usually block computers from reaching each other."
  Write-Host "   - Has the server computer's address changed? Run .\Get-ClynxLanStatus.ps1 there."
  exit 1
}
Write-Host "3. Is it a Clynx server ..." -NoNewline
try {
  $i = Invoke-RestMethod -Uri "$($uri.GetLeftPart('Authority'))/server/info" -TimeoutSec 8
  if ($i.product -ne "clynx-cloud") { throw "not a Clynx server" }
  Write-Host " OK  ($($i.name), version $($i.serverVersion))" -ForegroundColor Green
  Write-Host "   Shared AI: $($i.services.sharedAi)   Shared eBay: $($i.services.sharedEbay)   Automatic updates: $($i.services.updates)"
} catch { Write-Host " FAILED - something answered, but it is not a Clynx server ($($_.Exception.Message))." -ForegroundColor Red; exit 1 }
Write-Host ""
Write-Host "All good. In Clynx: sign-in screen > Advanced > Server address > $($uri.GetLeftPart('Authority')) > Test connection." -ForegroundColor Green
