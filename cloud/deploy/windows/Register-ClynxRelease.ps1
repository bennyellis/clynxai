<#
.SYNOPSIS
  Prepares a release DRAFT on the Clynx server from an installer file on this PC: stores the file, checks its SHA-256 against the value you expect, makes the unsigned update manifest, signs it
  here with your update PRIVATE key (which never leaves this PC), and attaches the signed manifest. It does NOT approve or publish: that stays a deliberate step in the website console.
.EXAMPLE
  .\Register-ClynxRelease.ps1 -Installer ..\..\..\beta-release\Clynx-Beta-Setup-0.3.0-beta.2.exe -Version 0.3.0-beta.2 `
      -ExpectSha256 A59071DC... -NotesFile ..\..\..\beta-release\BETA2_RELEASE_NOTES.txt -IssuesFile ..\..\..\BETA2_KNOWN_ISSUES.md
.PARAMETER SigningKey
  Path to update-private.pem (default C:\Users\biggt\ClynxKeys\update-signing\update-private.pem). Read only by node on this PC to sign; it is never copied into Docker or the repository.
#>
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Version,
  [ValidateSet("beta", "stable")][string]$Channel = "beta",
  [string]$ExpectSha256,
  [string]$NotesFile,
  [string]$IssuesFile,
  [string]$SigningKey = "C:\Users\biggt\ClynxKeys\update-signing\update-private.pem"
)
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
if (-not (Test-Path $Installer)) { Stop-Script "Cannot find $Installer" }
if (-not (Test-Path $SigningKey)) { Stop-Script "Cannot find the update signing key $SigningKey" }
$Installer = (Resolve-Path $Installer).Path
$env:LAN_BIND = (Read-EnvFile)["LAN_ADDRESS"]
$name = Split-Path $Installer -Leaf
$tool = @("exec", "-T", "api", "node", "dist/scripts/release.js")
$tmp = Join-Path $env:TEMP "clynx-release-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $localSha = (Get-FileHash $Installer -Algorithm SHA256).Hash.ToLower()
  Write-Ok "Installer on this PC: $name  SHA-256 $localSha"
  if ($ExpectSha256 -and $localSha -ne $ExpectSha256.ToLower()) { Stop-Script "This file's SHA-256 is NOT the one you expected ($ExpectSha256). Nothing was uploaded." }

  Write-Step "Copying the installer into the server container (temporary)"
  Invoke-Compose @("cp", $Installer, "api:/tmp/$name")
  $draft = @("draft", "--version", $Version, "--channel", $Channel, "--file", "/tmp/$name")
  if ($ExpectSha256) { $draft += @("--expect-sha256", $ExpectSha256.ToLower()) }
  if ($NotesFile) { Invoke-Compose @("cp", (Resolve-Path $NotesFile).Path, "api:/tmp/notes.txt"); $draft += @("--notes-file", "/tmp/notes.txt") }
  if ($IssuesFile) { Invoke-Compose @("cp", (Resolve-Path $IssuesFile).Path, "api:/tmp/issues.txt"); $draft += @("--issues-file", "/tmp/issues.txt") }
  Write-Step "Creating the draft release (the server computes the checksum itself)"
  Invoke-Compose ($tool + $draft)

  Write-Step "Making the update manifest and signing it HERE with your private key"
  $unsigned = Join-Path $tmp "manifest.json"
  $signed = Join-Path $tmp "signed.json"
  $json = & docker @((Get-ComposeArgs) + $tool + @("template", "--version", $Version, "--channel", $Channel)) 2>$null
  if ($LASTEXITCODE -ne 0) { Stop-Script "Could not make the manifest template." }
  [System.IO.File]::WriteAllText($unsigned, ($json -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
  $repo = (Resolve-Path (Join-Path $script:CloudDir "..")).Path
  & node (Join-Path $repo "scripts\update-keys.cjs") sign $SigningKey $unsigned $signed
  if ($LASTEXITCODE -ne 0) { Stop-Script "Signing failed." }
  Invoke-Compose @("cp", $signed, "api:/tmp/signed.json")
  Invoke-Compose ($tool + @("attach", "--version", $Version, "--channel", $Channel, "--file", "/tmp/signed.json"))
  Write-Host ""
  Write-Host "Done: $Version ($Channel) is a DRAFT with a verified signed manifest. Nobody can see or download it yet." -ForegroundColor Green
  Write-Host "To release it: website console > Releases > $Version > Approve, then Publish (type the version)." -ForegroundColor Cyan
} finally {
  Invoke-Compose @("exec", "-T", "api", "sh", "-c", "rm -f /tmp/$name /tmp/notes.txt /tmp/issues.txt /tmp/signed.json") -AllowFail
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
