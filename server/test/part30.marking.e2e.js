/**
 * ★ ЧАСТЬ 30 — МАРКИРОВКА (ИС МПТ Казахстан).
 *
 * Полный цикл маркированного товара:
 *  • парсинг DataMatrix (GS1: 01<GTIN>21<серийный>)
 *  • приёмка со сверкой с накладной поставщика (что привезли/не хватает/лишнее)
 *  • продажа → вывод из оборота + журнал
 *  • ЗАЩИТА от двойной продажи одного кода
 *  • возврат маркированного товара в оборот
 *  • реестр остатков по кодам
 */
const { spawn } = require('child_process');

const PORT = '3301';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7704' + Math.floor(1000000 + Math.random() * 8999999);

let TOK = '';
const j = async (method, path, body) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json', ...(TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

// коды DataMatrix: 01 + 14 цифр GTIN + 21 + серийный
const mkCode = (gtin, serial) => `01${gtin}21${serial}`;

(async () => {
  ok(await wait(), 'Сервер поднялся');

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Маркировка Тест', ownerName: 'Нурлан', password: 'Password123' });
  TOK = r.d.access;

  // маркированный товар (обувь)
  r = await j('POST', '/goods', { name: 'Кроссовки', salePrice: 25000, purchasePrice: 15000, barcode: '4870001112223' });
  const pid = r.d.id;

  const GTIN = '04870001112223';
  const c1 = mkCode(GTIN, 'SN0001');
  const c2 = mkCode(GTIN, 'SN0002');
  const c3 = mkCode(GTIN, 'SN0003');

  // ---------- ПРИЁМКА со сверкой ----------
  // накладная поставщика обещала c1, c2, c3; по факту привезли c1, c2 и левый код
  r = await j('POST', '/marking/receive', {
    productId: pid, codes: [c1, c2, mkCode(GTIN, 'SN9999')],
    expectedCodes: [c1, c2, c3] });
  ok(r.d.accepted === 3, `★ Принято 3 кода маркировки`);
  ok(r.d.reconciliation.missing.includes(c3), `★ Сверка: не привезли ${c3.slice(-6)} (есть в накладной)`);
  ok(r.d.reconciliation.unexpected.length === 1, '★ Сверка: 1 лишний код (нет в накладной)');
  ok(r.d.reconciliation.matched === 2, 'Сверка: 2 кода совпали с накладной');

  // кривой код отбивается
  r = await j('POST', '/marking/receive', { productId: pid, codes: ['не-датаматрикс'] });
  ok(r.d.accepted === 0 && r.d.rejected.length === 1, 'Кривой код не принят');

  // дубль кода отбивается
  r = await j('POST', '/marking/receive', { productId: pid, codes: [c1] });
  ok(r.d.accepted === 0 && /уже в системе/.test(r.d.rejected[0].reason), 'Повторный приём кода отбит');

  // ---------- ПРОВЕРКА кода (касса перед продажей) ----------
  r = await j('GET', `/marking/check?code=${encodeURIComponent(c1)}`);
  ok(r.d.found && r.d.sellable && r.d.product === 'Кроссовки', '★ Код проверен: на складе, можно продать');
  r = await j('GET', `/marking/check?code=${encodeURIComponent(mkCode(GTIN, 'NOPE00'))}`);
  ok(r.d.found === false && !r.d.sellable, 'Непринятый код продать нельзя');

  // ---------- ПРОДАЖА → вывод из оборота ----------
  r = await j('POST', '/marking/sell', { code: c1, productId: pid });
  ok(r.d.ok && r.d.gtin === GTIN, `★ Код продан и выведен из оборота (GTIN ${r.d.gtin})`);

  // ЗАЩИТА: повторная продажа того же кода запрещена
  r = await j('POST', '/marking/sell', { code: c1 });
  ok(r.status === 400 && /уже продан/.test(r.d.message), '★ Повторная продажа кода отбита (защита от подмены)');

  // проверка показывает, что продан
  r = await j('GET', `/marking/check?code=${encodeURIComponent(c1)}`);
  ok(r.d.status === 'sold' && !r.d.sellable, 'Проданный код больше не продаётся');

  // ---------- ВОЗВРАТ в оборот ----------
  r = await j('POST', '/marking/return', { code: c1 });
  ok(r.d.ok, '★ Маркированный товар возвращён — код возвращён в оборот');
  // непроданный вернуть нельзя
  r = await j('POST', '/marking/return', { code: c2 });
  ok(r.status === 400 && /проданный/.test(r.d.message), 'Непроданный код вернуть нельзя');

  // ---------- ЖУРНАЛ и ОТЧЁТЫ ----------
  r = await j('GET', '/marking/reports');
  ok(r.d.length === 2 && r.d.some((x) => x.kind === 'withdrawal') && r.d.some((x) => x.kind === 'return'),
     '★ Журнал ИС МПТ: вывод из оборота + возврат');

  r = await j('POST', '/marking/process-queue', {});
  ok(r.d.pending >= 1, `Очередь отправки в ИС МПТ: ${r.d.pending} операций`);

  r = await j('GET', '/marking/stock');
  const row = r.d.find((x) => x.product === 'Кроссовки');
  ok(row && row.inStock === 2 && row.returned === 1,
     `★ Реестр остатков: на складе ${row?.inStock}, возвращено ${row?.returned}`);

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
