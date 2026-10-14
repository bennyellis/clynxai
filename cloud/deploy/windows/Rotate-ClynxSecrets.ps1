<#
.SYNOPSIS
  Replaces server secrets in .env.lan and restarts what needs it. A copy of the old .env.lan is kept (.env.lan.bak-<time>) in case something goes wrong.
.PARAMETER What
  Jwt      - sign-in token secrets. EVERYONE is signed out (they sign in again). No data is affected.
  Redis    - the Redis password (queue/rate-limit state only).
  Postgres - the database password (changed inside the database too).
  Metrics  - the token that protects /metrics.
  All      - all four above.
  The credential-encryption key (CREDENTIALS_ENCRYPTION_KEY) is NOT rotated by this script because rotating it needs you to re-save the OpenAI/eBay keys in the console: see DEPLOYMENT.md "Rotating the credential key".
#>
param([Parameter(Mandatory = $true)][ValidateSet("Jwt", "Redis", "Postgres", "Metrics", "All")][string]$What)
. (Join-Path $PSScriptRoot "_Common.ps1")
Assert-Docker
Assert-EnvFile
$e = Read-EnvFile
$env:LAN_BIND = $e["LAN_ADDRESS"]
$env:LAN_PORT = $e["LAN_PORT"]
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $script:EnvFile "$script:EnvFile.bak-$stamp"
try { & icacls "$script:EnvFile.bak-$stamp" /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null } catch { }
Write-Ok "Kept a copy of the old settings: .env.lan.bak-$stamp (delete it once you are happy; it holds the OLD secrets)"

$do = @{ Jwt = ($What -in "Jwt", "All"); Redis = ($What -in "Redis", "All"); Postgres = ($What -in "Postgres", "All"); Metrics = ($What -in "Metrics", "All") }
$new = @{}
if ($do.Jwt) { $new["JWT_ACCESS_SECRET"] = New-Secret 32; $new["JWT_REFRESH_SECRET"] = New-Secret 32 }
if ($do.Metrics) { $new["METRICS_TOKEN"] = New-Secret 24 }
if ($do.Redis) { $new["REDIS_PASSWORD"] = New-Secret 24 }
if ($do.Postgres) {
  $pw = New-Secret 24
  Write-Step "Changing the database password inside PostgreSQL"
  $out = & docker @((Get-ComposeArgs) + @("exec", "-T", "postgres", "psql", "-U", $e["POSTGRES_USER"], "-d", $e["POSTGRES_DB"], "-v", "ON_ERROR_STOP=1", "-c", "ALTER USER $($e['POSTGRES_USER']) PASSWORD '$pw'")) 2>&1
  if ($LASTEXITCODE -ne 0) { Stop-Script "Could not change the database password: $out. Nothing else was changed." }
  $new["POSTGRES_PASSWORD"] = $pw
}
Set-EnvValues $new
Write-Ok "Updated .env.lan"

Write-Step "Restarting the services that use them"
if ($do.Redis) { Invoke-Compose @("up", "-d", "--force-recreate", "redis") }
Invoke-Compose @("up", "-d", "--force-recreate", "--no-build", "api", "worker")
if (Wait-Healthy (Get-ServerBase) 120) { Write-Host "Done. The server is healthy with the new secrets." -ForegroundColor Green } else { Stop-Script "Not healthy after rotating. Restore the old settings with: Copy-Item .env.lan.bak-$stamp .env.lan  (then .\Start-ClynxLan.ps1)" }
if ($do.Jwt) { Write-Warn2 "Everyone, including the desktop apps, must sign in again." }
if ($do.Postgres -or $do.Redis) { Write-Warn2 "Back up the new .env.lan to your private storage." }
