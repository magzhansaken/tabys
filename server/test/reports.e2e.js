/**
 * ЧАСТЬ 8 — ОТЧЁТЫ И ДАШБОРД.
 * Дашборд 1:1 со сценарием «Главной» UMAG, но живой. Плюс проверка поправки:
 * у UMAG «Средний чек = Выручка / Количество продаж», где «количество продаж»
 * в их же определении — штуки товара.
 */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { ReportService } = require('../dist/reports/report.service');
  const { PosService } = require('../dist/pos/pos.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const { FinanceService } = require('../dist/finance/finance.service');
  const { ContragentService } = require('../dist/contragents/contragent.service');

  const db = new DbService();
  const goods = new GoodsService(db);
  const notified = [];
  const gateway = { notifyAccount: (a, m) => { notified.push({ a, m }); return 1; }, connectionsOf: () => 1 };
  const rep = new ReportService(db, gateway);
  const pos = new PosService(db, goods);
  const stock = new StockService(db, new SyncService(db, gateway), goods);
  const fin = new FinanceService(db);
  const cps = new ContragentService(db);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Магазин Отчёты','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);
  const today = rep.quickPeriod('today');

  const ctx = await tx(async (c) => {
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const dairy = (await c.query(`INSERT INTO category (account_id, name) VALUES ($1,'Молочное') RETURNING id`, [accountId])).rows[0].id;
    const tobacco = (await c.query(`INSERT INTO category (account_id, name) VALUES ($1,'Табак') RETURNING id`, [accountId])).rows[0].id;
    const cashier = (await c.query(`INSERT INTO employee (account_id, role_id, first_name, phone, can_login_pos) VALUES ($1,(SELECT id FROM role WHERE code='cashier'),'Марат',$2,true) RETURNING id`, [accountId, '+7705' + Math.floor(1000000 + Math.random() * 8999999)])).rows[0].id;
    const sup = (await c.query(`INSERT INTO counterparty (account_id, name, is_supplier) VALUES ($1,'Караван',true) RETURNING id`, [accountId])).rows[0].id;

    const g = {};
    // [ключ, имя, цена, себестоимость, категория]
    for (const [k, name, price, cost, cat] of [
      ['milk', 'Молоко', 500, 300, dairy],       // маржинальный
      ['cig', 'Сигареты', 750, 730, tobacco],    // оборот есть, прибыли нет → AC
      ['cheese', 'Сыр', 3000, 1500, dairy],      // редкий, но маржинальный → CA
      ['gum', 'Жвачка', 100, 95, tobacco],       // ни оборота, ни прибыли → CC
    ]) {
      const id = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, category_id, supplier_id, purchase_price) VALUES ($1,$2,'simple',$3,$4,$5,$6) RETURNING id`, [accountId, name, sht, cat, sup, cost])).rows[0].id;
      await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,$4)`, [accountId, id, rt, price]);
      g[k] = id;
    }
    return { store, wh, reg, cashier, sup, dairy, tobacco, ...g };
  });

  const sup = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId, supplierId: ctx.sup });
  for (const [k, cost] of [['milk', 300], ['cig', 730], ['cheese', 1500], ['gum', 95]])
    await stock.addItem(accountId, sup.id, { productId: ctx[k], qty: 300, price: cost });
  await stock.process(accountId, sup.id);

  // ============ ДЕНЬ ТОРГОВЛИ ============
  const sh = await pos.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ctx.cashier, openingFloat: 5000 });
  // 10 чеков: сигареты гонят оборот, молоко даёт прибыль
  for (let i = 0; i < 10; i++) {
    const s = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ctx.cashier });
    await pos.addToCart(accountId, s.id, { productId: ctx.cig, qty: 4 });     // 3000 ₸, прибыль 80
    const cart = await pos.addToCart(accountId, s.id, { productId: ctx.milk, qty: 2 });  // 1000 ₸, прибыль 400
    await pos.pay(accountId, s.id, [{ method: i % 2 ? 'card' : 'cash', amount: Number(cart.total), received: Number(cart.total) }]);
  }
  // 1 чек с сыром — редкий, но маржинальный
  const sc = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ctx.cashier });
  const cheeseCart = await pos.addToCart(accountId, sc.id, { productId: ctx.cheese, qty: 1 });
  await pos.pay(accountId, sc.id, [{ method: 'qr', amount: Number(cheeseCart.total) }]);
  // 1 чек с жвачкой
  const sg = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ctx.cashier });
  const gumCart = await pos.addToCart(accountId, sg.id, { productId: ctx.gum, qty: 1 });
  const gumSale = await pos.pay(accountId, sg.id, [{ method: 'cash', amount: Number(gumCart.total), received: 100 }]);

  // ============ 8.1 ДАШБОРД ДНЯ ============
  const d = await rep.dashboardDay(accountId, today);
  ok(d.receipts === 12, `Чеков за день: ${d.receipts} — это покупатели`);
  ok(near(d.itemsSold, 62), `Позиций продано: ${d.itemsSold} штук — это и есть «Количество продаж» в определении UMAG`);
  ok(near(d.revenue, 43100), `Выручка: ${d.revenue} ₸`);
  ok(near(d.avgReceipt, Math.round(43100 / 12 * 100) / 100),
     `★ Средний чек = Выручка / чеки = ${d.avgReceipt} ₸`);
  ok(!near(d.avgReceipt, 43100 / 62),
     `★ Если считать «Выручка / количество продаж» по букве определения UMAG, вышло бы ${Math.round(43100 / 62)} ₸ — это средняя цена позиции, а не средний чек`);
  ok(near(d.avgItemsPerReceipt, Math.round(62 / 12 * 100) / 100), `Позиций в чеке: ${d.avgItemsPerReceipt} — показывает, работает ли допродажа`);
  // сигареты 40×730 + молоко 20×300 + сыр 1×1500 + жвачка 1×95 = 36 795
  ok(near(d.cost, 36795), `Себестоимость: ${d.cost} ₸`);
  ok(near(d.grossProfit, 43100 - 36795), `★ Валовая прибыль = Выручка − Себестоимость = ${d.grossProfit} ₸ (формула UMAG)`);
  ok(d.marginPercent > 0, `Рентабельность: ${d.marginPercent}%`);
  ok(near(d.payments.cash, 20100) && near(d.payments.card, 20000) && near(d.payments.qr, 3000),
     'Оплаты разложены по способам');

  // возврат уменьшает выручку
  await pos.refund(accountId, { saleId: gumSale.id, shiftId: sh.id, employeeId: ctx.cashier });
  const d2 = await rep.dashboardDay(accountId, today);
  ok(near(d2.revenue, 43000) && d2.refunds.count === 1, `Возврат учтён: выручка ${d2.revenue} ₸, возвратов ${d2.refunds.count}`);

  // ★ ЖИВОЙ ДАШБОРД
  notified.length = 0;
  rep.notifyDashboard(accountId);
  ok(notified.length === 1 && notified[0].m.type === 'dashboard_update',
     '★ Дашборд живой: сервер сам толкает обновление владельцу (у UMAG «Главную» надо перезагружать)');

  // график выручки
  const chart = await rep.revenueChart(accountId, rep.quickPeriod('week'));
  ok(chart.length === 7, `График за неделю: ${chart.length} дней (UMAG: «сумма выручки за каждый отдельный день»)`);
  ok(near(chart[chart.length - 1].revenue, 43000), 'Сегодняшний день в графике сходится с дашбордом');

  // ============ ТАБЛИЦА «СЧЕТА» (Главная UMAG) ============
  const accs = await fin.accounts(accountId);
  const cash = accs.items.find((a) => a.kind === 'cash');
  await fin.bindPaymentMethod(accountId, { method: 'cash', finAccountId: cash.id });
  const board = await rep.accountsBoard(accountId);
  ok(board.length === 2 && board.every((b) => b.allow_negative === false),
     'Таблица «Счета»: колонка «разрешён ли отрицательный баланс» (UMAG), по умолчанию запрещено');

  await fin.expense(accountId, { finAccountId: cash.id, amount: 0.01 }).catch(() => {});
  await tx(async (c) => c.query(`UPDATE fin_balance SET balance = -500 WHERE fin_account_id=$1`, [cash.id]));
  const board2 = await rep.accountsBoard(accountId);
  ok(board2.find((b) => b.id === cash.id).problem,
     'Минус на наличном счёте помечен как проблема — в денежном ящике так не бывает');
  await tx(async (c) => c.query(`UPDATE fin_account SET allow_negative=true WHERE id=$1`, [cash.id]));
  const board3 = await rep.accountsBoard(accountId);
  ok(!board3.find((b) => b.id === cash.id).problem,
     'Если владелец осознанно разрешил минус (овердрафт) — предупреждения нет');
  await tx(async (c) => c.query(`UPDATE fin_account SET allow_negative=false WHERE id=$1`, [cash.id]));
  await db.raw(`SELECT recalc_fin_balance($1,$2)`, [accountId, cash.id]);

  // ============ СИНХРОНИЗАЦИЯ КАСС (светофор UMAG) ============
  const dev = await tx(async (c) => (await c.query(
    `INSERT INTO device (account_id, cash_register_id, name, platform, token_hash, paired_at, last_seen_at)
     VALUES ($1,$2,'Касса 1','windows','x',now(),now()) RETURNING id`, [accountId, ctx.reg])).rows[0].id);
  let sb = await rep.syncBoard(accountId);
  ok(sb[0].status === 'green' && /На связи/.test(sb[0].message), 'Светофор синхронизации: зелёный — касса на связи');
  await tx(async (c) => c.query(`UPDATE device SET last_seen_at = now() - interval '10 minutes' WHERE id=$1`, [dev]));
  sb = await rep.syncBoard(accountId);
  ok(sb[0].status === 'yellow', 'Жёлтый — связи нет 10 минут (у UMAG жёлтый значок «в процессе»)');
  await tx(async (c) => c.query(`UPDATE device SET last_seen_at = now() - interval '2 hours' WHERE id=$1`, [dev]));
  sb = await rep.syncBoard(accountId);
  ok(sb[0].status === 'red' && /Не выходит на связь/.test(sb[0].message),
     'Красный — касса пропала на 2 часа. Владелец узнаёт сразу, а не на инвентаризации');

  // последние изменения
  const rc = await rep.recentChanges(accountId);
  ok(rc.length >= 1 && rc[0].doc_kind === 'supply', 'Таблица «Последние изменения»: документ, статус, кто и когда (UMAG)');

  // ============ 8.2 СТАТИСТИКА ПРОДАЖ — 5 разрезов UMAG ============
  const byProduct = await rep.salesByProduct(accountId, today);
  ok(byProduct.length === 4, `По товарам: ${byProduct.length} позиции`);
  const milk = byProduct.find((p) => p.name === 'Молоко');
  ok(near(milk.qtySold, 20) && near(milk.revenue, 10000) && near(milk.profit, 4000),
     `Молоко: продано ${milk.qtySold}, выручка ${milk.revenue}, прибыль ${milk.profit} ₸`);
  ok(near(milk.marginPercent, 40) && near(milk.markupPercent, 66.67),
     `Рентабельность ${milk.marginPercent}% и наценка ${milk.markupPercent}% — обе колонки UMAG, и это разные числа`);
  ok(milk.barcode !== undefined && milk.unit === 'шт' && milk.category === 'Молочное',
     'В отчёте штрихкод, единица измерения и категория (колонки UMAG)');

  const byCat = await rep.salesBy(accountId, 'category', today);
  ok(byCat.length === 2 && byCat[0].name === 'Табак', `По категориям: ${byCat.map((c) => c.name).join(', ')}`);
  const bySup = await rep.salesBy(accountId, 'supplier', today);
  ok(bySup.length === 1 && bySup[0].name === 'Караван', 'По поставщикам: видно, чьи товары продаются (сценарий UMAG)');
  const byReceipt = await rep.salesByReceipt(accountId, today);
  ok(byReceipt.length === 13 && byReceipt.some((r) => r.is_refund), 'По чекам: все чеки, включая возврат');
  ok(byReceipt.every((r) => r.cashier === 'Марат'), 'В каждом чеке виден кассир');

  // ============ 8.3 ABC — модель UMAG (две оценки + свод) ============
  const abc = await rep.abc(accountId, today);
  ok(abc.items.length === 4, `ABC: ${abc.items.length} товара`);
  const cig = abc.items.find((i) => i.name === 'Сигареты');
  const cheese = abc.items.find((i) => i.name === 'Сыр');
  ok(cig.abcRevenue === 'A', `Сигареты по розничной цене — группа ${cig.abcRevenue} (гонят оборот)`);
  ok(cig.abcProfit !== 'A', `Но по прибыли — группа ${cig.abcProfit}`);
  ok(cig.abcCombined === 'A' + cig.abcProfit, `★ Свод «${cig.abcCombined}» — комбинация двух оценок (колонка UMAG)`);
  ok(/закупочную цену/.test(cig.hint), `★ Подсказка словами: «${cig.hint}» — две буквы владельцу ничего не говорят`);
  ok(cheese.abcProfit === 'A' || cheese.abcProfit === 'B', `Сыр по прибыли — группа ${cheese.abcProfit}: продаётся редко, но маржа высокая`);
  ok(abc.items.every((i) => i.abcRevenue && i.abcProfit && i.abcCombined), 'У каждого товара обе оценки и свод');
  ok(abc.attention.length >= 1, `Отдельно выделены товары, требующие внимания: ${abc.attention.length}`);
  ok(cig.markupPercent > 2 && cig.markupPercent < 3,
     `Наценка сигарет ${cig.markupPercent}% — вот почему они в группе ${cig.abcProfit} по прибыли`);

  const abcDairy = await rep.abc(accountId, today, ctx.dairy);
  ok(abcDairy.items.length === 2 && !abcDairy.items.some((i) => i.name === 'Сигареты'),
     'ABC только по выбранной категории (фильтр «Категории» UMAG)');

  // ============ 8.4 СМЕНЫ И КАССИРЫ ============
  await pos.cashOperation(accountId, { shiftId: sh.id, kind: 'deposit', amount: 1000, employeeId: ctx.cashier });
  const x = await pos.xReport(accountId, sh.id);
  await pos.closeShift(accountId, sh.id, { employeeId: ctx.cashier, actualCash: x.expectedCash - 200, comment: 'Ошиблась сдачей' });

  const cash1 = await rep.cashiers(accountId, today);
  const marat = cash1.find((c) => c.name === 'Марат');
  ok(marat.receipts === 12 && near(marat.sales, 43100), `Кассир Марат: ${marat.receipts} чеков на ${marat.sales} ₸ («Сумма по продажам» UMAG)`);
  ok(near(marat.cashless, 23000), `Безнал ${marat.cashless} ₸ (колонка UMAG)`);
  ok(near(marat.refunds, 100) && near(marat.total, 43000),
     `★ Итого = Продажи − Возвраты = ${marat.total} ₸ (формула UMAG)`);
  ok(near(marat.shiftReports, x.expectedCash - 200), `«Сумма по отчётам»: конечные остатки смен = ${marat.shiftReports} ₸ (колонка UMAG)`);
  ok(marat.discrepancies.count === 1 && near(marat.discrepancies.sum, -200),
     `★ Наше добавление: расхождение в 1 смене на ${marat.discrepancies.sum} ₸ — ради этого отчёт и открывают`);
  ok(marat.flags.length >= 1 && /Расхождения/.test(marat.flags[0]), `Отметка для владельца: «${marat.flags[0]}»`);

  const shifts = await rep.shifts(accountId, today);
  ok(shifts.length === 1 && shifts[0].discrepancy_comment === 'Ошиблась сдачей', 'Список смен с объяснением расхождения');

  const det = await rep.shiftDetail(accountId, sh.id);
  ok(det.cash.opening === 5000, `Детальный отчёт по смене (вкладка «Обзор» UMAG): остаток на начало ${det.cash.opening} ₸`);
  ok(det.cash.income > 0 && det.cash.outcome >= 0, `Приход ${det.cash.income} ₸, расход ${det.cash.outcome} ₸`);
  ok(det.cash.expected === x.expectedCash && det.cash.discrepancy === -200,
     `Остаток на конец ${det.cash.expected} ₸ «включая разницу, если есть»: ${det.cash.discrepancy} ₸`);
  ok(det.revenue.cash > 0 && det.revenue.card > 0 && det.revenue.qr > 0, 'Выручка отдельно наличными, безналом и QR');

  // ============ 8.5 ПРИБЫЛЬНОСТЬ ПО ТОВАРАМ ============
  const prof = await rep.profitability(accountId, today);
  ok(prof.top[0].name === 'Молоко', `Топ по прибыли: ${prof.top[0].name} (${prof.top[0].profit} ₸) — а не сигареты, которые дают оборот`);
  ok(prof.zeroMargin.some((z) => z.name === 'Сигареты'),
     'Сигареты попали в «почти нулевая маржа» — оборот есть, зарабатываем копейки');
  ok(near(prof.totalProfit, 6300), `Общая прибыль ${prof.totalProfit} ₸ (43 000 выручки − 36 700 себестоимости)`);

  // ============ 8.6 СВОДНЫЙ ОТЧЁТ ПО ККМ (идея Wipon) ============
  await tx(async (c) => c.query(
    `INSERT INTO kkm (account_id, cash_register_id, store_id, provider, mode, reg_number, serial_number)
     VALUES ($1,$2,$3,'none','all','600900123456','SN-0001')`, [accountId, ctx.reg, ctx.store]));
  const sum = await rep.kkmSummary(accountId, ctx.reg, today);
  ok(sum.organization === 'Магазин Отчёты' && sum.kkm.regNumber === '600900123456' && sum.kkm.serial === 'SN-0001',
     'Сводный отчёт: данные организации и ККМ (РНМ, ЗНМ) — пункт 1 списка Wipon');
  ok(sum.sales.count === 12 && near(sum.sales.sum, 43100) && sum.refunds.count === 1,
     `Суммы продаж и возвратов: ${sum.sales.count} чеков на ${sum.sales.sum} ₸, возвратов ${sum.refunds.count}`);
  ok(near(sum.payments.cash, 20100) && near(sum.payments.card, 20000) && near(sum.payments.qr, 3000),
     'Движение денег по типам оплаты (пункт Wipon)');
  ok(near(sum.cashOps.deposits, 6000) && near(sum.cashOps.withdrawals, 0),
     `Операции внесения и изъятия: внесено ${sum.cashOps.deposits} ₸ (размен 5000 + внесение 1000)`);
  ok(sum.cash.opening === 5000 && near(sum.cash.closing, x.expectedCash - 200),
     `★ Остаток в кассе на начало ${sum.cash.opening} ₸ и на конец ${sum.cash.closing} ₸ (пункт Wipon)`);
  ok(sum.sections.length === 2 && sum.sections[0].section === 'Табак',
     `Разбивка оборотов по секциям: ${sum.sections.map((s) => s.section).join(', ')} (у Wipon секции ККМ — у нас категории)`);
  ok(sum.shifts === 1, 'Количество смен за период');

  const receipt = await rep.kkmSummaryReceipt(accountId, ctx.reg, today);
  ok(/СВОДНЫЙ ОТЧЁТ/.test(receipt.text) && /РНМ: 600900123456/.test(receipt.text),
     '★ Печать сводного отчёта на чековой ленте — как у Wipon (переиспользуем ESC/POS из Части 5)');
  ok(/В кассе на конец:/.test(receipt.text) && /ПО СЕКЦИЯМ/.test(receipt.text), 'На ленте есть остатки и секции');
  ok(receipt.text.split('\n').every((l) => l.length <= 32), 'Всё влезает в 32 символа чековой ленты');

  // быстрые фильтры Wipon
  const q = rep.quickPeriod('prev_month');
  ok(new Date(q.to) < new Date(), 'Быстрый фильтр «прошлый месяц» (Wipon)');
  const qq = rep.quickPeriod('quarter');
  ok(new Date(qq.from).getMonth() % 3 === 0, 'Быстрый фильтр «квартал» (Wipon)');

  // ============ 8.7 ★ МОБИЛЬНЫЙ РЕЖИМ ВЛАДЕЛЬЦА ============
  const m = await rep.ownerMobile(accountId);
  ok(near(m.today.revenue, 43000) && m.today.receipts === 12,
     `★ Показатели магазина в кармане: выручка ${m.today.revenue} ₸, ${m.today.receipts} чеков (главная фишка UMAG — паритет)`);
  ok(m.today.avgReceipt > 0 && m.today.grossProfit > 0, 'Средний чек и валовая прибыль в телефоне');
  ok(m.vsYesterday !== undefined, 'Сравнение со вчера — первое, что хочет знать владелец');
  ok(m.week.length === 7, 'График недели одним запросом');
  ok(m.money.total !== undefined && m.money.accounts.length === 2, 'Сколько денег и где');
  ok(Array.isArray(m.problems) && m.problems.some((p) => /Касса «Касса 1»/.test(p)),
     `★ Проблемы вынесены наверх: «${m.problems[0]}» — владелец видит их, не листая отчёты`);
  ok(m.topProducts.length === 4 && m.topProducts[0].name, 'Топ товаров дня');

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  const foreign = await rep.dashboardDay(acc2.account_id, today);
  ok(foreign.revenue === 0 && foreign.receipts === 0, 'Чужой аккаунт видит свои нули, а не нашу выручку');
  const foreignAbc = await rep.abc(acc2.account_id, today);
  ok(foreignAbc.items.length === 0, 'И пустой ABC');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
