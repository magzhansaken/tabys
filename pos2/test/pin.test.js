/*
 * ПРОВЕРКА ЭКРАНА КОДА.
 *
 * Первые проверки — про ту самую беду: «нажал Выйти, а клавиатуры
 * нет, и в ноуте не пишется».
 */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>');
global.document = dom.window.document; global.window = dom.window;

const { buildPin, farewellText, PIN_KEYS } = require('../renderer/screen-pin.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };
const root = document.getElementById('app');
const key = (k) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const state = { storeName: 'Мини-маркет на Абая', registerName: 'Касса 1' };

console.log('═══ ЭТАП 7 · ЭКРАН КОДА ═══\n');

(async () => {

// ── ТА САМАЯ БЕДА: КЛАВИАТУРА ЕСТЬ ─────────────────────────────────
{
  buildPin(root, state, { onPin: async () => ({ ok: true }) });
  const кнопок = root.querySelectorAll('#pinPad button').length;
  ok(кнопок === 12, `★ Клавиатура собрана: ${кнопок} кнопок`);
  ok(root.querySelectorAll('#pinDots i').length === 4, 'Четыре точки под код');
}

// ── И СОБИРАЕТСЯ КАЖДЫЙ РАЗ ────────────────────────────────────────
{
  // Показали, ушли, вернулись — как при «Выйти»
  root.innerHTML = '<p>другой экран</p>';
  buildPin(root, state, { onPin: async () => ({ ok: true }) });
  ok(root.querySelectorAll('#pinPad button').length === 12,
     '★ После «Выйти» клавиатура СОБРАЛАСЬ снова, а не пустой экран');

  root.innerHTML = '';
  buildPin(root, state, { onPin: async () => ({ ok: true }) });
  ok(root.querySelectorAll('#pinPad button').length === 12,
     '★ И в третий раз: касса не запрётся насмерть');
}

// ── КЛАВИАТУРА НОУТБУКА РАБОТАЕТ ───────────────────────────────────
{
  let принят = null;
  buildPin(root, state, { onPin: async (p) => { принят = p; return { ok: true }; } });

  key('1'); key('2'); key('3');
  ok(root.querySelectorAll('#pinDots i.on').length === 3,
     '★ Цифры С КЛАВИАТУРЫ НОУТБУКА набираются');

  key('Backspace');
  ok(root.querySelectorAll('#pinDots i.on').length === 2, 'Backspace стирает знак');

  key('4'); key('5');
  await wait(10);
  ok(принят === '1245', `★ Код с ноутбука дошёл целиком: «${принят}»`);
}

// ── ПАЛЬЦЕМ ТОЖЕ ───────────────────────────────────────────────────
{
  let принят = null;
  buildPin(root, state, { onPin: async (p) => { принят = p; return { ok: true }; } });
  const btn = (t) => [...root.querySelectorAll('#pinPad button')].find((b) => b.textContent === t);
  btn('9').click(); btn('9').click(); btn('9').click(); btn('9').click();
  await wait(10);
  ok(принят === '9999', '★ Тот же код пальцем по кнопкам');
}

// ── ОБРАБОТЧИК НЕ ОСТАЁТСЯ ВИСЕТЬ ──────────────────────────────────
{
  let было = 0;
  buildPin(root, state, { onPin: async () => { было++; return { ok: true }; } });
  root.__cleanup();          // экран сменился
  key('1'); key('1'); key('1'); key('1');
  await wait(10);
  ok(было === 0,
     '★ Экран ушёл — цифры с клавиатуры больше не приходят');
}

// ── ОТКАЗ ГОВОРИТ СЛОВАМИ И ЧИСТИТ ─────────────────────────────────
{
  buildPin(root, state, { onPin: async () => ({ ok: false, said: 'Код не подошёл' }) });
  key('1'); key('1'); key('1'); key('1');
  await wait(10);
  ok(/Код не подошёл/.test(root.querySelector('#pinErr').textContent),
     'Отказ показан словами');
  ok(root.querySelectorAll('#pinDots i.on').length === 0,
     '★ И точки очищены: кассир вводит заново, а не дописывает');
}

// ── ПЯТЫЙ ЗНАК НЕ УХОДИТ ВТОРЫМ ЗАПРОСОМ ───────────────────────────
{
  let вызовов = 0;
  buildPin(root, state, { onPin: async () => { вызовов++; await wait(40); return { ok: true }; } });
  key('1'); key('2'); key('3'); key('4');
  key('5'); key('6');          // кассир дожимает, пока идём на сервер
  await wait(80);
  ok(вызовов === 1, '★ Лишние нажатия не шлют второй запрос');
}

// ── КНОПКИ C И СТЕРЕТЬ ─────────────────────────────────────────────
{
  buildPin(root, state, { onPin: async () => ({ ok: true }) });
  key('1'); key('2'); key('3');
  const btn = (t) => [...root.querySelectorAll('#pinPad button')].find((b) => b.textContent === t);
  btn('C').click();
  ok(root.querySelectorAll('#pinDots i.on').length === 0, 'Кнопка «C» чистит всё');
  key('7'); btn('⌫').click();
  ok(root.querySelectorAll('#pinDots i.on').length === 0, 'Кнопка стирания убирает знак');
}

// ── ГДЕ МЫ ─────────────────────────────────────────────────────────
{
  buildPin(root, state, { onPin: async () => ({ ok: true }) });
  ok(/Мини-маркет на Абая · Касса 1/.test(root.querySelector('#pinWhere').textContent),
     '★ Видно магазин и кассу: у владельца их несколько');
}

// ── ЯВКА: «Я УХОЖУ ДОМОЙ» ──────────────────────────────────────────
{
  let ушёл = null;
  buildPin(root, state, {
    onPin: async () => ({ ok: true }),
    onClockOut: async (p) => { ушёл = p; return { ok: true }; },
  });
  ok(root.querySelector('#pinOut'), 'Кнопка «Я ухожу домой» есть');

  root.querySelector('#pinOut').click();
  ok(/ухода домой/.test(root.querySelector('#pinTitle').textContent),
     '★ Заголовок сменился: кассир видит, что код сейчас для ухода');

  key('1'); key('1'); key('1'); key('1');
  await wait(10);
  ok(ушёл === '1111', '★ Код ушёл в закрытие явки, а не во вход');

  root.querySelector('#pinIn').click();
  ok(/Введите свой код/.test(root.querySelector('#pinTitle').textContent),
     'И можно вернуться ко входу');
}

// ── ПРОЩАНИЕ НАЗЫВАЕТ ОТРАБОТАННОЕ ─────────────────────────────────
{
  ok(/Айгуль/.test(farewellText('Айгуль', 495)) && /8 ч 15 мин/.test(farewellText('Айгуль', 495)),
     `★ Прощание: «${farewellText('Айгуль', 495)}»`);
  ok(/45 мин/.test(farewellText('Ерлан', 45)), 'Меньше часа — только минуты');
}

// ── ЯВКИ МОЖЕТ НЕ БЫТЬ ─────────────────────────────────────────────
{
  buildPin(root, state, { onPin: async () => ({ ok: true }), canClockOut: false });
  ok(!root.querySelector('#pinOut'),
     'Без явки кнопки нет: не показываем то, чего магазин не ведёт');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
})();
