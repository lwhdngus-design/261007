@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 로컬 AI(Ollama) 모델 받기 — 처음 한 번 (회사 IT 승인 후)
rem   ai-setup.bat       → 추천 모델 qwen2.5:7b (약 4.7GB, 메모리 16GB 이상 권장)
rem   ai-setup.bat 3b    → 작은 모델 qwen2.5:3b (약 1.9GB, 메모리 8GB PC용, 연구용 라이선스 확인 필요)
rem 모델 받기에만 인터넷이 필요하고, 받은 뒤에는 이 PC 안에서만 동작합니다.
set MODEL=qwen2.5:7b
if /i "%~1"=="3b" set MODEL=qwen2.5:3b
if not "%~1"=="" if /i not "%~1"=="3b" set MODEL=%~1

where ollama >nul 2>nul
if errorlevel 1 (
  echo [안내] Ollama가 설치되어 있지 않습니다.
  echo   1^) https://ollama.com/download 에서 Windows용을 받아 설치하세요.
  echo   2^) 설치가 끝나면 이 파일을 다시 실행하세요.
  pause
  exit /b 1
)
echo 모델 %MODEL% 을 받습니다. 몇 분 걸릴 수 있습니다...
ollama pull %MODEL%
if errorlevel 1 (
  echo [오류] 모델을 받지 못했습니다. 회사망에서 막혔다면 다른 PC에서 받은 뒤
  echo   %%USERPROFILE%%\.ollama\models 폴더를 이 PC의 같은 위치로 복사하세요.
  pause
  exit /b 1
)
echo.
echo 완료. start.bat으로 앱을 실행한 뒤 상단 [AI 질문]에서 "로컬 AI 연결됨"을 확인하세요.
ollama list
pause
