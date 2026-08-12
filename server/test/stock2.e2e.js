/** Часть 3, добор: режимы инвентаризации (3.6), уведомления и пополнение (3.7). */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const db = new DbService();
  const sync = new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 });
  const goods = new GoodsService(db);
  const svc = new StockService(db, sync, goods);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Склад2 Тест','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  const ctx = await tx(async (c) => {
    const wh1 = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const wh2 = (await c.query(`INSERT INTO warehouse (account_id, store_id, name) VALUES ($1,$2,'Склад №2') RETURNING id`, [accountId, store])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const dairy = (await c.query(`INSERT INTO category (account_id, name) VALUES ($1,'Молочное') RETURNING id`, [accountId])).rows[0].id;
    const tobacco = (await c.query(`INSERT INTO category (account_id, name) VALUES ($1,'Табак') RETURNING id`, [accountId])).rows[0].id;

    const milk = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, category_id, min_stock) VALUES ($1,'Молоко','simple',$2,$3,20) RETURNING id`, [accountId, sht, dairy])).rows[0].id;
    await c.query(`INSERT INTO barcode (account_id, product_id, code, type, is_primary) VALUES ($1,$2,'4870200000017','ean13',true)`, [accountId, milk]);
    const kefir = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, category_id, min_stock) VALUES ($1,'Кефир','simple',$2,$3,5) RETURNING id`, [accountId, sht, dairy])).rows[0].id;
    const cig = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, category_id) VALUES ($1,'Сигареты','simple',$2,$3) RETURNING id`, [accountId, sht, tobacco])).rows[0].id;
    await c.query(`INSERT INTO barcode (account_id, product_id, code, type, is_primary) VALUES ($1,$2,'4870200000024','ean13',true)`, [accountId, cig]);
    const block = (await c.query(`INSERT INTO package (account_id, product_id, name, quantity) VALUES ($1,$2,'Блок',10) RETURNING id`, [accountId, cig])).rows[0].id;
    await c.query(`INSERT INTO barcode (account_id, product_id, package_id, code, type) VALUES ($1,$2,$3,'4870200000031','ean13')`, [accountId, cig, block]);
    return { wh1, wh2, store, milk, kefir, cig, dairy, tobacco };
  });

  // наполняем склад
  const sup = await svc.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh1, employeeId: ownerId });
  await svc.addItem(accountId, sup.id, { productId: ctx.milk, qty: 30, price: 380 });
  await svc.addItem(accountId, sup.id, { productId: ctx.kefir, qty: 12, price: 300 });
  await svc.addItem(accountId, sup.id, { productId: ctx.cig, qty: 100, price: 600 });
  await svc.process(accountId, sup.id);

  // ============ СКАНЕР-РЕЖИМ (способ №2 у UMAG) ============
  const inv = await svc.createDoc(accountId, { kind: 'inventory', warehouseId: ctx.wh1, storeId: ctx.store, employeeId: ownerId, blind: true });
  let s = await svc.scanInto(accountId, inv.id, '4870200000017');
  ok(s.product.name === 'Молоко' && s.added === 1 && s.total === 1,
     'Сканер-режим: провели сканером по товару — позиция добавилась сама (способ №2 у UMAG)');
  s = await svc.scanInto(accountId, inv.id, '4870200000017');
  ok(s.total === 2, 'Второй скан того же штрихкода — количество накапливается, как при реальном пересчёте');

  // скан блока: у него свой штрихкод, должно прийти 10
  s = await svc.scanInto(accountId, inv.id, '4870200000031');
  ok(s.added === 10 && s.source === 'package',
     'Скан блока сигарет при пересчёте даёт 10 пачек, а не одну (упаковки из 2.6)');

  let notFound = false;
  try { await svc.scanInto(accountId, inv.id, '9999999999999'); } catch (e) { notFound = /не найден/.test(e.message); }
  ok(notFound, 'Неизвестный штрихкод отклонён с понятным текстом (валидационная ошибка UMAG)');

  // ============ СЛЕПОЙ РЕЖИМ ============
  const blindList = await svc.countingList(accountId, inv.id);
  ok(blindList.every((i) => i.book === null),
     'Слепой пересчёт: учётный остаток кассиру не показывается — иначе он видит «30» и пишет «30», не считая');
  ok(blindList.find((i) => i.name === 'Молоко').fact === 2, 'Но свой посчитанный факт кассир видит');

  await tx(async (c) => c.query(`UPDATE stock_doc SET blind=false WHERE id=$1`, [inv.id]));
  const openList = await svc.countingList(accountId, inv.id);
  ok(openList.find((i) => i.name === 'Молоко').book === 30, 'В обычном режиме учётный остаток виден (30 шт)');

  // ============ ЧАСТИЧНАЯ ИНВЕНТАРИЗАЦИЯ ПО КАТЕГОРИИ ============
  const part = await svc.startPartialInventory(accountId, {
    warehouseId: ctx.wh1, storeId: ctx.store, categoryId: ctx.dairy, employeeId: ownerId, blind: true,
  });
  ok(part.products === 2, `Частичная инвентаризация только по «Молочному»: ${part.products} позиции (UMAG: «можно разбить по типу товаров»)`);
  const partList = await svc.countingList(accountId, part.docId);
  ok(!partList.some((i) => i.name === 'Сигареты'), 'Сигарет в молочной инвентаризации нет — считаем только свою зону');
  ok(partList.every((i) => i.fact === 0), 'Все позиции начинаются с нуля — кассир вводит факт сам');

  await svc.setFact(accountId, part.docId, ctx.milk, 28);
  await svc.setFact(accountId, part.docId, ctx.kefir, 12);
  const rep = await svc.inventoryReport(accountId, part.docId);
  ok(rep.shortageCount === 1 && rep.matched === 1, 'Отчёт частичной: недостача по молоку, кефир сошёлся');
  await svc.process(accountId, part.docId);
  const milkQty = (await svc.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh1 }))[0].qty;
  ok(milkQty === 28, 'Частичная инвентаризация проведена: молока стало 28, сигарет никто не трогал');
  const cigQty = (await svc.balance(accountId, { productId: ctx.cig, warehouseId: ctx.wh1 }))[0].qty;
  ok(cigQty === 100, 'Сигареты не затронуты — их не было в документе');

  // ============ 3.7 УВЕДОМЛЕНИЯ ============
  let n = await svc.buildLowStockNotification(accountId, ownerId);
  ok(!n.created && /Нечего сообщать/.test(n.reason), 'Пока всё выше минимума — уведомлений нет');

  // роняем остаток ниже критического
  const wo = await svc.createDoc(accountId, { kind: 'write_off', warehouseId: ctx.wh1, employeeId: ownerId });
  await svc.addItem(accountId, wo.id, { productId: ctx.milk, qty: 20 });
  await svc.process(accountId, wo.id);

  n = await svc.buildLowStockNotification(accountId, ownerId);
  ok(n.created && n.items === 1, `Товар упал ниже критического — уведомление создано (${n.items} поз.)`);
  let list = await svc.notifications(accountId, ownerId);
  ok(/Заканчивается товар/.test(list[0].title) && /Молоко/.test(list[0].body), 'В уведомлении названо, что именно заканчивается');
  ok(list[0].link === '/stock?filter=low_stock', 'Ссылка ведёт на склад с уже включённым фильтром (находка UMAG)');

  // ГЛАВНОЕ ОТЛИЧИЕ: не спамим одним и тем же
  n = await svc.buildLowStockNotification(accountId, ownerId);
  ok(!n.created && /не изменился/.test(n.reason),
     '★ Повторный запуск не шлёт то же самое: UMAG слал бы это письмо каждое утро, пока товар не закажут');
  list = await svc.notifications(accountId, ownerId);
  ok(list.length === 1, 'В списке по-прежнему одно уведомление, а не два одинаковых');

  // список изменился — сообщаем снова
  const wo2 = await svc.createDoc(accountId, { kind: 'write_off', warehouseId: ctx.wh1, employeeId: ownerId });
  await svc.addItem(accountId, wo2.id, { productId: ctx.kefir, qty: 9 });
  await svc.process(accountId, wo2.id);
  n = await svc.buildLowStockNotification(accountId, ownerId);
  ok(n.created && n.items === 2, 'Список изменился (добавился кефир) — уведомление ушло');

  // выключение уведомлений
  await tx(async (c) => c.query(`UPDATE notify_setting SET enabled=false WHERE account_id=$1 AND kind='low_stock'`, [accountId]));
  n = await svc.buildLowStockNotification(accountId, ownerId);
  ok(!n.created && /выключены/.test(n.reason), 'Выключенные уведомления не шлются');
  await tx(async (c) => c.query(`UPDATE notify_setting SET enabled=true WHERE account_id=$1 AND kind='low_stock'`, [accountId]));

  const st = await tx(async (c) => (await c.query(`SELECT send_at, repeat_days FROM notify_setting WHERE account_id=$1 AND kind='low_stock'`, [accountId])).rows[0]);
  ok(String(st.send_at).startsWith('09:00'), 'Время по умолчанию 9:00 — как у UMAG, но у нас это настройка, а не жёсткий закон');

  // ============ ПОПОЛНЕНИЕ ДО НЕСНИЖАЕМОГО ОСТАТКА (модель МС) ============
  const plan = await svc.replenishmentPlan(accountId, ctx.wh1);
  ok(plan.length === 2, `План пополнения: ${plan.length} позиции ниже минимума (модель МС «Пополнить резервы»)`);
  const milkPlan = plan.find((p) => p.name === 'Молоко');
  ok(milkPlan.toOrder === 12 && milkPlan.qty === 8 && milkPlan.minStock === 20,
     'По молоку: есть 8, минимум 20 — докупить 12');
  ok(milkPlan.action === 'purchase', 'Пока товара нет на других складах — предлагается закупка');

  // кладём излишек на второй склад: теперь достаточно перемещения
  const sup2 = await svc.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh2, employeeId: ownerId });
  await svc.addItem(accountId, sup2.id, { productId: ctx.milk, qty: 60, price: 380 });
  await svc.process(accountId, sup2.id);
  const plan2 = await svc.replenishmentPlan(accountId, ctx.wh1);
  const milkPlan2 = plan2.find((p) => p.name === 'Молоко');
  ok(milkPlan2.action === 'transfer' && milkPlan2.availableElsewhere === 40,
     '★ На складе №2 лежит с избытком 40 — система предлагает перемещение вместо закупки (у МС такой подсказки в списке нет)');

  const tr = await svc.createReplenishmentTransfer(accountId, ctx.wh1, ownerId);
  ok(tr.created && tr.items >= 1, `Черновик перемещения создан автоматически: ${tr.items} поз.`);
  const trDoc = await tx(async (c) => (await c.query(`SELECT kind, status, comment FROM stock_doc WHERE id=$1`, [tr.docId])).rows[0]);
  ok(trDoc.kind === 'transfer' && trDoc.status === 'draft' && /Пополнение/.test(trDoc.comment),
     'Это черновик перемещения с понятным комментарием — владелец проверит и проведёт');
  await svc.process(accountId, tr.docId);
  const after = (await svc.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh1 }))[0];
  ok(after.qty === 20, 'После перемещения молока ровно 20 — неснижаемый остаток восстановлен');
  const plan3 = await svc.replenishmentPlan(accountId, ctx.wh1);
  ok(!plan3.some((p) => p.name === 'Молоко'), 'Молоко ушло из плана пополнения');

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  const foreignN = await svc.notifications(acc2.account_id);
  ok(foreignN.length === 0, 'Чужой аккаунт не видит наши уведомления');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
