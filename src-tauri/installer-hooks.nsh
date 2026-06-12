; "Open in Arterm" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInArterm" "" "Open in Arterm"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInArterm" "Icon" '"$INSTDIR\arterm.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInArterm" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInArterm\command" "" '"$INSTDIR\arterm.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInArterm" "" "Open in Arterm"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInArterm" "Icon" '"$INSTDIR\arterm.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInArterm" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInArterm\command" "" '"$INSTDIR\arterm.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInArterm" "" "Open in Arterm"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInArterm" "Icon" '"$INSTDIR\arterm.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInArterm" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInArterm\command" "" '"$INSTDIR\arterm.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInArterm"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInArterm"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInArterm"
!macroend
