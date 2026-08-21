/*
 * ПРОВЕРКА КАНАРЕЙКИ И ОБНОВЛЕНИЯ.
 *
 * Главное: отчёт не роняет кассу второй раз, обновление не идёт
 * посреди смены, откат отбит.
 */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html>');
global.window = dom.window;

const { REPEAT_MS, makeCrashReporter } = require('../renderer/crash.js');
const { isNewer, canUpdate } = require('../electron/updater.cjs');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

console.log('═══ ЭТАП 24 · ПАДЕНИЯ И ОБНОВЛЕНИЕ ═══\n');

(async () => {

// ── ОТЧЁТ УХОДИТ ───────────────────────────────────────────────────
{
  let ушло = null;
  const r = makeCrashReporter({
    fetchIt: async (url, opts) => { ушло = { url, body: JSON.parse(opts.body) }; },
    getSettings: async () => ({ apiUrl: 'https://пример.kz/api', version: '3.0.0' }),
    getState: async () => ({ accountId: 'a1', cashRegisterId: 'r1' }),
  });

  await r.report('Cannot read properties of undefined', 'at drawCart (app.js:812)');
  ok(ушло && /client-error$/.test(ушло.url), 'Отчёт ушёл на сервер');
  ok(ушло.body.message === 'Cannot read properties of undefined', 'С сообщением');
  ok(ушло.body.stack.includes('drawCart'), 'И со следом: видно, где упало');
  ok(ушло.body.version === '3.0.0' && ушло.body.accountId === 'a1',
     '★ И с версией и магазином: одна ошибка у десяти клиентов — наша вина');
}

// ── ДЕДУП: НЕ ЧАЩЕ РАЗА В МИНУТУ ───────────────────────────────────
{
  let раз = 0;
  let t = 1000000;
  const r = makeCrashReporter({
    fetchIt: async () => { раз += 1; },
    getSettings: async () => ({}), getState: async () => ({}),
    now: () => t,
  });

  // Ошибка в цикле отрисовки: десять раз в секунду
  for (let i = 0; i < 10; i += 1) { await r.report('одна и та же беда'); t += 100; }
  ok(раз === 1,
     '★ Десять раз подряд — ОДНО письмо: иначе сервер получит тысячи за смену');

  t += REPEAT_MS + 1;
  await r.report('одна и та же беда');
  ok(раз === 2, 'Через минуту — можно снова: беда не прошла');

  await r.report('другая беда');
  ok(раз === 3, '★ А другая ошибка уходит сразу: дедуп по сообщению');
}

// ── СБОЙ ОТПРАВКИ НЕ РОНЯЕТ КАССУ ──────────────────────────────────
{
  const r = makeCrashReporter({
    fetchIt: async () => { throw new Error('сеть легла'); },
    getSettings: async () => ({}), getState: async () => ({}),
  });
  const итог = await r.report('падение');
  ok(итог === false,
     '★ Отправка не вышла — молча: отчёт о падении не имеет права уронить кассу ВТОРОЙ раз');
}

// ── КАССА УПАЛА ДО ПРИВЯЗКИ ────────────────────────────────────────
{
  let ушло = null;
  const r = makeCrashReporter({
    fetchIt: async (url, o) => { ушло = JSON.parse(o.body); },
    getSettings: async () => ({ apiUrl: 'https://пример.kz/api' }),
    getState: async () => ({}),      // ни токена, ни магазина
  });
  await r.report('упало до привязки');
  ok(ушло && ушло.accountId === null,
     '★ Упала ДО привязки — отчёт всё равно ушёл: это самый тяжёлый случай');
}

// ── ПУСТОЕ СООБЩЕНИЕ ───────────────────────────────────────────────
{
  let раз = 0;
  const r = makeCrashReporter({ fetchIt: async () => { раз += 1; },
    getSettings: async () => ({}), getState: async () => ({}) });
  await r.report(''); await r.report(null);
  ok(раз === 0, 'Пустое сообщение не шлём: сервер не должен получать мусор');
}

// ── ЛОВИМ ОБА ВИДА ПАДЕНИЙ ─────────────────────────────────────────
{
  const пойманы = [];
  const r = makeCrashReporter({
    fetchIt: async (u, o) => { пойманы.push(JSON.parse(o.body).message); },
    getSettings: async () => ({}), getState: async () => ({}),
  });
  const снять = r.wire(dom.window);

  const e1 = new dom.window.Event('error');
  e1.message = 'брошенная ошибка';
  dom.window.dispatchEvent(e1);

  await new Promise((res) => setTimeout(res, 10));
  ok(пойманы.includes('брошенная ошибка'), '★ Ловим брошенные ошибки');

  снять();
  const e2 = new dom.window.Event('error');
  e2.message = 'после снятия';
  dom.window.dispatchEvent(e2);
  await new Promise((res) => setTimeout(res, 10));
  ok(!пойманы.includes('после снятия'), 'И уборка работает');
}

// ── ВЕРСИИ ─────────────────────────────────────────────────────────
console.log('\n═══ ОБНОВЛЕНИЕ ═══\n');
{
  ok(isNewer('2.5.0', '2.4.0'), 'Новее — ставим');
  ok(!isNewer('2.3.0', '2.4.0'), '★ Старее — НЕ ставим: откат отбит');
  ok(!isNewer('2.4.0', '2.4.0'), 'Та же — не ставим');
  ok(isNewer('2.10.0', '2.9.0'),
     '★ 2.10 новее 2.9: сравниваем ЧИСЛАМИ. Строкой «2.10» меньше «2.9» — откат на девять версий');
  ok(isNewer('3.0.0', '2.99.9'), 'И через старший разряд');
  ok(!isNewer('2.4', '2.4.0'), 'Разная длина — не новее');
}

// ── ПРИ ОТКРЫТОЙ СМЕНЕ НЕ ОБНОВЛЯЕМСЯ ──────────────────────────────
{
  const смена = canUpdate({ shift: { id: 's1' } });
  ok(!смена.ok && /Смена открыта/.test(смена.said),
     '★ Смена открыта — НЕ обновляемся: этого у донора нет');
  ok(/останавливает торговлю/.test(смена.said),
     'И объяснено почему');

  const очередь = canUpdate({ pendingCount: 5 });
  ok(!очередь.ok && /Не отправлено чеков: 5/.test(очередь.said),
     '★ Есть неотправленные — ждём: вдруг новая версия читает их иначе');

  ok(canUpdate({}).ok, 'Смена закрыта, очередь пуста — можно');
  ok(canUpdate({ shift: null, pendingCount: 0 }).ok, 'И явно пустое состояние');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
})();
