<#
.SYNOPSIS
  Removes a leftover PER-MACHINE ("all users") Clynx registration whose program folder is a temporary test folder. Needs "Run as administrator".
.DESCRIPTION
  A per-machine registration makes every later Clynx installer (even a silent update) ask for administrator rights (a Windows UAC prompt). This happened on this PC because test installs
  were made "for all users". The script touches ONLY a registration whose InstallLocation is inside your temporary folder (...\AppData\Local\Temp\clynx-*), shows what it will remove,
  and asks before deleting. It never touches a normal per-user install, your data (%APPDATA%\Clynx) or any other program.
  Alternative without this script: Settings > Apps > Installed apps > "Clynx (beta)" > Uninstall, and click Yes on the UAC prompt.
#>
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "Right-click PowerShell > Run as administrator, then run this again." -ForegroundColor Red; exit 1 }
$temp = [System.IO.Path]::GetTempPath().TrimEnd("\")
$found = @()
foreach ($root in "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall") {
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ($p.DisplayName -match "^Clynx") { $found += [pscustomobject]@{ Uninstall = $_.PSPath; Guid = $_.PSChildName; Location = $p.InstallLocation; Version = $p.DisplayVersion; Name = $p.DisplayName } }
  }
}
if (-not $found) { Write-Host "No per-machine Clynx registration found. Nothing to do." -ForegroundColor Green; exit 0 }
foreach ($f in $found) {
  Write-Host ("{0} {1}  ->  {2}" -f $f.Name, $f.Version, $f.Location)
  $loc = if ($f.Location) { $f.Location } else { "" }
  if ($loc -notlike "$temp\clynx-*" -and $loc -notlike "*\AppData\Local\Temp\clynx-*") { Write-Host "   Not in a temporary test folder: leaving it alone. (Use Settings > Apps to remove a real install.)" -ForegroundColor Yellow; continue }
  $answer = Read-Host "   Remove this stale registration (and its temporary program folder)? [y/N]"
  if ($answer -ne "y") { continue }
  Remove-Item $f.Uninstall -Recurse -Force
  Remove-Item "HKLM:\SOFTWARE\$($f.Guid)" -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $loc) { Remove-Item $loc -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host "   Removed." -ForegroundColor Green
}
