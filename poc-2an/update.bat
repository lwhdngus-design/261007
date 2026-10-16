@echo off
chcp 65001 >nul
rem 최신 버전 받기: git으로 받은 폴더는 git pull, ZIP으로 받은 폴더는 최신 ZIP을 받아 덮어씀
rem (자기 자신도 덮어쓰므로 임시 폴더에 복사본을 만들어 그것으로 실행)
if /i not "%~1"=="--run" (
  copy /y "%~f0" "%TEMP%\poc2an_update.bat" >nul
  "%TEMP%\poc2an_update.bat" --run "%~dp0."
  exit /b
)
set "APPDIR=%~f2"
cd /d "%APPDIR%"
set "BR=claude/excel-2an-sheet-format-svwm4c"
set "ZIPURL=https://github.com/lwhdngus-design/261007/archive/refs/heads/claude/excel-2an-sheet-format-svwm4c.zip"
echo 앱 폴더: %APPDIR%
echo.

where git >nul 2>nul || goto zip
git rev-parse --is-inside-work-tree >nul 2>nul || goto zip
echo [git] 최신 버전을 받습니다...
git fetch origin %BR% || goto fail
git checkout %BR% || goto fail
git pull origin %BR% || goto fail
goto done

:zip
echo [ZIP] git으로 받은 폴더가 아니어서 최신 ZIP을 내려받아 덮어씁니다.
echo       폴더 설정(docs-folder.txt)과 검색 색인(.docs-cache)은 그대로 둡니다.
set "TMPD=%TEMP%\poc2an_update"
if exist "%TMPD%" rmdir /s /q "%TMPD%"
mkdir "%TMPD%"
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%ZIPURL%' -OutFile '%TMPD%\app.zip'; Expand-Archive -Force '%TMPD%\app.zip' '%TMPD%\x'"
if errorlevel 1 goto zipfail
set "SRC="
for /d %%D in ("%TMPD%\x\*") do set "SRC=%%D\poc-2an"
if not defined SRC goto zipfail
if not exist "%SRC%\index.html" goto zipfail
robocopy "%SRC%" "%APPDIR%" /E /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto zipfail
rmdir /s /q "%TMPD%"
goto done

:zipfail
echo.
echo [업데이트 못 함] 최신 ZIP을 자동으로 받지 못했습니다 (인터넷 차단·보안 프로그램 등).
echo  1) 크롬 주소창에 아래 주소를 넣어 최신 ZIP을 받습니다.
echo     %ZIPURL%
echo  2) 압축을 풀고, 안의 poc-2an 폴더 내용을 지금 이 poc-2an 폴더에 모두 덮어씁니다.
echo  3) 검은 창을 모두 닫고 start.bat 으로 다시 실행합니다.
goto end

:fail
echo.
echo [업데이트 실패] 위에 나온 메시지를 캡처해서 보내 주세요.
echo  "local changes would be overwritten" 이 보이면 앱 폴더의 파일을 직접 고친 것이 있다는 뜻입니다.
goto end

:done
echo.
echo 업데이트 완료. 받은 앱 버전:
findstr /c:"const APP_VERSION" "%APPDIR%\layout.js"
echo.
echo 열려 있는 앱 창(검은 창)을 모두 닫고 start.bat 으로 다시 실행하세요.
echo 앱의 [기초서류 연결] 화면 "앱 버전"에서도 확인할 수 있습니다.

:end
echo.
pause
