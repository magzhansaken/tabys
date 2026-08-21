/*
 * ЭКРАННАЯ КЛАВИАТУРА.
 *
 * Их довод взят целиком: на Windows-планшете системная клавиатура НЕ
 * ВСПЛЫВАЕТ при касании поля, а на кассовых терминалах физической
 * клавиатуры часто нет совсем. Поэтому своя.
 *
 * ГЛАВНАЯ ЛОВУШКА — ЛОВИМ mousedown, А НЕ click.
 *
 * Кассир касается кнопки — поле теряет курсор ДО того, как придёт
 * click. Знак уходит в никуда, а кассир жмёт снова и снова, думая,
 * что клавиатура сломана. preventDefault не даёт полю потерять курсор,
 * stopPropagation не даёт касанию закрыть окно, в котором клавиатура
 * живёт. ЭТО НЕЛЬЗЯ ЛОМАТЬ, переставляя кнопки.
 *
 * ЧТО ИЗМЕНИЛОСЬ В ОБЛИКЕ v3 (работа ловушки не тронута):
 *   раскладки не свалены в одну простыню из восьми рядов — русская с
 *     казахским рядом сразу (товары «Айран», «Құрт» ищут вперемешку),
 *     латиница за клавишей ABC: она нужна редко, а место ест всегда;
 *   в цифровом ряду появился дефис — код привязки TBS-4FE2-3137 иначе
 *     не ввести с планшета вовсе;
 *   цифровой вид стал сеткой 3×4 под палец, с клавишей «00» — размены
 *     и суммы в тенге круглые, 20 000 набирается тремя касаниями;
 *   клавиатура умеет вставать В ЭКРАН (inline), а не только поверх;
 *   поля в окнах кассы (скидка, внесение, изъятие) сами показывают
 *     клавиатуру — раньше на планшете в них нельзя было напечатать
 *     ничего вовсе.
 */

/* Раскладки. Казахские буквы отдельным рядом: в товарах они есть, а на
   русской клавиатуре их нет.
   ИМЕНА С ПОМЕТКОЙ KB_: простое RU уже занято словарём языков, второе
   объявление сломало бы весь файл. Найдено запуском. */
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
 * СОБРАТЬ КЛАВИАТУРУ. Строится ЦЕЛИКОМ при каждом показе — правило
 * этапа 1: ни один показ не полагается на прежнюю сборку.
 *
 * @param mode   'text' — буквы и цифры, 'number' — сетка цифр 3×4
 * @param inline true — врезать в экран, а не крепить к низу
 */
function buildKeyboard(root, { mode = 'text', onKey, onClose, inline = false } = {}) {
  root.className = 'kbd' + (inline ? ' kbd-inline' : '');

  /* Латиница спрятана за клавишей: нужна для редких названий, а место
     ест всегда. Переключение перерисовывает клавиатуру целиком. */
  let lang = 'ru';

  const draw = () => {
    root.innerHTML = '';

    if (mode === 'number') {
      const grid = document.createElement('div');
      grid.className = 'kbd-grid';
      for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '\b'])
        grid.appendChild(makeKey(k === '\b' ? '⌫' : k, k, onKey));
      root.appendChild(grid);
      if (onClose) root.appendChild(auxRow());
      return;
    }

    const ряды = lang === 'en'
      ? [[...KB_DIGITS, '-'], ...KB_EN]
      : [[...KB_DIGITS, '-'], ...KB_RU, ...KB_KZ];

    for (const ряд of ряды) {
      const div = document.createElement('div');
      div.className = 'kbd-row';
      for (const k of ряд) div.appendChild(makeKey(k, k, onKey));
      root.appendChild(div);
    }
    root.appendChild(auxRow());
  };

  /* Служебный ряд: раскладка, пробел, стереть, скрыть. */
  function auxRow() {
    const div = document.createElement('div');
    div.className = 'kbd-row kbd-aux';

    if (mode !== 'number') {
      /* Переключатель раскладки — ТОТ ЖЕ mousedown с preventDefault:
         иначе само переключение уронит курсор из поля. */
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'kbd-key kbd-lang';
      sw.textContent = lang === 'en' ? 'АБВ' : 'ABC';
      sw.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        lang = lang === 'en' ? 'ru' : 'en';
        draw();
      });
      div.appendChild(sw);
      div.appendChild(makeKey('пробел', ' ', onKey, 'kbd-space'));
    }

    div.appendChild(makeKey('⌫', '\b', onKey));

    if (onClose) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'kbd-key kbd-close';
      close.textContent = 'Скрыть';
      close.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        onClose();
      });
      div.appendChild(close);
    }
    return div;
  }

  draw();
  return root;
}

