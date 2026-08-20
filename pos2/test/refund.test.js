/*
 * ПРОВЕРКА ВОЗВРАТОВ И ДВИЖЕНИЯ ДЕНЕГ.
 *
 * Главное: не отдать деньги дважды, не уйти в минус по ящику, оставить
 * след с подписью.
 */
const { REFUND_REASONS, CASH_MOVES, planRefund, buildRefund, buildCashMove,
  needsNote, refundLines } = require('../renderer/refund.js');
const { receiptLines } = require('../renderer/receipt.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

let ln = 0; const newId = () => `r${++ln}`;

const чек = {
  id: 'rec-1', number: 57,
  items: [
    { productId: 'g1', name: 'Молоко 2,5%', qty: 2, price: 480, discount: 0 },
    { productId: 'g2', name: 'Хлеб', qty: 1, price: 250, discount: 0 },
    { productId: 'g3', name: 'Сыр', qty: 1, price: 4270, discount: 200, marks: ['M1'] },
  ],
  total: 5481,
};

const state = {
  lastNumber: 60, cashInDrawer: 45000, storeName: 'Мини-маркет',
  registerName: 'Касса 1', employee: { id: 'e1', name: 'Айгуль' }, shift: { id: 's1' },
};

console.log('═══ ЭТАП 19 · ВОЗВРАТЫ ═══\n');

// ── ЧАСТИЧНЫЙ ВОЗВРАТ ──────────────────────────────────────────────
{
  const p = planRefund(чек, [{ idx: 1, qty: 1 }]);
  ok(p.ok && p.total === 250,
     '★ Вернули ОДИН хлеб из чека на 5 481: частичный возврат обязателен');
  ok(!p.full, 'И это не весь чек');

  const весь = planRefund(чек, [{ idx: 0, qty: 2 }, { idx: 1, qty: 1 }, { idx: 2, qty: 1 }]);
  ok(весь.ok && весь.full, 'А тут весь чек целиком');
}

// ── ЧАСТЬ КОЛИЧЕСТВА ───────────────────────────────────────────────
{
  const p = planRefund(чек, [{ idx: 0, qty: 1 }]);
  ok(p.ok && p.total === 480,
     '★ Из двух пачек молока вернули одну: считаем по одной цене');
}

// ── ДЕНЬГИ ДВАЖДЫ НЕ ОТДАЁМ ────────────────────────────────────────
{
  const уже = {
    ...чек,
    items: чек.items.map((it, i) => (i === 0 ? { ...it, returned: 1 } : it)),
  };

  const p = planRefund(уже, [{ idx: 0, qty: 2 }]);
  ok(!p.ok && /можно вернуть только 1/.test(p.said),
     `★ Одну пачку уже возвращали — вторую отдать можно, а две нельзя`);

  const всё = {
    ...чек,
    items: чек.items.map((it, i) => (i === 1 ? { ...it, returned: 1 } : it)),
  };
  const p2 = planRefund(всё, [{ idx: 1, qty: 1 }]);
  ok(!p2.ok && /уже всё возвращено/.test(p2.said),
     '★ Строку вернули целиком — второй раз денег не отдаём');
}

// ── ПУСТОЙ ВЫБОР ───────────────────────────────────────────────────
{
  ok(!planRefund(чек, []).ok, 'Ничего не выбрали — не возвращаем');
  ok(!planRefund(null, [{ idx: 0, qty: 1 }]).ok, 'Чека нет — не возвращаем');
  ok(!planRefund(чек, [{ idx: 99, qty: 1 }]).ok, 'Строки нет — не возвращаем');
}

// ── ЗАПИСЬ ВОЗВРАТА ────────────────────────────────────────────────
console.log('\n═══ ЗАПИСЬ ВОЗВРАТА ═══\n');
{
  const p = planRefund(чек, [{ idx: 2, qty: 1 }]);
  const r = buildRefund({
    receipt: чек, plan: p, reason: 'Брак или просрочка', way: 'cash',
    approval: { approvedBy: 'e2', approvedName: 'Ерлан',
      offlineNote: 'код старшего проверен на кассе (без связи)' },
    state, newId,
  });

  ok(r.kind === 'refund' && r.number === 61, 'Возврат — отдельная запись со своим номером');
  ok(r.ofReceiptId === 'rec-1' && r.ofReceiptNumber === 57,
     '★ Ссылается на чек: без этого возврат не сверить с продажей');
  ok(r.approvedName === 'Ерлан',
     '★ Подпись старшего в записи: владелец видит, кто отвечает');
  ok(/без связи/.test(r.offlineNote),
     '★ И как проверена: кассой, а не сервером');
  ok(r.reason === 'Брак или просрочка', 'Причина записана');
  ok(r.cashDelta === -4070,
     `★ Из ящика ушло ${-r.cashDelta} ₸ — со знаком минус`);
  ok(r.items[0].marks.length === 1,
     '★ Марки возвращаются В ОБОРОТ: товар снова можно продать');

  const картой = buildRefund({ receipt: чек, plan: p, way: 'card', state, newId });
  ok(картой.cashDelta === 0,
     '★ Вернули на карту — ящик не тронут: деньги уйдут через банк');
}

// ── ДВИЖЕНИЕ НАЛИЧНЫХ ──────────────────────────────────────────────
console.log('\n═══ НАЛИЧНЫЕ МИМО ЧЕКОВ ═══\n');
{
  const внесли = buildCashMove({ type: 'cash_in', amount: 20000, state, newId });
  ok(внесли.ok && внесли.move.delta === 20000, 'Внесли размен — ящик вырос');

  const взяли = buildCashMove({ type: 'cash_out', amount: 5000,
    note: 'Купили ленту для принтера', state, newId });
  ok(взяли.ok && взяли.move.delta === -5000, 'Изъяли — ящик уменьшился');
  ok(взяли.move.note === 'Купили ленту для принтера',
     '★ Причина записана: «взяли 5 000» без слов — дыра в отчёте');

  const инкассация = buildCashMove({ type: 'collection', amount: 40000, state, newId });
  ok(инкассация.ok && инкассация.move.delta === -40000, 'Инкассация — сдали выручку');
}

// ── ИЗ ЯЩИКА НЕ ВЗЯТЬ БОЛЬШЕ, ЧЕМ В НЁМ ЕСТЬ ───────────────────────
{
  const много = buildCashMove({ type: 'cash_out', amount: 99999, state, newId });
  ok(!много.ok && /В ящике 45000 ₸/.test(много.said),
     `★ Взять больше, чем есть, нельзя: «${много.said}»`);

  // А внести можно сколько угодно: деньги приносят снаружи
  ok(buildCashMove({ type: 'cash_in', amount: 99999, state, newId }).ok,
     'А внести можно сколько угодно: деньги приносят снаружи');
}

// ── ОТКАЗЫ ─────────────────────────────────────────────────────────
{
  ok(!buildCashMove({ type: 'cash_out', amount: 0, state, newId }).ok, 'Ноль — отказ');
  ok(!buildCashMove({ type: 'cash_out', amount: -100, state, newId }).ok, 'Минус — отказ');
  ok(!buildCashMove({ type: 'ерунда', amount: 100, state, newId }).ok, 'Чужой вид — отказ');
  ok(needsNote('cash_out') && !needsNote('cash_in'),
     '★ Причина обязательна для ИЗЪЯТИЯ, а не для внесения');
}

// ── ЛЕНТА ВОЗВРАТА ─────────────────────────────────────────────────
console.log('\n═══ ЛЕНТА ВОЗВРАТА ═══\n');
{
  const p = planRefund(чек, [{ idx: 1, qty: 1 }]);
  const r = buildRefund({ receipt: чек, plan: p, reason: 'Не подошёл товар',
    way: 'cash', state, newId });
  const lines = refundLines({ ...r, at: '2026-08-21T15:00:00' }, 48, { receiptLines });

  const текст = (l) => (typeof l === 'string' ? l : (l && l.text) || '');
  const весь = lines.map(текст);

  ok(весь.some((l) => l.includes('ВОЗВРАТ')),
     '★ На ленте написано ВОЗВРАТ: иначе покупатель примет её за чек');
  ok(весь.some((l) => /к чеку №57/.test(l)), 'И к какому чеку');
  ok(весь.some((l) => /Причина: Не подошёл товар/.test(l)),
     '★ Причина на ленте: владелец читает её при разборе');
  ok(lines.find((l) => текст(l) === 'ВОЗВРАТ').bold === true,
     '★ И ЖИРНЫМ: кассир не спутает её с обычным чеком в пачке');
}

// ── ПРИЧИНЫ ────────────────────────────────────────────────────────
{
  ok(REFUND_REASONS.length === 4, `Причины под рукой: ${REFUND_REASONS.length}`);
  ok(REFUND_REASONS.every((r) => /[а-яё]/i.test(r)), 'Все по-русски');
  ok(Object.values(CASH_MOVES).every((m) => m.hint && /[а-яё]/i.test(m.hint)),
     '★ У каждого движения денег есть подсказка: кассир не гадает');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
