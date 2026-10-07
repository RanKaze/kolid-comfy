@echo off
rem 编译 .cud 缩略图提供器并注册(当前用户级 HKCU,不需要管理员)
cd /d "%~dp0"
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo .NET Framework v4 csc.exe not found
    exit /b 1
)
"%CSC%" /nologo /target:library /optimize+ /out:"%CD%\CudThumbnail.dll" /r:System.Drawing.dll /r:System.Web.Extensions.dll CudThumbnail.cs
if errorlevel 1 exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register.ps1"
echo Done. Open a folder containing .cud files and set the view to medium/large icons.
