@echo off
rem MOSS Prompt Studio - desktop launcher
rem   start.bat            open the desktop window
rem   start.bat browser    use the system browser instead of a native window
rem   start.bat debug      keep console + WebView devtools (same as start-debug.bat)
rem   start.bat rebuild    rebuild the frontend (needs Node.js)
rem   start.bat fixvenv    recreate .venv
cd /d "%~dp0"
setlocal EnableDelayedExpansion
set "FORCE_REBUILD="
set "FIX_VENV="
set "MODE=window"
for %%A in (%*) do (
  if /I "%%~A"=="rebuild" set "FORCE_REBUILD=1"
  if /I "%%~A"=="fixvenv" set "FIX_VENV=1"
  if /I "%%~A"=="browser" set "MODE=browser"
  if /I "%%~A"=="debug" set "MODE=debug"
)
set "REQ=requirements.txt"

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

if "%MODE%"=="debug" (
  echo [i] Debug mode: logs below, close this window to quit.
  "%VPY%" -m desktop --debug
  if errorlevel 1 pause
  exit /b
)
if "%MODE%"=="browser" (
  "%VPY%" -m desktop --browser
  if errorlevel 1 pause
  exit /b
)
rem pythonw = no console window; errors go to data\app.log
start "" ".venv\Scripts\pythonw.exe" -m desktop
exit /b 0
