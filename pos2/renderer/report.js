/*
 * ОТЧЁТЫ СМЕНЫ: X и Z.
 *
 * X-ОТЧЁТ — «сколько сейчас». Печатается посреди смены, ничего не
 * закрывает. Кассир сверяет ящик в обед, старший смотрит выручку.
 *
 * Z-ОТЧЁТ — «смена закрыта». Печатается один раз, при закрытии, и
 * показывает расхождение между расчётом и пересчётом.
 *
 * ГЛАВНОЕ ИХ ПРАВИЛО: «Данные приходят готовым агрегатом — здесь
 * только раскладка, ни одного вычисления по заказам».
 *
 * У меня наоборот: СЧИТАЕМ НА КАССЕ, из своих же чеков. Их отчёт
 * приходит с сервера, и без связи его нет. А смену закрывают вечером,
 * когда интернет как раз и падает.
 */

/* Общие мелочи: счёт по-русски и разряды. Лежат отдельно, потому что
   нужны всем, а одно имя в двух файлах ломает второй целиком. */
if (typeof module !== 'undefined' && typeof num === 'undefined') {
  // eslint-disable-next-line global-require
  var { num } = require('./common.js');
}

/**
 * СВЕСТИ СМЕНУ ИЗ ЧЕКОВ.
 *
 * Всё считается здесь, из того, что лежит на кассе. Сервер потом
 * пересчитает по-своему, и числа должны сойтись — иначе владелец
 * увидит две правды.
 */
function reportSummary({ receipts, moves, shift, state }) {
  const свои = (receipts || []).filter((r) => !shift || r.shiftId === shift.id);

  const продажи = свои.filter((r) => r.kind !== 'refund');
  const возвраты = свои.filter((r) => r.kind === 'refund');

  /* Скидки считаем ОТДЕЛЬНО: владелец должен видеть, сколько роздано.
     Это первое, что он спрашивает, когда выручка ниже обычного. */
  const скидки = продажи.reduce((a, r) => a
    + (r.discount || 0)
    + (r.items || []).reduce((b, i) => b + (i.discount || 0), 0), 0);

  const выручка = продажи.reduce((a, r) => a + (r.total || 0), 0);
  const возвращено = возвраты.reduce((a, r) => a + (r.total || 0), 0);

  const позиций = продажи.reduce((a, r) => a + (r.items || []).length, 0);

  /* ПО СПОСОБАМ ОПЛАТЫ. Владелец сверяет карту с выпиской банка, а
     наличные — с ящиком. Без разбивки сверить нечего. */
  const оплаты = {};
  for (const r of продажи) {
    const w = r.way || 'cash';
    оплаты[w] = (оплаты[w] || 0) + (r.total || 0);
  }

  // Наличная часть: сколько денег вправду прошло через ящик.
  const наличными = продажи.reduce((a, r) => a + (r.cashDelta || 0), 0);
  const возвратНаличными = возвраты.reduce((a, r) => a + Math.abs(r.cashDelta || 0), 0);

  const свои_движения = (moves || []).filter((m) => !shift || m.shiftId === shift.id);
  const внесено = свои_движения.filter((m) => m.delta > 0)
    .reduce((a, m) => a + m.delta, 0);
  const изъято = свои_движения.filter((m) => m.delta < 0)
    .reduce((a, m) => a + Math.abs(m.delta), 0);

  const размен = (shift && shift.openingCash) || 0;

  /* ДОЛЖНО БЫТЬ В ЯЩИКЕ — считаем ДВУМЯ путями и сверяем.
   *
   * Первый: размен + наличная выручка + внесения − изъятия − возвраты.
   * Второй: то, что касса вела с каждой оплаты.
   *
   * Если пути разошлись — где-то потеряна запись, и это надо увидеть
   * СЕЙЧАС, а не когда владелец придёт с вопросом. */
  const расчёт = размен + наличными + внесено - изъято - возвратНаличными;
  const ведёт = Number(state && state.cashInDrawer) || 0;

  return {
    checks: продажи.length,
    refunds: возвраты.length,
    items: позиций,
    avgCheck: продажи.length ? Math.round(выручка / продажи.length) : 0,

    gross: выручка + скидки,      // до скидок
    discounts: скидки,
    revenue: выручка,
    returned: возвращено,
    net: выручка - возвращено,

    payments: оплаты,

    openingCash: размен,
    cashSales: наличными,
    cashIn: внесено,
    cashOut: изъято,
    cashRefunds: возвратНаличными,
    expectedCash: расчёт,

    // Расхождение двух путей: должно быть ноль.
    drift: ведёт - расчёт,
  };
}

/** Названия способов оплаты для отчёта. */
const WAY_NAMES = {
  cash: 'Наличными', card: 'Картой', qr: 'QR с телефона',
  mixed: 'Смешанно', credit: 'В долг',
};

/**
 * ЛЕНТА ОТЧЁТА.
 *
 * По их канону: числа чистые, валюта одной строкой, тяжёлая линия
 * перед итогом.
 */
