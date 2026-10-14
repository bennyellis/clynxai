<#
.SYNOPSIS
  Shows whether the Clynx LAN server is healthy: containers, health checks, version, services, queue, accounts, disk, and the age of the newest backup.
#>
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
$e = Read-EnvFile
$env:LAN_BIND = $e["LAN_ADDRESS"]
$base = Get-ServerBase

Write-Step "Containers"
Invoke-Compose @("ps", "--format", "table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Ports}}") -AllowFail

Write-Step "Health"
try {
  $r = Invoke-RestMethod -Uri "$base/health/ready" -TimeoutSec 5
  Write-Ok "ready: $($r | ConvertTo-Json -Compress)"
} catch { Write-Warn2 "Not ready at $base : $($_.Exception.Message)" }
try {
  $i = Invoke-RestMethod -Uri "$base/server/info" -TimeoutSec 5
  Write-Ok ("{0}  version {1}  API v{2}  shared AI: {3}  shared eBay: {4}  updates: {5}  billing: {6}" -f $i.name, $i.serverVersion, $i.apiVersion, $i.services.sharedAi, $i.services.sharedEbay, $i.services.updates, $i.services.billing)
} catch { }
if ($e.Contains("METRICS_TOKEN") -and $e["METRICS_TOKEN"]) {
  try {
    $m = Invoke-RestMethod -Uri "$base/metrics" -Headers @{ Authorization = "Bearer $($e['METRICS_TOKEN'])" } -TimeoutSec 5
    Write-Ok "metrics: $($m | ConvertTo-Json -Compress -Depth 4)"
  } catch { }
}

Write-Step "Data"
$users = & docker @((Get-ComposeArgs) + @("exec", "-T", "postgres", "psql", "-U", $e["POSTGRES_USER"], "-d", $e["POSTGRES_DB"], "-tAc", "select count(*) from users")) 2>$null
if ($LASTEXITCODE -eq 0) { Write-Ok "accounts: $($users.Trim())" }

Write-Step "Backups"
if (Test-Path $script:BackupDir) {
  $latest = Get-ChildItem $script:BackupDir -Filter "*.sql.gz" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) {
    $age = [int]((Get-Date) - $latest.LastWriteTime).TotalHours
    if ($age -gt 48) { Write-Warn2 "Newest backup is $age hours old: $($latest.Name)" } else { Write-Ok "Newest backup: $($latest.Name) ($age h old)" }
  } else { Write-Warn2 "No backup yet. Run .\Backup-ClynxLan.ps1" }
} else { Write-Warn2 "No backup yet. Run .\Backup-ClynxLan.ps1" }

Write-Step "Network"
$listening = Get-NetTCPConnection -State Listen -LocalPort ([int]$e["LAN_PORT"]) -ErrorAction SilentlyContinue | Select-Object -First 3
foreach ($l in $listening) { Write-Ok "port $($l.LocalPort) listening on $($l.LocalAddress)" }
$bad = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 5432, 6379 -and $_.LocalAddress -notin "127.0.0.1", "::1" }
if ($bad) { Write-Warn2 "PostgreSQL/Redis ports are listening beyond this computer: $(($bad | ForEach-Object { '{0}:{1}' -f $_.LocalAddress, $_.LocalPort }) -join ', '). (The LAN stack publishes none; this is probably the developer stack - see docker-compose.yml.)" }
