/**
 * Создаёт демо-магазин, чтобы было чем зайти в кабинет.
 * Запуск:  node setup_demo.js
 */
const { DbService } = require('./dist/db/db.service');
// хешируем тем же способом, каким сервер проверяет: bcryptjs, а не crypt() в SQL
const bcrypt = require('bcryptjs');

const PHONE = '+77011234567';
const PASSWORD = '12345678';

(async () => {
  const db = new DbService();
  try {
    // таблица аккаунтов тоже под изоляцией, поэтому обычный SELECT её не видит.
    // Проверяем через служебную функцию регистрации: она сама скажет, занят ли номер.
    const exists = (await db.raw(
      `SELECT id AS account_id FROM account WHERE phone = $1 LIMIT 1`, [PHONE])).rows[0];

    let accountId;
    if (exists) {
      accountId = exists.account_id;
      console.log('Аккаунт уже был, использую его.');
    } else {
      const a = (await db.raw(
        `SELECT * FROM register_account($1, 'Магазин у дома', 'Магжан', 'ru')`, [PHONE])).rows[0];
      accountId = a.account_id;
      console.log('Аккаунт создан.');
    }

    // пароль ставим владельцу. Через withTenant: изоляция аккаунтов не пустит
    // к чужим строкам, пока не сказано, чей аккаунт смотрим.
    const hash = await bcrypt.hash(PASSWORD, 8);
    const owner = await db.withTenant(accountId, async (c) => {
      const r = await c.query(
        `UPDATE employee SET password_hash = $1
          WHERE is_owner AND deleted_at IS NULL
          RETURNING id, first_name, is_owner`, [hash]);
      return r.rows[0];
    });
    if (!owner) throw new Error('Владелец в этом аккаунте не найден');
    console.log(`Пароль задан для: ${owner.first_name} (владелец: ${owner.is_owner})`);

    // немного товара, чтобы кабинет был не пустой
    await db.withTenant(accountId, async (c) => {
      const has = Number((await c.query(`SELECT count(*) n FROM product`)).rows[0].n);
      if (has > 0) { console.log(`Товары уже есть: ${has}`); return; }

      const unit = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
      const kg = (await c.query(`SELECT id FROM unit WHERE short_name='кг' LIMIT 1`)).rows[0].id;
      const retail = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
      const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
      const cat = (await c.query(
        `INSERT INTO category (account_id, name) VALUES ($1,'Продукты') RETURNING id`, [accountId])).rows[0].id;

      const goods = [
        ['Молоко Айран 1л', 'simple', unit, 300, 480, '4870000000017'],
        ['Хлеб формовой',   'simple', unit, 150, 250, '4870000000024'],
        ['Яблоки Голден',   'weight', kg,   600, 890, null],
      ];
      for (const [name, kind, u, cost, price, bc] of goods) {
        const p = (await c.query(
          `INSERT INTO product (account_id, name, kind, unit_id, category_id, purchase_price, min_stock)
           VALUES ($1,$2,$3::product_kind,$4,$5,$6,10) RETURNING id`,
          [accountId, name, kind, u, cat, cost])).rows[0].id;
        await c.query(
          `INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,$4)`,
          [accountId, p, retail, price]);
        if (bc) await c.query(
          `INSERT INTO barcode (account_id, product_id, code, is_primary) VALUES ($1,$2,$3,true)`,
          [accountId, p, bc]);
        // кладём остаток на склад: остаток — это сумма движений (принцип 1.3)
        await c.query(`SELECT apply_stock_move($1,$2,$3,50::numeric,300::numeric,'supply',NULL,NULL)`,
          [accountId, wh, p]);
      }
      console.log('Заведено товаров: 3, остатки положены на склад.');
    });

    console.log('');
    console.log('===================================');
    console.log('  Заходи в кабинет:');
    console.log('  http://localhost:3100/login');
    console.log('');
    console.log('  Телефон: ' + PHONE);
    console.log('  Пароль:  ' + PASSWORD);
    console.log('===================================');
  } catch (e) {
    console.error('ОШИБКА:', e.message);
  } finally {
    await db.onModuleDestroy();
  }
})();
