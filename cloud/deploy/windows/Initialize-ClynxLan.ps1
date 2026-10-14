<#
.SYNOPSIS
  Creates .env.lan (the secrets and settings for the Clynx LAN server). Safe to run again: it NEVER overwrites an existing .env.lan.
.DESCRIPTION
  Generates strong random secrets, picks this computer's LAN address, and writes .env.lan into %USERPROFILE%\ClynxLan, outside the project folder (readable only by your Windows account). Nothing is started and nothing is sent anywhere.
.PARAMETER LanAddress
  The address other computers will use (default: this computer's Wi-Fi/Ethernet IPv4 address). Give a fixed address - set a DHCP reservation in your router so it never changes.
.PARAMETER Port
  The one port the server listens on (default 8788).
.PARAMETER UpdatePublicKeyFile
  Optional: the PUBLIC half of your update signing key (update-public.pem). Without it the server will not accept or serve automatic-update manifests.
#>
param(
  [string]$LanAddress,
  [int]$Port = 8788,
  [string]$UpdatePublicKeyFile,
  [string]$ServerName = "Clynx Cloud (home server)"
)
. (Join-Path $PSScriptRoot "_Common.ps1")

if (Test-Path $script:EnvFile) {
  Write-Warn2 ".env.lan already exists - leaving it exactly as it is. (Delete it yourself only if you want a brand-new server with new secrets; the database would then need the old secrets.)"
  exit 0
}

Write-Step "Choosing this computer's LAN address"
$candidates = @(Get-LanAddresses)
if (-not $LanAddress) {
  if ($candidates.Count -eq 0) { Stop-Script "No network connection with a gateway was found. Connect to your Wi-Fi/Ethernet, or pass -LanAddress." }
  $LanAddress = $candidates[0].Address
  foreach ($c in $candidates) { Write-Host ("    {0,-22} {1}" -f $c.Interface, $c.Address) }
  if ($candidates.Count -gt 1) { Write-Warn2 "More than one network found; using $LanAddress. Pass -LanAddress to choose another." }
}
Write-Ok "LAN address: $LanAddress  (port $Port)"

$hostName = $env:COMPUTERNAME.ToLower()
$origins = @("http://${LanAddress}:$Port", "http://${hostName}:$Port", "http://${hostName}.local:$Port", "http://localhost:$Port", "http://127.0.0.1:$Port") -join ","

$updateKeyLine = "UPDATE_PUBLIC_KEY="
if ($UpdatePublicKeyFile) {
  if (-not (Test-Path $UpdatePublicKeyFile)) { Stop-Script "Cannot find $UpdatePublicKeyFile" }
  $pem = (Get-Content $UpdatePublicKeyFile -Raw)
  if ($pem -notmatch "BEGIN PUBLIC KEY") { Stop-Script "That file is not a PUBLIC key (it must contain BEGIN PUBLIC KEY). Never give the server your private key." }
  $updateKeyLine = "UPDATE_PUBLIC_KEY=" + (($pem.Trim() -replace "`r", "") -replace "`n", "\n")
}

Write-Step "Generating secrets"
$text = @"
# Clynx Cloud - LAN server settings. SECRET: do not share, do not commit (git-ignored), and keep a copy somewhere safe
# (CREDENTIALS_ENCRYPTION_KEY below is the only way to read the OpenAI/eBay keys saved in the console).
LAN_ADDRESS=$LanAddress
LAN_PORT=$Port
SERVER_NAME=$ServerName
PUBLIC_URL=http://${LanAddress}:$Port
ALLOWED_ORIGINS=$origins
POSTGRES_USER=clynx
POSTGRES_DB=clynx_cloud
POSTGRES_PASSWORD=$(New-Secret 24)
REDIS_PASSWORD=$(New-Secret 24)
JWT_ACCESS_SECRET=$(New-Secret 32)
JWT_REFRESH_SECRET=$(New-Secret 32)
METRICS_TOKEN=$(New-Secret 24)
CREDENTIALS_ENCRYPTION_KEY=$(New-Secret 32 base64)
ENFORCE_ENTITLEMENTS=false
# The OpenAI key is NOT stored here. The Owner pastes it in the website console (stored encrypted in the database).
OPENAI_API_KEY=
SMTP_URL=
MAIL_FROM=Clynx <no-reply@clynx.invalid>
SUPPORT_EMAIL=
$updateKeyLine
"@
[System.IO.File]::WriteAllText($script:EnvFile, ($text -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding($false)))

# readable by this Windows account only
try { & icacls $script:EnvFile /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null } catch { Write-Warn2 "Could not restrict the file's permissions: $_" }
Write-Ok "Wrote $script:EnvFile"
Write-Host ""
Write-Host "Next:  .\Start-ClynxLan.ps1" -ForegroundColor Cyan
Write-Host "Back up .env.lan to a safe place that is NOT this computer (a password manager's secure notes is ideal)." -ForegroundColor Yellow
