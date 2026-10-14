<#
.SYNOPSIS
  OPTIONAL (needs "Run as administrator"): an inbound Windows Firewall rule that lets ONLY computers on your own subnet reach the Clynx server port. -Remove deletes it.
.DESCRIPTION
  Docker Desktop normally installs its own allow rule, so the port may already be reachable. This rule documents and narrows the intent: TCP <port>, from the local subnet only.
  It does not open PostgreSQL or Redis (those are never published). It does not forward anything from the internet - never forward this port on your router.
  The script also shows your network's category: a "Public" Wi-Fi profile is the strictest; "Private" is what most home networks use.
#>
param([int]$Port = 8788, [switch]$Remove)
. (Join-Path $PSScriptRoot "_Common.ps1")
$name = "Clynx Cloud LAN (TCP $Port)"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Stop-Script "Right-click PowerShell > Run as administrator, then run this again." }
if ($Remove) { Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule; Write-Ok "Removed '$name'"; exit 0 }
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Profile Any | Out-Null
Write-Ok "Created '$name': TCP $Port, from the local subnet only."
Get-NetConnectionProfile | ForEach-Object { Write-Host ("    network '{0}' ({1}) is {2}" -f $_.Name, $_.InterfaceAlias, $_.NetworkCategory) }
