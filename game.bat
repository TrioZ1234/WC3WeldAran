@echo off
chcp 65001 >nul
title War for WeldAran - партия
cd /d "%~dp0"

if not exist "build\extracted\war3map.j" (
    echo Сначала запустите setup.bat - карта ещё не распакована.
    echo.
    pause
    exit /b 1
)

set "SECONDS=%~1"
if "%SECONDS%"=="" set "SECONDS=300"

echo.
echo Симулируется %SECONDS% секунд игрового времени.
echo Карта инициализируется, идут часы 32 Гц, юниты спавнятся и дерутся.
echo.
echo Чтобы задать другую длительность: game.bat 600
echo.

node engine\cli\run-game.ts --seconds %SECONDS%

echo.
pause
