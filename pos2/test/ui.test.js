/*
 * ПРОВЕРКА ОКОН — на настоящей странице.
 *
 * Каждый случай — ловушка, которая уже кого-то подводила.
 */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body><div id="modal" class="hidden"></div><div id="toasts"></div></body>');
global.document = dom.window.document;
global.window = dom.window;

const ui = require('../renderer/ui.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

const root = document.getElementById('modal');
const toasts = document.getElementById('toasts');
const click = (el, type = 'mousedown') => el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true }));

console.log('═══ ЭТАП 5 · СВОИ ОКНА ═══\n');

// ── ОКНО ОТКРЫВАЕТСЯ И ЗАКРЫВАЕТСЯ ─────────────────────────────────
{
  ui.openModal(root, '<p>Проба</p>');
  ok(!root.classList.contains('hidden') && /Проба/.test(root.innerHTML), 'Окно открылось');
  ok(ui.hasModal(), 'Касса знает, что окно открыто');
  ui.closeModal(root);
  ok(root.classList.contains('hidden') && root.innerHTML === '',
     '★ Закрылось и убрало за собой: следующее откроется чистым');
  ok(!ui.hasModal(), 'И касса это знает');
}

// ── ЛОВУШКА 1: КЛИК ПО ОКНУ НЕ ЗАКРЫВАЕТ ЕГО ───────────────────────
{
  ui.openModal(root, '<button id="ins">Кнопка внутри</button>');
  click(document.getElementById('ins'));
  ok(ui.hasModal(),
     '★ Клик по кнопке ВНУТРИ окна не захлопнул его — их урок про «пузырение»');

  // А касание мимо — закрывает: так ведут себя все окна кассы
  click(root.querySelector('[data-back]'));
  ok(!ui.hasModal(), '★ Касание МИМО окна закрывает');
}

// ── ЛОВУШКА 2: ОПАСНОЕ СПРАВА И КРАСНЫМ ────────────────────────────
{
  ui.askSure(root, { title: 'Вернуть чек?', text: 'Из кассы уйдёт 3 400 ₸', yes: 'Вернуть', danger: true });
  const кнопки = [...root.querySelectorAll('.row-actions button')];
  ok(кнопки[0].hasAttribute('data-no'), '★ «Отмена» ПЕРВАЯ: случайный тычок безопасен');
  ok(кнопки[1].className.includes('bad'), '★ Опасное подписано красным');
  ui.closeModal(root);
}

// ── ВОПРОС ОТВЕЧАЕТ ─────────────────────────────────────────────────
{
  const p = ui.askSure(root, { title: 'Заменить чек?' });
  click(root.querySelector('[data-yes]'), 'click');
  p.then((r) => ok(r === true, 'Ответ «да» доходит'));
}
{
  const p = ui.askSure(root, { title: 'Заменить чек?' });
  click(root.querySelector('[data-no]'), 'click');
  p.then((r) => ok(r === false, 'Ответ «нет» доходит'));
}
{
  // Закрыли фоном — считается отказом. Иначе касса ждала бы вечно.
  const p = ui.askSure(root, { title: 'Заменить чек?' });
  click(root.querySelector('[data-back]'));
  p.then((r) => ok(r === false, '★ Закрыли фоном — это «нет», а не зависшее ожидание'));
}

// ── ЛОВУШКА 3: ESCAPE ЗАКРЫВАЕТ ────────────────────────────────────
{
  ui.wireEscape(document);
  ui.openModal(root, '<p>Проба</p>');
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(!ui.hasModal(), '★ Escape закрывает — один список на ВСЕ окна');
}

// ── ЛОВУШКА 4: ОДНО ОКНО ЗА РАЗ ────────────────────────────────────
{
  ui.openModal(root, '<p id="первое">Первое</p>');
  ui.openModal(root, '<p id="второе">Второе</p>');
  ok(!document.getElementById('первое') && document.getElementById('второе'),
     '★ Второе окно заменило первое, а не легло поверх');
  ui.closeModal(root);
}

// ── ИМЯ ТОВАРА СО СКОБКАМИ НЕ ЛОМАЕТ ОКНО ──────────────────────────
{
  ui.askSure(root, { title: 'Убрать «<b>Хлеб</b>»?' });
  ok(/&lt;b&gt;/.test(root.innerHTML),
     '★ Имя со скобками показано как есть, а не выполнено как разметка');
  ui.closeModal(root);
}

// ── СООБЩЕНИЕ ───────────────────────────────────────────────────────
{
  ui.toast(toasts, 'Чек напечатан');
  ok(toasts.children.length === 1 && /Чек напечатан/.test(toasts.textContent), 'Сообщение появилось');
  const e = ui.toast(toasts, 'Не хватает марок', 'warn');
  ok(e.className.includes('warn'), 'Ошибка помечена отдельно');
  ok(toasts.children.length === 2, 'Два сообщения не мешают друг другу');
}

// ── ЛИСТ СНИЗУ ──────────────────────────────────────────────────────
{
  ui.openSheet(root, { title: 'Отчёт смены', html: '<p>Выручка 45 000 ₸</p>' });
  ok(/sheet-head/.test(root.innerHTML) && /Выручка/.test(root.textContent), 'Лист открылся');
  click(root.querySelector('[data-close]'), 'click');
  ok(!ui.hasModal(), 'И закрылся по крестику');
}

setTimeout(() => {
  console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
  process.exit(failed ? 1 : 0);
}, 50);
