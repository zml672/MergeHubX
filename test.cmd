@echo off
rem MergeHub unit test runner: double-click, or run "test" in the project folder
cd /d "%~dp0"
call npm run test
pause
