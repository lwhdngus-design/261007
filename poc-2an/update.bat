@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 깃허브에서 최신 버전을 받습니다. 작업 브랜치로 맞춘 뒤 git pull 합니다.
set BR=claude/excel-2an-sheet-format-svwm4c
git fetch origin %BR%
git checkout %BR%
git pull origin %BR%
echo.
echo 지금 버전:
git log -1 --format="%%cd  %%s" --date=format:"%%Y-%%m-%%d %%H:%%M"
echo.
echo 끝났습니다. 열려 있는 앱 창(검은 창)을 모두 닫고 start.bat 으로 다시 실행하세요.
pause
