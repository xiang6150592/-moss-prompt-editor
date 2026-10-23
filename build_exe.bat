@echo off
rem Build a portable folder: release\MOSS-Prompt-Studio\MOSS-Prompt-Studio.exe
rem Copy the whole folder to use it elsewhere; user data lives in its data\ subfolder.
cd /d "%~dp0"
setlocal EnableDelayedExpansion
set "FORCE_REBUILD=1"
set "FIX_VENV="
for %%A in (%*) do (
  if /I "%%~A"=="fixvenv" set "FIX_VENV=1"
  if /I "%%~A"=="nobuild" set "FORCE_REBUILD="
)
set "REQ=requirements-dev.txt"

rem ---- pick Python 3.11-3.13 (3.14 not supported by pywebview/pythonnet yet) ----
set "PY="
for %%V in (3.12 3.11 3.13) do (
  if not defined PY (
    py -%%V -c "import sys" >nul 2>&1
    if !errorlevel! equ 0 set "PY=py -%%V"
  )
)
if not defined PY (
  python -c "import sys; sys.exit(0 if (3,11)<=sys.version_info[:2]<=(3,13) else 1)" >nul 2>&1
  if !errorlevel! equ 0 set "PY=python"
)
if not defined PY (
  echo [x] Need Python 3.11 - 3.13 ^(64-bit^). Check installed versions with: py -0p
  pause
  exit /b 1
)

if "%FIX_VENV%"=="1" if exist ".venv\" (
  echo [i] Recreating .venv ...
  rmdir /s /q ".venv"
)
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys" >nul 2>&1
  if errorlevel 1 (
    echo [i] .venv is broken, recreating ...
    rmdir /s /q ".venv"
  )
)
if not exist ".venv\Scripts\python.exe" (
  echo [i] Creating .venv with %PY% ...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo [x] Failed to create venv.
    pause
    exit /b 1
  )
  if exist ".venv\.req-stamp" del /q ".venv\.req-stamp"
)
set "VPY=.venv\Scripts\python.exe"

rem ---- install deps only when %REQ% changed ----
set "NEED_PIP=1"
if exist ".venv\.req-stamp" (
  fc /b "%REQ%" ".venv\.req-stamp" >nul 2>&1
  if !errorlevel! equ 0 set "NEED_PIP=0"
)
if "!NEED_PIP!"=="1" (
  echo [i] Installing Python packages from %REQ% ...
  "%VPY%" -m pip install -q -U pip
  "%VPY%" -m pip install -q -r "%REQ%"
  if errorlevel 1 (
    echo [x] pip install failed. Check network / proxy, or run: %~nx0 fixvenv
    pause
    exit /b 1
  )
  copy /y "%REQ%" ".venv\.req-stamp" >nul
)

rem ---- frontend: dist\ is shipped prebuilt; rebuild only if missing or asked ----
set "NEED_BUILD=0"
if "%FORCE_REBUILD%"=="1" set "NEED_BUILD=1"
if not exist "dist\index.html" set "NEED_BUILD=1"
if "!NEED_BUILD!"=="1" (
  where npm >nul 2>&1
  if errorlevel 1 (
    echo [x] dist\ missing and npm not found. Install Node.js 18+ first.
    pause
    exit /b 1
  )
  if not exist "node_modules\" call npm install
  echo [i] Building frontend ...
  call npm run build
  if errorlevel 1 (
    echo [x] npm run build failed.
    pause
    exit /b 1
  )
)

echo [i] Running PyInstaller ...
"%VPY%" -m PyInstaller --noconfirm --clean --distpath release --workpath build\pyinstaller moss-studio.spec
if errorlevel 1 (
  echo [x] PyInstaller failed.
  pause
  exit /b 1
)
if not exist "release\MOSS-Prompt-Studio\data\" mkdir "release\MOSS-Prompt-Studio\data"
if exist "data\skills.json" if not exist "release\MOSS-Prompt-Studio\data\skills.json" copy /y "data\skills.json" "release\MOSS-Prompt-Studio\data\" >nul
echo.
echo [ok] Done: release\MOSS-Prompt-Studio\MOSS-Prompt-Studio.exe
echo      Copy your old data\settings.json / history.json into release\MOSS-Prompt-Studio\data\ if needed.
pause
