/*
 * ПРОВЕРКА СМЕНЫ И ЯВКИ.
 *
 * Три беды, каждая уже случалась: забытая смена, чужая смена, пустое
 * поле при закрытии.
 */
const { FLOATS, shiftForgotten, openShift, currentShift, shiftSummary,
        closeShift, diffText } = require('../renderer/shift.js');
const { clockOut, workedText, farewell } = require('../renderer/attendance.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

let счёт = 0;
const newId = () => `id-${++счёт}`;

function makeStore(init = {}) {
  const st = { shift: null, cashInDrawer: 0, ...init };
  const out = [];
  return {
    st, out,
    saveState: async (p) => Object.assign(st, p),
    getState: async () => st,
    outboxAdd: async (r) => { out.push(r); return r; },
  };
}

console.log('═══ ЭТАП 10 · СМЕНА И ЯВКА ═══\n');

(async () => {

// ── ЗАБЫТАЯ СМЕНА ──────────────────────────────────────────────────
{
  const днём = new Date('2026-08-20T14:00:00');
  const ночью = new Date('2026-08-20T03:00:00');

  // Открыта сегодня утром — обычная
  ok(!shiftForgotten({ openedAt: '2026-08-20T08:00:00' }, днём),
     'Смена открыта сегодня — молчим');

  // Открыта ВЧЕРА, сейчас день — забыта
  const f = shiftForgotten({ openedAt: '2026-08-19T09:00:00' }, днём);
  ok(f && f.hours === 29, `★ Смена со вчера — поймана: ${f && f.hours} ч`);
  ok(/смешается/.test(f.said), `И объяснено чем грозит: «${f.said.slice(-40)}»`);

  // Ночная смена: открыта вчера в 22:00, сейчас 3 ночи — НЕ забыта
  ok(!shiftForgotten({ openedAt: '2026-08-19T22:00:00' }, ночью),
     '★ Ночная смена не считается забытой: магазин работает круглосуточно');

  // Долгая, но сегодняшняя: у донора «14 часов» здесь бы соврала.
  const долгая = shiftForgotten({ openedAt: '2026-08-20T06:30:00' },
    new Date('2026-08-20T23:00:00'));
  ok(!долгая,
     '★ Смена идёт 16 ч, но открыта СЕГОДНЯ — молчим. У донора здесь ложная тревога');

  ok(!shiftForgotten(null) && !shiftForgotten({}), 'Нет смены — нет и тревоги');
}

// ── ОТКРЫТИЕ СМЕНЫ ─────────────────────────────────────────────────
{
  const store = makeStore();
  const sh = await openShift({ store, employee: { id: 'e1', name: 'Айгуль' },
    openingCash: 40000, newId });

  ok(sh.openedByName === 'Айгуль', 'Смена помнит, кто открыл');
  ok(store.st.cashInDrawer === 40000, '★ Размен сразу в ящике: сверка начнётся с него');
  ok(store.out.length === 1 && store.out[0].entity === 'shift',
     '★ Смена легла В ОЧЕРЕДЬ раньше, чем в состояние: не потеряется');
  ok(FLOATS.includes(40000), `Размены под рукой: ${FLOATS.join(', ')}`);
}

// ── ЧУЖАЯ СМЕНА ────────────────────────────────────────────────────
{
  // Сервер говорит: смена уже открыта
  const есть = await currentShift({
    ask: async () => ({ open: true, id: 's-чужая', openedByName: 'Ерлан' }),
    settings: {}, deviceToken: 'K' });
  ok(есть && есть.openedByName === 'Ерлан',
     '★ Открытая смена найдена ДО того, как предлагать новую');

  // Без связи не мешаем работать — их правило
  const нет = await currentShift({
    ask: async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; },
    settings: {}, deviceToken: 'K' });
  ok(нет === null, '★ Без связи не мешаем: смена откроется, сервер разберётся');
}

// ── СВОДКА СЧИТАЕТСЯ НА КАССЕ ──────────────────────────────────────
{
  const shift = { id: 's1', openingCash: 40000 };
  const receipts = [
    { shiftId: 's1', total: 3400, cashPart: 3400 },
    { shiftId: 's1', total: 1200, cardPart: 1200 },
    { shiftId: 's1', total: 500, cashPart: 500, isRefund: true },
    { shiftId: 's-чужая', total: 9999, cashPart: 9999 },   // не наша
  ];
  const s = shiftSummary({ shift, receipts, cashInDrawer: 42900 });

  ok(s.count === 2 && s.refundCount === 1, 'Продажи и возвраты сосчитаны отдельно');
  ok(s.revenue === 4100, `★ Выручка за вычетом возвратов: ${s.revenue}`);
  ok(s.card === 1200, 'Карта отдельно от наличных');
  ok(!receipts.some((r) => r.shiftId === 's-чужая' && s.revenue > 9000),
     '★ Чужая смена не попала в сводку');
  ok(s.expectedCash === 42900, 'В ящике по расчёту — с кассы, а не с сервера');
}

// ── ЗАКРЫТИЕ: ПУСТОЕ ПОЛЕ ──────────────────────────────────────────
{
  const store = makeStore({ shift: { id: 's1' }, cashInDrawer: 45000 });

  let e = null;
  try { await closeShift({ store, shift: { id: 's1' }, factCash: null,
    expectedCash: 45000, newId }); } catch (x) { e = x; }

  ok(e && e.needCount === true,
     '★ Пустое поле НЕ ноль: касса отказывается закрывать молча');
  ok(e.expected === 45000, 'И называет, сколько должно быть');
  ok(store.st.shift !== null, '★ Смена НЕ закрыта: недостачи в отчёте не появилось');
}

// ── ЗАКРЫТИЕ: ВПИСАЛИ ──────────────────────────────────────────────
{
  const store = makeStore({ shift: { id: 's1' }, cashInDrawer: 45000 });
  const c = await closeShift({ store, shift: { id: 's1' }, factCash: 44500,
    expectedCash: 45000, newId });

  ok(c.diff === -500, `Расхождение сосчитано: ${c.diff}`);
  ok(store.st.shift === null && store.st.cashInDrawer === 0,
     '★ Смена снята, ящик обнулён: деньги сданы');
  ok(store.out.some((r) => r.entity === 'shift_close'),
     'Закрытие ушло в очередь');
}

// ── РАСХОЖДЕНИЕ СЛОВАМИ ────────────────────────────────────────────
{
  ok(diffText(45000, 45000).kind === 'ok', 'Сходится');
  ok(diffText(45500, 45000).kind === 'warn' && /Излишек/.test(diffText(45500, 45000).said),
     'Излишек назван');
  ok(diffText(44500, 45000).kind === 'bad' && /Не хватает/.test(diffText(44500, 45000).said),
     '★ Недостача названа прямо, до подтверждения');
}

// ── ЯВКА ───────────────────────────────────────────────────────────
console.log('\n═══ ЯВКА ═══\n');
{
  const r = await clockOut({ ask: async () => ({ fullName: 'Айгуль', workedMin: 495 }),
    settings: {}, deviceToken: 'K', pin: '1111' });
  ok(r.ok && r.workedMin === 495, 'Уход отмечен, время получено');
  ok(/8 ч 15 мин/.test(farewell(r.name, r.workedMin)),
     `★ Прощание: «${farewell(r.name, r.workedMin)}»`);
}
{
  const r = await clockOut({
    ask: async () => { const e = new Error('нет открытой явки');
      e.serverAnswered = true; e.code = 'NO_OPEN_ATTENDANCE'; throw e; },
    settings: {}, deviceToken: 'K', pin: '1111' });
  ok(!r.ok && /уход уже отмечен/.test(r.said),
     '★ Нажал дважды — говорим, что уход уже отмечен');
}
{
  const r = await clockOut({
    ask: async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; },
    settings: {}, deviceToken: 'K', pin: '1111' });
  ok(!r.ok && /Нет связи — уход не отмечен/.test(r.said),
     '★ Без связи НЕ делаем вид, что отметили: это зарплата человека');
  ok(/владельцу/.test(r.said), 'И сказано, кому сказать');
}
{
  ok(workedText(495) === '8 ч 15 мин' && workedText(45) === '45 мин'
     && workedText(0) === '0 мин', 'Время читается по-человечески');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
})();
