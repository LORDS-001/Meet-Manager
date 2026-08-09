@echo off
REM ---------------------------------------------------------------------
REM  MeetManager launcher
REM ---------------------------------------------------------------------
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 goto :nopython
    echo Installing dependencies...
    ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt
)

".venv\Scripts\python.exe" run.py %*
goto :eof

:nopython
echo.
echo  Could not create a virtual environment.
echo  Make sure Python 3.10 or newer is installed and on your PATH.
echo.
pause
