/*
 * ПРОВЕРКА ОТЧЁТОВ.
 *
 * Главное: числа сходятся, X не путают с Z, расхождение видно.
 */
const { shiftSummary, reportLines, num } = require('../renderer/report.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

const смена = { id: 's1', openedAt: '2026-08-21T08:00:00', openingCash: 20000 };

/* Смена как в жизни: продажи наличными и картой, скидка, возврат,
   размен и инкассация. */
const чеки = [
  { shiftId: 's1', total: 1620, way: 'cash', cashDelta: 1620, discount: 0,
    items: [{ discount: 0 }, { discount: 0 }] },
  { shiftId: 's1', total: 4800, way: 'card', cashDelta: 0, discount: 200,
    items: [{ discount: 100 }] },
  { shiftId: 's1', total: 900, way: 'cash', cashDelta: 900, discount: 0,
    items: [{ discount: 0 }] },
  { shiftId: 's2', total: 5000, way: 'cash', cashDelta: 5000, items: [{}] },  // чужая смена
  { shiftId: 's1', kind: 'refund', total: 480, way: 'cash', cashDelta: -480, items: [{}] },
];

const движения = [
  { shiftId: 's1', delta: 5000, type: 'cash_in' },
  { shiftId: 's1', delta: -3000, type: 'cash_out' },
];

console.log('═══ ЭТАП 20 · ОТЧЁТЫ ═══\n');

// ── СВОДКА СЧИТАЕТСЯ ВЕРНО ─────────────────────────────────────────
{
  const state = { cashInDrawer: 20000 + 1620 + 900 + 5000 - 3000 - 480 };
  const s = shiftSummary({ receipts: чеки, moves: движения, shift: смена, state });

  ok(s.checks === 3, `★ Чеков ТРИ: чужая смена не в счёт (было ${чеки.length} записей)`);
  ok(s.refunds === 1, 'И один возврат');
  ok(s.revenue === 7320, `Выручка ${s.revenue} = 1620 + 4800 + 900`);
  ok(s.returned === 480, 'Возвращено 480');
  ok(s.net === 6840, `★ Чистая выручка ${s.net}: за вычетом возврата`);
  ok(s.discounts === 300, `★ Скидки посчитаны отдельно: ${s.discounts} — первое, что спросит владелец`);
  ok(s.gross === 7620, 'Сумма до скидок');
  ok(s.avgCheck === 2440, `Средний чек ${s.avgCheck}`);
}

// ── ОПЛАТЫ ПО СПОСОБАМ ─────────────────────────────────────────────
{
  const s = shiftSummary({ receipts: чеки, moves: движения, shift: смена, state: {} });
  ok(s.payments.cash === 2520 && s.payments.card === 4800,
     '★ Разбивка по способам: карту сверяют с банком, наличные с ящиком');
}

// ── ЯЩИК СХОДИТСЯ ──────────────────────────────────────────────────
{
  const ведёт = 20000 + 1620 + 900 + 5000 - 3000 - 480;
  const s = shiftSummary({ receipts: чеки, moves: движения, shift: смена,
    state: { cashInDrawer: ведёт } });

  ok(s.openingCash === 20000, 'Размен на месте');
  ok(s.cashSales === 2520, 'Наличная выручка');
  ok(s.cashIn === 5000 && s.cashOut === 3000, 'Внесения и изъятия');
  ok(s.cashRefunds === 480, 'Возвраты наличными');
  ok(s.expectedCash === ведёт, `★ Должно быть в ящике: ${s.expectedCash}`);
  ok(s.drift === 0,
     '★ ДВА ПУТИ СОШЛИСЬ: расчёт из чеков и то, что вела касса');
}

// ── РАСХОЖДЕНИЕ ВИДНО ──────────────────────────────────────────────
{
  // Касса потеряла запись: ящик показывает на 500 больше
  const s = shiftSummary({ receipts: чеки, moves: движения, shift: смена,
    state: { cashInDrawer: 20000 + 1620 + 900 + 5000 - 3000 - 480 + 500 } });

  ok(s.drift === 500,
     '★ Пути разошлись на 500 — это видно СЕЙЧАС, а не когда придёт владелец');
}

// ── ПУСТАЯ СМЕНА ───────────────────────────────────────────────────
{
  const s = shiftSummary({ receipts: [], moves: [], shift: смена, state: {} });
  ok(s.checks === 0 && s.avgCheck === 0,
     '★ Пустая смена не роняет: средний чек ноль, а не деление на ноль');
  ok(s.expectedCash === 20000, 'В ящике только размен');
}

// ── ЛЕНТА X-ОТЧЁТА ─────────────────────────────────────────────────
console.log('\n═══ ЛЕНТА X-ОТЧЁТА ═══\n');
{
  const state = { storeName: 'Мини-маркет', registerName: 'Касса 1',
    employee: { name: 'Айгуль' }, cashInDrawer: 24040 };
  const s = shiftSummary({ receipts: чеки, moves: движения, shift: смена, state });
  const lines = reportLines('x', { summary: s, shift: смена, state, width: 48 });
  const текст = (l) => (typeof l === 'string' ? l : (l && l.text) || '');
  const всё = lines.map(текст);

  ok(всё.some((l) => l === 'X-ОТЧЁТ'), 'Заголовок X-ОТЧЁТ');
  ok(всё.some((l) => /Без гашения: смена продолжается/.test(l)),
     '★ «Без гашения» — иначе кассир решит, что смена закрыта, и вечером не закроет настоящую');
  ok(всё.some((l) => /ВСЕ СУММЫ В ТЕНГЕ/.test(l)),
     'Валюта названа один раз, внизу');
  ok(!всё.some((l) => l.includes('₸')),
     '★ Значка валюты в теле нет: он ломал раскладку на узкой ленте');
  ok(!всё.some((l) => /СХОДИТСЯ|НЕ ХВАТАЕТ/.test(l)),
     '★ В X-отчёте расхождения НЕТ: пересчёта ещё не было');

  // Все строки с двумя колонками ровно по ширине
  const двух = всё.filter((l) => /\s{2,}\S/.test(l));
  ok(двух.every((l) => l.length === 48),
     `★ Все ${двух.length} строк с суммами ровно по ширине`);
}

// ── ЛЕНТА Z-ОТЧЁТА ─────────────────────────────────────────────────
console.log('\n═══ ЛЕНТА Z-ОТЧЁТА ═══\n');
{
  const state = { storeName: 'Мини-маркет', employee: { name: 'Айгуль' },
    cashInDrawer: 24040 };
  const s = shiftSummary({ receipts: чеки, moves: движения, shift: смена, state });
  const текст = (l) => (typeof l === 'string' ? l : (l && l.text) || '');

  const сошлось = reportLines('z', { summary: s, shift: смена, state,
    factCash: s.expectedCash, width: 48 }).map(текст);
  ok(сошлось.some((l) => /СХОДИТСЯ/.test(l)), '★ Пересчитали точно — «СХОДИТСЯ»');
  ok(сошлось.some((l) => /Смена закрыта/.test(l)), 'И смена закрыта');

  const мало = reportLines('z', { summary: s, shift: смена, state,
    factCash: s.expectedCash - 500, width: 48 }).map(текст);
  ok(мало.some((l) => /НЕ ХВАТАЕТ\s+500/.test(l)),
     '★ Не хватает 500 — сказано словами, а не «-500»');

  const много = reportLines('z', { summary: s, shift: смена, state,
    factCash: s.expectedCash + 300, width: 48 }).map(текст);
  ok(много.some((l) => /ИЗЛИШЕК\s+300/.test(l)), 'Излишек 300');
}

// ── РАСХОЖДЕНИЕ УЧЁТА НА ЛЕНТЕ ─────────────────────────────────────
{
  const state = { storeName: 'М', cashInDrawer: 99999 };
  const s = shiftSummary({ receipts: чеки, moves: движения, shift: смена, state });
  const текст = (l) => (typeof l === 'string' ? l : (l && l.text) || '');
  const lines = reportLines('x', { summary: s, shift: смена, state, width: 48 }).map(текст);

  ok(lines.some((l) => /Расхождение учёта/.test(l)),
     '★ Расхождение учёта на ленте: владелец увидит, что запись потеряна');
  ok(lines.some((l) => /покажите владельцу/.test(l)), 'И кому показать');
}

// ── ЧИСЛА ──────────────────────────────────────────────────────────
{
  ok(num(1234567) === '1 234 567', 'Разряды разделены');
  ok(num(0) === '0', 'Ноль');
  ok(num(400.5) === '401', 'Дробное округлено: копеек в кассе нет');
  ok(!num(1000).includes('₸'), 'И без значка валюты');
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
