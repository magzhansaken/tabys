/**
 * ТАБЫС КАССА — экраны и логика.
 *
 * Главный принцип: ПРОДАЖА НИКОГДА НЕ ЖДЁТ СЕТЬ. Чек считается и
 * сохраняется на диск мгновенно, а на сервер уходит фоном. Если интернета
 * нет — касса работает как обычно, а очередь копится и уезжает потом.
 *
 * Деньги считаем в целых тенге. Дробное представление в компьютере
 * округляется незаметно, и столбик оплат перестаёт сходиться с итогом —
 * владелец видит «недостачу» на ровном месте.
 */
const K = window.kassa;

const $ = (id) => document.getElementById(id);
const show = (id) => {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
  $(id).classList.remove('hidden');
};
const money = (n) => {
  const v = Number(n || 0);
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';
};
const uuid = () => crypto.randomUUID();

let S = {};            // состояние: токен, кассир, смена
let SET = {};          // настройки: адрес сервера, принтер
let catalog = [];      // товары (лежат на диске — продаём без интернета)
let cart = [];         // текущий чек

// ── Обращения к серверу ──────────────────────────────────────────────
async function api(path, { method = 'GET', body, device = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (device && S.deviceToken) headers['X-Device-Token'] = S.deviceToken;
  const r = await fetch(SET.apiUrl.replace(/\/$/, '') + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.message || `Сервер ответил ${r.status}`);
  return d;
}

// ── Запуск ───────────────────────────────────────────────────────────
(async function start() {
  const v = await K.version(); $('ver').textContent = 'v' + (v.data || '');
  $('ver2').textContent = 'Табыс v' + (v.data || '');
  SET = (await K.getSettings()).data;
  S = (await K.getState()).data;
  catalog = (await K.getCatalog()).data || [];

  $('apiUrl').value = SET.apiUrl;
  $('printWidth').value = String(SET.printWidth || 48);
  loadPrinters();

  if (!S.deviceToken) { show('scr-setup'); return; }
  if (!S.employee) { openPin(); return; }
  openSale();
  syncLoop();
})();

async function loadPrinters() {
  const r = await K.printers();
  if (!r.ok) return;
  const sel = $('printerSel');
  for (const p of r.data) {
    const o = document.createElement('option');
    o.value = p; o.textContent = p;
    if (p === SET.printer) o.selected = true;
    sel.appendChild(o);
  }
}

// ── Экран 1: привязка ────────────────────────────────────────────────
$('btnPair').onclick = async () => {
  const err = $('setupErr'); err.textContent = '';
  SET = (await K.saveSettings({
    apiUrl: $('apiUrl').value.trim(),
    printer: $('printerSel').value,
    printWidth: Number($('printWidth').value),
  })).data;
  const code = $('pairCode').value.trim();
  if (!code) { err.textContent = 'Введите код привязки из кабинета'; return; }
  try {
    const d = await api('/pos/pair', {
      method: 'POST', device: false,
      body: { code, platform: 'windows', appVersion: (await K.version()).data },
    });
    S = (await K.saveState({
      deviceToken: d.deviceToken, deviceId: d.deviceId,
      accountId: d.accountId, cashRegisterId: d.cashRegisterId,
    })).data;
    await pullCatalog();
    openPin();
  } catch (e) { err.textContent = e.message; }
};

$('btnTestPrint').onclick = async () => {
  await K.saveSettings({ printer: $('printerSel').value, printWidth: Number($('printWidth').value) });
  // Печатаем диагностический лист, а не просто строку: по нему сразу видно
  // ширину ленты, кириллицу, выделение и вид денег. Простая «пробная
  // строка» печатается даже при неверных настройках и ничего не проверяет.
  const r = await K.printDiagnostic();
  $('setupErr').textContent = r.ok
    ? 'Лист отправлен. Проверьте: рамка ровная, буквы читаются, цифры не обрезаны'
    : 'Ошибка печати: ' + r.error;
};

// ── Экран 2: PIN ─────────────────────────────────────────────────────
let pin = '';
function openPin() {
  show('scr-pin');
  $('pinStore').textContent = S.store?.name || '';
  pin = ''; drawPin();
  const kp = $('keypad'); kp.innerHTML = '';
  for (const d of ['1','2','3','4','5','6','7','8','9','C','0','←']) {
    const b = document.createElement('button');
    b.textContent = d;
    b.onclick = () => {
      if (d === 'C') pin = '';
      else if (d === '←') pin = pin.slice(0, -1);
      else if (pin.length < 4) pin += d;
      drawPin();
      if (pin.length === 4) tryPin();
    };
    kp.appendChild(b);
  }
}
function drawPin() {
  $('pinDots').innerHTML = [0,1,2,3].map((i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
}
async function tryPin() {
  const err = $('pinErr'); err.textContent = '';
  try {
    const d = await api('/pos/login', { method: 'POST', body: { pin } });
    S = (await K.saveState({ employee: d.employee || d, shift: S.shift || null })).data;
    await pullCatalog().catch(() => {});
    openSale(); syncLoop();
  } catch (e) {
    // Офлайн-вход: если сервер недоступен, пускаем кассира, который уже
    // входил на этой кассе. Иначе пропажа интернета останавливает торговлю.
    if (/fetch|network|failed/i.test(e.message) && S.lastEmployee) {
      S = (await K.saveState({ employee: S.lastEmployee })).data;
      openSale(); return;
    }
    err.textContent = e.message; pin = ''; drawPin();
  }
}

// ── Экран 3: продажа ─────────────────────────────────────────────────
function openSale() {
  show('scr-sale');
  $('cashierLabel').textContent = S.employee?.name ? ' · ' + S.employee.name : '';
  drawTop();
  K.saveState({ lastEmployee: S.employee });
  drawGoods(''); drawCart(); updatePending(); updateParkedCount();
}

/**
 * Шапка: смена, наличные в кассе, неотправленные чеки, счётчик отмен.
 *
 * Наличные показываем прямо здесь: кассир должен видеть остаток, не
 * открывая ящик и не считая в уме. При закрытии смены он сверяет эту
 * цифру с тем, что насчитал руками — расхождение видно сразу, а не
 * через неделю в отчёте у владельца.
 */
function drawTop() {
  $('shiftLabel').textContent = S.shift ? 'Смена открыта' : 'Смена не открыта';
  const el = $('cashLabel');
  if (el) {
    el.textContent = S.shift ? 'в кассе ' + money(S.cashInDrawer || 0) : '';
    el.className = S.shift ? 'cash-badge' : '';
  }
}

$('search').oninput = (e) => drawGoods(e.target.value);
$('search').onkeydown = (e) => {
  // Сканер штрихкодов «печатает» код и жмёт Enter — ловим и добавляем сразу.
  if (e.key === 'Enter') {
    const q = e.target.value.trim();
    const found = catalog.find((g) => (g.barcodes || []).includes(q));
    if (found) { addToCart(found); e.target.value = ''; drawGoods(''); }
  }
};

// ── Быстрые товары ──────────────────────────────────────────────────
// Часто продаваемое плитками, чтобы не искать поиском по сто раз за смену.
// Что именно и в каких группах — задаёт владелец в кабинете; касса просто
// показывает то, что пришло в каталоге, и ничего не решает сама.
let quickGroup = null;

function quickItems() {
  return catalog.filter((g) => g.quick || g.quickGroup);
}

function drawQuick() {
  const items = quickItems();
  const tabs = $('quickTabs'), grid = $('quickGrid');
  if (!tabs || !grid) return;

  if (!items.length) {
    tabs.innerHTML = '';
    // Пустое состояние говорит, что сделать, а не «ничего нет».
    grid.innerHTML = '<div class="quick-empty">Быстрые товары не настроены. ' +
      'Владелец добавляет их в кабинете: сигареты, пакеты, вода — то, что ' +
      'продаётся десятки раз в день, чтобы не искать поиском.</div>';
    return;
  }

  const groups = [];
  for (const g of items) {
    const name = g.quickGroup || 'Ходовое';
    if (!groups.includes(name)) groups.push(name);
  }
  if (!groups.includes(quickGroup)) quickGroup = groups[0];

  tabs.innerHTML = groups.map((name) =>
    `<button data-g="${escapeHtml(name)}" class="${name === quickGroup ? 'on' : ''}">${escapeHtml(name)}</button>`).join('');
  tabs.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { quickGroup = b.dataset.g; drawQuick(); };
  });

  const inGroup = items.filter((g) => (g.quickGroup || 'Ходовое') === quickGroup);
  grid.innerHTML = inGroup.map((g) =>
    `<button class="qtile" data-i="${catalog.indexOf(g)}">
       <span class="qn">${escapeHtml(g.name)}</span><span class="qp">${money(g.price)}</span></button>`).join('');
  grid.querySelectorAll('.qtile').forEach((b) => {
    b.onclick = () => addToCart(catalog[Number(b.dataset.i)]);
  });
}

function drawGoods(q) {
  const list = q
    ? catalog.filter((g) => g.name.toLowerCase().includes(q.toLowerCase())
        || (g.barcodes || []).some((b) => String(b).includes(q)))
    : catalog;
  $('goods').innerHTML = list.slice(0, 60).map((g, i) =>
    `<button class="good" data-i="${catalog.indexOf(g)}">
       <span>${escapeHtml(g.name)}</span><b>${money(g.price)}</b></button>`).join('')
    || '<p class="muted">Товаров нет. Заведите их в кабинете и нажмите «Смена» → обновить каталог.</p>';
  $('goods').querySelectorAll('.good').forEach((b) => {
    b.onclick = () => addToCart(catalog[Number(b.dataset.i)]);
  });
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function addToCart(g) {
  if (!g) return;
  const line = cart.find((l) => l.productId === g.id);
  if (line) line.qty += 1;
  else cart.push({ productId: g.id, name: g.name, price: g.price, qty: 1 });
  drawCart();
}
let voids = 0;      // отмен позиций за смену
let discounts = 0;  // скидок за смену

function drawVoids() {
  const el = $('voidLabel');
  if (!el) return;
  const parts = [];
  if (voids) parts.push('отмен: ' + voids);
  if (discounts) parts.push('скидок: ' + discounts);
  el.textContent = parts.join(' · ');
  el.classList.toggle('hidden', parts.length === 0);
}

function drawCart() {
  drawQuick();
  $('cart').innerHTML = cart.map((l, i) => {
    const sum = l.price * l.qty - (l.discount || 0);
    return `
    <div class="line">
      <div class="nm">${escapeHtml(l.name)}${
        l.discount ? `<span class="disc">−${money(l.discount)}</span>` : ''}${
        l.free ? '<span class="free-mark">без карточки</span>' : ''}${
        l.priceChanged ? '<span class="price-mark">цена изменена</span>' : ''}</div>
      <div class="qty">
        <button data-m="${i}">−</button><span>${l.qty}</span><button data-p="${i}">+</button>
      </div>
      <div class="sum">${money(sum)}</div>
      <button class="del" data-pr="${i}" title="Изменить цену">₸</button>
      <button class="del" data-s="${i}" title="Скидка на позицию">%</button>
      <button class="del" data-d="${i}" title="Убрать позицию">✕</button>
    </div>`; }).join('') || '<p class="muted">Чек пуст. Выберите товар слева.</p>';
  $('cart').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.p != null) cart[b.dataset.p].qty += 1;
      if (b.dataset.m != null) { const l = cart[b.dataset.m]; l.qty -= 1; if (l.qty <= 0) cart.splice(b.dataset.m, 1); }
      if (b.dataset.d != null) {
        // Первое касание взводит, второе убирает. Окна нет — очередь ждёт, —
        // но случайно смахнуть позицию локтем уже нельзя.
        if (!b.classList.contains('armed')) {
          b.classList.add('armed');
          b.textContent = 'Убрать?';
          setTimeout(() => { b.classList.remove('armed'); b.textContent = '✕'; }, 3000);
          return;
        }
        cart.splice(b.dataset.d, 1);
        voids += 1; drawVoids();
      }
      if (b.dataset.pr != null) {
        // ИЗМЕНЕНИЕ ЦЕНЫ. Разрешено только вверх, если владелец включил
        // запрет на снижение: снижение цены на кассе — самый тихий способ
        // отдать товар «своим» дешевле, и в отчётах это выглядит как
        // обычная продажа.
        const l = cart[b.dataset.pr];
        const base = catalog.find((g) => g.id === l.productId)?.price ?? l.price;
        const v = prompt(`Цена «${l.name}»${SET.noPriceDown ? ' (снижать нельзя)' : ''}:`, String(l.price));
        if (v !== null) {
          const np = Number(v) || 0;
          if (np <= 0) return;
          if (SET.noPriceDown && np < base) { alert(`Снижать цену нельзя. В карточке ${money(base)}`); return; }
          l.price = np; l.priceChanged = np !== base;
        }
      }
      if (b.dataset.s != null) {
        // Скидка на позицию действует только в этом чеке — как у UMAG.
        const l = cart[b.dataset.s];
        const max = l.price * l.qty;
        const v = prompt(`Скидка на «${l.name}» в тенге (не больше ${max}):`, String(l.discount || 0));
        if (v !== null) {
          const d = Math.max(0, Math.min(Number(v) || 0, max));
          if (d > 0 && d !== (l.discount || 0)) { discounts += 1; drawVoids(); }
          l.discount = d;
        }
      }
      drawCart();
    };
  });
  const total = cart.reduce((s, l) => s + l.price * l.qty - (l.discount || 0), 0);
  $('cartCount').textContent = cart.reduce((s, l) => s + l.qty, 0);
  $('cartTotal').textContent = money(total);
  $('btnPay').disabled = cart.length === 0;
}
$('btnClear').onclick = () => { cart = []; drawCart(); };

