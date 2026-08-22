/*
 * ПРОВЕРКА ПРОПУСКОВ.
 *
 * Главное здесь — СМЕННОСТЬ: утренний ушёл, вечерний сел, и вечерний
 * обязан войти ПОД СВОИМ именем.
 */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html>');
global.window = dom.window;
global.TextEncoder = require('util').TextEncoder;
global.crypto = require('crypto').webcrypto;

const { pinPrint, savePass, offlineLogin, passTooOld, login, PASS_DAYS } = require('../renderer/passes.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

/* Хранилище в памяти — как настоящее, но быстрое. */
function makeStore() {
  const box = {};
  return {
    box,
    passSave: async (p, v) => { box[p] = v; },
    passRead: async (p) => box[p] || null,
    passCount: async () => Object.keys(box).length,
  };
}

console.log('═══ ЭТАП 8 · ПРОПУСКА ═══\n');

(async () => {

// ── СЛЕД КОДА ──────────────────────────────────────────────────────
{
  const a = await pinPrint('1111', 'ключ-кассы-1');
  const b = await pinPrint('1111', 'ключ-кассы-2');
  const c = await pinPrint('2222', 'ключ-кассы-1');

  ok(a.length === 64, `След — 64 знака (SHA-256): ${a.slice(0, 16)}…`);
  ok(!a.includes('1111'), '★ Самого кода в следе НЕТ: подобрать нельзя');
  ok(a !== b, '★ Тот же код на ДРУГОЙ кассе даёт другой след: не унести');
  ok(a !== c, 'Другой код — другой след');
  ok(a === await pinPrint('1111', 'ключ-кассы-1'), 'Тот же код и касса — тот же след');
}

// ── СМЕННОСТЬ: ГЛАВНОЕ ─────────────────────────────────────────────
{
  const store = makeStore();
  const KEY = 'ключ-кассы';

  await savePass({ store, pin: '1111', deviceKey: KEY,
    employee: { id: 'e1', name: 'Айгуль' } });
  await savePass({ store, pin: '2222', deviceKey: KEY,
    employee: { id: 'e2', name: 'Ерлан' } });

  const a = await offlineLogin({ store, pin: '1111', deviceKey: KEY });
  const b = await offlineLogin({ store, pin: '2222', deviceKey: KEY });
  const чужой = await offlineLogin({ store, pin: '9999', deviceKey: KEY });

  ok(a && a.employee.name === 'Айгуль', '★ Утренний входит под СВОИМ именем');
  ok(b && b.employee.name === 'Ерлан', '★ Вечерний — под своим, а не под чужим');
  ok(чужой === null, '★ Чужой код не пускает');
}

// ── ПРАВА ЛЕЖАТ В ПРОПУСКЕ ─────────────────────────────────────────
{
  const store = makeStore();
  await savePass({ store, pin: '3333', deviceKey: 'K',
    employee: { id: 'e3', name: 'Старший', isShiftAdmin: true,
      permissions: { pos: { view: true } }, discountLimitPct: 30 } });
  const p = await offlineLogin({ store, pin: '3333', deviceKey: 'K' });

  ok(p.employee.isShiftAdmin === true,
     '★ Без сети видно, что человек СТАРШИЙ: он разрешит отмену сам');
  ok(p.discountLimitPct === 30,
     '★ И его предел скидки — иначе он даст любую, пока лежит роутер');
  ok(p.permissions && p.permissions.pos, 'Права тоже сохранены');
}

// ── СТАРЫЙ ПРОПУСК ─────────────────────────────────────────────────
{
  const свежий = { savedAt: new Date().toISOString() };
  const старый = { savedAt: new Date(Date.now() - 40 * 86400000).toISOString() };
  const месячный = { savedAt: new Date(Date.now() - 29 * 86400000).toISOString() };

  ok(!passTooOld(свежий), 'Сегодняшний пропуск годен');
  ok(!passTooOld(месячный), '29 дней — ещё годен');
  ok(passTooOld(старый), `★ 40 дней — просрочен: уволенный не войдёт`);
  ok(passTooOld(null) && passTooOld({}), 'Пропуска нет — считаем просроченным');
}

// ── ПОЛНЫЙ ПУТЬ ВХОДА ──────────────────────────────────────────────
console.log('\n═══ ВХОД: СЕРВЕР И ПРОПУСК ═══\n');

// 1. Сервер жив, код верный
{
  const store = makeStore();
  const ask = async () => ({ employee: { id: 'e1', name: 'Айгуль' }, permissions: {} });
  const r = await login({ ask, store, settings: {}, deviceToken: 'K', pin: '1111' });
  ok(r.ok && r.from === 'сервер', 'Сервер жив — вошли через него');
  ok((await store.passCount()) === 1, '★ И пропуск выписан на будущее');
}

// 2. Сервер жив, код НЕверный — пропуск не смотрим
{
  const store = makeStore();
  await savePass({ store, pin: '1111', deviceKey: 'K', employee: { id: 'e1', name: 'Айгуль' } });

  const ask = async () => {
    const e = new Error('Код не подошёл'); e.serverAnswered = true; throw e;
  };
  const r = await login({ ask, store, settings: {}, deviceToken: 'K', pin: '1111' });
  ok(!r.ok && r.said === 'Код не подошёл',
     '★ Сервер ЖИВ и отказал — верим ему, пропуск не спасает');
}

// 3. Сервер молчит — входим по пропуску
{
  const store = makeStore();
  await savePass({ store, pin: '2222', deviceKey: 'K', employee: { id: 'e2', name: 'Ерлан' } });

  const ask = async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; };
  const r = await login({ ask, store, settings: {}, deviceToken: 'K', pin: '2222' });
  ok(r.ok && r.from === 'пропуск' && r.employee.name === 'Ерлан',
     '★ Сервер молчит — вошли по пропуску, под своим именем');
}

// 4. Сервер молчит, пропуска нет
{
  const store = makeStore();
  const ask = async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; };
  const r = await login({ ask, store, settings: {}, deviceToken: 'K', pin: '9999' });
  ok(!r.ok && /ещё никто не входил/.test(r.said),
     `★ Первый день без связи — сказано честно: «${r.said}»`);
}

// 5. Сервер молчит, чужой код, но другие входили
{
  const store = makeStore();
  await savePass({ store, pin: '1111', deviceKey: 'K', employee: { id: 'e1', name: 'Айгуль' } });
  const ask = async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; };
  const r = await login({ ask, store, settings: {}, deviceToken: 'K', pin: '9999' });
  ok(!r.ok && /кто уже работал на этой кассе/.test(r.said),
     'Чужой код без связи — отказ с объяснением');
}

