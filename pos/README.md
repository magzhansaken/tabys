# Касса (Flutter)

Один код — Windows, Android, iOS, Sunmi.

## Сборка

```bash
flutter pub get
dart run build_runner build --delete-conflicting-outputs   # генерация drift (local_db.g.dart)
flutter run --dart-define=API_URL=https://api.вашдомен.kz  # или http://localhost:3000
```

## Первый запуск

1. В кабинете: **Точки и кассы → создать кассу → «Код привязки»**.
2. На устройстве ввести код (действует 10 минут). Касса скачает сотрудников
   с PIN-хэшами, профиль и весь каталог — дальше работает и без интернета.
3. Вход кассира — PIN (4 цифры). Пять ошибок — блок на 5 минут (офлайн тоже).

## Что где лежит

- `lib/domain/cart.dart` — вся математика чека. Менять формулы можно только
  синхронно с server/test/part16.pos-app.e2e.js (там их зеркало).
- `lib/core/sync_engine.dart` — очередь Outbox: сплошной clientSeq, очистка
  только после подтверждения сервера, батчи по 100.
- `lib/data/local_schema.dart` — схема локальной SQLite (drift).

## Проверка без Flutter

Контракт и математика кассы проверяются на живом сервере:

```bash
cd ../server && node test/part16.pos-app.e2e.js
```
