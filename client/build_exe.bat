@echo off
rem 重新打包 Kolid Desktop.exe(onefile,无控制台窗口)
rem 需要:python -m pip install pywebview pyinstaller;Windows 需 WebView2 Runtime(Win10/11 一般自带)
cd /d "%~dp0.."
python -m PyInstaller --noconfirm --onefile --noconsole --distpath . --name "Kolid Desktop" --icon "client/icon.ico" --add-data "client/icon.ico;." client/kolid_client.py
rem PyInstaller 必然生成 spec 临时文件与 build 中间目录,构建完清掉,仓库只留 exe
del "Kolid Desktop.spec"
rd /s /q build
echo.
echo Output: Kolid Desktop.exe(仓库根目录)
