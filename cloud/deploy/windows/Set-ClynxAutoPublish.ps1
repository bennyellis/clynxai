<#
.SYNOPSIS
  Turns the Owner's standing permission "publish my BETA releases automatically" on or off. While it is ON, Publish-ClynxRelease.ps1 will publish a beta right after preparing it.
.DESCRIPTION
  The permission is a small file (auto-publish-beta.consent) next to the server's settings. It covers the BETA channel only; the stable channel is never published automatically and a release is
  never marked "required" by it. Turning it off (or deleting the file) stops it at once. Nothing else changes.
.EXAMPLE
  .\Set-ClynxAutoPublish.ps1 -On
  .\Set-ClynxAutoPublish.ps1 -Off
  .\Set-ClynxAutoPublish.ps1            (shows whether it is on)
#>
param([switch]$On, [switch]$Off)
. (Join-Path $PSScriptRoot "_Common.ps1")
$file = Join-Path $script:StateDir "auto-publish-beta.consent"
if ($On -and $Off) { Stop-Script "Choose -On or -Off, not both." }
if ($On) {
  New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
  "The Owner allows BETA releases to be published automatically after they are prepared, signed and checked. Given $(Get-Date -Format s). Remove this file or run Set-ClynxAutoPublish.ps1 -Off to stop." | Set-Content -Path $file -Encoding UTF8
  Write-Ok "Automatic publishing of BETA releases is ON ($file)."
} elseif ($Off) {
  Remove-Item $file -Force -ErrorAction SilentlyContinue
  Write-Ok "Automatic publishing is OFF. New releases stay drafts until you publish them in the console."
} else {
  if (Test-Path $file) { Write-Host "Automatic publishing of BETA releases is ON." -ForegroundColor Yellow; Get-Content $file } else { Write-Host "Automatic publishing is OFF." -ForegroundColor Green }
}
