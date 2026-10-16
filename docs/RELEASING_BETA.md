```
cd C:\Users\biggt\OneDrive\Documents\Claude\Sessions\fb-marketplace-scout
```

`git pull origin master-wveebf`
`Select-String -Path package.json -Pattern '"version"' | Select-Object -First 1`
`npm install`
`npm run typecheck`
`npm run dist:beta`
`Get-ChildItem .\dist\*.exe`
The version line must say `0.3.0-beta.16`, and the last command must list `Clynx-Beta-Setup-0.3.0-beta.16.exe`.
2. Copy it into `beta-release` and hash it

```
New-Item -ItemType Directory -Force beta-release | Out-Null
```

`Copy-Item .\dist\Clynx-Beta-Setup-0.3.0-beta.16.exe .\beta-release\`
`Get-FileHash .\beta-release\Clynx-Beta-Setup-0.3.0-beta.16.exe -Algorithm SHA256`
3. Publish (Docker Desktop must be running)

```
cd cloud\deploy\windows
```

`.\Set-ClynxAutoPublish.ps1 -On`
`.\Publish-ClynxRelease.ps1 ``
`  -Installer ..\..\..\beta-release\Clynx-Beta-Setup-0.3.0-beta.16.exe ``
`  -Version 0.3.0-beta.16 ``
`  -ExpectSha256 PASTE_THE_HASH ``
`  -NotesFile ..\..\..\release-notes\0.3.0-beta.16.txt`
`.\Set-ClynxAutoPublish.ps1 -Off`
`cd ..\..\..`
