/*
 * ВЕРНУТЬ ЧЕКИ ИЗ КАРАНТИНА.
 *
 * Чек в карантине — это взятые деньги без учёта. Он не пропал: тело
 * события лежит целиком, применить его можно.
 *
 * Раньше сервер отбивал чеки по трём причинам: смена не дошла, метки
 * времени не было, слова «refund» он не знал. Всё три чинены — значит
 * старые чеки теперь примутся.
 *
 * Запуск:
 *   docker exec tabys-server node scripts/retry-quarantine.js        смотрит
 *   docker exec tabys-server node scripts/retry-quarantine.js --fix  применяет
 */
const { Client } = require('pg');

const ЧИНИТЬ = process.argv.includes('--fix');

/* КЛЮЧ «ВСЕ» поднимает и помеченные разобранными, но НЕ ПРИМЕНЁННЫЕ.
   Прежний разбор помечал их и забывал применить — деньги остались вне
   учёта, а обычный разбор их больше не видит. */
const ВСЕ = process.argv.includes('--all');

const деньги = (v) => Math.round(Number(v) || 0)
  .toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';

/**
 * РАЗОБРАТЬ КАРАНТИН ОДНОГО МАГАЗИНА.
 *
 * Поднимаем ход обмена сервера прямо здесь: скрипт живёт внутри его
 * контейнера, и весь код рядом.
 */
async function разбери(accountId, все) {
  /* СБОРКА СЕРВЕРА ЛЕЖИТ РЯДОМ. В контейнере это /app/dist, при
     запуске из исходников — server/dist. Понимаем оба. */
  const fs = require('fs');
  const path = require('path');
  const где = ['/app/dist', path.join(__dirname, '..', 'server', 'dist'),
    path.join(__dirname, '..', 'dist')]
    .find((p) => fs.existsSync(path.join(p, 'main.js')));

  if (!где) throw new Error('Не нашёл сборку сервера — запустите внутри контейнера');

  const корень = path.join(где, '..');
  const { NestFactory } = require(path.join(корень, 'node_modules', '@nestjs', 'core'));

  /* СВОБОДНЫЙ ПОРТ ДЛЯ РАЗБОРА.
   *
   * main.js не только отдаёт AppModule — он ЗАПУСКАЕТ сервер. А боевой
   * уже слушает 3000, и разбор падал с «address already in use».
   *
   * Берём порт 0: система выдаст свободный. Разбор поднимет свой ход на
   * минуту, сделает дело и выйдет — боевой сервер не тронут. */
  process.env.PORT = '0';

  /* AppModule живёт в main.js — там же, где запуск сервера. */
  const { AppModule } = require(path.join(где, 'main.js'));
  const { SyncService } = require(path.join(где, 'sync', 'sync.service.js'));

  if (!разбери._app) {
    разбери._app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  }
  const sync = разбери._app.get(SyncService);
  const r = await sync.retryQuarantine(accountId, !!все);
  return { применено: r.применено, осталось: r.осталось,
    беды: (r.беды || []).map((b) => b.error) };
}

(async () => {
  const c = new Client({
    host: process.env.PGHOST || 'localhost',
    user: process.env.PGUSER || 'shop_app',
    password: process.env.PGPASSWORD || 'change_me_in_prod',
    database: process.env.PGDATABASE || 'shop',
  });
  await c.connect();

  let магазины = [];
  try {
    магазины = (await c.query(
      `SELECT id, name FROM platform_clients('super', NULL, NULL) ORDER BY name`)).rows;
  } catch {
    магазины = (await c.query(
      `SELECT id, name FROM account WHERE deleted_at IS NULL ORDER BY name`)).rows;
  }

  console.log('');
  console.log('═══ ЧЕКИ В КАРАНТИНЕ ═══');

  let всего = 0;
  let сумма = 0;
  let вернули = 0;

  for (const м of магазины) {
    await c.query(`SET app.account_id = '${м.id}'`);

    const записи = (await c.query(
      `SELECT id, entity, entity_id, op, payload, error, client_ts, client_seq, device_id
         FROM oplog_dead_letter
        WHERE account_id = $1
          AND (resolved_at IS NULL OR ($2::boolean AND NOT EXISTS (
                SELECT 1 FROM sale s WHERE s.id = entity_id
                UNION ALL SELECT 1 FROM shift sh WHERE sh.id = entity_id
                UNION ALL SELECT 1 FROM cash_operation co WHERE co.id = entity_id)))
        ORDER BY first_seen_at`, [м.id, ВСЕ])).rows;

    if (!записи.length) continue;

    /* СУММУ СЧИТАЕМ ТОЛЬКО ПО ЧЕКАМ. Смены и движения денег суммы не
       несут — их считать не с чего, но применить надо. */
    const деньгиТут = записи
      .filter((r) => r.entity === 'sale' || r.entity === 'refund')
      .reduce((a, r) => a + (Number(r.payload && r.payload.total) || 0), 0);

    всего += записи.length;
    сумма += деньгиТут;

    console.log('');
    console.log('  ' + м.name + ': ' + записи.length
      + (деньгиТут ? ' · на ' + деньги(деньгиТут) : ''));

    if (!ЧИНИТЬ) {
      /* СПЕРВА СМЕНЫ, потом чеки: чек ссылается на смену, и наоборот
         не выйдет. */
      const порядок = ['shift', 'sale', 'refund', 'cash_move', 'cash_operation'];
      for (const вид of порядок) {
        const n = записи.filter((r) => r.entity === вид).length;
        if (n) console.log('      ' + вид + ': ' + n);
      }
      continue;
    }

    /* ВОЗВРАЩАЕМ ЧЕРЕЗ СЕРВЕР, а не правкой журнала.
     *
     * Было: разбор возвращал события в журнал, но НЕ ПРИМЕНЯЛ их —
     * чеков в продажах не появлялось. «Возвращено» было правдой лишь
     * наполовину, а владелец видел ноль и думал, что мы не доделали.
     *
     * Зовём свёртку сервера напрямую: скрипт работает ВНУТРИ его
     * контейнера, и городить вход в кабинет ради своего же кода
     * незачем. */
    const итог = await разбери(м.id, ВСЕ);

    console.log('      применено: ' + итог.применено
      + (итог.осталось ? ' · осталось ' + итог.осталось : ' ✔'));
    вернули += итог.применено;
    for (const b of итог.беды) console.log('        ✘ ' + b);
  }

  await c.end();

  console.log('');
  if (!всего) {
    console.log('═══ КАРАНТИН ПУСТ ═══');
    console.log('');
    process.exit(0);
  }

  console.log('═══ ВСЕГО: ' + всего + ' записей'
    + (сумма ? ' · на ' + деньги(сумма) : '') + ' ═══');

  if (!ЧИНИТЬ) {
    console.log('');
    console.log('  Вернуть в работу: node scripts/retry-quarantine.js --fix');
    console.log('');
    console.log('  Если разбор уже делали, а чеков в отчёте нет — добавьте');
    console.log('  --all: он поднимет помеченные, но не применённые.');
    console.log('');
    console.log('  Сперва выложите свежий код: старые чеки отбивались по');
    console.log('  трём причинам, и все три чинены. Без свежего кода они');
    console.log('  отобьются снова.');
    console.log('');
    process.exit(0);
  }

  console.log('  Возвращено: ' + вернули);
  console.log('');
  console.log('  Проверьте: node scripts/check-receipts.js');
  console.log('');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
