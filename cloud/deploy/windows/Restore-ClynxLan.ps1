<#
.SYNOPSIS
  Restores a database backup made by Backup-ClynxLan.ps1 WITHOUT destroying anything: the backup is loaded into a new database, checked, and only then swapped in; the database that was
  live is kept under a new name (clynx_cloud_before_restore_<time>) so the restore itself can be undone.
.PARAMETER BackupFile
  Path to a clynx-lan-*.sql.gz file.
.PARAMETER Yes
  Required to go ahead (the server is stopped for a minute while the databases are swapped).
.PARAMETER CheckOnly
  Load the backup into a scratch database, report what it contains, and remove the scratch database. Changes nothing else; the server keeps running.
#>
param([Parameter(Mandatory = $true)][string]$BackupFile, [switch]$Yes, [switch]$CheckOnly)
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
if (-not (Test-Path $BackupFile)) { Stop-Script "Cannot find $BackupFile" }
$e = Read-EnvFile
$env:LAN_BIND = $e["LAN_ADDRESS"]
$user = $e["POSTGRES_USER"]
$db = $e["POSTGRES_DB"]
$stamp = Get-Date -Format "yyyyMMddHHmmss"
$scratch = "clynx_restore_$stamp"

function Invoke-Psql([string]$database, [string]$sql, [switch]$Quiet) {
  $out = & docker @((Get-ComposeArgs) + @("exec", "-T", "postgres", "psql", "-U", $user, "-d", $database, "-v", "ON_ERROR_STOP=1", "-tAc", $sql)) 2>&1
  if ($LASTEXITCODE -ne 0) { Stop-Script "psql failed: $out" }
  return ($out | Out-String).Trim()
}

Write-Step "Checking the backup file"
$sumFile = $BackupFile -replace "\.sql\.gz$", ".sha256.txt"
if (Test-Path $sumFile) {
  $want = (Get-Content $sumFile | Where-Object { $_ -match [regex]::Escape((Split-Path $BackupFile -Leaf)) } | Select-Object -First 1)
  if ($want) {
    $wantHash = ($want -split "\s+")[0]
    $got = (Get-FileHash $BackupFile -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $wantHash) { Stop-Script "The backup file does not match its recorded checksum. It may be damaged; not using it." }
    Write-Ok "Checksum matches"
  }
}

Write-Step "Loading it into a scratch database ($scratch)"
Invoke-Psql "postgres" "CREATE DATABASE $scratch" | Out-Null
Invoke-Compose @("cp", $BackupFile, "postgres:/tmp/restore.sql.gz")
try {
  Invoke-Compose @("exec", "-T", "postgres", "sh", "-c", "gunzip -c /tmp/restore.sql.gz | psql -U $user -d $scratch -q -v ON_ERROR_STOP=1 > /dev/null")
  $users = Invoke-Psql $scratch "select count(*) from users"
  $migs = Invoke-Psql $scratch "select count(*) from schema_migrations"
  Write-Ok "The backup loads cleanly: $users accounts, $migs migrations applied"
} catch { throw } finally {
  Invoke-Compose @("exec", "-T", "postgres", "rm", "-f", "/tmp/restore.sql.gz") -AllowFail
}

if ($CheckOnly) {
  Invoke-Psql "postgres" "DROP DATABASE $scratch" | Out-Null
  Write-Ok "Scratch database removed. Nothing else was changed."
  exit 0
}
if (-not $Yes) {
  Invoke-Psql "postgres" "DROP DATABASE $scratch" | Out-Null
  Stop-Script "Add -Yes to swap this backup in (the current database is kept under another name). Scratch database removed."
}

Write-Step "Taking a safety backup of the CURRENT database first"
& (Join-Path $PSScriptRoot "Backup-ClynxLan.ps1") -Label "pre-restore" -Keep 100

Write-Step "Swapping databases (the server is stopped for a moment)"
Invoke-Compose @("stop", "api", "worker")
$old = "${db}_before_restore_$stamp"
Invoke-Psql "postgres" "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$db','$scratch') AND pid <> pg_backend_pid()" | Out-Null
Invoke-Psql "postgres" "ALTER DATABASE $db RENAME TO $old" | Out-Null
Invoke-Psql "postgres" "ALTER DATABASE $scratch RENAME TO $db" | Out-Null
Invoke-Compose @("start", "api", "worker")
if (Wait-Healthy (Get-ServerBase) 120) { Write-Ok "Server is healthy on the restored data." } else { Write-Warn2 "The server did not report healthy; check .\Get-ClynxLanStatus.ps1" }
Write-Host "The database that was live is still there as '$old'. To undo this restore, stop api+worker and rename the databases back; to reclaim the space later: DROP DATABASE $old." -ForegroundColor Yellow
