# =====================================================================
#  ЗАПУСК SHOP НА WINDOWS (PowerShell)  -  версия 2
#  Из папки shop:  powershell -ExecutionPolicy Bypass -File .\start.ps1
#
#  Почему v2: PowerShell 5 считает ЛЮБОЙ текст в stderr ошибкой - даже
#  "ЗАМЕЧАНИЕ" PostgreSQL. Все вызовы psql теперь идут через cmd /c
#  с 2>&1, а решает только код возврата. База пересоздаётся начисто.
# =====================================================================
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$env:PGCLIENTENCODING = "UTF8"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; chcp 65001 | Out-Null } catch {}

function Fail($msg) { Write-Host ""; Write-Host "ОШИБКА: $msg" -ForegroundColor Red; Read-Host "Enter для выхода"; exit 1 }
function RunPsql($args_) {
    # cmd /c сливает stderr в stdout - PS5 не паникует на "ЗАМЕЧАНИЕ"
    $out = cmd /c "psql $args_ 2>&1"
    return @{ code = $LASTEXITCODE; out = ($out -join "`n") }
}
function Tail($s) { if ($s.Length -gt 600) { $s.Substring($s.Length-600) } else { $s } }

Write-Host "[1/6] Проверка окружения..." -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js не найден: https://nodejs.org" }
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) {
    $pg = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\psql.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pg) { $env:Path += ";" + $pg.DirectoryName } else { Fail "psql не найден - установите PostgreSQL" }
}
if (-not $env:PGPASSWORD) { $env:PGPASSWORD = Read-Host "Пароль пользователя postgres" }
$r = RunPsql "-U postgres -h localhost -tAc ""SELECT 1"""
if ($r.code -ne 0) { Fail "Нет подключения к PostgreSQL. Проверьте пароль и службу. Ответ: $($r.out)" }

Write-Host "[2/6] База shop_dev (пересоздаётся начисто)..." -ForegroundColor Cyan
$r = RunPsql "-U postgres -h localhost -v ON_ERROR_STOP=1 -f db\setup.sql"
if ($r.code -ne 0) { Fail ("db\setup.sql: " + (Tail $r.out)) }
Write-Host "      применяю миграции (полминуты)..." -ForegroundColor DarkGray
$r = RunPsql "-U postgres -h localhost -d shop_dev -v ON_ERROR_STOP=1 -q -f db\migrate.sql"
if ($r.code -ne 0) { Fail ("миграции: " + (Tail $r.out)) }
Write-Host "      база готова" -ForegroundColor DarkGray

Write-Host "[3/6] Зависимости сервера (первый раз - несколько минут)..." -ForegroundColor Cyan
Push-Location server; cmd /c "npm install --no-audit --no-fund 2>&1" | Out-Null
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm install в server" }; Pop-Location

Write-Host "[4/6] Зависимости кабинета..." -ForegroundColor Cyan
Push-Location admin; cmd /c "npm install --no-audit --no-fund 2>&1" | Out-Null
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm install в admin" }; Pop-Location

Write-Host "[5/6] Сборка (сервер + кабинет, пара минут)..." -ForegroundColor Cyan
Push-Location server; cmd /c "npx tsc 2>&1"
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "сборка сервера (tsc)" }; Pop-Location
Push-Location admin; cmd /c "npx next build 2>&1" | Out-Null
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "сборка кабинета (next build)" }; Pop-Location

Write-Host "[6/6] Запуск..." -ForegroundColor Cyan
$env:PGUSER = "shop_app"; $env:PGPASSWORD = "change_me_in_prod"; $env:PGDATABASE = "shop_dev"
if (-not $env:OPERATOR_KEY) { $env:OPERATOR_KEY = "demo-operator" }

Start-Process -WindowStyle Minimized cmd -ArgumentList "/k","title shop-api && cd server && set PORT=3000&& node dist\main.js" | Out-Null
Start-Process -WindowStyle Minimized cmd -ArgumentList "/k","title shop-admin && cd admin && npx next start -p 3001" | Out-Null

Write-Host "      жду API..." -ForegroundColor DarkGray
$up = $false
for ($i = 0; $i -lt 40; $i++) {
    try { Invoke-RestMethod http://localhost:3000/health -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep 1 }
}
if (-not $up) { Fail "API не поднялся. Разверните окно shop-api на панели задач и пришлите текст оттуда" }

Write-Host "      наполняю демо-магазин..." -ForegroundColor DarkGray
node scripts\demo_seed.js
if ($LASTEXITCODE -ne 0) { Write-Host "      (демо споткнулось - кабинет всё равно работает)" -ForegroundColor Yellow }

Write-Host ""
Write-Host "======================================================" -ForegroundColor Green
Write-Host "  Лендинг:   http://localhost:3001/"
Write-Host "  Кабинет:   http://localhost:3001/login   (+77010001122 / Demo1234)"
Write-Host "  Оператор:  http://localhost:3001/operator (ключ: $($env:OPERATOR_KEY))"
Write-Host "  Свёрнутые окна shop-api и shop-admin не закрывайте."
Write-Host "======================================================" -ForegroundColor Green
Start-Process "http://localhost:3001/"
Read-Host "Enter чтобы закончить (серверы останутся работать)"