/** Одна клавиша. Вся ловушка — здесь. НЕ МЕНЯТЬ mousedown на click. */
function makeKey(label, value, onKey, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'kbd-key' + (cls ? ' ' + cls : '');
  b.textContent = label;

  if (value !== null && onKey) {
    /* preventDefault — поле не теряет курсор до прихода знака.
       stopPropagation — касание не закрывает окно, где живёт поле. */
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onKey(value);
    });
  }
  return b;
}

/**
 * ПРИМЕНИТЬ ЗНАК К ПОЛЮ. Пишет как человек и шлёт событие ввода —
 * иначе поиск не заметит изменения.
 */
function applyKey(input, value) {
  if (!input) return;

  if (value === '\b') input.value = input.value.slice(0, -1);
  else input.value += value;

  input.dispatchEvent(new (input.ownerDocument.defaultView.Event)('input', { bubbles: true }));
}

/*
 * КЛАВИАТУРА САМА ПРИХОДИТ К ПОЛЯМ В ОКНАХ.
 *
 * Беда, которую это закрывает: окна «Скидка», «Внести», «Изъять»,
 * «Насчитал в ящике» ждут ввода суммы, а на планшете печатать НЕЧЕМ —
 * системной клавиатуры нет, своя не звалась. Кассир упирался в поле.
 *
 * Правило: поле в окне (.backdrop) получило курсор — снизу встаёт
 * клавиатура: цифровая для сумм, буквенная для остального. Курсор
 * ушёл из полей — клавиатура прячется. Экран продажи это не трогает:
 * у поиска свой переключатель, сканеру всплывающая клавиатура мешала бы.
 */
function wireKeyboardAssist(doc) {
  const kbd = () => doc.getElementById('kbd');

  const hide = () => {
    const k = kbd();
    if (!k) return;
    k.classList.add('hidden');
    k.innerHTML = '';
  };

  doc.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'INPUT' || el.readOnly || el.disabled) return;
    if (!el.closest || !el.closest('.backdrop')) return;   // только окна
    const k = kbd();
    if (!k) return;

    const mode = el.getAttribute('inputmode') === 'numeric' ? 'number' : 'text';
    buildKeyboard(k, { mode, onKey: (v) => applyKey(el, v), onClose: hide });
    k.classList.remove('hidden');
  });

  doc.addEventListener('focusout', () => {
    /* Ждём чуть-чуть: курсор мог перейти в соседнее поле того же окна.
       Касание самой клавиатуры сюда не попадает — mousedown погашен. */
    setTimeout(() => {
      const a = doc.activeElement;
      if (a && a.tagName === 'INPUT' && a.closest && a.closest('.backdrop')) return;
      hide();
    }, 120);
  });
}

/* На кассе — включаем; в проверках (jsdom с require) — нет. */
if (typeof module === 'undefined' && typeof document !== 'undefined') {
  wireKeyboardAssist(document);
}

if (typeof module !== 'undefined') {
  module.exports = { KB_RU, KB_KZ, KB_EN, KB_DIGITS, DIGITS: KB_DIGITS,
    buildKeyboard, makeKey, applyKey, wireKeyboardAssist };
}
