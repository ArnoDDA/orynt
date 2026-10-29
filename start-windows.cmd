@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ORYNT_NODE=%~dp0runtime\win-x64\node.exe"
if not exist "%ORYNT_NODE%" set "ORYNT_NODE=node"
"%ORYNT_NODE%" scripts\launch.mjs
if errorlevel 1 (
  echo 启动失败，请完整解压体验包，并保留以上错误信息。
  pause
)
