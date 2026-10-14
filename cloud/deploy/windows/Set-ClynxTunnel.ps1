<#
.SYNOPSIS
  Starts, stops or shows the private HTTPS tunnel to the Clynx server. RUNNING THIS WITH -Action Start MAKES THE SERVER REACHABLE FROM THE INTERNET (behind the sign-in gate). Do it only when you have decided to.
.DESCRIPTION
  Provider "Tailscale" (recommended; free): uses Tailscale Funnel. You need: a free Tailscale account, Tailscale installed on this PC and signed in, and in the Tailscale admin console
  (DNS page) "Enable HTTPS" turned on. Funnel then gives this PC a stable address https://<this-pc>.<your-tailnet>.ts.net with a real certificate, with NO router ports opened.
  The tunnel forwards to the LAN address of the Clynx server (the API listens only there).
  Safety: it refuses to start unless the server is in private mode (Enable-ClynxPrivateAccess.ps1) and reports healthy.
  Commands used: tailscale funnel --bg <url>  /  tailscale funnel status  /  tailscale funnel reset   (https://tailscale.com/kb/1311/tailscale-funnel)
#>
param([Parameter(Mandatory = $true)][ValidateSet("Start", "Stop", "Status")][string]$Action, [ValidateSet("Tailscale")][string]$Provider = "Tailscale")
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-EnvFile
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue)
if (-not $ts) {
  $guess = "C:\Program Files\Tailscale\tailscale.exe"
  if (Test-Path $guess) { $ts = Get-Item $guess } else { Stop-Script "Tailscale is not installed on this PC. Install it from https://tailscale.com/download (free), sign in, then run this again." }
}
$tsExe = if ($ts.PSObject.Properties.Name -contains "Source") { $ts.Source } else { $ts.FullName }
$target = Get-ServerBase

switch ($Action) {
  "Status" { & $tsExe status 2>&1 | Select-Object -First 8; Write-Host ""; & $tsExe funnel status 2>&1 }
  "Stop" { & $tsExe funnel reset 2>&1; Write-Ok "Funnel is off: the server is no longer reachable from the internet." }
  "Start" {
    $e = Read-EnvFile
    if ($e["ACCESS_MODE"] -ne "private") { Stop-Script "The server is not in private mode. Run .\Enable-ClynxPrivateAccess.ps1 first: otherwise the website would be public." }
    try { $info = Invoke-RestMethod -Uri "$target/server/info" -TimeoutSec 5 } catch { Stop-Script "The Clynx server is not answering at $target. Run .\Start-ClynxLan.ps1." }
    if ($info.access -ne "private") { Stop-Script "The running server reports access = $($info.access), not private. Restart it with .\Enable-ClynxPrivateAccess.ps1." }
    Write-Step "Starting the Tailscale Funnel to $target"
    & $tsExe funnel --bg $target 2>&1
    if ($LASTEXITCODE -ne 0) { Stop-Script "Tailscale could not start the funnel. Is HTTPS enabled (admin console > DNS) and Funnel allowed for this device? Run: tailscale funnel status" }
    & $tsExe funnel status 2>&1
    Write-Host ""
    Write-Host "The address above (https://...ts.net) is your private Clynx address. Put exactly that into Enable-ClynxPrivateAccess.ps1 -PublicUrl <address> if you have not yet." -ForegroundColor Green
  }
}
