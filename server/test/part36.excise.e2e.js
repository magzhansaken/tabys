/**
 * ★ ЧАСТЬ 36 — АКЦИЗНЫЕ МАРКИ АЛКОГОЛЯ (УКМ).
 *
 * Проверяем (догоняем Wipon Pro):
 *  • проверка УКМ по серии+номеру → подлинная / не найдена (контрафакт)
 *  • проверка по штрих-коду (парсинг серии+номера)
 *  • приёмка марок со сверкой подлинности (контрафакт не принимается)
 *  • продажа марки → списание
 *  • ЗАЩИТА от повторной продажи одной марки (клон)
 *  • реестр остатков марок
 */
const { spawn } = require('child_process');

const PORT = '3361';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7700' + Math.floor(1000000 + Math.random() * 8999999);

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

(async () => {
  ok(await wait(), 'Сервер поднялся');

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Алко Тест', ownerName: 'Тимур', password: 'Password123' });
  TOK = r.d.access;

  // товар — водка (маркированный алкоголь)
  r = await j('POST', '/goods', { name: 'Водка Тест 0.5л', salePrice: 2500, purchasePrice: 1500, barcode: '4870040001' });
  const vodka = r.d.id;

  // ---------- ПРОВЕРКА УКМ ----------
  // номер оканчивается не на 0 → подлинная
  r = await j('POST', '/excise/check', { series: 'KZ', number: '000000001' });
  ok(r.d.found && r.d.ok && r.d.strength === 40, `★ УКМ подлинная: ${r.d.productName}, крепость ${r.d.strength}%`);

  // номер на 0 → не найдена (контрафакт)
  r = await j('POST', '/excise/check', { series: 'KZ', number: '000000010' });
  ok(r.d.found === false && /контрафакт/.test(r.d.warning), '★ Контрафактная УКМ не найдена в базе');

  // проверка по штрих-коду (серия+номер)
  r = await j('POST', '/excise/check', { barcode: 'KZ000000002' });
  ok(r.d.found && r.d.series === 'KZ' && r.d.number === '000000002', '★ УКМ проверена по штрих-коду (разобран на серию+номер)');

  // кривой штрих-код
  r = await j('POST', '/excise/check', { barcode: 'мусор' });
  ok(r.status === 400, 'Кривой штрих-код УКМ отбит');

  // ---------- ПРИЁМКА МАРОК ----------
  r = await j('POST', '/excise/receive', {
    productId: vodka,
    marks: [{ series: 'KZ', number: '000000101' }, { series: 'KZ', number: '000000102' },
            { series: 'KZ', number: '000000110' }] });  // последняя — контрафакт (на 0)
  ok(r.d.accepted === 2 && r.d.rejected.length === 1, `★ Принято 2 подлинных марки, 1 контрафакт отклонён`);
  ok(/контрафакт/.test(r.d.rejected[0].reason), 'Контрафактная марка отклонена с причиной');

  // повторная приёмка той же марки
  r = await j('POST', '/excise/receive', { productId: vodka, marks: [{ series: 'KZ', number: '000000101' }] });
  ok(r.d.accepted === 0 && /Уже учтена/.test(r.d.rejected[0].reason), 'Повторный приём марки отбит');

  // ---------- ПРОДАЖА МАРКИ ----------
  r = await j('POST', '/excise/sell', { series: 'KZ', number: '000000101' });
  ok(r.d.ok, `★ Марка продана: ${r.d.product}`);

  // ЗАЩИТА: повторная продажа той же марки
  r = await j('POST', '/excise/sell', { series: 'KZ', number: '000000101' });
  ok(r.status === 400 && /уже продана/.test(r.d.message), '★ Повторная продажа марки отбита (защита от клона)');

  // продажа неучтённой марки
  r = await j('POST', '/excise/sell', { series: 'KZ', number: '999999999' });
  ok(r.status === 400 && /не учтена/.test(r.d.message), 'Продажа неучтённой марки отбита');

  // проверка проданной марки показывает already_sold
  r = await j('POST', '/excise/check', { series: 'KZ', number: '000000101' });
  ok(r.d.result === 'already_sold' && /клон/.test(r.d.warning), '★ Проверка проданной марки предупреждает о клоне');

  // ---------- РЕЕСТР И ЖУРНАЛ ----------
  r = await j('GET', '/excise/stock');
  const row = r.d.find((x) => x.product === 'Водка Тест 0.5л');
  ok(row && row.inStock === 1 && row.sold === 1, `★ Реестр марок: на складе ${row?.inStock}, продано ${row?.sold}`);

  r = await j('GET', '/excise/history');
  ok(r.d.length >= 5, `Журнал проверок УКМ ведётся (${r.d.length} записей)`);

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
