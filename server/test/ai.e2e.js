/**
 * ЧАСТЬ 13 — ИИ-ФИЧИ (killer).
 * Ответ на жалобу клиентов UMAG «технические трудности при внесении позиций».
 * Развитие автоприёмки Wipon, у которой «в офлайн-режиме недоступна».
 */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { AiService, MockAiProvider, parseSpokenPrice } = require('../dist/ai/ai.service');
  const { DocumentService, MockEsfProvider } = require('../dist/documents/document.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const { PosService } = require('../dist/pos/pos.service');
  const { ContragentService } = require('../dist/contragents/contragent.service');

  const db = new DbService();
  const goods = new GoodsService(db);
  const svc = new AiService(db);
  const docs = new DocumentService(db);
  const pos = new PosService(db, goods);
  const stock = new StockService(db, new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 }), goods);
  const cps = new ContragentService(db);
  const ai = new MockAiProvider();
  svc.setProvider(ai);
  docs.registerProvider('is_esf', new MockEsfProvider());

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Магазин ИИ','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  const ctx = await tx(async (c) => {
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    return { wh, store, reg };
  });

  // ============ 13.1 ★ КАРТОЧКА ПО ФОТО ============
  const photo = await svc.productFromPhoto(accountId, { imageRef: 'photo://label1.jpg', employeeId: ownerId });
  ok(photo.status === 'done' && photo.result.name === 'Молоко Айран 1л',
     `★ Фото этикетки → карточка: «${photo.result.name}», ${photo.result.price} ₸, штрихкод ${photo.result.barcode}. Вместо семи полей — одна фотография`);
  ok(photo.confidence > 0.9 && photo.needsReview,
     `Уверенность ${photo.confidence}, но подтверждение всё равно обязательно`);
  ok(/сохраняем только после вашего подтверждения/.test(photo.hint), `«${photo.hint}»`);

  // ★ ничего в базе до подтверждения
  const before = await tx(async (c) => Number((await c.query(`SELECT count(*) n FROM product`)).rows[0].n));
  ok(before === 0, '★ В базе пусто: распознали, но не записали. Модель ошибается, а неверная цена — это деньги владельца');

  const conf = await svc.confirmProduct(accountId, { taskId: photo.taskId, employeeId: ownerId });
  ok(conf.created && conf.name === 'Молоко Айран 1л' && conf.price === 480, `После подтверждения товар создан: «${conf.name}»`);
  const created = await tx(async (c) => (await c.query(
    `SELECT p.name, b.code, pp.value FROM product p
       LEFT JOIN barcode b ON b.product_id=p.id LEFT JOIN product_price pp ON pp.product_id=p.id
      WHERE p.id=$1`, [conf.productId])).rows[0]);
  ok(created.code === '4870000000017' && Number(created.value) === 480, 'Штрихкод и цена записаны');

  const twice = await svc.confirmProduct(accountId, { taskId: photo.taskId, employeeId: ownerId });
  ok(!twice.created && /Уже подтверждено/.test(twice.reason), 'Повторное подтверждение не задваивает товар');

  // ★ человек правит распознанное
  ai.labelResult = { name: 'Кефир 2,5%', barcode: '4870000000024', price: 390, unit: 'шт' };
  const photo2 = await svc.productFromPhoto(accountId, { imageRef: 'photo://label2.jpg', employeeId: ownerId });
  const fixed = await svc.confirmProduct(accountId, {
    taskId: photo2.taskId, employeeId: ownerId, overrides: { price: 420, category: 'Молочное' },
  });
  ok(fixed.created && fixed.price === 420,
     '★ Владелец поправил цену перед сохранением: 390 → 420. Модель предлагает, человек решает');
  const cat = await tx(async (c) => (await c.query(
    `SELECT c.name FROM product p JOIN category c ON c.id=p.category_id WHERE p.id=$1`, [fixed.productId])).rows[0]);
  ok(cat.name === 'Молочное', 'Категория создана из подтверждения');

  // штрихкод-дубль
  ai.labelResult = { name: 'Молоко другое', barcode: '4870000000017', price: 500 };
  const dupPhoto = await svc.productFromPhoto(accountId, { imageRef: 'photo://dup.jpg', employeeId: ownerId });
  let dupErr = false;
  try { await svc.confirmProduct(accountId, { taskId: dupPhoto.taskId, employeeId: ownerId }); }
  catch (e) { dupErr = /уже у товара «Молоко Айран 1л»/.test(e.message); }
  ok(dupErr, '★ Штрихкод уже у другого товара — не даём задвоить');

  // ★ низкая уверенность
  ai.lowConfidence = true;
  ai.labelResult = { name: 'Что-то неразборчивое', price: 100 };
  const blur = await svc.productFromPhoto(accountId, { imageRef: 'photo://blurry.jpg', employeeId: ownerId });
  ok(blur.lowConfidence && /проверьте каждое поле/.test(blur.hint),
     `★ Плохое фото: уверенность ${blur.confidence} → «${blur.hint}»`);
  await svc.rejectTask(accountId, blur.taskId, ownerId);
  ok((await svc.tasks(accountId, { status: 'rejected' })).length === 1, 'Мусор можно отклонить');
  ai.lowConfidence = false;

  // ============ ★ ГОЛОСОМ ============
  ok(parseSpokenPrice('двести восемьдесят тенге') === 280, '★ «двести восемьдесят тенге» → 280');
  ok(parseSpokenPrice('тысяча пятьсот тенге') === 1500, '«тысяча пятьсот» → 1500');
  ok(parseSpokenPrice('две тысячи триста тенге') === 2300, '«две тысячи триста» → 2300');
  ok(parseSpokenPrice('450 тенге') === 450, 'Цифрами тоже');
  ok(parseSpokenPrice('молоко вкусное') === undefined, 'Без цены — undefined, а не ноль');

  const voice = await svc.productFromVoice(accountId, {
    text: 'Молоко Айран литр двести восемьдесят тенге', employeeId: ownerId,
  });
  ok(voice.status === 'done' && voice.result.price === 280,
     `★ Голосом: «Молоко Айран литр двести восемьдесят тенге» → цена ${voice.result.price} ₸. Руки продавца заняты товаром, а не клавиатурой`);

  // ============ ★ ОФЛАЙН: ОЧЕРЕДЬ (у Wipon автоприёмка в офлайне недоступна) ============
  ai.failNext = 1;
  const offline = await svc.productFromPhoto(accountId, { imageRef: 'photo://offline.jpg', employeeId: ownerId });
  ok(offline.status === 'queued' && offline.retryable,
     '★ Связи нет — фото легло в очередь. У Wipon в этот момент автоприёмка просто недоступна');
  await tx(async (c) => c.query(`UPDATE ai_task SET next_try_at = now() - interval '1 minute' WHERE id=$1`, [offline.taskId]));
  const q = await svc.processQueue(accountId);
  ok(q.done === 1, '★ Связь появилась — очередь разобралась сама');

  // ============ 13.2 ★ ПРИЁМКА ИЗ ЭСФ В ОДИН КЛИК ============
  const sup = await cps.create(accountId, { name: 'ТОО Караван', kind: 'company', isSupplier: true, iinBin: '070740008064' });
  const esf = await tx(async (c) => {
    const d = (await c.query(
      `INSERT INTO gov_doc (account_id, kind, direction, status, number, counterparty_id, total_sum, vat_sum, gov_number)
       VALUES ($1,'esf','received','sent','500',$2,15000,1607.14,'ESF-2026-000500') RETURNING id`, [accountId, sup.id])).rows[0].id;
    await c.query(
      `INSERT INTO gov_doc_item (account_id, gov_doc_id, line_no, name, ntin, qty, price, total_wo_vat, vat_sum, total_with_vat)
       VALUES ($1,$2,1,'Молоко Айран 1л','04870000000017',20,300,5357.14,642.86,6000),
              ($1,$2,2,'Печенье овсяное','04870000000055',10,900,8035.71,964.29,9000)`, [accountId, d]);
    return d;
  });

  const fromEsf = await svc.receiveFromEsf(accountId, { govDocId: esf, warehouseId: ctx.wh, employeeId: ownerId });
  ok(fromEsf.created && fromEsf.matched === 1 && fromEsf.unmatched.length === 1,
     `★ Приёмка из ЭСФ одним кликом: ${fromEsf.matched} позиция сопоставлена, ${fromEsf.unmatched.length} нет в каталоге. Это точные данные госсистемы, а не распознавание`);
  ok(fromEsf.status === 'draft' && /Проверьте и проведите/.test(fromEsf.hint) === false,
     'Собран черновик, а не проведённый документ');
  ok(/нет в каталоге/.test(fromEsf.hint), `Подсказка: «${fromEsf.hint}»`);
  ok(fromEsf.unmatched[0].name === 'Печенье овсяное', 'Видно, чего не хватает');

  const esfTwice = await svc.receiveFromEsf(accountId, { govDocId: esf, warehouseId: ctx.wh });
  ok(!esfTwice.created && /уже сделана/.test(esfTwice.reason), 'По тому же ЭСФ приёмка не задваивается');

  const item = await tx(async (c) => (await c.query(
    `SELECT i.qty, i.price, p.name FROM stock_doc_item i JOIN product p ON p.id=i.product_id WHERE i.doc_id=$1`, [fromEsf.docId])).rows[0]);
  ok(Number(item.qty) === 20 && Number(item.price) === 300 && item.name === 'Молоко Айран 1л',
     'Количество и цена подтянулись из ЭСФ: 20 шт по 300 ₸');

  // исходящий ЭСФ приёмкой не станет
  const outEsf = await tx(async (c) => (await c.query(
    `INSERT INTO gov_doc (account_id, kind, direction, status, number, counterparty_id, total_sum)
     VALUES ($1,'esf','issued','sent','501',$2,5000) RETURNING id`, [accountId, sup.id])).rows[0].id);
  let wrongDir = false;
  try { await svc.receiveFromEsf(accountId, { govDocId: outEsf, warehouseId: ctx.wh }); }
  catch (e) { wrongDir = /выписан нами/.test(e.message); }
  ok(wrongDir, 'Из нашего же исходящего ЭСФ приёмку не собрать');

  // ============ ★ ФОТО НАКЛАДНОЙ → ЧЕРНОВИК ============
  const invTask = await svc.invoiceFromPhoto(accountId, { imageRef: 'photo://invoice.jpg', employeeId: ownerId });
  ok(invTask.status === 'done' && invTask.result.items.length === 2,
     `★ Фото накладной распознано: поставщик «${invTask.result.supplier}», ${invTask.result.items.length} позиции`);

  const fromInv = await svc.receiveFromInvoicePhoto(accountId, {
    taskId: invTask.taskId, warehouseId: ctx.wh, employeeId: ownerId,
  });
  ok(fromInv.created && fromInv.supplierFound && fromInv.supplier === 'ТОО Караван',
     '★ Поставщик найден по БИН из накладной');
  ok(fromInv.matched === 1 && fromInv.unmatched.length === 1, `Сопоставлено ${fromInv.matched}, не найдено ${fromInv.unmatched.length}`);
  ok(fromInv.status === 'draft' && /сверьте с бумагой/.test(fromInv.hint),
     `★ Черновик с честной подсказкой: «${fromInv.hint}»`);

  // ============ 13.3 ★ ПОДСКАЗКИ ДОЗАКАЗА ============
  const prods = await tx(async (c) => {
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const out = {};
    for (const [k, name, min] of [['bread', 'Хлеб', 10], ['water', 'Вода', 5], ['rare', 'Икра', 2]]) {
      const id = (await c.query(
        `INSERT INTO product (account_id, name, kind, unit_id, purchase_price, min_stock, supplier_id)
         VALUES ($1,$2,'simple',$3,100,$4,$5) RETURNING id`, [accountId, name, sht, min, sup.id])).rows[0].id;
      await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,300)`, [accountId, id, rt]);
      out[k] = id;
    }
    return out;
  });

  const s2 = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId });
  await stock.addItem(accountId, s2.id, { productId: prods.bread, qty: 100, price: 100 });
  await stock.addItem(accountId, s2.id, { productId: prods.water, qty: 200, price: 50 });
  await stock.addItem(accountId, s2.id, { productId: prods.rare, qty: 1, price: 5000 });
  await stock.process(accountId, s2.id);

  // хлеб продаётся бодро: 90 штук за период
  const sh = await pos.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ownerId, openingFloat: 1000 });
  for (let i = 0; i < 9; i++) {
    const s = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
    const cart = await pos.addToCart(accountId, s.id, { productId: prods.bread, qty: 10 });
    await pos.pay(accountId, s.id, [{ method: 'cash', amount: Number(cart.total), received: Number(cart.total) }]);
  }

  const adv = await svc.restockAdvice(accountId, 30);
  const bread = adv.items.find((i) => i.name === 'Хлеб');
  ok(bread && bread.soldQty === 90 && near(bread.perDay, 3),
     `★ ИИ видит скорость продаж: хлеба продано ${bread.soldQty} за 30 дней = ${bread.perDay} в день. План из Части 3 знает только минимальный остаток`);
  ok(near(bread.daysLeft, 3.3), `★ Осталось ${bread.stock} — это ${bread.daysLeft} дня. Формула по минимуму этого не увидит`);
  // 3,3 дня запаса — это «скоро» (порог critical: 2 дня и меньше)
  ok(bread.urgency === 'soon' && bread.suggestQty > 0,
     `Срочность «${bread.urgency}» — на 3,3 дня хватит; предложено взять ${bread.suggestQty} (запас на две недели)`);
  ok(/кончится через 3.3 дн. \(3 в день\). Взять/.test(bread.advice),
     `★ Человеческая формулировка: «${bread.advice}»`);

  const rare = adv.items.find((i) => i.name === 'Икра');
  ok(rare && rare.urgency === 'below_min', `Икра не продаётся, но ниже минимума: «${rare.urgency}»`);
  ok(!adv.items.some((i) => i.name === 'Вода'), 'Вода не в списке: её много и продаётся мало');

  // товары, заведённые по фото, лежат с нулевым остатком — они тоже в списке
  ok(adv.bySupplier.some((s) => s.supplier === 'ТОО Караван') && adv.bySupplier.length === 2,
     `★ Сгруппировано по поставщикам (${adv.bySupplier.map((s) => s.supplier).join(', ')}) — заказ собирают им, а не по товарам`);
  ok(adv.summary.out === 2 && adv.summary.soon === 1 && adv.summary.total === 4,
     `Сводка: ${JSON.stringify(adv.summary)} — молоко и кефир заведены по фото и ещё не приняты`);
  ok(adv.urgent.length === 2 && adv.urgent.every((u) => ['out', 'critical'].includes(u.urgency)),
     'Срочное вынесено отдельно: то, чего нет совсем, и то, что кончается за два дня');

  // товар кончился совсем
  const s3 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  const c3 = await pos.addToCart(accountId, s3.id, { productId: prods.bread, qty: 10 });
  await pos.pay(accountId, s3.id, [{ method: 'cash', amount: Number(c3.total), received: Number(c3.total) }]);
  const adv2 = await svc.restockAdvice(accountId, 30);
  const bread2 = adv2.items.find((i) => i.name === 'Хлеб');
  ok(bread2.urgency === 'out' && /закончился/.test(bread2.advice),
     `★ «${bread2.advice}» — и это первое, что видит владелец`);

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  ok((await svc.tasks(acc2.account_id)).length === 0, 'Чужой аккаунт не видит наши распознавания');
  ok((await svc.restockAdvice(acc2.account_id)).items.length === 0, 'И не видит наши остатки');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
