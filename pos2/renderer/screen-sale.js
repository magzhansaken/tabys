/*
 * ЭКРАН ПРОДАЖИ — главный экран кассы. Собирает себя сам.
 *
 * Слева товары, справа чек — как и было: кассир смотрит вправо, там
 * то, за что платит покупатель. Товары СТРОКАМИ во всю ширину — это
 * выстраданное решение, оставлено: название читается целиком, два
 * сорта хлеба различимы, крупный шрифт виден через стол.
 *
 * ЧТО ИЗМЕНИЛОСЬ В ОБЛИКЕ v3:
 *   ОПЛАТА несёт итог НА СЕБЕ — самая крупная кнопка кассы: один
 *     взгляд — сумма, одно касание — оплата;
 *   вкладка «Все» появилась: раньше при первом входе список был полон,
 *     а ни одна вкладка не горела — непонятно, где ты;
 *   у поиска крестик: стереть запрос — одно касание, а не десять «⌫»,
 *     и кнопка экранной клавиатуры для планшета (по кнопке, не сама:
 *     курсор всегда в поиске из-за сканера, всплывающая мешала бы);
 *   весовой и маркированный товар помечены в списке заранее — кассир
 *     знает, чего ждать, ДО касания;
 *   цена весового подписана «/кг» — 280 ₸ без подписи читалось как
 *     цена штуки.
 */
