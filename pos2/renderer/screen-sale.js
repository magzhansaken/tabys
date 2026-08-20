/*
 * ЭКРАН ПРОДАЖИ — собирает себя сам.
 *
 * Три части: вкладки и поиск слева, товары плитками, чек справа.
 *
 * Чек и оплата придут на этапах 13 и 16 — здесь только каталог, как
 * велит план. Место под них размечено, но пустым не показывается:
 * пустая колонка сбивает не меньше, чем пустой экран.
 */

function buildSale(root, state, ctx) {
  const { goods, onPick, onSearch } = ctx;

  root.innerHTML = `
    <div class="sale">
      <div class="sale-left">
        <div class="searchrow">
          <input id="saleSearch" class="field" autocomplete="off"
                 placeholder="Поиск или штрихкод">
          <button id="saleClear" class="ghost hidden" title="Очистить">✕</button>
        </div>
        <div class="cattabs" id="saleTabs"></div>
        <div class="goods" id="saleGoods"></div>
      </div>
      <div class="sale-right" id="saleCart"></div>
    </div>`;

  const field = root.querySelector('#saleSearch');
  const clear = root.querySelector('#saleClear');
  const tabsBox = root.querySelector('#saleTabs');
  const goodsBox = root.querySelector('#saleGoods');

  let tab = null;
  let query = '';

  const G = require_goods();

  function drawTabs() {
    const tabs = G.catTabs(goods);
    if (!tabs.includes(tab)) tab = tabs[0];
    tabsBox.innerHTML = tabs.map((n) =>
      `<button data-tab="${G.esc ? G.esc(n) : n}" class="${n === tab ? 'on' : ''}${
        n === G.QUICK_TAB ? ' quick' : ''}">${n}</button>`).join('');

    for (const b of tabsBox.querySelectorAll('button')) {
      b.onclick = () => {
        tab = b.dataset.tab;
        // Смена вкладки чистит поиск: иначе кассир жмёт «Табак», видит
        // молоко и решает, что касса сломалась.
        query = '';
        field.value = '';
        clear.classList.add('hidden');
        drawTabs();
        drawGoods();
      };
    }
  }

  function drawGoods() {
    const list = G.pickGoods(goods, { tab, query });

    if (!list.length) {
      /* ПУСТО — ОБЪЯСНЯЕМ. Кассир при очереди должен понимать, искать
         дальше или звать владельца. */
      goodsBox.innerHTML = `<div class="empty">${
        query
          ? `Ничего не нашлось по «${query}».<br><small>Проверьте написание или отсканируйте штрихкод</small>`
          : 'В этой вкладке пока нет товаров'
      }</div>`;
      return;
    }

    goodsBox.innerHTML = list.slice(0, 200).map((g, i) => `
      <button class="good" data-i="${i}">
        <span class="good-name">${g.name}</span>
        <span class="good-price">${g.price}</span>
        ${g.marked ? '<span class="good-mark">марка</span>' : ''}
      </button>`).join('');

    for (const b of goodsBox.querySelectorAll('.good')) {
      b.onclick = () => {
        const g = list[Number(b.dataset.i)];
        if (!g) return;
        onPick(g);

        /* ТОВАР ВЫБРАН — ПОИСК УХОДИТ. Их правило: «клавиатура своё
           отработала». Иначе в поиске висит «хле», и следующий товар
           кассир ищет поверх старого слова. */
        if (query) {
          query = '';
          field.value = '';
          clear.classList.add('hidden');
          drawGoods();
        }
      };
    }
  }

  field.oninput = () => {
    query = field.value;
    clear.classList.toggle('hidden', !query);
    drawGoods();
    if (onSearch) onSearch(query);
  };

  clear.onclick = () => {
    query = ''; field.value = ''; clear.classList.add('hidden');
    drawGoods(); field.focus();
  };

  drawTabs();
  drawGoods();

  /* Курсор в поиск: сканер шлёт код как набор с клавиатуры, и он
     должен попасть в поле, а не в пустоту. */
  setTimeout(() => field.focus(), 0);

  // Наружу — чтобы этапы 12 и 13 могли перерисовать товары и чек.
  root.__sale = { drawGoods, drawTabs, focus: () => field.focus() };
}

/* Разбор товаров лежит отдельным листом: в браузере он уже загружен,
   в проверке — берётся через require. */
function require_goods() {
  if (typeof module !== 'undefined' && typeof require === 'function') {
    return require('./goods.js');
  }
  return {
    QUICK_TAB: 'Ходовое', ALL_TAB: 'Все',
    catTabs: window.catTabs, pickGoods: window.pickGoods,
  };
}

if (typeof module !== 'undefined') module.exports = { buildSale };
