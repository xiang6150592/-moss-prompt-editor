@echo off
cd /d "%~dp0"
setlocal EnableDelayedExpansion
set PORT=8787
set FORCE_REBUILD=
set FIX_VENV=

if /I "%~1"=="rebuild" set FORCE_REBUILD=1
if /I "%~1"=="fixvenv" set FIX_VENV=1
if /I "%~2"=="rebuild" set FORCE_REBUILD=1
if /I "%~2"=="fixvenv" set FIX_VENV=1
if not "%~1"=="" if /I not "%~1"=="rebuild" if /I not "%~1"=="fixvenv" set PORT=%~1

set PYLAUNCHER=
py -3.11 -c "import sys" >nul 2>&1
if %ERRORLEVEL%==0 set PYLAUNCHER=py -3.11
if "%PYLAUNCHER%"=="" py -3.12 -c "import sys" >nul 2>&1
if "%PYLAUNCHER%"=="" if %ERRORLEVEL%==0 set PYLAUNCHER=py -3.12
if "%PYLAUNCHER%"=="" py -3.13 -c "import sys" >nul 2>&1
if "%PYLAUNCHER%"=="" if %ERRORLEVEL%==0 set PYLAUNCHER=py -3.13

if "%PYLAUNCHER%"=="" (
  echo Need Python 3.11-3.13. Python 3.14 is not supported yet.
  echo Install 3.11 or run: py -0p
  pause
  exit /b 1
)

echo Using: %PYLAUNCHER%
%PYLAUNCHER% -c "import sys; print(sys.version)"

if "%FIX_VENV%"=="1" (
  echo Force recreating .venv ...
  if exist ".venv\" rmdir /s /q ".venv"
)

if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys; print(sys.executable)" >nul 2>&1
  if errorlevel 1 (
    echo Venv python broken ^(Unable to create process / bad path^). Recreating...
    rmdir /s /q ".venv"
  )
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating venv...
  %PYLAUNCHER% -m venv .venv
  if errorlevel 1 (
    echo Failed to create venv.
    pause
    exit /b 1
  )
)

echo Installing Python deps...
".venv\Scripts\python.exe" -m pip install -q -U pip
if errorlevel 1 (
  echo pip upgrade failed. Try: start.bat fixvenv
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m pip install -q -r server\requirements.txt
if errorlevel 1 (
  echo pip install failed. Try: start.bat fixvenv
  pause
  exit /b 1
)

set NEED_BUILD=0
if "%FORCE_REBUILD%"=="1" set NEED_BUILD=1
if not exist "dist\index.html" set NEED_BUILD=1

if "%NEED_BUILD%"=="1" (
  where npm >nul 2>&1
  if errorlevel 1 (
    echo dist missing/outdated and npm not found.
    pause
    exit /b 1
  )
  if not exist "node_modules\" call npm install
  echo Building frontend...
  call npm run build
  if errorlevel 1 (
    echo npm build failed.
    pause
    exit /b 1
  )
)

echo.
echo Open http://127.0.0.1:%PORT%
echo Press Ctrl+C to stop.
echo Tip: start.bat rebuild   to force rebuild frontend
echo Tip: start.bat fixvenv   if Unable to create process / ???? path
echo.
REM Never call uvicorn.exe - its launcher embeds a broken non-ASCII path.
".venv\Scripts\python.exe" -m uvicorn server.main:app --host 127.0.0.1 --port %PORT%
if errorlevel 1 (
  echo.
  echo Server failed. If you saw Unable to create process / ???? path, run: start.bat fixvenv
  pause
)
