@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 깃허브에서 최신 버전을 받습니다. 작업 브랜치로 맞춘 뒤 git pull 합니다.
set BR=claude/excel-2an-sheet-format-svwm4c
where git >nul 2>nul || goto nogit
git rev-parse --is-inside-work-tree >nul 2>nul || goto nogit
git fetch origin %BR% || goto fail
git checkout %BR% || goto fail
git pull origin %BR% || goto fail
echo.
echo 업데이트 완료. 지금 버전:
git log -1 --format="%%cd  %%s" --date=format:"%%Y-%%m-%%d %%H:%%M"
echo.
echo 열려 있는 앱 창(검은 창)을 모두 닫고 start.bat 으로 다시 실행하세요.
goto end
:nogit
echo.
echo [업데이트 못 함] 이 폴더는 ZIP으로 받은 폴더이거나 PC에 git이 없어 자동 업데이트를 할 수 없습니다.
echo.
echo  1) 크롬 주소창에 아래 주소를 넣어 최신 ZIP을 받습니다.
echo     https://github.com/lwhdngus-design/261007/archive/refs/heads/claude/excel-2an-sheet-format-svwm4c.zip
echo  2) 압축을 풀고, 안의 poc-2an 폴더 내용을 지금 이 poc-2an 폴더에 모두 덮어씁니다.
echo     (docs-folder.txt 와 .docs-cache 는 ZIP에 없어서 그대로 남습니다 = 폴더 설정과 검색 색인 유지)
echo  3) 검은 창을 모두 닫고 start.bat 으로 다시 실행합니다.
goto end
:fail
echo.
echo [업데이트 실패] 위에 나온 메시지를 캡처해서 보내 주세요.
echo  "local changes would be overwritten" 이 보이면 앱 폴더의 파일을 직접 고친 것이 있다는 뜻입니다.
:end
echo.
pause
