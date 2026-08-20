/*
 * ЭКРАННАЯ КЛАВИАТУРА КАССЫ.
 *
 * Взята у донора вместе с их доводом:
 *
 *   «На Windows-планшете системная клавиатура не всплывает при касании
 *    поля: в режиме ноутбука её нет вовсе, а в планшетном она зависит
 *    от настройки, которую никто не включал. На кассовых терминалах
 *    физической клавиатуры часто нет совсем.»
 *
 * У меня была только цифровая — для сумм и количества. Буквенной не
 * было, а кассир ищет товар по названию: «хлеб», «молоко». Без неё
 * поиск не работал вовсе, и товар без штрихкода пробить было нечем.
 *
 * РАСКЛАДКА ПОД ТО, ЧТО ЗДЕСЬ НАБИРАЮТ: русские названия товаров,
 * казахские буквы и цифры. Английская — для редких ввозных названий.
 */
const KB_RU = [
  ['й','ц','у','к','е','н','г','ш','щ','з','х'],
  ['ф','ы','в','а','п','р','о','л','д','ж','э'],
  ['я','ч','с','м','и','т','ь','б','ю'],
];
/* Казахские буквы отдельным рядом, а не вместо русских: кассир ищет и
   «сүт», и «молоко» — товары называются по-разному. */
const KB_KK = ['ә','ғ','қ','ң','ө','ұ','ү','һ','і'];
const KB_EN = [
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['z','x','c','v','b','n','m'],
];
const KB_DIGITS = ['1','2','3','4','5','6','7','8','9','0'];

let kbLayout = 'ru';
let kbTarget = null;

/** Показать клавиатуру под полем. */
function kbOpen(input) {
  kbTarget = input;
  const box = document.getElementById('kbd');
  if (!box || !input) return;
  box.classList.remove('hidden');
  kbDraw();
  input.focus();
}

function kbClose() {
  const box = document.getElementById('kbd');
  if (box) box.classList.add('hidden');
  kbTarget = null;
}

/* Вписать знак в поле и сказать об этом полю.
 *
 * Событие 'input' обязательно: без него поиск не узнает, что текст
 * изменился, и список товаров не перерисуется. Кассир будет жать
 * буквы и видеть пустой экран. */
function kbType(ch) {
  if (!kbTarget) return;
  const t = kbTarget;
  const start = t.selectionStart ?? t.value.length;
  const end = t.selectionEnd ?? t.value.length;
  t.value = t.value.slice(0, start) + ch + t.value.slice(end);
  const pos = start + ch.length;
  try { t.setSelectionRange(pos, pos); } catch { /* поле без выделения */ }
  t.dispatchEvent(new Event('input', { bubbles: true }));
  t.focus();
}

function kbBack() {
  if (!kbTarget) return;
  const t = kbTarget;
  const start = t.selectionStart ?? t.value.length;
  const end = t.selectionEnd ?? t.value.length;
  if (start === end && start > 0) {
    t.value = t.value.slice(0, start - 1) + t.value.slice(end);
    try { t.setSelectionRange(start - 1, start - 1); } catch { /* нет выделения */ }
  } else {
    t.value = t.value.slice(0, start) + t.value.slice(end);
    try { t.setSelectionRange(start, start); } catch { /* нет выделения */ }
  }
  t.dispatchEvent(new Event('input', { bubbles: true }));
  t.focus();
}

function kbClear() {
  if (!kbTarget) return;
  kbTarget.value = '';
  kbTarget.dispatchEvent(new Event('input', { bubbles: true }));
  kbTarget.focus();
}

function kbDraw() {
  const box = document.getElementById('kbd');
  if (!box) return;
  const rows = kbLayout === 'en' ? KB_EN : KB_RU;
  const parts = [];

  parts.push('<div class="kb-row">'
    + KB_DIGITS.map((d) => `<button class="kb-k" data-ch="${d}">${d}</button>`).join('')
    + '</div>');

  for (const r of rows) {
    parts.push('<div class="kb-row">'
      + r.map((c) => `<button class="kb-k" data-ch="${c}">${c}</button>`).join('')
      + '</div>');
  }

  // Казахский ряд — только к русской раскладке: в английской он ни к чему.
  if (kbLayout === 'ru') {
    parts.push('<div class="kb-row">'
      + KB_KK.map((c) => `<button class="kb-k kb-kk" data-ch="${c}">${c}</button>`).join('')
      + '</div>');
  }

  parts.push('<div class="kb-row">'
    + `<button class="kb-k kb-wide" data-act="lang">${kbLayout === 'ru' ? 'ENG' : 'РУС'}</button>`
    + '<button class="kb-k kb-space" data-ch=" ">пробел</button>'
    + '<button class="kb-k kb-wide" data-act="back">←</button>'
    + '<button class="kb-k kb-wide" data-act="clear">Стереть</button>'
    + '<button class="kb-k kb-wide kb-done" data-act="close">Готово</button>'
    + '</div>');

  box.innerHTML = parts.join('');
}

/* Нажатие ловим на ВСЮ клавиатуру, а не на каждую кнопку.
 *
 * И через mousedown, а не click: click сперва уводит палец с поля,
 * поле теряет выделение, и знак вписывается не туда. Донор поймал то
 * же самое — у них клик «пузырился до фона» и закрывал окно. */
document.addEventListener('mousedown', (e) => {
  const box = document.getElementById('kbd');
  if (!box || box.classList.contains('hidden')) return;
  const k = e.target.closest && e.target.closest('.kb-k');
  if (!k || !box.contains(k)) return;

  // Не даём полю потерять выделение: иначе знак уйдёт мимо.
  e.preventDefault();
  e.stopPropagation();

  if (k.dataset.ch !== undefined) { kbType(k.dataset.ch); return; }
  const act = k.dataset.act;
  if (act === 'back') kbBack();
  else if (act === 'clear') kbClear();
  else if (act === 'close') kbClose();
  else if (act === 'lang') { kbLayout = kbLayout === 'ru' ? 'en' : 'ru'; kbDraw(); }
});
