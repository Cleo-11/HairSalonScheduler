@echo off
rem Resets the demo salon and queue to fresh sample data.
cd /d "%~dp0Backend"
call npm run db:seed -- --demo-queue
echo.
pause
