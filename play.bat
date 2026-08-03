@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title War for WeldAran

REM ===========================================================================
REM  Запуск War for WeldAran на Windows одним файлом.
REM
REM  Как пользоваться:
REM    play.bat                        собрать (если нужно) и запустить
REM    play.bat путь\к\WFWA.w3x        пересобрать данные из карты и запустить
REM    перетащить .w3x на этот файл    то же самое
REM    play.bat --assets               ещё и сконвертировать текстуры и модели
REM    play.bat --test                 прогнать тесты перед запуском
REM
REM  Каждый шаг объясняет, что делает, и останавливается с внятной причиной,
REM  а не с кодом ошибки. Ничего не удаляет, кроме собственного каталога build.
REM ===========================================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "MAP="
set "RUNTESTS="
set "WITHASSETS="


REM Разбор аргументов: флаг или путь к карте.
:args
if "%~1"=="" goto args_done
if /i "%~1"=="--test" (
  set "RUNTESTS=1"
) else if /i "%~1"=="--assets" (
  set "WITHASSETS=1"
) else (
  set "MAP=%~f1"
)
shift
goto args
:args_done

echo.
echo ==========================================================
echo   War for WeldAran — перенос карты из Warcraft III
echo ==========================================================
echo.

REM ---------------------------------------------------------------------------
REM  1. Репозиторий
REM ---------------------------------------------------------------------------

if not exist "%ROOT%\build.py" (
  echo [1/7] Репозитория рядом нет — попробую скачать.
  where git >nul 2>&1
  if errorlevel 1 (
    echo.
    echo   Не найден git, а рядом с батником нет файлов проекта.
    echo   Положите play.bat в корень репозитория WC3WeldAran либо
    echo   установите git: https://git-scm.com/download/win
    goto fail
  )
  git clone --branch shell/game-interface-and-lobby https://github.com/TrioZ1234/WC3WeldAran.git "%ROOT%\WC3WeldAran"
  if errorlevel 1 goto fail
  set "ROOT=%ROOT%\WC3WeldAran"
  echo   Скачано в %ROOT%
) else (
  echo [1/7] Репозиторий: %ROOT%
)

REM Оболочка живёт в отдельной ветке, в main её пока нет.
if not exist "%ROOT%\web\src\shell\app.ts" (
  echo.
  echo   В этой копии нет файлов оболочки — похоже, ветка main.
  echo   Переключаюсь на ветку с интерфейсом.
  pushd "%ROOT%"
  git fetch origin shell/game-interface-and-lobby
  if errorlevel 1 (popd & goto fail)
  git checkout shell/game-interface-and-lobby
  if errorlevel 1 (popd & goto fail)
  popd
)

REM ---------------------------------------------------------------------------
REM  2. Python — им работает конвейер карты
REM ---------------------------------------------------------------------------

set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY (python --version >nul 2>&1 && set "PY=python")
if not defined PY (
  echo.
  echo   Не найден Python 3. Он нужен, чтобы разобрать .w3x.
  echo   Поставьте с python.org и отметьте "Add python.exe to PATH".
  goto fail
)
for /f "tokens=2" %%v in ('%PY% --version 2^>^&1') do set "PYVER=%%v"
echo [2/7] Python %PYVER%

REM ---------------------------------------------------------------------------
REM  3. Node.js — на нём собирается и работает клиент
REM ---------------------------------------------------------------------------

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Не найден Node.js. Он нужен для веб-клиента.
  echo   Поставьте LTS с nodejs.org, затем запустите этот файл заново.
  goto fail
)
for /f "tokens=* delims=v" %%v in ('node -v') do set "NODEVER=%%v"
for /f "tokens=1 delims=." %%v in ("!NODEVER!") do set "NODEMAJOR=%%v"
echo [3/7] Node.js !NODEVER!
if !NODEMAJOR! LSS 20 (
  echo.
  echo   Нужен Node.js 20 или новее, у вас !NODEVER!.
  goto fail
)

REM ---------------------------------------------------------------------------
REM  4. Данные карты
REM ---------------------------------------------------------------------------

REM Карта в репозитории не хранится: 25 МБ бинарника в истории git никому
REM не помогут. Если её не передали — поищем рядом.
if not defined MAP (
  for %%f in ("%ROOT%\*.w3x") do if not defined MAP set "MAP=%%~ff"
)

set "HAVEDATA="
if exist "%ROOT%\web\public\data\map.json" set "HAVEDATA=1"

