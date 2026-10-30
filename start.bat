@echo off
title Strike Lite server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing game files for the first time...
  call npm install
)
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
node server.js
pause
