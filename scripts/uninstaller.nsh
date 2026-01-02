; Custom NSIS script for Facebook Messenger Desktop
; This runs during uninstall to clean up ALL app data

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

