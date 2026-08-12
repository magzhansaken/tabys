#!/usr/bin/env bash
# =====================================================================
# ЗАПУСК НА НОУТБУКЕ (Linux / macOS):  ./start.sh
# Нужны: Node.js 20+, PostgreSQL 16+ (запущенный).
# Поднимает API на :3000 и кабинет на :3001, наполняет демо-данными.
# =====================================================================
set -e
cd "$(dirname "$0")"

echo "[1/6] Проверка окружения…"
node -v >/dev/null 2>&1 || { echo "Нужен Node.js 20+: https://nodejs.org"; exit 1; }
psql --version >/dev/null 2>&1 || { echo "Нужен PostgreSQL 16+ (psql в PATH)"; exit 1; }

echo "[2/6] База данных (создаётся shop_dev, роль shop_app)…"
PSQL="psql -U postgres -h localhost"
$PSQL -tAc "SELECT 1" >/dev/null 2>&1 || PSQL="sudo -u postgres psql"
$PSQL -tAc "SELECT 1 FROM pg_database WHERE datname='shop_dev'" | grep -q 1 || $PSQL -f db/setup.sql
PGDATABASE=shop_dev PGUSER=postgres bash db/apply.sh 2>/dev/null || $PSQL -d shop_dev -f db/migrate.sql

echo "[3/6] Зависимости сервера…";  (cd server && npm install --silent)
echo "[4/6] Зависимости кабинета…"; (cd admin  && npm install --silent)

echo "[5/6] Сборка…"
(cd server && npx tsc)
(cd admin  && npx next build >/dev/null)

echo "[6/6] Запуск…"
export PGUSER=shop_app PGPASSWORD=change_me_in_prod PGDATABASE=shop_dev
export OPERATOR_KEY="${OPERATOR_KEY:-demo-operator}"
(cd server && PORT=3000 node dist/main.js) & SRV=$!
(cd admin  && npx next start -p 3001 >/dev/null 2>&1) & WEB=$!
trap "kill $SRV $WEB 2>/dev/null" EXIT

for i in $(seq 1 40); do curl -s http://localhost:3000/health >/dev/null && break; sleep 1; done
node scripts/demo_seed.js || true

echo ""
echo "======================================================"
echo "  Лендинг:   http://localhost:3001/"
echo "  Кабинет:   http://localhost:3001/login  (+7 701 000 11 22 / Demo1234)"
echo "  Оператор:  http://localhost:3001/operator  (ключ: $OPERATOR_KEY)"
echo "  API:       http://localhost:3000/health"
echo "  Остановка: Ctrl+C"
echo "======================================================"
wait
