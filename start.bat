@echo off
REM ===================================================================
REM  ЗАПУСК НА WINDOWS:  двойной клик или start.bat в терминале
REM  Нужны: Node.js 20+ (nodejs.org), PostgreSQL 16+ (запущенная служба)
REM ===================================================================
cd /d "%~dp0"

where node >nul 2>nul || (echo Ustanovite Node.js 20+: nodejs.org & pause & exit /b 1)
where psql >nul 2>nul || (echo Dobavte PostgreSQL bin v PATH - psql ne naiden & pause & exit /b 1)

echo [1/5] База данных...
psql -U postgres -h localhost -tAc "SELECT 1 FROM pg_database WHERE datname='shop_dev'" | findstr 1 >nul || psql -U postgres -h localhost -f db\setup.sql
psql -U postgres -h localhost -d shop_dev -f db\migrate.sql >nul

echo [2/5] Зависимости сервера...
cd server && call npm install --silent && cd ..
echo [3/5] Зависимости кабинета...
cd admin && call npm install --silent && cd ..

echo [4/5] Сборка...
cd server && call npx tsc && cd ..
cd admin && call npx next build >nul && cd ..

echo [5/5] Запуск...
set PGUSER=shop_app
set PGPASSWORD=change_me_in_prod
set PGDATABASE=shop_dev
if "%OPERATOR_KEY%"=="" set OPERATOR_KEY=demo-operator
start "shop-api" cmd /c "cd server && set PORT=3000&& node dist\main.js"
start "shop-admin" cmd /c "cd admin && npx next start -p 3001"
timeout /t 8 /nobreak >nul
node scripts\demo_seed.js

echo.
echo ======================================================
echo   Лендинг:   http://localhost:3001/
echo   Кабинет:   http://localhost:3001/login  (+7 701 000 11 22 / Demo1234)
echo   Оператор:  http://localhost:3001/operator  (ключ: %OPERATOR_KEY%)
echo   Окна "shop-api" и "shop-admin" не закрывайте.
echo ======================================================
pause
