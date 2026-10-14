<#
.SYNOPSIS
  Backs up the Clynx LAN server: the PostgreSQL database (compressed SQL dump), the uploaded installers, and a checksum list. Does not stop the server.
.PARAMETER Keep
  How many backup sets to keep (default 14); older ones are removed ONLY from the backup folder.
.PARAMETER IncludeEnv
  Also copy .env.lan (it holds the secrets, including the key that decrypts the saved OpenAI/eBay keys) into the backup. Keep such a backup somewhere private and OFF this computer.
.NOTES
  Backups go to %USERPROFILE%\ClynxLan\backups (outside the project folder and OneDrive) or $env:CLYNX_BACKUP_DIR. Copy them to another disk or computer: a backup on the same disk does not protect against that disk failing.
#>
param([int]$Keep = 14, [switch]$IncludeEnv, [string]$Label = "")
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
$e = Read-EnvFile
$env:LAN_BIND = $e["LAN_ADDRESS"]
New-Item -ItemType Directory -Force -Path $script:BackupDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$name = "clynx-lan-$stamp$(if ($Label) { '-' + ($Label -replace '[^A-Za-z0-9_-]', '') })"
$sql = Join-Path $script:BackupDir "$name.sql.gz"
$rel = Join-Path $script:BackupDir "$name.releases.tgz"

Write-Step "Dumping the database"
Invoke-Compose @("exec", "-T", "postgres", "sh", "-c", "pg_dump -U $($e['POSTGRES_USER']) -d $($e['POSTGRES_DB']) --no-owner | gzip > /tmp/backup.sql.gz && gzip -t /tmp/backup.sql.gz")
Invoke-Compose @("cp", "postgres:/tmp/backup.sql.gz", $sql)
Invoke-Compose @("exec", "-T", "postgres", "rm", "-f", "/tmp/backup.sql.gz") -AllowFail
if (-not (Test-Path $sql) -or (Get-Item $sql).Length -lt 1000) { Stop-Script "The database backup is missing or suspiciously small." }
Write-Ok ("{0}  ({1:N1} MB)" -f $sql, ((Get-Item $sql).Length / 1MB))

Write-Step "Copying the uploaded installers"
Invoke-Compose @("exec", "-T", "api", "sh", "-c", "tar czf /tmp/releases.tgz -C /data .")
Invoke-Compose @("cp", "api:/tmp/releases.tgz", $rel)
Invoke-Compose @("exec", "-T", "api", "rm", "-f", "/tmp/releases.tgz") -AllowFail
Write-Ok ("{0}  ({1:N1} MB)" -f $rel, ((Get-Item $rel).Length / 1MB))

$files = @($sql, $rel)
if ($IncludeEnv) {
  $envCopy = Join-Path $script:BackupDir "$name.env.lan"
  Copy-Item $script:EnvFile $envCopy
  try { & icacls $envCopy /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null } catch { }
  $files += $envCopy
  Write-Warn2 "Included .env.lan (secrets!) - store this file privately and off this computer."
}
$sums = $files | ForEach-Object { "{0}  {1}" -f (Get-FileHash $_ -Algorithm SHA256).Hash.ToLower(), (Split-Path $_ -Leaf) }
Set-Content -Path (Join-Path $script:BackupDir "$name.sha256.txt") -Value $sums -Encoding ASCII
Write-Ok "Checksums: $name.sha256.txt"

# keep the newest $Keep sets
$sets = Get-ChildItem $script:BackupDir -Filter "clynx-lan-*.sql.gz" | Sort-Object Name -Descending
if ($sets.Count -gt $Keep) {
  foreach ($old in $sets | Select-Object -Skip $Keep) {
    $base = $old.Name -replace "\.sql\.gz$", ""
    Get-ChildItem $script:BackupDir -Filter "$base.*" | Remove-Item -Force
    Write-Ok "Removed old backup set $base"
  }
}
Write-Host "Backup complete: $name" -ForegroundColor Green
