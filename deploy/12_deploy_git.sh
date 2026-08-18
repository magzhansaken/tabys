#!/usr/bin/env bash
# =====================================================================
# ТАБЫС — выкладка прямо из репозитория.
#
# ЗАЧЕМ: сейчас каждое обновление — это архив вручную через ваш
# компьютер. Восемь выкладок подряд, и ни одной точки, куда можно
# откатиться, если новая версия окажется хуже.
#
# С репозиторием обновление становится одной командой, а откат на
# любую прошлую версию — ещё одной.
#
# ВЕТКИ:
#   main — истина, туда попадает всё
#   prod — то, что стоит на сервере. Выкладываем ТОЛЬКО её.
#
# Разделение веток спасает от случая «поправил на ходу и сразу уехало
# клиенту»: чтобы попасть на сервер, изменение должно быть осознанно
# переведено в prod.
#
# Запуск:  bash /opt/tabys/deploy/12_deploy_git.sh
# Откат:   bash /opt/tabys/deploy/12_deploy_git.sh --rollback
# =====================================================================
set -uo pipefail

REPO_DIR=/opt/tabys-src
DST=/opt/tabys
BRANCH=prod

if [ "${1:-}" = "--rollback" ]; then
  echo "═══ ОТКАТ НА ПРЕДЫДУЩУЮ ВЕРСИЮ ═══"
  cd "$REPO_DIR" || { echo "Репозиторий не найден. Сначала обычная выкладка."; exit 1; }
  echo "Последние версии:"
  git log --oneline -8 "$BRANCH" | sed 's/^/   /'
  echo
  read -rp "Введите номер версии для отката (или Enter для отмены): " TARGET
  [ -z "$TARGET" ] && { echo "Отменено."; exit 0; }
  git checkout -q "$TARGET" || { echo "Версия не найдена"; exit 1; }
  echo "Откатываемся на $TARGET"
else
  echo "═══ ВЫКЛАДКА ИЗ РЕПОЗИТОРИЯ ═══"
  if [ ! -d "$REPO_DIR/.git" ]; then
    echo "Репозитория ещё нет. Скачиваю впервые."
    echo "Понадобится доступ: имя пользователя GitHub и токен вместо пароля."
    git clone --branch "$BRANCH" "${TABYS_REPO:?укажите TABYS_REPO=https://github.com/magzhansaken/tabys.git}" "$REPO_DIR" || exit 1
  else
    cd "$REPO_DIR"
    echo "── Что нового"
    git fetch --quiet origin "$BRANCH"
    CURRENT=$(git rev-parse --short HEAD)
    git log --oneline "HEAD..origin/$BRANCH" | sed 's/^/   /' || true
    NEW=$(git rev-parse --short "origin/$BRANCH")
    if [ "$CURRENT" = "$NEW" ]; then
      echo "   уже последняя версия ($CURRENT) — обновлять нечего"
      exit 0
    fi
    git checkout -q "$BRANCH" && git reset --hard -q "origin/$BRANCH"
    echo "   было $CURRENT → стало $NEW"
  fi
fi

cd "$REPO_DIR"
VERSION=$(git rev-parse --short HEAD)
echo
echo "── Сторожа перед выкладкой"
if node scripts/check-invariants.js; then
  :
else
  echo "ОСТАНОВЛЕНО: нарушены правила. На сервер такое не поедет."
  exit 1
fi

# Адреса: кнопка, которая зовёт несуществующий путь, падает молча —
# ни сборка, ни тесты этого не видят. Две такие уже находились
# случайно, третью ищет этот сторож.
if node scripts/check-routes.js; then
  :
else
  echo "ОСТАНОВЛЕНО: кабинет зовёт адрес, которого нет. Кнопка будет мёртвой."
  exit 1
fi

echo
echo "── Копирую в $DST (настройки с паролями сохраняются)"
for d in server admin db docs shared scripts pos pos-desktop; do
  [ -d "$d" ] && cp -r "$d" "$DST"/ 2>/dev/null
done
for f in deploy/*.sh deploy/docker-compose*.yml; do cp "$f" "$DST"/deploy/; done
echo "   версия $VERSION"

cd "$DST/deploy"
echo
echo "── Сборка и запуск"
docker compose -p tabys -f docker-compose.prod.yml up -d --build

echo
echo "── Жду сервер"
for i in $(seq 1 12); do
  sleep 3
  docker logs --tail 5 tabys-server 2>&1 | grep -q "слушает порт" && break
done

set -a; . "$DST/deploy/.env"; set +a
source "$DST/deploy/lib_check.sh"
set +e; run_all_checks; RC=$?; set -e

echo
echo "Версия на сервере: $VERSION"
if [ "$RC" = "0" ]; then
  echo "Выкладка завершена и проверена."
else
  echo "ЕСТЬ ПРОБЛЕМЫ. Откат: bash $DST/deploy/12_deploy_git.sh --rollback"
fi
exit $RC
