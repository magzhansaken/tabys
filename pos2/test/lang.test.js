/*
 * ПРОВЕРКА ЯЗЫКОВ, КЛАВИАТУРЫ И ГОРЯЧИХ КЛАВИШ.
 *
 * Главное: клавиатура ловит mousedown, чек остаётся русским, сканер
 * важнее клавиш.
 */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body><input id="f"><div id="kb"></div></body>');
global.document = dom.window.document; global.window = dom.window;

const { RU, KZ, t, missing } = require('../renderer/i18n.js');
const { buildKeyboard, applyKey, DIGITS } = require('../renderer/keyboard.js');
const { KEYS, typing, wireHotkeys, hotkeyHelp } = require('../renderer/hotkeys.js');
const { makeScanner } = require('../renderer/scan.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

const kb = document.getElementById('kb');
const поле = document.getElementById('f');
const key = (k, opts) => document.dispatchEvent(
  new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

console.log('═══ ЭТАП 23 · ЯЗЫКИ И КЛАВИАТУРА ═══\n');

// ── ДВА ЯЗЫКА ──────────────────────────────────────────────────────
{
  ok(Object.keys(RU).length === Object.keys(KZ).length,
     `★ Слова переведены полностью: ${Object.keys(RU).length} на обоих языках`);
  ok(missing('kz').length === 0, 'Ни одного пропуска');

  ok(t('pay', 'ru') === 'ОПЛАТА' && t('pay', 'kz') === 'ТӨЛЕМ',
     `★ «${t('pay', 'ru')}» → «${t('pay', 'kz')}»`);
  ok(t('change', 'kz') === 'Қайтарым', 'Сдача по-казахски');

  ok(t('неизвестное', 'kz') === 'неизвестное',
     'Незнакомый ключ не роняет');
  ok(t('pay', 'китайский') === 'ОПЛАТА',
     '★ Незнакомый язык — берём русский, а не пустоту');
}

// ── КАЗАХСКИЕ БУКВЫ ЕСТЬ ───────────────────────────────────────────
{
  const все = Object.values(KZ).join('');
  const буквы = ['ә', 'қ', 'ң', 'ө', 'ұ', 'ү', 'і', 'ғ'];
  const нет = буквы.filter((b) => !все.includes(b));
  ok(нет.length < буквы.length, '★ Казахские буквы вправду в переводе, а не подделка');
}

// ── КЛАВИАТУРА: mousedown, А НЕ click ──────────────────────────────
console.log('\n═══ ЭКРАННАЯ КЛАВИАТУРА ═══\n');
{
  let принято = null;
  buildKeyboard(kb, { onKey: (v) => { принято = v; } });

  const кнопка = [...kb.querySelectorAll('.kbd-key')].find((b) => b.textContent === 'а');

  // Так жмёт палец: сперва mousedown
  кнопка.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  ok(принято === 'а',
     '★ Знак пришёл на mousedown: поле теряет курсор ДО click, и знак ушёл бы в никуда');

  // А click уже ничего не добавляет
  принято = null;
  кнопка.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  ok(принято === null, 'И click не задваивает знак');
}

// ── СОБЫТИЕ НЕ ВСПЛЫВАЕТ ───────────────────────────────────────────
{
  let всплыло = false;
  document.body.addEventListener('mousedown', () => { всплыло = true; }, { once: true });

  buildKeyboard(kb, { onKey: () => {} });
  const b = kb.querySelector('.kbd-key');
  b.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));

  ok(!всплыло,
     '★ Касание НЕ всплывает выше: иначе оно закроет окно, в котором клавиатура и живёт');
}

// ── ПОЛЕ НЕ ТЕРЯЕТ КУРСОР ──────────────────────────────────────────
{
  buildKeyboard(kb, { onKey: () => {} });
  const b = kb.querySelector('.kbd-key');
  const e = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  b.dispatchEvent(e);
  ok(e.defaultPrevented,
     '★ preventDefault не даёт полю потерять курсор при касании');
}

