/*
 * СКАНЕР ШТРИХКОДОВ.
 *
 * Сканер — это клавиатура. Он «печатает» цифры кода и жмёт ввод, всё
 * за долю секунды. Касса не отличает его от человека, и в этом вся
 * сложность.
 *
 * У донора сканера для товаров нет вовсе: в ресторане не сканируют.
 * Взят только их урок про поле: «курсор в поле сразу — сканер начнёт
 * печатать в ту же секунду, и кассиру не придётся сначала целиться в
 * поле пальцем».
 *
 * ТРИ БЕДЫ, КОТОРЫЕ НАДО ОБОЙТИ:
 *
 *   1. Кассир НАБИРАЕТ РУКАМИ в том же поле. Если считать всякий ввод
 *      сканером, поиск «хлеб» превратится в поиск штрихкода «хлеб».
 *
 *   2. Сканер печатает БЫСТРО. Человек — от 80 мс между знаками,
 *      сканер — 5–20 мс. По скорости их и различаем.
 *
 *   3. Код может прийти, когда открыто окно или экран не тот. Тогда
 *      цифры сыплются в чужое поле, и кассир не понимает, что набрал.
 */

/** Быстрее этого человек не печатает. */
const FAST_MS = 40;

/** Короче этого штрихкодов не бывает: это опечатка или мусор. */
const MIN_LEN = 6;

/**
 * ШТРИХКОД ВЕСОВ.
 *
 * Весы печатают наклейку: 22 + код товара + вес в граммах + проверка.
 * Кассир НИЧЕГО НЕ НАБИРАЕТ — вес приходит в самом коде.
 *
 * У донора вес спрашивают кнопкой «С весов» через отдельного
 * посредника. Это лишнее звено: посредник не встал — вес не пришёл.
 *
 * Разбираем два вида: 13 знаков (обычный) и 12 (короткий).
 */
function weighedBarcode(code, goods) {
  const c = String(code || '').trim();
  if (!/^2[12]\d{10,11}$/.test(c)) return null;

  const plu = String(Number(c.slice(2, 7)));
  const grams = Number(c.slice(7, 12));
  if (!grams) return null;                    // ноль граммов — не товар

  const good = (goods || []).find((g) => String(g.plu ?? '') === plu);
  if (!good) return { unknownPlu: plu, qty: grams / 1000 };

  return { good, qty: grams / 1000, weighed: true };
}

/**
 * РАЗОБРАТЬ ПРИШЕДШИЙ КОД.
 *
 * Сперва весовой — он самый частый в продуктовом. Потом обычный.
 */
function resolveCode(code, goods, findByBarcode) {
  const c = String(code || '').trim();
  if (c.length < MIN_LEN) return { tooShort: true };

  const вес = weighedBarcode(c, goods);
  if (вес) return вес;

  const good = findByBarcode(goods, c);
  if (good) return { good, qty: 1 };

  return { unknown: true, code: c };
}

/**
 * СЛУШАТЬ СКАНЕР.
 *
 * Ловим ввод на всём окне, а не в поле: код должен сработать, даже
 * если кассир увёл курсор куда-то ещё. Иначе он сканирует, ничего не
 * происходит, и он сканирует снова и снова.
 *
 * @param onCode  что делать с распознанным кодом
 * @param busy    когда нельзя (открыто окно, идёт оплата)
 * @returns снять слушателя
 */
function listenScanner(doc, { onCode, busy }) {
  let buf = '';
  let last = 0;

  const onKey = (e) => {
    const now = Date.now();
    const пауза = now - last;
    last = now;

    if (e.key === 'Enter') {
      const код = buf;
      buf = '';
      // Слишком коротко — это человек нажал ввод, а не сканер.
      if (код.length < MIN_LEN) return;
      if (busy && busy()) return;
      e.preventDefault();
      onCode(код);
      return;
    }

    if (e.key.length !== 1 || !/[0-9]/.test(e.key)) {
      // Буква или служебная клавиша: человек печатает — сбрасываем.
      buf = '';
      return;
    }

    /* ПАУЗА БОЛЬШЕ 40 мс — ЭТО ЧЕЛОВЕК. Начинаем набор заново: иначе
       цифры, набранные руками минуту назад, склеятся с кодом сканера
       и дадут чужой товар. */
    if (пауза > FAST_MS) buf = '';

    buf += e.key;
  };

  doc.addEventListener('keydown', onKey, true);
  return () => doc.removeEventListener('keydown', onKey, true);
}

if (typeof module !== 'undefined') {
  module.exports = { FAST_MS, MIN_LEN, weighedBarcode, resolveCode, listenScanner };
}
