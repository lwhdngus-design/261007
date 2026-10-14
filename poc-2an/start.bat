@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 기초서류 폴더를 자동 연결해서 앱을 엽니다. 이 창을 닫으면 앱이 종료됩니다.
rem 폴더를 바꾸려면: python serve.py --folder "C:\경로\폴더"
python build-data.py
python serve.py
pause
