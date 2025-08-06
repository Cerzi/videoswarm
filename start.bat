@echo off
REM Windows batch file to start the video browser server

echo 🎬 Starting Video Browser Server...

REM Check if Python is available
python --version >nul 2>&1
if %errorlevel% == 0 (
    python server.py
) else (
    echo ❌ Python not found! Please install Python 3
    pause
    exit /b 1
)
