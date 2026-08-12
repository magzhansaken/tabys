#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — шаг 2: сборка и запуск. Ресторан не затрагивается вообще.
# Запуск:  bash /opt/tabys/deploy/02_start.sh
# =====================================================================
set -euo pipefail
cd /opt/tabys/deploy

echo "=== Собираю и запускаю (первый раз 3-6 минут)"
docker compose -p tabys -f docker-compose.prod.yml up -d --build

echo
echo "=== Контейнеры Табыс:"
docker ps -a --filter name=tabys --format 'table {{.Names}}\t{{.Status}}'

echo
echo "=== Миграции базы (последние строки):"
docker logs tabys-migrate 2>&1 | tail -8 || echo "· контейнер миграций не найден"

echo
echo "=== Проверка изнутри сервера (без домена)"
echo "· жду, пока сервер поднимется (NestJS стартует несколько секунд)"
OK=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 3
  if docker exec tabys-server node -e 'fetch("http://127.0.0.1:3000/health").then(r=>r.text()).then(t=>{console.log("сервер отвечает:",t);process.exit(0)}).catch(()=>process.exit(1))' 2>/dev/null; then
    OK=1; break
  fi
  echo "  попытка $i — пока не отвечает, жду ещё"
done
if [ "$OK" = "1" ]; then
  echo "· сервер здоров"
else
  echo "· ВНИМАНИЕ: сервер не ответил за 30 секунд. Логи:"
  docker logs --tail 30 tabys-server 2>&1 || true
fi

echo
echo "=== Ресторан на месте?"
docker ps --filter name=dastarhan2 --format 'table {{.Names}}\t{{.Status}}'

echo
echo "ГОТОВО. Домен пока не подключён — это отдельный шаг 03,"
echo "он единственный трогает файл ресторана и делается по вашему слову."
