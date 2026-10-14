# Shared helpers for the Clynx LAN server scripts (Windows PowerShell 5.1 or PowerShell 7). Dot-sourced by the other scripts; not meant to be run by itself.
Set-StrictMode -Version 2.0
# (docker writes progress to stderr, which Windows PowerShell 5.1 would treat as an error under "Stop"; every command below checks its exit code instead)
$ErrorActionPreference = "Continue"

$script:CloudDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$script:ComposeFile = Join-Path $script:CloudDir "docker-compose.lan.yml"
# Secrets and backups live OUTSIDE the project folder (which may be synced to OneDrive/Dropbox): by default in %USERPROFILE%\ClynxLan (override with $env:CLYNX_LAN_DIR).
$script:StateDir = if ($env:CLYNX_LAN_DIR) { $env:CLYNX_LAN_DIR } else { Join-Path $env:USERPROFILE "ClynxLan" }
New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null
$script:EnvFile = Join-Path $script:StateDir ".env.lan"
$script:BackupDir = if ($env:CLYNX_BACKUP_DIR) { $env:CLYNX_BACKUP_DIR } else { Join-Path $script:StateDir "backups" }

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Write-Warn2([string]$text) { Write-Host "    !!  $text" -ForegroundColor Yellow }
function Stop-Script([string]$text) { Write-Host "    ERROR  $text" -ForegroundColor Red; exit 1 }

function Assert-Docker {
  $null = & docker version --format "{{.Server.Version}}" 2>$null
  if ($LASTEXITCODE -ne 0) { Stop-Script "Docker is not running. Start Docker Desktop, wait until it says 'Engine running', and try again." }
}

function Read-EnvFile([string]$path = $script:EnvFile) {
  $map = [ordered]@{}
  if (-not (Test-Path $path)) { return $map }
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $i = $line.IndexOf("=")
    $map[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim()
  }
  return $map
}

function Set-EnvValues([hashtable]$values, [string]$path = $script:EnvFile) {
  $lines = if (Test-Path $path) { @(Get-Content $path) } else { @() }
  foreach ($k in $values.Keys) {
    $found = $false
    for ($n = 0; $n -lt $lines.Count; $n++) {
      if ($lines[$n] -match "^\s*$([regex]::Escape($k))\s*=") { $lines[$n] = "$k=$($values[$k])"; $found = $true; break }
    }
    if (-not $found) { $lines += "$k=$($values[$k])" }
  }
  [System.IO.File]::WriteAllText($path, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

function New-Secret([int]$bytes = 32, [string]$format = "hex") {
  $buf = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buf)
  $rng.Dispose()
  if ($format -eq "base64") { return [Convert]::ToBase64String($buf) }
  return ([BitConverter]::ToString($buf) -replace "-", "").ToLower()
}

# The computer's usable LAN addresses (not loopback, not link-local, not virtual adapters such as WSL / Docker / VPN).
function Get-LanAddresses {
  $result = @()
  $configs = Get-NetIPConfiguration | Where-Object { $_.IPv4Address -and $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq "Up" }
  foreach ($c in $configs) {
    $name = $c.InterfaceAlias
    if ($name -match "vEthernet|WSL|Docker|VirtualBox|VMware|Hyper-V|Loopback|VPN|Tailscale|ZeroTier|OpenVPN|WireGuard") { continue }
    foreach ($a in $c.IPv4Address) {
      if ($a.IPAddress -match "^169\.254\.|^127\.") { continue }
      $result += [pscustomobject]@{ Interface = $name; Address = $a.IPAddress; PrefixLength = $a.PrefixLength }
    }
  }
  return $result
}

# CLYNX_COMPOSE_PROJECT / CLYNX_IMAGE let a second, throw-away copy of the stack run beside the real one (used by the test procedures); normally unset.
$script:Image = if ($env:CLYNX_IMAGE) { $env:CLYNX_IMAGE } else { "clynx-lan-api:latest" }
function Get-ComposeArgs {
  $env:CLYNX_ENV_FILE = $script:EnvFile
  $a = @("compose")
  if ($env:CLYNX_COMPOSE_PROJECT) { $a += @("-p", $env:CLYNX_COMPOSE_PROJECT) }
  return $a + @("-f", $script:ComposeFile, "--env-file", $script:EnvFile)
}

function Invoke-Compose([string[]]$arguments, [switch]$AllowFail) {
  $all = (Get-ComposeArgs) + $arguments
  & docker @all
  if ($LASTEXITCODE -ne 0 -and -not $AllowFail) { Stop-Script "docker $($arguments -join ' ') failed (exit $LASTEXITCODE)." }
}

function Get-ServerBase {
  $e = Read-EnvFile
  $port = if ($e.Contains("LAN_PORT")) { $e["LAN_PORT"] } else { "8788" }
  $addr = if ($e.Contains("LAN_ADDRESS")) { $e["LAN_ADDRESS"] } else { "127.0.0.1" }
  return "http://${addr}:${port}"
}

function Wait-Healthy([string]$base, [int]$seconds = 120) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri "$base/health/ready" -TimeoutSec 5
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 3
  }
  return $false
}

function Assert-EnvFile { if (-not (Test-Path $script:EnvFile)) { Stop-Script ".env.lan does not exist yet. Run .\Initialize-ClynxLan.ps1 first." } }
