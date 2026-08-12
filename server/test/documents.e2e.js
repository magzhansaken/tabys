/**
 * ЧАСТЬ 9 — ДОКУМЕНТЫ КАЗАХСТАНА.
 * Эталон один — Wipon (у UMAG документов КЗ нет, у МС конструктор и маркировка РФ).
 * Главное отличие: ЭСФ выписывается ИЗ документа, а не набивается руками.
 */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { DocumentService, MockEsfProvider, amountInWords } = require('../dist/documents/document.service');
  const { PosService } = require('../dist/pos/pos.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const { ContragentService } = require('../dist/contragents/contragent.service');

  const db = new DbService();
  const goods = new GoodsService(db);
  const svc = new DocumentService(db);
  const pos = new PosService(db, goods);
  const stock = new StockService(db, new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 }), goods);
  const cp = new ContragentService(db);
  const mock = new MockEsfProvider();
  svc.registerProvider('is_esf', mock);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Магазин Документы','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  // реквизиты организации — без них печатных форм не бывает
  await tx(async (c) => c.query(
    `INSERT INTO organization (account_id, type, name, short_name, tin, director_name, accountant_name,
                               address, phone, bank_name, bank_bic, bank_account, stamp_url, signature_url, is_default)
     VALUES ($1,'ip','ИП «Айгуль»','ИП Айгуль','950101300123','Айгуль Сериковна','Айгуль Сериковна',
             'г. Астана, ул. Кабанбай батыра 15','+77012223344','АО «Kaspi Bank»','CASPKZKA',
             'KZ12345678901234567','/stamp.png','/sign.png',true)`, [accountId]));

  const ctx = await tx(async (c) => {
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const g = {};
    for (const [k, name, price, cost, ntin, marked] of [
      ['milk', 'Молоко', 500, 300, '04870000000017', 'none'],
      ['cig', 'Сигареты', 750, 600, '04870000000024', 'tobacco'],   // маркированный: вид группы из Части 2
      ['nokod', 'Товар без НКТ', 200, 100, null, 'none'],
    ]) {
      const id = (await c.query(
        `INSERT INTO product (account_id, name, kind, unit_id, purchase_price, ntin, marking, vat_rate)
         VALUES ($1,$2,'simple',$3,$4,$5,$6::marking_kind,12) RETURNING id`, [accountId, name, sht, cost, ntin, marked])).rows[0].id;
      await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,$4)`, [accountId, id, rt, price]);
      g[k] = id;
    }
    return { store, wh, reg, ...g };
  });

  // ============ ЭЦП ============
  let noKey = false;
  const supplier = await cp.create(accountId, { name: 'ТОО Караван', kind: 'company', isSupplier: true, iinBin: '070740008064' });
  const sup = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId, supplierId: supplier.id });
  await stock.addItem(accountId, sup.id, { productId: ctx.milk, qty: 100, price: 300 });
  await stock.addItem(accountId, sup.id, { productId: ctx.cig, qty: 200, price: 600 });
  await stock.process(accountId, sup.id);

  const esfSupply = await svc.esfFromSupply(accountId, sup.id, ownerId);
  try { await svc.sendDoc(accountId, esfSupply.id); } catch (e) { noKey = /ключ ЭЦП/.test(e.message); }
  ok(noKey, 'Без ключа ЭЦП документ не отправить — система прямо говорит, чего не хватает');

  const key = await svc.addKey(accountId, {
    name: 'ЭЦП ИП Айгуль', keyData: Buffer.from('fake-p12-key-content'), subjectBin: '950101300123',
    subjectName: 'Айгуль Сериковна', esfLogin: 'aigul', esfPassword: 'portal-pass',
    validUntil: new Date(Date.now() + 200 * 86400000).toISOString(),
  });
  ok(key.id && !key.store_password, 'Ключ ЭЦП добавлен, пароль от него не сохранён — владелец вводит при отправке');
  ok(!key.warning, 'Предупреждения нет: пароль не хранится');

  const key2 = await svc.addKey(accountId, {
    name: 'Ключ с паролем', keyData: Buffer.from('x'), keyPassword: '123', storePassword: true,
    validUntil: new Date(Date.now() + 400 * 86400000).toISOString(),
  });
  ok(/безопаснее вводить его при каждой отправке/.test(key2.warning),
     '★ Если владелец просит запомнить пароль от ЭЦП — честно предупреждаем, что это его риск');
  await tx(async (c) => c.query(`UPDATE gov_key SET is_active=false WHERE id=$1`, [key2.id]));

  // срок ключа
  const health = await svc.keyHealth(accountId);
  ok(health[0].status === 'ok' && health[0].daysLeft > 100, `Ключ действует ещё ${health[0].daysLeft} дн.`);
  await tx(async (c) => c.query(`UPDATE gov_key SET valid_until = now() + interval '10 days' WHERE id=$1`, [key.id]));
  const h2 = await svc.keyHealth(accountId);
  ok(h2[0].status === 'expiring' && /обновите заранее/.test(h2[0].message),
     `★ За 30 дней предупреждаем: «${h2[0].message}». Просроченный ЭЦП — это невыписанный ЭСФ, а срок выписки ограничен`);
  await tx(async (c) => c.query(`UPDATE gov_key SET valid_until = now() - interval '1 day' WHERE id=$1`, [key.id]));
  const h3 = await svc.keyHealth(accountId);
  ok(h3[0].status === 'expired' && /не уйдут в налоговую/.test(h3[0].message), 'Просроченный ключ виден сразу');
  const expired = await svc.sendDoc(accountId, esfSupply.id);
  ok(!expired.sent && /просрочен/.test(expired.reason), 'С просроченным ключом отправка не идёт');
  await tx(async (c) => c.query(`UPDATE gov_key SET valid_until = now() + interval '200 days' WHERE id=$1`, [key.id]));

  // ============ 9.1 ★ ЭСФ ИЗ ДОКУМЕНТА ============
  ok(esfSupply.number === '1' && esfSupply.items === 2,
     `★ ЭСФ выписан ИЗ приёмки одним действием: №${esfSupply.number}, ${esfSupply.items} позиции (у Wipon — «заполнить все необходимые поля» руками)`);
  ok(near(esfSupply.total, 150000), `Сумма подтянулась из приёмки: ${esfSupply.total} ₸`);
  ok(near(esfSupply.vat, Math.round(150000 / 1.12 * 0.12 * 100) / 100),
     `★ НДС выделен обратным счётом из цены с НДС: ${esfSupply.vat} ₸ — так считают в РК`);
  ok(esfSupply.warnings.length === 0, 'У всех позиций есть НКТ — предупреждений нет');

  let dupEsf = false;
  try { await svc.esfFromSupply(accountId, sup.id); } catch (e) { dupEsf = /уже выписан/.test(e.message); }
  ok(dupEsf, 'Повторная выписка ЭСФ по той же приёмке запрещена — задвоенный ЭСФ это проблема с налоговой');

  // отправка в ОГД
  const sent = await svc.sendDoc(accountId, esfSupply.id);
  ok(sent.sent && /^ESF-/.test(sent.govNumber), `★ ЭСФ ушёл в ОГД, получен регистрационный номер ${sent.govNumber}`);
  const again = await svc.sendDoc(accountId, esfSupply.id);
  ok(!again.sent && /уже в ОГД/.test(again.reason), 'Повторная отправка не задваивает документ');

  // ЭСФ по продаже юрлицу
  const buyer = await cp.create(accountId, { name: 'ТОО Астана Строй', kind: 'company', iinBin: '123456789012' });
  const sh = await pos.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ownerId, openingFloat: 5000 });
  const s1 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId, customerId: buyer.id });
  const cart = await pos.addToCart(accountId, s1.id, { productId: ctx.milk, qty: 10 });
  const paid = await pos.pay(accountId, s1.id, [{ method: 'card', amount: Number(cart.total) }]);
  const esfSale = await svc.esfFromSale(accountId, paid.id, ownerId);
  ok(near(esfSale.total, 5000) && esfSale.items === 1, `★ ЭСФ по продаже юрлицу: ${esfSale.total} ₸ — покупатель и позиции уже в чеке`);

  // без БИН покупателя ЭСФ не выписать
  const noBin = await cp.create(accountId, { name: 'Физлицо Азамат' });
  const s2 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId, customerId: noBin.id });
  const c2 = await pos.addToCart(accountId, s2.id, { productId: ctx.milk, qty: 1 });
  const p2 = await pos.pay(accountId, s2.id, [{ method: 'cash', amount: Number(c2.total), received: 500 }]);
  let noBinErr = false;
  try { await svc.esfFromSale(accountId, p2.id); } catch (e) { noBinErr = /ИИН\/БИН/.test(e.message); }
  ok(noBinErr, 'Без ИИН/БИН покупателя ЭСФ не выписывается — портал его не примет');

  // ============ НКТ ОБЯЗАТЕЛЕН ============
  const sup2 = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId, supplierId: supplier.id });
  await stock.addItem(accountId, sup2.id, { productId: ctx.nokod, qty: 10, price: 100 });
  await stock.process(accountId, sup2.id);
  const esfNoNtin = await svc.esfFromSupply(accountId, sup2.id, ownerId);
  ok(esfNoNtin.warnings.length === 1 && /Без кода НКТ/.test(esfNoNtin.warnings[0]),
     `★ Предупреждение ДО отправки: «${esfNoNtin.warnings[0]}» — иначе портал отклонит, а владелец не поймёт почему`);
  const rejected = await svc.sendDoc(accountId, esfNoNtin.id);
  ok(!rejected.sent && /НКТ/.test(rejected.reason) && !rejected.retryable,
     'Портал отклонил из-за НКТ — повторять бесполезно, и мы это понимаем');

  // ============ ОЧЕРЕДЬ И ПОВТОРЫ ============
  const sup3 = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId, supplierId: supplier.id });
  await stock.addItem(accountId, sup3.id, { productId: ctx.milk, qty: 5, price: 300 });
  await stock.process(accountId, sup3.id);
  const esfQueue = await svc.esfFromSupply(accountId, sup3.id, ownerId);
  mock.failNext = 1;
  const failed = await svc.sendDoc(accountId, esfQueue.id);
  ok(!failed.sent && failed.retryable && /недоступен/.test(failed.reason),
     'Портал ИС ЭСФ лёг — документ остался в очереди, ошибка временная');
  await tx(async (c) => c.query(`UPDATE gov_doc SET next_try_at = now() - interval '1 minute' WHERE id=$1`, [esfQueue.id]));
  const q = await svc.processQueue(accountId);
  ok(q.sent === 1, '★ Портал ожил — документ уехал сам (та же механика, что в фискализации)');

  // ============ ОТЗЫВ ============
  let noReason = false;
  try { await svc.revokeDoc(accountId, esfSupply.id, ''); } catch (e) { noReason = /Причина/.test(e.message); }
  ok(noReason, 'Отзыв без причины не проходит');
  const rev = await svc.revokeDoc(accountId, esfSupply.id, 'Ошибка в сумме');
  ok(rev.revoked, 'ЭСФ отозван (действие «Отозвать» у Wipon)');
  let revTwice = false;
  try { await svc.revokeDoc(accountId, esfSupply.id, 'Ещё раз'); } catch (e) { revTwice = /только отправленный/.test(e.message); }
  ok(revTwice, 'Повторно отозвать нельзя');

  // ============ СПИСОК И ФИЛЬТРЫ (Wipon) ============
  const list = await svc.list(accountId, { kind: 'esf' });
  ok(list.length === 4, `Список ЭСФ: ${list.length} документов`);
  ok(list.some((d) => d.status === 'revoked') && list.some((d) => d.status === 'sent'), 'Видны статусы: отправлен, отозван');
  const byCp = await svc.list(accountId, { kind: 'esf', counterpartyId: buyer.id });
  ok(byCp.length === 1 && byCp[0].counterparty === 'ТОО Астана Строй', 'Фильтр по контрагенту (Wipon)');
  const byStatus = await svc.list(accountId, { kind: 'esf', status: 'rejected' });
  ok(byStatus.length === 1, 'Фильтр по статусу (Wipon)');

  // ============ 9.3 АВР ============
  const avr = await svc.createAvr(accountId, {
    counterpartyId: buyer.id, employeeId: ownerId,
    items: [{ name: 'Доставка товара', qty: 1, price: 5000 }],
  });
  ok(avr.number === '1' && near(avr.total, 5000), `АВР создан: №${avr.number} на ${avr.total} ₸`);

  // ============ 9.4 ДОВЕРЕННОСТЬ (модель Wipon) ============
  const poa = await svc.createPoa(accountId, {
    counterpartyId: supplier.id, employeeId: ownerId, warehouseId: ctx.wh,
    basis: 'Счёт №15 от 17.07.2026',
    items: [{ name: 'Молоко', qty: 100, unit: 'шт' }],
  });
  ok(poa.number === '1' && poa.employee === 'Айгуль', `Доверенность на ${poa.employee}: склад, сотрудник, поставщик, основание (поля Wipon)`);
  ok(/подписание контрагентом/.test(poa.note), 'Дальше — ожидание подписания (сценарий Wipon)');
  ok(poa.warnings.length === 2 && /не указан ИИН/.test(poa.warnings[0]),
     `★ Проверка нашла: доверенность М-2 требует ИИН и удостоверение личности — «${poa.warnings[0]}». Без них поставщик товар не отдаст`);

  await tx(async (c) => c.query(`UPDATE employee SET iin='950101300123', id_doc_number='№012345678', id_doc_issued_by='МВД РК', id_doc_issued_at='2020-05-15' WHERE id=$1`, [ownerId]));
  const poa2 = await svc.createPoa(accountId, {
    counterpartyId: supplier.id, employeeId: ownerId, warehouseId: ctx.wh, basis: 'Счёт №16',
  });
  ok(poa2.warnings.length === 0, 'Реквизиты сотрудника заполнены — предупреждений нет');

  // ============ 9.5 ПЕЧАТНЫЕ ФОРМЫ КЗ ============
  const form = await svc.printForm(accountId, 'esf', esfSale.id);
  ok(form.org.tin === '950101300123' && form.org.director === 'Айгуль Сериковна',
     'Печатная форма ЭСФ: реквизиты организации (БИН, директор)');
  ok(form.org.stampUrl === '/stamp.png' && form.org.signatureUrl === '/sign.png',
     '★ Печать и подпись подставляются — вместо конструктора МоегоСклада на 511 шаблонов');
  ok(form.counterparty.bin === '123456789012', 'Реквизиты контрагента');
  ok(form.items[0].ntin === '04870000000017' && form.items[0].vatRate === 12, 'В позициях НКТ и ставка НДС');
  ok(/тенге/.test(form.totalInWords), `★ Сумма прописью: «${form.totalInWords}» — обязательный реквизит форм КЗ`);

  const wb = await svc.printForm(accountId, 'waybill', sup.id);
  ok(wb.items.length === 2 && wb.counterparty.name === 'ТОО Караван', 'Печатная форма накладной по приёмке');
  const inv = await svc.printForm(accountId, 'invoice', paid.id);
  ok(inv.doc.total === 5000 && inv.org.bankAccount === 'KZ12345678901234567', 'Счёт на оплату с банковскими реквизитами');
  const poaForm = await svc.printForm(accountId, 'poa', poa.id);
  ok(poaForm.doc.payload.basis === 'Счёт №15 от 17.07.2026', 'Печатная форма доверенности с основанием');

  // сумма прописью — отдельно
  ok(amountInWords(0) === 'ноль тенге 00 тиын', 'Прописью: ноль');
  ok(amountInWords(1) === 'Один тенге 00 тиын', `Прописью: ${amountInWords(1)}`);
  ok(amountInWords(21) === 'Двадцать один тенге 00 тиын', `Прописью: ${amountInWords(21)}`);
  ok(amountInWords(2000) === 'Две тысячи тенге 00 тиын', `★ Прописью «две тысячи», а не «два тысяча»: ${amountInWords(2000)}`);
  ok(amountInWords(1500.5) === 'Одна тысяча пятьсот тенге 50 тиын', `Прописью с тиынами: ${amountInWords(1500.5)}`);
  ok(amountInWords(1234567.89) === 'Один миллион двести тридцать четыре тысячи пятьсот шестьдесят семь тенге 89 тиын',
     `Прописью миллионы: ${amountInWords(1234567.89)}`);
  ok(amountInWords(115) === 'Сто пятнадцать тенге 00 тиын', `Прописью подростковые: ${amountInWords(115)}`);

  // ============ МАРКИРОВКА ============
  const dm = '010487000000002421ABC123456789';
  const parsed = svc.parseDataMatrix(dm);
  ok(parsed.valid && parsed.gtin === '04870000000024' && parsed.serial === 'ABC123456789',
     `Код Data Matrix разобран: GTIN ${parsed.gtin}, серийный ${parsed.serial}`);
  ok(!svc.parseDataMatrix('12345').valid, 'Мусор вместо кода отклонён');

  const recv = await svc.receiveMarkedCodes(accountId, {
    docId: sup.id, productId: ctx.cig,
    codes: [dm, '010487000000002421XYZ987654321', 'плохой-код'],
  });
  ok(recv.accepted === 2 && recv.rejected.length === 1, `Приняли ${recv.accepted} кода, отклонили ${recv.rejected.length}`);
  const dup2 = await svc.receiveMarkedCodes(accountId, { docId: sup.id, productId: ctx.cig, codes: [dm] });
  ok(dup2.accepted === 0 && /уже в системе/.test(dup2.rejected[0].reason), 'Тот же код второй раз не принять');

  const s3 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  const c3 = await pos.addToCart(accountId, s3.id, { productId: ctx.cig, qty: 1 });
  const p3 = await pos.pay(accountId, s3.id, [{ method: 'cash', amount: Number(c3.total), received: 1000 }]);
  const sold = await svc.sellMarkedCode(accountId, { code: dm, saleId: p3.id, productId: ctx.cig });
  ok(sold.ok && /ИС МПТ/.test(sold.note), '★ Маркированный товар продан, код выведен из оборота (у Wipon Ismet — «в разработке»)');
  let soldTwice = false;
  try { await svc.sellMarkedCode(accountId, { code: dm, saleId: p3.id }); } catch (e) { soldTwice = /уже продан/.test(e.message); }
  ok(soldTwice, '★ Повторная продажа того же кода запрещена — это прямое нарушение');
  let unknown = false;
  try { await svc.sellMarkedCode(accountId, { code: '010487000000002421NEVER', saleId: p3.id }); } catch (e) { unknown = /не найден на складе/.test(e.message); }
  ok(unknown, 'Продать код, которого не принимали, нельзя');

  // ============ НАЛОГОВЫЕ РЕГИСТРЫ (список Wipon) ============
  const today = new Date().toISOString().slice(0, 10);
  const inc = await svc.taxRegisterIncome(accountId, today, today);
  ok(inc.items.length === 1 && inc.items[0].receipts === 3, `Регистр доходов: ${inc.items[0].receipts} чека за день`);
  ok(near(inc.totalCashless, 5000) && near(inc.totalCash, 1250),
     `★ «Регистр по учёту доходов, в том числе полученных путём безналичных расчётов» (Wipon): безнал ${inc.totalCashless} ₸ отдельной строкой`);

  const pur = await svc.taxRegisterPurchases(accountId, today, today);
  ok(pur.items.length === 3, `«Регистр по учёту приобретённых товаров» (Wipon): ${pur.items.length} приёмки`);
  ok(pur.items.some((i) => i.esfNumber) && pur.withoutEsf >= 1,
     `★ Видно, по каким закупкам нет ЭСФ: ${pur.withoutEsf} — это незачтённый НДС и вопрос при проверке`);
  ok(pur.items[0].supplierBin === '070740008064', 'В регистре БИН поставщика');

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  const foreign = await svc.list(acc2.account_id, {});
  ok(foreign.length === 0, 'Чужой аккаунт не видит наши документы');
  const foreignKeys = await svc.keyHealth(acc2.account_id);
  ok(foreignKeys.length === 0, 'И не видит наши ключи ЭЦП');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
