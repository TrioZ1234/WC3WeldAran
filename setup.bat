@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title War for WeldAran - настройка
cd /d "%~dp0"

echo.
echo ================================================================
echo   War for WeldAran - настройка движка
echo ================================================================
echo.
echo Этот файл подготовит всё к запуску. Займёт около двух минут.
echo Интернет нужен: скачаются скрипты и графика Warcraft III ^(~44 МБ^).
echo.

REM ---------------------------------------------------------------- Python
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY (
    where py >nul 2>nul && set "PY=py -3"
)
if not defined PY (
    echo [ОШИБКА] Python не найден.
    echo.
    echo   Установите Python 3.11 или новее: https://www.python.org/downloads/
    echo   При установке ОБЯЗАТЕЛЬНО отметьте "Add python.exe to PATH".
    echo   После установки закройте это окно и запустите setup.bat заново.
    goto :fail
)
for /f "tokens=2" %%v in ('%PY% --version 2^>^&1') do set "PYVER=%%v"
echo [ok] Python !PYVER!

REM ------------------------------------------------------------------ Node
where node >nul 2>nul
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден.
    echo.
    echo   Установите Node.js 24 LTS: https://nodejs.org/
    echo   После установки закройте это окно и запустите setup.bat заново.
    goto :fail
)
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODEVER=%%v"
set "NODENUM=!NODEVER:v=!"
for /f "tokens=1,2 delims=." %%a in ("!NODENUM!") do (
    set "NMAJ=%%a"
    set "NMIN=%%b"
)
REM Прямое исполнение TypeScript без флага доступно с Node 23.6
set "NODEOK=0"
if !NMAJ! GEQ 24 set "NODEOK=1"
if !NMAJ! EQU 23 if !NMIN! GEQ 6 set "NODEOK=1"
if "!NODEOK!"=="0" (
    echo [ОШИБКА] Node.js !NODEVER! слишком старый.
    echo.
    echo   Нужен Node.js 23.6 или новее - с этой версии TypeScript
    echo   исполняется напрямую, без сборки.
    echo   Скачать: https://nodejs.org/  ^(берите версию LTS^)
    goto :fail
)
echo [ok] Node.js !NODEVER!

REM ------------------------------------------------------------------- Карта
set "MAP=%~1"
if not "%MAP%"=="" goto :havemap
for %%f in ("*.w3x") do (
    set "MAP=%%~ff"
    goto :havemap
)
for %%f in ("*.w3m") do (
    set "MAP=%%~ff"
    goto :havemap
)
echo [ОШИБКА] Файл карты не найден.
echo.
echo   Положите свой .w3x рядом с этим файлом и запустите заново,
echo   либо перетащите .w3x мышкой прямо на setup.bat
goto :fail

:havemap
if not exist "%MAP%" (
    echo [ОШИБКА] Файл карты не найден: %MAP%
    goto :fail
)
for %%f in ("%MAP%") do set "MAPNAME=%%~nxf"
echo [ok] Карта: !MAPNAME!
echo.

REM -------------------------------------------------------------- Pillow
echo ----------------------------------------------------------------
echo  Шаг 1 из 6. Библиотека Pillow ^(нужна для конвертации текстур^)
echo ----------------------------------------------------------------
%PY% -c "import PIL" 2>nul
if errorlevel 1 (
    %PY% -m pip install --quiet --disable-pip-version-check Pillow
    if errorlevel 1 (
        echo [ОШИБКА] Не удалось установить Pillow.
        echo   Попробуйте вручную:  %PY% -m pip install Pillow
        goto :fail
    )
    echo   установлена
) else (
    echo   уже установлена
)
echo.

REM --------------------------------------------------------------- Конвейер
echo ----------------------------------------------------------------
echo  Шаг 2 из 6. Распаковка карты и конвертация ассетов
echo ----------------------------------------------------------------
%PY% build.py "%MAP%"
if errorlevel 1 goto :buildfail
echo.

echo ----------------------------------------------------------------
echo  Шаг 3 из 6. Скрипты и таблицы Warcraft III ^(~4 МБ^)
echo ----------------------------------------------------------------
%PY% tools\fetch_war3_data.py
if errorlevel 1 goto :netfail
echo.

echo ----------------------------------------------------------------
echo  Шаг 4 из 6. Разрешение объектов карты против прототипов
echo ----------------------------------------------------------------
%PY% tools\export_stock.py build\war3 build\data
if errorlevel 1 goto :fail
echo.

echo ----------------------------------------------------------------
echo  Шаг 5 из 6. Графика Warcraft III ^(~39 МБ, около минуты^)
echo ----------------------------------------------------------------
%PY% tools\analyze_assets.py build\extracted build\data --json docs\data\asset-gap.json >nul
%PY% tools\fetch_war3_art.py
if errorlevel 1 (
    echo   [!] Графику скачать не удалось. Это не критично:
    echo       движок и консольные стенды работают без неё,
    echo       не соберётся только браузерный стенд боя.
) else (
    %PY% tools\make_battle_demo.py
)
echo.

echo ----------------------------------------------------------------
echo  Шаг 6 из 6. Проверка
echo ----------------------------------------------------------------
node engine\test\smoke.ts
if errorlevel 1 (
    echo.
    echo   [!] Часть проверок не прошла. Пришлите вывод выше - разберём.
)
echo.

echo ================================================================
echo   Готово. Что запускать дальше:
echo ================================================================
echo.
echo   game.bat     партия: время идёт, юниты спавнятся и дерутся
echo   battle.bat   бой двух отрядов в консоли, с проверкой детерминизма
echo   demo.bat     тот же бой в браузере, с иконками юнитов
echo   tests.bat    99 проверок движка
echo.
echo   Просто дважды кликните по нужному файлу.
echo.
pause
exit /b 0

:buildfail
echo.
echo [ОШИБКА] Не удалось разобрать карту.
echo   Проверьте, что файл не повреждён и это действительно .w3x
goto :fail

:netfail
echo.
echo [ОШИБКА] Не удалось скачать данные Warcraft III.
echo   Проверьте интернет. Если мешает антивирус или прокси -
echo   файлы берутся с raw.githubusercontent.com
goto :fail

:fail
echo.
pause
exit /b 1
