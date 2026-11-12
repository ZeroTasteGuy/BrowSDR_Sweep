@echo off
rem Starts the BirriaSDR bridge for BrowSDR. Extra arguments are passed through, e.g. --lib C:\path\to\Release
python "%~dp0birria_bridge.py" %*
pause
