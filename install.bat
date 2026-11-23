@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "SILENT_MODE=0"
for %%A in (%*) do (
  if /I "%%~A"=="--silent" set "SILENT_MODE=1"
  if /I "%%~A"=="/S" set "SILENT_MODE=1"
)

call :FIND_NODE
if not defined NODE_EXE (
  echo Node.js v22+ LTS is required to install The Tunnel.
  where winget >nul 2>nul
  if !ERRORLEVEL! EQU 0 (
    if "!SILENT_MODE!"=="1" (
      echo Installing OpenJS.NodeJS.LTS via winget...
      winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
      call :FIND_NODE
    ) else (
      choice /C YN /M "Install Node.js LTS automatically via winget now?"
      if not errorlevel 2 (
        winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
        call :FIND_NODE
      )
    )
  )
)

if not defined NODE_EXE (
  echo [ERR] Node.js not found in PATH. Install Node.js LTS from https://nodejs.org/
  if "!SILENT_MODE!"=="0" pause
  exit /b 1
)

echo Installing The Tunnel plugin...
"%NODE_EXE%" "%~dp0install.js" %*
set "EXIT_CODE=!ERRORLEVEL!"
if !EXIT_CODE! NEQ 0 (
  echo [ERR] Installation failed with exit code !EXIT_CODE!.
  if "!SILENT_MODE!"=="0" pause
  exit /b !EXIT_CODE!
)

echo.
if "!SILENT_MODE!"=="0" pause
exit /b 0

:FIND_NODE
set "NODE_EXE="
for /f "delims=" %%P in ('where node.exe 2^>nul') do (
  if not defined NODE_EXE if exist "%%~P" set "NODE_EXE=%%~P"
)
if defined NODE_EXE goto :EOF
for %%D in (
  "%ProgramFiles%\nodejs"
  "%ProgramFiles(x86)%\nodejs"
  "%LOCALAPPDATA%\Programs\nodejs"
  "%NVM_SYMLINK%"
  "%VOLTA_HOME%\bin"
  "%USERPROFILE%\scoop\apps\nodejs\current"
  "%USERPROFILE%\scoop\apps\nodejs-lts\current"
) do (
  if not defined NODE_EXE if not "%%~D"=="" if exist "%%~D\node.exe" (
    set "NODE_EXE=%%~D\node.exe"
    set "PATH=%%~D;!PATH!"
  )
)
goto :EOF