function buildSale(root, state, ctx) {
  const { goods, cart, cartDiscount, tabs, tab, query, money,
    onTab, onSearch, onPick, onPay, onLine, markBar } = ctx;

  const позиций = (cart || []).length;
  const итог = Math.max(0, (cart || []).reduce((a, l) =>
    a + Math.round(l.price * l.qty) - (l.discount || 0), 0) - (cartDiscount || 0));

  const kbdEl = document.getElementById('kbd');
  const kbdOpen = !!(kbdEl && !kbdEl.classList.contains('hidden'));

  root.innerHTML = `
    <div class="sale">
      <div class="sale-left">
        <div class="sale-find">
          <div class="sale-findwrap">
            <input id="saleSearch" class="field sale-search" autocomplete="off"
                   spellcheck="false" placeholder="Поиск: название или штрихкод"
                   value="${esc(query || '')}">
            ${query ? '<button id="saleClearQ" class="sale-clear" title="Очистить поиск">✕</button>' : ''}
          </div>
          <button id="saleKbd" class="sale-kbd ${kbdOpen ? 'on' : ''}"
                  title="Экранная клавиатура">АБВ</button>
        </div>
        <div class="sale-tabs" id="saleTabs"></div>
        <div class="sale-goods" id="saleGoods"></div>
      </div>

      <div class="sale-right">
        <div class="sale-marks" id="saleMarks"></div>
        <div class="cart-head"><span>Чек</span><span>${позиций
          ? `${позиций} ${plural(позиций, 'позиция', 'позиции', 'позиций')}` : ''}</span></div>
        <div class="sale-cart" id="saleCart"></div>
        <div class="sale-sums">
          ${cartDiscount ? `<div class="sale-disc"><span>Скидка на чек</span>
            <span>−${money(cartDiscount)}</span></div>` : ''}
          <div class="sale-total">
            <span>ИТОГО</span>
            <b id="saleTotal">${money(итог)}</b>
          </div>
        </div>
        <div class="sale-acts">
          <!-- ЦЕНА НА ВИДУ: её спрашивают при покупателе. Работает и на
               пустом чеке: вопрос задают до покупки. -->
          <button id="salePrice">Цена?</button>
          <button id="saleDisc" ${позиций ? '' : 'disabled'}>Скидка</button>
          <button id="salePark" ${позиций ? '' : 'disabled'}>Отложить</button>
          <button id="saleClear" class="bad" ${позиций ? '' : 'disabled'}>Очистить</button>
        </div>
        <button id="salePay" class="primary paybtn" ${позиций ? '' : 'disabled'}
          ${позиций ? '' : 'title="Чек пуст — сканируйте товар"'}>
          <span class="paybtn-word">ОПЛАТА</span>
          <b class="paybtn-sum">${money(итог)}</b>
        </button>
      </div>
    </div>`;

  /* ── ВКЛАДКИ. «Все» — своя: видно, где ты, даже до первого касания. ── */
  const рядВкладок = root.querySelector('#saleTabs');
  const вкладка = (имя, включена, значение) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = имя;
    b.className = включена ? 'on' : '';
    b.onclick = () => onTab && onTab(значение);
    рядВкладок.appendChild(b);
  };
  вкладка('Все', !tab && !query, null);
  for (const t of tabs || []) вкладка(t, t === tab, t);

  /* ── ТОВАРЫ ──────────────────────────────────────────────────── */
  const сетка = root.querySelector('#saleGoods');
  if (!goods || !goods.length) {
    // Пусто ОБЪЯСНЕНО: пустое место — это звонок в поддержку.
    сетка.innerHTML = `<div class="sale-empty">${esc(ctx.empty
      || 'Ничего не нашлось — проверьте написание или отсканируйте штрихкод')}</div>`;
  } else {
    for (const g of goods) {
      const весовой = g.weight || g.unit === 'кг';
      const метки = (g.marked ? '<span class="tag tag-mark">марка</span>' : '')
        + (весовой ? '<span class="tag tag-kg">на вес</span>' : '');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'good';
      b.innerHTML = `<span class="good-name">${esc(g.name)}</span>`
        + `<span class="good-price">${money(g.price)}${весовой ? '<small> /кг</small>' : ''}</span>`
        + (метки ? `<span class="good-tags">${метки}</span>` : '');
      b.onclick = () => onPick && onPick(g, 1);
      сетка.appendChild(b);
    }
  }

  /* ── ЧЕК ─────────────────────────────────────────────────────── */
  const чек = root.querySelector('#saleCart');
  if (!позиций) {
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
          l.discount ? `<i class="cart-disc">скидка −${money(l.discount)}</i>` : ''}</div>`;

      row.querySelectorAll('button').forEach((b) => {
        b.onclick = () => onLine && onLine(i, b.dataset.act);
      });
      чек.appendChild(row);
    }
    // Последняя строка на виду: кассир смотрит туда, куда пробил.
    чек.scrollTop = чек.scrollHeight;
  }

  /* ── ПОЛОСА МАРОК ────────────────────────────────────────────── */
  const полоса = root.querySelector('#saleMarks');
  if (markBar) {
    полоса.className = 'sale-marks ' + markBar.kind;
    полоса.innerHTML = `<b>${esc(markBar.title)}</b><small>${esc(markBar.note)}</small>`;
  } else {
    полоса.className = 'sale-marks hidden';
  }

  /* ── ПОИСК ───────────────────────────────────────────────────── */
  const поле = root.querySelector('#saleSearch');
  let ждём = null;

  поле.oninput = () => {
    /* Не ищем на каждой букве: перерисовка на каждый знак сносит
       разметку и сбивает курсор. Ждём, пока кассир остановится. */
    clearTimeout(ждём);
    const q = поле.value;
    ждём = setTimeout(() => onSearch && onSearch(q), 250);
  };

  const крестик = root.querySelector('#saleClearQ');
  if (крестик) крестик.onclick = () => onSearch && onSearch('');

  /* ЭКРАННАЯ КЛАВИАТУРА — ПО КНОПКЕ, НЕ САМА. Курсор всегда стоит в
     поиске ради сканера; всплывай она сама — заслоняла бы товары при
     каждом чеке. Пишет в живое поле (ищем его при каждом касании:
     экран пересобирается, старое поле умирает). */
  const kbdBtn = root.querySelector('#saleKbd');
  kbdBtn.onclick = () => {
    const k = document.getElementById('kbd');
    if (!k) return;
    if (!k.classList.contains('hidden')) {
      k.classList.add('hidden'); k.innerHTML = '';
      kbdBtn.classList.remove('on');
      return;
    }
    buildKeyboard(k, {
      mode: 'text',
      onKey: (v) => applyKey(document.getElementById('saleSearch'), v),
      onClose: () => { k.classList.add('hidden'); k.innerHTML = ''; kbdBtn.classList.remove('on'); },
    });
    k.classList.remove('hidden');
    kbdBtn.classList.add('on');
    поле.focus();
  };

  root.querySelector('#salePay').onclick = () => onPay && onPay();

  /* КНОПКИ ПРИ ПОКУПАТЕЛЕ: их жмут, пока человек стоит у кассы —
     прятать в меню значит держать очередь. */
  root.querySelector('#salePrice').onclick = () => ctx.onPrice && ctx.onPrice();
  root.querySelector('#saleDisc').onclick = () => ctx.onDiscount && ctx.onDiscount();
  root.querySelector('#salePark').onclick = () => ctx.onPark && ctx.onPark();
  root.querySelector('#saleClear').onclick = () => ctx.onClear && ctx.onClear();

  /* КУРСОР В ПОЛЕ: сканер начнёт печатать в ту же секунду. */
  setTimeout(() => { поле.focus(); поле.setSelectionRange(поле.value.length, поле.value.length); }, 0);
}

/* Экранирование берём из окон: второе объявление сломало бы файл. */
if (typeof module !== 'undefined') {
  // eslint-disable-next-line global-require
  var { esc } = require('./ui.js');
  module.exports = { buildSale };
}