/**
 * ОТЛОЖЕННЫЕ ЧЕКИ. В магазине это происходит каждый день: покупатель
 * забыл кошелёк, побежал к машине, а за ним очередь. Без отложенного
 * чека кассир либо держит очередь, либо теряет набранную корзину.
 *
 * Откладываем на диск, а не в память: касса может закрыться или
 * зависнуть, а покупатель вернётся.
 */
$('btnPark').onclick = async () => {
  if (!cart.length) return;
  const parked = (await K.getState()).data.parked || [];
  parked.push({ id: uuid(), at: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                items: cart, total: cart.reduce((s, l) => s + l.price * l.qty - (l.discount || 0), 0) });
  S = (await K.saveState({ parked })).data;
  // Наличные в кассе: пришли деньги — прибавилось, дали сдачу — убавилось.
  // Считаем на месте, чтобы кассир видел остаток сразу, без связи.
  if (receipt.hasCash) {
    const got = (way === 'cash' ? cash : cash) - (receipt.change || 0);
    S = (await K.saveState({ cashInDrawer: (S.cashInDrawer || 0) + got })).data;
  }
  drawTop();
  cart = []; drawCart(); updateParkedCount();
};

$('btnParked').onclick = async () => {
  const parked = (await K.getState()).data.parked || [];
  openModal(`<h2>Отложенные чеки</h2>
    <div class="reclist">${parked.map((p) => `
      <button data-id="${p.id}">${p.at} · ${p.items.length} поз. · <b>${money(p.total)}</b></button>`).join('')
      || '<p class="muted">Отложенных чеков нет.</p>'}</div>
    <div class="modal-actions">
      <button id="noReceipt">Возврат без чека</button>
      <button id="c">Закрыть</button>
    </div>`);

  // ВОЗВРАТ БЕЗ ЧЕКА. Покупатель потерял чек — обычное дело, и отказывать
  // ему нельзя. Но это же и способ вынуть деньги из кассы «на возврат»
  // несуществующей покупки, поэтому: причина обязательна, и операция
  // попадает в счётчик отмен, который видят сменщик и владелец.
  $('noReceipt').onclick = () => {
    openModal(`
      <h2>Возврат без чека</h2>
      <p class="muted">Покупатель не может показать чек. Операция попадёт в отчёт владельцу.</p>
      <label>Что возвращают</label>
      <input id="nrName" placeholder="напр. Молоко Айран 1л">
      <label>Сумма к возврату</label>
      <input id="nrSum" inputmode="numeric" value="">
      <label>Причина</label>
      <input id="nrNote" placeholder="напр. брак, покупатель потерял чек">
      <div class="err" id="nrErr"></div>
      <div class="modal-actions">
        <button id="nrCancel">Отмена</button>
        <button id="nrOk" class="primary big">Вернуть деньги</button>
      </div>`);
    $('nrCancel').onclick = closeModal;
    $('nrOk').onclick = async () => {
      const name = $('nrName').value.trim(), sum = Number($('nrSum').value || 0), note = $('nrNote').value.trim();
      if (!name || sum <= 0 || !note) { $('nrErr').textContent = 'Заполните всё: без причины возврат не проводим'; return; }
      const ref = { id: uuid(), number: (S.lastNumber || 0) + 1, date: new Date().toLocaleString('ru-RU'),
        store: S.store?.name || 'Магазин', cashier: S.employee?.name || '',
        items: [{ productId: null, name, qty: 1, price: sum, total: sum, free: true }],
        total: sum, isRefund: true, noReceipt: true, comment: note,
        payments: [{ label: 'Наличные', sum }], hasCash: true };
      await K.receiptAdd(ref);
      await K.outboxAdd({ id: ref.id, entity: 'sale', entityId: ref.id, op: 'insert', payload: ref });
      voids++;                                  // в счётчик отмен — это след
      S = (await K.saveState({ lastNumber: ref.number, cashInDrawer: (S.cashInDrawer || 0) - sum })).data;
      await K.print(ref);
      closeModal(); updatePending(); drawTop(); trySync();
    };
  };
  $('c').onclick = closeModal;
  document.querySelectorAll('.reclist button').forEach((b) => b.onclick = async () => {
    const p = parked.find((x) => x.id === b.dataset.id);
    if (cart.length && !confirm('Текущий чек будет заменён. Продолжить?')) return;
    cart = p.items;
    S = (await K.saveState({ parked: parked.filter((x) => x.id !== p.id) })).data;
    closeModal(); drawCart(); updateParkedCount();
  });
};

