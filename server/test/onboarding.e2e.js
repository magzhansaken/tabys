/**
 * ЧАСТЬ 12 — ОНБОРДИНГ И МИГРАЦИЯ. [РУБЕЖ]
 * У Wipon есть тег «для клиентов Umag» с одной страницей: канал застолблён,
 * но не наполнен. Делаем переезд кнопкой, а не статьёй.
 */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { MigrationService, normalizePhone, parseMoney, KK_TERMS, t } = require('../dist/migration/migration.service');
  const { ContragentService } = require('../dist/contragents/contragent.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const { PosService } = require('../dist/pos/pos.service');

  const db = new DbService();
  const svc = new MigrationService(db);
  const cps = new ContragentService(db);
  const goods = new GoodsService(db);
  const pos = new PosService(db, goods);
  const stock = new StockService(db, new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 }), goods);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Магазин Переезд','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  // ============ ★ РАСПОЗНАВАНИЕ ВЫГРУЗКИ UMAG ============
  // заголовки — из документации UMAG «Список товаров»
  const umagHeaders = ['Наименование', 'Штрихкод', 'Артикул', 'Категория', 'Цена продажи', 'Цена закупки', 'Количество'];
  const umag = svc.detectFormat(umagHeaders);
  ok(umag.source === 'umag' && umag.entity === 'product',
     `★ Файл узнан сам: выгрузка товаров UMAG (уверенность ${umag.confidence}). Wipon заставляет сопоставлять столбцы вручную`);
  ok(umag.recognized === 7 && umag.unknownColumns.length === 0, `Распознаны все ${umag.recognized} колонок`);
  ok(umag.withStock, '★ Определено, что файл «с остатками» — это деление из статьи Wipon');
  ok(umag.missing.length === 0, 'Всё обязательное на месте');

  // ============ ВЫГРУЗКА WIPON (их обязательные поля) ============
  const wiponHeaders = ['Наименование', 'Единица измерения', 'Цена продажи', 'Штрихкод'];
  const wp = svc.detectFormat(wiponHeaders);
  ok(wp.source === 'wipon' && !wp.withStock,
     '★ Выгрузка Wipon «без остатков» — ровно тот набор полей, что в их статье');
  const wpStock = svc.detectFormat([...wiponHeaders, 'Количество', 'Цена закупки']);
  ok(wpStock.source === 'wipon' && wpStock.withStock, 'И «с остатками» — их второй режим');

  // ============ КАЗАХСКИЕ ЗАГОЛОВКИ ============
  const kk = svc.detectFormat(['Атауы', 'Штрихкод', 'Сату бағасы', 'Саны', 'Сатып алу бағасы']);
  ok(kk.recognized === 5 && kk.entity === 'product',
     '★ Казахские заголовки распознаются: файл из казахской версии программы тоже переедет');

  // ============ ПРОИЗВОЛЬНЫЙ ФАЙЛ ============
  const custom = svc.detectFormat(['Товар', 'Цена', 'Мой странный столбец']);
  ok(custom.source === 'custom' && custom.unknownColumns.length === 1,
     'Незнакомая колонка не ломает импорт — уходит в ручное сопоставление');
  const broken = svc.detectFormat(['Столбец A', 'Столбец B']);
  ok(broken.missing.includes('name'), 'Если нет даже названия — честно говорим, чего не хватает');

  // ============ ★ ГАЛОЧКА «ЗАГОЛОВОК» (Wipon просит ставить руками) ============
  ok(svc.looksLikeHeader(['Наименование', 'Штрихкод', 'Цена']),
     '★ Первая строка распознана как заголовки — Wipon просит ставить эту галочку вручную и предупреждает о проблемах');
  ok(!svc.looksLikeHeader(['Молоко 1л', '4870000000017', '500']), 'Строка с данными не принята за заголовок');
  ok(!svc.looksLikeHeader(['1', '2', '3']), 'Строка из чисел — это данные');

  // ============ РАЗБОР ДАННЫХ ============
  ok(normalizePhone('8 707 123 45 67') === '+77071234567', 'Телефон 8-707 приведён к +7');
  ok(normalizePhone('+7 (701) 234-56-78') === '+77012345678', 'И телефон в скобках');
  ok(normalizePhone('7012345678') === '+77012345678', 'И без кода страны');
  ok(normalizePhone('') === null, 'Пустой телефон — это null, а не мусор');
  ok(parseMoney('1 500,50 ₸') === 1500.5, '★ Сумма «1 500,50 ₸» разобрана: в выгрузках пишут как попало');
  ok(parseMoney('1500.5') === 1500.5 && parseMoney(2000) === 2000 && parseMoney('') === 0, 'Другие написания тоже');

  // ============ ★ ДУБЛИ ДО ИМПОРТА ============
  const ctx = await tx(async (c) => {
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const p = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, purchase_price) VALUES ($1,'Молоко 1л','simple',$2,300) RETURNING id`, [accountId, sht])).rows[0].id;
    await c.query(`INSERT INTO barcode (account_id, product_id, code, is_primary) VALUES ($1,$2,'4870000000017',true)`, [accountId, p]);
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,500)`, [accountId, p, rt]);
    return { wh, store, reg, sht, rt, milk: p };
  });

  const mapping = { '0': 'name', '1': 'barcode', '2': 'price' };
  const dupRows = [
    ['Хлеб', '4870000000024', '200'],
    ['Кефир', '4870000000031', '450'],
    ['Хлеб', '4870000000024', '210'],          // тот же штрихкод в файле
    ['Молоко 1л', '4870000000017', '520'],     // уже в базе
  ];
  const dups = await svc.checkDuplicates(accountId, dupRows, mapping);
  ok(dups.inFile.length === 2 && dups.inFile.some((d) => d.kind === 'barcode_in_file'),
     `★ В файле найдены повторы: ${dups.inFile.length}. Два «Хлеба» с одним штрихкодом дадут вечную путаницу в остатках`);
  ok(dups.inBase.length === 2 && dups.inBase.some((d) => d.existing === 'Молоко 1л'),
     'И совпадения с тем, что уже в базе — по штрихкоду и по названию');
  ok(/остатки будут расходиться/.test(dups.hint), `Владельцу сказано, чем это грозит: «${dups.hint}»`);
  const clean = await svc.checkDuplicates(accountId, [['Сок', '4870000000048', '600']], mapping);
  ok(clean.total === 0 && !clean.hint, 'Чистый файл — предупреждений нет');

  // ============ ★ ПЕРЕНОС ДОЛГОВ (чего Wipon не делает) ============
  const debtHeaders = ['Наименование', 'Телефон', 'Сумма долга'];
  const det = svc.detectFormat(debtHeaders);
  ok(det.entity === 'counterparty' && det.source === 'umag',
     '★ Выгрузка покупателей UMAG узнана по колонкам: имя, телефон, долг');

  const cpRows = [
    ['Азамат Серикулы', '8 707 111 22 33', '15 000'],
    ['Марат Оспанов', '+7 (701) 999-88-77', '0'],
    ['Гульнара', '87021234567', '3 500,50'],
    ['', '87055554433', '100'],                   // без имени
  ];
  const dry = await svc.importCounterparties(accountId, {
    rows: cpRows, mapping: { '0': 'name', '1': 'phone', '2': 'debt' },
    source: 'umag', employeeId: ownerId, dryRun: true,
  });
  ok(dry.created === 3 && dry.skipped === 1 && dry.dryRun,
     `★ Пробный прогон: ${dry.created} контрагента будет создано, ${dry.skipped} пропущено — видно ДО записи`);

  const imp = await svc.importCounterparties(accountId, {
    rows: cpRows, mapping: { '0': 'name', '1': 'phone', '2': 'debt' },
    source: 'umag', employeeId: ownerId,
  });
  ok(imp.created === 3 && imp.skipped === 1, `Перенесено ${imp.created} контрагента`);
  ok(imp.debtsTransferred === 2 && near(imp.debtTotal, 18500.5),
     `★ Долги переехали вместе с людьми: ${imp.debtsTransferred} должника на ${imp.debtTotal} ₸. Wipon переносит только номенклатуру`);

  const book = await cps.debtBook(accountId);
  ok(book.items.length === 2 && near(book.total, 18500.5),
     `★ Долги легли в долговую книгу Части 6: ${book.total} ₸ — тетрадка переехала целиком`);
  const azamat = book.items.find((i) => /Азамат/.test(i.name));
  ok(near(azamat.debt, 15000) && azamat.phone === '+77071112233',
     'У Азамата долг 15 000 ₸ и нормализованный телефон');

  const again = await svc.importCounterparties(accountId, {
    rows: cpRows, mapping: { '0': 'name', '1': 'phone', '2': 'debt' }, source: 'umag',
  });
  ok(again.created === 0 && again.skipped === 4,
     '★ Повторный импорт того же файла ничего не задваивает — люди узнаются по телефону');

  // ============ 12.3 ★ МАСТЕР ПЕРВОГО ЗАПУСКА ============
  // чистый аккаунт: сразу после регистрации продавать нечем
  const phFresh = '+7705' + Math.floor(1000000 + Math.random() * 8999999);
  const fresh = (await db.raw(`SELECT * FROM register_account($1,'Свежий','Нурлан','ru')`, [phFresh])).rows[0];
  const st0 = await svc.onboardingState(fresh.account_id);
  ok(st0.steps.length === 9, `Мастер: ${st0.steps.length} шагов`);
  ok(st0.steps.find((s) => s.code === 'store').status === 'done',
     'Магазин и склад созданы при регистрации — шаг уже закрыт');
  ok(!st0.canSell && st0.blockers.length === 2,
     `★ Пока продавать нельзя: ${st0.blockers.join(', ')} — и сказано словами`);
  ok(/Чтобы начать продавать, осталось/.test(st0.message), `Сообщение: «${st0.message}»`);
  ok(st0.nextStep === 'organization', 'Подсказан следующий шаг');

  // у нашего магазина товар с ценой уже есть
  const st1 = await svc.onboardingState(accountId);
  ok(st1.canSell && st1.blockers.length === 0,
     '★ Товар с ценой есть — можно продавать. Остальное настраивается по ходу, мастер ничего не блокирует');
  ok(/Можно продавать/.test(st1.message), `«${st1.message}»`);

  const st2 = await svc.skipStep(accountId, 'equipment');
  ok(st2.steps.find((s) => s.code === 'equipment').status === 'skipped',
     'Шаг можно пропустить: весов у магазина может и не быть');

  // ★ отметка «готово» сама по себе ничего не значит: шаг закрывается фактом
  const st3 = await svc.completeStep(accountId, 'organization', { tin: '950101300123' }, ownerId);
  ok(st3.steps.find((s) => s.code === 'organization').status === 'pending',
     '★ Владелец нажал «готово», но реквизиты не завёл — шаг остался открытым. Галочка без дела не считается');

  await tx(async (c) => c.query(
    `INSERT INTO organization (account_id, type, name, tin, is_default)
     VALUES ($1,'ip','ИП Айгуль','950101300123',true)`, [accountId]));
  const st3b = await svc.onboardingState(accountId);
  ok(st3b.steps.find((s) => s.code === 'organization').status === 'done' && st3b.progress > st1.progress,
     `★ Реквизиты появились — шаг закрылся сам. Готовность: ${st1.progress}% → ${st3b.progress}%`);

  // первая продажа закрывает последний шаг сама
  const sup = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId });
  await stock.addItem(accountId, sup.id, { productId: ctx.milk, qty: 10, price: 300 });
  await stock.process(accountId, sup.id);
  const sh = await pos.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ownerId, openingFloat: 1000 });
  const s = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  const cart = await pos.addToCart(accountId, s.id, { productId: ctx.milk, qty: 1 });
  await pos.pay(accountId, s.id, [{ method: 'cash', amount: Number(cart.total), received: 500 }]);
  const st4 = await svc.onboardingState(accountId);
  ok(st4.steps.find((s) => s.code === 'first_sale').status === 'done' &&
     st4.steps.find((s) => s.code === 'stock').status === 'done',
     '★ Шаги закрываются сами по факту работы, а не по нажатию кнопки «готово»');

  // откуда переехали
  await svc.setSource(accountId, 'umag');
  const src = await tx(async (c) => (await c.query(`SELECT came_from FROM account WHERE id=$1`, [accountId])).rows[0]);
  ok(src.came_from === 'umag', 'Записано, откуда переехал клиент — это нужно поддержке');

  // ============ 12.4 ★ КАЗАХСКАЯ ЛОКАЛИЗАЦИЯ ============
  ok(Object.keys(KK_TERMS).length >= 30, `Словарь терминов: ${Object.keys(KK_TERMS).length} пар из казахского зеркала Wipon`);
  ok(t('esf', 'kk') === 'ЭШФ' && t('snt', 'kk') === 'ТІЖ' && t('avr', 'kk') === 'ОЖА',
     '★ Аббревиатуры документов: ЭСФ→ЭШФ, СНТ→ТІЖ, АВР→ОЖА — их не угадать переводом, это официальные казахские сокращения');
  ok(t('purchase_price', 'kk') === 'Сатып алу бағасы' && t('sale_price', 'kk') === 'Сату бағасы',
     'Цены закупки и продажи — терминами, на которых уже работают казахстанские магазины');
  ok(t('debt_book', 'kk') === 'Қарыз кітабы' && t('stock_balance', 'kk') === 'Тауар қалдықтары',
     'Долговая книга и остатки товаров');
  ok(t('vat', 'kk') === 'ҚҚС' && t('unit', 'kk') === 'Өлшем бірлігі', 'НДС и единица измерения');
  ok(t('with_stock', 'kk') === 'Қалдықтарымен' && t('import_header', 'kk') === 'Тақырып',
     'Термины импорта: «с остатками» и «заголовок»');
  ok(t('esf', 'ru') === 'ЭСФ' && t('неизвестный_ключ') === 'неизвестный_ключ',
     'Русский по умолчанию; неизвестный ключ возвращается как есть, а не падает');

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  const foreign = await svc.onboardingState(acc2.account_id);
  ok(foreign.progress < st4.progress && !foreign.canSell, 'У нового аккаунта свой чистый мастер');
  const foreignDup = await svc.checkDuplicates(acc2.account_id, dupRows, mapping);
  ok(foreignDup.inBase.length === 0, 'И он не видит наши товары при проверке дублей');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
