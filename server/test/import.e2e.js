/**
 * КРИТЕРИЙ ЧАСТИ 2: «завести 1000 товаров импортом за минуты».
 * Файл Excel настоящий, база живая, замер времени честный.
 */
const XLSX = require('xlsx');
const { Client } = require('pg');
const { randomUUID } = require('crypto');
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { ImportService } = require('../dist/goods/import.service');
  const db = new DbService();
  const svc = new ImportService(db);

  // регистрируем аккаунт напрямую через функцию БД
  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Импорт Тест','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id;

  // ---------- 1. ФАЙЛ НА 1000 ТОВАРОВ (как выгрузка от клиента) ----------
  const cats = ['Молочное', 'Бакалея', 'Напитки', 'Хлеб', 'Бытовая химия'];
  const rows = [['Наименование', 'Штрихкод', 'Код НКТ (NTIN)', 'Категория', 'Единица измерения', 'Цена закупки', 'Цена', 'НДС']];
  for (let i = 1; i <= 1000; i++) {
    rows.push([`Товар номер ${i} — ${cats[i % 5]}`, String(4870200000000 + i), i % 3 === 0 ? String(48702000000 + i) : '',
               cats[i % 5], i % 7 === 0 ? 'кг' : 'шт', 100 + (i % 500), 150 + (i % 700), 12]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Товары');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  ok(buf.length > 0, `Файл Excel на 1000 позиций собран (${Math.round(buf.length / 1024)} КБ)`);

  // ---------- 2. ПРЕДПРОСМОТР ----------
  const prev = await svc.preview(accountId, null, buf, 'nomenklatura.xlsx', true);
  ok(prev.totalRows === 1000, 'Предпросмотр: распознана 1000 строк');
  ok(prev.mapping.name !== undefined && prev.mapping.barcode !== undefined && prev.mapping.ntin !== undefined,
     'Колонки сопоставлены автоматически, включая «Код НКТ (NTIN)» (Wipon требует делать это руками)');
  ok(prev.problems.length === 0, 'Ошибок в файле не найдено', JSON.stringify(prev.problems?.slice(0, 2)));

  // ---------- 3. КРИТЕРИЙ: 1000 ТОВАРОВ ЗА МИНУТЫ ----------
  const r = await svc.run(accountId, prev.sessionId, buf, { matchField: 'barcode', generateBarcodes: false });
  ok(r.created === 1000 && r.errors === 0, `Создано ${r.created} товаров, ошибок ${r.errors}`);
  ok(r.elapsedMs < 60_000, `★ КРИТЕРИЙ ЧАСТИ 2: 1000 товаров импортированы за ${(r.elapsedMs / 1000).toFixed(1)} с`);

  const tx = async (fn) => db.withTenant(accountId, fn);
  const cnt = await tx(async (c) => (await c.query(`SELECT count(*)::int n FROM product WHERE deleted_at IS NULL`)).rows[0].n);
  ok(cnt === 1000, 'В базе ровно 1000 товаров');
  const bc = await tx(async (c) => (await c.query(`SELECT count(*)::int n FROM barcode`)).rows[0].n);
  ok(bc === 1000, 'У каждого товара свой штрихкод');
  const cc = await tx(async (c) => (await c.query(`SELECT count(*)::int n FROM category WHERE deleted_at IS NULL`)).rows[0].n);
  ok(cc === 5, 'Пять категорий созданы из файла на лету');
  const weights = await tx(async (c) => (await c.query(`SELECT count(*)::int n FROM product WHERE kind='weight'`)).rows[0].n);
  ok(weights > 100, `Товары с единицей «кг» распознаны как весовые (${weights} шт)`);
  const prices = await tx(async (c) => (await c.query(`SELECT count(*)::int n FROM product_price`)).rows[0].n);
  ok(prices === 1000, 'Розничные цены проставлены');

  // ---------- 4. ПОВТОРНЫЙ ИМПОРТ = ОБНОВЛЕНИЕ, А НЕ ДУБЛИ ----------
  const rows2 = [rows[0], ...rows.slice(1, 101).map((r) => [r[0] + ' (новая цена)', r[1], r[2], r[3], r[4], r[5], Number(r[6]) + 50, r[7]])];
  const ws2 = XLSX.utils.aoa_to_sheet(rows2); const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, ws2, 'Товары');
  const buf2 = XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' });
  const prev2 = await svc.preview(accountId, null, buf2, 'update.xlsx', true);
  const r2 = await svc.run(accountId, prev2.sessionId, buf2, { matchField: 'barcode' });
  ok(r2.updated === 100 && r2.created === 0, `Повторный импорт обновил 100 позиций и не создал дублей`);
  const total2 = await tx(async (c) => (await c.query(`SELECT count(*)::int n FROM product WHERE deleted_at IS NULL`)).rows[0].n);
  ok(total2 === 1000, 'Товаров по-прежнему 1000 — поиск по штрихкоду сработал (модель МС)');

  // ---------- 5. ОТКАТ ИМПОРТА (нет ни у одного из троих) ----------
  const back = await svc.rollback(accountId, prev2.sessionId);
  ok(back.restored === 100, `Откат вернул прежние значения 100 товарам`);
  const nameBack = await tx(async (c) => (await c.query(`SELECT name FROM product WHERE id=(SELECT product_id FROM import_row WHERE session_id=$1 AND action='updated' LIMIT 1)`, [prev2.sessionId])).rows[0].name);
  ok(!/новая цена/.test(nameBack), 'Название вернулось к прежнему: «' + nameBack + '»');

  // откат создающего импорта: 1000 товаров в архив
  const back2 = await svc.rollback(accountId, prev.sessionId);
  ok(back2.archived === 1000, 'Откат первого импорта отправил все 1000 товаров в архив (МойСклад: «удалить импортом не получится, только вручную»)');
  const alive = await tx(async (c) => (await c.query(`SELECT count(*)::int n FROM product WHERE deleted_at IS NULL`)).rows[0].n);
  ok(alive === 0, 'В номенклатуре чисто — клиент может залить файл заново');

  // ---------- 6. ФАЙЛ С ОШИБКАМИ ----------
  const bad = [['Наименование', 'Штрихкод', 'Цена'], ['', '4870200099999', 100], ['Дубль', '4870200088888', 50], ['Дубль 2', '4870200088888', 60], ['Кривой ШК', 'abc', 70], ['Минус', '4870200099998', -5]];
  const wsB = XLSX.utils.aoa_to_sheet(bad); const wbB = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbB, wsB, 'Товары');
  const bufB = XLSX.write(wbB, { type: 'buffer', bookType: 'xlsx' });
  const prevB = await svc.preview(accountId, null, bufB, 'bad.xlsx', true);
  ok(prevB.problemCount >= 4, `Предпросмотр нашёл ${prevB.problemCount} проблемы ДО импорта: пустое имя, дубль штрихкода, кривой штрихкод, минусовая цена`);
  ok(prevB.problems.some((p) => /повторяется/.test(p.error)), 'Дубль штрихкода внутри файла пойман с номером строки');

  // ---------- 7. ШАБЛОН КАЗАХСТАН ----------
  const tpl = svc.template('kz');
  const tplRows = XLSX.utils.sheet_to_json(XLSX.read(tpl, { type: 'buffer' }).Sheets['Товары'], { header: 1 });
  ok(tplRows[0].includes('Код НКТ (NTIN)'), 'Шаблон «Казахстан» содержит колонку кода НКТ (как у МоегоСклада)');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
