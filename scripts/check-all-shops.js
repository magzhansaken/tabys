/*
 * ПРОВЕРКА ВСЕХ МАГАЗИНОВ РАЗОМ.
 *
 * check-shop.js смотрит один магазин. А беды бывают общие: код кассира
 * не лёг в базу, кассиры не привязаны к магазину, у владельца нет
 * пароля.
 *
 * Эта проходит по ВСЕМ и говорит, где встанет. С ключом --fix чинит
 * то, что можно починить без спроса.
 *
 * Запуск:
 *   docker exec tabys-server node scripts/check-all-shops.js
 *   docker exec tabys-server node scripts/check-all-shops.js --fix
 */
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const ЧИНИТЬ = process.argv.includes('--fix');

(async () => {
  const c = new Client({
    host: process.env.PGHOST || 'localhost',
    user: process.env.PGUSER || 'shop_app',
    password: process.env.PGPASSWORD || 'change_me_in_prod',
    database: process.env.PGDATABASE || 'shop',
  });
  await c.connect();

  /* Магазины берём через список платформы: защита строк прячет их,
     пока ни один не выбран — запрос молчит, а не падает. */
  let магазины = [];
  try {
    магазины = (await c.query(
      `SELECT id, name FROM platform_clients('super', NULL, NULL) ORDER BY name`)).rows;
  } catch {
    магазины = (await c.query(
      `SELECT id, name FROM account WHERE deleted_at IS NULL ORDER BY name`)).rows;
  }

  console.log('');
  console.log(`═══ ПРОВЕРКА ВСЕХ МАГАЗИНОВ: ${магазины.length} ═══`);
  console.log('');

  let бед = 0;
  let починено = 0;
  const выданные = [];

  for (const м of магазины) {
    await c.query(`SET app.account_id = '${м.id}'`);
    const беды = [];

    /* КОД КАССИРА. Без него владелец не войдёт на кассу — а он этого
       не поймёт: касса скажет «Неверный PIN» на верный код. */
    const без = (await c.query(
      `SELECT id, first_name, is_owner FROM employee
        WHERE account_id = $1 AND is_active AND can_login_pos
          AND pos_pin_hash IS NULL`, [м.id])).rows;

    if (без.length) {
      беды.push(`без кода для кассы: ${без.length}`);

      if (ЧИНИТЬ) {
        for (const e of без) {
          /* Код СВОЙ у каждого: одинаковый «1234» у всех — это ключ от
             всех касс разом. */
          const pin = String(Math.floor(1000 + Math.random() * 9000));
          const r = await c.query(
            `UPDATE employee SET pos_pin_hash = $2 WHERE id = $1 RETURNING id`,
            [e.id, bcrypt.hashSync(pin, 10)]);

          if (r.rowCount) {
            починено += 1;
            выданные.push(`${м.name} · ${e.first_name}${e.is_owner ? ' (владелец)' : ''} · ${pin}`);
          }
        }
      }
    }

    /* ПРИВЯЗКА К МАГАЗИНУ. Сервер ищет на кассе только привязанных:
       кассир заведён, код стоит, а войти не может. */
    const непривязан = (await c.query(
      `SELECT count(*)::int AS n FROM employee e
        WHERE e.account_id = $1 AND e.is_active AND NOT e.is_owner
          AND NOT EXISTS (SELECT 1 FROM employee_store s WHERE s.employee_id = e.id)`,
      [м.id])).rows[0];

    if (непривязан.n) {
      беды.push(`не привязаны к магазину: ${непривязан.n}`);

      if (ЧИНИТЬ) {
        const store = (await c.query(
          `SELECT id FROM store WHERE account_id = $1 ORDER BY created_at LIMIT 1`,
          [м.id])).rows[0];

        if (store) {
          const r = await c.query(
            `INSERT INTO employee_store (account_id, employee_id, store_id)
             SELECT $1, e.id, $2 FROM employee e
              WHERE e.account_id = $1 AND e.is_active AND NOT e.is_owner
                AND NOT EXISTS (SELECT 1 FROM employee_store s WHERE s.employee_id = e.id)
             ON CONFLICT DO NOTHING`, [м.id, store.id]);
          починено += r.rowCount || 0;
        }
      }
    }

    /* ПАРОЛЬ ОТ КАБИНЕТА. Без него владелец не заведёт товар и не
       увидит выручку. Пароль НЕ ВЫДАЁМ сами: он показывается один раз
       при заведении, а тут его некому передать. */
    const хозяин = (await c.query(
      `SELECT password_hash IS NOT NULL AS есть FROM employee
        WHERE account_id = $1 AND is_owner LIMIT 1`, [м.id])).rows[0];

    if (хозяин && !хозяин.есть) {
      беды.push('у владельца НЕТ пароля от кабинета — восстановит по телефону');
    }

    if (беды.length) {
      бед += 1;
      console.log(`  ✘ ${м.name}`);
      for (const b of беды) console.log(`      ${b}`);
    } else {
      console.log(`  ✔ ${м.name}`);
    }
  }

  await c.end();

  console.log('');
  if (!бед) {
    console.log('═══ ВСЕ МАГАЗИНЫ В ПОРЯДКЕ ═══');
    console.log('');
    process.exit(0);
  }

  console.log(`═══ С БЕДАМИ: ${бед} из ${магазины.length} ═══`);

  if (!ЧИНИТЬ) {
    console.log('');
    console.log('  Починить: node scripts/check-all-shops.js --fix');
    console.log('  Новые коды кассиров будут показаны — запишите их.');
    console.log('');
    process.exit(1);
  }

  console.log('');
  console.log(`  Починено: ${починено}`);

  if (выданные.length) {
    console.log('');
    console.log('  ═══ НОВЫЕ КОДЫ КАССИРОВ ═══');
    console.log('  Показываются ОДИН РАЗ — запишите и передайте владельцам.');
    console.log('');
    for (const s of выданные) console.log('    ' + s);
  }

  console.log('');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА: ' + e.message); process.exit(1); });
