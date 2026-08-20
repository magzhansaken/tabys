/*
 * ПРОВЕРКА ЧЕКА.
 *
 * Слияние строк, предел количества, отмена с разрешением, отложенные.
 */
const { lineSum, cartTotal, cartCount, canMerge, addToCart,
        qtyAllowed, setQty, removeLine, parkCart, unparkCart } = require('../renderer/cart.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

let счёт = 0;
const newId = () => `l${++счёт}`;
const да = async () => ({ ok: true, approvedName: 'Ерлан' });
const нет = async () => ({ ok: false, said: 'Это действие вам не разрешено' });

const хлеб = { id: 'g1', name: 'Хлеб', price: 250 };
const молоко = { id: 'g2', name: 'Молоко', price: 420 };
const сыр = { id: 'g3', name: 'Сыр весовой', price: 4200, unit: 'кг' };
const водка = { id: 'g4', name: 'Водка', price: 2500, marked: true };

console.log('═══ ЭТАП 13 · ЧЕК ═══\n');

(async () => {

// ── СЛИЯНИЕ СТРОК ──────────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, хлеб, 1, newId);
  addToCart(cart, хлеб, 1, newId);
  ok(cart.length === 1 && cart[0].qty === 2,
     '★ Тот же товар подряд — одна строка, количество выросло');
}
{
  const cart = [];
  addToCart(cart, хлеб, 1, newId);
  addToCart(cart, молоко, 1, newId);
  addToCart(cart, хлеб, 1, newId);
  ok(cart.length === 2,
     '★ Хлеб, молоко, хлеб — ДВЕ строки: покупатель выкладывает вперемешку');
  ok(cart[0].name === 'Хлеб' && cart[0].qty === 2,
     'Второй хлеб сложился с первым: иначе покупатель решит, что обсчитали');
  ok(cart[1].name === 'Молоко 2,5%',
     'А порядок строк не сбился: молоко там же, где было');
}
{
  const cart = [];
  addToCart(cart, сыр, 0.45, newId);
  addToCart(cart, сыр, 0.6, newId);
  ok(cart.length === 2,
     '★ Два взвешивания сыра — две строки: кассир видит оба');
}
{
  const cart = [];
  addToCart(cart, водка, 1, newId);
  addToCart(cart, водка, 1, newId);
  ok(cart.length === 2,
     '★ Маркированный не сливается: у каждой пачки своя марка');
}
{
  const cart = [];
  addToCart(cart, хлеб, 1, newId);
  cart[0].discount = 50;
  addToCart(cart, хлеб, 1, newId);
  ok(cart.length === 2,
     '★ Со скидкой не сливается: иначе скидка расползётся на весь товар');
}

// ── СЧЁТ ДЕНЕГ ─────────────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, хлеб, 3, newId);
  ok(lineSum(cart[0]) === 750, 'Строка: 250 × 3 = 750');

  addToCart(cart, сыр, 0.45, newId);
  ok(lineSum(cart[1]) === 1890, '★ Весовой: 4200 × 0.45 = 1890, без хвостов');

  cart[0].discount = 100;
  ok(lineSum(cart[0]) === 650, 'Скидка вычтена');
  ok(cartTotal(cart) === 2540, `Итог чека: ${cartTotal(cart)}`);
}
{
  // Дробные числа не дают хвостов
  const cart = [];
  addToCart(cart, { id: 'x', name: 'Мясо', price: 3333 }, 0.3, newId);
  const s = lineSum(cart[0]);
  ok(Number.isInteger(s), `★ Итог целый: ${s}, а не 999.9000000000001`);
}
{
  const cart = [];
  addToCart(cart, хлеб, 3, newId);
  addToCart(cart, сыр, 0.45, newId);
  ok(cartCount(cart) === 4, '★ В чеке 4: три хлеба и одно взвешивание');
}

// ── ПРЕДЕЛ КОЛИЧЕСТВА ──────────────────────────────────────────────
{
  ok(qtyAllowed(5).ok && qtyAllowed(1000).ok, 'Обычные числа проходят');
  ok(!qtyAllowed(1001).ok, '★ Больше тысячи — отказ');
  ok(/опечатку/.test(qtyAllowed(99999).said),
     `★ И объяснено: «${qtyAllowed(99999).said}»`);
  ok(!qtyAllowed(0).ok && !qtyAllowed(-5).ok, 'Ноль и минус не проходят');
  ok(!qtyAllowed('абв').ok, 'Не число — тоже отказ');
}

// ── КОЛИЧЕСТВО И РАЗРЕШЕНИЕ ────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, хлеб, 1, newId);
  const r = await setQty(cart, cart[0], 5, { allow: нет });
  ok(r.ok && cart[0].qty === 5,
     '★ УВЕЛИЧЕНИЕ без разрешения: кассир добавляет товар, это не убыток');
}
{
  const cart = [];
  addToCart(cart, хлеб, 5, newId);
  const r = await setQty(cart, cart[0], 2, { allow: да });
  ok(r.ok && cart[0].qty === 2, 'Уменьшение с разрешения прошло');
  ok(r.approval.approvedName === 'Ерлан', '★ И подпись ушла в журнал');
}
{
  const cart = [];
  addToCart(cart, хлеб, 5, newId);
  const r = await setQty(cart, cart[0], 2, { allow: нет });
  ok(!r.ok && cart[0].qty === 5,
     '★ Отказано — количество НЕ изменилось: касса не делает вид');
}
{
  const cart = [];
  addToCart(cart, хлеб, 1, newId);
  const r = await removeLine(cart, cart[0], { allow: да });
  ok(r.ok && r.removed && cart.length === 0, 'Строка убрана с разрешения');
}
{
  const cart = [];
  addToCart(cart, хлеб, 1, newId);
  const r = await setQty(cart, cart[0], 9999, { allow: да });
  ok(!r.ok && /опечатку/.test(r.said) && cart[0].qty === 1,
     '★ Опечатка отбита ДО разрешения: старшего зря не позвали');
}

