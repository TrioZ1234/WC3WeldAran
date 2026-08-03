@echo off
chcp 65001 >nul
setlocal
title War for WeldAran - бой отрядов
cd /d "%~dp0"

if not exist "build\data\resolved\units.json" (
    echo Сначала запустите setup.bat - характеристики юнитов ещё не разрешены.
    echo.
    pause
    exit /b 1
)

echo.
echo ================================================================
echo   Боевые юниты карты
echo ================================================================
node engine\cli\run-battle.ts --list

echo.
echo ----------------------------------------------------------------
echo Введите коды двух юнитов из списка выше ^(слева, вида h01R^).
echo Просто Enter - возьмутся значения по умолчанию.
echo ----------------------------------------------------------------
echo.

set "A="
set "B="
set "N="
set /p "A=Сторона A [h01R]: "
set /p "B=Сторона B [h01V]: "
set /p "N=Юнитов в отряде [10]: "

if "%A%"=="" set "A=h01R"
if "%B%"=="" set "B=h01V"
if "%N%"=="" set "N=10"

echo.
node engine\cli\run-battle.ts --a %A% --b %B% --count %N%

echo.
pause
