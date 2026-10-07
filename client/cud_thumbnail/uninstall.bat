@echo off
rem 取消 .cud 缩略图提供器的注册并删除编译产物
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0unregister.ps1"
del /q "%~dp0CudThumbnail.dll" 2>nul
