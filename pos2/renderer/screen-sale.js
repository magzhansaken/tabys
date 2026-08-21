/*
 * ЭКРАН ПРОДАЖИ — главный экран кассы.
 *
 * Слева товары, справа чек. Кассир смотрит вправо: там то, за что
 * платит покупатель.
 *
 * НАЙДЕНО ЖИВЬЁМ: прежний экран рисовал только каталог. Товар
 * пробивался, ложился в чек, но кассир его НЕ ВИДЕЛ — и не мог ни
 * проверить, ни отменить.
 *
 * Собирает себя сам — правило этапа 1.
 */
function buildSale(root, state, ctx) {
  const { goods, cart, cartDiscount, tabs, tab, query, money,
    onTab, onSearch, onPick, onPay, onLine, markBar } = ctx;

  const итог = (cart || []).reduce((a, l) =>
    a + Math.round(l.price * l.qty) - (l.discount || 0), 0) - (cartDiscount || 0);

  root.innerHTML = `
    <div class="sale">
      <div class="sale-left">
        <input id="saleSearch" class="field sale-search" autocomplete="off"
               placeholder="Поиск товара или штрихкод" value="${esc(query || '')}">
        <div class="sale-tabs" id="saleTabs"></div>
        <div class="sale-goods" id="saleGoods"></div>
      </div>

      <div class="sale-right">
        <div class="sale-marks" id="saleMarks"></div>
        <div class="sale-cart" id="saleCart"></div>
        <div class="sale-total">
          <span>ИТОГО</span>
          <b id="saleTotal">${money(Math.max(0, итог))}</b>
        </div>
        <div class="sale-acts">
          <!-- ЦЕНА НА ВИДУ: её спрашивают ПРИ ПОКУПАТЕЛЕ, и он ждёт у
               прилавка. Работает и на пустом чеке: вопрос задают до
               покупки. -->
          <button id="salePrice">Цена?</button>
          <button id="saleDisc" ${cart && cart.length ? '' : 'disabled'}>Скидка</button>
          <button id="salePark" ${cart && cart.length ? '' : 'disabled'}>Отложить</button>
          <button id="saleClear" class="bad" ${cart && cart.length ? '' : 'disabled'}>Очистить</button>
        </div>

        <button id="salePay" class="primary big" ${cart && cart.length ? '' : 'disabled'}
          ${cart && cart.length ? '' : 'title="Чек пуст — сканируйте товар"'}>ОПЛАТА</button>
      </div>
    </div>`;

  /* ── ВКЛАДКИ ──────────────────────────────────────────────────── */
  const рядВкладок = root.querySelector('#saleTabs');
  for (const t of tabs || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t;
    b.className = t === tab ? 'on' : '';
    b.onclick = () => onTab && onTab(t);
    рядВкладок.appendChild(b);
  }

  /* ── ТОВАРЫ ───────────────────────────────────────────────────── */
  const сетка = root.querySelector('#saleGoods');
  if (!goods || !goods.length) {
    // Пусто ОБЪЯСНЕНО: пустое место — это звонок в поддержку.
    сетка.innerHTML = `<div class="sale-empty">${esc(ctx.empty
      || 'Ничего не нашлось — проверьте написание или отсканируйте штрихкод')}</div>`;
  } else {
    for (const g of goods) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'good';
      b.innerHTML = `<span class="good-name">${esc(g.name)}</span>`
        + `<span class="good-price">${money(g.price)}</span>`
        + (g.marked ? '<span class="good-mark">марка</span>' : '');
      b.onclick = () => onPick && onPick(g, 1);
      сетка.appendChild(b);
    }
  }

  /* ── ЧЕК ──────────────────────────────────────────────────────── */
  const чек = root.querySelector('#saleCart');
  if (!cart || !cart.length) {
    чек.innerHTML = '<div class="cart-empty">Отсканируйте товар<br>или выберите слева</div>';
  } else {
    for (let i = 0; i < cart.length; i += 1) {
      const l = cart[i];
      const сумма = Math.round(l.price * l.qty) - (l.discount || 0);
      const кол = l.qty % 1
        ? String(Number(l.qty.toFixed(3))).replace('.', ',') + ' ' + (l.unit || 'кг')
        : '×' + l.qty;

      const row = document.createElement('div');
      row.className = 'cart-row';
      row.innerHTML = `
        <div class="cart-name">${esc(l.name)}${
          l.marked ? '<i class="cart-mark">марка</i>' : ''}</div>
        <div class="cart-qty">
          <button data-act="minus" title="Меньше">−</button>
          <span>${кол}</span>
          <button data-act="plus" title="Больше">+</button>
        </div>
        <div class="cart-sum">${money(сумма)}${
          l.discount ? `<i class="cart-disc">−${money(l.discount)}</i>` : ''}</div>`;

      row.querySelectorAll('button').forEach((b) => {
        b.onclick = () => onLine && onLine(i, b.dataset.act);
      });
      чек.appendChild(row);
    }
    // Последняя строка на виду: кассир смотрит туда, куда пробил.
    чек.scrollTop = чек.scrollHeight;
  }

  /* ── ПОЛОСА МАРОК ─────────────────────────────────────────────── */
  const полоса = root.querySelector('#saleMarks');
  if (markBar) {
    полоса.className = 'sale-marks ' + markBar.kind;
    полоса.innerHTML = `<b>${esc(markBar.title)}</b><small>${esc(markBar.note)}</small>`;
  } else {
    полоса.className = 'sale-marks hidden';
  }

  /* ── ПОИСК ────────────────────────────────────────────────────── */
  const поле = root.querySelector('#saleSearch');
  let ждём = null;

  поле.oninput = () => {
    /* НЕ ИЩЕМ НА КАЖДОЙ БУКВЕ. Перерисовка на каждый знак сносит
       разметку и сбивает курсор — кассир печатает «мол», а поле
       очищается на втором знаке. Ждём, пока он остановится. */
    clearTimeout(ждём);
    const q = поле.value;
    ждём = setTimeout(() => onSearch && onSearch(q), 250);
  };

  root.querySelector('#salePay').onclick = () => onPay && onPay();

  /* КНОПКИ ПРИ ПОКУПАТЕЛЕ. Скидка, отложить, очистить — их жмут, пока
     человек стоит у кассы, и прятать их в меню значит держать очередь. */
  root.querySelector('#salePrice').onclick = () => ctx.onPrice && ctx.onPrice();
  root.querySelector('#saleDisc').onclick = () => ctx.onDiscount && ctx.onDiscount();
  root.querySelector('#salePark').onclick = () => ctx.onPark && ctx.onPark();
  root.querySelector('#saleClear').onclick = () => ctx.onClear && ctx.onClear();

  /* КУРСОР В ПОЛЕ: сканер начнёт печатать в ту же секунду, и кассиру
     не придётся сначала целиться пальцем. */
  setTimeout(() => { поле.focus(); поле.setSelectionRange(поле.value.length, поле.value.length); }, 0);
}


/* Экранирование берём из окон: оно там уже есть, и второе объявление
   сломало бы этот файл целиком — все они на одной странице. */
if (typeof module !== 'undefined') {
  // eslint-disable-next-line global-require
  var { esc } = require('./ui.js');
  module.exports = { buildSale };
}
