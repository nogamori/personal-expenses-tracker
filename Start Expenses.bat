@echo off
cd /d "%~dp0"
rem Opens the dashboard in your browser a moment after the server starts. Close this window (or press Ctrl+C) to stop.
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:8765"
where py >nul 2>nul && (py -3 server.py) || (python server.py)
if errorlevel 1 (
  echo.
  echo Python 3 was not found. Install it from https://www.python.org/downloads/ and run this file again.
  pause
)
