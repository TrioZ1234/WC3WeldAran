@echo off
chcp 65001 >nul
title War for WeldAran - проверки
cd /d "%~dp0"

echo.
echo Регрессионный тест движка.
echo.
echo Проверяется лексер и парсер JASS, семантика языка, хендлы,
echo фиксированная точка, боевая математика, таймеры, корутины
echo и живая симуляция на реальной карте.
echo.
echo Без данных сборки часть проверок пропускается - это нормально.
echo.

node engine\test\smoke.ts

echo.
pause
