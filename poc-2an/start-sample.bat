@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 교육용 실습: 가상 기초서류 샘플(가나다생명)로 앱을 엽니다. 내 기초서류 폴더 설정은 바뀌지 않습니다.
python build-data.py
python serve.py --sample
pause
