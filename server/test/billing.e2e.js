/**
 * ЧАСТЬ 14 — ЭКСПЛУАТАЦИЯ И ЗАПУСК.
 * Ответ на модель UMAG: плата за кассы, 4 600 ₸ за сотрудника, рост цены +570%.
 */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { BillingService } = require('../dist/billing/billing.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const { PosService } = require('../dist/pos/pos.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');

  const db = new DbService();
  const goods = new GoodsService(db);
  const svc = new BillingService(db);
  const pos = new PosService(db, goods);
  const stock = new StockService(db, new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 }), goods);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Магазин Пилот','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  // ============ 14.1 ★ ТАРИФЫ ============
  const tariffs = await svc.tariffs();
  ok(tariffs.length === 2 && tariffs[0].code === 'start', `Тарифы: ${tariffs.map((t) => `${t.name} ${t.price_month}₸`).join(', ')}`);
  ok(tariffs[0].price_month === 6900 && tariffs[1].price_month === 14900,
     '★ Дешевле UMAG: 6 900 против их 8 800 «Старт», 14 900 против 19 900 «Стандарт»');
  ok(tariffs.every((t) => t.devicesUnlimited),
     '★ Безлимит устройств. У UMAG тариф ограничивает «количество магазинов и касс»');
  ok(tariffs.every((t) => t.employeesUnlimited),
     '★ Сотрудники бесплатно. У UMAG — 4 600 ₸ за каждого, из-за чего магазины не заводят кассирам учётки и теряют весь контроль');

  // ★ фиксация цены
  const sub = await svc.subscribe(accountId, 'start');
  ok(sub.price_locked === 6900 && sub.status === 'trial', `Подписка: ${sub.tariff}, ${sub.price_locked} ₸`);
  ok(/зафиксирована до/.test(sub.promise) && /за 60 дней с правом выгрузить данные/.test(sub.promise),
     `★ «${sub.promise}» — прямой ответ на рост цены UMAG до +570%, когда уходить уже поздно`);
  const lockYear = new Date(sub.price_locked_until).getFullYear();
  ok(lockYear === new Date().getFullYear() + 1, 'Цена держится 12 месяцев');

  // ============ ★ СПИСАНИЕ И ЛЬГОТНЫЙ ПЕРИОД ============
  const acc0 = await svc.access(accountId);
  ok(acc0.canSell && acc0.status === 'trial', 'На пробном периоде можно торговать');

  const ch1 = await svc.charge(accountId);
  ok(ch1.charged === 0 && ch1.status === 'grace' && /Даём 7 дней — касса работает как обычно/.test(ch1.message),
     `★ Денег нет → льготный период: «${ch1.message}». Остановить торговлю из-за забытого платежа — это выручка магазина за день`);
  const acc1 = await svc.access(accountId);
  ok(acc1.canSell, '★ В льготный период касса работает как обычно');

  await tx(async (c) => c.query(`UPDATE subscription SET grace_until = current_date - 1 WHERE account_id=$1`, [accountId]));
  const ch2 = await svc.charge(accountId);
  ok(ch2.status === 'readonly' && /только на чтение/.test(ch2.message), `Льгота кончилась: «${ch2.message}»`);
  const acc2 = await svc.access(accountId);
  ok(!acc2.canSell && acc2.canRead && acc2.canCloseShift,
     '★ Только чтение — но смену закрыть можно: деньги в ящике надо сдать, а чек из налоговой не отзовёшь');

  // ★ пополнили — работа вернулась
  const top = await svc.topup(accountId, 10000, 'Оплата за июль');
  ok(top.balance === 10000, `Пополнено: баланс ${top.balance} ₸`);
  const ch3 = await svc.charge(accountId);
  ok(ch3.charged === 6900 && ch3.status === 'active' && near(ch3.balance, 3100),
     `★ Списано ${ch3.charged} ₸, статус «${ch3.status}», остаток ${ch3.balance} ₸`);
  const acc3 = await svc.access(accountId);
  ok(acc3.canSell && acc3.paidUntil, `Работа вернулась, оплачено до ${acc3.paidUntil}`);

  // ★ вторая точка — доплата, но не за кассы
  await tx(async (c) => c.query(`UPDATE subscription SET stores_paid = 2 WHERE account_id=$1`, [accountId]));
  await svc.topup(accountId, 20000);
  const ch4 = await svc.charge(accountId);
  ok(ch4.charged === 6900 + 4900,
     `★ Вторая торговая точка: ${ch4.charged} ₸ (6 900 + 4 900 за точку). Считаем по точкам, а не по кассам`);

  // ============ ★ ЗАМОРОЗКА (механика UMAG) ============
  const fr = await svc.freeze(accountId);
  ok(fr.frozen && /Данные сохранены/.test(fr.note), `Заморозка: «${fr.note}»`);
  const chFrozen = await svc.charge(accountId);
  ok(chFrozen.charged === 0, '★ Замороженная компания не платит — магазин закрылся на месяц, данные целы');
  const accFr = await svc.access(accountId);
  ok(!accFr.canSell && accFr.canRead, 'В заморозке торговать нельзя, смотреть можно');

  const top2 = await svc.topup(accountId, 5000);
  ok(top2.unfrozen, '★ Авторазморозка при пополнении — механика UMAG, взяли как есть');
  ok((await svc.access(accountId)).canSell, 'После разморозки касса работает');

  const hist = await svc.history(accountId);
  ok(hist.length >= 5 && hist.some((h) => h.kind === 'charge') && hist.some((h) => h.kind === 'topup'),
     `История биллинга: ${hist.length} операций, видно каждое списание`);

  // ============ 14.2 ★ АДМИНКА ПОДДЕРЖКИ ============
  const ctx = await tx(async (c) => {
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const p = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, purchase_price) VALUES ($1,'Молоко','simple',$2,300) RETURNING id`, [accountId, sht])).rows[0].id;
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,500)`, [accountId, p, rt]);
    await c.query(`UPDATE account SET came_from='umag' WHERE id=$1`, [accountId]);
    return { wh, store, reg, milk: p };
  });
  const sup = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId });
  await stock.addItem(accountId, sup.id, { productId: ctx.milk, qty: 50, price: 300 });
  await stock.process(accountId, sup.id);
  const sh = await pos.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ownerId, openingFloat: 1000 });
  const s1 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  const cart = await pos.addToCart(accountId, s1.id, { productId: ctx.milk, qty: 2 });
  await pos.pay(accountId, s1.id, [{ method: 'cash', amount: Number(cart.total), received: 1000 }]);

  const snap = await svc.supportSnapshot(accountId);
  ok(snap.account.name === 'Магазин Пилот' && snap.account.cameFrom === 'umag',
     `★ Оператор видит всё сразу: «${snap.account.name}», переехал с ${snap.account.cameFrom}`);
  ok(snap.subscription.tariff === 'Старт' && snap.subscription.status === 'active', 'Тариф и статус подписки');
  ok(snap.today.sales === 1 && near(snap.today.revenue, 1000), `Сегодня: ${snap.today.sales} чек на ${snap.today.revenue} ₸`);
  ok(snap.scale.products === 1 && snap.scale.stores === 1, 'Масштаб аккаунта');
  ok(snap.health === 'ok' && snap.problems.length === 0,
     '★ Проблем нет — а если бы были, оператор увидел бы их до звонка. У UMAG жалуются, что не дозвониться');

  // ★ проблемы всплывают
  await tx(async (c) => {
    const k = (await c.query(
      `INSERT INTO kkm (account_id, cash_register_id, store_id, provider, mode, reg_number)
       VALUES ($1,$2,$3,'none','all','600900999') RETURNING id`, [accountId, ctx.reg, ctx.store])).rows[0].id;
    await c.query(`INSERT INTO fiscal_receipt (account_id, kkm_id, op, status, punched_at) VALUES ($1,$2,'sale','pending',now())`, [accountId, k]);
    await c.query(`INSERT INTO device (account_id, cash_register_id, name, platform, token_hash, paired_at, last_seen_at)
                   VALUES ($1,$2,'Касса 1','windows','x',now(), now() - interval '2 hours')`, [accountId, ctx.reg]);
  });
  const snap2 = await svc.supportSnapshot(accountId);
  ok(snap2.problems.length === 2 && snap2.health === 'warning',
     `★ Проблемы названы сразу: ${snap2.problems.join('; ')}`);

  // ============ 14.3 АУДИТ ============
  const audit = await svc.audit(accountId);
  ok(Array.isArray(audit), `Журнал аудита доступен: ${audit.length} записей (каркас с Части 1)`);

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2x = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  ok((await svc.history(acc2x.account_id)).length === 0, 'Чужой аккаунт не видит наши списания');
  const foreign = await svc.access(acc2x.account_id);
  ok(!foreign.canSell && /Нет подписки/.test(foreign.reason), 'Без подписки продавать нельзя');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