if defined MAP (
  echo [4/7] Карта: %MAP%

  REM Конвертация текстур и моделей требует Pillow и занимает минуты, а юниты
  REM пока рисуются кубами — до подключения моделей эти файлы никто не читает.
  REM Поэтому по умолчанию собираются только данные: это секунды.
  set "BUILDFLAGS=--skip-assets"
  if defined WITHASSETS (
    %PY% -c "import PIL" >nul 2>&1
    if errorlevel 1 (
      echo       Для конвертации графики нужен Pillow, ставлю.
      %PY% -m pip install Pillow
      if errorlevel 1 (
        echo       Не удалось поставить Pillow — соберу без графики.
        echo       Это ничего не меняет: модели пока не рисуются.
      ) else (
        set "BUILDFLAGS="
      )
    ) else (
      set "BUILDFLAGS="
    )
  )

  if defined WITHASSETS (
    echo       Собираю данные и графику — это несколько минут.
  ) else (
    echo       Собираю данные карты. Графику пропускаю: play.bat --assets, если нужна.
  )
  pushd "%ROOT%"
  %PY% build.py "%MAP%" !BUILDFLAGS!
  if errorlevel 1 (popd & goto fail)
  popd
  set "HAVEDATA=1"
) else if defined HAVEDATA (
  echo [4/7] Данные карты уже собраны, пропускаю.
  echo       Чтобы пересобрать: play.bat путь\к\WFWA.w3x
) else (
  echo [4/7] Файл .w3x не найден, данных карты нет.
  echo.
  echo       Клиент всё равно запустится, но покажет тренировочный бой
  echo       на условных характеристиках — это не сама карта.
  echo       Чтобы играть в карту, положите WFWA_v0.9.9q.w3x рядом
  echo       с этим файлом и запустите его снова.
  echo.
)

REM ---------------------------------------------------------------------------
REM  5. Скрипты и таблицы Warcraft III
REM ---------------------------------------------------------------------------

REM common.j, Blizzard.j и стоковый баланс — около 4 МБ, в git не хранятся.
REM Без них скрипт карты не исполняется: нативные функции не объявлены.
if defined HAVEDATA (
  if not exist "%ROOT%\build\war3\common.j" (
    echo [5/7] Загружаю скрипты и таблицы Warcraft III, ~4 МБ.
    pushd "%ROOT%"
    %PY% tools\fetch_war3_data.py
    if errorlevel 1 (
      echo       Не удалось загрузить — нужен интернет.
      echo       Без этих файлов будет тренировочный бой вместо карты.
    )
    popd
  ) else (
    echo [5/7] Скрипты Warcraft III уже на месте.
  )

  if exist "%ROOT%\build\war3\common.j" (
    if not exist "%ROOT%\build\data\resolved\units.json" (
      echo       Сверяю объекты карты со стоковыми прототипами.
      pushd "%ROOT%"
      %PY% tools\export_stock.py build\war3 build\data
      if errorlevel 1 (popd & goto fail)
      popd
    )
    REM Скрипты нужны браузеру по HTTP: карта исполняется в воркере.
    pushd "%ROOT%"
    %PY% build.py --stage-only >nul
    popd
  )
) else (
  echo [5/7] Нечего сверять — данных карты нет.
)

REM ---------------------------------------------------------------------------
REM  6. Зависимости клиента и проверка типов
REM ---------------------------------------------------------------------------

pushd "%ROOT%\web"

if not exist "node_modules" (
  echo [6/7] Ставлю зависимости клиента.
  call npm install
  if errorlevel 1 (popd & goto fail)
) else (
  echo [6/7] Зависимости уже установлены.
)

REM Проверка типов не выполнялась там, где этот код готовился: не было доступа
REM к npm. Поэтому она здесь, и её результат стоит показать автору.
echo       Проверяю типы.
call npm run typecheck
if errorlevel 1 (
  echo.
  echo       Проверка типов нашла ошибки. Дев-сервер их не блокирует,
  echo       игра запустится, но ошибки выше стоит показать автору кода.
  echo.
) else (
  echo       Типы в порядке.
)

if defined RUNTESTS (
  if !NODEMAJOR! LSS 23 (
    echo       Тесты пропущены: Node !NODEVER! не исполняет TypeScript напрямую,
    echo       для них нужен Node 23 или новее. Игру это не затрагивает.
  ) else (
    echo       Прогоняю тесты.
    pushd "%ROOT%"
    node engine\test\smoke.ts
    node web\test\smoke.ts
    popd
  )
  echo.
)

REM ---------------------------------------------------------------------------
REM  7. Запуск
REM ---------------------------------------------------------------------------

echo [7/7] Запускаю. Браузер откроется сам через несколько секунд.
echo.
echo       Адрес:  http://localhost:5173
echo       Нужен  Chrome или Edge 113+ — клиент рисует через WebGPU.
echo       Выход: закройте это окно или нажмите Ctrl+C.
echo.
echo       В меню: "Одиночная игра" — лобби на 12 слотов.
echo       Кнопка "Заполнить ботами" занимает все свободные слоты.
echo.

start "" /min cmd /c "ping -n 7 127.0.0.1 >nul & start http://localhost:5173"
call npm run dev

popd
echo.
echo Сервер остановлен.
pause
exit /b 0

:fail
echo.
echo ==========================================================
echo   Не получилось. Причина выше.
echo ==========================================================
echo.
pause
exit /b 1
