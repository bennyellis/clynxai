<#
.SYNOPSIS
  Turns the Clynx server into a PRIVATE BETA: nothing is reachable without signing in, and accounts need an invitation. Optionally tells it the https address a tunnel will serve it on.
.DESCRIPTION
  Changes only these settings in %USERPROFILE%\ClynxLan\.env.lan (a copy of the file is kept first as .env.lan.bak-<time>), then restarts the API and worker (database untouched):
    ACCESS_MODE=private      visitors who are not signed in see only a sign-in page; the website, downloads, update files and the API need a session or a desktop sign-in
    REGISTRATION=invite      an account needs a one-time invitation code (create them in the website console > Invitations, or with New-ClynxInvite.ps1)
  With -PublicUrl https://your-name.example (the address your tunnel gives you):
    PUBLIC_URL / ALLOWED_ORIGINS  include that address (and keep the home-network ones)
    TRUST_PROXY=true             the tunnel forwards visitors; their address and https come from its headers
  This does NOT start any tunnel and does NOT open anything to the internet: that is Set-ClynxTunnel.ps1, a separate decision.
  Existing accounts (your Owner account) keep working, on the home network and through the tunnel. Undo with Disable-ClynxPrivateAccess.ps1.
#>
param([string]$PublicUrl, [ValidateSet("invite", "closed")][string]$Registration = "invite")
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
$e = Read-EnvFile
if ($PublicUrl) {
  if ($PublicUrl -notmatch '^https://[A-Za-z0-9.-]+(:\d+)?/?$') { Stop-Script "-PublicUrl must look like https://name.example (https, no path)." }
  $PublicUrl = $PublicUrl.TrimEnd("/")
}
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $script:EnvFile "$script:EnvFile.bak-$stamp"
try { & icacls "$script:EnvFile.bak-$stamp" /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null } catch { }
Write-Ok "Kept a copy of the current settings: .env.lan.bak-$stamp"

$lanUrl = "http://$($e['LAN_ADDRESS']):$($e['LAN_PORT'])"
$origins = @($e["ALLOWED_ORIGINS"] -split "," | Where-Object { $_ })
if ($PublicUrl -and ($origins -notcontains $PublicUrl)) { $origins += $PublicUrl }
$new = @{ ACCESS_MODE = "private"; REGISTRATION = $Registration; ALLOWED_ORIGINS = ($origins -join ",") }
if ($PublicUrl) { $new["PUBLIC_URL"] = $PublicUrl; $new["TRUST_PROXY"] = "true"; $new["LAN_PUBLIC_URL"] = $lanUrl }
Set-EnvValues $new
$env:LAN_BIND = $e["LAN_ADDRESS"]
$env:LAN_PORT = $e["LAN_PORT"]
$env:TRUST_PROXY = if ($PublicUrl) { "true" } else { "false" }

Write-Step "Restarting the API and worker with the private-beta settings"
Invoke-Compose @("up", "-d", "--force-recreate", "--no-build", "api", "worker")
if (-not (Wait-Healthy (Get-ServerBase) 120)) { Stop-Script "The server is not healthy. Undo with: Copy-Item `"$script:EnvFile.bak-$stamp`" `"$script:EnvFile`"; .\Start-ClynxLan.ps1 -NoBuild" }
$info = Invoke-RestMethod -Uri "$(Get-ServerBase)/server/info" -TimeoutSec 5
Write-Ok "Server says: access = $($info.access), registration = $($info.registration)"
Write-Host ""
Write-Host "Private beta is ON. Home-network address (unchanged): $lanUrl" -ForegroundColor Green
if ($PublicUrl) { Write-Host "Private https address (works only once a tunnel serves it): $PublicUrl" -ForegroundColor Green }
Write-Host "Next: create invitations (website console > Invitations, or .\New-ClynxInvite.ps1 -Email tester@example.com)." -ForegroundColor Cyan
