/**
 * ★ ЧАСТЬ 23 — БОЕВАЯ ФИСКАЛИЗАЦИЯ.
 *
 * Проверяем не «эндпоинт отвечает», а ЗАЩИТУ ОТ ОШИБКИ, которая губит
 * пилоты: боевой режим нельзя включить, пока не проверена связь с ОФД.
 * Иначе первый же реальный чек уйдёт в никуда — это нарушение закона.
 *
 * Ключевые проверки:
 *  • прод не включается без РНМ/ЗНМ и без проверки связи
 *  • проверка связи меняет готовность кассы
 *  • чек коррекции фискализируется и попадает в журнал
 *  • всё через mock-провайдер (боевые ключи — по договору с оператором)
 */
const { spawn } = require('child_process');

const PORT = '3231';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7707' + Math.floor(1000000 + Math.random() * 8999999);

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
    businessName: 'Фискал Тест', ownerName: 'Бекзат', password: 'Password123' });
  TOK = r.d.access;

  // касса
  r = await j('POST', '/admin/stores/registers', { name: 'Касса 1' });
  const regId = r.d.id;

  // ---------- регистрация ККМ без РНМ (только ключи) ----------
  r = await j('POST', '/fiscal/register', {
    cashRegisterId: regId, provider: 'mock', mode: 'all',
    apiLogin: 'test@shop.kz', apiPassword: 'secret', apiUrl: 'https://sandbox.webkassa.kz', kkmId: 'KKM-TEST-1',
  });
  ok(r.status === 201 || r.status === 200, 'ККМ зарегистрирована в тестовом режиме');
  const kkmId = r.d.id ?? r.d.kkmId;

  // ---------- готовность: пока не готова к бою ----------
  r = await j('GET', '/fiscal/readiness');
  let k = r.d.find((x) => x.kkmId === kkmId) ?? r.d[0];
  ok(k.env === 'test', 'Новая касса стартует в тестовом режиме (боевые чеки не уходят)');
  ok(k.hasCredentials === true, 'Ключи есть');
  ok(k.hasRegNumber === false, 'РНМ/ЗНМ ещё не указаны');
  ok(k.readyForProduction === false, '★ К бою НЕ готова — нет РНМ и не проверена связь');

  // ---------- попытка включить прод без готовности → отказ ----------
  r = await j('POST', '/fiscal/set-env', { kkmId: k.kkmId, env: 'production' });
  ok(r.status === 400 && /РНМ|ЗНМ/.test(r.d.message), '★ Прод без РНМ отбит: ' + r.d.message);

  // ---------- указываем РНМ/ЗНМ (владелец получил их в КНП) ----------
  r = await j('POST', '/fiscal/register', {
    cashRegisterId: regId, provider: 'mock', mode: 'all',
    apiLogin: 'test@shop.kz', apiPassword: 'secret', apiUrl: 'https://sandbox.webkassa.kz', kkmId: 'KKM-TEST-1',
    regNumber: '600900123456', serialNumber: 'SN-KZ-0001',
  });
  ok(r.status === 201 || r.status === 200, 'РНМ и ЗНМ внесены');
  const kkmId2 = r.d.id ?? r.d.kkmId ?? kkmId;

  // прод всё ещё нельзя — связь не проверена
  r = await j('POST', '/fiscal/set-env', { kkmId: kkmId2, env: 'production' });
  ok(r.status === 400 && /связ/.test(r.d.message), '★ Прод без проверки связи отбит: ' + r.d.message);

  // ---------- проверка связи с ОФД (mock отвечает «ок») ----------
  r = await j('POST', '/fiscal/check-connection', { kkmId: kkmId2 });
  ok(r.d.ok === true && /связь/i.test(r.d.message), '★ Проверка связи прошла: ' + r.d.message);
  ok(r.d.checkUrl?.includes('oofd'), 'ОФД вернул адрес проверки чека (для QR): ' + r.d.checkUrl);

  r = await j('GET', '/fiscal/readiness');
  k = r.d.find((x) => x.kkmId === kkmId2) ?? r.d[0];
  ok(k.connectionOk === true && k.readyForProduction === true,
     '★ Теперь касса готова к бою: ключи + РНМ + связь');

  // ---------- включаем боевой режим ----------
  r = await j('POST', '/fiscal/set-env', { kkmId: kkmId2, env: 'production' });
  ok(r.d.ok && r.d.env === 'production' && /боев/.test(r.d.message), '★ Боевой режим включён: ' + r.d.message);

  // обратно в test — всегда можно
  r = await j('POST', '/fiscal/set-env', { kkmId: kkmId2, env: 'test' });
  ok(r.d.ok && r.d.env === 'test', 'Можно вернуться в тест (потренироваться)');
  await j('POST', '/fiscal/set-env', { kkmId: kkmId2, env: 'production' });

  // ---------- чек коррекции ----------
  r = await j('POST', '/fiscal/correction', {
    kkmId: kkmId2, kind: 'income', reason: 'Неучтённая выручка из-за сбоя ККМ 15.07', amount: 5000, cash: 5000 });
  ok(r.d.ok && r.d.fiscalNumber?.startsWith('FC'), '★ Чек коррекции (приход) фискализирован: ' + r.d.fiscalNumber);

  r = await j('POST', '/fiscal/correction', { kkmId: kkmId2, kind: 'income', reason: '', amount: 1000 });
  ok(r.status === 400 && /причин/.test(r.d.message), 'Коррекция без причины отбита (её смотрит налоговая)');

  r = await j('POST', '/fiscal/correction', { kkmId: kkmId2, kind: 'income', reason: 'тест', amount: 0 });
  ok(r.status === 400, 'Коррекция на нулевую сумму отбита');

  r = await j('GET', '/fiscal/corrections');
  ok(r.d.length === 1 && r.d[0].amount === 5000 && r.d[0].status === 'ok',
     `Журнал коррекций: 1 запись на ${r.d[0]?.amount} ₸, статус ${r.d[0]?.status}`);

  // ---------- health по-прежнему работает ----------
  r = await j('GET', '/fiscal/health');
  ok(typeof r.d.healthy === 'boolean', 'Health фискализации отвечает (очередь чеков жива)');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
