/**
 * ★ ЧАСТЬ 34 — ПРОВЕРКА КОНТРАГЕНТА (КГД).
 *
 * Проверяем защиту от налоговых рисков:
 *  • надёжный поставщик (плательщик НДС) → risk ok
 *  • не плательщик НДС → warning (НДС к зачёту не примут)
 *  • неблагонадёжный + долг → danger
 *  • не найден в КГД → danger
 *  • статус сохраняется на карточку контрагента
 *  • проверка поставщика приёмки по документу
 */
const { spawn } = require('child_process');

const PORT = '3341';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7708' + Math.floor(1000000 + Math.random() * 8999999);

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

// БИН из 12 цифр; последняя цифра управляет ответом mock-провайдера
const bin = (last) => '07074000806' + last;

(async () => {
  ok(await wait(), 'Сервер поднялся');

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Проверка Тест', ownerName: 'Асхат', password: 'Password123' });
  TOK = r.d.access;

  // ---------- НАДЁЖНЫЙ (плательщик НДС) ----------
  r = await j('POST', '/verification/check', { binOrIin: bin('1'), provider: 'mock' });
  ok(r.d.found && r.d.vatPayer === true && r.d.risk === 'ok',
     `★ Надёжный поставщик: плательщик НДС, риск ${r.d.risk}`);
  ok(r.d.reasons.some((x) => /Плательщик НДС/.test(x)), 'Причина: плательщик НДС без ограничений');

  // ---------- НЕ ПЛАТЕЛЬЩИК НДС ----------
  r = await j('POST', '/verification/check', { binOrIin: bin('8'), provider: 'mock' });
  ok(r.d.found && r.d.vatPayer === false && r.d.risk === 'warning',
     `★ Не плательщик НДС → предупреждение (риск ${r.d.risk})`);
  ok(r.d.reasons.some((x) => /НДС к зачёту не примут/.test(x)),
     '★ Предупреждение: НДС к зачёту не примут (защита от доначислений)');

  // ---------- НЕБЛАГОНАДЁЖНЫЙ + ДОЛГ ----------
  r = await j('POST', '/verification/check', { binOrIin: bin('9'), provider: 'mock' });
  ok(r.d.found && r.d.isUnreliable && r.d.hasTaxDebt && r.d.risk === 'danger',
     `★ Неблагонадёжный + долг → ОПАСНО (риск ${r.d.risk})`);
  ok(r.d.reasons.some((x) => /неблагонадёжных/.test(x)), 'Причина: в реестре неблагонадёжных');

  // ---------- НЕ НАЙДЕН ----------
  r = await j('POST', '/verification/check', { binOrIin: bin('0'), provider: 'mock' });
  ok(r.d.found === false && r.d.risk === 'danger', '★ Не найден в КГД → опасно (проверьте БИН)');

  // ---------- невалидный БИН ----------
  r = await j('POST', '/verification/check', { binOrIin: '123', provider: 'mock' });
  ok(r.status === 400, 'Короткий БИН отбит');

  // ---------- СОХРАНЕНИЕ НА КАРТОЧКУ ----------
  r = await j('POST', '/contragents', { name: 'ТОО Надёжный Партнёр', roles: ['supplier'], iinBin: bin('1') });
  const cpId = r.d.id ?? r.d.counterpartyId;
  r = await j('POST', '/verification/check', { binOrIin: bin('1'), counterpartyId: cpId, provider: 'mock' });
  ok(r.d.risk === 'ok', 'Проверка с привязкой к контрагенту');

  // статус записан в карточку — проверим через историю
  r = await j('GET', `/verification/history?counterpartyId=${cpId}`);
  ok(r.d.length === 1 && r.d[0].vat_payer === true, '★ Статус НДС сохранён в истории контрагента');

  // ---------- ПРОВЕРКА ПОСТАВЩИКА ПРИЁМКИ ----------
  // создаём приёмку с этим поставщиком
  r = await j('GET', '/warehouse/list');
  const whId = (r.d ?? []).find((w) => w.is_primary)?.id ?? r.d[0]?.id;
  r = await j('POST', '/stock/docs', { kind: 'supply', supplierId: cpId, warehouseId: whId });
  const docId = r.d.id;
  r = await j('POST', `/verification/check-supplier/${docId}`, {});
  ok(r.d.risk === 'ok' && r.d.name, `★ Проверка поставщика приёмки: ${r.d.name}, риск ${r.d.risk}`);

  // приёмка с неблагонадёжным поставщиком → danger
  r = await j('POST', '/contragents', { name: 'ТОО Проблемный', roles: ['supplier'], iinBin: bin('9') });
  const badId = r.d.id ?? r.d.counterpartyId;
  r = await j('POST', '/stock/docs', { kind: 'supply', supplierId: badId, warehouseId: whId });
  r = await j('POST', `/verification/check-supplier/${r.d.id}`, {});
  ok(r.d.risk === 'danger', '★ Приёмка от неблагонадёжного поставщика помечена опасной');

  // ---------- ИСТОРИЯ ----------
  r = await j('GET', '/verification/history');
  ok(r.d.length >= 5, `Журнал проверок ведётся (${r.d.length} записей)`);

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
