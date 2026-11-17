; Hooks for the NSIS installer made by `tauri build` (bundle.windows.nsis.installerHooks).
;
; An update replaces ide-lite.exe but keeps the existing shortcuts, and Explorer
; keeps showing the icon it cached for them: after a new logo the desktop and
; Start menu would still show the old one. Tell the shell that the exe and its
; shortcuts changed, then have Windows rebuild its icon cache.

!define IDE_SHCNE_UPDATEITEM 0x00002000
!define IDE_SHCNE_ASSOCCHANGED 0x08000000
!define IDE_SHCNF_FLUSH 0x1000
!define IDE_SHCNF_PATHW_FLUSH 0x1005 ; SHCNF_PATHW (0x0005) | SHCNF_FLUSH

!macro IDE_ICON_CHANGED path
  System::Call 'shell32::SHChangeNotify(i ${IDE_SHCNE_UPDATEITEM}, i ${IDE_SHCNF_PATHW_FLUSH}, w "${path}", p 0)'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro IDE_ICON_CHANGED "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro IDE_ICON_CHANGED "$DESKTOP\${PRODUCTNAME}.lnk"
  !insertmacro IDE_ICON_CHANGED "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !insertmacro IDE_ICON_CHANGED "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  System::Call 'shell32::SHChangeNotify(i ${IDE_SHCNE_ASSOCCHANGED}, i ${IDE_SHCNF_FLUSH}, p 0, p 0)'

  ; The installer is 32-bit: the 64-bit System32 is reached through Sysnative.
  ${If} ${FileExists} "$WINDIR\Sysnative\ie4uinit.exe"
    nsExec::Exec '"$WINDIR\Sysnative\ie4uinit.exe" -show'
    Pop $0
  ${ElseIf} ${FileExists} "$SYSDIR\ie4uinit.exe"
    nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
    Pop $0
  ${EndIf}
!macroend
