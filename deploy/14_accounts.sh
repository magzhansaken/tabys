#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — какие магазины есть на сервере.
#
# Нужен, когда непонятно, под каким телефоном вы регистрировались:
# показывает телефон, название, состояние и имя владельца.
#
# Пароли НЕ показывает и показать не может — они хранятся отпечатком,
# как и положено. Если пароль забыт, есть отдельная команда сброса.
#
# Запуск:  bash /opt/tabys/deploy/14_accounts.sh
# Сброс пароля: bash /opt/tabys/deploy/14_accounts.sh --reset +7777... НовыйПароль
# =====================================================================
set -uo pipefail
cd /opt/tabys/deploy
set -a; . ./.env; set +a

if [ "${1:-}" = "--reset" ]; then
  PHONE="${2:?укажите телефон}"
  NEWPASS="${3:?укажите новый пароль, не короче 8 знаков}"
  if [ "${#NEWPASS}" -lt 8 ]; then echo "Пароль не короче 8 знаков"; exit 1; fi

  # Хэш считаем внутри контейнера сервера — там есть нужная библиотека,
  # и пароль не проходит через командную строку базы в открытом виде.
  HASH=$(docker exec -e NP="$NEWPASS" tabys-server node -e \
    'const b=require("bcryptjs");console.log(b.hashSync(process.env.NP,12))' 2>/dev/null)
  [ -z "$HASH" ] && { echo "Не удалось подготовить пароль"; exit 1; }

  # Через готовую функцию оператора: она уже умеет менять пароль
  # владельца в обход построчной защиты и проверена тестами.
  docker exec -e PGPASSWORD="$DB_SUPER_PASSWORD" tabys-db psql -q -U postgres -d shop \
    -c "SELECT operator_reset_owner_password(
          (SELECT id FROM account WHERE phone = '$PHONE'), '$HASH')" >/dev/null 2>&1 \
    && echo "Пароль изменён для $PHONE" \
    || echo "Не нашёл магазин с телефоном $PHONE"
  exit 0
fi

echo "═══ МАГАЗИНЫ НА СЕРВЕРЕ ═══"
echo
docker exec -e PGPASSWORD="$DB_SUPER_PASSWORD" tabys-db psql -U postgres -d shop -c \
"SELECT a.phone AS телефон,
        a.name AS магазин,
        a.status AS состояние,
        coalesce((SELECT e.first_name FROM employee e
                   WHERE e.account_id = a.id AND e.is_owner LIMIT 1), '—') AS владелец,
        to_char(a.created_at, 'DD.MM.YYYY') AS создан,
        (SELECT count(*) FROM sale s WHERE s.account_id = a.id) AS чеков
   FROM account a ORDER BY a.created_at"

echo
echo "Пароли здесь не показываются — они хранятся отпечатком, и это"
echo "правильно: утечка базы не должна становиться утечкой паролей."
echo
echo "Забыли пароль? Сбросить так:"
echo "  bash /opt/tabys/deploy/14_accounts.sh --reset ВАШ_ТЕЛЕФОН НовыйПароль"
