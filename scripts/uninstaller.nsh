; Custom NSIS script for Facebook Messenger Desktop
; This runs during install/update and uninstall

; Custom install macro - runs after installation/update
; This fixes the "missing" taskbar icon issue after updates by refreshing pinned shortcuts
!macro customInstall
  ; Use PowerShell to update any existing Messenger taskbar shortcuts to point to the new executable
  ; This preserves the pinned status while updating the target path and icon location
  ; $INSTDIR contains the new installation directory
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "\
    $$taskbarPath = [Environment]::GetFolderPath(\"ApplicationData\") + \"\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\"; \
    $$shell = New-Object -ComObject WScript.Shell; \
    Get-ChildItem -Path $$taskbarPath -Filter \"*Messenger*.lnk\" -ErrorAction SilentlyContinue | ForEach-Object { \
      $$shortcut = $$shell.CreateShortcut($$_.FullName); \
      $$shortcut.TargetPath = \"$INSTDIR\Messenger.exe\"; \
      $$shortcut.WorkingDirectory = \"$INSTDIR\"; \
      $$shortcut.IconLocation = \"$INSTDIR\Messenger.exe,0\"; \
      $$shortcut.Save(); \
    }"'
  Pop $0
  
  ; Also update Start Menu shortcuts if they exist
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "\
    $$startMenuPath = [Environment]::GetFolderPath(\"StartMenu\") + \"\Programs\"; \
    $$shell = New-Object -ComObject WScript.Shell; \
    Get-ChildItem -Path $$startMenuPath -Filter \"*Messenger*.lnk\" -Recurse -ErrorAction SilentlyContinue | ForEach-Object { \
      $$shortcut = $$shell.CreateShortcut($$_.FullName); \
      $$shortcut.TargetPath = \"$INSTDIR\Messenger.exe\"; \
      $$shortcut.WorkingDirectory = \"$INSTDIR\"; \
      $$shortcut.IconLocation = \"$INSTDIR\Messenger.exe,0\"; \
      $$shortcut.Save(); \
    }"'
  Pop $0
  
  ; Clear the Windows icon cache to force refresh of all icons
  ; This is more aggressive than SHChangeNotify alone and helps fix stale cached icons
  nsExec::ExecToStack 'cmd.exe /c del /f /q "%LOCALAPPDATA%\IconCache.db" 2>nul'
  Pop $0
  nsExec::ExecToStack 'cmd.exe /c del /f /q "%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db" 2>nul'
  Pop $0
  
  ; Notify Windows shell to refresh icons and update the taskbar
  ; SHCNE_ASSOCCHANGED (0x08000000) with SHCNF_IDLIST (0) tells the shell that file associations changed
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ; First, close Messenger if it's running
  ; This prevents "file in use" errors during uninstall
  
  ; Force kill any Messenger processes using taskkill
  ; /F = force terminate, /IM = image name, /T = terminate child processes
  ; Use nsExec to run silently (won't show errors if process isn't running)
  nsExec::ExecToStack 'taskkill /F /IM "Messenger.exe" /T'
  Pop $0 ; Exit code (0 = success, non-zero = no process found - both are fine)
  
  ; Wait for the process to fully terminate and release file handles
  Sleep 2000
  
  ; Remove from Windows taskbar (pinned shortcuts)
  ; The taskbar pins are stored in: %APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar
  ; Use cmd.exe with del command and wildcard to remove any Messenger shortcuts
  nsExec::ExecToStack 'cmd.exe /c del /q "%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\*Messenger*.lnk" 2>nul'
  Pop $0
  
  ; Also remove from Start Menu pins (Windows 10/11)
  nsExec::ExecToStack 'cmd.exe /c del /q "%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\StartMenu\*Messenger*.lnk" 2>nul'
  Pop $0
  
  ; Clean up LOCALAPPDATA (cache, GPU cache, etc.)
  ; deleteAppDataOnUninstall only cleans APPDATA, not LOCALAPPDATA
  RMDir /r "$LOCALAPPDATA\Messenger"
  
  ; Also clean up any leftover temp files
  RMDir /r "$TEMP\Messenger"
!macroend