// ── МАРКИ СНИМАЮТСЯ ВМЕСТЕ С ТОВАРОМ ───────────────────────────────
{
  const cart = [];
  addToCart(cart, водка, 3, newId);
  cart[0].codes = ['M1', 'M2', 'M3'];
  let снято = 0;
  const trimMarks = (l) => {
    const need = Math.max(0, Math.ceil(l.qty));
    if (l.codes.length > need) { снято = l.codes.length - need; l.codes.length = need; }
  };
  await setQty(cart, cart[0], 1, { allow: да, trimMarks });
  ok(cart[0].codes.length === 1 && снято === 2,
     '★ Убрали две бутылки — снялись две марки: лишние не уйдут в налоговую');
}

// ── ОТЛОЖЕННЫЕ ЧЕКИ ────────────────────────────────────────────────
console.log('\n═══ ОТЛОЖЕННЫЕ ЧЕКИ ═══\n');
{
  const st = { parked: [] };
  const store = { getState: async () => st, saveState: async (p) => Object.assign(st, p) };

  const cart = [];
  addToCart(cart, хлеб, 2, newId);
  addToCart(cart, молоко, 1, newId);

  const r = await parkCart(store, cart, { newId, who: 'Айгуль' });
  ok(r.ok && st.parked.length === 1, 'Чек отложен');
  ok(st.parked[0].total === 920, `И сумма запомнена: ${st.parked[0].total}`);
  ok(st.parked[0].by === 'Айгуль', '★ И кто отложил: разбираться будет владелец');

  // Меняем свой чек — отложенный не должен измениться
  cart[0].qty = 99;
  ok(st.parked[0].lines[0].qty === 2,
     '★ Отложенный — КОПИЯ: правка в текущем чеке его не трогает');

  const back = await unparkCart(store, st.parked[0].id);
  ok(back.ok && back.lines.length === 2, 'Чек вернулся с двумя строками');
  ok(st.parked.length === 0,
     '★ И ушёл из списка: чек один, а не размножается');

  const снова = await unparkCart(store, 'нет-такого');
  ok(!снова.ok && /уже забрали/.test(снова.said),
     'Второй раз тот же чек не забрать');
}
{
  const st = { parked: [] };
  const store = { getState: async () => st, saveState: async (p) => Object.assign(st, p) };
  const r = await parkCart(store, [], { newId });
  ok(!r.ok && /пуст/.test(r.said), 'Пустой чек откладывать нечего');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
})();
