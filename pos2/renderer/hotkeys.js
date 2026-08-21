/*
 * ГОРЯЧИЕ КЛАВИШИ.
 *
 * Касса стоит и на ноутбуке, и на компьютере с обычной клавиатурой.
 * Там кассир быстрее нажмёт клавишу, чем прицелится мышью.
 *
 * ДВА ПРАВИЛА, ОБА ВАЖНЫЕ.
 *
 * 1. СКАНЕР ВАЖНЕЕ КЛАВИШ. Он шлёт цифры как клавиатура — и если
 *    перехватывать всё подряд, товар не пробьётся.
 *
 * 2. В ПОЛЕ ВВОДА КЛАВИШИ НЕ РАБОТАЮТ. Кассир печатает «Ф» в поиске —
 *    это буква, а не «открыть ящик». Иначе он не сможет искать товары
 *    с этими буквами вовсе.
 */

/** Что умеет касса с клавиатуры. */
const KEYS = [
  { key: 'F2',  name: 'Поиск товара',      act: 'search' },
  { key: 'F3',  name: 'Отложить чек',      act: 'park' },
  { key: 'F4',  name: 'Отложенные',        act: 'unpark' },
  { key: 'F6',  name: 'Скидка',            act: 'discount' },
  { key: 'F7',  name: 'Открыть ящик',      act: 'drawer' },
  { key: 'F8',  name: 'Оплата',            act: 'pay' },
  { key: 'F9',  name: 'X-отчёт',           act: 'xreport' },
  { key: 'F12', name: 'Меню кассы',        act: 'menu' },
  { key: 'Escape', name: 'Закрыть окно',   act: 'close' },
  { key: 'Delete', name: 'Убрать позицию', act: 'remove' },
];

/** Печатает ли кассир прямо сейчас. */
function typing(el) {
  if (!el) return false;
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable === true;
}

/**
 * ПОВЕСИТЬ КЛАВИШИ.
 *
 * @param scanner ловец сканера: ему знак отдаётся первым
 */
function wireHotkeys(doc, { onAction, scanner, isBusy } = {}) {
  const карта = new Map(KEYS.map((k) => [k.key, k.act]));

  const handler = (e) => {
    /* СКАНЕР ПЕРВЫЙ. Он шлёт цифры и Enter быстрее человека — если
       отдать их клавишам, товар не пробьётся. */
    if (scanner && scanner.key(e)) { e.preventDefault(); return; }

    // Касса занята окном оплаты или отправкой — не мешаем.
    if (isBusy && isBusy()) return;

    const act = карта.get(e.key);
    if (!act) return;

    /* В ПОЛЕ ВВОДА РАБОТАЮТ ТОЛЬКО F-КЛАВИШИ И ESCAPE.
       Delete в поиске — это стереть букву, а не убрать позицию. */
    if (typing(doc.activeElement) && !/^F\d/.test(e.key) && e.key !== 'Escape') return;

    e.preventDefault();
    if (onAction) onAction(act, e);
  };

  doc.addEventListener('keydown', handler);
  // Уборка обязательна: иначе клавиши останутся висеть.
  return () => doc.removeEventListener('keydown', handler);
}

/** Подсказка для кассира — список клавиш. */
function hotkeyHelp() {
  return KEYS.map((k) => ({ key: k.key, name: k.name }));
}

if (typeof module !== 'undefined') {
  module.exports = { KEYS, typing, wireHotkeys, hotkeyHelp };
}
