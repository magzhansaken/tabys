/*
 * ПРОВЕРКА ПРАВ И ПРЕДЕЛОВ.
 *
 * Главное: старший не зовёт сам себя, а код старшего работает без
 * сети — иначе «упал роутер» превращается в «встала касса».
 */
const { decide, selfAllowed, approve, discountCap, capText } = require('../renderer/rights.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

const кассир = { id: 'e1', name: 'Айгуль', permissions: { pos: { view: true, create: true } } };
const старший = { id: 'e2', name: 'Ерлан', isShiftAdmin: true };
const владелец = { id: 'e3', name: 'Нурлан', isOwner: true };
const кассирСправом = { id: 'e4', name: 'Асель', permissions: { pos: { void: true } } };

console.log('═══ ЭТАП 9 · ПРАВА ═══\n');

// ── ПРАВИЛО МАГАЗИНА ───────────────────────────────────────────────
{
  const всем = { actions: { remove_item: 'everyone' } };
  const сразрешения = { actions: { remove_item: 'admin_only' } };
  const никому = { actions: { remove_item: 'nobody' } };

  ok(decide({ settings: всем, employee: кассир, action: 'remove_item' }) === 'free',
     'Магазин разрешил всем — идём молча');
  ok(decide({ settings: сразрешения, employee: кассир, action: 'remove_item' }) === 'senior',
     'Магазин требует разрешения — зовём старшего');
  ok(decide({ settings: никому, employee: владелец, action: 'remove_item' }) === 'never',
     '★ Запрет владельца сильнее ВСЕГО, даже его собственных прав');
}

// ── СТАРШИЙ НЕ ЗОВЁТ САМ СЕБЯ ──────────────────────────────────────
{
  const s = { actions: { remove_item: 'admin_only', discount: 'admin_only' } };
  ok(decide({ settings: s, employee: старший, action: 'remove_item' }) === 'free',
     '★ Старший смены отменяет САМ: не стоит у своей кассы с своим кодом');
  ok(decide({ settings: s, employee: владелец, action: 'discount' }) === 'free',
     '★ Владелец тоже: звать ему некого');
  ok(decide({ settings: s, employee: кассир, action: 'remove_item' }) === 'senior',
     'А обычный кассир — зовёт');
  ok(decide({ settings: s, employee: кассирСправом, action: 'remove_item' }) === 'free',
     '★ Кассир с личным правом отменять — тоже сам');
}

// ── ПРАВА ПО РАЗДЕЛАМ ──────────────────────────────────────────────
{
  ok(selfAllowed(кассирСправом, 'remove_item') && selfAllowed(кассирСправом, 'reduce_qty'),
     'Право «отменять» открывает и удаление, и уменьшение');
  ok(!selfAllowed(кассирСправом, 'refund'),
     '★ Но НЕ возврат: это другие деньги, и право другое');
  ok(!selfAllowed(null, 'remove_item') && !selfAllowed({}, 'remove_item'),
     'Без человека и без прав — нельзя');
}

// ── КОД СТАРШЕГО: ШЕСТЬ ИСХОДОВ ────────────────────────────────────
console.log('\n═══ КОД СТАРШЕГО ═══\n');

const pinPrint = async (pin, key) => `след:${pin}:${key}`;
const makeStore = (box = {}) => ({ passRead: async (p) => box[p] || null });

(async () => {
  // 1. Сервер жив, код верный
  {
    const r = await approve({ ask: async () => ({ ok: true, employeeId: 'e2', name: 'Ерлан' }),
      store: makeStore(), settings: {}, deviceToken: 'K', pin: '1111',
      action: 'remove_item', pinPrint });
    ok(r.ok && r.byName === 'Ерлан' && r.note === null,
       'Сервер жив, код верный — разрешил, пометки нет');
  }

  // 2. Сервер жив, код неверный
  {
    const ask = async () => { const e = new Error('Код не подошёл'); e.serverAnswered = true; throw e; };
    const box = { 'след:9999:K': { employee: старший } };
    const r = await approve({ ask, store: makeStore(box), settings: {},
      deviceToken: 'K', pin: '9999', action: 'remove_item', pinPrint });
    ok(!r.ok, '★ Сервер ЖИВ и отказал — верим ему, пропуск не спасает');
  }

  // 3. Сервер молчит, код старшего известен
  {
    const ask = async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; };
    const box = { 'след:2222:K': { employee: старший } };
    const r = await approve({ ask, store: makeStore(box), settings: {},
      deviceToken: 'K', pin: '2222', action: 'remove_item', pinPrint });
    ok(r.ok && r.byName === 'Ерлан', '★ Сеть упала — код старшего РАБОТАЕТ');
    ok(/проверен на кассе/.test(r.note),
       `★ И в отчёт идёт пометка: «${r.note}»`);
  }

  // 4. Сервер молчит, код кассира — прав не даёт
  {
    const ask = async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; };
    const box = { 'след:3333:K': { employee: кассир } };
    const r = await approve({ ask, store: makeStore(box), settings: {},
      deviceToken: 'K', pin: '3333', action: 'remove_item', pinPrint });
    ok(!r.ok && /не даёт права/.test(r.said),
       '★ Код узнан, но человек не старший — отказ настоящий');
  }

  // 5. Сервер молчит, код чужой
  {
    const ask = async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; };
    const r = await approve({ ask, store: makeStore(), settings: {},
      deviceToken: 'K', pin: '9999', action: 'remove_item', pinPrint });
    ok(r.ok, '★ Незнакомый код без связи — ПРОПУСКАЕМ: очередь важнее');
    ok(/не проверен/.test(r.note),
       `★ Но отчёт узнает правду: «${r.note}»`);
  }

  // 6. Кассир с правом сам разрешает без сети
  {
    const ask = async () => { const e = new Error('нет связи'); e.serverAnswered = false; throw e; };
    const box = { 'след:4444:K': { employee: кассирСправом } };
    const r = await approve({ ask, store: makeStore(box), settings: {},
      deviceToken: 'K', pin: '4444', action: 'remove_item', pinPrint });
    ok(r.ok && r.byName === 'Асель',
       'Кассир с личным правом разрешает и без сети');
  }

  // ── ПРЕДЕЛ СКИДКИ: ДВА ПОТОЛКА ───────────────────────────────────
  console.log('\n═══ ПРЕДЕЛ СКИДКИ ═══\n');
  {
    const база = 10000;
    const c1 = discountCap({ settings: { discountMaxPct: 30 },
      employee: { discountLimitPct: 10 }, base: база });
    ok(c1.pct === 10 && c1.sum === 1000,
       `★ Магазин 30%, свой 10% → берём 10% = ${c1.sum} ₸`);

    const c2 = discountCap({ settings: { discountMaxPct: 10 },
      employee: { discountLimitPct: 30 }, base: база });
    ok(c2.pct === 10, '★ Магазин 10%, свой 30% → всё равно 10%: не обойти');

    const c3 = discountCap({ settings: { discountMaxPct: 100 },
      employee: владелец, base: база });
    ok(c3.pct === 100, 'Владелец без предела');

    const c4 = discountCap({ settings: {}, employee: кассир, base: база });
    ok(c4.pct === 100, 'Магазин не задал, у кассира нет — сто процентов');

    ok(/ваш предел 10%/.test(capText(c1)), `★ Сказано, ЧЕЙ предел: «${capText(c1)}»`);
    ok(/больше 10% не даём/.test(capText(c2)), `А тут магазинный: «${capText(c2)}»`);
    ok(capText(c3) === '', 'Без предела — молчим, лишних слов не надо');
  }

  console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
  process.exit(failed ? 1 : 0);
})();
