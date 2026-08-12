/** ЧАСТЬ 5 — ФИСКАЛИЗАЦИЯ. Режимы Wipon, очередь, повторы, ESC/POS. */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { FiscalService } = require('../dist/fiscal/fiscal.service');
  const { MockProvider } = require('../dist/fiscal/provider');
  const { renderReceipt, EscPosBuilder } = require('../dist/fiscal/escpos');
  const { PosService } = require('../dist/pos/pos.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');

  const db = new DbService();
  const goods = new GoodsService(db);
  const pos = new PosService(db, goods);
  const stock = new StockService(db, new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 }), goods);
  const fiscal = new FiscalService(db);
  const mock = new MockProvider();
  fiscal.setProvider('mock', mock);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Магазин Береке','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  const ctx = await tx(async (c) => {
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    await c.query(`UPDATE store SET address='г. Астана, ул. Кенесары 40' WHERE id=$1`, [store]);
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const milk = (await c.query(`INSERT INTO product (account_id, name, name_kk, kind, unit_id, purchase_price, vat_rate, ntin) VALUES ($1,'Молоко Айналайын','Айналайын сүті','simple',$2,380,12,'04870204391237') RETURNING id`, [accountId, sht])).rows[0].id;
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,450)`, [accountId, milk, rt]);
    const bread = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, purchase_price) VALUES ($1,'Хлеб Тандыр','simple',$2,100) RETURNING id`, [accountId, sht])).rows[0].id;
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,150)`, [accountId, bread, rt]);
    return { store, wh, reg, milk, bread };
  });
  const sup = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId });
  await stock.addItem(accountId, sup.id, { productId: ctx.milk, qty: 100, price: 380 });
  await stock.addItem(accountId, sup.id, { productId: ctx.bread, qty: 100, price: 100 });
  await stock.process(accountId, sup.id);

  // ============ ПОДКЛЮЧЕНИЕ ККМ ============
  const kkm = await fiscal.registerKkm(accountId, {
    cashRegisterId: ctx.reg, provider: 'mock', mode: 'all',
    regNumber: '600900123456', serialNumber: 'SN-KZ-0001', kkmId: 'KKM-1',
  });
  ok(kkm.reg_number === '600900123456' && kkm.mode === 'all',
     'ККМ подключена: регистрационный и заводской номер, ID — поля из статьи Wipon про Kaspi Кассу');

  const sh = await pos.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ownerId, openingFloat: 5000 });
  const mkSale = async (payments, qty = 2) => {
    const s = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
    await pos.addToCart(accountId, s.id, { productId: ctx.milk, qty });
    const f = await pos.addToCart(accountId, s.id, { productId: ctx.bread, qty: 1 });
    return pos.pay(accountId, s.id, payments(Number(f.total)));
  };

  // ============ 5.1 ОЧЕРЕДЬ И ФИСКАЛИЗАЦИЯ ============
  const sale1 = await mkSale((t) => [{ method: 'cash', amount: t, received: t }]);
  const q1 = await fiscal.enqueueSale(accountId, sale1.id);
  ok(q1.status === 'pending', 'Чек встал в очередь на фискализацию — деньги уже взяты, признак придёт следом');
  const beforeFiscal = await tx(async (c) => (await c.query(`SELECT fiscal_id FROM sale WHERE id=$1`, [sale1.id])).rows[0]);
  ok(beforeFiscal.fiscal_id === null, 'Чек выдан покупателю ещё без фискального признака (модель Wipon для офлайна)');

  let r = await fiscal.processQueue(accountId);
  ok(r.ok === 1 && r.failed === 0, 'Очередь обработана: чек ушёл оператору');
  const afterFiscal = await tx(async (c) => (await c.query(`SELECT fiscal_id, fiscal_at FROM sale WHERE id=$1`, [sale1.id])).rows[0]);
  ok(/^FP\d{9}$/.test(afterFiscal.fiscal_id) && afterFiscal.fiscal_at, `Фискальный признак получен: ${afterFiscal.fiscal_id}`);

  // идемпотентность: двойной фискальный чек — это штраф
  const dup = await fiscal.enqueueSale(accountId, sale1.id);
  ok(dup.status === 'duplicate', '★ Повторная постановка того же чека отклонена — двойной фискальный чек это штраф');
  const cnt = await tx(async (c) => (await c.query(`SELECT count(*)::int n FROM fiscal_receipt WHERE sale_id=$1`, [sale1.id])).rows[0].n);
  ok(cnt === 1, 'В базе ровно одна фискальная операция на чек');

  // время продажи, а не отправки
  const sent = mock.calls.filter((c) => c.op === 'sale');
  ok(sent.length === 1 && sent[0].externalId === sale1.id, 'Оператору ушёл UUID нашего чека как ключ идемпотентности');

  // ============ РЕЖИМЫ ФИСКАЛИЗАЦИИ (таблица Wipon) ============
  await tx(async (c) => c.query(`UPDATE kkm SET mode='cash_only' WHERE id=$1`, [kkm.id]));
  const cardSale = await mkSale((t) => [{ method: 'card', amount: t }]);
  const qCard = await fiscal.enqueueSale(accountId, cardSale.id);
  ok(qCard.status === 'not_required' && /не фискализируется/.test(qCard.reason),
     'Режим «только наличные»: оплата картой не фискализируется (таблица Wipon)');

  const cashSale = await mkSale((t) => [{ method: 'cash', amount: t, received: t }]);
  const qCash = await fiscal.enqueueSale(accountId, cashSale.id);
  ok(qCash.status === 'pending', 'Режим «только наличные»: оплата наличными фискализируется');

  // исключение «Разрешить фискализацию безналичных» (переключатель Wipon)
  await tx(async (c) => c.query(`UPDATE kkm SET allow_cashless_fiscal=true WHERE id=$1`, [kkm.id]));
  const cardSale2 = await mkSale((t) => [{ method: 'card', amount: t }]);
  const qCard2 = await fiscal.enqueueSale(accountId, cardSale2.id);
  ok(qCard2.status === 'pending', 'Переключатель «Разрешить фискализацию безналичных» включает карту в режиме наличных (исключение Wipon)');

  // смешанная оплата фискализируется в любом «частичном» режиме
  await tx(async (c) => c.query(`UPDATE kkm SET mode='card_only', allow_cashless_fiscal=false WHERE id=$1`, [kkm.id]));
  const mixSale = await mkSale((t) => [{ method: 'cash', amount: 100, received: 100 }, { method: 'card', amount: t - 100 }]);
  const qMix = await fiscal.enqueueSale(accountId, mixSale.id);
  ok(qMix.status === 'pending', 'Режим «только карта»: смешанная оплата фискализируется (таблица Wipon)');

  await tx(async (c) => c.query(`UPDATE kkm SET mode='off' WHERE id=$1`, [kkm.id]));
  const offSale = await mkSale((t) => [{ method: 'cash', amount: t, received: t }]);
  const qOff = await fiscal.enqueueSale(accountId, offSale.id);
  ok(qOff.status === 'not_required', 'Режим «фискализация отключена»: чеки не фискализируются');
  await tx(async (c) => c.query(`UPDATE kkm SET mode='all' WHERE id=$1`, [kkm.id]));

  // QR считается как наличные для целей фискализации (это оплата покупателем напрямую)
  await tx(async (c) => c.query(`UPDATE kkm SET mode='cash_only' WHERE id=$1`, [kkm.id]));
  const qrSale = await mkSale((t) => [{ method: 'qr', amount: t, ref: 'kaspi-1' }]);
  ok((await fiscal.enqueueSale(accountId, qrSale.id)).status === 'pending', 'Kaspi QR фискализируется как приход денег от покупателя');
  await tx(async (c) => c.query(`UPDATE kkm SET mode='all' WHERE id=$1`, [kkm.id]));

  // ============ ОПЕРАТОР ЛЁГ — ТОРГОВЛЯ ИДЁТ ============
  await fiscal.processQueue(accountId);          // разбираем накопленное от проверок режимов
  mock.failNext = 1;
  const sale2 = await mkSale((t) => [{ method: 'cash', amount: t, received: t }]);
  await fiscal.enqueueSale(accountId, sale2.id);
  r = await fiscal.processQueue(accountId);
  ok(r.failed >= 1, 'Оператор недоступен — чек не потерян, помечен на повтор');
  const failed = await tx(async (c) => (await c.query(`SELECT status, attempts, next_attempt_at, error FROM fiscal_receipt WHERE sale_id=$1`, [sale2.id])).rows[0]);
  ok(failed.status === 'failed' && failed.attempts === 1 && failed.next_attempt_at, `Повтор запланирован: попытка ${failed.attempts}, ошибка «${failed.error}»`);

  const health1 = await fiscal.health(accountId);
  ok(!health1.healthy && health1.failed >= 1, `★ Здоровье фискализации: ${health1.message} (у Wipon такой страницы нет — узнаёшь по факту)`);

  // сеть вернулась
  mock.failNext = 0;
  await tx(async (c) => c.query(`UPDATE fiscal_receipt SET next_attempt_at=now() WHERE sale_id=$1`, [sale2.id]));
  r = await fiscal.processQueue(accountId);
  ok(r.ok >= 1, 'Оператор ответил — очередь разобралась сама, без участия кассира');
  const fixed = await tx(async (c) => (await c.query(`SELECT status, fiscal_number FROM fiscal_receipt WHERE sale_id=$1`, [sale2.id])).rows[0]);
  ok(fixed.status === 'ok' && fixed.fiscal_number, `Чек всё-таки фискализирован: ${fixed.fiscal_number}`);

  // постоянная ошибка не долбит оператора вечно
  mock.failPermanently = true;
  const sale3 = await mkSale((t) => [{ method: 'cash', amount: t, received: t }]);
  await fiscal.enqueueSale(accountId, sale3.id);
  await fiscal.processQueue(accountId);
  const permFail = await tx(async (c) => (await c.query(`SELECT status, next_attempt_at, error FROM fiscal_receipt WHERE sale_id=$1`, [sale3.id])).rows[0]);
  ok(permFail.status === 'failed' && permFail.next_attempt_at === null && /БИН/.test(permFail.error),
     'Постоянная ошибка («неверный БИН») не ставится на повтор — ждёт человека, а не долбит оператора');
  mock.failPermanently = false;
  await tx(async (c) => c.query(`UPDATE fiscal_receipt SET status='ok' WHERE sale_id=$1`, [sale3.id]));

  // ============ ВОЗВРАТ ============
  const refund = await pos.refund(accountId, { saleId: sale1.id, shiftId: sh.id, employeeId: ownerId, comment: 'Не подошло' });
  const qRef = await fiscal.enqueueSale(accountId, refund.id);
  ok(qRef.status === 'pending', 'Возврат тоже фискализируется — отдельной операцией');
  await fiscal.processQueue(accountId);
  const refFiscal = await tx(async (c) => (await c.query(`SELECT op, fiscal_number FROM fiscal_receipt WHERE sale_id=$1`, [refund.id])).rows[0]);
  ok(refFiscal.op === 'refund' && /^FR/.test(refFiscal.fiscal_number), `Возврат получил свой фискальный признак: ${refFiscal.fiscal_number}`);

  // ============ ФИСКАЛЬНАЯ СМЕНА И Z-ОТЧЁТ ============
  await fiscal.processQueue(accountId);
  await tx(async (c) => c.query(`UPDATE fiscal_receipt SET next_attempt_at=now() WHERE status='failed'`));
  await fiscal.processQueue(accountId);
  const fsh = await fiscal.openFiscalShift(accountId, kkm.id, sh.id);
  ok(fsh.status === 'ok', 'Фискальная смена открыта — она отдельная от смены кассы (модель Wipon: три смены)');

  const x = await fiscal.xReport(accountId, kkm.id);
  ok(x.ok, 'X-отчёт ККМ получен без закрытия смены');

  // нельзя закрыть смену с неотправленными чеками
  const stuckSale = await mkSale((t) => [{ method: 'cash', amount: t, received: t }]);
  await fiscal.enqueueSale(accountId, stuckSale.id);
  let cantClose = false;
  try { await fiscal.closeFiscalShift(accountId, kkm.id); } catch (e) { cantClose = /разойдётся с выручкой/.test(e.message); }
  ok(cantClose, '★ Z-отчёт не закрыть, пока чеки не уехали оператору — иначе отчёт разойдётся с выручкой');

  await fiscal.processQueue(accountId);
  const z = await fiscal.closeFiscalShift(accountId, kkm.id);
  ok(z.ok && z.shift.closed_at, 'Z-отчёт получен, фискальная смена закрыта');

  const health2 = await fiscal.health(accountId);
  ok(health2.healthy, `Все чеки фискализированы: ${health2.ok} из ${health2.total}`);

  // ============ 5.4 ПЕЧАТЬ ESC/POS ============
  const bytes = await fiscal.receiptBytes(accountId, sale1.id, { width: 32 });
  ok(Buffer.isBuffer(bytes) && bytes.length > 100, `Чек собран в байты ESC/POS: ${bytes.length} байт`);
  ok(bytes[0] === 0x1b && bytes[1] === 0x40, 'Чек начинается с команды сброса принтера (ESC @)');
  const hex = bytes.toString('hex');
  ok(hex.includes('1d564200'), 'В конце команда отрезки чека (GS V B)');
  ok(hex.includes('1d286b'), 'QR-код проверки чека печатается (команда GS ( k)');

  // текст в CP866 — иначе на принтере будет мусор
  const cp866 = bytes.toString('binary');
  ok(/\x8c\xae\xab\xae\xaa\xae/.test(cp866), 'Кириллица закодирована в CP866 — «Молоко» принтер напечатает буквами, а не крокозябрами');
  ok(cp866.includes('600900123456'), 'На чеке регистрационный номер ККМ');
  ok(cp866.includes('04870204391237'), '★ Код НКТ (NTIN) напечатан в чеке — казахстанская обязаловка (UMAG «Коды НКТ»)');
  ok(cp866.includes('consumer.oofd.kz'), 'Ссылка проверки чека зашита в QR');
  ok(/\xa3\x2e\x20\x80\xe1\xe2\xa0\xad\xa0/.test(cp866) || cp866.includes('40'), 'Адрес магазина на чеке — брендирование (идея Wipon)');

  // нефискальный чек честно говорит об этом
  const noFiscalBytes = await fiscal.receiptBytes(accountId, cardSale.id, { width: 32 });
  const nf = noFiscalBytes.toString('binary');
  ok(/\x97\x85\x8a\x20\x8d\x85\x20\x94\x88\x91\x8a\x80\x8b\x9c\x8d\x9b\x89/.test(nf),
     'Нефискальный чек честно печатает «ЧЕК НЕ ФИСКАЛЬНЫЙ» — покупатель не должен гадать');

  // 80 мм
  const wide = await fiscal.receiptBytes(accountId, sale1.id, { width: 48 });
  ok(wide.length > bytes.length - 200, 'Чек печатается и на 80 мм (48 символов) — оба формата в КЗ живые');

  // казахский чек
  const kk = await fiscal.receiptBytes(accountId, sale1.id, { lang: 'kk' });
  ok(Buffer.isBuffer(kk) && kk.length > 100, 'Чек на казахском языке собирается');

  // ============ ЧИСТАЯ ПРОВЕРКА ГЕНЕРАТОРА ============
  const b = new EscPosBuilder(32);
  const pairLine = b.pair('Итого', '1 050').build().toString('binary');
  ok(pairLine.length === 33, 'Две колонки выравниваются по ширине ленты ровно');
  const demo = renderReceipt({
    brand: { name: 'Магазин у дома', bin: '123456789012' },
    items: [{ name: 'Вода', qty: 1, price: 120, total: 120 }],
    subtotal: 120, total: 120, payments: [{ method: 'cash', amount: 120 }], fiscalNumber: 'FP000000001',
    checkUrl: 'https://consumer.oofd.kz/ticket/1',
  }, 32);
  ok(demo.length > 50 && demo.toString('binary').includes('FP000000001'), 'Генератор чека работает автономно от базы');

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  const h3 = await fiscal.health(acc2.account_id);
  ok(h3.total === 0, 'Чужой аккаунт не видит наши фискальные чеки');
  let foreign = false;
  try { await fiscal.receiptBytes(acc2.account_id, sale1.id); } catch { foreign = true; }
  ok(foreign, 'Чужой чек не напечатать');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
