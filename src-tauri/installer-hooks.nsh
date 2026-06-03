; "Open in Artex" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInArtex" "" "Open in Artex"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInArtex" "Icon" '"$INSTDIR\artex.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInArtex" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInArtex\command" "" '"$INSTDIR\artex.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInArtex" "" "Open in Artex"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInArtex" "Icon" '"$INSTDIR\artex.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInArtex" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInArtex\command" "" '"$INSTDIR\artex.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInArtex" "" "Open in Artex"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInArtex" "Icon" '"$INSTDIR\artex.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInArtex" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInArtex\command" "" '"$INSTDIR\artex.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInArtex"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInArtex"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInArtex"
!macroend
