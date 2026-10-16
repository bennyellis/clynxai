# Releasing a Clynx beta (the steps that work)

Run in PowerShell on the Windows PC. Docker Desktop must be running for step 3.
Set the version once, then paste each step. Change `$v` for each release (for example `0.3.0-beta.20`).

```powershell
$v = "0.3.0-beta.20"
```

## 1. Pull, build

```powershell
cd C:\Users\biggt\OneDrive\Documents\Claude\Sessions\fb-marketplace-scout
git pull origin master-wveebf
Select-String -Path package.json -Pattern '"version"' | Select-Object -First 1
npm install
npm run typecheck
npm run dist:beta
Get-ChildItem .\dist\*.exe
```

The version line must say `$v`, and the last command must list `Clynx-Beta-Setup-$v.exe`.

## 2. Copy it into `beta-release` and hash it

```powershell
New-Item -ItemType Directory -Force beta-release | Out-Null
Copy-Item ".\dist\Clynx-Beta-Setup-$v.exe" .\beta-release\
$hash = (Get-FileHash ".\beta-release\Clynx-Beta-Setup-$v.exe" -Algorithm SHA256).Hash
$hash
```

## 3. Publish (turn automatic publishing on only for this step)

```powershell
cd cloud\deploy\windows
.\Set-ClynxAutoPublish.ps1 -On
.\Publish-ClynxRelease.ps1 `
  -Installer "..\..\..\beta-release\Clynx-Beta-Setup-$v.exe" `
  -Version $v `
  -ExpectSha256 $hash `
  -NotesFile "..\..\..\release-notes\$v.txt"
.\Set-ClynxAutoPublish.ps1 -Off
cd ..\..\..
```

Notes:
- `npm test` is optional (about 7 minutes); run it when in doubt.
- Server code changes need the server updated first (rebuild the `api` and `worker` containers); app-only releases do not.
