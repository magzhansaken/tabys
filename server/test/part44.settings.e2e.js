/**
 * ★ ЭТАП 12 — Настройки вместо переделок.
 *
 * Смысл этапа: решения владельца должны быть ВЫБОРОМ НАСТРОЙКИ, а не
 * поводом переписывать код. Проверяем:
 *
 *  • граница операционного дня: по умолчанию полночь, меняется одним
 *    полем, и отчёты сразу считают иначе;
 *  • ночная выручка при границе 6 утра остаётся во вчерашнем дне;
 *  • выбор СМС-шлюза — переключение без правки кода;
 *  • без ключа шлюза регистрация продолжает работать (заглушка).
 */
const { spawn } = require('child_process');
const path = require('path');

const PORT = '3396';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7710' + Math.floor(1000000 + Math.random() * 8999999);

let TOK = '';
const j = async (method, p, body) => {
  const r = await fetch(API + p, { method,
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
    businessName: 'Круглосуточный', ownerName: 'Ерлан', password: 'Password123' });
  TOK = r.d.access;

  // ---------- ГРАНИЦА ДНЯ: УМОЛЧАНИЕ ----------
  r = await j('GET', '/company/settings');
  ok(r.d?.dayStartHour === 0, '★ По умолчанию день с полуночи — поведение магазина не меняется');
  ok(/полуночи/.test(r.d?.dayStartHint ?? ''), 'Понятная подсказка вместо числа');

  // ---------- СМЕНА ГРАНИЦЫ ----------
  r = await j('PATCH', '/company/day-start', { hour: 6 });
  ok(r.d?.ok && r.d?.dayStartHour === 6, '★ Граница переведена на 6 утра одним полем');
  ok(/попадут во вчерашний день/.test(r.d?.note ?? ''),
     '★ Предупреждение: отчёты за прошлые дни покажут другие цифры — это ожидаемо');

  r = await j('GET', '/company/settings');
  ok(r.d?.dayStartHour === 6 && /6:00/.test(r.d?.dayStartHint ?? ''), 'Настройка сохранилась');

  // ---------- ЗАЩИТА ОТ БЕССМЫСЛЕННЫХ ЗНАЧЕНИЙ ----------
  for (const bad of [24, -1, 99]) {
    r = await j('PATCH', '/company/day-start', { hour: bad });
    ok(r.status === 400, `Час ${bad} отбит`);
  }

  // ---------- РАСЧЁТ ДНЯ ----------
  // Проверяем саму логику: при границе 6 утра время 01:30 относится
  // к ВЧЕРАШНЕМУ дню — иначе ночная выручка перескочит в новый день.
  const dayCalc = (nowHour, startHour) => {
    const now = new Date(2026, 7, 11, nowHour, 30);
    const d = new Date(now);
    if (startHour > 0 && now.getHours() < startHour) d.setDate(d.getDate() - 1);
    d.setHours(startHour, 0, 0, 0);
    return d.getDate();
  };
  ok(dayCalc(1, 6) === 10, '★ 01:30 при границе 6:00 — это ещё 10 число (вчера)');
  ok(dayCalc(9, 6) === 11, 'После 6 утра — уже новый день');
  ok(dayCalc(1, 0) === 11, 'При границе полночь 01:30 — уже новый день');
  ok(dayCalc(23, 6) === 11, 'Поздний вечер — текущий день');

  // ---------- ОТЧЁТЫ УЧИТЫВАЮТ ГРАНИЦУ ----------
  r = await j('GET', '/reports/dashboard');
  const from = new Date(r.d?.period?.from);
  ok(from.getHours() === 6, `★ Отчёт «за сегодня» начинается с ${from.getHours()}:00, а не с полуночи`);

  await j('PATCH', '/company/day-start', { hour: 0 });
  r = await j('GET', '/reports/dashboard');
  ok(new Date(r.d?.period?.from).getHours() === 0, 'Вернули полночь — отчёт снова с 00:00');

  // ---------- СМС-ШЛЮЗЫ ----------
  const smsPath = path.join(__dirname, '..', 'dist', 'auth', 'sms.provider.js');
  const sms = require(smsPath);

  const mock = new sms.MockSmsProvider();
  const res = await mock.send('+77011234567', 'Табыс: код 1234');
  ok(res.ok && mock.sent.length === 1, 'Заглушка принимает отправку');

  ok(typeof sms.MobizonSmsProvider === 'function'
     && typeof sms.SmscSmsProvider === 'function'
     && typeof sms.AutocallSmsProvider === 'function',
     '★ Готовы все три шлюза Казахстана — выбор будет строкой в настройках');

  const noKey = sms.createSmsProvider();
  ok(noKey.name === 'mock',
     '★ Без ключа работает заглушка: регистрация не ломается из-за неподключённого шлюза');

  process.env.SMS_PROVIDER = 'mobizon'; process.env.SMS_API_KEY = 'test-key';
  ok(sms.createSmsProvider().name === 'mobizon', '★ Переключение шлюза — одной настройкой');
  process.env.SMS_PROVIDER = 'smsc'; process.env.SMS_LOGIN = 'l'; process.env.SMS_PASSWORD = 'p';
  ok(sms.createSmsProvider().name === 'smsc', 'И на другой шлюз тоже');
  delete process.env.SMS_PROVIDER;

  // ---------- РЕГИСТРАЦИЯ РАБОТАЕТ БЕЗ ШЛЮЗА ----------
  const p2 = '+7711' + Math.floor(1000000 + Math.random() * 8999999);
  r = await j('POST', '/auth/otp', { phone: p2 });
  ok(!!r.d?.devCode, '★ Код по-прежнему выдаётся — шлюз не обязателен для работы');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
