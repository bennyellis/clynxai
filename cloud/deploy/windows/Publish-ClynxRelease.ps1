<#
.SYNOPSIS
  Prepares a BETA release exactly like Register-ClynxRelease.ps1 (stores the installer, checks its SHA-256, signs the update manifest here with your private key, has the server verify it), and
  then PUBLISHES it, but only while the Owner's standing permission is on (Set-ClynxAutoPublish.ps1 -On).
.DESCRIPTION
  Refuses when: the permission file is missing; the version is not a pre-release (beta) version; the version is not newer than every approved or published beta; the SHA-256 differs from
  -ExpectSha256; the server's own checks fail (see publishBetaFromTool in cloud/src/releases/manifestOps.ts). Needs the server code that has the `publish` command (run Update-ClynxLan.ps1
  first). It never marks a release required and never touches the stable channel.
.EXAMPLE
  .\Publish-ClynxRelease.ps1 -Installer ..\..\..\beta-release\Clynx-Beta-Setup-0.3.0-beta.7.exe -Version 0.3.0-beta.7 -ExpectSha256 <hex> -NotesFile ..\..\..\release-notes\0.3.0-beta.7.txt
#>
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$ExpectSha256,
  [string]$NotesFile,
  [string]$IssuesFile,
  [string]$SigningKey = "C:\Users\biggt\ClynxKeys\update-signing\update-private.pem"
)
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
$consent = Join-Path $script:StateDir "auto-publish-beta.consent"
if (-not (Test-Path $consent)) { Stop-Script "Automatic publishing is OFF (no $consent). Use Register-ClynxRelease.ps1 for a draft and publish it in the console, or turn it on with Set-ClynxAutoPublish.ps1 -On." }
if ($Version -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}-[0-9A-Za-z.]{1,20}$') { Stop-Script "Only pre-release (beta) versions such as 0.3.0-beta.7 are published automatically." }
$params = @{ Installer = $Installer; Version = $Version; Channel = "beta"; ExpectSha256 = $ExpectSha256; SigningKey = $SigningKey }
if ($NotesFile) { $params.NotesFile = $NotesFile }
if ($IssuesFile) { $params.IssuesFile = $IssuesFile }
& (Join-Path $PSScriptRoot "Register-ClynxRelease.ps1") @params
if ($LASTEXITCODE -ne 0) { Stop-Script "Preparing the release failed; nothing was published." }
Write-Step "Publishing $Version (beta) under the Owner's standing permission"
$env:LAN_BIND = (Read-EnvFile)["LAN_ADDRESS"]
Invoke-Compose @("exec", "-T", "api", "node", "dist/scripts/release.js", "publish", "--version", $Version, "--channel", "beta")
Write-Host ""
Write-Host "Published $Version. Computers on the beta channel update by themselves." -ForegroundColor Green
