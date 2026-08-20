/*
 * ПРОВЕРКА СКИДОК.
 *
 * Главное: скидка не плывёт при правке чека, и два потолка не обойти.
 */
const { PRESETS, pctToAmount, amountToPct, checkDiscount, capFor, capHint,
  applyLineDiscount, fitDiscount } = require('../renderer/discount.js');
const { addToCart, cartTotal, lineSum } = require('../renderer/cart.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

let ln = 0; const newId = () => `l${++ln}`;
const кассир = { id: 'e1', name: 'Айгуль', discountLimitPct: 10 };
const старший = { id: 'e2', name: 'Ерлан', discountLimitPct: 30, isShiftAdmin: true };
const хозяин = { id: 'e3', name: 'Нурлан', isOwner: true };

console.log('═══ ЭТАП 15 · СКИДКИ ═══\n');

// ── СКИДКА НЕ ПЛЫВЁТ ───────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, { id: 'g1', name: 'Товар', price: 5000 }, 1, newId);

  // Кассир дал 10% от 5 000 = 500
  const скидка = pctToAmount(cartTotal(cart), 10);
  ok(скидка === 500, `10% от 5 000 = ${скидка} ₸`);

  // Покупатель вспомнил про пакет
  addToCart(cart, { id: 'g2', name: 'Пакет', price: 30 }, 1, newId);

  ok(скидка === 500,
     '★ Добавили пакет — скидка ОСТАЛАСЬ 500, а не выросла до 503');
  ok(pctToAmount(cartTotal(cart), 10) === 503,
     'Хранили бы процентом — стало бы 503: деньги, которых кассир не давал');
}

// ── ДВА ПОТОЛКА ────────────────────────────────────────────────────
{
  ok(capFor({ shopMaxPct: 30, employee: кассир }) === 10,
     '★ Магазин 30, кассир 10 → предел 10%');
  ok(capFor({ shopMaxPct: 10, employee: старший }) === 10,
     '★ Магазин 10, старший 30 → всё равно 10%: с другой стороны не обойти');
  ok(capFor({ shopMaxPct: 30, employee: хозяин }) === 30,
     'У владельца личного предела нет — правит магазин');
  ok(capFor({ shopMaxPct: null, employee: хозяин }) === 100,
     'Ни магазин, ни человек не ограничены — без предела');
}

// ── ПРОВЕРКА СКИДКИ ────────────────────────────────────────────────
{
  const base = 5000;

  ok(checkDiscount(400, { base, capPct: 10 }).ok, '400 при пределе 10% — можно');
  ok(checkDiscount(500, { base, capPct: 10 }).ok, 'Ровно предел — можно');

  const сверх = checkDiscount(700, { base, capPct: 10 });
  ok(!сверх.ok && сверх.needSenior,
     '★ Сверх предела — не ОТКАЗ, а «нужен старший»');
  ok(/Ваш предел — 10% \(500 ₸\)/.test(сверх.said),
     `★ И названо в процентах И в деньгах: «${сверх.said}»`);

  const больше = checkDiscount(6000, { base, capPct: 100 });
  ok(!больше.ok && !больше.needSenior && /больше суммы/.test(больше.said),
     '★ Скидка больше чека — отказ насовсем: касса не платит покупателю');

  ok(checkDiscount(0, { base, capPct: 10 }).ok, 'Снять скидку можно всегда');
  ok(!checkDiscount(-100, { base, capPct: 10 }).ok, 'Отрицательная — отказ');
}

// ── ПОДСКАЗКА НАД ПОЛЕМ ────────────────────────────────────────────
{
  const свой = capHint({ base: 5000, employee: кассир, shopMaxPct: 30 });
  ok(/Ваш предел — 10%/.test(свой) && /500 ₸/.test(свой),
     `★ Личный предел: «${свой}»`);

  const общий = capHint({ base: 5000, employee: хозяин, shopMaxPct: 30 });
  ok(/в этом магазине не дают/.test(общий),
     `★ Предел магазина назван иначе: «${общий}»`);

  ok(capHint({ base: 5000, employee: хозяин, shopMaxPct: null }) === null,
     'Без предела — и подсказки нет: лишнего не пишем');
}

// ── СКИДКА НА ПОЗИЦИЮ ──────────────────────────────────────────────
{
  const cart = [];
  addToCart(cart, { id: 'g1', name: 'Хлеб', price: 250 }, 2, newId);

  const r = applyLineDiscount(cart[0], 100);
  ok(r.ok && lineSum(cart[0]) === 400,
     '★ Скидка на строку: 500 − 100 = 400');

  const много = applyLineDiscount(cart[0], 9999);
  ok(!много.ok && /больше строки/.test(много.said),
     '★ Скидка больше строки — отказ с суммой строки');
}

// ── СКИДКА ПОСЛЕ УДАЛЕНИЯ ТОВАРА ───────────────────────────────────
{
  // Чек был 5 030, скидка 500. Убрали товар — осталось 300.
  const r = fitDiscount(300, 500);
  ok(r.discount === 300 && r.trimmed === 200,
     '★ Убрали товар — скидка поджата до остатка: итог не ушёл в минус');

  ok(fitDiscount(5000, 500).discount === 500,
     'Чек больше скидки — не трогаем');
  ok(fitDiscount(0, 500).discount === 0, 'Чек опустел — скидки нет');
}

// ── ПЕРЕСЧЁТ ───────────────────────────────────────────────────────
{
  ok(pctToAmount(5000, 10) === 500, '10% от 5 000 = 500');
  ok(pctToAmount(4999, 10) === 500, 'Округление вверх: 499,9 → 500');
  ok(amountToPct(5000, 500) === 10, 'И обратно: 500 от 5 000 = 10%');
  ok(amountToPct(0, 500) === 0, 'Пустой чек — ноль процентов, а не деление на ноль');
  ok(PRESETS.length === 3, `Обычные скидки под рукой: ${PRESETS.join('%, ')}%`);
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
