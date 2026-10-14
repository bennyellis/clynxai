; Clynx installer: install for the CURRENT USER only, without asking, so an automatic update never needs Windows administrator permission.
; (The assisted installer would otherwise offer "all users", which writes to Program Files and makes every later silent update raise a Windows permission prompt.)
; A computer that already has an ALL-USERS install keeps being updated all-users (replacing it with a second per-user copy would leave two Clynx installs); that case still needs permission.
!macro customInstallMode
  ${if} $hasPerMachineInstallation == "1"
    StrCpy $isForceMachineInstall "1"
  ${else}
    StrCpy $isForceCurrentInstall "1"
  ${endif}
!macroend
