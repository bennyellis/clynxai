<#
.SYNOPSIS
  Makes ONE existing account the Owner (full access, no payment, can enter the company OpenAI/eBay keys). The only way to become Owner; it runs on this server computer.
.DESCRIPTION
  1. Register the account normally first (in the desktop app, or on the website at the server address) and note its email.
  2. Run this script with that email. It prints nothing secret to the screen except a one-time code that works for 15 minutes, then asks you to paste that code to confirm.
  Run with -Status to see who the Owner is, or -Revoke to remove the Owner role.
#>
param([string]$Email, [switch]$Status, [switch]$Revoke)
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
$env:LAN_BIND = (Read-EnvFile)["LAN_ADDRESS"]
$owner = @("exec", "-T", "api", "node", "dist/scripts/owner.js")

if ($Status) { Invoke-Compose ($owner + @("status")); exit 0 }
if (-not $Email) { $Email = Read-Host "Email of the account that should become Owner" }
if ($Revoke) { Invoke-Compose ($owner + @("revoke", $Email, "--yes")); exit 0 }

Invoke-Compose ($owner + @("begin", $Email))
$code = Read-Host "Paste the one-time code shown above"
Invoke-Compose ($owner + @("complete", $Email, $code.Trim()))
Write-Host "Done. Sign in again with that account; the console shows 'Owner - Full Access'." -ForegroundColor Green
