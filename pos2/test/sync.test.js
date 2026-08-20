/*
 * ПРОВЕРКА ОЧЕРЕДИ.
 *
 * Главное: чек не пропадает и не крутится вечно. Обе беды были.
 */
const { BATCH, flush, makeSyncLoop, queueNote } = require('../renderer/sync.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

/* Хранилище в памяти — как настоящее. */
function makeStore(rows = []) {
  let queue = [...rows];
  const bad = [];
  return {
    get queue() { return queue; },
    get bad() { return bad; },
    outboxPending: async () => queue,
    outboxAck: async (ids) => { queue = queue.filter((e) => !ids.includes(e.id)); },
    rejectedAdd: async (r) => bad.push(...r),
    rejectedAll: async () => bad,
  };
}

const чек = (id, n) => ({ id, entity: 'sale', entityId: id, op: 'insert',
  payload: { number: n, total: n * 100 } });

console.log('═══ ЭТАП 21 · ОЧЕРЕДЬ ═══\n');

(async () => {

// ── ВСЁ УШЛО ───────────────────────────────────────────────────────
{
  const store = makeStore([чек('a', 57), чек('b', 58)]);
  const r = await flush({
    ask: async () => ({ results: [{ id: 'a', result: 'ok' }, { id: 'b', result: 'ok' }] }),
    store, settings: {}, deviceToken: 'K',
  });
  ok(r.reached && r.sent === 2 && r.left === 0, 'Два чека ушли, очередь пуста');
}

// ── СВЯЗЬ ПРОПАЛА: ОЧЕРЕДЬ ЖДЁТ ────────────────────────────────────
{
  const store = makeStore([чек('a', 57)]);
  const r = await flush({
    ask: async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; },
    store, settings: {}, deviceToken: 'K',
  });
  ok(!r.reached && r.left === 1,
     '★ Сервер молчит — чек ЖДЁТ в очереди, ничего не тронуто');
  ok(store.queue.length === 1, 'И он вправду на месте');
}

// ── ДУБЛЬ СЧИТАЕТСЯ ПРИНЯТЫМ ───────────────────────────────────────
{
  const store = makeStore([чек('a', 57)]);
  const r = await flush({
    ask: async () => ({ results: [{ id: 'a', result: 'duplicate' }] }),
    store, settings: {}, deviceToken: 'K',
  });
  ok(r.sent === 1 && r.left === 0,
     '★ Дубль снят как принятый: связь оборвалась на полпути, сервер чек записал');
  ok(store.bad.length === 0, 'И в ящик отклонённых не попал: это не беда');
}

// ── ОТКЛОНЁННЫЙ — В ЯЩИК, А НЕ В МУСОР И НЕ ОБРАТНО ────────────────
{
  const store = makeStore([чек('a', 57), чек('b', 58), чек('c', 59)]);
  const r = await flush({
    ask: async () => ({ results: [
      { id: 'a', result: 'ok' },
      { id: 'b', result: 'error', message: 'дубль номера чека' },
      { id: 'c', result: 'ok' },
    ] }),
    store, settings: {}, deviceToken: 'K',
  });

  ok(r.sent === 2 && r.rejected === 1, 'Два ушли, один отклонён');
  ok(r.left === 0,
     '★ Очередь ПУСТА: отклонённый не крутится вечно — эта беда у меня была');
  ok(store.bad.length === 1,
     '★ И не пропал: лежит в ящике — эта беда была у донора');
  ok(store.bad[0].number === 58 && /дубль номера/.test(store.bad[0].reason),
     `★ С номером и причиной: «Чек №${store.bad[0].number} — ${store.bad[0].reason}»`);
  ok(store.bad[0].total === 5800, 'И суммой: владелец видит, о каких деньгах речь');
}

// ── СЕРВЕР ОТВЕТИЛ НЕ ПРО ВСЁ ──────────────────────────────────────
{
  const store = makeStore([чек('a', 57), чек('b', 58), чек('c', 59)]);
  const r = await flush({
    ask: async () => ({ results: [{ id: 'a', result: 'ok' }, { id: 'b', result: 'ok' }] }),
    store, settings: {}, deviceToken: 'K',
  });
  ok(r.left === 1 && store.queue[0].id === 'c',
     '★ Про «c» сервер промолчал — чек ЖДЁТ, а не пропал вместе с ответом');
}

// ── БОЛЬШАЯ ОЧЕРЕДЬ ИДЁТ ПАЧКАМИ ───────────────────────────────────
{
  const много = Array.from({ length: 120 }, (_, i) => чек('e' + i, i));
  const store = makeStore(много);
  let запросов = 0;

  const r = await flush({
    ask: async (p, o) => {
      запросов += 1;
      return { results: o.body.events.map((e) => ({ id: e.id, result: 'ok' })) };
    },
    store, settings: {}, deviceToken: 'K',
  });

  ok(запросов === 1 && r.sent === BATCH,
     `★ За раз шлём ${BATCH}: больше — запрос долгий, по мобильному оборвётся`);
  ok(r.more === true, 'И помечено, что есть ещё: пойдём сразу, не ждя таймера');
}

// ── КОЛЬЦО ОТПРАВКИ ────────────────────────────────────────────────
console.log('\n═══ КОЛЬЦО ОТПРАВКИ ═══\n');
{
  const много = Array.from({ length: 120 }, (_, i) => чек('e' + i, i));
  const store = makeStore(много);
  const сказано = [];
  const watch = { good: () => сказано.push('связь'), bad: () => сказано.push('нет связи') };

  const loop = makeSyncLoop({
    ask: async (p, o) => ({ results: o.body.events.map((e) => ({ id: e.id, result: 'ok' })) }),
    ping: async () => true,
    store,
    getSettings: async () => ({}),
    getState: async () => ({ deviceToken: 'K', employee: { id: 'e1' } }),
    watch,
  });

  await loop.once();
  ok(store.queue.length === 0,
     '★ 120 чеков ушли за один заход: пачками, без ожидания таймера');
}

// ── СВЯЗЬ ПРОВЕРЯЕТСЯ ПРИ ПУСТОЙ ОЧЕРЕДИ ───────────────────────────
{
  const store = makeStore([]);
  const сказано = [];
  const watch = { good: () => сказано.push('жива'), bad: () => сказано.push('мертва') };

  const loop = makeSyncLoop({
    ask: async () => ({ results: [] }),
    ping: async () => { throw new Error('нет сети'); },
    store,
    getSettings: async () => ({}),
    getState: async () => ({ deviceToken: 'K' }),
    watch,
  });

  await loop.once();
  ok(сказано[0] === 'мертва',
     '★ Слать нечего, но связь ПРОВЕРЕНА: иначе зелёная точка при мёртвой сети');
}

// ── КАССА НЕ ПРИВЯЗАНА ─────────────────────────────────────────────
{
  const store = makeStore([чек('a', 1)]);
  let ходили = false;
  const loop = makeSyncLoop({
    ask: async () => { ходили = true; return { results: [] }; },
    ping: async () => { ходили = true; return true; },
    store,
    getSettings: async () => ({}),
    getState: async () => ({ deviceToken: null }),
    watch: { good: () => {}, bad: () => {} },
  });
  await loop.once();
  ok(!ходили, '★ Касса не привязана — на сервер не ходим зря');
}

// ── ЧТО ВИДИТ КАССИР ───────────────────────────────────────────────
console.log('\n═══ ЧТО ВИДИТ КАССИР ═══\n');
{
  ok(queueNote({ left: 0, rejected: 0 }) === null,
     'Всё ушло — молчим: лишнего не пишем');

  const тихо = queueNote({ left: 3, rejected: 0 });
  ok(/не отправлено: 3/.test(тихо), `Копится: «${тихо}»`);

  const без_связи = queueNote({ left: 3, rejected: 0, netDown: true,
    lastSync: new Date('2026-08-21T12:35:00').toISOString() });
  ok(/ушло в 12:35/.test(без_связи),
     `★ И КОГДА ушло: «${без_связи}» — иначе неясно, минуту это или третий час`);

  const беда = queueNote({ left: 0, rejected: 2 });
  ok(/сервер не принял: 2/.test(беда),
     `★ Отклонённые названы отдельно: «${беда}»`);
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
})();
