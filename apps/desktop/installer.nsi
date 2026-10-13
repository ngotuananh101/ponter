!include "MUI2.nsh"
Name "Ponter Desktop"
OutFile "target\release\bundle\nsis\PonterDesktop-setup.exe"
InstallDir "$LOCALAPPDATA\Ponter Desktop"
RequestExecutionLevel user
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Section "Install"
  SetOutPath "$INSTDIR"
  File "target\release\ponter-desktop.exe"
  CreateShortCut "$SMPROGRAMS\Ponter Desktop.lnk" "$INSTDIR\ponter-desktop.exe"
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd
Section "Uninstall"
  Delete "$INSTDIR\ponter-desktop.exe"
  Delete "$INSTDIR\uninstall.exe"
  Delete "$SMPROGRAMS\Ponter Desktop.lnk"
  RMDir "$INSTDIR"
SectionEnd