// ── РАСКЛАДКИ ──────────────────────────────────────────────────────
{
  buildKeyboard(kb, { onKey: () => {} });
  const все = [...kb.querySelectorAll('.kbd-key')].map((b) => b.textContent);

  ok(все.includes('ж') && все.includes('ё'), 'Русские буквы на месте');
  ok(все.includes('ә') && все.includes('қ') && все.includes('ң'),
     '★ Казахские буквы есть: в товарах бывают «Айран», «Құрт»');
  ok(все.includes('q') && все.includes('z'),
     'И английские: названия вроде «Winston» набирают ими');
  ok(DIGITS.every((d) => все.includes(d)), 'Цифры тоже');
  ok(все.includes('⌫') && все.includes('␣'), 'Стереть и пробел');

  buildKeyboard(kb, { mode: 'number', onKey: () => {} });
  const цифровая = [...kb.querySelectorAll('.kbd-key')].map((b) => b.textContent);
  ok(!цифровая.includes('ж'),
     '★ Для сумм — только цифры: букв там не набирают');
}

// ── ЗНАК ПОПАДАЕТ В ПОЛЕ ───────────────────────────────────────────
{
  let событий = 0;
  поле.value = '';
  поле.addEventListener('input', () => { событий += 1; });

  applyKey(поле, 'х');
  applyKey(поле, 'л');
  applyKey(поле, 'е');
  ok(поле.value === 'хле', `Знаки в поле: «${поле.value}»`);
  ok(событий === 3,
     '★ Событие ввода шлём САМИ: без него поиск не найдёт товар');

  applyKey(поле, '\b');
  ok(поле.value === 'хл', 'Стереть убирает знак');
}

// ── ГОРЯЧИЕ КЛАВИШИ ────────────────────────────────────────────────
console.log('\n═══ ГОРЯЧИЕ КЛАВИШИ ═══\n');
{
  let было = null;
  const снять = wireHotkeys(document, { onAction: (a) => { было = a; } });

  key('F8');
  ok(было === 'pay', '★ F8 — оплата');
  key('F7');
  ok(было === 'drawer', 'F7 — ящик');
  key('F2');
  ok(было === 'search', 'F2 — поиск');

  снять();
  было = null;
  key('F8');
  ok(было === null, '★ Уборка сняла клавиши: иначе висели бы вечно');
}

// ── СКАНЕР ВАЖНЕЕ КЛАВИШ ───────────────────────────────────────────
{
  let действие = null;
  let код = null;
  const scanner = makeScanner({ onCode: (c) => { код = c; } });
  const снять = wireHotkeys(document, { onAction: (a) => { действие = a; }, scanner });

  // Сканер шлёт цифры и Enter
  let t0 = Date.now();
  for (const k of '4870001234567') {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown',
      { key: k, bubbles: true, cancelable: true }));
  }
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown',
    { key: 'Enter', bubbles: true, cancelable: true }));

  ok(код === '4870001234567',
     '★ Сканер прочитан целиком: он важнее клавиш, иначе товар не пробьётся');
  снять();
}

// ── В ПОЛЕ КЛАВИШИ НЕ МЕШАЮТ ───────────────────────────────────────
{
  let действие = null;
  const снять = wireHotkeys(document, { onAction: (a) => { действие = a; } });

  поле.focus();
  ok(typing(document.activeElement), 'Кассир печатает в поле');

  key('Delete');
  ok(действие === null,
     '★ Delete в поиске — это стереть букву, а не убрать позицию из чека');

  key('F8');
  ok(действие === 'pay',
     '★ А F-клавиши работают и в поле: они не буквы');

  поле.blur();
  снять();
}

// ── ПОДСКАЗКА ──────────────────────────────────────────────────────
{
  const h = hotkeyHelp();
  ok(h.length === KEYS.length && h.every((k) => /[а-яё]/i.test(k.name)),
     `★ Подсказка по-русски на все ${h.length} клавиш: кассир не гадает`);
}

console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