// 6. Пропуск просрочен
{
  const store = makeStore();
  const print = await pinPrint('1111', 'K');
  await store.passSave(print, {
    employee: { id: 'e1', name: 'Уволенный' },
    savedAt: new Date(Date.now() - 60 * 86400000).toISOString(),
  });
  const ask = async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; };
  const r = await login({ ask, store, settings: {}, deviceToken: 'K', pin: '1111' });
  ok(!r.ok && /давно не входили при связи/.test(r.said),
     '★ Пропуску два месяца — не пускаем: человека могли уволить');
}

// 7. Живой вход обновляет пропуск
{
  const store = makeStore();
  const print = await pinPrint('1111', 'K');
  await store.passSave(print, {
    employee: { id: 'e1', name: 'Айгуль' },
    savedAt: new Date(Date.now() - 25 * 86400000).toISOString(),
  });
  const ask = async () => ({ employee: { id: 'e1', name: 'Айгуль' } });
  await login({ ask, store, settings: {}, deviceToken: 'K', pin: '1111' });
  const p = await store.passRead(print);
  ok(!passTooOld(p), '★ Живой вход обновил пропуск: кто работает — тот и входит');
}

// ── МОСТ ОТДАЁТ ОБЁРТКУ ───────────────────────────────────────────
(async () => {
  /* НАЙДЕНО ВЛАДЕЛЬЦЕМ: замок не отпирался выданным кодом.
   *
   * Мост кассы отвечает { ok, data }, а offlineLogin читал это как
   * пропуск: employee внутри не виделся, и замок падал на «Cannot read
   * properties of undefined». Кассир вводил ВЕРНЫЙ код и оставался
   * запертым. */
  const диск = {};
  const мост = {
    passSave: async (k, v) => { диск[k] = v; return { ok: true }; },
    passRead: async (k) => ({ ok: true, data: диск[k] || null }),
  };

  await savePass({ store: мост, pin: '1234', deviceKey: 'K',
    employee: { id: 'e1', name: 'Айгуль' } });

  const через = await offlineLogin({ store: мост, pin: '1234', deviceKey: 'K' });
  ok(через && через.employee && через.employee.name === 'Айгуль',
     '★ Через мост пропуск читается: замок отопрётся');

  const чужой = await offlineLogin({ store: мост, pin: '9999', deviceKey: 'K' });
  ok(чужой === null,
     '★ Чужого кода нет — отдаём ПУСТО, а не пустой предмет: иначе впустим кого угодно');

  // И простой склад тоже понимаем — на нём стоят остальные проверки.
  const прямой = {};
  const простой = {
    passSave: async (k, v) => { прямой[k] = v; },
    passRead: async (k) => прямой[k] || null,
  };
  await savePass({ store: простой, pin: '1234', deviceKey: 'K',
    employee: { id: 'e2', name: 'Нурлан' } });
  const п2 = await offlineLogin({ store: простой, pin: '1234', deviceKey: 'K' });
  ok(п2 && п2.employee.name === 'Нурлан',
     '★ Простой склад тоже работает — понимаем оба вида ответа');

  console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
  process.exit(failed ? 1 : 0);
})();
})();
