@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 기초서류 폴더를 바꿉니다. 폴더별 색인은 따로 보관되므로, 예전 폴더로 돌아가도 다시 읽지 않습니다.
set /p FOLDER=기초서류 PDF 폴더 경로를 붙여넣고 Enter: 
python build-data.py
python serve.py --folder "%FOLDER%"
pause
