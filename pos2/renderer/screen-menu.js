/*
 * ВЕРХНЯЯ СТРОКА И МЕНЮ КАССЫ.
 *
 * Найдено владельцем: касса умела всё и не показывала ничего. Поэтому
 * ЗДЕСЬ ПЕРЕЧИСЛЕНЫ ВСЕ ВОСЕМНАДЦАТЬ ДЕЛ — терять нельзя ни одного.
 *
 * На виду — то, что жмут при покупателе. В меню — то, что делают
 * между покупателями.
 *
 * ОБЛИК v3:
 *   меню разворачивается ЧЕТЫРЬМЯ СТОЛБЦАМИ на широком экране: все 18
 *     дел видны разом, без прокрутки — кассир ищет глазами, а не
 *     листает;
 *   гашёное дело остаётся видимым и объясняет себя подписью — гашёная
 *     кнопка честнее пропавшей;
 *   в верхней строке появились ЧАСЫ: смену закрывают по времени, а
 *     касса стоит в полный экран — часов Windows не видно;
 *   связь — цветная точка со словами, недалеко от глаз кассира.
 */

/** Верхняя строка: где мы, кто за кассой, жива ли связь, который час. */
function buildTopBar(root, state, ctx) {
  const { netDown, pending, rejected, onMenu, onLock } = ctx;

  root.innerHTML = `
    <div class="top">
      <div class="top-where">
        <b>${esc(state.storeName || 'Касса')}</b>
        <small>${esc(state.registerName || '')}</small>
      </div>

      <div class="top-who" id="topWho"></div>

      <div class="top-clock" id="topClock"></div>

      <!-- СВЯЗЬ ОТДЕЛЬНО ОТ ОЧЕРЕДИ: пустая очередь не значит, что
           сеть жива. Кассир видит правду, а не зелёную точку. -->
      <div class="top-net ${netDown ? 'down' : 'up'}" id="topNet"></div>

      <button id="topLock" title="Запереть кассу — чек не пропадёт">Замок</button>
      <button id="topMenu" title="Все дела кассы — F12">Меню</button>
    </div>`;

  const кто = root.querySelector('#topWho');
  кто.textContent = state.employee ? state.employee.name : '';

  const связь = root.querySelector('#topNet');
  const части = [];
  части.push(netDown ? 'Нет связи' : 'Связь есть');
  if (pending) части.push(`не ушло: ${pending}`);
  if (rejected) части.push(`не принято: ${rejected}`);
  связь.textContent = части.join(' · ');

  /* ЧАСЫ. Прежний отсчёт снимаем ПЕРЕД новым: верхняя строка
     пересобирается при каждом чеке, и без уборки отсчёты копились бы. */
  const часы = root.querySelector('#topClock');
  const тик = () => {
    часы.textContent = new Date().toLocaleTimeString('ru-RU',
      { hour: '2-digit', minute: '2-digit' });
  };
  if (root.__clock) clearInterval(root.__clock);
  root.__clock = setInterval(тик, 15000);
  тик();

  root.querySelector('#topMenu').onclick = () => onMenu && onMenu();
  root.querySelector('#topLock').onclick = () => onLock && onLock();
}

/**
 * МЕНЮ КАССЫ. Разделами, а не кучей: кассир ищет глазами. Каждая
 * строка объясняет себя — иначе он не решится нажать.
 */
function buildMenu(root, state, ctx) {
  const { openSheet, closeModal, on } = ctx;

  const разделы = [
    ['Чек', [
      ['park', 'Отложить чек', 'Покупатель ушёл за деньгами — касса свободна', !!ctx.hasCart],
      ['unpark', `Отложенные${ctx.parked ? ` (${ctx.parked})` : ''}`, 'Вернуть отложенный чек', !!ctx.parked],
      ['discount', 'Скидка на чек', 'В пределах вашего потолка', !!ctx.hasCart],
      ['reprint', 'Повторить печать', 'Кончилась лента, отошёл провод', true],
      ['price', 'Сколько стоит?', 'Узнать цену, не пробивая товар — F5', true],
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

  const card = openSheet(root, { title: 'Меню кассы',
    html: `<div class="menu menu-full">${html}</div>` });

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
