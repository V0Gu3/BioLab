@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo PROBIOLAB requiere Node.js 22.5 o superior.
  echo Instala Node.js y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)
start "Servidor PROBIOLAB" cmd /k "cd /d ""%~dp0"" && npm start"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8787"
endlocal
