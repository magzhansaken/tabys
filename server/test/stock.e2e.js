/**
 * ЧАСТЬ 3 — СКЛАД. Критерий: полный товарный цикл без кассы.
 * Живая база, реальные документы, реальный пересчёт себестоимости.
 */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const db = new DbService();
  const sync = new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 });
  const svc = new StockService(db, sync);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Склад Тест','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  const ctx = await tx(async (c) => {
    const wh1 = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const wh2 = (await c.query(`INSERT INTO warehouse (account_id, store_id, name) VALUES ($1,$2,'Склад на рынке') RETURNING id`, [accountId, store])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const kg = (await c.query(`SELECT id FROM unit WHERE short_name='кг' LIMIT 1`)).rows[0].id;

    const milk = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, min_stock) VALUES ($1,'Молоко 2.5%','simple',$2,10) RETURNING id`, [accountId, sht])).rows[0].id;
    const cig = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id) VALUES ($1,'Сигареты Winston','simple',$2) RETURNING id`, [accountId, sht])).rows[0].id;
    const apple = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id) VALUES ($1,'Яблоки','weight',$2) RETURNING id`, [accountId, kg])).rows[0].id;
    const svc_item = (await c.query(`INSERT INTO product (account_id, name, kind, track_stock) VALUES ($1,'Доставка','service',false) RETURNING id`, [accountId])).rows[0].id;
    const block = (await c.query(`INSERT INTO package (account_id, product_id, name, quantity) VALUES ($1,$2,'Блок',10) RETURNING id`, [accountId, cig])).rows[0].id;
    return { wh1, wh2, store, milk, cig, apple, svc_item, block };
  });

  // ================= 3.1 ПРИЁМКА + ЧЕРНОВИК =================
  let doc = await svc.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh1, comment: 'Первая поставка', employeeId: ownerId });
  ok(doc.status === 'draft' && doc.number === 1, `Черновик приёмки №${doc.number} создан`);
  const before = await svc.balance(accountId, { productId: ctx.milk });
  ok(before.length === 0 || before[0].qty === 0, 'Черновик не влияет на учёт (модель UMAG)');

  await svc.addItem(accountId, doc.id, { productId: ctx.milk, qty: 100, price: 380 });
  await svc.addItem(accountId, doc.id, { productId: ctx.apple, qty: 50, price: 600 });
  await svc.addItem(accountId, doc.id, { productId: ctx.cig, packageId: ctx.block, qtyPackages: 5, price: 600 });
  const items = await tx(async (c) => (await c.query(`SELECT product_id, qty, qty_packages FROM stock_doc_item WHERE doc_id=$1`, [doc.id])).rows);
  const cigItem = items.find((i) => i.product_id === ctx.cig);
  ok(Number(cigItem.qty) === 50 && Number(cigItem.qty_packages) === 5,
     'Приёмка блоками: 5 блоков × 10 = 50 пачек (упаковки из 2.6; UMAG и Wipon так не умеют)');

  await svc.addItem(accountId, doc.id, { productId: ctx.milk, qty: 20, price: 380 });
  const milkItem = await tx(async (c) => (await c.query(`SELECT qty FROM stock_doc_item WHERE doc_id=$1 AND product_id=$2`, [doc.id, ctx.milk])).rows[0]);
  ok(Number(milkItem.qty) === 120, 'Один товар дважды — количество суммируется (модель UMAG)');

  let r = await svc.process(accountId, doc.id);
  ok(r.ok, 'Приёмка проведена');
  let bal = await svc.balance(accountId, { warehouseId: ctx.wh1, onlyNonZero: true });
  ok(bal.length === 3, 'На складе три позиции');
  const milkBal = bal.find((b) => b.product_id === ctx.milk);
  ok(milkBal.qty === 120 && near(milkBal.avg_cost, 380), `Молоко: 120 шт по 380 ₸`);

  // ================= 3.8 СРЕДНЕВЗВЕШЕННАЯ СЕБЕСТОИМОСТЬ =================
  const doc2 = await svc.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh1, employeeId: ownerId });
  await svc.addItem(accountId, doc2.id, { productId: ctx.milk, qty: 80, price: 450 });   // подорожало
  await svc.process(accountId, doc2.id);
  bal = await svc.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh1 });
  // (120×380 + 80×450) / 200 = 408
  ok(near(bal[0].avg_cost, 408), `★ Средневзвешенная: (120×380 + 80×450)/200 = ${bal[0].avg_cost} ₸ (у МС и UMAG здесь FIFO — но их касса не работает офлайн)`);
  ok(bal[0].qty === 200, 'Остаток 200 шт');

  // накладные расходы (модель МС)
  const doc3 = await svc.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh1, employeeId: ownerId, extraCosts: 2000 });
  await svc.addItem(accountId, doc3.id, { productId: ctx.apple, qty: 50, price: 600 });
  await svc.process(accountId, doc3.id);
  bal = await svc.balance(accountId, { productId: ctx.apple, warehouseId: ctx.wh1 });
  // было 50×600; пришло 50 по (600 + 2000/50=40) = 640 → (50×600 + 50×640)/100 = 620
  ok(near(bal[0].avg_cost, 620), `Накладные расходы 2000 ₸ вошли в себестоимость: ${bal[0].avg_cost} ₸ (модель МС)`);

  // ================= 3.3 ПЕРЕМЕЩЕНИЕ =================
  const mv = await svc.createDoc(accountId, { kind: 'transfer', warehouseId: ctx.wh1, warehouseToId: ctx.wh2, employeeId: ownerId });
  await svc.addItem(accountId, mv.id, { productId: ctx.milk, qty: 50 });
  await svc.process(accountId, mv.id);
  const b1 = (await svc.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh1 }))[0];
  const b2 = (await svc.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh2 }))[0];
  ok(b1.qty === 150 && b2.qty === 50, 'Перемещение: 50 шт уехали со склада у дома на рынок');
  ok(near(b2.avg_cost, 408), 'Себестоимость уехала вместе с товаром — на рынке те же 408 ₸');

  let same = false;
  try { await svc.createDoc(accountId, { kind: 'transfer', warehouseId: ctx.wh1, warehouseToId: ctx.wh1 }); } catch { same = true; }
  ok(same, 'Перемещение на тот же склад отклонено');

  // ================= 3.4 СПИСАНИЕ =================
  const wo = await svc.createDoc(accountId, { kind: 'write_off', warehouseId: ctx.wh1, employeeId: ownerId, comment: 'Просрочка' });
  await svc.addItem(accountId, wo.id, { productId: ctx.milk, qty: 10, reason: 'Истёк срок годности' });
  await svc.process(accountId, wo.id);
  const afterWo = (await svc.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh1 }))[0];
  ok(afterWo.qty === 140, 'Списание: 10 шт просрочки убрано');
  ok(near(afterWo.avg_cost, 408), 'Списание не меняет среднюю себестоимость — только количество');

  // ================= 3.2 ВОЗВРАТ ПОСТАВЩИКУ =================
  const sr = await svc.createDoc(accountId, { kind: 'supplier_return', warehouseId: ctx.wh1, employeeId: ownerId });
  await svc.addItem(accountId, sr.id, { productId: ctx.cig, qty: 10 });
  await svc.process(accountId, sr.id);
  const cigBal = (await svc.balance(accountId, { productId: ctx.cig, warehouseId: ctx.wh1 }))[0];
  ok(cigBal.qty === 40, 'Возврат поставщику: 10 пачек уехали обратно, осталось 40');

  // ================= 3.5 ОПРИХОДОВАНИЕ =================
  const adj = await svc.createDoc(accountId, { kind: 'adjustment', warehouseId: ctx.wh1, employeeId: ownerId, comment: 'Нашлось на полке' });
  await svc.addItem(accountId, adj.id, { productId: ctx.cig, qty: 5, price: 600 });
  await svc.process(accountId, adj.id);
  ok((await svc.balance(accountId, { productId: ctx.cig, warehouseId: ctx.wh1 }))[0].qty === 45,
     'Оприходование: нашли 5 неучтённых пачек (у МС это «обнаружение неучтённого товара», в отличие от приёмки)');

  // ================= ВАЛИДАЦИЯ =================
  const badDoc = await svc.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh1 });
  await svc.addItem(accountId, badDoc.id, { productId: ctx.milk, qty: 5 });     // без цены
  let v = await svc.validate(accountId, badDoc.id);
  ok(!v.valid && /не указана цена закупки/.test(v.problems[0].error), 'Приёмка без цены не проводится (валидация до проведения, модель UMAG)');

  const svcDoc = await svc.createDoc(accountId, { kind: 'write_off', warehouseId: ctx.wh1 });
  await svc.addItem(accountId, svcDoc.id, { productId: ctx.svc_item, qty: 1 });
  v = await svc.validate(accountId, svcDoc.id);
  ok(!v.valid && /услуга/.test(v.problems[0].error), 'Услугу нельзя списать со склада — остатки по ней не ведутся');

  const emptyDoc = await svc.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh1 });
  v = await svc.validate(accountId, emptyDoc.id);
  ok(!v.valid && /нет ни одной позиции/.test(v.problems[0].error), 'Пустой документ не проводится');

  // ================= ЗАПРЕТ ОТРИЦАТЕЛЬНОГО ОСТАТКА =================
  await tx(async (c) => c.query(`UPDATE account SET allow_negative_stock=false WHERE id=$1`, [accountId]));
  const neg = await svc.createDoc(accountId, { kind: 'write_off', warehouseId: ctx.wh1 });
  await svc.addItem(accountId, neg.id, { productId: ctx.milk, qty: 99999 });
  v = await svc.validate(accountId, neg.id);
  ok(!v.valid && /на складе/.test(v.problems[0].error), 'Списать больше, чем есть, нельзя (когда настройка запрещает минус)');
  await tx(async (c) => c.query(`UPDATE account SET allow_negative_stock=true WHERE id=$1`, [accountId]));

  // ================= 3.7 КРИТИЧЕСКИЕ ОСТАТКИ =================
  const low1 = await svc.lowStock(accountId, ctx.wh1);
  ok(low1.length === 0, 'Пока молока 140 при минимуме 10 — уведомлений нет');
  const wo2 = await svc.createDoc(accountId, { kind: 'write_off', warehouseId: ctx.wh1 });
  await svc.addItem(accountId, wo2.id, { productId: ctx.milk, qty: 135 });
  await svc.process(accountId, wo2.id);
  const low2 = await svc.lowStock(accountId, ctx.wh1);
  ok(low2.length === 1 && low2[0].name === 'Молоко 2.5%' && low2[0].deficit === 5,
     'Критический остаток (UMAG) = неснижаемый остаток (МС): осталось 5 при минимуме 10, не хватает 5');

  // ================= 3.6 ИНВЕНТАРИЗАЦИЯ =================
  const inv = await svc.createDoc(accountId, { kind: 'inventory', warehouseId: ctx.wh1, storeId: ctx.store, employeeId: ownerId, blind: true });
  ok(inv.status === 'draft' && inv.blind === true, 'Инвентаризация создана в режиме слепого пересчёта (нашего добавления нет ни у кого из троих)');

  // остаток фиксируется на момент первого сканирования (главная находка UMAG)
  await svc.addItem(accountId, inv.id, { productId: ctx.milk, qty: 4 });
  const snap = await tx(async (c) => (await c.query(`SELECT qty_book, book_at FROM stock_doc_item WHERE doc_id=$1 AND product_id=$2`, [inv.id, ctx.milk])).rows[0]);
  ok(Number(snap.qty_book) === 5 && snap.book_at, 'Учётный остаток зафиксирован на момент первого сканирования: 5 шт (находка UMAG)');

  // магазин продолжает торговать: продали 2 шт прямо во время пересчёта
  await tx(async (c) => c.query(`SELECT apply_stock_move($1,$2,$3,-2,NULL,'sale',NULL,NULL)`, [accountId, ctx.wh1, ctx.milk]));
  const nowQty = (await svc.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh1 }))[0].qty;
  ok(nowQty === 3, 'Во время пересчёта продали 2 шт — остаток стал 3');
  const snap2 = await tx(async (c) => (await c.query(`SELECT qty_book FROM stock_doc_item WHERE doc_id=$1 AND product_id=$2`, [inv.id, ctx.milk])).rows[0]);
  ok(Number(snap2.qty_book) === 5, '★ Снимок остатка не поехал: как было 5 на момент скана, так и осталось — продажи не портят пересчёт');

  await svc.addItem(accountId, inv.id, { productId: ctx.cig, qty: 47 });   // было 45 — излишек
  const added = await svc.addMissingAsZero(accountId, inv.id);
  ok(added.added >= 1, `Массовое обнуление: не найденные на полке товары добавлены с нулём (${added.added} шт) — модель UMAG`);

  const rep = await svc.inventoryReport(accountId, inv.id);
  const milkRow = rep.items.find((i) => i.product_id === ctx.milk);
  ok(Number(milkRow.book) === 5 && Number(milkRow.fact) === 4 && Number(milkRow.diff) === -1,
     'Отчёт: по молоку учёт 5, факт 4, недостача 1');
  ok(rep.shortageCount >= 1 && rep.surplusCount === 1, `Недостача по ${rep.shortageCount} позициям, излишек по ${rep.surplusCount}`);
  ok(rep.shortageSum > 0, `Сумма недостачи ${rep.shortageSum} ₸ = разница × себестоимость (модель UMAG)`);

  const invR = await svc.process(accountId, inv.id);
  ok(invR.ok && invR.shortage >= 1 && invR.surplus === 1, 'Инвентаризация проведена: недостачи списаны, излишки оприходованы');
  const afterInv = (await svc.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh1 }))[0];
  // факт 4 при снимке 5 → разница −1; текущий остаток был 3 → 3 − 1 = 2
  ok(afterInv.qty === 2, `Остаток скорректирован на разницу от снимка, а не затёрт фактом: ${afterInv.qty} (продажа во время пересчёта учтена)`);
  const cigAfter = (await svc.balance(accountId, { productId: ctx.cig, warehouseId: ctx.wh1 }))[0];
  ok(cigAfter.qty === 47, 'Излишек сигарет оприходован: 47 пачек');

  // ================= ОБЪЕДИНЕНИЕ ЧЕРНОВИКОВ (UMAG) =================
  const d1 = await svc.createDoc(accountId, { kind: 'inventory', warehouseId: ctx.wh1, employeeId: ownerId, comment: 'Зал' });
  const d2 = await svc.createDoc(accountId, { kind: 'inventory', warehouseId: ctx.wh1, employeeId: ownerId, comment: 'Подсобка' });
  await svc.addItem(accountId, d1.id, { productId: ctx.milk, qty: 1 });
  await svc.addItem(accountId, d2.id, { productId: ctx.milk, qty: 1 });
  await svc.addItem(accountId, d2.id, { productId: ctx.cig, qty: 47 });
  const merged = await svc.mergeDrafts(accountId, [d1.id, d2.id]);
  ok(merged.merged.length === 1, 'Черновики объединены (считали по зонам разными устройствами — модель UMAG)');
  const mergedItems = await tx(async (c) => (await c.query(`SELECT product_id, qty FROM stock_doc_item WHERE doc_id=$1`, [merged.docId])).rows);
  ok(mergedItems.find((i) => i.product_id === ctx.milk).qty == 2, 'Одинаковые товары из разных черновиков суммировались');
  ok(mergedItems.length === 2, 'В объединённом документе обе позиции');
  const gone = await tx(async (c) => (await c.query(`SELECT status FROM stock_doc WHERE id=$1`, [d2.id])).rows[0]);
  ok(gone.status === 'deleted', 'Присоединённый черновик закрыт');

  // ================= ЧЕРНОВИКИ: УДАЛЕНИЕ И ВОССТАНОВЛЕНИЕ (UMAG) =================
  const tmp = await svc.createDoc(accountId, { kind: 'write_off', warehouseId: ctx.wh1 });
  await svc.deleteDoc(accountId, tmp.id);
  const del = await tx(async (c) => (await c.query(`SELECT status FROM stock_doc WHERE id=$1`, [tmp.id])).rows[0]);
  ok(del.status === 'deleted', 'Черновик удалён');
  await svc.restoreDoc(accountId, tmp.id);
  const rest = await tx(async (c) => (await c.query(`SELECT status FROM stock_doc WHERE id=$1`, [tmp.id])).rows[0]);
  ok(rest.status === 'draft', 'Удалённый черновик восстановлен — вернулся в черновик (модель UMAG)');
  let cantDelete = false;
  try { await svc.deleteDoc(accountId, doc.id); } catch { cantDelete = true; }
  ok(cantDelete, 'Проведённый документ удалить нельзя — только сторно');

  // ================= ОСТАТОК ПЕРЕСЧИТЫВАЕТСЯ ИЗ ДВИЖЕНИЙ =================
  await tx(async (c) => c.query(`UPDATE stock_balance SET qty = 999 WHERE warehouse_id=$1 AND product_id=$2`, [ctx.wh1, ctx.milk]));
  const fixed = await db.raw(`SELECT recalc_stock($1,$2) AS n`, [accountId, ctx.wh1]);
  const restored = (await svc.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh1 }))[0];
  ok(restored.qty === 2, 'Остаток пересобран из движений: испорченное значение исправлено (у МС на этот случай статья «Если остатки считаются неверно»)');

  // ================= ИЗОЛЯЦИЯ =================
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  const foreign = await svc.balance(acc2.account_id, {});
  ok(foreign.length === 0, 'Чужой аккаунт не видит наши остатки');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
