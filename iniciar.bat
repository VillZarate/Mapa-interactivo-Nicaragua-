@echo off
cd /d "%~dp0"
echo Mapa de Nicaragua: abriendo http://localhost:8000
echo Deja esta ventana abierta mientras uses el mapa. Ciérrala para detener el servidor.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8000"
where py >nul 2>nul && (py -m http.server 8000) || (python -m http.server 8000)
pause
