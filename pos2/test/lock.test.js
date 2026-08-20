/*
 * ПРОВЕРКА ЗАМКА И ВЫХОДА.
 *
 * ПЕРВЫЕ ПРОВЕРКИ — ПРО ВАШУ БЕДУ: «нажал Выйти, а клавиатуры нет, и в
 * ноуте не пишется».
 */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>');
global.document = dom.window.document; global.window = dom.window;
global.TextEncoder = require('util').TextEncoder;
global.crypto = require('crypto').webcrypto;

const { IDLE_MIN, LOCK_KEYS, makeIdleWatch, unlock, planLogout, buildLock } = require('../renderer/lock.js');
const { pinPrint, offlineLogin } = require('../renderer/passes.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };
const root = document.getElementById('app');
const key = (k) => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const айгуль = { id: 'e1', name: 'Айгуль' };
const ерлан = { id: 'e2', name: 'Ерлан' };

console.log('═══ ЭТАП 22 · ЗАМОК И ВЫХОД ═══\n');

(async () => {

// ── ВАША БЕДА: КЛАВИАТУРА ЕСТЬ ─────────────────────────────────────
{
  buildLock(root, { employee: айгуль }, { onUnlock: async () => ({ ok: true }) });
  ok(root.querySelectorAll('#lockPad button').length === 12,
     `★ Клавиатура собрана: 12 кнопок`);
  ok(root.querySelectorAll('#lockDots i').length === 4, 'И четыре точки под код');
}

// ── И СОБИРАЕТСЯ КАЖДЫЙ РАЗ ────────────────────────────────────────
{
  root.__cleanup && root.__cleanup();
  root.innerHTML = '<p>продажа</p>';
  buildLock(root, { employee: айгуль }, { onUnlock: async () => ({ ok: true }) });
  ok(root.querySelectorAll('#lockPad button').length === 12,
     '★ Заперлись второй раз — кнопки СОБРАЛИСЬ снова');

  root.__cleanup && root.__cleanup();
  root.innerHTML = '';
  buildLock(root, { employee: айгуль }, { onUnlock: async () => ({ ok: true }) });
  ok(root.querySelectorAll('#lockPad button').length === 12,
     '★ И в третий: касса не запрётся насмерть');
}

// ── КЛАВИАТУРА НОУТБУКА ────────────────────────────────────────────
{
  let принят = null;
  root.__cleanup && root.__cleanup();
  buildLock(root, { employee: айгуль },
    { onUnlock: async (p) => { принят = p; return { ok: true }; } });

  key('1'); key('2'); key('3'); key('4');
  await wait(10);
  ok(принят === '1234', `★ Код С НОУТБУКА принят: «${принят}»`);
}

// ── И ПАЛЬЦЕМ ──────────────────────────────────────────────────────
{
  let принят = null;
  root.__cleanup && root.__cleanup();
  buildLock(root, { employee: айгуль },
    { onUnlock: async (p) => { принят = p; return { ok: true }; } });
  const btn = (t) => [...root.querySelectorAll('#lockPad button')].find((b) => b.textContent === t);
  btn('9').click(); btn('9').click(); btn('9').click(); btn('9').click();
  await wait(10);
  ok(принят === '9999', '★ Тот же код пальцем');
}

// ── ESCAPE НЕ ОТПИРАЕТ ─────────────────────────────────────────────
{
  let звали = false;
  root.__cleanup && root.__cleanup();
  buildLock(root, { employee: айгуль },
    { onUnlock: async () => { звали = true; return { ok: true }; } });
  key('Escape'); key('Escape');
  await wait(10);
  ok(!звали, '★ Escape НЕ отпирает: замок на то и замок');
}

// ── ОБРАБОТЧИК НЕ ВИСИТ ────────────────────────────────────────────
{
  let было = 0;
  buildLock(root, { employee: айгуль },
    { onUnlock: async () => { было += 1; return { ok: true }; } });
  root.__cleanup();
  key('1'); key('1'); key('1'); key('1');
  await wait(10);
  ok(было === 0, '★ Экран ушёл — цифры больше не приходят');
}

// ── ОТСЧЁТ ПРОСТОЯ ─────────────────────────────────────────────────
console.log('\n═══ ОТСЧЁТ ПРОСТОЯ ═══\n');
{
  let заперлось = false;
  // Три минуты в проверке — 30 мс: ждать по-настоящему нельзя
  const w = makeIdleWatch({ minutes: 30 / 60000, onLock: () => { заперлось = true; } });
  w.arm();
  await wait(60);
  ok(заперлось, '★ Простой — касса заперлась сама');
  ok(w.locked, 'И знает об этом');
}

{
  let заперлось = false;
  const w = makeIdleWatch({ minutes: 60 / 60000, onLock: () => { заперлось = true; } });
  w.arm();
  await wait(30); w.touch();      // кассир работает
  await wait(30); w.touch();
  await wait(30);
  ok(!заперлось,
     '★ Кассир работает — касание СБРАСЫВАЕТ отсчёт, замок не мешает');
}

{
  let заперлось = false;
  const w = makeIdleWatch({ minutes: 0, onLock: () => { заперлось = true; } });
  w.arm();
  await wait(50);
  ok(!заперлось,
     '★ Ноль в настройке — не запирать: на кассе в закрытой комнате замок мешает');
  ok(IDLE_MIN === 3, 'По умолчанию три минуты — их число');
}

// ── ОТПИРАНИЕ ──────────────────────────────────────────────────────
console.log('\n═══ ОТПИРАНИЕ ═══\n');
{
  const box = {};
  const store = {
    passSave: async (p, v) => { box[p] = v; },
    passRead: async (p) => box[p] || null,
    passCount: async () => Object.keys(box).length,
  };
  await store.passSave(await pinPrint('1111', 'K'), { employee: айгуль });
  await store.passSave(await pinPrint('2222', 'K'), { employee: ерлан });

  const свой = await unlock({ pin: '1111', state: { employee: айгуль },
    store, deviceToken: 'K', offlineLogin });
  ok(свой.ok && !свой.changed, '★ Свой код — отперли, кассир тот же');
  ok(свой.said === null, 'И говорить нечего');

  const сменщик = await unlock({ pin: '2222', state: { employee: айгуль },
    store, deviceToken: 'K', offlineLogin });
  ok(сменщик.ok && сменщик.changed && сменщик.employee.name === 'Ерлан',
     '★ Сменщик отпер своим — за кассой теперь ОН');
  ok(/За кассой теперь Ерлан/.test(сменщик.said),
     `★ И сказано вслух: «${сменщик.said}» — иначе чеки пойдут на утреннего`);

  const чужой = await unlock({ pin: '7777', state: { employee: айгуль },
    store, deviceToken: 'K', offlineLogin });
  ok(!чужой.ok, '★ Чужой код не отпирает');
}

// ── ВЫХОД КАССИРА ──────────────────────────────────────────────────
console.log('\n═══ ВЫХОД ═══\n');
{
  const пусто = planLogout({ cart: [], state: {} });
  ok(пусто.warnings.length === 0, 'Пустая касса — выходим молча');

  const с_чеком = planLogout({ cart: [{}, {}, {}], state: {} });
  ok(/В чеке 3 позиции/.test(с_чеком.warnings[0].said),
     `★ Набранный чек пропадёт — предупреждаем: «${с_чеком.warnings[0].said.slice(0, 40)}…»`);
  ok(/отложите чек/.test(с_чеком.warnings[0].said),
     'И сказано, что делать вместо этого');

  const со_сменой = planLogout({ cart: [], state: { shift: { id: 's1' } } });
  ok(/Смена останется открытой/.test(со_сменой.warnings[0].said),
     '★ Смена ОСТАЁТСЯ: иначе кассир решит, что выход её закрыл, и уйдёт домой');
  ok(/кто сводит ящик/.test(со_сменой.warnings[0].said),
     'И кто должен её закрывать');

  const оба = planLogout({ cart: [{}], state: { shift: { id: 's1' } } });
  ok(оба.warnings.length === 2, 'Оба предупреждения разом');
  ok(оба.canLogout, '★ Но выйти МОЖНО: не запрещаем, а предупреждаем');
}

// ── СЧЁТ ПО-РУССКИ ─────────────────────────────────────────────────
{
  const p = (n) => planLogout({ cart: Array(n).fill({}), state: {} }).warnings[0].said;
  ok(/1 позиция/.test(p(1)) && /2 позиции/.test(p(2)) && /5 позиций/.test(p(5)),
     '★ Счёт по-русски: 1 позиция, 2 позиции, 5 позиций');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
})();
