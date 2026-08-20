/*
 * ЛЕНТА ЧЕКА.
 *
 * ИХ УРОК ПРО ВАЛЮТУ ВЗЯТ ЦЕЛИКОМ:
 *
 *   «Деньги в теле чека — чистые числа: валюта названа один раз,
 *    строкой под итогом, как принято на хороших чеках. Значок ₸ в
 *    каждой строке только съедал ширину и, БУДУЧИ ШИРЕ ОДНОГО БАЙТА В
 *    КОДИРОВКЕ ПРИНТЕРА, ЛОМАЛ РАСКЛАДКУ.»
 *
 * Это не мелочь: на ленте 32 знака, и один сдвинутый знак превращает
 * ровный столбик сумм в лесенку. Покупатель такой чек не читает.
 *
 * ШИРИНА ЛЕНТЫ. 80 мм даёт 48 знаков (XP-80C и почти все стационарные),
 * 58 мм — 32 знака (переносные). Берём из настроек, по умолчанию 48.
 */

/** Ровно по ширине: слева и справа. */
function padLR(left, right, width) {
  const l = String(left);
  const r = String(right);

  /* ПРАВАЯ ЧАСТЬ ТЕРЯЛАСЬ. Найдено просмотром ленты ГЛАЗАМИ: я собрал
     пробелы, а сам текст справа приклеить забыл.

     На ленте это значило чек БЕЗ ЕДИНОЙ СУММЫ: ни цен, ни итога, ни
     сдачи — покупатель получил бы список товаров и всё.

     Проверки этого не поймали: они смотрели, что строка не длиннее
     ленты, а короткая их устраивала. */
  const gap = width - l.length - r.length;
  if (gap >= 1) return l + ' '.repeat(gap) + r;

  /* Не влезло. Режем ЛЕВОЕ — название товара, а не сумму: сумма
     важнее, её кассир и покупатель сверяют. */
  const место = Math.max(0, width - r.length - 1);
  return l.slice(0, место) + ' '.repeat(Math.max(1, место - l.slice(0, место).length + 1)) + r;
}

/** По середине. */
function center(s, width) {
  const t = String(s).slice(0, width);
  const left = Math.max(0, Math.floor((width - t.length) / 2));
  // Дополняем и справа: лента — ровный столбец одной ширины. Иначе
  // проверка «не длиннее ленты» пропускает обрубки, как и вышло с
  // суммами.
  return (' '.repeat(left) + t).padEnd(width, ' ');
}

/** Число без значка валюты — их правило. */
function num(v) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(Number(v) || 0));
}

/** Длинное имя товара переносим, а не режем: покупатель должен понять,
    за что заплатил. */
function wrap(s, width) {
  const words = String(s).split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    if (!line.length) line = w;
    else if ((line + ' ' + w).length <= width) line += ' ' + w;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out;
}

/**
 * СОБРАТЬ ЛЕНТУ ЧЕКА.
 *
 * Порядок такой же, как на чеках, к которым люди привыкли: магазин,
 * номер, время, товары, итог, оплата, сдача.
 */
function receiptLines(r, width = 48) {
  const hr = '─'.repeat(width);
  const heavy = '═'.repeat(width);     // тяжёлая линия только перед итогом
  const out = [];

  // ── Шапка ───────────────────────────────────────────────────────
  out.push(center(r.store || '', width));
  if (r.register) out.push(center(r.register, width));
  out.push('');

  const at = new Date(r.at || Date.now());
  out.push(padLR(`Чек №${r.number}`,
    at.toLocaleDateString('ru-RU') + ' '
    + at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), width));
  if (r.cashier) out.push(padLR('Кассир', r.cashier, width));
  out.push(hr);

  // ── Товары ──────────────────────────────────────────────────────
  for (const it of r.items || []) {
    for (const line of wrap(it.name, width)) out.push(line);

    /* Количество и цена ОТДЕЛЬНОЙ строкой под названием: так покупатель
       видит, по какой цене считали. Спор «а почему так дорого» гасится
       этой строкой. */
    const кол = it.qty % 1 ? String(it.qty).replace('.', ',') : String(it.qty);
    const сумма = Math.round(it.price * it.qty) - (it.discount || 0);
    out.push(padLR(`  ${кол} × ${num(it.price)}`, num(сумма), width));

    if (it.discount) out.push(padLR('  скидка', '-' + num(it.discount), width));

    /* МАРКИ НЕ ПЕЧАТАЕМ. Код Data Matrix — это 30-40 знаков мусора на
       ленте, покупателю он не нужен, а ленты уходит вдвое больше.
       В налоговую марки едут в самом чеке, а не на бумаге. */
  }

  // ── Итог ────────────────────────────────────────────────────────
  out.push(heavy);
  if (r.discount) {
    out.push(padLR('Скидка на чек', '-' + num(r.discount), width));
  }
  out.push(padLR('ИТОГО', num(r.total), width));
  // Валюта названа ОДИН раз, как принято на хороших чеках.
  out.push(center('ТЕНГЕ', width));
  out.push('');

  // ── Оплата ──────────────────────────────────────────────────────
  if (r.card) out.push(padLR('Картой', num(r.card), width));
  if (r.cash) out.push(padLR('Наличными', num(r.cash), width));
  if (r.change) out.push(padLR('Сдача', num(r.change), width));

  // ── Подвал ──────────────────────────────────────────────────────
  out.push('');
  out.push(center('Спасибо за покупку!', width));
  if (r.offline) {
    /* Чек пробит без связи. Покупатель должен знать: в налоговую он
       уйдёт позже. Иначе при проверке чека в приложении его там не
       окажется, и человек решит, что его обманули. */
    out.push(center('Чек уйдёт в налоговую при связи', width));
  }
  out.push('');
  out.push('');

  return out;
}

/** Ширина ленты из настроек. 80 мм — самый частый случай. */
function paperWidth(settings) {
  const w = Number(settings && settings.printWidth);
  return w === 32 ? 32 : 48;
}

if (typeof module !== 'undefined') {
  module.exports = { receiptLines, paperWidth, padLR, center, num, wrap };
}
