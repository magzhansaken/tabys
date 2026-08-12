/** ЧАСТЬ 4 — КАССА. Смены, продажа, скидки, оплата, округление, возвраты, отложенные чеки. */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { PosService } = require('../dist/pos/pos.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const db = new DbService();
  const goods = new GoodsService(db);
  const svc = new PosService(db, goods);
  const stock = new StockService(db, new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 }), goods);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Касса Тест','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  const ctx = await tx(async (c) => {
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const cashier = (await c.query(`INSERT INTO employee (account_id, role_id, first_name, phone, can_login_pos) VALUES ($1,(SELECT id FROM role WHERE code='cashier'),'Марат',$2,true) RETURNING id`, [accountId, '+7705' + Math.floor(1000000 + Math.random() * 8999999)])).rows[0].id;
    const cons = (await c.query(`INSERT INTO consultant (account_id, name, phone) VALUES ($1,'Продавец Алия','+77015550001') RETURNING id`, [accountId])).rows[0].id;

    const milk = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, purchase_price, vat_rate) VALUES ($1,'Молоко','simple',$2,380,12) RETURNING id`, [accountId, sht])).rows[0].id;
    await c.query(`INSERT INTO barcode (account_id, product_id, code, type, is_primary) VALUES ($1,$2,'4870200000017','ean13',true)`, [accountId, milk]);
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,450)`, [accountId, milk, rt]);

    const bread = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, purchase_price, min_price) VALUES ($1,'Хлеб','simple',$2,100,140) RETURNING id`, [accountId, sht])).rows[0].id;
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,150)`, [accountId, bread, rt]);

    const cig = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, purchase_price) VALUES ($1,'Сигареты','simple',$2,600) RETURNING id`, [accountId, sht])).rows[0].id;
    const block = (await c.query(`INSERT INTO package (account_id, product_id, name, quantity) VALUES ($1,$2,'Блок',10) RETURNING id`, [accountId, cig])).rows[0].id;
    await c.query(`INSERT INTO barcode (account_id, product_id, package_id, code, type) VALUES ($1,$2,$3,'4870200000031','ean13')`, [accountId, cig, block]);
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,750)`, [accountId, cig, rt]);

    const bag = (await c.query(`INSERT INTO product (account_id, name, kind, track_stock) VALUES ($1,'Пакет','service',false) RETURNING id`, [accountId])).rows[0].id;
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,20)`, [accountId, bag, rt]);
    return { store, wh, reg, sht, cashier, cons, milk, bread, cig, bag };
  });

  // товар на складе
  const sup = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId });
  await stock.addItem(accountId, sup.id, { productId: ctx.milk, qty: 100, price: 380 });
  await stock.addItem(accountId, sup.id, { productId: ctx.bread, qty: 50, price: 100 });
  await stock.addItem(accountId, sup.id, { productId: ctx.cig, qty: 100, price: 600 });
  await stock.process(accountId, sup.id);

  // ============ 4.6 СМЕНА ============
  const sh = await svc.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ctx.cashier, openingFloat: 5000 });
  ok(sh.number === 1 && sh.status === 'open', 'Смена №1 открыта с разменом 5000 ₸');
  let twice = false;
  try { await svc.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ctx.cashier }); } catch { twice = true; }
  ok(twice, 'Вторую смену на той же кассе открыть нельзя');

  // ============ 4.1 ЭКРАН ПРОДАЖИ ============
  let sale = await svc.newSale(accountId, { shiftId: sh.id, employeeId: ctx.cashier, consultantId: ctx.cons });
  ok(sale.status === 'draft' && sale.consultant_id === ctx.cons, 'Чек открыт, продавец-консультант указан (модель UMAG)');

  await svc.addToCart(accountId, sale.id, { barcode: '4870200000017' });     // сканер
  await svc.addToCart(accountId, sale.id, { productId: ctx.bread, qty: 2 }); // поиск
  sale = await svc.addToCart(accountId, sale.id, { barcode: '4870200000017' });
  const items = await tx(async (c) => (await c.query(`SELECT product_id, qty FROM sale_item WHERE sale_id=$1`, [sale.id])).rows);
  ok(Number(items.find((i) => i.product_id === ctx.milk).qty) === 2, 'Повторный скан того же товара: количество растёт, а не дублируется строка');
  ok(near(sale.subtotal, 450 * 2 + 150 * 2), `Промежуточный итог ${sale.subtotal} ₸`);
  ok(near(sale.cost_total, 380 * 2 + 100 * 2), 'Себестоимость чека считает касса (сервер не пересчитывает — после суток офлайна цифры разъехались бы)');
  ok(near(sale.profit, sale.total - sale.cost_total), `Прибыль по чеку ${sale.profit} ₸`);

  sale = await svc.addToCart(accountId, sale.id, { barcode: '4870200000031' });   // блок сигарет
  const cigItem = await tx(async (c) => (await c.query(`SELECT qty FROM sale_item WHERE sale_id=$1 AND product_id=$2`, [sale.id, ctx.cig])).rows[0]);
  ok(Number(cigItem.qty) === 10, 'Скан блока на кассе даёт 10 пачек (упаковки из 2.6)');
  await svc.cancelItem(accountId, sale.id, ctx.cig);

  // ============ 4.4 ОТМЕНЁННЫЕ ТОВАРЫ (контроль UMAG) ============
  const canc = await svc.cancelledItems(accountId);
  ok(canc.length === 1 && canc[0].product === 'Сигареты', 'Отмена позиции попала в журнал отменённых (раздел UMAG)');
  ok(canc[0].employee === 'Марат' && canc[0].cash_register === 'Касса 1', 'Видно, кто и на какой кассе отменил — это антифрод');
  ok(canc[0].display === '10', 'Отменено полностью — в журнале одно число (формат UMAG)');

  await svc.addToCart(accountId, sale.id, { productId: ctx.cig, qty: 5 });
  await svc.cancelItem(accountId, sale.id, ctx.cig, 3);
  const canc2 = await svc.cancelledItems(accountId);
  ok(canc2[0].display === '5→3', 'Частичная отмена показана как «5→3»: добавили 5, отменили 3 (формат UMAG дословно)');
  await svc.cancelItem(accountId, sale.id, ctx.cig);

  // ============ 4.2 СКИДКИ ============
  sale = await svc.setDiscount(accountId, sale.id, { productId: ctx.milk, percent: 10 });
  const milkItem = await tx(async (c) => (await c.query(`SELECT discount_sum, total FROM sale_item WHERE sale_id=$1 AND product_id=$2`, [sale.id, ctx.milk])).rows[0]);
  ok(near(milkItem.discount_sum, 90) && near(milkItem.total, 810), 'Ручная скидка 10% на товар: 900 → 810 ₸');

  let tooBig = false;
  try { await svc.setDiscount(accountId, sale.id, { productId: ctx.milk, percent: 50 }); } catch (e) { tooBig = /разрешение старшего/.test(e.message); }
  ok(tooBig, 'Скидка больше предела из разрешений кассы требует старшего (наше добавление к модели Wipon)');

  let belowMin = false;
  try { await svc.setDiscount(accountId, sale.id, { productId: ctx.bread, percent: 10 }); } catch (e) { belowMin = /ниже минимальной/.test(e.message); }
  ok(belowMin, 'Скидка не пускает цену ниже минимальной (защита из Части 2 — «по доброте» в убыток не продадим)');

  // автоматическая скидка (модель Wipon)
  await tx(async (c) => c.query(`INSERT INTO discount (account_id, name, percent, scope, product_id, auto_apply) VALUES ($1,'Акция на хлеб',20,'product',$2,true)`, [accountId, ctx.bread]));
  const sale2 = await svc.newSale(accountId, { shiftId: sh.id, employeeId: ctx.cashier });
  const s2 = await svc.addToCart(accountId, sale2.id, { productId: ctx.bread, qty: 2 });
  ok(near(s2.discount_sum, 60) && near(s2.total, 240), 'Автоматическая скидка подтянулась сама: 300 − 20% = 240 ₸ (модель Wipon)');

  // ============ 4.3 ОКРУГЛЕНИЕ (модель Wipon) ============
  await tx(async (c) => c.query(`UPDATE pos_profile SET round_mode='total', round_to=5 WHERE account_id=$1`, [accountId]));
  const sale3 = await svc.newSale(accountId, { shiftId: sh.id, employeeId: ctx.cashier });
  await svc.addToCart(accountId, sale3.id, { productId: ctx.bread, qty: 1 });
  const s3 = await svc.addToCart(accountId, sale3.id, { productId: ctx.bag, qty: 1 });   // 150−20%=120 + 20 = 140
  const s3b = await svc.setDiscount(accountId, sale3.id, { percent: 3 });
  ok(s3b.total % 5 === 0, `Округление до 5 ₸ (в КЗ мелочь вышла из обихода): итог ${s3b.total} ₸`);
  ok(Number(s3b.rounding) <= 0, `Округляем в пользу покупателя: поправка ${s3b.rounding} ₸ (спор у кассы дороже копеек)`);
  await tx(async (c) => c.query(`UPDATE pos_profile SET round_to=1 WHERE account_id=$1`, [accountId]));

  // ============ 4.3 ОПЛАТА ============
  let notEnough = false;
  try { await svc.pay(accountId, sale.id, [{ method: 'cash', amount: 10 }]); } catch (e) { notEnough = /Не хватает/.test(e.message); }
  ok(notEnough, 'Оплата меньше суммы чека отклонена');

  let noCustomer = false;
  try { await svc.pay(accountId, sale.id, [{ method: 'credit', amount: 1110 }]); } catch (e) { noCustomer = /покупателем/.test(e.message); }
  ok(noCustomer, 'В долг без выбранного покупателя нельзя (правило Wipon)');

  const paid = await svc.pay(accountId, sale.id, [{ method: 'cash', amount: sale.total, received: 2000 }]);
  ok(paid.status === 'completed' && paid.number === 1, `Чек №${paid.number} пробит`);
  ok(near(paid.change_given, 2000 - Number(sale.total)), `Сдача посчитана: ${paid.change_given} ₸ (кассир нажал номинал «2000», как у Wipon)`);

  const stockAfter = await stock.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh });
  ok(stockAfter[0].qty === 98, 'Товар списался со склада: было 100, продали 2 → 98');

  // смешанная оплата (модель Wipon: вводится одна сумма, вторая считается)
  const sale4 = await svc.newSale(accountId, { shiftId: sh.id, employeeId: ctx.cashier });
  const s4 = await svc.addToCart(accountId, sale4.id, { productId: ctx.milk, qty: 4 });
  const mixed = await svc.pay(accountId, sale4.id, [
    { method: 'cash', amount: 1000, received: 1000 },
    { method: 'card', amount: Number(s4.total) - 1000 },
  ]);
  ok(near(mixed.paid_cash, 1000) && near(mixed.paid_card, Number(s4.total) - 1000), 'Смешанная оплата: часть наличными, часть картой');

  // QR — казахстанская специфика, которой нет в доках ни у кого из троих
  const sale5 = await svc.newSale(accountId, { shiftId: sh.id, employeeId: ctx.cashier });
  const s5 = await svc.addToCart(accountId, sale5.id, { productId: ctx.milk, qty: 1 });
  const qr = await svc.pay(accountId, sale5.id, [{ method: 'qr', amount: Number(s5.total), ref: 'kaspi-tx-123' }]);
  ok(near(qr.paid_qr, s5.total), 'Оплата по QR (Kaspi) — в Казахстане это половина платежей, у конкурентов в доках такого способа нет');

  // ============ 4.5 ОТЛОЖЕННЫЕ ЧЕКИ (модель МС) ============
  const sale6 = await svc.newSale(accountId, { shiftId: sh.id, employeeId: ctx.cashier });
  await svc.addToCart(accountId, sale6.id, { productId: ctx.milk, qty: 1 });
  const parked = await svc.park(accountId, sale6.id);
  ok(parked.status === 'parked', 'Чек отложен: покупатель пошёл за добавкой (модель МС)');
  const plist = await svc.parkedList(accountId, sh.id);
  ok(plist.length === 1, 'Отложенный чек виден в списке');

  const pre = await svc.preReceipt(accountId, sale6.id);
  ok(pre.isPreReceipt && pre.items.length === 1, 'Пречек из отложенного чека печатается (модель МС)');

  // цена изменилась, пока чек лежал
  await tx(async (c) => c.query(`UPDATE product_price SET value=500 WHERE product_id=$1 AND store_id IS NULL`, [ctx.milk]));
  const un = await svc.unpark(accountId, sale6.id);
  ok(un.warnings.some((w) => /цена изменилась/.test(w)),
     'При возврате к чеку видно, что цена изменилась (МС в этом месте просто не даёт оформить — мы показываем и даём решить)');
  await tx(async (c) => c.query(`UPDATE product_price SET value=450 WHERE product_id=$1 AND store_id IS NULL`, [ctx.milk]));
  await svc.pay(accountId, sale6.id, [{ method: 'cash', amount: un.sale.total, received: un.sale.total }]);

  // ============ 4.4 ВОЗВРАТЫ ============
  const stockAfterSales = (await stock.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh }))[0].qty;
  const full = await svc.refund(accountId, { saleId: paid.id, shiftId: sh.id, employeeId: ctx.cashier, comment: 'Не подошло' });
  ok(full.return_of_id === paid.id && Number(full.total) > 0, `Полный возврат оформлен на ${full.total} ₸`);
  const origStatus = await tx(async (c) => (await c.query(`SELECT status FROM sale WHERE id=$1`, [paid.id])).rows[0].status);
  ok(origStatus === 'returned', 'Исходный чек помечен как возвращённый');
  const backQty = (await stock.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh }))[0].qty;
  ok(backQty === stockAfterSales + 2, `Товар вернулся на склад: было ${stockAfterSales}, стало ${backQty}`);

  let twiceRefund = false;
  try { await svc.refund(accountId, { saleId: paid.id, shiftId: sh.id, employeeId: ctx.cashier }); } catch { twiceRefund = true; }
  ok(twiceRefund, 'Повторно вернуть тот же чек нельзя');

  // частичный возврат
  const partial = await svc.refund(accountId, {
    saleId: mixed.id, shiftId: sh.id, employeeId: ctx.cashier,
    items: [{ productId: ctx.milk, qty: 2 }],
  });
  ok(near(partial.total, Number(mixed.total) / 2), `Частичный возврат: вернули 2 из 4 шт на ${partial.total} ₸`);
  const mixedStatus = await tx(async (c) => (await c.query(`SELECT status FROM sale WHERE id=$1`, [mixed.id])).rows[0].status);
  ok(mixedStatus === 'completed', 'Чек с частичным возвратом остаётся пробитым — вернули не всё');
  let overRefund = false;
  try { await svc.refund(accountId, { saleId: mixed.id, shiftId: sh.id, employeeId: ctx.cashier, items: [{ productId: ctx.milk, qty: 3 }] }); }
  catch (e) { overRefund = /осталось/.test(e.message); }
  ok(overRefund, 'Вернуть больше, чем осталось по чеку, нельзя');

  // ============ 4.6 ДЕНЬГИ В КАССЕ ============
  await svc.cashOperation(accountId, { shiftId: sh.id, kind: 'deposit', amount: 3000, comment: 'Разменяли', employeeId: ctx.cashier });
  let tooMuch = false;
  try { await svc.cashOperation(accountId, { shiftId: sh.id, kind: 'withdrawal', amount: 999999, employeeId: ctx.cashier }); }
  catch (e) { tooMuch = /нельзя/.test(e.message); }
  ok(tooMuch, 'Изъять больше, чем есть в кассе, нельзя');
  await svc.cashOperation(accountId, { shiftId: sh.id, kind: 'collection', amount: 1000, comment: 'Инкассация', employeeId: ctx.cashier, approvedBy: ownerId });

  // ============ X-ОТЧЁТ ============
  const x = await svc.xReport(accountId, sh.id);
  ok(x.receipts >= 3, `X-отчёт: ${x.receipts} чеков, выручка ${x.revenue} ₸ (возвращённый чек в выручку не входит — это верно)`);
  // часть 16: размен больше НЕ входит во внесения (он отдельная строка
  // X-отчёта, как в Z-отчёте Wipon) — иначе expected_cash считал его дважды
  ok(x.openingFloat === 5000 && x.deposits === 3000 && x.withdrawals === 1000, 'X-отчёт видит размен, внесения и изъятия (размен — отдельной строкой)');
  ok(x.qr > 0 && x.card > 0 && x.cash > 0, 'X-отчёт разделяет наличные, карту и QR');
  ok(x.expectedCash > 0, `В кассе должно быть ${x.expectedCash} ₸`);

  // ============ Z-ОТЧЁТ И ЗАКРЫТИЕ ============
  let needComment = false;
  try { await svc.closeShift(accountId, sh.id, { employeeId: ctx.cashier, actualCash: x.expectedCash - 3000 }); }
  catch (e) { needComment = /нужен комментарий/.test(e.message); }
  ok(needComment, '★ Расхождение при закрытии требует объяснения: не «недостача 3000, ну ладно», а «объясни»');

  const sale7 = await svc.newSale(accountId, { shiftId: sh.id, employeeId: ctx.cashier });
  await svc.addToCart(accountId, sale7.id, { productId: ctx.milk, qty: 1 });
  await svc.park(accountId, sale7.id);
  let hasParked = false;
  try { await svc.closeShift(accountId, sh.id, { employeeId: ctx.cashier, actualCash: x.expectedCash }); }
  catch (e) { hasParked = /отложенных/.test(e.message); }
  ok(hasParked, 'Смену с отложенными чеками не закрыть — они живут только до конца смены (правило МС)');
  await svc.unpark(accountId, sale7.id);
  await tx(async (c) => c.query(`UPDATE sale SET status='cancelled' WHERE id=$1`, [sale7.id]));

  const z = await svc.closeShift(accountId, sh.id, { employeeId: ctx.cashier, actualCash: x.expectedCash - 500, comment: 'Ошиблась сдачей' });
  ok(z.discrepancy === -500 && z.shift.status === 'closed', `Z-отчёт: смена закрыта, недостача ${z.discrepancy} ₸ с объяснением`);
  const closed = await tx(async (c) => (await c.query(`SELECT discrepancy_comment, receipts_count FROM shift WHERE id=$1`, [sh.id])).rows[0]);
  ok(closed.discrepancy_comment === 'Ошиблась сдачей', 'Объяснение сохранено в смене — владелец увидит');

  const sh2 = await svc.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ctx.cashier, openingFloat: 5000 });
  ok(sh2.number === 2, 'Новая смена №2 открывается после закрытия предыдущей');

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  const foreign = await svc.cancelledItems(acc2.account_id);
  ok(foreign.length === 0, 'Чужой аккаунт не видит наши отмены');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
