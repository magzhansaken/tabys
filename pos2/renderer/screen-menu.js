/*
 * ВЕРХНЯЯ СТРОКА И МЕНЮ КАССЫ.
 *
 * НАЙДЕНО ВАМИ: касса умела всё — отложенные чеки, возвраты, отчёты,
 * инкассацию, перепечатку — и НЕ ПОКАЗЫВАЛА НИЧЕГО. Девятнадцать дел
 * без единой кнопки, которая к ним ведёт.
 *
 * Свёртки были построены и проверены порознь, а собрать их в живую
 * кассу я не довёл. Проверки этого не видят: они зовут свёртки
 * напрямую, минуя экран.
 *
 * ЧТО НА ВИДУ, А ЧТО В МЕНЮ.
 *
 * На виду — то, что жмут при покупателе: отложить чек, скидка,
 * запереть кассу. Их ищут при очереди, и лишнее нажатие тут дорого.
 *
 * В меню — то, что делают между покупателями: отчёты, деньги,
 * настройки. Их и так делают спокойно.
 */

/** Верхняя строка: где мы, кто за кассой, жива ли связь. */
function buildTopBar(root, state, ctx) {
  const { netDown, pending, rejected, onMenu, onLock, money } = ctx;

  root.innerHTML = `
    <div class="top">
      <div class="top-where">
        <b>${esc(state.storeName || 'Касса')}</b>
        <small>${esc(state.registerName || '')}</small>
      </div>

      <div class="top-who" id="topWho"></div>

      <!-- СВЯЗЬ ОТДЕЛЬНО ОТ ОЧЕРЕДИ: пустая очередь не значит, что сеть
           жива. Кассир должен видеть правду, а не зелёную точку. -->
      <div class="top-net ${netDown ? 'down' : 'up'}" id="topNet"></div>

      <button id="topLock" class="ghost" title="Запереть кассу">🔒</button>
      <button id="topMenu" class="ghost">Меню</button>
    </div>`;

  const кто = root.querySelector('#topWho');
  кто.textContent = state.employee ? state.employee.name : '';

  const связь = root.querySelector('#topNet');
  const части = [];
  части.push(netDown ? 'Нет связи' : 'Связь есть');
  if (pending) части.push(`не ушло: ${pending}`);
  if (rejected) части.push(`не принято: ${rejected}`);
  связь.textContent = части.join(' · ');

  root.querySelector('#topMenu').onclick = () => onMenu && onMenu();
  root.querySelector('#topLock').onclick = () => onLock && onLock();
}

/**
 * МЕНЮ КАССЫ.
 *
 * Разделами, а не общей кучей: кассир ищет глазами, а не читает
 * подряд. Каждая строка объясняет себя — иначе он не решится нажать.
 */
function buildMenu(root, state, ctx) {
  const { openSheet, closeModal, money, on } = ctx;

  const разделы = [
    ['Чек', [
      ['park', 'Отложить чек', 'Покупатель ушёл за деньгами — касса свободна', !!ctx.hasCart],
      ['unpark', `Отложенные${ctx.parked ? ` (${ctx.parked})` : ''}`, 'Вернуть отложенный чек', !!ctx.parked],
      ['discount', 'Скидка на чек', 'В пределах вашего потолка', !!ctx.hasCart],
      ['reprint', 'Повторить печать', 'Кончилась лента, отошёл провод', true],
      ['price', 'Сколько стоит?', 'Узнать цену, не пробивая товар', true],
    ]],
    ['Деньги', [
      ['refund', 'Возврат по чеку', 'Покупатель принёс товар и чек', true],
      ['cash_in', 'Внести в кассу', 'Размен утром, доложили мелочь', true],
      ['cash_out', 'Изъять из кассы', 'Взяли на расходы — назовите на что', true],
      ['collection', 'Инкассация', 'Сдали выручку владельцу или в банк', true],
      ['drawer', 'Открыть ящик', 'Без продажи — разменять или проверить', true],
    ]],
    ['Смена', [
      ['xreport', 'X-отчёт', 'Сколько сейчас — смена продолжается', true],
      ['shift_close', 'Закрыть смену', 'Пересчитать ящик и свести день', true],
      ['rejected', `Сервер не принял${ctx.rejected ? ` (${ctx.rejected})` : ''}`,
        'Чеки, которых нет в отчёте — покажите владельцу', !!ctx.rejected],
    ]],
    ['Касса', [
      ['printer', 'Настройки печати', 'Принтер, ширина ленты, пробная печать', true],
      ['log', 'Журнал печати', 'Что писала касса — для разбора с владельцем', true],
      ['lang', `Язык: ${state.lang === 'kz' ? 'қазақша' : 'русский'}`,
        'Чек всегда печатается по-русски', true],
      ['keys', 'Горячие клавиши', 'Что работает с клавиатуры', true],
      ['logout', 'Выйти', 'Сменщик сядет за кассу — смена останется', true],
    ]],
  ];

  const html = разделы.map(([имя, дела]) => `
    <div class="menu-group">
      <div class="menu-title">${esc(имя)}</div>
      ${дела.map(([id, name, hint, можно]) => `
        <button class="menu-item" data-do="${id}" ${можно ? '' : 'disabled'}>
          <span class="menu-name">${esc(name)}</span>
          <span class="menu-hint">${esc(hint)}</span>
        </button>`).join('')}
    </div>`).join('');

  const card = openSheet(root, { title: 'Меню кассы', html: `<div class="menu">${html}</div>` });

  card.querySelectorAll('[data-do]').forEach((b) => {
    b.onclick = () => {
      if (b.disabled) return;
      closeModal(root);
      on(b.dataset.do);
    };
  });
}

/* Экранирование берём из окон: второе объявление сломало бы файл. */
if (typeof module !== 'undefined') {
  // eslint-disable-next-line global-require
  var { esc } = require('./ui.js');
  module.exports = { buildTopBar, buildMenu };
}
