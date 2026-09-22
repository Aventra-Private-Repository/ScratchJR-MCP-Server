@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
cd /d "%~dp0"
node scripts\one-click.js
if errorlevel 1 (
  echo.
  echo Setup failed. The message above says which step.
)
echo.
pause
