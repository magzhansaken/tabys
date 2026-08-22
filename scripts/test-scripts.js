/*
 * ПРОВЕРКА САМИХ ПРОВЕРОК.
 *
 * Дважды подряд я отдал владельцу проверку, которая врала на его
 * данных: она судила по признаку, появившемуся ПОЗЖЕ этих данных.
 *
 *   пометка «УЧЕБНЫЙ» на товарах — завели поздно;
 *   поле «kind» у чека — касса кладёт «isRefund»;
 *   ссылка возврата — звалась «returnOf», потом «ofReceiptId».
 *
 * Я проверял их на данных, которые сам же и делал — по нынешним
 * правилам. Старых данных в такой проверке нет, и врать ей негде.
 *
 * Этот прогон заводит магазин КАК ДО ПРАВОК: без пометок, без склада у
 * кассы, без кода кассира, со ссылкой возврата старым именем. И
 * смотрит, что каждая проверка увидит беду.
 *
 * Запуск: node scripts/test-scripts.js
 */
const { execFileSync } = require('child_process');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const БАЗА = 'проверка_проверок';
let прошло = 0;
let сбоев = 0;

const ok = (усл, имя) => {
  if (усл) { прошло += 1; console.log('  ✔ ' + имя); }
  else { сбоев += 1; console.log('  ✘ ' + имя); }
};

(async () => {
  const общ = new Client({ host: 'localhost', user: 'postgres', database: 'postgres' });
  await общ.connect().catch(() => {});

  console.log('');
  console.log('═══ ПРОВЕРКА САМИХ ПРОВЕРОК ═══');
  console.log('');
  console.log('  Магазин заведён КАК ДО ПРАВОК: учебные товары без');
  console.log('  пометки, касса без склада, владелец без кода, ссылка');
  console.log('  возврата старым именем.');
  console.log('');

  const c = new Client({
    host: process.env.PGHOST || 'localhost',
    user: process.env.PGUSER || 'shop_app',
    password: process.env.PGPASSWORD || 'change_me_in_prod',
    database: process.env.PGDATABASE || 'shop',
  });
  await c.connect();

  const a = (await c.query(`SELECT * FROM platform_create_tenant($1,$2,$3,$4)`,
    ['Старый уклад', '+7' + Date.now().toString().slice(-10), 'Хозяин',
     bcrypt.hashSync('x12345678', 10)])).rows[0];
  const A = a.out_account;
  await c.query(`SET app.account_id = '${A}'`);

  /* ОТКАТЫВАЕМ ВСЁ, ЧТО ДОБАВЛЕНО ПОЗЖЕ. Это и есть суть прогона:
     данные должны быть СТАРЫМИ, иначе проверка проверяет себя. */
  await c.query(`SELECT seed_demo_goods($1)`, [A]);
  await c.query(`UPDATE product SET article = NULL,
    name = replace(name, ' (учебный)', '')`);
  await c.query(`UPDATE cash_register SET warehouse_id = NULL`);
  await c.query(`UPDATE employee SET pos_pin_hash = NULL WHERE is_owner`);

  const рег = (await c.query(`SELECT id, store_id FROM cash_register LIMIT 1`)).rows[0];
  const dev = (await c.query(
    `INSERT INTO device (account_id, cash_register_id, name, paired_at, token_hash)
     VALUES ($1,$2,'Касса',now(),'x') RETURNING id`, [A, рег.id])).rows[0];

  const чек = async (n, сумма) => (await c.query(
    `INSERT INTO sale (id, account_id, cash_register_id, store_id, number, status,
      subtotal, discount_sum, rounding, total, cost_total, profit, paid_cash,
      created_at, completed_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'completed',$5,0,0,$5,0,$5,$5,now(),now())
     RETURNING id`, [A, рег.id, рег.store_id, n, сумма])).rows[0];

  const пр = await чек(1, 500);
  const вз = await чек(2, 500);

  /* Ссылка старым именем: очень старая касса звала её «returnOf». */
  await c.query(
    `INSERT INTO oplog (id, account_id, device_id, entity, entity_id, op, payload, client_ts, seq)
     VALUES (gen_random_uuid(),$1,$2,'refund',$3,'insert',$4,now(),1)`,
    [A, dev.id, вз.id, JSON.stringify({ returnOf: пр.id, total: 500 })]);

  await c.end();

  const прогон = (файл, ключи = []) => {
    try {
      return execFileSync('node', [`scripts/${файл}`, ...ключи],
        { encoding: 'utf8', env: process.env, cwd: process.cwd() });
    } catch (e) { return String(e.stdout || '') + String(e.message || ''); }
  };

  // ── КАЖДАЯ ПРОВЕРКА ДОЛЖНА УВИДЕТЬ СВОЮ БЕДУ ─────────────────────
  const все = прогон('check-all-shops.js');
  ok(/без кода для кассы/.test(все),
     '★ check-all-shops видит владельца без кода кассира');

  const чеки = прогон('check-receipts.js');
  ok(/БЕЗ СКЛАДА/.test(чеки),
     '★ check-receipts видит кассу без склада');

  const список = прогон('list-shops.js');
  ok(/Старый уклад\s+\d+\s+\S+\s+₸\s+0\s/.test(список.replace(/\s+/g, ' ')
       .replace('Старый уклад', '\nСтарый уклад')) || /Старый уклад/.test(список),
     'list-shops показывает магазин');
  ok(!/Старый уклад.*?ни торговли/s.test(список),
     '★ list-shops НЕ зовёт учебные товары своими');

  const возвр = прогон('fix-refunds.js');
  ok(/1 на 500/.test(возвр),
     '★ fix-refunds находит возврат со ссылкой СТАРЫМ именем «returnOf»');

  console.log('');
  console.log(`═══ ИТОГ: пройдено ${прошло}, провалено ${сбоев} ═══`);
  console.log('');
  if (сбоев) {
    console.log('  Проверка врёт на старых данных — так и было дважды.');
    console.log('');
  }
  process.exit(сбоев ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
