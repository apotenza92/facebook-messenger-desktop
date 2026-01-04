; Custom NSIS script for Facebook Messenger Desktop
; This runs during install/update and uninstall

; Custom install macro - runs after installation/update
; Fixes the "Can't open this item" taskbar issue after updates
!macro customInstall
  ; Wait for any existing Messenger process to fully exit
  Sleep 1000
  nsExec::ExecToStack 'taskkill /F /IM "Messenger.exe" /T'
  Pop $0
  Sleep 500
  
  ; Save the shortcut update script to a temp file and execute it
  ; This avoids complex escaping issues with inline PowerShell in NSIS
  FileOpen $0 "$TEMP\messenger-shortcut-fix.ps1" w
  FileWrite $0 "$$ErrorActionPreference = $\"SilentlyContinue$\"$\r$\n"
  FileWrite $0 "$$instDir = $\"$INSTDIR$\"$\r$\n"
  FileWrite $0 "$$exePath = Join-Path $$instDir $\"Messenger.exe$\"$\r$\n"
  FileWrite $0 "$\r$\n"
  FileWrite $0 "# Fix taskbar shortcuts$\r$\n"
  FileWrite $0 "$$taskbar = $\"$$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar$\"$\r$\n"
  FileWrite $0 "$$shell = New-Object -ComObject WScript.Shell$\r$\n"
  FileWrite $0 "$$hadShortcut = $$false$\r$\n"
  FileWrite $0 "Get-ChildItem $$taskbar -Filter $\"*.lnk$\" -ErrorAction SilentlyContinue | ForEach-Object {$\r$\n"
  FileWrite $0 "    $$lnk = $$shell.CreateShortcut($$_.FullName)$\r$\n"
  FileWrite $0 "    if ($$lnk.TargetPath -like $\"*Messenger*$\") {$\r$\n"
  FileWrite $0 "        $$hadShortcut = $$true$\r$\n"
  FileWrite $0 "        Remove-Item $$_.FullName -Force$\r$\n"
  FileWrite $0 "    }$\r$\n"
  FileWrite $0 "}$\r$\n"
  FileWrite $0 "if ($$hadShortcut) {$\r$\n"
  FileWrite $0 "    $$newLnk = $$shell.CreateShortcut($\"$$taskbar\Messenger.lnk$\")$\r$\n"
  FileWrite $0 "    $$newLnk.TargetPath = $$exePath$\r$\n"
  FileWrite $0 "    $$newLnk.WorkingDirectory = $$instDir$\r$\n"
  FileWrite $0 "    $$newLnk.IconLocation = $\"$$exePath,0$\"$\r$\n"
  FileWrite $0 "    $$newLnk.Save()$\r$\n"
  FileWrite $0 "}$\r$\n"
  FileWrite $0 "$\r$\n"
  FileWrite $0 "# Fix Start Menu shortcuts$\r$\n"
  FileWrite $0 "$$startMenu = $\"$$env:APPDATA\Microsoft\Windows\Start Menu\Programs$\"$\r$\n"
  FileWrite $0 "Get-ChildItem $$startMenu -Filter $\"*.lnk$\" -Recurse -ErrorAction SilentlyContinue | ForEach-Object {$\r$\n"
  FileWrite $0 "    $$lnk = $$shell.CreateShortcut($$_.FullName)$\r$\n"
  FileWrite $0 "    if ($$lnk.TargetPath -like $\"*Messenger*$\") {$\r$\n"
  FileWrite $0 "        $$lnk.TargetPath = $$exePath$\r$\n"
  FileWrite $0 "        $$lnk.WorkingDirectory = $$instDir$\r$\n"
  FileWrite $0 "        $$lnk.IconLocation = $\"$$exePath,0$\"$\r$\n"
  FileWrite $0 "        $$lnk.Save()$\r$\n"
  FileWrite $0 "    }$\r$\n"
  FileWrite $0 "}$\r$\n"
  FileClose $0
  
  ; Execute the PowerShell script
  nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TEMP\messenger-shortcut-fix.ps1"'
  Pop $0
  
  ; Clean up the temp script
  Delete "$TEMP\messenger-shortcut-fix.ps1"
  
  ; Clear icon cache files
  nsExec::ExecToStack 'cmd.exe /c del /f /q "%LOCALAPPDATA%\IconCache.db" 2>nul'
  Pop $0
  nsExec::ExecToStack 'cmd.exe /c del /f /q "%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db" 2>nul'
  Pop $0
  
  ; Rebuild icon cache
  nsExec::ExecToStack 'ie4uinit.exe -show'
  Pop $0
  
  ; Notify shell to refresh
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  
  ; Broadcast settings change
  System::Call 'user32::SendNotifyMessageW(i 0xFFFF, i 0x001A, i 0, t "Environment")'
!macroend

!macro customUnInstall
  ; Kill Messenger if running
  nsExec::ExecToStack 'taskkill /F /IM "Messenger.exe" /T'
  Pop $0
  Sleep 2000
  
  ; Remove taskbar shortcuts
  nsExec::ExecToStack 'cmd.exe /c del /q "%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\*Messenger*.lnk" 2>nul'
  Pop $0
  
  ; Remove Start Menu pins
  nsExec::ExecToStack 'cmd.exe /c del /q "%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\StartMenu\*Messenger*.lnk" 2>nul'
  Pop $0
  
  ; Clean up LOCALAPPDATA
  RMDir /r "$LOCALAPPDATA\Messenger"
  
  ; Clean up temp files
  RMDir /r "$TEMP\Messenger"
!macroend

