@echo off
rem Configure all Windows integration for .cud files:
rem   1) Explorer thumbnails    - COM thumbnail provider showing the saved canvas composite
rem   2) Double-click           - opens the .cud in Kolid Desktop.exe
rem   3) Classic right-click    - KolidUI > PNG writes a same-name .png next to the .cud
rem   4) Win11 first-level menu - the same KolidUI > PNG in the modern menu (packaged
rem      MSIX; needs one UAC prompt; skipped cleanly without MSYS2 g++ / network)
rem Steps 1-3 are per-user (HKCU, no admin). Builds CudThumbnail.dll, CudPng.exe and
rem (when MSYS2 is present) the native menu DLL. Re-run any time to rebuild + refresh.
setlocal
cd /d "%~dp0"

set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo [X] .NET Framework v4 csc.exe not found - install .NET Framework 4.x first.
    goto :done_fail
)

rem Stop the Explorer thumbnail host so a rebuild is not blocked by a locked DLL (CS0016).
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'dllhost.exe' -and $_.CommandLine -and $_.CommandLine.Contains('AB8902B4-09CA-4BB6-B78D-A8F59079A8D5') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>nul

pushd "%~dp0client\cud_thumbnail"
"%CSC%" /nologo /target:library /optimize+ /out:CudThumbnail.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll CudThumbnail.cs CudDoc.cs
if errorlevel 1 (
    echo [X] failed to build CudThumbnail.dll
    popd
    goto :done_fail
)
"%CSC%" /nologo /target:winexe /optimize+ /out:CudPng.exe /r:System.Web.Extensions.dll CudPng.cs CudDoc.cs
if errorlevel 1 (
    echo [X] failed to build CudPng.exe
    popd
    goto :done_fail
)
popd

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0client\cud_thumbnail\register.ps1"
if errorlevel 1 goto :done_fail

rem 4) Win11 modern (first-level) menu: build + pack + elevated install.
rem    exit 3 = skipped (no MSYS2 g++ / no network), 4 = UAC declined.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0client\cud_thumbnail\win11_menu\install_win11_menu.ps1"
set MENU_RC=%errorlevel%

echo.
echo [OK] Windows integration configured:
echo   - .cud thumbnails in Explorer (saved canvas composite)
echo   - Double-click a .cud opens it in Kolid Desktop
echo   - Right-click a .cud: KolidUI ^> PNG writes a same-name .png next to it
if "%MENU_RC%"=="0" echo   - Win11 first-level menu: installed/updated
if "%MENU_RC%"=="3" echo   - Win11 first-level menu: skipped (no MSYS2 g++ / no network)
if "%MENU_RC%"=="4" echo   - Win11 first-level menu: skipped (UAC declined)
if "%MENU_RC%"=="1" echo   - Win11 first-level menu: FAILED - see the [X] line above
echo.
echo If icons do not refresh immediately, restart explorer.exe or sign out/in.
pause
exit /b 0

:done_fail
echo.
echo [X] Setup did not complete - see the messages above.
pause
exit /b 1