async function updateParkedCount() {
  const n = ((await K.getState()).data.parked || []).length;
  $('btnParked').textContent = n ? `Отложенные (${n})` : 'Отложенные';
}

// ── Оплата ───────────────────────────────────────────────────────────
$('btnPay').onclick = () => {
  const total = cart.reduce((s, l) => s + l.price * l.qty, 0);
  openModal(`
    <h2>К оплате<span class="amount">${money(total)}</span></h2>
    <div class="pay-tabs">
      <button data-w="cash" class="on">Наличные</button>
      <button data-w="card">Карта</button>
      <button data-w="mixed">Смешанно</button>
      <button data-w="credit">В долг</button>
    </div>
    <div id="payBody"></div>
    <div class="err" id="payErr"></div>
    <div class="modal-actions">
      <button id="payCancel">Отмена</button>
      <button id="payDo" class="primary big">ПРОБИТЬ ЧЕК</button>
    </div>`);
  let way = 'cash';
  const body = $('payBody');
  const render = () => {
    if (way === 'cash') body.innerHTML = `<label>Получено наличными</label>
      <input id="pCash" inputmode="numeric" value="${total}"><div id="change" class="change"></div>`;
    else if (way === 'card') body.innerHTML = `<p class="muted">Проведите картой на терминале, затем нажмите «Пробить чек».</p>`;
    else if (way === 'mixed') body.innerHTML = `<label>Наличными</label><input id="pCash" inputmode="numeric" value="0">
      <label>Картой</label><input id="pCard" inputmode="numeric" value="${total}">`;
    else {
      // В ДОЛГ. Отпустить под запись можно только известному покупателю:
      // «долг Марату» без карточки клиента — это потерянные деньги, их
      // некому предъявить. Поэтому выбор обязателен.
      body.innerHTML = `<label>Кому в долг</label>
        <select id="pDebtor"><option value="">— выберите покупателя —</option>${
          (S.customers || []).map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${
            c.debt ? ` · уже должен ${money(c.debt)}` : ''}</option>`).join('')
        }</select>
        <p class="muted">Долг попадёт в карточку покупателя. Владелец увидит его в разделе «Контрагенты».</p>`;
    }
    const c = $('pCash');
    if (c) c.oninput = () => {
      const got = Number(c.value || 0);
      if ($('change')) $('change').textContent = got > total ? 'Сдача ' + money(got - total) : '';
    };
  };
  render();
  document.querySelectorAll('.pay-tabs button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.pay-tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); way = b.dataset.w; render();
  });
  $('payCancel').onclick = closeModal;
  $('payDo').onclick = () => finishSale(way, total);
};

async function finishSale(way, total) {
  const cash = Number($('pCash')?.value || 0);
  const card = way === 'card' ? total : Number($('pCard')?.value || 0);

  // В долг: деньги сейчас не приходят, приходит обязательство.
  let debtorId = null, debtorName = '';
  if (way === 'credit') {
    debtorId = $('pDebtor')?.value || '';
    if (!debtorId) { $('payErr').textContent = 'Выберите покупателя — долг должен быть на кого-то записан'; return; }
    debtorName = $('pDebtor').selectedOptions[0]?.textContent?.split(' · ')[0] ?? '';
  } else {
    const paid = (way === 'cash' ? cash : way === 'card' ? total : cash + card);
    if (paid < total) { $('payErr').textContent = 'Оплачено меньше суммы чека'; return; }
  }

  const receipt = {
    id: uuid(),
    number: (S.lastNumber || 0) + 1,
    date: new Date().toLocaleString('ru-RU'),
    store: S.store?.name || 'Магазин',
    cashier: S.employee?.name || '',
    items: cart.map((l) => ({ ...l, discount: l.discount || 0, total: l.price * l.qty - (l.discount || 0) })),
    discount: cart.reduce((a, l) => a + (l.discount || 0), 0),
    total,
    payments: way === 'cash' ? [{ label: 'Наличные', sum: cash }]
      : way === 'card' ? [{ label: 'Карта', sum: total }]
      : way === 'credit' ? [{ label: 'В долг: ' + debtorName, sum: total }]
      : [{ label: 'Наличные', sum: cash }, { label: 'Карта', sum: card }],
    customerId: debtorId || undefined,
    payment: way === 'credit' ? { credit: total } : undefined,
    change: (way === 'card' || way === 'credit') ? 0
      : Math.max(0, (way === 'cash' ? cash : cash + card) - total),
    // Ящик открываем только когда пришли наличные: при карте и долге
    // денег в кассе не прибавилось, и открывать его незачем.
    hasCash: way === 'cash' || way === 'mixed',
  };

  // 1) Сначала сохраняем на диск — чек не должен зависеть от сети и печати.
  await K.receiptAdd(receipt);
  await K.outboxAdd({ id: receipt.id, entity: 'sale', entityId: receipt.id, op: 'insert', payload: receipt });
  S = (await K.saveState({ lastNumber: receipt.number })).data;

  // 2) Печатаем. Ошибка печати не отменяет продажу — деньги уже приняты.
  const p = await K.print(receipt);
  closeModal();
  cart = []; drawCart(); updatePending();
  if (!p.ok) alert('Чек сохранён, но не напечатался:\n' + p.error);
  trySync();
}

function openModal(html) { $('modalBody').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); }

// ── Смена ────────────────────────────────────────────────────────────
$('btnShift').onclick = () => {
  if (!S.shift) {
    openModal(`<h2>Открыть смену</h2>
      <label>Размен в кассе</label><input id="float" inputmode="numeric" value="0">
      <div class="modal-actions"><button id="c">Отмена</button>
      <button id="ok" class="primary big">Открыть</button></div>`);
    $('c').onclick = closeModal;
    $('ok').onclick = async () => {
      const shift = { id: uuid(), openedAt: new Date().toISOString(), openingFloat: Number($('float').value || 0) };
      await K.outboxAdd({ id: shift.id, entity: 'shift', entityId: shift.id, op: 'insert', payload: shift });
      // Размен — это стартовые наличные в ящике, а не «просто число».
      S = (await K.saveState({ shift, cashInDrawer: shift.openingFloat })).data;
      drawTop();
      closeModal(); updatePending(); trySync();
    };
  } else {
    openModal(`<h2>Закрыть смену</h2>
      <p class="muted">Пересчитайте наличные в ящике и впишите, сколько насчитали.</p>
      <div class="expected">По расчёту должно быть: <b>${money(S.cashInDrawer || 0)}</b></div>
      <label>Фактически насчитал</label><input id="fact" inputmode="numeric" value="">
      <div id="diff" class="diff"></div>
      <div class="modal-actions"><button id="c">Отмена</button>
      <button id="ok" class="primary big">Закрыть смену</button></div>`);
    $('c').onclick = closeModal;
    // Расхождение показываем ДО подтверждения: кассир пересчитает сейчас,
    // а не будет объясняться завтра. Это ради него, а не против него.
    $('fact').oninput = () => {
      const fact = Number($('fact').value || 0);
      const must = S.cashInDrawer || 0;
      const d = fact - must;
      $('diff').innerHTML = !$('fact').value ? ''
        : d === 0 ? '<span class="ok">Сходится</span>'
        : d > 0 ? `<span class="warn">Излишек ${money(d)}</span>`
        : `<span class="bad">Не хватает ${money(-d)}</span>`;
    };
    $('ok').onclick = async () => {
      const close = { id: uuid(), shiftId: S.shift.id, closedAt: new Date().toISOString(), factCash: Number($('fact').value || 0) };
      await K.outboxAdd({ id: close.id, entity: 'shift_close', entityId: S.shift.id, op: 'update', payload: close });
      S = (await K.saveState({ shift: null, cashInDrawer: 0 })).data;
      voids = 0;                       // счётчик отмен — на каждую смену свой
      drawTop();
      closeModal(); updatePending(); trySync();
    };
  }
};

/**
 * ДЕНЬГИ В КАССЕ: внести, изъять, сдать выручку.
 *
 * Без этого касса не сходится физически. Утром разменяли — деньги
 * пришли не от продажи. Вечером сдали выручку — ушли не покупателю.
 * Если этого нет, расчётный остаток и настоящий расходятся с первого
 * дня, и владелец видит недостачу там, где её нет.
 *
 * Три вида: внести, изъять, сдать выручку (инкассация). Разделены не
 * ради красоты — в отчёте по смене они считаются по-разному: изъятие
 * это расход, инкассация это передача денег дальше.
 */
/**
 * ТОВАР БЕЗ КАРТОЧКИ — пробить по цене.
 *
 * Каждый день: привезли что-то новое, товар ещё не заведён, а покупатель
 * стоит. Без этого кассир либо не продаёт, либо пробивает под чужим
 * товаром — и остатки разъезжаются молча. Второе хуже.
 *
 * Помечаем такую позицию отдельно: владелец увидит в отчёте, что
 * продавали без карточки, и заведёт товар.
 */
$('btnFree').onclick = () => {
  openModal(`
    <h2>Товар без карточки</h2>
    <p class="muted">Для товара, который ещё не заведён. Владелец увидит это в отчёте.</p>
    <label>Название</label>
    <input id="freeName" placeholder="напр. Арбуз весовой">
    <label>Цена</label>
    <input id="freeSum" inputmode="numeric" value="">
    <div class="err" id="freeErr"></div>
    <div class="modal-actions">
      <button id="freeCancel">Отмена</button>
      <button id="freeOk" class="primary big">Добавить в чек</button>
    </div>`);
  $('freeCancel').onclick = closeModal;
  $('freeOk').onclick = () => {
    const name = $('freeName').value.trim();
    const price = Number($('freeSum').value || 0);
    if (!name) { $('freeErr').textContent = 'Напишите название — иначе в отчёте будет непонятно, что продали'; return; }
    if (price <= 0) { $('freeErr').textContent = 'Введите цену'; return; }
    cart.push({ productId: null, name, price, qty: 1, free: true });
    closeModal(); drawCart();
  };
};

/**
 * ПРОВЕРКА ЦЕНЫ без продажи.
 *
 * Покупатель спрашивает «сколько стоит» — кассир не должен для этого
 * начинать чек и потом его отменять. Отменённый чек это след, который
 * потом объясняй.
 */
$('btnPrice').onclick = () => {
  openModal(`
    <h2>Проверка цены</h2>
    <p class="muted">Отсканируйте товар или введите штрихкод. Чек не начинается.</p>
    <input id="priceCode" inputmode="numeric" placeholder="Штрихкод" autofocus>
    <div id="priceResult" class="price-result"></div>
    <div class="modal-actions"><button id="priceClose" class="primary big">Закрыть</button></div>`);
  $('priceClose').onclick = closeModal;
  const check = () => {
    const q = $('priceCode').value.trim();
    if (!q) return;
    const g = catalog.find((x) => (x.barcodes || []).includes(q))
      ?? catalog.find((x) => x.name.toLowerCase().includes(q.toLowerCase()));
    $('priceResult').innerHTML = g
      ? `<div class="pr-name">${escapeHtml(g.name)}</div><div class="pr-price">${money(g.price)}</div>`
      : `<div class="pr-none">Товар не найден</div>`;
  };
  $('priceCode').oninput = check;
  $('priceCode').onkeydown = (e) => { if (e.key === 'Enter') { check(); e.target.select(); } };
  setTimeout(() => $('priceCode')?.focus(), 50);
};

$('btnCash').onclick = () => {
  if (!S.shift) { alert('Сначала откройте смену'); return; }
  openModal(`
    <h2>Деньги в кассе</h2>
    <div class="cash-kinds">
      <button data-k="deposit" class="on">Внести</button>
      <button data-k="withdrawal">Изъять</button>
      <button data-k="collection">Сдать выручку</button>
    </div>
    <label>Сумма</label>
    <input id="cashSum" inputmode="numeric" value="">
    <label>Причина <span class="muted">(увидит владелец в отчёте)</span></label>
    <input id="cashNote" placeholder="напр. размен, оплата поставщику">
    <div class="err" id="cashErr"></div>
    <div class="modal-actions">
      <button id="cashCancel">Отмена</button>
      <button id="cashOk" class="primary big">Провести</button>
    </div>`);

  let kind = 'deposit';
  const hints = {
    deposit: 'напр. размен, доложили из сейфа',
    withdrawal: 'напр. оплата поставщику, хозрасходы',
    collection: 'напр. сдал старшему смены',
  };
  document.querySelectorAll('.cash-kinds button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.cash-kinds button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); kind = b.dataset.k;
    $('cashNote').placeholder = hints[kind];
  });

  $('cashCancel').onclick = closeModal;
  $('cashOk').onclick = async () => {
    const sum = Number($('cashSum').value || 0);
    if (sum <= 0) { $('cashErr').textContent = 'Введите сумму больше нуля'; return; }
    // Причину требуем у изъятия и инкассации: деньги уходят из кассы, и
    // владелец должен видеть, куда. У внесения не требуем — там очевидно.
    const note = $('cashNote').value.trim();
    if (kind !== 'deposit' && !note) { $('cashErr').textContent = 'Напишите причину — её увидит владелец'; return; }

    const op = { id: uuid(), shiftId: S.shift.id, kind, amount: sum, comment: note || null };
    await K.outboxAdd({ id: op.id, entity: 'cash_operation', entityId: op.id, op: 'insert', payload: op });
    // Считаем наличные в кассе прямо здесь: кассир должен видеть остаток
    // сразу, а не после связи с сервером.
    const delta = kind === 'deposit' ? sum : -sum;
    S = (await K.saveState({ cashInDrawer: (S.cashInDrawer || 0) + delta })).data;
    closeModal(); updatePending(); drawTop(); trySync();
  };
};

$('btnLogout').onclick = async () => { S = (await K.saveState({ employee: null })).data; openPin(); };

// ── Возврат ──────────────────────────────────────────────────────────
$('btnRefund').onclick = async () => {
  const list = (await K.receiptsRecent(30)).data || [];
  openModal(`<h2>Возврат</h2>
    <p class="muted">Выберите чек для возврата.</p>
    <div class="reclist">${list.map((r) => `
      <button data-id="${r.id}">№${r.number} · ${r.date} · <b>${money(r.total)}</b></button>`).join('')
      || '<p class="muted">Чеков пока нет.</p>'}</div>
    <div class="modal-actions"><button id="c">Закрыть</button></div>`);
  $('c').onclick = closeModal;
  document.querySelectorAll('.reclist button').forEach((b) => b.onclick = async () => {
    const r = list.find((x) => x.id === b.dataset.id);
    if (!confirm(`Вернуть чек №${r.number} на ${money(r.total)}?`)) return;
    const ref = { ...r, id: uuid(), isRefund: true, refundOf: r.id, date: new Date().toLocaleString('ru-RU') };
    await K.receiptAdd(ref);
    await K.outboxAdd({ id: ref.id, entity: 'sale', entityId: ref.id, op: 'insert', payload: ref });
    await K.print(ref);
    closeModal(); updatePending(); trySync();
  });
};

// ── Обмен с сервером ─────────────────────────────────────────────────
async function pullCatalog() {
  const d = await api('/pos/goods/catalog');
  // Сервер отдаёт { products, categories, serverSeq }. У товара цена в
  // поле price, а штрихкодов может быть несколько — берём все, чтобы
  // сканер находил товар по любому из них.
  const items = (d.products || []).map((g) => ({
    id: g.id, name: g.name, price: Number(g.price ?? 0),
    barcodes: Array.isArray(g.barcodes) ? g.barcodes.map((b) => (b.code ?? b)) : [],
    // Быстрые товары: сервер отдаёт is_quick и quick_group, но раньше
    // касса их выбрасывала при разборе — поля до плиток не доходили.
    quick: !!g.is_quick,
    quickGroup: g.quick_group ?? null,
  }));
  if (items.length) { catalog = items; await K.saveCatalog(items); }
}

async function trySync() {
  const pending = (await K.outboxPending()).data || [];
  if (!pending.length) { setDot(true); return; }
  try {
    const events = pending.map((e) => ({
      id: e.id, entity: e.entity, entityId: e.entityId, op: e.op,
      payload: e.payload, clientSeq: e.clientSeq, clientTs: e.clientTs,
      employeeId: S.employee?.id,
    }));
    const r = await api('/sync/push', { method: 'POST', body: { events } });
    const done = (r.results || []).filter((x) => x.result !== 'error').map((x) => x.id);
    if (done.length) await K.outboxAck(done);
    setDot(true);
  } catch { setDot(false); }
  updatePending();
}
function syncLoop() { trySync(); setInterval(trySync, 30000); }
async function updatePending() {
  const n = ((await K.outboxPending()).data || []).length;
  $('pendingLabel').textContent = n ? `не отправлено: ${n}` : '';
  $('pendingLabel').classList.toggle('warn', n > 0);
  // Номер текущего чека: кассир называет его при возврате и при разборе
  // расхождений, и искать его в бумажной ленте — время при покупателях.
  const rc = $('receiptLabel');
  if (rc) rc.textContent = S.lastNumber ? 'Чек №' + S.lastNumber : '';
}
function setDot(ok) { $('syncDot').className = 'dot ' + (ok ? 'ok' : 'bad'); }

/* ═══════════════════════════════════════════════════════════════════
   ЭКРАННАЯ КЛАВИАТУРА (цифровая)

   Зачем: на кассовом планшете системной клавиатуры может не быть вовсе.
   Тогда кассир физически не может ввести сумму размена или пересчитать
   кассу при закрытии смены — работа встаёт.

   Урок соседнего проекта, слово в слово: у них один экран подключил
   клавиатуру, но ЗАБЫЛ ЕЁ ОТРИСОВАТЬ — поле молча не принимало ввод,
   и кассир не мог закрыть смену. Поэтому здесь клавиатура появляется
   САМА на любом числовом поле, а не подключается вручную к каждому.
   Забыть невозможно: нечего забывать.
   ═══════════════════════════════════════════════════════════════════ */
(function numericKeypad() {
  let pad = null, target = null;

  const build = () => {
    pad = document.createElement('div');
    pad.className = 'keypad-float';
    pad.innerHTML = ['7','8','9','4','5','6','1','2','3','0','000','←']
      .map((k) => `<button data-k="${k}">${k}</button>`).join('') +
      '<button class="kp-done" data-k="ok">Готово</button>';
    document.body.appendChild(pad);
    pad.addEventListener('mousedown', (e) => e.preventDefault());  // не терять фокус поля
    pad.addEventListener('click', (e) => {
      const k = e.target?.dataset?.k;
      if (!k || !target) return;
      if (k === 'ok') { hide(); return; }
      if (k === '←') target.value = String(target.value).slice(0, -1);
      else target.value = String(target.value) + k;
      // Сообщаем полю, что значение изменилось: иначе расчёт сдачи не
      // пересчитается — он слушает обычный ввод.
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const show = (el) => {
    if (!pad) build();
    target = el;
    pad.classList.add('on');
  };
  const hide = () => { pad?.classList.remove('on'); target = null; };

  // Ловим фокус на всех числовых полях — включая те, что появятся позже
  // (окна оплаты и смены создаются на лету).
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el?.tagName === 'INPUT' && el.getAttribute('inputmode') === 'numeric') show(el);
    else if (!el?.closest?.('.keypad-float')) hide();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.keypad-float') && e.target.getAttribute?.('inputmode') !== 'numeric') hide();
  });
})();
