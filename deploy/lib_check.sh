#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — общие проверки. Подключается точкой в другие скрипты:
#   source /opt/tabys/deploy/lib_check.sh
#
# ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ: одни и те же проверки нужны и при обновлении,
# и при разборе поломок. Копия в двух местах рано или поздно разъезжается,
# и одна из копий начинает врать.
#
# ГЛАВНЫЙ УРОК, из которого выросли эти проверки: за три дня запуска было
# четыре сбоя подряд, и КАЖДЫЙ прошёл мимо проверок. Сервер отвечал 200,
# страницы открывались, контейнеры работали — а зарегистрироваться было
# нельзя. Проверка обязана делать то, что делает клиент.
# =====================================================================

TABYS_DIR=/opt/tabys/deploy
TABYS_DOMAIN=tabys.duckdns.org
TABYS_API="https://$TABYS_DOMAIN/api"
CADDY_PATHS=/opt/dastarhan2/deploy/Caddyfile.paths

# ── 1. Сервер видит СВОЮ базу ────────────────────────────────────────
# Проверяем изнутри контейнера сервера — тем путём, которым ходит
# приложение. Проверка изнутри базы однажды уже обманула нас: подключение
# к самой себе разрешено без пароля, и она рапортовала «всё хорошо»
# поверх сломанной системы.
check_db() {
  echo "── База данных"
  local out
  out=$(docker exec tabys-server node -e "
const {Client} = require('pg'); const c = new Client();
c.connect()
 .then(() => c.query(\"SELECT current_database() d, current_user u, (SELECT count(*) FROM schema_migrations) m\"))
 .then(r => { console.log('   база: ' + r.rows[0].d + ' | роль: ' + r.rows[0].u + ' | миграций: ' + r.rows[0].m); return c.end(); })
 .then(() => process.exit(0))
 .catch(e => { console.log('   ОШИБКА: ' + e.message); process.exit(1); })
" 2>&1)
  echo "$out"
  if echo "$out" | grep -q 'ОШИБКА'; then
    echo "   Если написано «неверный пароль» — сервер уходит в чужую базу."
    echo "   Лечится: bash $TABYS_DIR/08_fix_db.sh"
    return 1
  fi
  return 0
}

# ── 2. Маршрут домена на месте ───────────────────────────────────────
# Наш блок живёт в файле ресторана и однажды уже пропал при их обновлении —
# сайт лёг, и узнали мы об этом от клиента, а не от проверки.
check_route() {
  echo "── Маршрут домена"
  if grep -q "^$TABYS_DOMAIN {" "$CADDY_PATHS" 2>/dev/null; then
    echo "   блок на месте"
    return 0
  fi
  echo "   ВНИМАНИЕ: блока $TABYS_DOMAIN нет в файле маршрутов!"
  echo "   Скорее всего его затёрло обновлением ресторана. Сайт недоступен."
  echo "   Восстановить: bash $TABYS_DIR/07_fix_route.sh"
  return 1
}

# ── 3. Доступность адресов ───────────────────────────────────────────
check_urls() {
  echo "── Доступность"
  local ok=0
  for pair in "сервер:$TABYS_API/health" "кабинет:https://$TABYS_DOMAIN/login" "лендинг:https://$TABYS_DOMAIN/"; do
    local name="${pair%%:*}" url="${pair#*:}"
    local code; code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" || echo 000)
    printf '   %-9s %s\n' "$name" "$code"
    [ "$code" = "200" ] || ok=1
  done
  # ресторан проверяем всегда: наши работы не должны его задевать
  local rest; rest=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://dastarhan.duckdns.org/office/ || echo 000)
  printf '   %-9s %s  (сосед, не должен пострадать)\n' "ресторан" "$rest"
  [ "$rest" = "200" ] || ok=1
  return $ok
}

# ── 4. НАСТОЯЩАЯ проверка: регистрация через сайт ────────────────────
# Полный путь клиента: интернет → Caddy → сервер → запись в базу →
# чтение обратно. Именно это ломалось четыре раза подряд, пока проверки
# смотрели на другое.
#
# За собой убираем: аккаунт удаляется ПО ТОЧНОМУ ИДЕНТИФИКАТОРУ из
# выданного токена, а не по имени. Удаление по имени однажды снесло бы
# живого клиента с похожим названием.
check_registration() {
  echo "── Регистрация через сайт (полный путь клиента)"
  local phone="+7700$(shuf -i 1000000-9999999 -n 1)"
  local resp
  resp=$(curl -s --max-time 25 -X POST "$TABYS_API/auth/register" \
    -H 'Content-Type: application/json' \
    -d "{\"phone\":\"$phone\",\"businessName\":\"Служебная проверка\",\"ownerName\":\"Проверка\",\"password\":\"Password123\"}" || echo '')

  if ! echo "$resp" | grep -q '"access"'; then
    echo "   НЕ РАБОТАЕТ. Ответ сервера:"
    echo "   $(echo "$resp" | head -c 200)"
    echo "   Последние ошибки сервера:"
    docker logs --tail 12 tabys-server 2>&1 | sed 's/^/   /' | tail -8
    return 1
  fi
  echo "   магазин создан через сайт"

  # Достаём идентификатор аккаунта из токена — так удаление точное.
  local acc
  acc=$(python3 - "$resp" <<'PY' 2>/dev/null
import sys, json, base64
try:
    tok = json.loads(sys.argv[1])["access"]
    p = tok.split(".")[1]
    p += "=" * (-len(p) % 4)
    print(json.loads(base64.urlsafe_b64decode(p))["acc"])
except Exception:
    pass
PY
)
  if [ -n "$acc" ]; then
    docker exec -e PGPASSWORD="$DB_SUPER_PASSWORD" tabys-db \
      psql -q -U postgres -d shop -c "DELETE FROM account WHERE id = '$acc'" >/dev/null 2>&1 \
      && echo "   служебный магазин удалён" \
      || echo "   ВНИМАНИЕ: не удалось удалить служебный магазин $acc"
  else
    # Запасной путь: чистим по телефону — он уникален и только что создан.
    docker exec -e PGPASSWORD="$DB_SUPER_PASSWORD" tabys-db \
      psql -q -U postgres -d shop -c "DELETE FROM account WHERE phone = '$phone'" >/dev/null 2>&1 \
      && echo "   служебный магазин удалён (по телефону)"
  fi
  return 0
}

# ── Уборка следов прошлых проверок ───────────────────────────────────
# Если удаление когда-то не прошло (сеть оборвалась), служебные записи
# копятся в списке заявок и мешают. Чистим только СВОИ: точное имя,
# нулевые продажи и возраст больше часа — живого клиента не заденем.
cleanup_test_accounts() {
  docker exec -e PGPASSWORD="$DB_SUPER_PASSWORD" tabys-db psql -q -U postgres -d shop -c "
    DELETE FROM account a
     WHERE a.name = 'Служебная проверка'
       AND a.created_at < now() - interval '1 hour'
       AND NOT EXISTS (SELECT 1 FROM sale s WHERE s.account_id = a.id)" >/dev/null 2>&1 || true
}

# ── Сводка ───────────────────────────────────────────────────────────
run_all_checks() {
  local fails=0
  echo
  echo "═══ ПРОВЕРКА ПОСЛЕ ВЫКЛАДКИ ═══"
  check_route || fails=$((fails+1))
  check_db || fails=$((fails+1))
  check_urls || fails=$((fails+1))
  cleanup_test_accounts
  check_registration || fails=$((fails+1))
  echo
  if [ "$fails" = "0" ]; then
    echo "═══ ВСЁ РАБОТАЕТ ═══"
    echo "Это не «ГОТОВО» на словах: магазин действительно создан через"
    echo "сайт и записан в базу, потом удалён."
  else
    echo "═══ ЕСТЬ ПРОБЛЕМЫ: $fails ═══"
    echo "Смотрите подсказки выше — в каждой написано, чем лечить."
  fi
  return $fails
}
