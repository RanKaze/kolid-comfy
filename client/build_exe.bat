@echo off
rem 重新打包 Kolid Desktop.exe(onefile,无控制台窗口)
rem
rem 解释器钉死为 CPython 3.14(pythoncore-3.14-64,装有 pythonnet 3.2.0
rem + pywebview 6.2 + PyInstaller)。勿改回裸 python -m PyInstaller —— 那会跟着
rem PATH 走:在 ComfyUI 的 .venv(Python 3.12 + pythonnet 3.0.5)里打出来的
rem exe 在消息循环里必 AV(事件日志 .NET Runtime 1026,栈钉在
rem Python.Runtime.Dispatcher/MethodBinder,开窗数秒~几分钟即崩),
rem 2026-10-24 的"desktop 总是自己崩溃"就是这种错构建。

set "PYEXE=C:\Users\Klein_Blue\AppData\Local\Python\pythoncore-3.14-64\python.exe"
set "PYCMD=%PYEXE%"

rem py 启动器能用就优先(机器迁移后路径变了也能找对 3.14)
py -3.14-64 -c "import pythonnet, PyInstaller, webview" >nul 2>&1
if not errorlevel 1 set "PYCMD=py -3.14-64"

%PYCMD% -c "import sys; sys.exit(0 if sys.version_info[:2]==(3,14) else 1)" >nul 2>&1
if errorlevel 1 goto badenv
%PYCMD% -c "import sys; from importlib.metadata import version; sys.exit(0 if version('pythonnet')>='3.2.0' else 1)" >nul 2>&1
if errorlevel 1 goto badenv
%PYCMD% -c "import pythonnet, PyInstaller, webview" >nul 2>&1
if errorlevel 1 goto badenv

cd /d "%~dp0.."
%PYCMD% -m PyInstaller --noconfirm --onefile --noconsole --distpath . --name "Kolid Desktop" --icon "client/icon.ico" --add-data "client/icon.ico;." client/kolid_client.py
rem PyInstaller 必然生成 spec 临时文件与 build 中间目录,构建完清掉,仓库只留 exe
del "Kolid Desktop.spec"
rd /s /q build
echo.
echo Output: Kolid Desktop.exe(仓库根目录)
exit /b 0

:badenv
echo [build] 解释器栈不对:%PYCMD%
echo [build] 需要 CPython 3.14 + pythonnet 3.2.0+ + pywebview + PyInstaller
echo [build] 装在 %PYEXE%(或用 py -3.14-64 可解析到的同一环境)
exit /b 1
