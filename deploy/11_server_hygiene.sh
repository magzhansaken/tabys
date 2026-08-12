#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — порядок на сервере: кэш сборок и файл подкачки.
#
# ОСТОРОЖНО И ОСОЗНАННО. Сервер общий с рестораном, у которого живой
# клиент и живые деньги. Поэтому здесь только безопасные действия:
#
#   ЧТО ДЕЛАЕМ:
#     · чистим кэш сборок СТАРШЕ НЕДЕЛИ (свежий не трогаем — иначе
#       следующая сборка будет собираться с нуля);
#     · удаляем «висячие» образы без имени (мусор от пересборок);
#     · добавляем файл подкачки, если его нет.
#
#   ЧЕГО НЕ ДЕЛАЕМ НИКОГДА:
#     · docker system prune --volumes — снесёт базы, включая чеки
#       живого заведения ресторана;
#     · docker image prune -a — снесёт рабочие образы, и ресторан
#       не поднимется после перезапуска;
#     · не трогаем контейнеры и тома ресторана вообще.
#
# Запуск:            bash /opt/tabys/deploy/11_server_hygiene.sh
# Только посмотреть: bash /opt/tabys/deploy/11_server_hygiene.sh --dry
# Поставить в еженедельный автозапуск: ... --install-cron
# =====================================================================
set -uo pipefail
DRY=0; INSTALL_CRON=0
for a in "$@"; do
  [ "$a" = "--dry" ] && DRY=1
  [ "$a" = "--install-cron" ] && INSTALL_CRON=1
done

echo "═══ ПОРЯДОК НА СЕРВЕРЕ ═══"
echo
echo "── Как сейчас"
docker system df | sed 's/^/   /'
echo
df -h / | tail -1 | awk '{print "   диск: занято "$3" из "$2", свободно "$4}'
free -h | awk 'NR==2{print "   память: занято "$3" из "$2}'
SWAP=$(free -h | awk 'NR==3{print $2}')
echo "   подкачка: $SWAP"

# ── 1. Кэш сборок ────────────────────────────────────────────────────
echo
echo "── 1/3 Кэш сборок старше недели"
if [ "$DRY" = "1" ]; then
  echo "   (только показ) освободилось бы:"
  docker builder prune --filter until=168h --force --keep-storage 0 2>/dev/null | tail -2 | sed 's/^/   /' || true
else
  BEFORE=$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | grep -i "build" | awk '{print $2}')
  docker builder prune -f --filter until=168h 2>&1 | tail -2 | sed 's/^/   /'
  AFTER=$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | grep -i "build" | awk '{print $2}')
  echo "   было: ${BEFORE:-?}, стало: ${AFTER:-?}"
fi

# ── 2. Висячие образы (без имени, остатки пересборок) ────────────────
echo
echo "── 2/3 Образы без имени"
if [ "$DRY" = "1" ]; then
  N=$(docker images -f dangling=true -q | wc -l)
  echo "   нашлось: $N (удалились бы только они, рабочие образы не трогаются)"
else
  docker image prune -f 2>&1 | tail -1 | sed 's/^/   /'
fi

# ── 3. Файл подкачки ─────────────────────────────────────────────────
echo
echo "── 3/3 Файл подкачки"
if [ "$(swapon --show | wc -l)" -gt 0 ]; then
  echo "   уже есть: $(free -h | awk 'NR==3{print $2}')"
elif [ "$DRY" = "1" ]; then
  echo "   (только показ) создался бы файл на 2 ГБ"
else
  FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
  if [ "${FREE_GB:-0}" -lt 10 ]; then
    echo "   ПРОПУЩЕНО: на диске меньше 10 ГБ свободно"
  else
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    # В список автозагрузки — только если строки ещё нет. Испорченный
    # файл автозагрузки может помешать серверу подняться, поэтому
    # сначала копия, потом дописывание.
    if ! grep -q '^/swapfile' /etc/fstab; then
      cp /etc/fstab "/etc/fstab.backup-$(date +%F-%H%M%S)"
      echo '/swapfile none swap sw 0 0' >> /etc/fstab
      echo "   добавлено в автозагрузку (копия старого файла сохранена)"
    fi
    echo "   создан: $(free -h | awk 'NR==3{print $2}')"
  fi
fi

# ── Еженедельный автозапуск ──────────────────────────────────────────
if [ "$INSTALL_CRON" = "1" ]; then
  echo
  echo "── Еженедельный автозапуск"
  LINE="0 4 * * 1 bash /opt/tabys/deploy/11_server_hygiene.sh >> /var/log/tabys-hygiene.log 2>&1"
  if crontab -l 2>/dev/null | grep -q 'tabys-hygiene'; then
    echo "   уже настроен, повтор не добавляю"
  else
    ( crontab -l 2>/dev/null; echo "$LINE" ) | crontab -
    echo "   настроен: каждый понедельник в 04:00"
  fi
  echo "   что уже стоит в расписании сервера:"
  crontab -l 2>/dev/null | sed 's/^/     /' || echo "     (пусто)"
fi

echo
echo "── Как стало"
docker system df | sed 's/^/   /'
echo
echo "── Ресторан цел?"
docker ps --filter name=dastarhan2 --format '   {{.Names}}  {{.Status}}'
echo
echo "ГОТОВО."
