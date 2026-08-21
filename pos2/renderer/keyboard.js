/*
 * ЭКРАННАЯ КЛАВИАТУРА.
 *
 * Их довод взят целиком:
 *
 *   «На Windows-планшете системная клавиатура НЕ ВСПЛЫВАЕТ при касании
 *    поля: в режиме ноутбука её нет вовсе, а в планшетном она зависит
 *    от настройки, которую никто не включал. На кассовых терминалах
 *    физической клавиатуры часто нет совсем.»
 *
 * ГЛАВНАЯ ЛОВУШКА — ЛОВИМ mousedown, А НЕ click.
 *
 * Кассир касается кнопки — поле теряет курсор ДО того, как придёт
 * click. Знак уходит в никуда, а кассир жмёт снова и снова, думая,
 * что клавиатура сломана.
 *
 * И событие не должно всплывать выше: иначе касание клавиши закроет
 * окно, в котором эта клавиатура и живёт.
 */

/* Раскладки. Казахские буквы отдельным рядом: в товарах они есть
   («Айран», «Құрт»), а на русской клавиатуре их нет.
 *
 * ИМЕНА С ПОМЕТКОЙ KB_. Все файлы кассы грузятся на ОДНУ страницу, и
 * простое RU уже занято словарём языков. Второе объявление ломает весь
 * файл — клавиатуры на кассе просто не будет. Найдено запуском. */
const KB_RU = [
  ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х'],
  ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
  ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю', 'ъ', 'ё'],
];

const KB_KZ = [['ә', 'ғ', 'қ', 'ң', 'ө', 'ұ', 'ү', 'һ', 'і']];

const KB_EN = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

const KB_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/**
 * СОБРАТЬ КЛАВИАТУРУ.
 *
 * Строится ЦЕЛИКОМ при каждом показе — правило из этапа 1.
 *
 * @param mode 'text' — буквы и цифры, 'number' — только цифры
 */
function buildKeyboard(root, { mode = 'text', onKey, onClose } = {}) {
  const ряды = mode === 'number'
    ? [KB_DIGITS]
    : [KB_DIGITS, ...KB_RU, ...KB_KZ, ...KB_EN];

  root.innerHTML = '';
  root.className = 'kbd';

  for (const ряд of ряды) {
    const div = document.createElement('div');
    div.className = 'kbd-row';
    for (const k of ряд) div.appendChild(makeKey(k, k, onKey));
    root.appendChild(div);
  }

  // Служебный ряд: пробел, стереть, закрыть.
  const служебный = document.createElement('div');
  служебный.className = 'kbd-row kbd-aux';
  if (mode !== 'number') служебный.appendChild(makeKey('␣', ' ', onKey, 'kbd-space'));
  служебный.appendChild(makeKey('⌫', '\b', onKey));
  const close = makeKey('Скрыть', null, null, 'kbd-close');
  close.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (onClose) onClose();
  });
  служебный.appendChild(close);
  root.appendChild(служебный);

  return root;
}

/** Одна клавиша. Вся ловушка — здесь. */
function makeKey(label, value, onKey, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'kbd-key' + (cls ? ' ' + cls : '');
  b.textContent = label;

  if (value !== null && onKey) {
    /* ЛОВИМ mousedown, А НЕ click.
     *
     * При касании поле теряет курсор ДО click — знак уходит в никуда,
     * а кассир жмёт снова, думая, что клавиатура сломана.
     *
     * preventDefault не даёт полю потерять курсор.
     * stopPropagation не даёт касанию закрыть окно, в котором
     * клавиатура и живёт. */
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onKey(value);
    });
  }
  return b;
}

/**
 * ПРИМЕНИТЬ ЗНАК К ПОЛЮ.
 *
 * Само поле не знает про клавиатуру: она пишет в него так же, как
 * писал бы человек, и шлёт событие ввода — иначе экран не заметит
 * изменения.
 */
function applyKey(input, value) {
  if (!input) return;

  if (value === '\b') input.value = input.value.slice(0, -1);
  else input.value += value;

  /* СОБЫТИЕ ВВОДА ШЛЁМ САМИ. Без него поиск не найдёт товар: он
     слушает ввод, а не значение поля. */
  input.dispatchEvent(new (input.ownerDocument.defaultView.Event)('input', { bubbles: true }));
}

if (typeof module !== 'undefined') {
  module.exports = { KB_RU, KB_KZ, KB_EN, KB_DIGITS, DIGITS: KB_DIGITS,
    buildKeyboard, makeKey, applyKey };
}
