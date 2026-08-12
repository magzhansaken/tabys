# Деплой

```bash
cp .env.example .env   # заполнить пароли
docker compose up -d --build
```

- Кабинет: http://сервер:3001 (в проде — за nginx/caddy с TLS)
- API: http://сервер:3000 (кассы ходят сюда, --dart-define=API_URL=...)
- Бэкапы: ./backups, ежесуточно, 14 последних.
  Восстановление: `gunzip -c файл.sql.gz | psql -h db -U postgres shop`
- Миграции идемпотентны: `docker compose run --rm migrate` после обновления кода.
