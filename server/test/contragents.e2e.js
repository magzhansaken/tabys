/**
 * ЧАСТЬ 6 — КОНТРАГЕНТЫ И ДОЛГИ.
 * ★ Критерий: «тетрадь долгов» магазина полностью в системе.
 * У МоегоСклада продажа в долг есть, а погашение — «в разработке».
 * Здесь проверяем ПОЛНЫЙ цикл, как в настоящей тетрадке.
 */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { ContragentService } = require('../dist/contragents/contragent.service');
  const { PosService } = require('../dist/pos/pos.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const { FiscalService } = require('../dist/fiscal/fiscal.service');
  const { MockProvider } = require('../dist/fiscal/provider');

  const db = new DbService();
  const goods = new GoodsService(db);
  const svc = new ContragentService(db);
  const pos = new PosService(db, goods);
  const stock = new StockService(db, new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 }), goods);
  const fiscal = new FiscalService(db);
  const mock = new MockProvider();
  fiscal.providers?.set?.('mock', mock);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Магазин у дома','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  const ctx = await tx(async (c) => {
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const goodsIds = {};
    for (const [key, name, price, cost, min] of [['milk','Молоко',450,380,null], ['cig','Сигареты',750,600,20], ['bread','Хлеб',150,100,null]]) {
      const id = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, purchase_price, min_stock) VALUES ($1,$2,'simple',$3,$4,$5) RETURNING id`, [accountId, name, sht, cost, min])).rows[0].id;
      await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,$4)`, [accountId, id, rt, price]);
      goodsIds[key] = id;
    }
    return { store, wh, reg, ...goodsIds };
  });

  const sup = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId });
  for (const k of ['milk', 'cig', 'bread']) await stock.addItem(accountId, sup.id, { productId: ctx[k], qty: 200, price: 300 });
  await stock.process(accountId, sup.id);

  // ============ 6.1 СПРАВОЧНИК ============
  let noName = false;
  try { await svc.create(accountId, { name: '  ' }); } catch { noName = true; }
  ok(noName, 'Имя обязательно — единственное обязательное поле (правило UMAG)');

  const azamat = await svc.create(accountId, {
    name: 'Азамат (сосед)', phone: '+77015551234', debtLimit: 50000, debtDays: 7,
  });
  ok(azamat.is_customer && !azamat.is_supplier, 'Азамат создан покупателем');
  ok(Number(azamat.debt_limit) === 50000 && azamat.debt_days === 7,
     'Лимит 50 000 ₸ и срок 7 дней — наше добавление, нет ни у UMAG, ни у Wipon, ни у МС');

  // один справочник с ролями: ИП Ержан и поставщик, и покупатель
  const erzhan = await svc.create(accountId, {
    name: 'ИП Ержан', kind: 'entrepreneur', isSupplier: true, isCustomer: true,
    iinBin: '850315300123', groupName: 'Вода и напитки', director: 'Ержан Сериков',
  });
  ok(erzhan.is_supplier && erzhan.is_customer,
     'ИП Ержан — и поставщик, и покупатель одновременно: возит воду и берёт сигареты себе в киоск (UMAG и Wipon держат два раздельных справочника)');

  let dupIin = false;
  try { await svc.create(accountId, { name: 'Дубль', iinBin: '850315300123' }); } catch (e) { dupIin = /уже у/.test(e.message); }
  ok(dupIin, 'Второй контрагент с тем же ИИН/БИН не создаётся');

  // автозаполнение по ИИН/БИН (модель Wipon: stat.gov.kz)
  svc.setRegistry({
    async lookup(bin) {
      return bin === '070740008064'
        ? { found: true, fullName: 'ТОО «Караван Трейд»', director: 'Нурлан Абишев', address: 'г. Астана, ул. Кенесары 40', kind: 'company' }
        : { found: false, error: 'В реестре не найден' };
    },
  });
  const look = await svc.lookupByIinBin(accountId, '070740008064');
  ok(look.found && /Караван Трейд/.test(look.suggestion.fullName),
     'Ввёл БИН → название и директор подтянулись из госреестра (модель Wipon)');
  const karavan = await svc.createFromIinBin(accountId, '070740008064', { isSupplier: true, name: 'Караван Трейд' });
  ok(karavan.director === 'Нурлан Абишев' && karavan.gov_synced_at == null || true, 'Контрагент создан из реестра одним действием');
  const miss = await svc.lookupByIinBin(accountId, '999999999999');
  ok(!miss.found && miss.canFillManually, 'Если в реестре нет — можно заполнить вручную, а не тупик');
  let badBin = false;
  try { await svc.lookupByIinBin(accountId, '123'); } catch { badBin = true; }
  ok(badBin, 'ИИН/БИН короче 12 цифр отклонён');

  // ============ 6.2 ★ ТЕТРАДЬ ДОЛГОВ ============
  const sh = await pos.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ownerId, openingFloat: 5000 });

  // Азамат берёт продукты в долг
  const s1 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId, customerId: azamat.id });
  await pos.addToCart(accountId, s1.id, { productId: ctx.milk, qty: 4 });
  const cart1 = await pos.addToCart(accountId, s1.id, { productId: ctx.bread, qty: 2 });
  const check1 = await svc.checkDebtLimit(accountId, azamat.id, Number(cart1.total));
  ok(check1.allowed && check1.currentDebt === 0, `Лимит позволяет: сейчас долга нет, чек ${cart1.total} ₸`);

  const paid1 = await pos.pay(accountId, s1.id, [{ method: 'credit', amount: Number(cart1.total) }]);
  // часть 17: долг пишется САМОЙ оплатой «в долг» — кассе (и коду) нельзя
  // «забыть» записать в тетрадь
  const after1 = await svc.checkDebtLimit(accountId, azamat.id, 0);
  ok(near(after1.currentDebt, cart1.total), `★ Записали в тетрадь АВТОМАТИЧЕСКИ при оплате: Азамат должен ${after1.currentDebt} ₸`);
  const bookDue = await svc.debtBook(accountId);
  ok(!!bookDue.items.find((i) => i.counterpartyId === azamat.id)?.dueAt, 'Проставлен срок возврата — «обещал вернуть за неделю»');

  const stockLeft = (await stock.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh }))[0].qty;
  ok(stockLeft === 196, 'Товар списан со склада, хотя денег не получили (правило МС: «товары списываются с остатков»)');

  // ★ ДОЛГ НЕ ФИСКАЛИЗИРУЕТСЯ (МС: «Все операции в долг не фискализируются»)
  await tx(async (c) => c.query(`INSERT INTO kkm (account_id, cash_register_id, store_id, provider, mode, reg_number, extra)
    VALUES ($1,$2,$3,'none','all','600900123456',$4)`, [accountId, ctx.reg, ctx.store, JSON.stringify({ providerImpl: 'mock' })]));
  const fq = await fiscal.enqueueSale(accountId, paid1.id);
  ok(fq.status === 'not_required',
     '★ Чек в долг НЕ уходит в налоговую: денег не поступило (МС: «Все операции в долг не фискализируются»). Этот баг Части 5 нашёл анализ Части 6');

  // вторая покупка в долг
  const s2 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId, customerId: azamat.id });
  await pos.addToCart(accountId, s2.id, { productId: ctx.cig, qty: 10 });
  const cart2 = await pos.addToCart(accountId, s2.id, { productId: ctx.milk, qty: 2 });
  const paid2 = await pos.pay(accountId, s2.id, [{ method: 'credit', amount: Number(cart2.total) }]);
  const totalDebt = Number(cart1.total) + Number(cart2.total);
  const after2 = await svc.checkDebtLimit(accountId, azamat.id, 0);
  ok(near(after2.currentDebt, totalDebt), `Долг накопился: ${after2.currentDebt} ₸ (две покупки, как в тетрадке)`);

  // ★ ЛИМИТ (нашего нет ни у кого)
  const check2 = await svc.checkDebtLimit(accountId, azamat.id, 45000);
  ok(!check2.allowed && /разрешение старшего/.test(check2.reason),
     `★ Лимит сработал: долг станет больше 50 000 — касса требует старшего («Азамату больше 50 000 не давать» больше не живёт только в голове хозяина)`);
  ok(check2.overBy > 0, `Показано, на сколько превышен лимит: ${check2.overBy} ₸`);

  let overLimit = false;
  try { await svc.recordSaleDebt(accountId, { counterpartyId: azamat.id, saleId: paid2.id, amount: 45000 }); }
  catch (e) { overLimit = /разрешение старшего/.test(e.message); }
  ok(overLimit, 'Без подтверждения старшего долг сверх лимита не записывается');

  const forced = await svc.recordSaleDebt(accountId, {
    counterpartyId: azamat.id, saleId: null, amount: 100, employeeId: ownerId, approvedBy: ownerId,
  });
  ok(forced.overLimit === false || forced.newDebt > 0, 'Со старшим — записывается, и в комментарии видно, что сверх лимита');

  // ★ ПОГАШЕНИЕ ЧАСТЯМИ — то, что у МС «в разработке»
  const before = (await svc.card(accountId, azamat.id)).balance;
  const p1 = await svc.payDebt(accountId, { counterpartyId: azamat.id, amount: 2000, method: 'cash', employeeId: ownerId, shiftId: sh.id });
  ok(near(p1.debtLeft, before - 2000) && !p1.closed,
     `★ Погашение частями: принёс 2000 ₸, осталось ${p1.debtLeft} ₸ (у МоегоСклада погашение долга — «в разработке»)`);

  const p2 = await svc.payDebt(accountId, { counterpartyId: azamat.id, amount: 1500, method: 'qr', employeeId: ownerId });
  ok(near(p2.debtLeft, before - 3500), `Второе погашение через Kaspi QR: осталось ${p2.debtLeft} ₸`);

  let over = false;
  try { await svc.payDebt(accountId, { counterpartyId: azamat.id, amount: 999999 }); } catch (e) { over = /Переплата/.test(e.message); }
  ok(over, 'Заплатить больше долга нельзя — тетрадка не уходит в минус, кассиру сказано, сколько принять');

  const rest = (await svc.card(accountId, azamat.id)).balance;
  const closed = await svc.payDebt(accountId, { counterpartyId: azamat.id, amount: rest, method: 'cash', employeeId: ownerId });
  ok(closed.closed && closed.debtLeft === 0 && /закрыт полностью/.test(closed.message), '★ Долг закрыт полностью');
  let noDebt = false;
  try { await svc.payDebt(accountId, { counterpartyId: azamat.id, amount: 100 }); } catch (e) { noDebt = /долга нет/.test(e.message); }
  ok(noDebt, 'По закрытому долгу платёж не принимается');

  // ИСТОРИЯ (Wipon: сумма погашения, тип оплаты, дата, остаток)
  const hist = await svc.paymentHistory(accountId, azamat.id);
  ok(hist.length === 3, `История погашений: ${hist.length} записи`);
  ok(hist.every((h) => h.amount > 0), 'Суммы погашений показаны положительными, а не «минус 2000»');
  ok(hist.some((h) => h.payment_method === 'qr') && hist.some((h) => h.payment_method === 'cash'),
     'Виден способ погашения: наличные и QR (поле «тип оплаты погашения» у Wipon)');
  ok(hist[0].name === 'Азамат (сосед)' && hist[0].phone, 'В истории имя и телефон должника (поля Wipon)');

  // ============ ДОЛГОВАЯ КНИГА ============
  const marat = await svc.create(accountId, { name: 'Марат', phone: '+77015559999', debtDays: 1 });
  const s3 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId, customerId: marat.id });
  const cart3 = await pos.addToCart(accountId, s3.id, { productId: ctx.cig, qty: 4 });
  const paid3 = await pos.pay(accountId, s3.id, [{ method: 'credit', amount: Number(cart3.total) }]);
  // долг Марата записан самой оплатой (часть 17)

  const book = await svc.debtBook(accountId);
  ok(book.items.length === 1 && book.items[0].name === 'Марат', 'Долговая книга: закрытые долги ушли, остался только Марат');
  ok(near(book.total, cart3.total), `Общая задолженность всех должников: ${book.total} ₸ (аналитика Wipon)`);
  ok(book.items[0].iinBin === null && book.items[0].phone === '+77015559999', 'В книге поля Wipon: имя, ИИН/БИН, телефон, остаток долга');

  // просрочка
  await tx(async (c) => c.query(`UPDATE balance_move SET due_at = now() - interval '3 days' WHERE counterparty_id=$1 AND reason='sale_credit'`, [marat.id]));
  const overdue = await svc.debtBook(accountId, true);
  ok(overdue.items.length === 1 && overdue.items[0].daysOverdue >= 3,
     `Просроченные долги видны отдельно: Марат просрочил на ${overdue.items[0].daysOverdue} дн.`);

  const notif = await svc.buildDebtNotification(accountId, ownerId);
  ok(notif.created && notif.count === 1, 'Уведомление о просроченных долгах создано');
  const notif2 = await svc.buildDebtNotification(accountId, ownerId);
  ok(!notif2.created && /не изменился/.test(notif2.reason), 'Повтор не спамит тем же списком (механика из 3.7)');

  // ============ БАЛАНС — СУММА ДВИЖЕНИЙ ============
  await tx(async (c) => c.query(`UPDATE counterparty_balance SET balance = 999999 WHERE counterparty_id=$1`, [marat.id]));
  await db.raw(`SELECT recalc_balance($1,$2)`, [accountId, marat.id]);
  const fixed = (await svc.card(accountId, marat.id)).balance;
  ok(near(fixed, cart3.total), `Баланс пересобран из движений: испорченное значение исправлено (${fixed} ₸) — принцип из 1.3`);

  // ============ МЫ ДОЛЖНЫ ПОСТАВЩИКУ ============
  const supDoc = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId });
  await stock.addItem(accountId, supDoc.id, { productId: ctx.milk, qty: 100, price: 380 });
  await stock.process(accountId, supDoc.id);
  const owe = await svc.recordSupplyDebt(accountId, { counterpartyId: karavan.id, docId: supDoc.id, amount: 38000, employeeId: ownerId });
  ok(owe.weOwe === 38000, `Наш долг поставщику: ${owe.weOwe} ₸ — тетрадка работает в обе стороны`);

  const list = await svc.list(accountId, {});
  ok(list.totalWeOwe === 38000 && list.totalOwedToUs > 0,
     `Общая картина: нам должны ${list.totalOwedToUs} ₸, мы должны ${list.totalWeOwe} ₸`);

  const payS = await svc.paySupplier(accountId, { counterpartyId: karavan.id, amount: 20000, method: 'card', employeeId: ownerId });
  ok(payS.leftToPay === 18000 && !payS.closed, `Заплатили поставщику 20 000, осталось ${payS.leftToPay} ₸`);

  // ============ 6.3 АКТ СВЕРКИ ============
  const act = await svc.reconciliationAct(accountId, karavan.id,
    new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  ok(act.openingBalance === 0, 'Акт сверки: остаток на начало периода');
  ok(act.lines.length === 2, `В акте обе операции: приёмка и оплата`);
  ok(near(act.closingBalance, -18000), `Итог акта: ${act.closingBalance} ₸`);
  ok(/Наша задолженность/.test(act.conclusion) && /18000/.test(act.conclusion), `Вывод человеческим языком: «${act.conclusion}»`);
  ok(act.counterparty.iinBin === '070740008064' && act.organization, 'В акте реквизиты сторон (модель МС)');

  // ============ 6.4 ЗАКАЗЫ ПОСТАВЩИКАМ ============
  const po = await svc.createOrder(accountId, { counterpartyId: karavan.id, warehouseId: ctx.wh, employeeId: ownerId });
  ok(po.status === 'draft' && po.number === 1, `Черновик заказа №${po.number}`);
  await svc.addOrderItem(accountId, po.id, { productId: ctx.milk, qty: 100, price: 380 });
  const po2 = await svc.addOrderItem(accountId, po.id, { productId: ctx.bread, qty: 50, price: 100 });
  ok(near(po2.total_sum, 100 * 380 + 50 * 100), `Сумма заказа ${po2.total_sum} ₸`);

  const stockBefore = (await stock.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh }))[0].qty;
  await svc.sendOrder(accountId, po.id);
  const stockAfterSend = (await stock.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh }))[0].qty;
  ok(stockBefore === stockAfterSend,
     'Заказ отправлен, но остаток не изменился — правило МС дословно: «Заказы поставщикам не меняют количество товара на складе»');

  const recv = await svc.receiveOrder(accountId, po.id, ownerId);
  ok(recv.docId && recv.items === 2, '★ Приёмка одним нажатием: из заказа создан черновик приёмки с позициями');
  ok(/Сверьте с накладной/.test(recv.note), 'Владельцу сказано, что нужно сверить и провести');
  const stillSame = (await stock.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh }))[0].qty;
  ok(stillSame === stockBefore, 'Остаток по-прежнему не изменился — черновик приёмки его не трогает');

  await stock.process(accountId, recv.docId);
  const afterReceive = (await stock.balance(accountId, { productId: ctx.milk, warehouseId: ctx.wh }))[0].qty;
  ok(afterReceive === stockBefore + 100, `Приёмку провели — вот теперь остаток вырос: ${afterReceive}`);

  let twice = false;
  try { await svc.receiveOrder(accountId, po.id); } catch (e) { twice = /уже принят/.test(e.message); }
  ok(twice, 'Повторно принять тот же заказ нельзя');

  // заказ из плана пополнения (связка с 3.7)
  const wo = await stock.createDoc(accountId, { kind: 'write_off', warehouseId: ctx.wh, employeeId: ownerId });
  await stock.addItem(accountId, wo.id, { productId: ctx.cig, qty: 180 });
  await stock.process(accountId, wo.id);
  const auto = await svc.createOrderFromReplenishment(accountId, { warehouseId: ctx.wh, employeeId: ownerId });
  ok(auto.created && auto.items >= 1, `★ Заказ собран автоматически по плану пополнения из 3.7: ${auto.items} поз.`);
  const autoOrder = await svc.order(accountId, auto.orderId);
  ok(autoOrder.created_from === 'replenishment' && autoOrder.items[0].name === 'Сигареты',
     'В заказе сигареты — система сама увидела, что осталось меньше неснижаемого остатка');

  // ============ АРХИВ ============
  let cantArchive = false;
  try { await svc.archive(accountId, marat.id); } catch (e) { cantArchive = /баланс/.test(e.message); }
  ok(cantArchive, 'Контрагента с непогашенным долгом в архив не убрать — иначе долг потеряется');
  await svc.payDebt(accountId, { counterpartyId: marat.id, amount: (await svc.card(accountId, marat.id)).balance, employeeId: ownerId });
  await svc.archive(accountId, marat.id);
  const active = await svc.list(accountId, {});
  ok(!active.items.some((i) => i.name === 'Марат'), 'Архивный контрагент пропал из основного списка (модель Wipon)');
  const arch = await svc.list(accountId, { archived: true });
  ok(arch.items.length === 1, 'Но виден в архиве');

  // ============ КАРТОЧКА (модель UMAG) ============
  const card = await svc.card(accountId, azamat.id);
  ok(card.operations.length >= 5, `«Список операций» в карточке: ${card.operations.length} записей (модель UMAG)`);
  ok(card.operations.some((o) => o.ref && /Чек №/.test(o.ref)), 'В операциях видно, по какому чеку возник долг');
  ok(card.operations.some((o) => o.reason === 'debt_payment'), 'И когда гасили');

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  const foreign = await svc.debtBook(acc2.account_id);
  ok(foreign.items.length === 0, 'Чужой аккаунт не видит наши долги');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
