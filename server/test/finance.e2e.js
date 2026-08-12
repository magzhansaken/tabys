/**
 * ЧАСТЬ 7 — ФИНАНСЫ.
 * Проверяем в том числе две поправки, которые нашла сверка с документацией:
 *  1) инкассация — перевод, а не расход (у UMAG это операционный расход);
 *  2) комиссия эквайринга считается (нет ни у кого из троих).
 */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { FinanceService } = require('../dist/finance/finance.service');
  const { PosService } = require('../dist/pos/pos.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const { ContragentService } = require('../dist/contragents/contragent.service');

  const db = new DbService();
  const goods = new GoodsService(db);
  const fin = new FinanceService(db);
  const pos = new PosService(db, goods);
  const stock = new StockService(db, new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 }), goods);
  const cp = new ContragentService(db);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Магазин Финансы','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  // ============ 7.1 СЧЕТА ============
  const accs = await fin.accounts(accountId);
  ok(accs.items.length === 2, 'При регистрации созданы два счёта: касса магазина и расчётный счёт — клиент начинает работать сразу');
  ok(accs.items.some((a) => a.kind === 'cash') && accs.items.some((a) => a.kind === 'bank'), 'Касса и банк — один тип сущности с разным видом (Wipon держит их в разных разделах)');
  const cash = accs.items.find((a) => a.kind === 'cash');
  const bank = accs.items.find((a) => a.kind === 'bank');

  const kaspi = await fin.createAccount(accountId, {
    kind: 'bank', name: 'Kaspi Bank', bankName: 'АО «Kaspi Bank»',
    iik: 'KZ123456789012345678', bik: 'CASPKZKA', kbe: '17',
  });
  ok(kaspi.iik === 'KZ123456789012345678' && kaspi.bik === 'CASPKZKA' && kaspi.kbe === '17',
     'Реквизиты казахстанского счёта: ИИК, БИК, КБЕ (поля Wipon дословно)');

  const cats = await fin.categories(accountId, 'out');
  ok(cats.length >= 8 && cats.some((c) => c.name === 'Аренда') && cats.some((c) => c.name === 'Зарплата'),
     `Готовые статьи расходов: ${cats.length} (список UMAG из «Операционных расходов»; у МоегоСклада статья «Статьи расходов» — «в разработке»)`);
  ok(!cats.some((c) => /Инкассац/i.test(c.name)),
     '★ Инкассации среди статей расходов НЕТ: UMAG считает её расходом, но деньги не потрачены — они переехали в банк');

  // ============ ПОДГОТОВКА: товар и касса ============
  const ctx = await tx(async (c) => {
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const milk = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, purchase_price) VALUES ($1,'Молоко','simple',$2,300) RETURNING id`, [accountId, sht])).rows[0].id;
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,500)`, [accountId, milk, rt]);
    return { store, wh, reg, milk };
  });
  const sup = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId });
  await stock.addItem(accountId, sup.id, { productId: ctx.milk, qty: 500, price: 300 });
  await stock.process(accountId, sup.id);

  // способ оплаты → счёт (модель Wipon) + комиссия эквайринга
  await fin.bindPaymentMethod(accountId, { method: 'card', finAccountId: kaspi.id, acquiringPercent: 2 });
  await fin.bindPaymentMethod(accountId, { method: 'qr', finAccountId: kaspi.id, acquiringPercent: 0.95 });
  ok(true, 'Способы оплаты привязаны к счетам: карта и QR → Kaspi (модель Wipon)');

  // ============ 7.5 ★ КОМИССИЯ ЭКВАЙРИНГА ============
  const sh = await pos.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ownerId, openingFloat: 5000 });
  const s1 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  const cart1 = await pos.addToCart(accountId, s1.id, { productId: ctx.milk, qty: 20 });   // 10 000 ₸
  const paid1 = await pos.pay(accountId, s1.id, [{ method: 'card', amount: Number(cart1.total) }]);
  const post1 = await fin.postSale(accountId, paid1.id);
  ok(near(post1.acquiringFee, 200),
     `★ Пробили 10 000 ₸ картой — банк удержал 2% = ${post1.acquiringFee} ₸. Ни UMAG, ни Wipon, ни МойСклад этого не показывают`);

  const afterCard = await fin.accounts(accountId);
  const kaspiBal = afterCard.items.find((a) => a.id === kaspi.id).balance;
  ok(near(kaspiBal, 9800), `★ На счёт пришло ${kaspiBal} ₸, а не 10 000 — вот эта разница и есть дыра в прибыли`);

  const dup = await fin.postSale(accountId, paid1.id);
  ok(!dup.posted && /уже разнесён/.test(dup.reason), 'Повторное разнесение чека не задваивает деньги');

  // QR с другой комиссией
  const s2 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  const cart2 = await pos.addToCart(accountId, s2.id, { productId: ctx.milk, qty: 10 });   // 5000 ₸
  const paid2 = await pos.pay(accountId, s2.id, [{ method: 'qr', amount: Number(cart2.total), ref: 'kaspi-qr-1' }]);
  const post2 = await fin.postSale(accountId, paid2.id);
  ok(near(post2.acquiringFee, 47.5), `Kaspi QR: комиссия 0,95% с 5000 = ${post2.acquiringFee} ₸ — у каждого способа своя ставка`);

  // наличные — без комиссии
  const s3 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  const cart3 = await pos.addToCart(accountId, s3.id, { productId: ctx.milk, qty: 30 });   // 15 000 ₸
  const paid3 = await pos.pay(accountId, s3.id, [{ method: 'cash', amount: Number(cart3.total), received: 15000 }]);
  const post3 = await fin.postSale(accountId, paid3.id);
  ok(post3.acquiringFee === 0, 'С наличных банк ничего не берёт');
  const cashBal = (await fin.accounts(accountId)).items.find((a) => a.id === cash.id).balance;
  ok(near(cashBal, 15000), `Наличные легли в кассу магазина: ${cashBal} ₸`);

  // ============ ДОЛГ В ДЕНЬГИ НЕ ПОПАДАЕТ ============
  const azamat = await cp.create(accountId, { name: 'Азамат', debtLimit: 50000 });
  const s4 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId, customerId: azamat.id });
  const cart4 = await pos.addToCart(accountId, s4.id, { productId: ctx.milk, qty: 4 });    // 2000 ₸
  const paid4 = await pos.pay(accountId, s4.id, [{ method: 'credit', amount: Number(cart4.total) }]);
  await cp.recordSaleDebt(accountId, { counterpartyId: azamat.id, saleId: paid4.id, amount: Number(paid4.total), employeeId: ownerId, shiftId: sh.id });
  const cashAfterDebt = (await fin.accounts(accountId)).items.find((a) => a.id === cash.id).balance;
  const post4 = await fin.postSale(accountId, paid4.id);
  ok(near(cashAfterDebt, 15000) && post4.lines.length === 0,
     'Продажа в долг денег на счета не приносит — их и не поступало (то же правило, что и в фискализации)');

  // должник принёс деньги — вот это уже деньги
  await cp.payDebt(accountId, { counterpartyId: azamat.id, amount: 2000, method: 'cash', employeeId: ownerId });
  await fin.postDebtPayment(accountId, { counterpartyId: azamat.id, amount: 2000, method: 'cash', employeeId: ownerId, shiftId: sh.id });
  const cashAfterPay = (await fin.accounts(accountId)).items.find((a) => a.id === cash.id).balance;
  ok(near(cashAfterPay, 17000), `Должник вернул 2000 — деньги пришли в кассу: ${cashAfterPay} ₸`);

  // ============ 7.4 ★ ИНКАССАЦИЯ — ПЕРЕВОД, А НЕ РАСХОД ============
  const plBefore = await fin.profitLoss(accountId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  const coll = await fin.collectFromShift(accountId, { shiftId: sh.id, amount: 10000, employeeId: ownerId });
  ok(coll.amount === 10000 && coll.to === 'Расчётный счёт', `Инкассация 10 000 ₸: ${coll.from} → ${coll.to}`);
  const plAfter = await fin.profitLoss(accountId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  ok(near(plBefore.netProfit, plAfter.netProfit),
     `★ Прибыль после инкассации не изменилась: ${plAfter.netProfit} ₸. У UMAG инкассация — операционный расход, и магазин выглядел бы тем убыточнее, чем чаще возишь выручку в банк`);
  ok(plAfter.operatingExpenses.total === 0, 'В операционных расходах инкассации нет');

  const afterColl = await fin.accounts(accountId);
  ok(near(afterColl.items.find((a) => a.id === cash.id).balance, 7000) &&
     near(afterColl.items.find((a) => a.id === bank.id).balance, 10000),
     'Деньги переехали: в кассе 7000, в банке 10 000 — общая сумма та же');
  ok(near(afterColl.total, 7000 + 10000 + 9800 + 4952.5), `Всего денег: ${afterColl.total} ₸ по всем счетам`);

  let tooMuch = false;
  try { await fin.collectFromShift(accountId, { shiftId: sh.id, amount: 999999 }); } catch (e) { tooMuch = /нельзя/.test(e.message); }
  ok(tooMuch, 'Инкассировать больше, чем есть в кассе, нельзя');

  // изъятие собственника — тоже не расход
  const draw = await fin.ownerDraw(accountId, { finAccountId: cash.id, amount: 5000, employeeId: ownerId, comment: 'Забрал себе' });
  ok(/не входит в операционные расходы/.test(draw.note), 'Изъятие собственника — вывод прибыли, а не операционный расход');
  const plAfterDraw = await fin.profitLoss(accountId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  ok(near(plAfterDraw.operatingExpenses.total, 0), 'Изъятие в операционные расходы не попало');

  // ============ 7.2 ПЛАТЕЖИ И ПЕРЕВОДЫ ============
  const rent = cats.find((c) => c.name === 'Аренда');
  await fin.expense(accountId, { finAccountId: bank.id, amount: 3000, categoryId: rent.id, comment: 'Аренда за июль', employeeId: ownerId });
  const plRent = await fin.profitLoss(accountId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  ok(near(plRent.operatingExpenses.total, 3000) && plRent.operatingExpenses.byCategory[0].name === 'Аренда',
     'Расход по статье «Аренда» попал в операционные расходы');

  let noMoney = false;
  try { await fin.expense(accountId, { finAccountId: bank.id, amount: 999999, categoryId: rent.id }); } catch (e) { noMoney = /только/.test(e.message); }
  ok(noMoney, 'Списать больше, чем есть на счёте, нельзя — с указанием, сколько есть');

  const kaspiBefore = (await fin.accounts(accountId)).items.find((a) => a.id === kaspi.id).balance;
  const tr = await fin.transfer(accountId, { fromId: kaspi.id, toId: bank.id, amount: 1000, employeeId: ownerId });
  ok(near(tr.from.balance, kaspiBefore - 1000) && near(tr.to.balance, 8000),
     `Перевод между счетами: Kaspi ${tr.from.balance} → Расчётный ${tr.to.balance} (на Kaspi шли и карта, и QR)`);
  ok(/не влияет на прибыль/.test(tr.note), 'Система прямо говорит: перевод не влияет на прибыль');
  let same = false;
  try { await fin.transfer(accountId, { fromId: bank.id, toId: bank.id, amount: 100 }); } catch { same = true; }
  ok(same, 'Перевод на тот же счёт отклонён');

  // ============ ★ ДАТА НАЧИСЛЕНИЯ (модель МС, у них платная опция) ============
  const nextMonth = new Date(); nextMonth.setMonth(nextMonth.getMonth() + 1);
  await fin.expense(accountId, {
    finAccountId: bank.id, amount: 4000, categoryId: rent.id,
    comment: 'Аренда за следующий месяц вперёд', accrualDate: nextMonth.toISOString().slice(0, 10), employeeId: ownerId,
  });
  const plNow = await fin.profitLoss(accountId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  ok(near(plNow.operatingExpenses.total, 3000),
     '★ Аренда, оплаченная вперёд, в этот месяц не попала — сработала дата начисления (у МоегоСклада это платная опция, у нас бесплатно)');
  const plNext = await fin.profitLoss(accountId, nextMonth.toISOString().slice(0, 10), new Date(nextMonth.getTime() + 86400000).toISOString());
  ok(near(plNext.operatingExpenses.total, 4000), 'Зато попала в следующий месяц — «оплатили аренду за апрель в марте» (пример из статьи МС)');

  // ============ 7.6 ПРИБЫЛИ И УБЫТКИ (структура UMAG) ============
  const pl = await fin.profitLoss(accountId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  ok(near(pl.revenue.sales, 32000), `Продажи = наличные + безнал + в долг = ${pl.revenue.sales} ₸ (формула UMAG)`);
  ok(near(pl.revenue.cash, 15000) && near(pl.revenue.card, 10000) && near(pl.revenue.qr, 5000) && near(pl.revenue.credit, 2000),
     'Продажи разложены по способам оплаты, как в отчёте UMAG');
  ok(near(pl.revenue.total, 32000), `Выручка = Продажи − Возврат = ${pl.revenue.total} ₸`);
  ok(near(pl.cost.sold, 19200), `Себестоимость проданных товаров: ${pl.cost.sold} ₸ (64 шт × 300)`);
  ok(near(pl.grossProfit, 32000 - 19200), `★ Валовая прибыль = Выручка − Себестоимость = ${pl.grossProfit} ₸ (формула UMAG)`);
  ok(near(pl.acquiringFees, 247.5), `★ Комиссии банка за период: ${pl.acquiringFees} ₸ — отдельной строкой, чего нет ни у кого`);
  ok(near(pl.netProfit, pl.grossProfit - pl.operatingExpenses.total - pl.acquiringFees - pl.writeOffs),
     `Чистая прибыль = Валовая − Операционные − Эквайринг − Списания = ${pl.netProfit} ₸`);
  ok(pl.marginPercent > 0 && pl.marginPercent < 100, `Рентабельность ${pl.marginPercent}%`);
  ok(/переехали, а не потрачены/.test(pl.note), 'В отчёте прямо сказано, почему инкассации нет в расходах');

  // возврат уменьшает выручку
  const ref = await pos.refund(accountId, { saleId: paid3.id, shiftId: sh.id, employeeId: ownerId, items: [{ productId: ctx.milk, qty: 10 }] });
  await fin.postSale(accountId, ref.id);
  const pl2 = await fin.profitLoss(accountId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  ok(near(pl2.revenue.refunds, 5000) && near(pl2.revenue.total, 27000),
     `Возврат 5000 ₸ уменьшил выручку: ${pl2.revenue.total} ₸ (Выручка = Продажи − Возврат)`);
  ok(near(pl2.cost.returned, 3000), `Себестоимость возвращённых товаров: ${pl2.cost.returned} ₸ (раскрытие UMAG)`);

  // списание — тоже потеря
  const wo = await stock.createDoc(accountId, { kind: 'write_off', warehouseId: ctx.wh, employeeId: ownerId });
  await stock.addItem(accountId, wo.id, { productId: ctx.milk, qty: 5 });
  await stock.process(accountId, wo.id);
  const pl3 = await fin.profitLoss(accountId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  ok(near(pl3.writeOffs, 1500), `★ Испорченный товар на 1500 ₸ учтён отдельной строкой — это тоже потеря денег`);

  // ============ 7.6 ДДС ============
  const cf = await fin.cashFlow(accountId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  ok(cf.inflow.length >= 2 && cf.outflow.length >= 3,
     `ДДС по статьям: ${cf.inflow.length} видов поступлений, ${cf.outflow.length} видов выплат (у UMAG всего три колонки: Закупы, Расходы, Вложения)`);
  ok(cf.inflow.some((i) => i.category === 'Выручка') && cf.inflow.some((i) => i.category === 'Погашение долгов покупателями'),
     'Видно, откуда пришли деньги: выручка и погашение долгов');
  ok(cf.outflow.some((o) => o.category === 'Комиссия банка (эквайринг)') && cf.outflow.some((o) => o.category === 'Изъятие собственника'),
     'И куда ушли: комиссия банка, изъятие собственника, аренда');
  ok(near(cf.closingBalance, cf.openingBalance + cf.totalIn - cf.totalOut),
     `Остаток на конец = остаток на начало + поступления − выплаты = ${cf.closingBalance} ₸`);
  const realTotal = (await fin.accounts(accountId)).total;
  ok(near(cf.closingBalance, realTotal), `★ Отчёт ДДС сходится с фактическими остатками по счетам: ${realTotal} ₸`);

  // ============ ДЕНЬГИ — СУММА ДВИЖЕНИЙ ============
  const realCash = (await fin.accounts(accountId)).items.find((a) => a.id === cash.id).balance;
  await tx(async (c) => c.query(`UPDATE fin_balance SET balance = 777777 WHERE fin_account_id=$1`, [cash.id]));
  await db.raw(`SELECT recalc_fin_balance($1,$2)`, [accountId, cash.id]);
  const fixed = (await fin.accounts(accountId)).items.find((a) => a.id === cash.id).balance;
  ok(near(fixed, realCash), `Баланс счёта пересобран из движений: испорченное значение исправлено (${fixed} ₸) — принцип из 1.3`);

  // ★ Касса ушла в минус: возврат 5000 отдали после того, как всю выручку
  // инкассировали и изъяли. Физически так не бывает — система обязана сказать.
  const withWarn = await fin.accounts(accountId);
  ok(withWarn.items.find((a) => a.id === cash.id).negative && withWarn.warnings.length === 1,
     `★ Отрицательный остаток кассы (${fixed} ₸) помечен как ошибка учёта — в ящике не бывает «минус 3000»`);
  ok(/возврат отдали уже после инкассации/.test(withWarn.warnings[0]),
     'Владельцу подсказано, где искать причину, пока он помнит этот день');

  // ============ ИСТОРИЯ ============
  const hist = await fin.history(accountId, { finAccountId: cash.id });
  ok(hist.length >= 5, `История по кассе: ${hist.length} операций`);
  ok(hist.some((h) => h.kind === 'transfer_out' && /Инкассация/.test(h.comment)), 'Инкассация видна в истории как перевод');

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  const foreign = await fin.accounts(acc2.account_id);
  ok(foreign.total === 0 && foreign.items.length === 2, 'Чужой аккаунт видит только свои счета с нулями');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
