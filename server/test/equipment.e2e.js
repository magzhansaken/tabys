/**
 * ЧАСТЬ 11 — ОБОРУДОВАНИЕ.
 * Главное: диагностика внутри программы, а не внешней утилитой (МойСклад
 * отправляет за утилитой АТОЛ) и не «переберите порты» (Wipon).
 */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { EquipmentService, MockScaleDriver, TsplPrinter, weightBarcode, parseWeightBarcode, ean13CheckDigit, splitName } = require('../dist/equipment/equipment.service');
  const { PosService } = require('../dist/pos/pos.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const { FiscalService } = require('../dist/fiscal/fiscal.service');

  const db = new DbService();
  const goods = new GoodsService(db);
  const svc = new EquipmentService(db);
  const pos = new PosService(db, goods);
  const stock = new StockService(db, new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 }), goods);
  const scale = new MockScaleDriver();
  svc.registerScaleDriver('rongta', scale);
  svc.registerScaleDriver('mock', scale);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Магазин Оборудование','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  const ctx = await tx(async (c) => {
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    const kg = (await c.query(`SELECT id FROM unit WHERE short_name='кг' LIMIT 1`)).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const g = {};
    // весовые товары — им место в памяти весов
    for (const [k, name, price, kind, unit] of [
      ['apple', 'Яблоки Голден', 890, 'weight', kg],
      ['tomato', 'Помидоры розовые бакинские отборные', 1490, 'weight', kg],
      ['meat', 'Говядина лопатка', 3200, 'weight', kg],
      ['milk', 'Молоко', 500, 'simple', sht],
    ]) {
      const id = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, purchase_price) VALUES ($1,$2,$3::product_kind,$4,100) RETURNING id`, [accountId, name, kind, unit])).rows[0].id;
      await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,$4)`, [accountId, id, rt, price]);
      g[k] = id;
    }
    return { store, wh, reg, ...g };
  });

  // ============ ВЕСОВОЙ ШТРИХКОД ============
  ok(ean13CheckDigit('590123412345') === '7', 'Контрольная цифра EAN-13 считается верно (эталонный код стандарта 5901234123457)');
  ok(ean13CheckDigit('487000000001') === '2', 'И на другом коде');
  const wb = weightBarcode(15, 1234);
  ok(wb.length === 13 && wb.startsWith('22'), `Весовой штрихкод: ${wb} — ровно 13 цифр (префикс 22 = весовой)`);
  ok(ean13CheckDigit(wb.slice(0, 12)) === wb[12], 'Контрольная цифра в весовом коде верная — иначе сканер его не примет');
  const parsed = parseWeightBarcode(wb);
  ok(parsed.plu === 15 && parsed.grams === 1234 && near(parsed.kg, 1.234),
     `★ Касса разобрала код с весов: товар ${parsed.plu}, вес ${parsed.kg} кг. Весы печатают — касса читает`);
  ok(parseWeightBarcode('4870000000017') === null, 'Обычный штрихкод не считается весовым');
  ok(parseWeightBarcode('123') === null, 'Мусор отклонён');

  // ============ 11.1 ВЕСЫ: ПОДКЛЮЧЕНИЕ ============
  let noIp = false;
  try { await svc.add(accountId, { kind: 'scales_print', name: 'Весы', connection: 'lan' }); }
  catch (e) { noIp = /IP-адрес/.test(e.message); }
  ok(noIp, 'Весы по сети без IP не добавить — система говорит, где его взять');

  const eq = await svc.add(accountId, {
    kind: 'scales_print', name: 'Весы овощной отдел', vendor: 'rongta', model: 'RLS1000',
    connection: 'lan', ip: '192.168.1.50', port: 8000, cashRegisterId: ctx.reg,
  });
  ok(eq.ip_address === '192.168.1.50' && eq.port === 8000, 'Весы Rongta подключены по LAN (схема Wipon)');

  const found = await svc.discover(accountId, '192.168.1.', { port: 8000 });
  ok(found.scanned === 254 && found.found.length === 254,
     `★ Программа сама опросила подсеть: ${found.scanned} адресов. Wipon предлагает открыть CMD, выполнить «arp -a» и подобрать адрес руками`);
  scale.online = false;
  const empty = await svc.discover(accountId, '192.168.1.');
  ok(empty.found.length === 0, 'Весов в сети нет — поиск честно пуст');
  scale.online = true;

  // ============ ★ ВЫГРУЗКА PLU ============
  const assign = await svc.autoAssign(accountId, eq.id);
  ok(assign.assigned === 3 && !assign.items.some((i) => i.product === 'Молоко'),
     `★ Автоназначение: ${assign.assigned} весовых товара разложены по ячейкам. Молока среди них нет — оно штучное. У Wipon: «выберите ячейку → назначьте товар» по одному мышкой`);
  ok(assign.items[0].cell === 1 && assign.items[1].cell === 2, 'Ячейки заняты по порядку — человек не должен помнить, какая свободна');

  const long = await tx(async (c) => (await c.query(
    `SELECT name_line1, name_line2 FROM scale_plu s JOIN product p ON p.id=s.product_id
      WHERE p.name LIKE 'Помидоры%'`)).rows[0]);
  ok(long.name_line1 === 'Помидоры розовые' && /бакинские/.test(long.name_line2),
     `★ Длинное имя разрезано по словам: «${long.name_line1}» / «${long.name_line2}» — на экране весов мало места`);
  ok(splitName('Яблоки')[1] === undefined, 'Короткое имя не режется');

  let notWeight = false;
  try { await svc.assignCell(accountId, { equipmentId: eq.id, cell: 99, productId: ctx.milk }); }
  catch (e) { notWeight = /продаётся штуками/.test(e.message); }
  ok(notWeight, 'Штучный товар в память весов не положить — система объясняет, почему');

  const up = await svc.uploadPlu(accountId, eq.id);
  ok(up.uploaded === 3 && scale.memory.length === 3, `★ Выгружено в весы: ${up.uploaded} товара одной кнопкой`);
  ok(scale.memory[0].name1 && scale.memory[0].price > 0 && scale.memory[0].cell === 1, 'В памяти весов ячейка, имя и цена');

  // ★ цены меняются каждый день — весы должны это узнать
  const diff0 = await svc.pluDiff(accountId, eq.id);
  ok(!diff0.needsUpload, 'Сразу после выгрузки расхождений нет');

  await tx(async (c) => c.query(
    `UPDATE product_price SET value = 990 WHERE product_id=$1`, [ctx.apple]));
  const diff1 = await svc.pluDiff(accountId, eq.id);
  ok(diff1.needsUpload && diff1.priceChanged.length === 1 && diff1.priceChanged[0].actual === 990,
     `★ Цена яблок изменилась: в весах ${diff1.priceChanged[0].inScale} ₸, в каталоге ${diff1.priceChanged[0].actual} ₸. Иначе весы печатают вчерашнюю цену`);
  const sync = await svc.syncPrices(accountId, eq.id);
  ok(sync.updated === 1, 'Цены в ячейках обновлены из каталога');
  await svc.uploadPlu(accountId, eq.id);
  ok(!(await svc.pluDiff(accountId, eq.id)).needsUpload, 'После выгрузки расхождений снова нет');

  // новый весовой товар
  await tx(async (c) => {
    const kg = (await c.query(`SELECT id FROM unit WHERE short_name='кг' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const id = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, purchase_price) VALUES ($1,'Виноград','weight',$2,600) RETURNING id`, [accountId, kg])).rows[0].id;
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,1200)`, [accountId, id, rt]);
  });
  const diff2 = await svc.pluDiff(accountId, eq.id);
  ok(diff2.notAssigned.length === 1 && diff2.notAssigned[0].name === 'Виноград',
     'Новый весовой товар виден как неназначенный — не потеряется');

  scale.failUpload = true;
  let uploadFail = false;
  try { await svc.uploadPlu(accountId, eq.id); } catch (e) { uploadFail = /отклонили таблицу/.test(e.message); }
  ok(uploadFail, 'Ошибка выгрузки не молчит');
  scale.failUpload = false;

  // ============ 11.2 ПРИНТЕР ЭТИКЕТОК ============
  const printer = await svc.add(accountId, {
    kind: 'label_printer', name: 'Xprinter XP-365B', vendor: 'xprinter', model: 'XP-365B',
    connection: 'usb', cashRegisterId: ctx.reg, settings: { widthMm: 58, heightMm: 40 },
  });
  const test = await svc.printTestLabel(accountId, printer.id);
  ok(/SIZE 58 mm,40 mm/.test(test.commands) && /BARCODE/.test(test.commands) && test.language === 'TSPL',
     'Пробная этикетка на языке TSPL (Xprinter, Gprinter)');
  ok(/иероглифы/.test(test.hint), `★ Подсказка сразу: «${test.hint.slice(0, 60)}...»`);

  const label = await svc.labelCommands(accountId, {
    equipmentId: printer.id, name: 'Яблоки Голден', price: 990, barcode: '2200150012347', weight: 1.234, date: '17.07',
  });
  ok(/Яблоки Голден/.test(label) && /990.00 T/.test(label) && /1.234 kg/.test(label),
     'Этикетка товара: название, цена, вес');
  ok(/PRINT 1,1/.test(label) && /CLS/.test(label), 'Команды печати сформированы');
  ok(/GAPDETECT/.test(TsplPrinter.calibrate()), 'Калибровка — командой, а не кнопкой PAUSE вручную');
  ok(/OFFSET 2 mm/.test(TsplPrinter.offset(2, 3)), 'Смещение печати задаётся из программы (у Wipon — руками в настройках)');

  // ★ база типовых проблем из статьи Wipon
  const tr = svc.troubleshoot('hieroglyphs');
  ok(/режиме чека/.test(tr.cause) && tr.steps.length === 4 && /PAUSE/.test(tr.steps[1]),
     `★ Иероглифы: «${tr.cause}» + ${tr.steps.length} шага. Это знание из статьи Wipon перенесено в программу`);
  const tr2 = svc.troubleshoot('shifted');
  ok(/калибровка/i.test(tr2.cause) && /Смещение/.test(tr2.steps[1]), 'Смещение печати: причина и шаги');
  const tr3 = svc.troubleshoot('skips_labels');
  ok(/датчик/i.test(tr3.cause), 'Пропуск этикеток: датчики');
  let unknownSym = false;
  try { svc.troubleshoot('нечто'); } catch { unknownSym = true; }
  ok(unknownSym, 'Неизвестный симптом отклонён');

  // ============ 11.3 ВТОРОЙ ЭКРАН ============
  const sup = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId });
  await stock.addItem(accountId, sup.id, { productId: ctx.apple, qty: 50, price: 600 });
  await stock.addItem(accountId, sup.id, { productId: ctx.milk, qty: 50, price: 300 });
  await stock.process(accountId, sup.id);

  const sh = await pos.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ownerId, openingFloat: 5000 });
  const sale = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  await pos.addToCart(accountId, sale.id, { productId: ctx.apple, qty: 1.234 });
  await pos.addToCart(accountId, sale.id, { productId: ctx.milk, qty: 2 });

  const disp = await svc.customerDisplay(accountId, sale.id);
  ok(disp.items.length === 2 && disp.lastItem.name === 'Молоко',
     '★ Второй экран: покупатель видит, что пробивают. Последняя позиция крупно — на неё он смотрит в момент пробития');
  ok(disp.total > 0 && disp.store === 'Магазин Оборудование', `Итого на экране: ${disp.total} ₸`);
  ok(disp.customerBonuses === null, 'Без карты бонусы не показываем');

  const qr = await svc.paymentQr(accountId, sale.id);
  ok(near(qr.amount, disp.total) && !qr.ready && /договор эквайринга с Kaspi/.test(qr.note),
     `★ QR для оплаты: сумма ${qr.amount} ₸ готова, но честно — «${qr.note.slice(0, 45)}...»`);

  // ============ 11.4 ★ МАСТЕР ДИАГНОСТИКИ ============
  const d1 = await svc.diagnose(accountId, { employeeId: ownerId });
  ok(d1.checks.length > 0 && d1.verdict, `Мастер отработал: ${d1.checks.length} проверок, вердикт «${d1.verdict}»`);
  ok(d1.checks.some((c) => c.code === 'device' && c.status === 'warning'),
     'Касса не привязана — мастер это видит');
  ok(d1.checks.some((c) => c.code === 'fiscal' && /ККМ не подключена/.test(c.message)),
     'ККМ не подключена — предупреждение');
  ok(d1.checks.some((c) => c.code === 'scales' && c.status === 'warning' && /данные устарели/.test(c.message)),
     '★ Весы на связи, но виноград не назначен — мастер говорит «Нажмите Выгрузить в весы»');

  // весы отвалились
  scale.online = false;
  const d2 = await svc.diagnose(accountId, { employeeId: ownerId });
  const scalesErr = d2.checks.find((c) => c.code === 'scales' && c.status === 'error');
  ok(scalesErr && /не отвечают/.test(scalesErr.message),
     '★ Весы не отвечают — ошибка, а не молчание');
  ok(/Первые три части адреса должны совпадать с сетью роутера/.test(scalesErr.action),
     `★ И сразу что делать: «${scalesErr.action.slice(0, 60)}...» — это то, что Wipon пишет в статье, а мы говорим в момент проблемы`);
  scale.online = true;

  // ★ непереданные чеки — то, ради чего МойСклад гоняет за утилитой АТОЛ
  await tx(async (c) => {
    const kkmId = (await c.query(
      `INSERT INTO kkm (account_id, cash_register_id, store_id, provider, mode, reg_number)
       VALUES ($1,$2,$3,'none','all','600900123456') RETURNING id`, [accountId, ctx.reg, ctx.store])).rows[0].id;
    await c.query(
      `INSERT INTO fiscal_receipt (account_id, kkm_id, op, status, punched_at)
       VALUES ($1,$2,'sale','pending', now() - interval '80 hours')`, [accountId, kkmId]);
    await c.query(
      `INSERT INTO fiscal_receipt (account_id, kkm_id, op, status, punched_at)
       VALUES ($1,$2,'sale','pending', now())`, [accountId, kkmId]);
  });
  const d3 = await svc.diagnose(accountId, { employeeId: ownerId });
  const fisc = d3.checks.find((c) => c.code === 'fiscal' && c.status === 'error');
  ok(fisc && /не ушли в налоговую больше 72 часов/.test(fisc.message),
     `★ «${fisc.message}» — МойСклад для этого отправляет за утилитой АТОЛ: «отключите ККТ, скачайте из центра загрузок, раскройте таблицу 15»`);
  ok(/Это уже нарушение/.test(fisc.action), 'Кассиру сказано, чем это грозит');

  // ★ минус на счету — учёт разошёлся с реальностью
  const negRows = await tx(async (c) => {
    const r = await c.query(
      `UPDATE fin_balance SET balance = -3000
        WHERE fin_account_id IN (SELECT id FROM fin_account WHERE kind='cash' AND deleted_at IS NULL)`);
    return r.rowCount;
  });
  ok(negRows === 1, `Наличный счёт уведён в минус для проверки (обновлено строк: ${negRows})`);
  const d4 = await svc.diagnose(accountId, { employeeId: ownerId });
  const moneyCheck = d4.checks.find((c) => c.code === 'money');
  ok(moneyCheck && /минус 3000 ₸/.test(moneyCheck.message),
     `Мастер ловит и минус на счету — связка с Частью 7: «${moneyCheck?.message}»`);
  ok(!/минус -/.test(moneyCheck.message), 'Без двойного отрицания: «минус 3000», а не «минус -3000»');

  ok(d4.priority.length > 0 && d4.priority[0].status === 'error',
     `★ Сначала то, что горит: «${d4.priority[0].message.slice(0, 50)}...»`);
  ok(d4.verdict === 'Есть проблемы, которые мешают работать', `Вердикт словами: «${d4.verdict}»`);
  ok(d4.summary.errors > 0 && d4.summary.warnings > 0, `Сводка: ${d4.summary.errors} ошибок, ${d4.summary.warnings} предупреждений`);

  // журнал проверок
  const log = await tx(async (c) => (await c.query(
    `SELECT count(*)::int n FROM equipment_check WHERE account_id=$1`, [accountId])).rows[0].n);
  ok(log > 10, `Журнал диагностики: ${log} записей — видно, что проверяли и когда`);

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  ok((await svc.list(acc2.account_id)).length === 0, 'Чужой аккаунт не видит наше оборудование');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
