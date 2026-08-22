/*
 * ГДЕ ЧЕКИ.
 *
 * Владелец пробил продажу, а в показателях ноль. Догадываться нечего —
 * эта проверка говорит, что вправду произошло с каждым чеком.
 *
 * Смотрит четыре места:
 *   чеки, которые дошли и легли в базу;
 *   чеки в КАРАНТИНЕ — сервер принял, но применить не смог;
 *   когда касса выходила на связь в последний раз;
 *   склад у кассы: без него чеки уходят в карантин.
 *
 * Запуск:
 *   docker exec tabys-server node scripts/check-receipts.js
 *   docker exec tabys-server node scripts/check-receipts.js "Мини-маркет на Абая"
 */
const { Client } = require('pg');

const ИМЯ = process.argv[2] || null;

const дата = (d) => (d
  ? new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit' })
  : '—');

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
      `SELECT id, name FROM platform_clients('super', NULL, $1) ORDER BY name`,
      [ИМЯ])).rows;
  } catch {
    магазины = (await c.query(
      `SELECT id, name FROM account WHERE deleted_at IS NULL
        AND ($1::text IS NULL OR name = $1) ORDER BY name`, [ИМЯ])).rows;
  }

  console.log('');
  console.log('═══ ГДЕ ЧЕКИ ═══');

  for (const м of магазины) {
    await c.query(`SET app.account_id = '${м.id}'`);

    const сег = (await c.query(
      `SELECT count(*)::int n, coalesce(sum(total),0) s
         FROM sale WHERE created_at >= date_trunc('day', now())`)).rows[0];

    const всего = (await c.query(
      `SELECT count(*)::int n, coalesce(sum(total),0) s, max(created_at) AS последний
         FROM sale`)).rows[0];

    /* КАРАНТИН — главное место. Сервер принял чек, но применить не смог:
       деньги взяты, а в отчёте их нет. */
    const кар = (await c.query(
      `SELECT count(*)::int n FROM oplog_dead_letter
        WHERE account_id = $1 AND resolved_at IS NULL`, [м.id])).rows[0];

    const причины = кар.n ? (await c.query(
      `SELECT entity, left(error, 96) AS error, count(*)::int n,
              max(first_seen_at) AS когда
         FROM oplog_dead_letter
        WHERE account_id = $1 AND resolved_at IS NULL
        GROUP BY entity, left(error, 96)
        ORDER BY n DESC LIMIT 4`, [м.id])).rows : [];

    /* СКЛАД У КАССЫ. Без него чек не может списать товар и уходит в
       карантин — самая частая причина «пробили, а в отчёте ноль». */
    const касс = (await c.query(
      `SELECT count(*)::int всего, count(warehouse_id)::int со_складом
         FROM cash_register WHERE account_id = $1`, [м.id])).rows[0];

    const связь = (await c.query(
      `SELECT max(last_seen_at) AS когда FROM device
        WHERE account_id = $1 AND paired_at IS NOT NULL`, [м.id])).rows[0];

    console.log('');
    console.log('  ' + м.name);
    console.log('    сегодня:   ' + сег.n + ' чеков на ' + деньги(сег.s));
    console.log('    всего:     ' + всего.n + ' чеков на ' + деньги(всего.s)
      + (всего.последний ? ' · последний ' + дата(всего.последний) : ''));

    console.log('    касс:      ' + касс.всего
      + (касс.со_складом < касс.всего
        ? `  ✘ БЕЗ СКЛАДА: ${касс.всего - касс.со_складом} — их чеки уйдут в карантин`
        : ' · склад есть ✔'));

    console.log('    связь:     ' + (связь.когда ? дата(связь.когда) : 'касса не выходила на связь'));

    if (кар.n) {
      console.log('    ✘ В КАРАНТИНЕ: ' + кар.n + ' — деньги взяты, а в отчёте их нет');
      for (const p of причины) {
        /* Причину говорим ДОСЛОВНО: владелец покажет её нам, и мы
           сразу поймём, что чинить, а не будем гадать. */
        console.log('        ' + p.n + '× ' + p.entity
          + ' · ' + дата(p.когда));
        console.log('           ' + (p.error || 'причина не записана'));
      }
    } else {
      console.log('    карантин:  пусто ✔');
    }
  }

  await c.end();
  console.log('');
  console.log('  ЧТО ДЕЛАТЬ:');
  console.log('');
  console.log('    касса без склада  →  выложите свежий код: миграция');
  console.log('                          113 привяжет склад сама;');
  console.log('    карантин не пуст  →  причина написана выше дословно;');
  console.log('    всё пусто         →  касса ещё не отправляла. Смотрите');
  console.log('                          на кассе «Меню → Сервер не принял»;');
  console.log('    связи не было     →  касса не выходила в сеть ни разу:');
  console.log('                          проверьте адрес сервера при привязке.');
  console.log('');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
