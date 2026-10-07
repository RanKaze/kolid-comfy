@echo off
rem Remove all Windows integration for .cud files and delete the built helper binaries:
rem thumbnails, double-click association, KolidUI right-click menus, FileExts
rem leftovers, and the Win11 first-level menu package.
rem Idempotent - safe to run even if nothing is installed.
rem Machine-level (HKLM) leftovers and the first-level menu removal trigger an
rem admin prompt.
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0client\cud_thumbnail\unregister.ps1"
if errorlevel 1 goto :done_warn

rem Win11 first-level menu package (elevated; skips cleanly when not installed).
rem exit 1 = failed, 4 = UAC declined; 3 (not installed) is not a warning.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0client\cud_thumbnail\win11_menu\uninstall_win11_menu.ps1"
set MENU_RC=%errorlevel%
if "%MENU_RC%"=="1" goto :done_warn
if "%MENU_RC%"=="4" goto :done_warn

echo.
echo [OK] All .cud integration removed (thumbnails, double-click, KolidUI menus).
echo If icons are stale, restart explorer.exe or sign out/in.
pause
exit /b 0

:done_warn
echo.
echo [X] Removal finished with warnings - see the [X] lines above.
pause
exit /b 1
