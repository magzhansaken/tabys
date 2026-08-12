#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — восстановление и починка маршрута.
#
# Делает так, чтобы наш блок в файле маршрутов ресторана был на месте
# и в правильном виде. Работает в любом из случаев:
#   · блока нет вовсе (затёрло при обновлении ресторана) — добавит;
#   · блок есть, но старого вида — переведёт на «спрашивать адрес
#     контейнера заново», чтобы пересоздание контейнеров не ломало сайт;
#   · блок уже правильный — ничего не тронет, просто перечитает настройки.
#
# Ресторанные блоки не затрагиваются: правится только наш, по домену.
# Перед правкой — копия файла, после — проверка синтаксиса и ресторана.
# =====================================================================
set -euo pipefail

PATHS=/opt/dastarhan2/deploy/Caddyfile.paths
COMPOSE_REST=/opt/dastarhan2/deploy/docker-compose.yml
DOMAIN=tabys.duckdns.org

echo "=== Проверка: наши контейнеры подняты?"
for c in tabys-server tabys-admin; do
  [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null || echo false)" = "true" ] \
    || { echo "ОСТАНОВЛЕНО: $c не запущен. Сначала: bash /opt/tabys/deploy/02_start.sh"; exit 1; }
done
echo "· контейнеры работают"

BACKUP="/root/Caddyfile.paths.backup-$(date +%F-%H%M%S)"
cp "$PATHS" "$BACKUP"
echo "· копия файла ресторана: $BACKUP"

echo "=== Что сейчас в файле"
if grep -q "^$DOMAIN {" "$PATHS"; then
  if grep -q "dynamic a tabys-server" "$PATHS"; then
    echo "· блок на месте и уже в правильном виде"
    STATE=ok
  else
    echo "· блок на месте, но старого вида — переведу на динамический адрес"
    STATE=old
  fi
else
  echo "· блока НЕТ — видимо, файл перезаписали при обновлении ресторана. Добавлю заново."
  STATE=missing
fi

if [ "$STATE" = "old" ]; then
  python3 - "$PATHS" "$DOMAIN" <<'PY'
import sys
path, domain = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()
start = src.find('\n' + domain + ' {')
if start == -1:
    print('· блок не найден для правки'); sys.exit(1)
end = src.find('\n}', start + 1)
block = src[start:end+2]
new = block.replace('reverse_proxy tabys-server:3000',
      'reverse_proxy {\n                        dynamic a tabys-server 3000\n                }')
new = new.replace('reverse_proxy tabys-admin:3001',
      'reverse_proxy {\n                        dynamic a tabys-admin 3001\n                }')
open(path, 'w', encoding='utf-8').write(src[:start] + new + src[end+2:])
print('· блок переведён на динамический адрес')
PY
fi

if [ "$STATE" = "missing" ]; then
  cat >> "$PATHS" <<EOF


# ===== Tabys (magaziny) — vosstanovleno $(date +%F' '%H:%M) =====
# dynamic a — Caddy uznayot adres kontejnera zanovo pered kazhdym
# obrashcheniem. Bez etogo peresozdanie kontejnerov pri obnovlenii
# lomaet marshrut: Caddy prodolzhaet stuchatsya po staromu adresu.
$DOMAIN {
        encode gzip
        log {
                output stdout
                format console
                level INFO
        }
        handle_path /api/* {
                reverse_proxy {
                        dynamic a tabys-server 3000
                }
        }
        handle {
                reverse_proxy {
                        dynamic a tabys-admin 3001
                }
        }
}
EOF
  echo "· блок добавлен заново"
fi

echo "=== Проверка синтаксиса ДО применения"
if ! docker compose -f "$COMPOSE_REST" exec -T web caddy validate --config /etc/caddy/Caddyfile; then
  echo "ОШИБКА в настройках — возвращаю файл как был, ничего не применялось."
  cp "$BACKUP" "$PATHS"
  exit 1
fi
echo "· синтаксис верный"

echo "=== Применяю вживую (без простоя)"
docker compose -f "$COMPOSE_REST" exec -T web caddy reload --config /etc/caddy/Caddyfile
echo "· настройки перечитаны"

echo
echo "=== Ресторан жив?"
REST=$(curl -s -o /dev/null -w '%{http_code}' https://dastarhan.duckdns.org/office/ || echo 000)
echo "· ресторан: $REST"
[ "$REST" = "200" ] || { echo "ВНИМАНИЕ: ресторан ответил $REST. Откат: bash /opt/tabys/deploy/99_caddy_rollback.sh"; exit 1; }

echo
echo "=== Наши адреса (сертификат может выпускаться до 30 секунд)"
for i in 1 2 3 4 5 6; do
  S=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/health" || echo 000)
  K=$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/login" || echo 000)
  echo "· попытка $i — сервер: $S, кабинет: $K"
  [ "$S" = "200" ] && [ "$K" = "200" ] && break
  sleep 6
done

echo
echo "ВАЖНО: если ресторан снова выложат из своего репозитория, наш блок"
echo "может опять исчезнуть. Тогда достаточно повторить этот скрипт."
