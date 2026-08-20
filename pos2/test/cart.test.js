/*
 * ПРОВЕРКА ЧЕКА.
 *
 * Главное: слияние строк вперемешку, предел количества, отложенные.
 */
const { MAX_QTY, lineSum, cartTotal, addGood, planQty, removeLine,
  parkCart, unparkCart, staleParked } = require('../renderer/cart.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

const молоко = { id: 'g2', name: 'Молоко 2,5%', price: 480 };
const хлеб = { id: 'g1', name: 'Хлеб', price: 250 };
const яблоки = { id: 'g3', name: 'Яблоки', price: 890, unit: 'кг' };

let n = 0; const newId = () => `p${++n}`;

console.log('═══ ЭТАП 13 · ЧЕК ═══\n');

// ── СЛИЯНИЕ СТРОК ВПЕРЕМЕШКУ ───────────────────────────────────────
{
  const cart = [];
  addGood(cart, молоко);
  addGood(cart, хлеб);
  addGood(cart, молоко);      // покупатель выложил вперемешку

  ok(cart.length === 2, '★ Молоко слилось ЧЕРЕЗ хлеб: строк 2, а не 3');
  ok(cart[0].qty === 2, 'Молока две пачки');
  ok(cart[0].name === 'Молоко 2,5%', 'И название на месте');
}

// ── ВЕСОВОЕ НЕ СЛИВАЕТСЯ ───────────────────────────────────────────
{
  const cart = [];
  addGood(cart, яблоки, 0.45);
  addGood(cart, яблоки, 1.2);
  ok(cart.length === 2,
     '★ Два взвешивания — две строки: 0,45 кг и 1,2 кг это разные покупки');
}

// ── СТРОКА СО СКИДКОЙ НЕ СЛИВАЕТСЯ ─────────────────────────────────
{
  const cart = [];
  const { line } = addGood(cart, молоко);
  line.discount = 50;
  addGood(cart, молоко);
  ok(cart.length === 2,
     '★ Строка со скидкой закрыта для слияния: скидка уже посчитана');
}

// ── ИЗМЕНЁННАЯ ЦЕНА НЕ СЛИВАЕТСЯ ───────────────────────────────────
{
  const cart = [];
  const { line } = addGood(cart, молоко);
  line.priceChanged = true;
  addGood(cart, молоко);
  ok(cart.length === 2, 'Цену меняли — отдельная строка');
}

// ── СЧЁТ ДЕНЕГ ─────────────────────────────────────────────────────
{
  const cart = [];
  addGood(cart, молоко, 2);        // 960
  addGood(cart, хлеб);             // 250
  ok(cartTotal(cart) === 1210, `Итог: ${cartTotal(cart)} ₸`);

  cart[0].discount = 100;
  ok(cartTotal(cart) === 1110, 'Скидка на строку вычтена');
  ok(cartTotal(cart, 200) === 910, 'И скидка на чек тоже');

  ok(cartTotal(cart, 99999) === 0,
     '★ Скидка больше чека — итог НОЛЬ, а не минус: касса не платит покупателю');
}

// ── ВЕСОВОЕ СЧИТАЕТСЯ БЕЗ КОПЕЕК ───────────────────────────────────
{
  const cart = [];
  addGood(cart, яблоки, 0.45);     // 890 × 0,45 = 400,5
  ok(lineSum(cart[0]) === 401,
     `★ Дробная сумма округлена: ${lineSum(cart[0])} ₸, а не 400,5 — копеек в кассе нет`);
}

// ── ПРЕДЕЛ КОЛИЧЕСТВА ──────────────────────────────────────────────
console.log('\n═══ КОЛИЧЕСТВО ═══\n');
{
  const line = { qty: 3, price: 480 };

  ok(planQty(line, 5).act === 'set', 'Больше — ставим молча');
  ok(planQty(line, 2).act === 'ask' && planQty(line, 2).action === 'reduce_qty',
     '★ Меньше — спрашиваем разрешение: это как отмена');
  ok(planQty(line, 0).act === 'ask' && planQty(line, 0).action === 'remove_item',
     'Ноль — это удаление строки');

  const много = planQty(line, 99999);
  ok(много.act === 'deny' && /опечатк/.test(много.said),
     `★ ${MAX_QTY} с лишним — отказ: «${много.said}»`);
  ok(planQty(line, MAX_QTY).act === 'set', `Ровно ${MAX_QTY} — можно`);

  ok(planQty(line, -5).act === 'deny', 'Отрицательное — отказ');
  ok(planQty(line, 'абв').act === 'deny', 'Не число — отказ');
}

// ── ОТЛОЖЕННЫЕ ЧЕКИ ────────────────────────────────────────────────
console.log('\n═══ ОТЛОЖЕННЫЕ ═══\n');
{
  const parked = [];
  const cart = [];
  addGood(cart, молоко, 2);
  addGood(cart, хлеб);

  const r = parkCart(parked, cart, 0, { newId });
  ok(r.ok && parked.length === 1, '★ Чек отложен: очередь идёт дальше');
  ok(r.entry.items === 2 && r.entry.total === 1210,
     `И видно, что в нём: ${r.entry.items} позиции на ${r.entry.total} ₸`);
  ok(/^\d\d:\d\d$/.test(r.entry.label),
     `★ Помечен временем «${r.entry.label}»: кассир ищет «тот, что в 14:20»`);

  // Чек на кассе чистят — отложенный не должен пострадать
  cart.length = 0;
  ok(parked[0].cart.length === 2, '★ Чистка кассы не тронула отложенный: он копия');

  const u = unparkCart(parked, r.entry.id);
  ok(u.ok && u.cart.length === 2 && parked.length === 0,
     '★ Достали обратно: две строки на месте');

  ok(!unparkCart(parked, r.entry.id).ok, 'Второй раз не достать — его уже забрали');
  ok(!parkCart(parked, [], 0, { newId }).ok, 'Пустой чек откладывать нечего');
}

// ── СТАРЫЕ ОТЛОЖЕННЫЕ ──────────────────────────────────────────────
{
  const свежий = { id: 'a', at: new Date().toISOString() };
  const вчерашний = { id: 'b', at: new Date(Date.now() - 20 * 3600000).toISOString() };
  const s = staleParked([свежий, вчерашний]);

  ok(s.length === 1 && s[0].id === 'b',
     '★ Вчерашний отложенный найден: покупатель не вернулся');
  ok(staleParked([свежий]).length === 0, 'Свежий не тревожим');
}

// ── УБРАТЬ СТРОКУ ──────────────────────────────────────────────────
{
  const cart = [];
  addGood(cart, молоко);
  const { line } = addGood(cart, хлеб);
  removeLine(cart, line);
  ok(cart.length === 1 && cart[0].name === 'Молоко 2,5%', 'Строка убрана, соседняя цела');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