function reportLines(kind, { summary: s, shift, state, factCash, at = new Date(), width = 48 }) {
  const line = (l, r) => ({ text: pad(l, r, width) });
  const hr = { text: '─'.repeat(width) };
  const heavy = { text: '═'.repeat(width) };
  const mid = (t) => ({ text: t, type: 'center' });

  const out = [];

  // ── Шапка ───────────────────────────────────────────────────────
  out.push({ text: state.storeName || '', type: 'center', bold: true });
  if (state.registerName) out.push(mid(state.registerName));
  out.push({ text: kind === 'z' ? 'Z-ОТЧЁТ' : 'X-ОТЧЁТ', type: 'center', bold: true });
  out.push(hr);

  const открыта = shift && shift.openedAt ? new Date(shift.openedAt) : null;
  if (открыта) {
    out.push(line('Смена открыта', открыта.toLocaleString('ru-RU',
      { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })));
  }
  out.push(line(kind === 'z' ? 'Закрыта' : 'Отчёт',
    at.toLocaleString('ru-RU',
      { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })));
  if (state.employee) out.push(line('Кассир', state.employee.name || ''));
  out.push(hr);

  // ── Чеки ────────────────────────────────────────────────────────
  out.push(line('Чеков закрыто', String(s.checks)));
  out.push(line('Позиций продано', String(s.items)));
  if (s.refunds) out.push(line('Возвратов', String(s.refunds)));
  out.push(line('Средний чек', num(s.avgCheck)));
  out.push(hr);

  // ── Продажи ─────────────────────────────────────────────────────
  out.push({ text: 'ПРОДАЖИ' });
  out.push(line('Сумма по товарам', num(s.gross)));
  out.push(line('Скидки', s.discounts ? '-' + num(s.discounts) : '0'));
  if (s.returned) out.push(line('Возвраты', '-' + num(s.returned)));
  out.push(heavy);
  out.push(line('ВЫРУЧКА ИТОГО', num(s.net)));
  out.push(hr);

  // ── Оплаты ──────────────────────────────────────────────────────
  out.push({ text: 'ОПЛАТЫ' });
  for (const [w, sum] of Object.entries(s.payments)) {
    out.push(line(WAY_NAMES[w] || w, num(sum)));
  }
  out.push(hr);

  // ── Ящик ────────────────────────────────────────────────────────
  out.push({ text: 'НАЛИЧНЫЕ В ЯЩИКЕ' });
  out.push(line('Размен на открытии', num(s.openingCash)));
  out.push(line('+ Наличная выручка', num(s.cashSales)));
  if (s.cashIn) out.push(line('+ Внесения', num(s.cashIn)));
  if (s.cashOut) out.push(line('- Изъятия', '-' + num(s.cashOut)));
  if (s.cashRefunds) out.push(line('- Возвраты наличными', '-' + num(s.cashRefunds)));
  out.push(line('= Должно быть', num(s.expectedCash)));

  /* Z-ОТЧЁТ ПОКАЗЫВАЕТ РАСХОЖДЕНИЕ. Это главное в нём: не «сколько
     наторговали», а «сошлось ли». */
  if (kind === 'z' && factCash != null) {
    const разница = Math.round(factCash) - s.expectedCash;
    out.push(line('Насчитано', num(factCash)));
    out.push(heavy);
    out.push(line(разница === 0 ? 'СХОДИТСЯ'
      : разница > 0 ? 'ИЗЛИШЕК' : 'НЕ ХВАТАЕТ',
      разница === 0 ? '0' : num(Math.abs(разница))));
  }

  out.push(hr);
  out.push(mid('ВСЕ СУММЫ В ТЕНГЕ'));

  /* «БЕЗ ГАШЕНИЯ» — их строка, и она важная. Кассир не должен думать,
     что X-отчёт закрыл смену: он напечатает его в обед, решит, что
     смена закрыта, и вечером не закроет настоящую. */
  out.push(mid(kind === 'z' ? 'Смена закрыта' : 'Без гашения: смена продолжается'));

  /* РАСХОЖДЕНИЕ ДВУХ ПУТЁЙ. Печатаем только если оно есть: в обычном
     отчёте лишняя строка только пугает. */
  if (s.drift) {
    out.push(hr);
    out.push({ text: `Расхождение учёта: ${num(s.drift)} — покажите владельцу` });
  }

  out.push({ text: '' });
  out.push({ text: '' });
  return out;
}

/** Ровно по ширине, слева и справа. */
function pad(left, right, width) {
  const l = String(left);
  const r = String(right);
  const gap = width - l.length - r.length;
  if (gap >= 1) return l + ' '.repeat(gap) + r;
  const место = Math.max(0, width - r.length - 1);
  return l.slice(0, место).padEnd(место) + ' ' + r;
}


if (typeof module !== 'undefined') {
  module.exports = { reportSummary, reportLines, WAY_NAMES };
}
