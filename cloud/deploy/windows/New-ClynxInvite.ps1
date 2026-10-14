<#
.SYNOPSIS
  Creates a one-time invitation code for the private beta (the website console > Invitations does the same). The code is shown ONCE; only a hash is stored.
.EXAMPLE
  .\New-ClynxInvite.ps1 -Email second-pc@example.com -Hours 24 -Note "my second computer"
  .\New-ClynxInvite.ps1 -List
#>
param([string]$Email, [int]$Hours = 72, [string]$Note, [switch]$List, [string]$Revoke)
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
$env:LAN_BIND = (Read-EnvFile)["LAN_ADDRESS"]
$tool = @("exec", "-T", "api", "node", "dist/scripts/invite.js")
if ($List) { Invoke-Compose ($tool + @("list")); exit 0 }
if ($Revoke) { Invoke-Compose ($tool + @("revoke", $Revoke)); exit 0 }
$args2 = @("create", "--hours", "$Hours")
if ($Email) { $args2 += @("--email", $Email) }
if ($Note) { $args2 += @("--note", $Note) }
Invoke-Compose ($tool + $args2)
