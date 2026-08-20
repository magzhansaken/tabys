/*
 * ПРОВЕРКА СМЕНЫ.
 *
 * Главное: забытая смена, чужая смена и пустое поле при закрытии.
 */
const { FLOATS, shiftForgotten, shiftOwnership, openShift, expectedCash,
  closeShift, diffText, pendingNote, clockOut } = require('../renderer/shift.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

const makeStore = () => {
  let st = { cashInDrawer: 0, shift: null, lastNumber: 0 };
  const box = [];
  return {
    box,
    getState: async () => st,
    saveState: async (p) => { st = { ...st, ...p }; return st; },
    outboxAdd: async (r) => { box.push(r); return r; },
    outboxPending: async () => box,
    get state() { return st; },
  };
};
let n = 0;
const newId = () => `id-${++n}`;

console.log('═══ ЭТАП 10 · СМЕНА ═══\n');

(async () => {

// ── ЗАБЫТАЯ СМЕНА ──────────────────────────────────────────────────
{
  const день = (h, m = 0) => { const d = new Date('2026-08-21T00:00:00'); d.setHours(h, m); return d; };

  // Смена открыта вчера в 23:00, сейчас 10 утра — забыта
  const вчера = new Date('2026-08-20T23:00:00').toISOString();
  const r1 = shiftForgotten({ openedAt: вчера }, день(10));
  ok(r1 && r1.hours === 11, `★ Вчерашняя смена поймана: ${r1 && r1.hours} ч`);
  ok(/уйдут во вчерашний отчёт/.test(r1.said),
     'И сказано, чем грозит: чеки уйдут во вчерашний отчёт');

  // Смена открыта сегодня в 8 утра, сейчас 20:00 — двенадцать часов, но НЕ забыта
  const сегодня = new Date('2026-08-21T08:00:00').toISOString();
  ok(shiftForgotten({ openedAt: сегодня }, день(20)) === null,
     '★ Двенадцать часов сегодня — НЕ забыта: магазин так и работает');

  // Смена открыта вчера в 22:00, сейчас 1 ночи — ночная, не забыта
  const ночь = new Date('2026-08-20T22:00:00').toISOString();
  ok(shiftForgotten({ openedAt: ночь }, день(1)) === null,
     '★ Ночная смена до двух — не забыта: сейчас ещё её время');

  ok(shiftForgotten(null) === null, 'Смены нет — и говорить не о чем');
}

// ── ЧЬЯ СМЕНА ──────────────────────────────────────────────────────
{
  const я = { id: 'e1', name: 'Айгуль' };
  const своя = shiftOwnership({ openedById: 'e1', openedByName: 'Айгуль' }, я);
  ok(своя.mine && своя.label === 'Продолжить смену', 'Своя смена — «Продолжить»');
  ok(своя.note === null, 'И объяснять нечего');

  const чужая = shiftOwnership({ openedById: 'e2', openedByName: 'Ерлан' }, я);
  ok(!чужая.mine && чужая.label === 'Принять смену',
     '★ Чужая смена — «ПРИНЯТЬ»: слово другое нарочно');
  ok(/отвечаете за деньги в ящике/.test(чужая.note),
     `★ И сказано, что берёшь на себя: «${чужая.note.slice(0, 50)}…»`);
}

// ── ОТКРЫТИЕ ───────────────────────────────────────────────────────
{
  const store = makeStore();
  const sh = await openShift({ store, openingCash: 20000, newId });
  ok(store.state.shift && store.state.shift.id === sh.id, 'Смена открыта');
  ok(store.state.cashInDrawer === 20000, '★ Размен лёг в ящик');
  ok(store.state.lastNumber === 0, 'Нумерация чеков началась заново');
  ok(store.box.length === 1 && store.box[0].entity === 'shift',
     '★ Смена легла в очередь СРАЗУ: упадём — она цела');
  ok(FLOATS.length === 3, `Обычные размены под рукой: ${FLOATS.join(', ')}`);
}

// ── ЗАКРЫТИЕ И РАСХОЖДЕНИЕ ─────────────────────────────────────────
{
  const store = makeStore();
  await openShift({ store, openingCash: 20000, newId });
  await store.saveState({ cashInDrawer: 45000 });   // наторговали

  ok(expectedCash(store.state) === 45000,
     '★ Сколько должно быть — считаем НА КАССЕ, без сервера');

  const c = await closeShift({ store, state: store.state, factCash: 44500, newId });
  ok(c.expectedCash === 45000 && c.factCash === 44500 && c.diff === -500,
     '★ Расхождение записано: не хватает 500');
  ok(store.state.shift === null && store.state.cashInDrawer === 0,
     'Смена закрыта, ящик обнулён');
  ok(store.box.some((r) => r.entity === 'shift_close'),
     'Закрытие ушло в очередь');
}

// ── РАСХОЖДЕНИЕ СЛОВАМИ ────────────────────────────────────────────
{
  ok(diffText(45000, 45000).said === 'Сходится', 'Сошлось — так и сказано');
  ok(diffText(45500, 45000).said === 'Излишек', 'Больше — излишек');
  const мало = diffText(44500, 45000);
  ok(мало.said === 'Не хватает' && мало.amount === 500,
     `★ Меньше — «Не хватает 500», а не «-500»`);
  ok(diffText(44500, 45000).kind === 'bad', 'И помечено как беда');
}

// ── ЧТО СКАЗАТЬ ПРО НЕОТПРАВЛЕННОЕ ─────────────────────────────────
{
  const п = pendingNote(3, 0);
  ok(/это не излишек/.test(п[0]),
     '★ Очередь объяснена: «деньги за них уже в ящике, это не излишек»');

  const о = pendingNote(0, 2);
  ok(/Покажите владельцу/.test(о[0]),
     '★ Отклонённые названы отдельно: деньги в ящике, а в отчёте их нет');

  ok(pendingNote(0, 0).length === 0, 'Всё ушло — молчим');
  const { plural } = require('../renderer/shift.js');
  const счёт = [[1, 'чек'], [2, 'чека'], [3, 'чека'], [5, 'чеков'],
    [11, 'чеков'], [21, 'чек'], [22, 'чека']];
  const плохо = счёт.filter(([n, ждём]) => plural(n, 'чек', 'чека', 'чеков') !== ждём);
  ok(плохо.length === 0,
     '★ Счёт по-русски: 1 чек, 2 чека, 5 чеков, 21 чек, 22 чека');
  ok(/В очереди 3 чека /.test(pendingNote(3, 0)[0]),
     'И в самом сообщении: «В очереди 3 чека», а не «3 чеков»');
}

// ── ЯВКА ───────────────────────────────────────────────────────────
console.log('\n═══ ЯВКА КАССИРА ═══\n');
{
  const r = await clockOut({ ask: async () => ({ fullName: 'Айгуль', workedMin: 495 }),
    settings: {}, deviceToken: 'K', pin: '1111' });
  ok(r.ok && r.workedMin === 495, '★ Явка закрыта, отработанное посчитано');

  const нет = await clockOut({
    ask: async () => { const e = new Error('нет открытой явки'); e.serverAnswered = true; throw e; },
    settings: {}, deviceToken: 'K', pin: '1111' });
  ok(!нет.ok && /уход уже отмечен/.test(нет.said),
     'Повторный уход — не ошибка, а «уже отмечен»');

  const офлайн = await clockOut({
    ask: async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; },
    settings: {}, deviceToken: 'K', pin: '1111' });
  ok(!офлайн.ok && /Можно уходить/.test(офлайн.said),
     `★ Без связи говорим, ЧТО ДЕЛАТЬ: «${офлайн.said.slice(0, 55)}…»`);
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
})();
