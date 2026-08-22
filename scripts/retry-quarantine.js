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

const деньги = (v) => Math.round(Number(v) || 0)
  .toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';

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
        WHERE account_id = $1 AND resolved_at IS NULL
        ORDER BY first_seen_at`, [м.id])).rows;

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

    /* ПРИМЕНЯЕМ В ТОМ ЖЕ ПОРЯДКЕ, в каком касса их пробила: смена
       первой, иначе чеки снова не найдут её. */
    const вес = { shift: 0, sale: 1, refund: 1, cash_move: 2, cash_operation: 2 };
    записи.sort((a, b) => (вес[a.entity] ?? 9) - (вес[b.entity] ?? 9));

    for (const r of записи) {
      try {
        const res = (await c.query(
          `SELECT * FROM sync_push_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [r.id, м.id, r.device_id, null, null, r.entity, r.entity_id, r.op,
           JSON.stringify(r.payload || {}), r.client_seq,
           r.client_ts || new Date().toISOString()])).rows[0];

        /* Событие снова в журнале — помечаем разобранным. Применит его
           обычный ход обмена, тот же, что и живые чеки. */
        await c.query(
          `UPDATE oplog_dead_letter SET resolved_at = now() WHERE id = $1`, [r.id]);
        вернули += 1;
      } catch (e) {
        console.log('      ✘ ' + r.entity + ': ' + String(e.message).slice(0, 70));
      }
    }
    console.log('      вернули: ' + записи.length);
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
