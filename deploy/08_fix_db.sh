#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — сверка и починка пароля базы + НАСТОЯЩАЯ проверка работы.
#
# Зачем: сервер не мог войти в базу, хотя скрипт миграций свою проверку
# проходил. Значит пароль, с которым ЗАПУЩЕН сервер, отличается от того,
# что записан в настройках: контейнер мог остаться со старым значением.
#
# Скрипт:
#   1) сравнивает пароль в настройках и пароль запущенного сервера;
#   2) приводит пароль роли в базе в соответствие с настройками;
#   3) при расхождении пересоздаёт контейнер сервера;
#   4) делает НАСТОЯЩУЮ проверку: регистрирует тестовый магазин через
#      сайт и удаляет его. Именно этого не хватало — прежние проверки
#      базу не трогали, поэтому поломки доживали до живого клиента.
# =====================================================================
set -euo pipefail
cd /opt/tabys/deploy
set -a; . ./.env; set +a

short() { echo "${1:0:8}…"; }

echo "=== 1/4 Сверка паролей"
CFG_PW="${DB_APP_PASSWORD:-}"
[ -n "$CFG_PW" ] || { echo "ОШИБКА: DB_APP_PASSWORD пуст в .env"; exit 1; }
SRV_PW="$(docker exec tabys-server printenv PGPASSWORD 2>/dev/null || echo '')"
echo "· в настройках:      $(short "$CFG_PW")"
echo "· у сервера сейчас:  $(short "${SRV_PW:-пусто}")"
if [ "$SRV_PW" = "$CFG_PW" ]; then
  echo "· совпадают"
  RECREATE=0
else
  echo "· РАСХОЖДЕНИЕ — вот причина ошибки. Пересоздам контейнер сервера."
  RECREATE=1
fi

echo
echo "=== 2/4 Устанавливаю пароль роли в базе"
docker exec -e PGPASSWORD="$DB_SUPER_PASSWORD" -i tabys-db \
  psql -v ON_ERROR_STOP=1 -q -U postgres -d shop -v pw="$CFG_PW" <<'SQL'
ALTER ROLE shop_app PASSWORD :'pw';
SQL
echo "· пароль установлен"

# Проверяем ИЗ КОНТЕЙНЕРА СЕРВЕРА, а не из базы. Прежняя проверка изнутри
# базы всегда проходила: подключение к самой себе разрешено без пароля —
# и она скрывала настоящую поломку. Проверять надо тем путём, которым
# ходит приложение, иначе проверка бесполезна.
echo "· проверяю подключение ИЗ контейнера сервера (как ходит приложение)"
if docker exec tabys-server node -e "const{Client}=require('pg');const c=new Client();c.connect().then(()=>c.query('SELECT current_database() d, current_user u, (SELECT count(*) FROM schema_migrations) m')).then(r=>{console.log('  база:',r.rows[0].d,'| роль:',r.rows[0].u,'| миграций:',r.rows[0].m);return c.end()}).then(()=>process.exit(0)).catch(e=>{console.log('  ошибка:',e.message);process.exit(1)})" 2>&1; then
  echo "· сервер видит НАШУ базу"
else
  echo "ОШИБКА: сервер не подключается к базе."
  echo "Если написано «неверный пароль» — сервер уходит в чужую базу."
  echo "Лечится обновлением: bash /opt/tabys/deploy/05_update.sh"
  exit 1
fi

echo
echo "=== 3/4 Контейнер сервера"
if [ "$RECREATE" = "1" ]; then
  docker compose -p tabys -f docker-compose.prod.yml up -d --force-recreate server admin
  echo "· пересоздан с настройками из .env"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    docker logs --tail 5 tabys-server 2>&1 | grep -q "слушает порт" && break
    echo "  жду запуска ($i)"
  done
else
  echo "· пересоздание не требуется"
fi

echo
echo "=== 4/4 НАСТОЯЩАЯ проверка: регистрация тестового магазина"
PHONE="+7700$(shuf -i 1000000-9999999 -n 1)"
RESP=$(curl -s -X POST https://tabys.duckdns.org/api/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"businessName\":\"Служебная проверка\",\"ownerName\":\"Проверка\",\"password\":\"Password123\"}" || echo '')

if echo "$RESP" | grep -q '"access"'; then
  echo "· РЕГИСТРАЦИЯ РАБОТАЕТ — магазин создан через сайт"
  # убираем за собой, чтобы служебные записи не мешались в списке заявок
  docker exec -e PGPASSWORD="$DB_SUPER_PASSWORD" tabys-db \
    psql -q -U postgres -d shop -c "DELETE FROM account WHERE phone = '$PHONE'" >/dev/null 2>&1 \
    && echo "· тестовый магазин удалён"
  echo
  echo "ГОТОВО. Можно регистрироваться на сайте по-настоящему."
else
  echo "· РЕГИСТРАЦИЯ НЕ РАБОТАЕТ. Ответ сервера:"
  echo "$RESP" | head -c 300; echo
  echo
  echo "Последние ошибки сервера:"
  docker logs --tail 15 tabys-server 2>&1 | tail -10
  exit 1
fi
