/*
 * ПРОВЕРКА ПРАВ И ПРЕДЕЛОВ.
 *
 * Главное: старший не зовёт сам себя, а потолок скидки не обойти с
 * другой стороны.
 */
global.TextEncoder = require('util').TextEncoder;
global.crypto = require('crypto').webcrypto;

const { isSenior, discountCap, needFor, allow, approveByPin, ACTIONS } = require('../renderer/rights.js');
const { pinPrint } = require('../renderer/passes.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

const кассир  = { id: 'e1', name: 'Айгуль' };
const старший = { id: 'e2', name: 'Ерлан', isShiftAdmin: true };
const хозяин  = { id: 'e3', name: 'Нурлан', isOwner: true };

console.log('═══ ЭТАП 9 · ПРАВА И ПРЕДЕЛЫ ═══\n');

(async () => {

// ── КТО СТАРШИЙ ────────────────────────────────────────────────────
{
  ok(!isSenior(кассир), 'Кассир не старший');
  ok(isSenior(старший) && isSenior(хозяин), 'Старший смены и владелец — старшие');
  ok(!isSenior(null), 'Никого за кассой — не старший');
}

// ── ПОТОЛОК СКИДКИ: БЕРЁМ МЕНЬШИЙ ──────────────────────────────────
{
  const случаи = [
    ['владелец без предела',   100, null, 100],
    ['старший равен магазину',  30,   30,  30],
    ['кассир ниже магазина',    30,   10,  10],
    ['магазин строже кассира',  10,   30,  10],
    ['магазин не задан',      null,   15,  15],
  ];
  for (const [что, shop, mine, ждём] of случаи) {
    const r = discountCap({ shopMaxPct: shop, employee: { discountLimitPct: mine } });
    ok(r === ждём, `${что}: магазин ${shop ?? '—'}, свой ${mine ?? '—'} → ${r}%`);
  }
  ok(discountCap({ shopMaxPct: 30, employee: кассир }) === 30,
     '★ Нет личного предела — правит магазин');
}

// ── ЧТО НУЖНО ДЛЯ ДЕЙСТВИЯ ─────────────────────────────────────────
{
  const S = (lvl) => ({ actions: { remove_item: lvl } });

  ok(needFor('remove_item', { settings: S('everyone'), employee: кассир }) === 'free',
     'Владелец разрешил всем — кассир отменяет молча');
  ok(needFor('remove_item', { settings: S('nobody'), employee: хозяин }) === 'never',
     '★ «Никому» значит никому — даже владельцу за кассой');
  ok(needFor('remove_item', { settings: S('admin_only'), employee: кассир }) === 'senior',
     'Кассиру нужен старший');
  ok(needFor('remove_item', { settings: S('admin_only'), employee: старший }) === 'free',
     '★ СТАРШИЙ НЕ ЗОВЁТ САМ СЕБЯ');
  ok(needFor('remove_item', { settings: {}, employee: кассир }) === 'free',
     'Настройки нет — считаем «всем»: касса не встанет из-за пустого поля');
}

// ── РАЗРЕШЕНИЕ: СТАРШИЙ МОЛЧА ──────────────────────────────────────
{
  let спрашивали = false;
  const r = await allow('remove_item', {
    settings: { actions: { remove_item: 'admin_only' } },
    employee: старший,
    askPin: async () => { спрашивали = true; return '1111'; },
  });
  ok(r.ok && !спрашивали, '★ Старший разрешил молча — кода не спросили');
  ok(r.approvedName === 'Ерлан', 'И в журнал ушло его имя');
  ok(r.offlineNote === null, 'Без пометки «без связи»: он стоит за кассой сам');
}

// ── ЗАПРЕЩЕНО ВОВСЕ ────────────────────────────────────────────────
{
  const r = await allow('refund_free', {
    settings: { actions: { refund_free: 'nobody' } }, employee: хозяин,
    askPin: async () => '1111',
  });
  ok(!r.ok && /владелец запретил/.test(r.said),
     `★ Запрещено вовсе — говорим прямо: «${r.said}»`);
}

// ── КАССИР ОТКАЗАЛСЯ ЗВАТЬ СТАРШЕГО ────────────────────────────────
{
  const r = await allow('remove_item', {
    settings: { actions: { remove_item: 'admin_only' } }, employee: кассир,
    askPin: async () => null,     // закрыл окно
  });
  ok(!r.ok && r.cancelled, 'Закрыл окно — не отказ, а «передумал»');
}

// ── КОД СТАРШЕГО: ШЕСТЬ СЛУЧАЕВ ────────────────────────────────────
console.log('\n═══ КОД СТАРШЕГО ═══\n');

const makeStore = () => {
  const box = {};
  return { box, passSave: async (p, v) => { box[p] = v; },
    passRead: async (p) => box[p] || null, passCount: async () => Object.keys(box).length };
};

// 1. Сервер жив, код верный
{
  const r = await approveByPin('1111', {
    ask: async () => ({ employeeId: 'e2', name: 'Ерлан' }),
    store: makeStore(), deviceToken: 'K',
  });
  ok(r.ok && r.approvedName === 'Ерлан', 'Сервер жив, код верный — разрешил');
  ok(r.offlineNote === null, 'Без пометки: подпись настоящая');
}

// 2. Сервер жив, код неверный
{
  const r = await approveByPin('9999', {
    ask: async () => { const e = new Error('Код не подошёл'); e.serverAnswered = true; throw e; },
    store: makeStore(), deviceToken: 'K',
  });
  ok(!r.ok && r.said === 'Код не подошёл',
     '★ Сервер ЖИВ и отказал — верим ему, пропуска не смотрим');
}

// 3. Нет связи, код старшего в пропусках
{
  const store = makeStore();
  await store.passSave(await pinPrint('2222', 'K'),
    { employee: { id: 'e2', name: 'Ерлан', isShiftAdmin: true } });
  const r = await approveByPin('2222', {
    ask: async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; },
    store, deviceToken: 'K',
  });
  ok(r.ok && r.approvedName === 'Ерлан', '★ Нет связи — разрешил по пропуску');
  ok(/проверен на кассе/.test(r.offlineNote),
     `★ И в отчёт ушла пометка: «${r.offlineNote}»`);
}

// 4. Нет связи, код обычного кассира
{
  const store = makeStore();
  await store.passSave(await pinPrint('3333', 'K'), { employee: { id: 'e1', name: 'Айгуль' } });
  const r = await approveByPin('3333', {
    ask: async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; },
    store, deviceToken: 'K',
  });
  ok(!r.ok && /не даёт права разрешать/.test(r.said),
     '★ Код узнан, но человек не старший — отказ настоящий');
}

// 5. Нет связи, код незнакомый
{
  const r = await approveByPin('7777', {
    ask: async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; },
    store: makeStore(), deviceToken: 'K',
  });
  ok(r.ok, '★ Незнакомый код без связи — пропускаем: очередь важнее строгости');
  ok(/не проверен/.test(r.offlineNote),
     `★ Но отчёт узнает правду: «${r.offlineNote}»`);
  ok(r.approvedBy === null, 'И подписи нет: разрешать было некому');
}

// 6. Сервер ответил «не подошёл» своим полем
{
  const r = await approveByPin('1111', {
    ask: async () => ({ ok: false, reason: 'Код отозван владельцем' }),
    store: makeStore(), deviceToken: 'K',
  });
  ok(!r.ok && /отозван/.test(r.said), 'Сервер объяснил по-своему — берём его слова');
}

// ── НАЗВАНИЯ ДЕЙСТВИЙ ──────────────────────────────────────────────
{
  const без = Object.keys(ACTIONS).filter((k) => !/[а-яё]/i.test(ACTIONS[k]));
  ok(без.length === 0, '★ Все действия названы по-русски: кассир видит слова, не коды');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
})();
