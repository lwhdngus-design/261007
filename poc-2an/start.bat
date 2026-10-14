@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem CSV를 고쳤다면 data.js를 다시 만들고(파이썬 필요), 앱을 브라우저로 엽니다.
where python >nul 2>nul && python build-data.py
start "" "%~dp0index.html"
