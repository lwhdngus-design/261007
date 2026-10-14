@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 깃허브에서 최신 버전을 받습니다. (git pull 과 같음)
git pull
echo.
echo 끝났습니다. 이제 start.bat 으로 실행하세요.
pause
