/*
 * ЛЕНТА ЧЕКА — что печатается на бумаге.
 *
 * ЧЕК ОСТАЁТСЯ НА РУССКОМ, даже если касса переключена на казахский.
 * Его читают не только покупатель, но и проверяющий, и бухгалтер, и
 * налоговая — а у них язык один.
 *
 * ШИРИНА ЛЕНТЫ. На 80 мм 48 знаков, на 58 мм — 32. Строки собираются
 * по ширине, а не «как вышло»: иначе цена переедет на вторую строку и
 * чек станет вдвое длиннее.
 */

/** Деньги на ленте: разряды пробелом, знак словом. */
function money(n) {
  const v = Math.round(Number(n) || 0);
  /* ЗНАЧОК ВАЛЮТЫ НЕ ПЕЧАТАЕМ — правило донора: «в каждой строке он
     только съедал ширину и, БУДУЧИ ШИРЕ ОДНОГО БАЙТА В КОДИРОВКЕ
     ПРИНТЕРА, ЛОМАЛ РАСКЛАДКУ».
     На ленте 32 знака, и значок в каждой строке съедает больше
     десятка впустую. Валюта названа один раз, под итогом. */
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Количество: целое без хвоста, весовое — с граммами. */
function qtyText(l) {
  const q = Number(l.qty);
  if (q % 1 === 0) return `${q} ${l.unit || 'шт'}`;
  return `${q.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} ${l.unit || 'кг'}`;
}

/**
 * СОБРАТЬ ЛЕНТУ ЧЕКА.
 *
 * Порядок строк — по обычаю кассовых чеков: шапка, товары, итог,
 * оплата, подвал. Покупатель ищет сумму глазами в одном месте.
 */
function receiptLines(r, { width = 48 } = {}) {
  const pair = (l, right) => {
    const rt = String(right);
    const место = width - rt.length;
    const lt = String(l);
    return lt.length >= место
      ? lt.slice(0, Math.max(0, место - 1)) + ' ' + rt
      : lt + ' '.repeat(место - lt.length) + rt;
  };
  const черта = '-'.repeat(width);
  const out = [];

  // ── ШАПКА ────────────────────────────────────────────────────────
  if (r.store) out.push({ text: r.store, type: 'center', bold: true });
  if (r.register) out.push({ text: r.register, type: 'center' });
  out.push(черта);

  const дата = new Date(r.at);
  out.push(pair(`Чек №${r.number}`,
    дата.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit' })));
  if (r.cashier) out.push(`Кассир: ${r.cashier}`);
  out.push(черта);

  // ── ТОВАРЫ ───────────────────────────────────────────────────────
  for (const l of r.items || []) {
    // Имя отдельной строкой: на узкой ленте оно не влезет рядом с
    // ценой, а обрезать название товара нельзя — покупатель не поймёт,
    // за что платит.
    out.push(l.name);

    const сумма = Math.round(l.price * l.qty) - (l.discount || 0);
    out.push(pair(`  ${qtyText(l)} x ${money(l.price)}`, money(сумма)));

    if (l.discount) out.push(pair('  скидка', `-${money(l.discount)}`));

    /* МАРКИ НА ЧЕКЕ — КОРОТКО.
     *
     * Два довода, и оба верны:
     *   печатать надо — покупатель вправе проверить подлинность
     *     товара, и на маркированный товар это его право;
     *   печатать целиком нельзя — код 25 знаков, пять пачек сигарет
     *     дают пятнадцать лишних строк, треть ленты.
     *
     * Берём хвост кода: по нему товар опознаётся при споре, а лента
     * цела. Полный код всё равно уходит в налоговую внутри чека. */
    for (const m of l.marks || []) {
      const хвост = String(m).slice(-8);
      out.push(`  марка …${хвост}`);
    }
  }

  out.push(черта);

  // ── ИТОГ ─────────────────────────────────────────────────────────
  if (r.discount) {
    const до = (r.items || []).reduce((a, l) =>
      a + Math.round(l.price * l.qty) - (l.discount || 0), 0);
    out.push(pair('Сумма', money(до)));
    out.push(pair('Скидка на чек', `-${money(r.discount)}`));
  }
  out.push({ text: pair('ИТОГО', money(r.total)), bold: true });

  // ── ОПЛАТА ───────────────────────────────────────────────────────
  out.push(черта);
  if (r.cash) out.push(pair('Наличными', money(r.cash)));
  if (r.card) out.push(pair('Картой', money(r.card)));
  if (r.change) out.push({ text: pair('Сдача', money(r.change)), bold: true });

  // ── ПОДВАЛ ───────────────────────────────────────────────────────
  out.push('');
  out.push({ text: 'Спасибо за покупку!', type: 'center' });
  if (r.returnNote) out.push({ text: r.returnNote, type: 'center' });

  return out;
}

/**
 * ЛЕНТА ВОЗВРАТА.
 *
 * Отличается словом и знаком: возврат нельзя спутать с продажей, иначе
 * при разборе решат, что деньги приняли, а их отдали.
 */
function refundLines(r, opts = {}) {
  const lines = receiptLines(r, opts);
  // Заголовок вместо «Чек №»: видно с первого взгляда.
  lines.splice(0, 0, { text: 'ВОЗВРАТ', type: 'center', bold: true, big: true });
  return lines;
}

if (typeof module !== 'undefined') {
  module.exports = { receiptLines, refundLines, money, qtyText };
}
