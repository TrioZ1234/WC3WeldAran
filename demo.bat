@echo off
chcp 65001 >nul
setlocal
title War for WeldAran - бой в браузере
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY ( where py >nul 2>nul && set "PY=py -3" )
if not defined PY (
    echo Python не найден. Запустите setup.bat.
    echo.
    pause
    exit /b 1
)

if not exist "build\data\resolved\units.json" (
    echo Сначала запустите setup.bat.
    echo.
    pause
    exit /b 1
)

if not exist "build\war3\art" (
    echo Графика ещё не скачана, качаю ^(~39 МБ^)...
    echo.
    %PY% tools\analyze_assets.py build\extracted build\data --json docs\data\asset-gap.json >nul
    %PY% tools\fetch_war3_art.py
    if errorlevel 1 (
        echo.
        echo Не удалось скачать графику. Проверьте интернет.
        echo.
        pause
        exit /b 1
    )
    echo.
)

echo Собираю страницу...
%PY% tools\make_battle_demo.py
if errorlevel 1 (
    echo.
    echo Не удалось собрать страницу.
    echo.
    pause
    exit /b 1
)

echo.
echo Открываю в браузере...
start "" "build\battle.html"

echo.
echo Страница лежит здесь: %CD%\build\battle.html
echo Можно открыть её в любой момент, сервер не нужен.
echo.
pause
