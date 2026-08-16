#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — завести владельца платформы или партнёра.
#
# Отдельным скриптом, а не длинной командой в одну строку: PowerShell
# разбирает кавычки по-своему, и команда с вложенными кавычками там не
# проходит. Скрипт принимает три понятных значения — и всё.
#
# Использование:
#   bash 14_platform_user.sh magzhan@tabys.kz 'ВашПароль' 'Магжан'
#   bash 14_platform_user.sh erlan@partner.kz 'Пароль' 'Ерлан' partner 15
#
# Четвёртое значение — роль (super или partner), пятое — комиссия в
# процентах для партнёра.
#
# ПАРОЛЬ В КАВЫЧКАХ: иначе оболочка съест знаки вроде $ и !, и войти
# будет нечем.
# =====================================================================
set -euo pipefail

EMAIL="${1:?укажите почту: bash 14_platform_user.sh admin@tabys.kz 'пароль' 'Имя'}"
PASSWORD="${2:?укажите пароль в одинарных кавычках}"
NAME="${3:?укажите имя}"
ROLE="${4:-super}"
COMMISSION="${5:-0}"

if [ "$ROLE" != "super" ] && [ "$ROLE" != "partner" ]; then
  echo "Роль бывает super (владелец платформы) или partner"; exit 1
fi
if [ "${#PASSWORD}" -lt 8 ]; then
  echo "Пароль от 8 знаков: этот вход открывает все магазины и все деньги"; exit 1
fi

COMPOSE="/opt/tabys/deploy/docker-compose.prod.yml"

# Скрипт кладём во временный файл внутри контейнера, а не передаём
# командой: так кавычки и кириллица доезжают целыми.
docker compose -p tabys -f "$COMPOSE" exec -T \
  -e PU_EMAIL="$EMAIL" -e PU_PASS="$PASSWORD" -e PU_NAME="$NAME" \
  -e PU_ROLE="$ROLE" -e PU_BP="$(( COMMISSION * 100 ))" \
  server node -e '
const bcrypt = require("bcryptjs");
const { Client } = require("pg");
(async () => {
  const c = new Client();
  await c.connect();
  const r = await c.query(
    `INSERT INTO platform_user (email, password_hash, full_name, role, commission_bp)
     VALUES ($1, $2, $3, $4::platform_role, $5)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       full_name     = EXCLUDED.full_name,
       role          = EXCLUDED.role,
       commission_bp = EXCLUDED.commission_bp,
       is_active     = true,
       deleted_at    = NULL
     RETURNING id, email, role, commission_bp, (xmax = 0) AS created`,
    [process.env.PU_EMAIL, bcrypt.hashSync(process.env.PU_PASS, 10),
     process.env.PU_NAME, process.env.PU_ROLE, Number(process.env.PU_BP)]);
  const u = r.rows[0];
  console.log(u.created ? "· создан" : "· пароль обновлён у существующего");
  console.log("· почта: " + u.email);
  console.log("· роль:  " + (u.role === "super" ? "владелец платформы" : "партнёр"));
  if (u.role === "partner") console.log("· комиссия: " + (u.commission_bp / 100) + "%");
  await c.end();
})().catch((e) => { console.error("Ошибка:", e.message); process.exit(1); });
'

echo
echo "Вход: https://tabys.duckdns.org/platform/login"
