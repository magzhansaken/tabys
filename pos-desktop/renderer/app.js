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
 *
 * ─── Раскладка v2 («цифровая полоса») ───────────────────────────────
 * Изменено только то, что видно: три колонки вместо двух, постоянная
 * клавиатура справа, оплата на месте вместо окна, всё редкое — листом
 * снизу, категории слиты с каталогом.
 *
 * Считающее не тронуто: обращения к системе (window.kassa.*), формулы
 * сумм, скидок и сдачи, порядок сохранения чека и очередь отправки — те
 * же. finishSale читает те же пять полей: pCash, pCard, pBonusCust,
 * pBonusSum, payErr.
 */
const K = window.kassa;

// Откуда лежит сам app.js: дисплей покупателя открывается рядом с ним, а не
// рядом с документом. Иначе при запуске из просмотра (заглушка лежит выше
// папки renderer) кнопка «Дисплей покупателя» уходит не туда.
const APP_BASE = (document.currentScript && document.currentScript.src) || location.href;

const $ = (id) => document.getElementById(id);
const show = (id) => {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
  $(id).classList.remove('hidden');
};
const money = (n) => {
  const v = Number(n || 0);
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  // Разряды пробелом, копейки запятой: весовой товар даёт дробные тенге,
  // и «586.50» через точку на кассе читается как чужое. Значение то же.
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ').replace('.', ',') + ' ₸';
};
const qtyStr = (q) => (Number(q) % 1 ? Number(q).toFixed(3).replace('.', ',') : String(q));
/* ULID вместо случайного ключа — часть 1 разбора их кассы.
 *
 * Их первая строка объясняет зачем: «идентификаторы — ULID, повторная
 * отправка безопасна». ULID растёт по времени: первые десять знаков —
 * метка времени, остальные случайны.
 *
 * Что это даёт кассе. При разборе спорного дня чеки в журнале лягут ПО
 * ПОРЯДКУ сами. Со случайным ключом они идут вперемешку, и «какой чек
 * был раньше» видно только по отдельному полю времени — а его могут и
 * не вывести в выгрузке.
 *
 * Буквы I, L, O, U выброшены нарочно: их путают с 1, 0 и V, когда код
 * диктуют по телефону при разборе. */
const ULID_ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let ulidLastMs = 0;
let ulidSeq = 0;
const uuid = () => {
  // ПОРЯДОК ВНУТРИ ОДНОЙ МИЛЛИСЕКУНДЫ. Касса создаёт ключи подряд
  // быстрее, чем тикают часы: метка времени одинаковая, и дальше
  // порядок решал бы случай. Считаем сами — тогда ключи идут строго
  // один за другим, ради чего ULID и берут.
  const now = Date.now();
  if (now === ulidLastMs) ulidSeq += 1;
  else { ulidLastMs = now; ulidSeq = 0; }

  let t = now;
  let time = '';
  for (let i = 0; i < 10; i += 1) { time = ULID_ABC[t % 32] + time; t = Math.floor(t / 32); }

  // Счётчик четырьмя знаками: миллион чеков в одну миллисекунду касса
  // не пробьёт, а порядок держится.
  let q = ulidSeq;
  let seq = '';
  for (let i = 0; i < 4; i += 1) { seq = ULID_ABC[q % 32] + seq; q = Math.floor(q / 32); }

  let rnd = '';
  for (let i = 0; i < 12; i += 1) rnd += ULID_ABC[Math.floor(Math.random() * 32)];
  return time + seq + rnd;
};

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

  // Права и настройки скидок приходят с сервера. Если связи нет —
  // работаем по последним известным: касса не должна вставать из-за
  // того, что не смогла спросить разрешения.
  try {
    const r = await K.posSettings();
    if (r.ok && r.data) {
      const p = r.data;
      SET.actions = { act_refund: p.act_refund, act_refund_free: p.act_refund_free,
        act_remove_item: p.act_remove_item, act_reduce_qty: p.act_reduce_qty,
        act_discount: p.act_discount, act_price_change: p.act_price_change,
        act_cash_out: p.act_cash_out };
      SET.discountAllowed = p.discount_allowed;
      SET.discountMaxPct = Number(p.discount_max_pct ?? 100);
      SET.noPriceDown = p.no_price_down;
      SET.receiptHeader = p.receipt_header;
      SET.receiptFooter = p.receipt_footer;
      SET.printMode = p.receipt_print_mode || 'always';
      // Состояние подписки приходит тем же ответом. Показываем сразу:
      // владелец должен узнать про срок от кассы, а не когда смена
      // встала посреди рабочего дня.
      SET.lock = p.lock || null;
      drawLock();
      await K.saveSettings(SET);
    }
  } catch { /* нет связи — работаем по сохранённым */ }
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
/* ПРОПУСКА КАССЫ — по образцу донора, вместе с их доводом:
 *
 *   «Интернет в зале пропадает, смена — нет. При каждой УСПЕШНОЙ
 *    онлайн-проверке касса оставляет себе пропуск — не сам код, а его
 *    след, посоленный ключом устройства. Подобрать код по следу
 *    нельзя, унести след на другую кассу бессмысленно: соль другая.»
 *
 * Моя прошлая правка помнила ОДНОГО последнего кассира — сменщик войти
 * не мог. А кассиры работают сменами: утренний ушёл, вечерний сел, и
 * без сети он должен войти ПОД СВОИМ именем, а не под чужим.
 *
 * Теперь склад: по пропуску на каждого, кто входил на этой кассе.
 */
const PASS_KEY = 'tabys.pinPasses';

/* След кода: SHA-256 с солью устройства. Обратно не разворачивается,
   на другой кассе бесполезен — там соль своя. */
async function pinPrint(pin, deviceKey) {
  const raw = new TextEncoder().encode(String(pin) + '\u00b7' + String(deviceKey || ''));
  try {
    const dig = await crypto.subtle.digest('SHA-256', raw);
    return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Нет надёжной свёртки — берём простую. Хуже, но лучше, чем
    // пускать по любому коду.
    let h = 0;
    const src = String(pin) + '|' + String(deviceKey || '');
    for (let i = 0; i < src.length; i += 1) h = (h * 31 + src.charCodeAt(i)) | 0;
    return 'w' + h;
  }
}

function passesAll() {
  try { return JSON.parse(localStorage.getItem(PASS_KEY) || '{}'); }
  catch { return {}; }
}

/** Выписать пропуск после ЖИВОЙ проверки сервером. */
function passSave(print, pass) {
  try {
    const all = passesAll();
    all[print] = pass;
    localStorage.setItem(PASS_KEY, JSON.stringify(all));
  } catch { /* хранилище тесно — вход случился, просто без пропуска */ }
}

/** Найти пропуск по следу кода. */
function passRead(print) { return passesAll()[print] || null; }

/* Расставить слова выбранного языка по экрану.
 *
 * Ищем по признаку data-tt: так перевод не расползается по коду, а
 * лежит в одном месте — в словаре. Забыли слово в словаре — на экране
 * останется русское, а не пустое место. */
function applyLang() {
  if (typeof tt !== 'function') return;
  document.querySelectorAll('[data-tt]').forEach((el) => {
    el.textContent = tt(el.dataset.tt);
  });
}

async function tryPin() {
  const err = $('pinErr'); err.textContent = '';
  try {
    const d = await api('/pos/login', { method: 'POST', body: { pin } });
    const who = d.employee || d;
    S = (await K.saveState({ employee: who, shift: S.shift || null })).data;

    // ВЫПИСЫВАЕМ ПРОПУСК после живой проверки. Ключ — след кода,
    // значение — кто и с какими правами. Соль берём от устройства:
    // след с этой кассы на другой бесполезен.
    passSave(await pinPrint(pin, S.deviceToken || S.device?.id || ''), {
      employee: who,
      permissions: d.permissions || who.permissions || null,
      savedAt: new Date().toISOString(),
    });
    await pullCatalog().catch(() => {});
    openSale(); syncLoop();
  } catch (e) {
    // Офлайн-вход: если сервер недоступен, пускаем кассира, который уже
    // входил на этой кассе. Иначе пропажа интернета останавливает торговлю.
    if (/fetch|network|failed/i.test(e.message)) {
      // БЕЗ СЕТИ ВХОДИТ ЛЮБОЙ ИЗ РАБОТАВШИХ — под СВОИМ именем.
      //
      // Кассиры сменяются: утренний ушёл, вечерний сел. Пускать
      // только последнего значит заставить вечернего торговать под
      // именем утреннего — и все его чеки уйдут не на того.
      const pass = passRead(await pinPrint(pin, S.deviceToken || S.device?.id || ''));
      if (pass) {
        S = (await K.saveState({ employee: pass.employee })).data;
        openSale(); return;
      }
      // Незнакомый код — честный отказ. Пускать по любому коду хуже,
      // чем не пустить: в чеках окажется чужое имя.
      err.textContent = Object.keys(passesAll()).length
        ? 'Нет связи. Без интернета входит только тот, кто уже работал на этой кассе'
        : 'Нет связи, а на этой кассе ещё никто не входил — нужен интернет';
      pin = ''; drawPin(); return;
    }
    err.textContent = e.message; pin = ''; drawPin();
  }
}

// ── Экран 3: продажа ─────────────────────────────────────────────────
function openSale() {
  show('scr-sale');
  $('cashierLabel').textContent = S.employee?.name ? ' · ' + S.employee.name : '';

  // ЗАПЕРЕТЬ КАССУ — не закрывая смену. Смену закрывают отдельно, с
  // пересчётом денег: это разные дела. Заперли — вернулись к вводу
  // кода, и кто сядет следующим, тот и назовётся в чеках.
  // ЯЗЫК КАССЫ. Кнопка показывает, на КАКОЙ язык переключит, а не
  // какой стоит сейчас: так понятно, что будет по нажатию.
  const lang = $('langBtn');
  if (lang) {
    lang.textContent = typeof posLang === 'function' && posLang() === 'kk' ? 'РУС' : 'ҚАЗ';
    if (!lang.dataset.wired) {
      lang.dataset.wired = '1';
      lang.onclick = () => {
        setPosLang(posLang() === 'kk' ? 'ru' : 'kk');
        applyLang();
        drawTop();
      };
    }
  }

  // Вызов экранной клавиатуры для поиска товара.
  const kb = $('kbdBtn');
  if (kb && !kb.dataset.wired) {
    kb.dataset.wired = '1';
    kb.onclick = () => {
      const box = $('kbd');
      if (box && !box.classList.contains('hidden')) kbClose();
      else kbOpen($('search'));
    };
  }

  const lock = $('lockBtn');
  if (lock && !lock.dataset.wired) {
    lock.dataset.wired = '1';
    lock.onclick = () => {
      pin = '';
      show('scr-pin');
      drawPin();
      const e = $('pinErr');
      if (e) e.textContent = 'Касса заперта. Смена не закрыта — введите свой код';
    };
  }
  drawTop();
  // «Последний кассир» больше не нужен: вход без сети идёт по складу
  // пропусков, где каждый работавший лежит отдельно, со своим следом.
  drawCatalog(); drawCart(); updatePending(); updateParkedCount();
  drawPad(); focusScanner();
}

/**
 * Шапка: смена, наличные в кассе, неотправленные чеки, счётчик отмен.
 *
 * Наличные показываем прямо здесь: кассир должен видеть остаток, не
 * открывая ящик и не считая в уме. При закрытии смены он сверяет эту
 * цифру с тем, что насчитал руками — расхождение видно сразу, а не
 * через неделю в отчёте у владельца.
 */
/**
 * ПОЛОСА О ПОДПИСКЕ.
 *
 * За три дня — жёлтая: «оплатите заранее, чтобы смена не встала».
 * После срока — красная: продажи закрыты.
 *
 * ЗАКРЫТИЕ СМЕНЫ РАБОТАЕТ ВСЕГДА, даже когда продажи закрыты. В ящике
 * чужие деньги, они обязаны сойтись — что бы ни случилось с оплатой.
 * Это правило взято у соседнего проекта и оно не обсуждается.
 */
function drawLock() {
  const el = $('lockBar');
  if (!el) return;
  const l = SET.lock;
  if (!l) { el.className = 'lock-bar'; el.innerHTML = ''; return; }
  el.className = 'lock-bar on ' + (l.kind === 'block' ? 'bad' : 'warn');
  el.innerHTML = `<b>${escapeHtml(l.title)}</b><span>${escapeHtml(l.message)}</span>`;
  // Продажи закрываем, но кнопку смены не трогаем.
  if (l.kind === 'block') {
    const pay = $('btnPay'); if (pay) { pay.disabled = true; pay.title = l.title; }
  }
}

function drawTop() {
  // СТРАЖ ЗАБЫТОЙ СМЕНЫ — взят у донора вместе с их доводом:
  //
  //   «Автозакрытия в 06:00 нет и не будет: закрытие смены — это
  //    пересчёт живых денег в ящике, автомат его не сделает. Но если
  //    смена открыта до утренней границы, сегодняшние чеки поедут во
  //    вчерашнюю, и отчёты сольются.»
  //
  // Кассир ушёл домой, не закрыв смену. Утром сел другой и бьёт чеки —
  // они ложатся во вчерашний день. Владелец смотрит выручку за вчера и
  // видит чужие деньги, а за сегодня — пусто.
  //
  // Не запрещаем работать: очередь у кассы важнее отчёта. Но говорим
  // так, чтобы нельзя было не заметить.
  const shiftAge = (() => {
    if (!S.shift?.openedAt) return null;
    const opened = new Date(S.shift.openedAt);
    const border = new Date(); border.setHours(6, 0, 0, 0);
    // Смена открыта после утренней границы или сейчас ещё ночь —
    // всё в порядке, это обычная смена.
    if (opened >= border || Date.now() < border.getTime()) return null;
    return Math.floor((Date.now() - opened.getTime()) / 3600000);
  })();

  const stale = $('staleShift');
  if (stale) {
    stale.classList.toggle('hidden', shiftAge === null);
    if (shiftAge !== null) {
      stale.textContent = `⚠ Смена открыта ${shiftAge} ч — со вчера. `
        + 'Закройте её: сегодняшние чеки уходят во вчерашний день';
    }
  }

  $('shiftLabel').textContent = S.shift ? 'Смена открыта' : 'Смена не открыта';
  const el = $('cashLabel');
  if (el) {
    el.textContent = S.shift ? 'в кассе ' + money(S.cashInDrawer || 0) : '';
    el.className = S.shift ? 'cash-badge' : '';
  }
}

/**
 * Поиск — он же приёмник сканера: сканер «печатает» код и жмёт Enter.
 *
 * ВЕСОВОЙ ШТРИХКОД 22PPPPPWWWWWK. Весы печатают этикетку с кодом товара
 * и весом в граммах. Разбираем её здесь: 0,850 кг плюсами не набирают, а
 * руками вбивают с опечатками. Код товара сверяем с plu из каталога.
 */
$('search').oninput = (e) => { searchQuery = e.target.value; drawCatalog(); };
$('search').onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  // Код маркировки проверяем ПЕРВЫМ: он длинный и внутри него сидит
  // штрихкод товара. Если смотреть на него как на обычный штрихкод, товар
  // не найдётся и кассир решит, что марка не читается.
  if (isMarkCode(q)) { e.target.value = ''; searchQuery = ''; applyMark(q); drawCatalog(); return; }
  const w = weighedBarcode(q);
  const found = w ? w.good : catalog.find((g) => (g.barcodes || []).includes(q));
  e.target.value = ''; searchQuery = '';
  if (!found) { drawCatalog(); toast('Штрихкод не найден: ' + q, true); return; }
  addToCart(found, w ? w.qty : 1);
  drawCatalog();
  if (w) toast(found.name + ' · ' + qtyStr(w.qty) + ' кг с весов');
  else if (found.marked) toast(found.name + ' · теперь отсканируйте марку на упаковке');
};

/* ═══════════════════════════════════════════════════════════════════
   МАРКИРОВКА DATA MATRIX

   Закон, а не удобство: табак давно, пиво в бутылках и кегах с
   1 февраля 2026 продаются только со сканированием кода, и код должен
   уйти в чеке в ОФД. Штраф выпишут без жалобы покупателя: все чеки
   и так у КГД, и отсутствие кода видно без проверки.

   Код уникален на каждую штуку: две бутылки — два кода. Поэтому считаем
   не «отсканировано или нет», а сколько кодов собрано из нужных.

   Где мы лучше рынка: касса не заставляет сначала искать товар, а потом
   сканировать марку — в марке уже есть штрихкод, и одного сканирования
   достаточно: товар встаёт в чек и марка привязывается сразу.
   ═══════════════════════════════════════════════════════════════════ */

// В коде маркировки сначала идёт (01) штрихкод товара из 14 цифр, потом
// (21) серийный номер штуки. Обычный штрихкод короче и так не начинается.
function isMarkCode(s) { return /^01\d{14}/.test(s) && s.length >= 20; }
function markGtin(code) { return code.slice(2, 16).replace(/^0+/, ''); }
const needMarks = (l) => (l.marked ? Math.max(0, Math.ceil(l.qty) - (l.codes || []).length) : 0);
const marksMissing = () => cart.reduce((a, l) => a + needMarks(l), 0);

function applyMark(code) {
  // Одну и ту же марку в чек дважды не пускаем: это либо второе
  // касание сканера, либо две одинаковые марки на полке. Оба случая
  // нельзя пропускать в чек.
  if (cart.some((l) => (l.codes || []).includes(code))) { toast('Эта марка уже в чеке — сканируйте следующую штуку', true); return; }
  const gtin = markGtin(code);
  const fits = (l) => l.marked && needMarks(l) > 0 && (l.barcodes || []).some((b) => String(b) === gtin);
  let line = cart.find(fits);
  if (!line) {
    const g = catalog.find((x) => (x.barcodes || []).some((b) => String(b) === gtin));
    if (!g) { toast('Марка от товара, которого нет в каталоге', true); return; }
    // Марка есть, товара в чеке нет — добавляем сами: кассир сканирует
    // пачку один раз, а не ищет её ещё и в каталоге.
    addToCart(g);
    line = cart.filter(fits).pop() || cart[cart.length - 1];
  }
  line.codes = (line.codes || []).concat(code);
  selLine = line;
  drawCart();
  const left = marksMissing();
  toast(left ? 'Марка принята · осталось отсканировать: ' + left : 'Марки собраны — можно к оплате');
}

function drawMarkBar() {
  const bar = $('markBar');
  if (!bar) return;
  const need = marksMissing();
  const has = cart.some((l) => l.marked);
  if (!has) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.classList.toggle('ok', need === 0);
  bar.innerHTML = need
    ? `<b>Нужно марок: ${need}</b><small>Отсканируйте Data Matrix на каждой штуке — без кода чек нельзя</small>`
    : `<b>Марки собраны</b><small>Коды уйдут в чеке и выведут товар из оборота</small>`;
}

function weighedBarcode(code) {
  if (!/^22\d{10,11}$/.test(code)) return null;
  const plu = String(Number(code.slice(2, 7)));
  const grams = Number(code.slice(7, 12));
  if (!grams) return null;
  const good = catalog.find((g) => String(g.plu ?? '') === plu);
  return good ? { good, qty: grams / 1000 } : null;
}

// ── Каталог: категории плитками, слитые с поиском ────────────────────
/**
 * Один список вместо двух. Раньше «быстрые товары» жили отдельно от
 * поиска по каталогу, и кассир держал в голове, где что искать. Теперь
 * первая вкладка — ходовое (его задаёт владелец в кабинете), дальше
 * категории, последняя — «Все». Плитки не мельчают: промах по мелкой
 * плитке дороже второго касания.
 */
let catTab = null;
let searchQuery = '';

function catGroups() {
  const hasQuick = catalog.some((g) => g.quick || g.quickGroup);
  const cats = [];
  for (const g of catalog) {
    const c = g.category || g.quickGroup;
    if (c && !cats.includes(c)) cats.push(c);
  }
  return (hasQuick ? ['Ходовое'] : []).concat(cats, ['Все']);
}

function catFilter() {
  const q = searchQuery.trim().toLowerCase();
  if (q) {
    return catalog.filter((g) => g.name.toLowerCase().includes(q)
      || (g.barcodes || []).some((b) => String(b).includes(q)));
  }
  if (catTab === 'Ходовое') return catalog.filter((g) => g.quick || g.quickGroup);
  if (catTab && catTab !== 'Все') return catalog.filter((g) => (g.category || g.quickGroup) === catTab);
  return catalog;
}

function drawCatalog() {
  const groups = catGroups();
  if (!groups.includes(catTab)) catTab = groups[0] || 'Все';
  const tabs = $('catTabs');
  tabs.innerHTML = groups.map((n) =>
    `<button data-g="${escapeHtml(n)}" class="${n === catTab ? 'on' : ''}${n === 'Ходовое' ? ' quick' : ''}">${escapeHtml(n)}</button>`).join('');
  tabs.querySelectorAll('button').forEach((b) => b.onclick = () => {
    catTab = b.dataset.g; searchQuery = ''; $('search').value = '';
    drawCatalog(); focusScanner();
  });

  const list = catFilter();
  $('goods').innerHTML = list.slice(0, 80).map((g) =>
    `<button class="good${g.quick || g.quickGroup ? ' q' : ''}" data-i="${catalog.indexOf(g)}">
       <span>${escapeHtml(g.name)}</span><b>${money(g.price)}</b></button>`).join('')
    || `<div class="empty">${searchQuery.trim()
        ? 'Ничего не нашлось. Проверьте название или отсканируйте штрихкод.'
        : 'Товаров нет. Заведите их в кабинете, потом «Меню» → «Обновить каталог».'}</div>`;
  $('goods').querySelectorAll('.good').forEach((b) => b.onclick = () => {
    addToCart(catalog[Number(b.dataset.i)]);
    focusScanner();
  });
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function addToCart(g, qty) {
  if (!g) return;
  const n = Number(qty || 1);
  // Весовую позицию не складываем с обычной строкой того же товара: два
  // взвешивания — это два разных веса, и в чеке они должны быть видны.
  const line = n % 1 === 0 ? cart.find((l) => l.productId === g.id && !(l.qty % 1)) : null;
  if (line) line.qty += n;
  else cart.push({ productId: g.id, name: g.name, price: g.price, qty: n,
    // Штрихкоды и признак маркировки нужны в строке: по ним марка
    // находит свою позицию, не перебирая каталог заново.
    barcodes: g.barcodes || [], marked: !!g.marked, codes: [] });
  selLine = line || cart[cart.length - 1];
  padNum = '';
  drawCart();
}
let voids = 0;      // отмен позиций за смену
let discounts = 0;  // скидок за смену
let selLine = null; // позиция, к которой относятся цифры справа
let parkedCount = 0; // отложенных чеков на диске — показываем в листах

function drawVoids() {
  const el = $('voidLabel');
  if (!el) return;
  const parts = [];
  if (voids) parts.push('отмен: ' + voids);
  if (discounts) parts.push('скидок: ' + discounts);
  el.textContent = parts.join(' · ');
  el.classList.toggle('hidden', parts.length === 0);
}

/**
 * Чек. Название 19 px — строку видно, не наклоняясь.
 *
 * Счётчик количества стоит МЕЖДУ «минусом» и «плюсом»: промахнуться с
 * одного на другой физически нельзя, а это самая дорогая опечатка на
 * кассе. Нажатие на счётчик берёт позицию в работу — дальше количество
 * набирают цифрами справа, там же, где всё остальное.
 */
function drawCart() {
  // Количество уменьшили — лишние марки снимаем здесь, в одном месте:
  // количество меняется из четырёх разных мест, и четырёхкратное
  // правило рано или поздно рассогласуется.
  for (const l of cart) {
    const cap = Math.ceil(l.qty);
    if (l.codes && l.codes.length > cap) l.codes = l.codes.slice(0, cap);
  }
  $('cart').innerHTML = cart.map((l, i) => {
    const sum = l.price * l.qty - (l.discount || 0);
    return `
    <div class="line${l === selLine ? ' sel' : ''}">
      <div class="nm"><span class="nm-t">${escapeHtml(l.name)}</span>${
        l.discount ? `<span class="disc">−${money(l.discount)}</span>` : ''}${
        l.free ? '<span class="free-mark">без карточки</span>' : ''}${
        l.priceChanged ? '<span class="price-mark">цена изменена</span>' : ''}${
        l.qty % 1 ? '<span class="weigh-mark">вес</span>' : ''}${
        l.marked ? (needMarks(l)
          ? `<span class="mark-need">нужна марка ${(l.codes || []).length}/${Math.ceil(l.qty)}</span>`
          : `<span class="mark-ok">марка ${(l.codes || []).length}/${Math.ceil(l.qty)}</span>`) : ''}</div>
      <div class="sum">${money(sum)}</div>
      <div class="qty">
        <button data-m="${i}" title="Меньше">−</button><button class="qty-num" data-q="${i}" title="Взять позицию в работу: количество набирается цифрами справа">${qtyStr(l.qty)}</button><button data-p="${i}" title="Больше">+</button><button class="qty-dup" data-dup="${i}" title="Ещё столько же">×2</button>
      </div>
      <div class="acts">
        <button data-pr="${i}" title="Изменить цену">₸</button>
        <button data-s="${i}" title="Скидка на позицию">%</button>
        <button data-d="${i}" title="Убрать позицию">✕</button>
      </div>
    </div>`; }).join('')
    || '<div class="empty">Чек пуст. Сканируйте товар, нажмите плитку слева или наберите сумму цифрами справа.</div>';

  $('cart').querySelectorAll('button').forEach((b) => {
    b.onclick = async () => {
      if (b.dataset.p != null) { cart[b.dataset.p].qty += 1; selLine = cart[b.dataset.p]; }
      if (b.dataset.m != null) {
        const l = cart[b.dataset.m];
        // Уменьшение количества и удаление — те самые действия, которыми
        // выносят деньги: пробил три, убрал одно, разницу забрал.
        const code = l.qty <= 1 ? 'act_remove_item' : 'act_reduce_qty';
        const ok = await allowAction(code, l.qty <= 1 ? 'Удаление позиции' : 'Уменьшение количества');
        if (!ok) return;
        l.qty -= 1;
        if (l.qty <= 0) cart.splice(b.dataset.m, 1);
        voids++;
        logAction(code, { productName: l.name, amount: l.price, approvedBy: ok.approvedBy });
      }
      if (b.dataset.d != null) {
        // Первое касание взводит, второе убирает. Окна нет — очередь ждёт, —
        // но случайно смахнуть позицию локтем уже нельзя.
        if (!b.classList.contains('del-armed')) {
          b.classList.add('del-armed');
          b.textContent = 'Убрать?';
          setTimeout(() => { b.classList.remove('del-armed'); b.textContent = '✕'; }, 3000);
          return;
        }
        const l = cart[b.dataset.d];
        const ok = await allowAction('act_remove_item', 'Удаление позиции');
        if (!ok) return;
        cart.splice(b.dataset.d, 1);
        voids += 1;
        logAction('act_remove_item', { productName: l.name, amount: l.price, approvedBy: ok.approvedBy });
      }
      if (b.dataset.dup != null) {
        // УДВОЕНИЕ ПОЗИЦИИ (модель МоегоСклада). Покупатель берёт «ещё
        // столько же» — частый случай на кассе: две упаковки воды, ещё
        // три пачки сигарет. Быстрее, чем вводить число, и понятнее, чем
        // жать «плюс» столько же раз, сколько уже набрано.
        const l = cart[b.dataset.dup];
        l.qty *= 2; selLine = l;
      }
      if (b.dataset.q != null) {
        // БЫСТРЫЙ ВВОД КОЛИЧЕСТВА. «12 бутылок воды» — это двенадцать
        // нажатий «плюс» или одно нажатие на цифру и три клавиши справа.
        // Для весового товара иначе никак: 0,850 кг плюсами не наберёшь.
        selLine = cart[b.dataset.q];
        padMode = 'qty'; padNum = '';
        drawCart(); drawPad();
        toast('Наберите количество цифрами справа');
        return;
      }
      if (b.dataset.pr != null) { openPriceSheet(Number(b.dataset.pr)); return; }
      if (b.dataset.s != null)  { openLineDiscountSheet(Number(b.dataset.s)); return; }
      drawCart();
    };
  });

  const total = cart.reduce((s, l) => s + l.price * l.qty - (l.discount || 0), 0) - cartDiscount;
  $('cartCount').textContent = cart.length;
  $('cartTotal').textContent = money(total);
  // Цифр больше, чем места в колонке, — только тогда шрифт мельче.
  $('cartTotal').classList.toggle('long', money(total).length > 13);
  $('btnDiscount').disabled = cart.length === 0;
  // Скидка на чек видна прямо в итоге: продавец называет покупателю
  // конечную сумму, и она должна совпадать с тем, что он видит.
  const dEl = $('cartDiscountLine');
  if (dEl) dEl.innerHTML = cartDiscount
    ? `<span>Скидка на чек</span><b>−${money(cartDiscount)}</b>` : '';

  if (selLine && !cart.includes(selLine)) selLine = null;
  if (!selLine && cart.length) selLine = cart[cart.length - 1];
  drawMarkBar();
  drawVoids(); drawPad();
  if (paying) payRender();
  pushDisplay();
}

/**
 * ИЗМЕНЕНИЕ ЦЕНЫ. Разрешено только вверх, если владелец включил запрет
 * на снижение: снижение цены на кассе — самый тихий способ отдать товар
 * «своим» дешевле, и в отчётах это выглядит как обычная продажа.
 *
 * Раньше цену спрашивало системное окно ввода. На кассовом планшете его
 * нечем заполнить: системной клавиатуры может не быть вовсе. Теперь это
 * лист снизу с обычным числовым полем — на нём клавиатура появляется сама.
 */
async function openPriceSheet(i) {
  const l = cart[i];
  const okp = await allowAction('act_price_change', 'Изменение цены');
  if (!okp) return;
  const base = catalog.find((g) => g.id === l.productId)?.price ?? l.price;
  openModal(`
    <h2>Цена позиции</h2>
    <p class="muted">${escapeHtml(l.name)} · в карточке ${money(base)}${SET.noPriceDown ? ' · снижать нельзя' : ''}</p>
    <label>Новая цена</label>
    <input id="prVal" inputmode="numeric" value="${l.price}">
    <div class="err" id="prErr"></div>
    <div class="modal-actions">
      <button id="prCancel">Отмена</button>
      <button id="prOk" class="primary">Применить</button>
    </div>`);
  $('prCancel').onclick = closeModal;
  $('prOk').onclick = () => {
    const np = Number($('prVal').value) || 0;
    if (np <= 0) { $('prErr').textContent = 'Введите цену'; return; }
    if (SET.noPriceDown && np < base) { $('prErr').textContent = `Снижать цену нельзя. В карточке ${money(base)}`; return; }
    l.price = np; l.priceChanged = np !== base;
    if (np !== base) logAction('price_change', { productName: l.name, amount: np - base, approvedBy: okp.approvedBy });
    closeModal(); drawCart();
  };
  setTimeout(() => $('prVal')?.focus(), 50);
}

/**
 * СКИДКА НА ПОЗИЦИЮ. Потолок скидки: запретить совсем — плохо, продавцу
 * иногда нужно уступить сто тенге, чтобы не потерять покупателя. «До 15%
 * можно, дальше зови администратора» — честнее и работает.
 */
async function openLineDiscountSheet(i) {
  const l = cart[i];
  if (SET.discountAllowed === false) { toast('Владелец запретил скидки на кассе', true); return; }
  const ok = await allowAction('act_discount', 'Скидка');
  if (!ok) return;
  const base = l.price * l.qty;
  const capPct = SET.discountMaxPct ?? 100;
  const cap = Math.floor(base * capPct / 100);
  openModal(`
    <h2>Скидка на позицию</h2>
    <p class="muted">${escapeHtml(l.name)} · ${money(base)}${capPct < 100 ? ` · больше ${capPct}% нельзя` : ''}</p>
    <label>Скидка в тенге <span class="muted">(не больше ${cap})</span></label>
    <input id="ldVal" inputmode="numeric" value="${l.discount || 0}">
    <div class="disc-preview" id="ldPrev"></div>
    <div class="modal-actions">
      <button id="ldOff">Убрать скидку</button>
      <button id="ldOk" class="primary">Применить</button>
    </div>`);
  const calc = () => {
    const v = Math.max(0, Math.min(Number($('ldVal').value || 0), cap));
    $('ldPrev').innerHTML = `<div>Скидка <b>${money(v)}</b></div>
      <div class="disc-total">Позиция ${money(base - v)}</div>`;
    return v;
  };
  $('ldVal').oninput = calc; calc();
  $('ldOff').onclick = () => { l.discount = 0; closeModal(); drawCart(); };
  $('ldOk').onclick = () => {
    const d = calc();
    if (d > 0 && d !== (l.discount || 0)) {
      discounts += 1;
      logAction('discount', { productName: l.name, amount: d, approvedBy: ok.approvedBy });
    }
    l.discount = d;
    closeModal(); drawCart();
  };
  setTimeout(() => $('ldVal')?.focus(), 50);
}

$('btnClear').onclick = () => { cart = []; cartDiscount = 0; selLine = null; drawCart(); };

/**
 * ПРЕЧЕК (модель МоегоСклада) — список с суммой ДО оплаты.
 *
 * Покупатель набрал полную корзину и хочет посмотреть, что получилось,
 * прежде чем платить. Без пречека кассир либо диктует вслух, либо
 * пробивает чек и потом делает возврат — а возврат это след, который
 * потом объясняй, и деньги, которые уже прошли через кассу.
 *
 * Не фискальный документ: печатается пометка, чтобы покупатель не принял
 * его за чек и не ушёл без настоящего.
 */
$('btnPreReceipt').onclick = async () => {
  if (!cart.length) return;
  const items = cart.map((l) => ({
    name: l.name, qty: l.qty, price: l.price,
    total: l.price * l.qty - (l.discount || 0),
  }));
  const sub = items.reduce((a, b) => a + b.total, 0);
  const disc = cartDiscount || 0;
  const r = await K.print({
    store: S.store?.name || 'Магазин',
    address: SET.receiptHeader || undefined,
    number: '—', date: new Date().toLocaleString('ru-RU'),
    cashier: S.employee?.name || '',
    cashierId: S.employee?.id || null,
    items, discount: disc, total: sub - disc,
    payments: [], isPreReceipt: true,
    footer: 'ЭТО НЕ ЧЕК. Предварительный расчёт',
  });
  if (!r.ok) toast('Не удалось напечатать: ' + r.error, true);
  else toast('Пречек напечатан');
};

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
  drawTop();
  cart = []; cartDiscount = 0; selLine = null; drawCart(); updateParkedCount();
  toast('Чек отложен на диск');
};

$('btnParked').onclick = async () => {
  const parked = (await K.getState()).data.parked || [];
  openModal(`<h2>Отложенные чеки <span class="ver">лежат на диске, касса может закрыться</span></h2>
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
  $('noReceipt').onclick = async () => {
    const okr = await allowAction('act_refund_free', 'Возврат без чека');
    if (!okr) return;
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
        <button id="nrOk" class="primary">Вернуть деньги</button>
      </div>`);
    $('nrCancel').onclick = closeModal;
    $('nrOk').onclick = async () => {
      const name = $('nrName').value.trim(), sum = Number($('nrSum').value || 0), note = $('nrNote').value.trim();
      if (!name || sum <= 0 || !note) { $('nrErr').textContent = 'Заполните всё: без причины возврат не проводим'; return; }
      const ref = { id: uuid(), number: (S.lastNumber || 0) + 1, date: new Date().toLocaleString('ru-RU'),
        store: S.store?.name || 'Магазин', cashier: S.employee?.name || '',
        cashierId: S.employee?.id || null,
        items: [{ productId: null, name, qty: 1, price: sum, total: sum, free: true }],
        total: sum, isRefund: true, noReceipt: true, comment: note,
        payments: [{ label: 'Наличные', sum }], hasCash: true };
      await K.receiptAdd(ref);
      await K.outboxAdd({ id: ref.id, entity: 'sale', entityId: ref.id, op: 'insert', payload: ref });
      voids++;                                  // в счётчик отмен — это след
      logAction('act_refund_free', { productName: name, amount: sum, approvedBy: okr.approvedBy });
      S = (await K.saveState({ lastNumber: ref.number, cashInDrawer: (S.cashInDrawer || 0) - sum })).data;
      await K.print(ref);
      closeModal(); updatePending(); drawTop(); drawVoids(); trySync();
      toast('Возврат ' + money(sum) + ' · причина ушла в отчёт');
    };
  };
  $('c').onclick = closeModal;
  document.querySelectorAll('.reclist button').forEach((b) => b.onclick = async () => {
    const p = parked.find((x) => x.id === b.dataset.id);
    if (!p) return;
    if (cart.length && !confirm('Текущий чек будет заменён. Продолжить?')) return;
    cart = p.items;
    S = (await K.saveState({ parked: parked.filter((x) => x.id !== p.id) })).data;
    closeModal(); drawCart(); updateParkedCount();
  });
};

async function updateParkedCount() {
  const n = ((await K.getState()).data.parked || []).length;
  parkedCount = n;
  $('btnParked').textContent = n ? `Отложенные (${n})` : 'Отложенные';
}

// ── Скидка на весь чек ───────────────────────────────────────────────
/**
 * Есть у всех троих конкурентов, у нас была только на позицию — и
 * «скидка 10% постоянному покупателю» приходилось ставить построчно,
 * по десять раз на чек.
 *
 * В тенге ИЛИ в процентах, как у МоегоСклада: продавец думает то так,
 * то эдак — «уступлю пятьсот» и «скину десять процентов» это разные
 * мысли, и заставлять пересчитывать в уме неправильно.
 */
let cartDiscount = 0;

$('btnDiscount').onclick = async () => {
  if (!cart.length) return;
  if (SET.discountAllowed === false) { toast('Владелец запретил скидки на кассе', true); return; }
  const ok = await allowAction('act_discount', 'Скидка на чек');
  if (!ok) return;

  const base = cart.reduce((a, l) => a + l.price * l.qty - (l.discount || 0), 0);
  const capPct = SET.discountMaxPct ?? 100;
  const cap = Math.floor(base * capPct / 100);

  openModal(`
    <h2>Скидка на чек</h2>
    <div class="muted">Сумма чека ${money(base)}${capPct < 100 ? ` · больше ${capPct}% нельзя` : ''}</div>
    <div class="disc-tabs">
      <button data-m="pct" class="on">Процентом</button>
      <button data-m="sum">Суммой</button>
    </div>
    <input id="discVal" inputmode="numeric" value="" placeholder="0">
    <div id="discPreview" class="disc-preview"></div>
    <div class="err" id="discErr"></div>
    <div class="modal-actions">
      <button id="discOff">Убрать скидку</button>
      <button id="discOk" class="primary">Применить</button>
    </div>`);

  let mode = 'pct';
  const calc = () => {
    const v = Number($('discVal').value || 0);
    const sum = mode === 'pct' ? Math.floor(base * v / 100) : v;
    const capped = Math.min(sum, cap);
    // Показываем и сумму скидки, и что останется заплатить: продавец
    // называет покупателю итог, а не размер скидки.
    $('discPreview').innerHTML = !v ? '' :
      `<div>Скидка <b>${money(capped)}</b>${capped < sum ? ' <span class="warn">(больше нельзя)</span>' : ''}</div>
       <div class="disc-total">К оплате ${money(base - capped)}</div>`;
    return capped;
  };
  $('discVal').oninput = calc;
  document.querySelectorAll('.disc-tabs button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.disc-tabs button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); mode = b.dataset.m; calc();
  });
  $('discOff').onclick = () => { cartDiscount = 0; closeModal(); drawCart(); };
  $('discOk').onclick = () => {
    const d = calc();
    if (d <= 0) { $('discErr').textContent = 'Введите скидку'; return; }
    cartDiscount = d;
    discounts += 1; drawVoids();
    logAction('discount', { productName: 'Скидка на чек', amount: d, approvedBy: ok.approvedBy });
    closeModal(); drawCart();
  };
  setTimeout(() => $('discVal')?.focus(), 50);
};

// ── Оплата на месте, без окна ────────────────────────────────────────
/**
 * Раньше оплата открывалась окном по центру, а поверх него выезжала
 * клавиатура: кассир переводил взгляд, искал поле, вводил сумму, искал
 * кнопку — четыре действия, два из них на переориентацию.
 *
 * Теперь способы оплаты встают ТАМ, ГДЕ БЫЛ КАТАЛОГ: чек остаётся на
 * экране, цифры остаются на месте, а «ЧЕК ✓» — точно там, где была
 * «ОПЛАТА». Палец не переезжает.
 *
 * Считает по-прежнему finishSale, и читает те же поля: pCash, pCard,
 * pBonusCust, pBonusSum, payErr. Здесь только то, где они стоят.
 */
let paying = false;
let payWay = 'cash';
// Как отдаём чек: бумага, ссылка на телефон или никак. Половина покупателей
// говорит «чек не надо», а лента кончается в очереди. Фискализация от
// выбора не зависит: чек уйдёт в ОФД в любом случае.
let giveReceipt = 'paper';
let receiptPhone = '';

const cartTotal = () => cart.reduce((s, l) => s + l.price * l.qty - (l.discount || 0), 0) - cartDiscount;

const WAYS = [['cash','Наличные'], ['card','Карта'], ['qr','QR с телефона'], ['mixed','Смешанно'],
              ['credit','В долг'], ['bonus','Бонусы'], ['cert','Сертификат']];
// Номиналы тенге. Покупатель даёт 5000 за покупку на 3240 — одно нажатие
// вместо четырёх цифр и без опечаток. Показываем только те, что не меньше
// суммы чека: остальные бессмысленны.
const DENOMS = [500, 1000, 2000, 5000, 10000, 20000];

function payOpen() {
  if (!cart.length) return;
  // Без марок к оплате не пускаем и говорим, сколько ещё сканировать: узнать
  // об этом после того, как покупатель достал деньги, хуже всего.
  const need = marksMissing();
  if (need) { toast('Отсканируйте марки: осталось ' + need, true); return; }
  paying = true; payWay = 'cash'; padNum = '';
  $('catalogPane').classList.add('hidden');
  $('payPane').classList.remove('hidden');
  drawPad(); payRender();
  setTimeout(() => $('pCash')?.focus(), 40);
}

function payClose() {
  paying = false; padNum = '';
  $('payPane').classList.add('hidden');
  $('catalogPane').classList.remove('hidden');
  $('changeRow').classList.add('hidden');
  drawPad(); drawCatalog(); focusScanner(); pushDisplay();
}

function payRender() {
  const total = cartTotal();
  const cashish = payWay === 'cash' || payWay === 'mixed';
  const askPaper = false;   // выбор теперь в ряду «Чек покупателю» ниже
  const dens = DENOMS.filter((d) => d >= total).slice(0, 4);
  $('payPane').innerHTML = `
    <div class="pay-ways">${WAYS.map(([w, l]) =>
      `<button data-w="${w}" class="${w === payWay ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="err" id="payErr"></div>
    <div class="pay-extra" id="payExtra"></div>
    ${cashish ? `<div class="pay-title">Дал купюрой</div>
    <div class="denoms">${dens.map((d) => `<button data-d="${d}">${money(d)}</button>`).join('')}</div>
    ${dens.length ? '' : '<div class="hint">Сумма больше 20 000 — наберите цифрами справа.</div>'}` : ''}
    ${askPaper ? `<label class="print-toggle"><input type="checkbox" id="wantPrint" checked>Печатать бумажный чек</label>` : ''}
    <div class="pay-title" style="margin-top:6px">Чек покупателю</div>
    <div class="give-receipt">
      <button data-g="paper" class="${giveReceipt === 'paper' ? 'on' : ''}">На бумаге</button>
      <button data-g="phone" class="${giveReceipt === 'phone' ? 'on' : ''}">На телефон</button>
      <button data-g="none" class="${giveReceipt === 'none' ? 'on' : ''}">Не нужен</button>
    </div>
    ${giveReceipt === 'phone' ? `<label>Номер покупателя</label>
    <input id="pPhone" inputmode="numeric" data-nokeypad placeholder="7 7XX XXX XX XX" value="${receiptPhone}">
    <div class="hint">Придёт ссылка на фискальный чек. Нет связи — уйдёт позже, сам.</div>` : ''}`;

  $('payPane').querySelectorAll('.pay-ways button').forEach((b) => b.onclick = () => {
    payWay = b.dataset.w; padNum = '';
    payRender(); drawPad();
    if (payWay === 'cash' || payWay === 'mixed') setTimeout(() => $('pCash')?.focus(), 40);
  });
  $('payPane').querySelectorAll('.denoms button').forEach((b) => b.onclick = () => {
    const el = $('pCash');
    if (!el) return;
    el.value = b.dataset.d;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  $('payPane').querySelectorAll('.give-receipt button').forEach((b) => b.onclick = () => {
    giveReceipt = b.dataset.g;
    payRender(); drawPad();
    if (giveReceipt === 'phone') setTimeout(() => $('pPhone')?.focus(), 40);
  });
  const ph = $('pPhone');
  if (ph) ph.oninput = () => { receiptPhone = ph.value; };
  payExtra(total);
  updateChange();
}

function payExtra(total) {
  const box = $('payExtra');
  if (!box) return;
  if (payWay === 'mixed') {
    box.innerHTML = `<label>Картой</label>
      <input id="pCard" inputmode="numeric" data-nokeypad value="${total}">`;
    $('pCard').oninput = updateChange;
  } else if (payWay === 'card') {
    box.innerHTML = `<p class="hint">Проведите картой на терминале, потом «ЧЕК ✓».</p>`;
  } else if (payWay === 'qr') {
    // QR с телефона — в Казахстане так платят чаще, чем картой.
    //
    // Где мы лучше рынка: у большинства касс сумму в приложении вводит сам
    // покупатель — и ошибается, а разница вскрывается вечером. Мы сразу
    // выводим сумму крупно и на дисплей покупателя, чтобы ей не было где
    // разойтись.
    box.innerHTML = `<div class="qr-note">Покажите покупателю QR магазина.<br>
      Сумма на его дисплее: <b>${money(total)}</b> — её не надо диктовать.</div>
      <p class="hint">Нажмите «ЧЕК ✓», когда видите поступление. Деньги идут не в ящик.</p>`;
  } else if (payWay === 'cert') {
    // Сертификат: номер обязателен — иначе один и тот же сертификат
    // принесут три раза, и владелец не узнает.
    box.innerHTML = `<label>Номер сертификата</label>
      <input id="pCertNo" inputmode="numeric" data-nokeypad placeholder="цифры на сертификате">
      <p class="hint">Номер уйдёт в чек и в отчёт: повторно принести его не получится.</p>`;
  } else if (payWay === 'credit') {
    // В ДОЛГ. Отпустить под запись можно только известному покупателю:
    // «долг Марату» без карточки клиента — это потерянные деньги, их
    // некому предъявить. Поэтому выбор обязателен.
    box.innerHTML = `<label>Кому в долг</label>
      <select id="pDebtor"><option value="">— выберите покупателя —</option>${
        (S.customers || []).map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${
          c.debt ? ` · уже должен ${money(c.debt)}` : ''}</option>`).join('')
      }</select>
      <p class="hint">Долг попадёт в карточку покупателя. Владелец увидит его в «Контрагентах».</p>`;
  } else if (payWay === 'bonus') {
    // ОПЛАТА БОНУСАМИ. Сколько можно списать, решает сервер: у программы
    // есть потолок (обычно половина чека), и считать его на кассе —
    // значит завести второе место, где живёт то же правило.
    box.innerHTML = `<label>Кто платит бонусами</label>
      <select id="pBonusCust"><option value="">— выберите покупателя —</option>${
        (S.customers || []).map((c) => `<option value="${c.id}" data-bal="${c.bonus || 0}">${
          escapeHtml(c.name)}${c.bonus ? ` · ${money(c.bonus)} бонусов` : ' · нет бонусов'}</option>`).join('')
      }</select>
      <div id="bonusInfo" class="bonus-info"></div>`;
    $('pBonusCust').onchange = async () => {
      const id = $('pBonusCust').value;
      if (!id) { $('bonusInfo').innerHTML = ''; return; }
      $('bonusInfo').innerHTML = '<span class="muted">Считаю…</span>';
      const r = await K.bonusSpendable(id, total);
      const can = r.ok ? Number(r.data?.canSpend ?? 0) : 0;
      $('bonusInfo').innerHTML = can > 0
        ? `<div class="bonus-can">Можно списать <b>${money(can)}</b></div>
           <label>Сколько списать</label>
           <input id="pBonusSum" inputmode="numeric" data-nokeypad value="${can}">
           <div id="bonusRest" class="bonus-rest">Доплатить наличными: ${money(total - can)}</div>`
        : `<div class="muted">${r.data?.reason || 'Списать нечего'}</div>`;
      const inp = $('pBonusSum');
      if (inp) inp.oninput = () => {
        const v = Math.max(0, Math.min(Number(inp.value || 0), can));
        $('bonusRest').textContent = 'Доплатить наличными: ' + money(total - v);
      };
      // Поле списания появилось — цифры справа теперь набирают в него.
      drawPad();
      if (inp) inp.focus();
    };
  } else box.innerHTML = '';
}

/**
 * Сдача — вторая по величине цифра на экране и подписана словом: под
 * углом с метра голое число читается как сумма к оплате, и кассир
 * отдаёт не то. Если денег дали меньше — то же место говорит «НЕ
 * ХВАТАЕТ», а не молчит.
 */
function updateChange() {
  const row = $('changeRow');
  if (!row) return;
  if (!paying || (payWay !== 'cash' && payWay !== 'mixed')) { row.classList.add('hidden'); pushDisplay(); return; }
  const total = cartTotal();
  const got = Number($('pCash')?.value || 0) + (payWay === 'mixed' ? Number($('pCard')?.value || 0) : 0);
  const short = got < total;
  row.classList.remove('hidden');
  row.classList.toggle('short', short);
  $('changeLabel').textContent = short ? 'НЕ ХВАТАЕТ' : 'СДАЧА';
  const text = money(short ? total - got : got - total);
  $('change').textContent = text;
  $('change').classList.toggle('long', text.length > 13);
  pushDisplay();
}

async function payConfirm() {
  const total = cartTotal();
  if ($('payErr')) $('payErr').textContent = '';
  await finishSale(payWay, total);
  // finishSale пишет в payErr, если не пропустил оплату: тогда остаёмся
  // на месте, кассир поправит и нажмёт снова.
  if ($('payErr') && $('payErr').textContent) return;
  payClose();
  toast('Чек сохранён на диск' + (S.lastNumber ? ' · №' + S.lastNumber : ''));
}

async function finishSale(way, total) {
  const cash = Number($('pCash')?.value || 0);
  const card = way === 'card' ? total : Number($('pCard')?.value || 0);

  // Бонусы: списываем ровно столько, сколько разрешил сервер.
  let bonusUsed = 0, bonusCustomer = null;
  if (way === 'bonus') {
    bonusCustomer = $('pBonusCust')?.value || '';
    if (!bonusCustomer) { $('payErr').textContent = 'Выберите покупателя — бонусы лежат на его карточке'; return; }
    bonusUsed = Number($('pBonusSum')?.value || 0);
    if (bonusUsed <= 0) { $('payErr').textContent = 'Укажите, сколько бонусов списать'; return; }
  }

  // Сертификат: без номера не принимаем — один и тот же сертификат иначе
  // принесут три раза, и владелец об этом не узнает.
  let certNo = '';
  if (way === 'cert') {
    certNo = String($('pCertNo')?.value || '').trim();
    if (!certNo) { $('payErr').textContent = 'Введите номер сертификата — без него его принесут ещё раз'; return; }
  }

  // Марки: последняя проверка перед сохранением. Оплата и так не откроется
  // без них, но чек — то, что уйдёт в ОФД: здесь дешевле ошибки нет.
  if (marksMissing()) { $('payErr').textContent = 'Не все марки отсканированы'; return; }

  // В долг: деньги сейчас не приходят, приходит обязательство.
  let debtorId = null, debtorName = '';
  if (way === 'credit') {
    debtorId = $('pDebtor')?.value || '';
    if (!debtorId) { $('payErr').textContent = 'Выберите покупателя — долг должен быть на кого-то записан'; return; }
    debtorName = $('pDebtor').selectedOptions[0]?.textContent?.split(' · ')[0] ?? '';
  } else if (way === 'cash' || way === 'mixed') {
    // Проверяем только там, где деньги действительно кладут на прилавок.
    // Карта, QR и сертификат закрывают сумму целиком.
    const paid = cash + (way === 'mixed' ? card : 0);
    if (paid < total) { $('payErr').textContent = 'Оплачено меньше суммы чека'; return; }
  }

  const receipt = {
    id: uuid(),
    number: (S.lastNumber || 0) + 1,
    date: new Date().toLocaleString('ru-RU'),
    store: S.store?.name || 'Магазин',
    cashier: S.employee?.name || '',
    // КЛЮЧ КАССИРА, А НЕ ТОЛЬКО ИМЯ. Одним именем чек с сотрудником не
    // связать: две Айгуль за год — обычное дело, одна ушла, другая
    // пришла. Без ключа выручку по кассирам не сверить и спросить не с
    // кого. Особенно у чеков, пробитых БЕЗ СЕТИ: они дойдут позже, и
    // разбирать их будут по этому полю.
    cashierId: S.employee?.id || null,
    items: cart.map((l) => ({ ...l, discount: l.discount || 0, total: l.price * l.qty - (l.discount || 0),
      // Коды маркировки едут вместе со строкой: ОФД передаёт их в систему
      // маркировки, и товар выходит из оборота.
      marks: l.codes || [] })),
    discount: cart.reduce((a, l) => a + (l.discount || 0), 0) + cartDiscount,
    cartDiscount, bonusUsed,
    total,
    payments: way === 'cash' ? [{ label: 'Наличные', sum: cash }]
      : way === 'card' ? [{ label: 'Карта', sum: total }]
      : way === 'qr' ? [{ label: 'QR с телефона', sum: total }]
      : way === 'cert' ? [{ label: 'Сертификат №' + certNo, sum: total }]
      : way === 'credit' ? [{ label: 'В долг: ' + debtorName, sum: total }]
      : way === 'bonus' ? [{ label: 'Бонусами', sum: bonusUsed },
                           ...(total - bonusUsed > 0 ? [{ label: 'Наличные', sum: total - bonusUsed }] : [])]
      : [{ label: 'Наличные', sum: cash }, { label: 'Карта', sum: card }],
    customerId: debtorId || bonusCustomer || undefined,
    certificateNo: way === 'cert' ? certNo : undefined,
    payment: way === 'credit' ? { credit: total } : undefined,
    change: (way === 'card' || way === 'credit' || way === 'qr' || way === 'cert') ? 0
      : Math.max(0, (way === 'cash' ? cash : cash + card) - total),
    // Ящик открываем, когда пришли наличные. При карте и долге денег в
    // кассе не прибавилось. При бонусах — только если была доплата.
    hasCash: way === 'cash' || way === 'mixed' || (way === 'bonus' && total - bonusUsed > 0),
  };

  // 1) Сначала сохраняем на диск — чек не должен зависеть от сети и печати.
  await K.receiptAdd(receipt);
  await K.outboxAdd({ id: receipt.id, entity: 'sale', entityId: receipt.id, op: 'insert', payload: receipt });
  S = (await K.saveState({ lastNumber: receipt.number })).data;

  // Наличные в кассе: пришли деньги — прибавилось, дали сдачу — убавилось.
  // Считаем на месте, чтобы кассир видел остаток сразу, без связи.
  if (receipt.hasCash) {
    const got = (way === 'bonus' ? total - bonusUsed : way === 'mixed' ? cash : cash) - (receipt.change || 0);
    S = (await K.saveState({ cashInDrawer: (S.cashInDrawer || 0) + got })).data;
  }
  drawTop();

  // 2) Отдаём чек покупателю так, как он просил: бумага, ссылка на телефон
  // или никак.
  //
  // Фискализация от этого НЕ зависит: чек ушёл в ОФД в любом случае,
  // не печатается только бумага. Половина покупателей у прилавка
  // говорит «чек не надо», а лента стоит денег и кончается в самый
  // неподходящий момент — посреди очереди.
  const mode = SET.printMode || 'always';
  const wantPaper = mode === 'never' ? false
    : mode === 'always' ? giveReceipt !== 'none'
    : giveReceipt === 'paper';

  let p = { ok: true };
  if (wantPaper) p = await K.print(receipt);

  // Ссылка на телефон — если мост умеет это отправлять. Метода пока нет,
  // и придумывать его нельзя: без серверной части чек никуда не уйдёт,
  // а кассир будет думать, что ушёл. Пока метода нет — говорим прямо.
  if (giveReceipt === 'phone') {
    const phone = String(receiptPhone || '').replace(/\D/g, '');
    if (phone.length < 10) toast('Номер неполный — чек не отправлен, сохранён на диске', true);
    else if (typeof K.receiptSend !== 'function') toast('Отправка на телефон ещё не подключена — чек сохранён, распечатайте', true);
    else {
      const r = await K.receiptSend({ receiptId: receipt.id, phone });
      if (!r.ok) toast('Чек не ушёл на телефон: ' + r.error, true);
    }
    receiptPhone = '';
  }
  closeModal();
  cart = []; cartDiscount = 0; selLine = null; drawCart(); updatePending();
  if (wantPaper && !p.ok) toast('Чек сохранён, но не напечатался: ' + p.error, true);
  trySync();
}

function openModal(html) { $('modalBody').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); focusScanner(); }

// ── Правая колонка: цифры ────────────────────────────────────────────
/**
 * Одна клавиатура на всё: количество, сумму без товара, оплату. Не
 * выезжает и не прячется — кассир не ищет её заново каждый раз, и через
 * две недели палец идёт туда сам.
 *
 * Большая зелёная кнопка внизу всегда на одном месте. Пока в наборе
 * пусто — это «ОПЛАТА». Как только кассир набрал число, она говорит,
 * что именно сделает с этим числом: применит количество или добавит
 * сумму в чек. Ничего не двигается, меняется только подпись.
 */
let padMode = 'qty';   // qty | sum
let padNum = '';

const PAD_KEYS = ['7','8','9','4','5','6','1','2','3','←','0','00'];

function padPress(k) {
  if (paying) {
    const el = payTarget();
    if (!el) return;
    if (k === '←') el.value = String(el.value).slice(0, -1);
    else el.value = String(el.value) + (k === '00' ? '00' : k);
    // Сообщаем полю, что значение изменилось: сдача пересчитывается по
    // обычному вводу, и путей должно быть не два, а один.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (k === '←') padNum = padNum.slice(0, -1);
  else padNum = (padNum + (k === '00' ? '00' : k)).slice(0, 9);
  drawPadValue();
}

function payTarget() {
  const a = document.activeElement;
  if (a && a.tagName === 'INPUT' && a.hasAttribute('data-nokeypad')) return a;
  return $('pCash') || $('pBonusSum') || $('pCard') || $('pCertNo') || $('pPhone');
}

function drawPad() {
  const keep = $('pCash')?.value;
  const total = cartTotal();
  const wayName = (WAYS.find(([w]) => w === payWay) || [, ''])[1];

  if (paying) {
    const cashish = payWay === 'cash' || payWay === 'mixed';
    $('padLabel').textContent = cashish ? 'Дал наличными' : 'Оплата · ' + wayName.toLowerCase();
    $('padValue').className = 'ctx-value';
    $('padValue').innerHTML = cashish
      ? `<input id="pCash" inputmode="numeric" data-nokeypad value="${payWay === 'mixed' ? 0 : total}">`
      : money(total);
    if (cashish && keep != null) $('pCash').value = keep;
    if (cashish) $('pCash').oninput = updateChange;
    $('padModes').innerHTML = `
      <button data-p="exact">Без сдачи</button>
      <button data-p="off">Отмена оплаты</button>`;
    $('padModes').querySelectorAll('button').forEach((b) => b.onclick = () => {
      if (b.dataset.p === 'off') { payClose(); return; }
      const el = $('pCash');
      if (el) { el.value = String(total); el.dispatchEvent(new Event('input', { bubbles: true })); }
    });
  } else {
    const sel = selLine;
    $('padLabel').textContent = padMode === 'sum' ? 'Сумма без товара'
      : sel ? 'Количество · ' + sel.name : 'Количество — выберите позицию в чеке';
    $('padValue').className = 'ctx-value' + (padMode === 'sum' ? ' calc' : '');
    $('padValue').textContent = padMode === 'sum'
      ? (padNum ? money(Number(padNum)) : '0 ₸')
      : (padNum || (sel ? qtyStr(sel.qty) : '—'));
    $('padModes').innerHTML = `
      <button data-m="qty" class="${padMode === 'qty' ? 'on' : ''}">Кол-во</button>
      <button data-m="sum" class="${padMode === 'sum' ? 'on' : ''}">Сумма без товара</button>`;
    $('padModes').querySelectorAll('button').forEach((b) => b.onclick = () => {
      padMode = b.dataset.m; padNum = ''; drawPad();
    });
  }

  $('pad').innerHTML = PAD_KEYS.map((k) => `<button data-k="${k}">${k}</button>`).join('');
  $('pad').querySelectorAll('button').forEach((b) => b.onclick = () => padPress(b.dataset.k));
  // Картой и в долг сумму не набирают — и клавиатура должна выглядеть
  // нерабочей, а не молча не принимать нажатия: именно так у соседей
  // кассир не смог закрыть смену.
  if (paying) {
    const t = payTarget();
    $('pad').querySelectorAll('button').forEach((b) => { b.disabled = !t; });
    const exact = $('padModes').querySelector('[data-p="exact"]');
    if (exact) exact.disabled = !$('pCash');
  }
  drawPadButton();
  // Сдачу считаем после того, как поле оплаты отрисовано: иначе она
  // читает пустое поле и говорит «не хватает» на ровном месте.
  if (paying) updateChange();
}

function drawPadValue() {
  if (!paying) {
    $('padValue').textContent = padMode === 'sum'
      ? (padNum ? money(Number(padNum)) : '0 ₸')
      : (padNum || (selLine ? qtyStr(selLine.qty) : '—'));
  }
  drawPadButton();
}

function drawPadButton() {
  const b = $('btnPay'), h = $('padHint');
  if (paying) {
    b.textContent = 'ЧЕК ✓'; b.className = 'primary pay confirm'; b.disabled = false;
    const t = payTarget();
    h.textContent = t ? 'Зелёная кнопка сохраняет чек на диск и печатает'
      : payWay === 'bonus' ? 'Сначала выберите покупателя слева'
      : 'Сумму набирать не нужно — нажмите «ЧЕК ✓»';
    h.classList.remove('hidden');
    return;
  }
  if (padNum && padMode === 'sum') {
    b.textContent = 'ДОБАВИТЬ В ЧЕК'; b.className = 'primary pay'; b.disabled = false;
    h.textContent = 'Строка попадёт в чек как «Сумма без товара»';
    h.classList.remove('hidden');
    return;
  }
  if (padNum && padMode === 'qty') {
    b.textContent = 'КОЛ-ВО ✓'; b.className = 'primary pay'; b.disabled = false;
    h.textContent = selLine ? selLine.name : 'Выберите позицию в чеке';
    h.classList.remove('hidden');
    return;
  }
  b.textContent = 'ОПЛАТА'; b.className = 'primary pay';
  // Не хватает марок — оплата недоступна, и подпись говорит, что именно
  // мешает. Гашеная кнопка без обьяснения — это звонок в поддержку.
  const need = marksMissing();
  b.disabled = cart.length === 0 || need > 0;
  if (need) {
    h.textContent = 'Отсканируйте марки: осталось ' + need;
    h.classList.remove('hidden');
    return;
  }
  h.classList.add('hidden');
}

$('btnPay').onclick = () => {
  if (paying) { payConfirm(); return; }
  if (padNum && padMode === 'sum') { addFreeSum(); return; }
  if (padNum && padMode === 'qty') { applyPadQty(); return; }
  payOpen();
};

/**
 * Количество с цифр — вместо системного окна ввода, которое на кассовом
 * планшете нечем заполнить. Права те же: уменьшение количества и
 * удаление позиции спрашивают разрешения, как и «минус» в чеке.
 */
async function applyPadQty() {
  const n = Number(padNum.replace(',', '.')) || 0;
  const l = selLine;
  padNum = '';
  if (!l) { toast('Сначала нажмите на количество в чеке', true); drawPadValue(); return; }
  if (n <= 0) {
    const ok = await allowAction('act_remove_item', 'Удаление позиции');
    if (!ok) { drawPadValue(); return; }
    cart.splice(cart.indexOf(l), 1); voids++;
    logAction('act_remove_item', { productName: l.name, amount: l.price, approvedBy: ok.approvedBy });
  } else if (n < l.qty) {
    const ok = await allowAction('act_reduce_qty', 'Уменьшение количества');
    if (!ok) { drawPadValue(); return; }
    l.qty = n;
    logAction('act_reduce_qty', { productName: l.name, amount: l.price, approvedBy: ok.approvedBy });
  } else {
    l.qty = n;
  }
  drawCart();
}

/**
 * СУММА БЕЗ ТОВАРА (модель Wipon: вкладка «Калькулятор»). Товар ещё не
 * заведён или пробивают услугу — кассир вбивает цену и продаёт. Позиция
 * помечена «без карточки»: владелец увидит в отчёте и заведёт товар.
 */
function addFreeSum() {
  const v = Number(padNum.replace(',', '.')) || 0;
  padNum = '';
  if (v <= 0) { drawPadValue(); return; }
  cart.push({ productId: null, name: 'Сумма без товара', price: v, qty: 1, free: true });
  selLine = cart[cart.length - 1];
  padMode = 'qty';
  drawCart();
}

// ── Меню и «Ещё»: всё редкое листом снизу ────────────────────────────
function sheetGrid(title, sub, items) {
  openModal(`<h2>${escapeHtml(title)} <span class="ver">${escapeHtml(sub)}</span></h2>
    <div class="sheet-grid">${items.map(([l, h, , tone], i) =>
      `<button data-i="${i}" class="${tone || ''}"><span>${escapeHtml(l)}</span><small>${escapeHtml(h)}</small></button>`).join('')}</div>
    <div class="modal-actions"><button id="sgClose">Закрыть</button></div>`);
  $('sgClose').onclick = closeModal;
  document.querySelectorAll('.sheet-grid button').forEach((b) => {
    b.onclick = () => items[Number(b.dataset.i)][2]();
  });
}

$('btnMenu').onclick = () => {
  sheetGrid('Меню', 'смена, деньги, контроль', [
    [S.shift ? 'Закрыть смену' : 'Открыть смену',
      S.shift ? 'пересчёт, расхождение видно сразу' : 'с разменом', () => $('btnShift').onclick()],
    ['Касса', 'внести, изъять, сдать выручку', () => $('btnCash').onclick()],
    ['Возврат', 'по чеку из истории', () => $('btnRefund').onclick()],
    ['Отложенные', parkedCount ? parkedCount + ' на диске' : 'вернуть чек с диска', () => $('btnParked').onclick()],
    ['Моя смена', 'что касса знает о смене', () => openMyShift()],
    ['Журнал действий', 'что делали до вас', () => openActionLog()],
    ['Дисплей покупателя', 'вторым окном на второй монитор', () => openDisplay()],
    ['Маркировка', 'как продавать табак и пиво', () => openMarkHelp()],
    ['Горячие клавиши', 'F2 · F4 · F6 · F8', () => openHotkeys()],
    ['Обновить каталог', 'подтянуть цены и товары', () => refreshCatalog()],
    ['Настройки печати', 'принтер, лента, пробная печать', () => openPrintSheet()],
    ['Выход', 'смена остаётся открытой', () => $('btnLogout').onclick(), 'bad'],
  ]);
};

$('btnMore').onclick = () => {
  sheetGrid('Ещё', 'операции с этим чеком', [
    ['Скидка на чек', 'в тенге или процентом', () => $('btnDiscount').onclick()],
    ['Товар без карточки', 'название и цена', () => $('btnFree').onclick()],
    ['Отложить чек', 'покупатель вернётся', () => { closeModal(); $('btnPark').onclick(); }],
    ['Отложенные', parkedCount ? parkedCount + ' на диске' : 'вернуть с диска', () => $('btnParked').onclick()],
    ['Проверить цену', 'не начиная чек', () => $('btnPrice').onclick()],
    ['Очистить чек', 'попадёт в счётчик отмен', () => {
      closeModal();
      if (!cart.length) return;
      voids += 1; drawVoids();
      logAction('act_remove_item', { productName: 'Очистка чека', amount: cartTotal() });
      $('btnClear').onclick();
      toast('Чек очищен');
    }, 'warn'],
  ]);
};

async function refreshCatalog() {
  closeModal();
  try { await pullCatalog(); drawCatalog(); toast('Каталог обновлён'); }
  catch { toast('Нет связи — работаем по сохранённому каталогу', true); }
}

/**
 * МОЯ СМЕНА. Показываем только то, что касса знает сама: остаток в
 * ящике, счётчики за смену, номер последнего чека, сколько не уехало на
 * сервер. Выручку считает кабинет — второе место, где считаются те же
 * деньги, рано или поздно разойдётся с первым.
 */
async function openMyShift() {
  const parked = ((await K.getState()).data.parked || []).length;
  const pending = ((await K.outboxPending()).data || []).length;
  openModal(`<h2>Моя смена <span class="ver">${escapeHtml(S.employee?.name || '')}</span></h2>
    <div class="rows">
      <div class="r"><span>Смена</span><b>${S.shift ? 'открыта' : 'не открыта'}</b></div>
      <div class="r"><span>Размен на открытии</span><b>${money(S.shift?.openingFloat || 0)}</b></div>
      <div class="r"><span>Наличные в кассе сейчас</span><b>${money(S.cashInDrawer || 0)}</b></div>
      <div class="r"><span>Последний чек</span><b>${S.lastNumber ? '№' + S.lastNumber : '—'}</b></div>
      <div class="r"><span>Отмен за смену</span><b class="${voids ? 'warn' : ''}">${voids}</b></div>
      <div class="r"><span>Скидок за смену</span><b class="${discounts ? 'warn' : ''}">${discounts}</b></div>
      <div class="r"><span>Отложенных чеков</span><b>${parked}</b></div>
      <div class="r"><span>Не отправлено на сервер</span><b class="${pending ? 'warn' : 'ok'}">${pending}</b></div>
    </div>
    <p class="hint">Выручку за смену считает кабинет: касса показывает только то, что знает сама, чтобы цифры не разошлись.</p>
    <div class="modal-actions"><button id="msClose" class="primary">Закрыть</button></div>`);
  $('msClose').onclick = closeModal;
}

/**
 * Как продавать маркированный товар — коротко и на месте.
 *
 * Новый кассир встречает маркировку в первый же день: сигареты берут
 * чаще всего остального. И именно здесь ставят штрафы, поэтому
 * объяснение должно быть в кассе, а не в чате с владельцем.
 */
function openMarkHelp() {
  openModal(`<h2>Маркировка <span class="ver">табак, пиво и всё, что помечено</span></h2>
    <div class="rows">
      <div class="r"><span>1. Отсканируйте код Data Matrix на упаковке</span><b class="ok">товар встанет в чек сам</b></div>
      <div class="r"><span>2. Две штуки — два кода</span><b>код у каждой свой</b></div>
      <div class="r"><span>3. Полоса над итогом считает, сколько осталось</span><b class="warn">нужно марок: N</b></div>
      <div class="r"><span>4. Код не считался или стёрся</span><b class="bad">товар продавать нельзя</b></div>
    </div>
    <p class="hint">Без кода в чеке штраф выпишут без жалобы покупателя: все чеки и так видны налоговой. Поэтому касса не даёт закрыть такой чек — это защита, а не препятствие.</p>
    <div class="modal-actions"><button id="mhClose" class="primary">Понятно</button></div>`);
  $('mhClose').onclick = closeModal;
}

function openHotkeys() {  openModal(`<h2>Горячие клавиши <span class="ver">для кассы с клавиатурой</span></h2>
    <div class="rows">
      <div class="r"><span>Оплата</span><b><span class="kbd">F2</span></b></div>
      <div class="r"><span>Количество выбранной позиции</span><b><span class="kbd">F4</span></b></div>
      <div class="r"><span>Проверка цены</span><b><span class="kbd">F6</span></b></div>
      <div class="r"><span>Сумма без товара</span><b><span class="kbd">F8</span></b></div>
      <div class="r"><span>Закрыть лист, отменить оплату</span><b><span class="kbd">Esc</span></b></div>
      <div class="r"><span>Штрихкод со сканера</span><b><span class="kbd">Enter</span></b></div>
    </div>
    <div class="modal-actions"><button id="hkClose" class="primary">Закрыть</button></div>`);
  $('hkClose').onclick = closeModal;
}

function openPrintSheet() {
  const w = Number(SET.printWidth || 48);
  openModal(`<h2>Настройки печати <span class="ver">редко, но должно быть под рукой</span></h2>
    <label>Ширина ленты</label>
    <select id="pwSel">
      <option value="48"${w === 48 ? ' selected' : ''}>80 мм (48 знаков)</option>
      <option value="32"${w === 32 ? ' selected' : ''}>58 мм (32 знака)</option>
    </select>
    <p class="hint">Пробная печать печатает лист с рамкой по ширине ленты: по нему видно и ширину, и кириллицу, и что цифры не обрезаны.</p>
    <div class="modal-actions">
      <button id="pwCancel">Закрыть</button>
      <button id="pwTest" class="primary">Пробная печать</button>
    </div>`);
  $('pwCancel').onclick = closeModal;
  $('pwTest').onclick = async () => {
    SET = (await K.saveSettings({ printWidth: Number($('pwSel').value) })).data;
    const r = await K.printDiagnostic();
    closeModal();
    toast(r.ok ? 'Лист отправлен: рамка должна быть ровной' : 'Ошибка печати: ' + r.error, !r.ok);
  };
}

// ── Смена ────────────────────────────────────────────────────────────
$('btnShift').onclick = () => {
  if (!S.shift) {
    openModal(`<h2>Открыть смену</h2>
      <label>Размен в кассе</label><input id="float" inputmode="numeric" value="0">
      <div class="modal-actions"><button id="c">Отмена</button>
      <button id="ok" class="primary">Открыть</button></div>`);
    $('c').onclick = closeModal;
    $('ok').onclick = async () => {
      const shift = { id: uuid(), openedAt: new Date().toISOString(), openingFloat: Number($('float').value || 0) };
      await K.outboxAdd({ id: shift.id, entity: 'shift', entityId: shift.id, op: 'insert', payload: shift });
      // Размен — это стартовые наличные в ящике, а не «просто число».
      S = (await K.saveState({ shift, cashInDrawer: shift.openingFloat })).data;
      drawTop();
      closeModal(); updatePending(); trySync();
      toast('Смена открыта · размен ' + money(shift.openingFloat));
    };
    setTimeout(() => $('float')?.focus(), 50);
  } else {
    openModal(`<h2>Закрыть смену</h2>
      <p class="muted">Пересчитайте наличные в ящике и впишите, сколько насчитали.</p>
      <div class="expected">По расчёту должно быть: <b>${money(S.cashInDrawer || 0)}</b></div>
      <label>Фактически насчитал</label><input id="fact" inputmode="numeric" value="">
      <div id="diff" class="diff"></div>
      <div class="modal-actions"><button id="c">Отмена</button>
      <button id="ok" class="primary">Закрыть смену</button></div>`);
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
      voids = 0; discounts = 0;         // счётчики — на каждую смену свои
      drawTop(); drawVoids();
      closeModal(); updatePending(); trySync();
      toast('Смена закрыта');
    };
    setTimeout(() => $('fact')?.focus(), 50);
  }
};

/**
 * РАЗРЕШЕНИЕ ДЕЙСТВИЯ (модель UMAG, доведённая).
 *
 * Владелец задаёт для каждого опасного действия: доступно всем, только
 * администратору или никому. Если кассиру нельзя — касса не отказывает,
 * а просит PIN администратора ПРЯМО ЗДЕСЬ, не прерывая работу.
 *
 * Почему это лучше запрета: кассир не заблокирован и очередь не стоит,
 * но действие сделано с чужого ведома и попало в журнал с двумя именами
 * — кто сделал и кто разрешил.
 *
 * Возвращает: null — нельзя вовсе; { approvedBy } — можно (пусто, если
 * разрешено всем).
 */
async function allowAction(code, title) {
  const level = (SET.actions || {})[code] || 'everyone';
  if (level === 'everyone') return { approvedBy: null };
  if (level === 'nobody') { toast(`${title}: владелец запретил это действие`, true); return null; }

  // ПРАВО ЧЕЛОВЕКА СИЛЬНЕЕ НАСТРОЙКИ УСТРОЙСТВА — правило донора.
  //
  // Настройка магазина говорит «отмены только с разрешения» — это про
  // магазин, и она верна. Но она одна на всех, и СТАРШИЙ КАССИР ЗВАЛ
  // САМ СЕБЯ: стоял у кассы и вводил свой же код, потому что касса не
  // знала, кто перед ней.
  //
  // Теперь знает: сервер отдаёт при входе isShiftAdmin и isOwner, и
  // они лежат в пропуске. Кто вправе разрешать — разрешает молча.
  const me = S.employee || {};
  if (me.isOwner || me.isShiftAdmin) {
    // Записываем, КТО разрешил: в журнале должно остаться имя, даже
    // если код никто не вводил.
    return { approvedBy: me.name || 'старший смены' };
  }

  // admin_only — спрашиваем PIN
  return new Promise((resolve) => {
    openModal(`
      <h2>Нужно разрешение</h2>
      <p class="muted">«${escapeHtml(title)}» — только с разрешения администратора.<br>
      Позовите его: он введёт свой PIN, и вы продолжите.</p>
      <div class="dots" id="apDots"></div>
      <div class="err" id="apErr"></div>
      <div class="keypad" id="apPad"></div>
      <div class="modal-actions"><button id="apCancel">Отмена</button></div>`);

    let pin = '';
    const draw = () => $('apDots').innerHTML = [0,1,2,3].map((i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
    draw();
    const pad = $('apPad'); pad.innerHTML = '';
    for (const d of ['1','2','3','4','5','6','7','8','9','C','0','←']) {
      const b = document.createElement('button');
      b.textContent = d;
      b.onclick = async () => {
        if (d === 'C') pin = '';
        else if (d === '←') pin = pin.slice(0, -1);
        else if (pin.length < 4) pin += d;
        draw();
        if (pin.length === 4) {
          const r = await K.approve(pin);
          if (r.ok && r.data?.ok) { closeModal(); resolve({ approvedBy: r.data.employeeId, approvedName: r.data.name }); }
          else { $('apErr').textContent = r.data?.reason || 'PIN не подошёл'; pin = ''; draw(); }
        }
      };
      pad.appendChild(b);
    }
    $('apCancel').onclick = () => { closeModal(); resolve(null); };
  });
}

/** Запись значимого действия в журнал: кто сделал, кто разрешил.
 *
 *  Название действия приводим к словарю сервера: он группирует отчёт
 *  владельцу по `remove_item`, `reduce_qty`, `discount` и `refund*`.
 *  Если посылать `act_remove_item`, запись ляжет в журнал, но в отчёт по
 *  кассирам не попадёт — владелец увидит нули там, где были отмены. */
async function logAction(action, extra = {}) {
  await K.logAction({ action: String(action).replace(/^act_/, ''),
    shiftId: S.shift?.id, employeeId: S.employee?.id, ...extra });
}

// Человеческие названия действий — для журнала на кассе.
const ACTION_LABEL = {
  remove_item: 'Удаление позиции', reduce_qty: 'Уменьшение количества',
  discount: 'Скидка', price_change: 'Изменение цены',
  refund: 'Возврат по чеку', refund_free: 'Возврат без чека',
  cash_out: 'Изъятие из кассы', cash_in: 'Внесение в кассу', collection: 'Инкассация',
};

/**
 * ЖУРНАЛ ДЕЙСТВИЙ НА КАССЕ — взгляд перед пересменкой.
 *
 * Сменщик принимает кассу и видит, что делали до него. Это снимает
 * главное условие кражи — незаметность — и никого не обвиняет: при честной
 * работе журнал защищает именно кассира — видно, что недостача не его.
 *
 * Сервер отдаёт последние 50 записей за сутки. Полная история — у владельца
 * в кабинете, и прав на отчёты у кассира нет.
 */
async function openActionLog() {
  if (typeof K.logRead !== 'function') {
    openModal(`<h2>Журнал действий</h2>
      <p class="hint">В этой версии кассы чтение журнала ещё не подключено. Обновите кассу.</p>
      <div class="modal-actions"><button id="alClose" class="primary">Закрыть</button></div>`);
    $('alClose').onclick = closeModal;
    return;
  }
  openModal(`<h2>Журнал действий <span class="ver">загружаю…</span></h2>
    <div class="reclist" id="alList"></div>
    <div class="modal-actions"><button id="alClose" class="primary">Закрыть</button></div>`);
  $('alClose').onclick = closeModal;

  const r = await K.logRead();
  const list = $('alList');
  if (!list) return;                       // лист успели закрыть — рисовать некуда
  if (!r.ok) {
    list.innerHTML = `<p class="hint">Нет связи с сервером — журнал живёт там. Продажа этого не ждёт.</p>`;
    return;
  }
  const rows = r.data || [];
  document.querySelector('#modalBody .ver').textContent = rows.length ? 'за сутки · ' + rows.length : 'за сутки';
  list.innerHTML = rows.map((l) => {
    const t = l.at ? new Date(l.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
    const who = [l.employee, l.approvedBy ? 'разрешил ' + l.approvedBy : ''].filter(Boolean).join(' · ');
    const what = ACTION_LABEL[l.action] || l.action;
    const sum = l.amount == null ? '' : money(l.amount);
    return `<div class="logrow"><span class="what">${t} · ${escapeHtml(what)}${
      l.product ? ' · ' + escapeHtml(l.product) : ''}</span><span class="sum">${sum}</span><span class="who">${escapeHtml(who)}${
      l.comment ? ' · ' + escapeHtml(l.comment) : ''}</span></div>`;
  }).join('') || '<p class="hint">За сутки ничего значимого не было.</p>';
}

/**
 * ТОВАР БЕЗ КАРТОЧКИ — пробить по цене и названию.
 *
 * Каждый день: привезли что-то новое, товар ещё не заведён, а покупатель
 * стоит. Без этого кассир либо не продаёт, либо пробивает под чужим
 * товаром — и остатки разъезжаются молча. Второе хуже.
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
      <button id="freeOk" class="primary">Добавить в чек</button>
    </div>`);
  $('freeCancel').onclick = closeModal;
  $('freeOk').onclick = () => {
    const name = $('freeName').value.trim();
    const price = Number($('freeSum').value || 0);
    if (!name) { $('freeErr').textContent = 'Напишите название — иначе в отчёте будет непонятно, что продали'; return; }
    if (price <= 0) { $('freeErr').textContent = 'Введите цену'; return; }
    cart.push({ productId: null, name, price, qty: 1, free: true });
    selLine = cart[cart.length - 1];
    closeModal(); drawCart();
  };
  setTimeout(() => $('freeName')?.focus(), 50);
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
    <div class="modal-actions"><button id="priceClose" class="primary">Закрыть</button></div>`);
  $('priceClose').onclick = closeModal;
  const check = () => {
    const q = $('priceCode').value.trim();
    if (!q) return;
    const w = weighedBarcode(q);
    const g = w ? w.good
      : catalog.find((x) => (x.barcodes || []).includes(q))
      ?? catalog.find((x) => x.name.toLowerCase().includes(q.toLowerCase()));
    $('priceResult').innerHTML = g
      ? `<div><div class="pr-name">${escapeHtml(g.name)}</div><div class="pr-price">${money(g.price)}</div></div>`
      : `<div class="pr-none">Товар не найден</div>`;
  };
  $('priceCode').oninput = check;
  $('priceCode').onkeydown = (e) => { if (e.key === 'Enter') { check(); e.target.select(); } };
  setTimeout(() => $('priceCode')?.focus(), 50);
};

/**
 * ДЕНЬГИ В КАССЕ: внести, изъять, сдать выручку.
 *
 * Без этого касса не сходится физически. Утром разменяли — деньги
 * пришли не от продажи. Вечером сдали выручку — ушли не покупателю.
 * Если этого нет, расчётный остаток и настоящий расходятся с первого
 * дня, и владелец видит недостачу там, где её нет.
 */
$('btnCash').onclick = () => {
  if (!S.shift) { toast('Сначала откройте смену', true); return; }
  openModal(`
    <h2>Деньги в кассе <span class="ver">в ящике ${money(S.cashInDrawer || 0)}</span></h2>
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
      <button id="cashOk" class="primary">Провести</button>
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
    if (kind !== 'deposit') {
      const ok = await allowAction('act_cash_out', kind === 'collection' ? 'Инкассация' : 'Изъятие из кассы');
      if (!ok) return;
    }

    const op = { id: uuid(), shiftId: S.shift.id, kind, amount: sum, comment: note || null };
    await K.outboxAdd({ id: op.id, entity: 'cash_operation', entityId: op.id, op: 'insert', payload: op });
    // В журнал тоже: сменщик и владелец должны видеть движение денег
    // там же, где отмены и скидки, а не в другом отчёте.
    logAction(kind === 'deposit' ? 'cash_in' : kind === 'collection' ? 'collection' : 'cash_out',
      { amount: sum, comment: note || null });
    // Считаем наличные в кассе прямо здесь: кассир должен видеть остаток
    // сразу, а не после связи с сервером.
    const delta = kind === 'deposit' ? sum : -sum;
    S = (await K.saveState({ cashInDrawer: (S.cashInDrawer || 0) + delta })).data;
    closeModal(); updatePending(); drawTop(); trySync();
    toast((kind === 'deposit' ? 'Внесено ' : kind === 'collection' ? 'Сдано ' : 'Изъято ') + money(sum));
  };
  setTimeout(() => $('cashSum')?.focus(), 50);
};

$('btnLogout').onclick = async () => { S = (await K.saveState({ employee: null })).data; openPin(); };

// ── Возврат ──────────────────────────────────────────────────────────
$('btnRefund').onclick = async () => {
  const list = (await K.receiptsRecent(30)).data || [];
  openModal(`<h2>Возврат <span class="ver">выберите чек</span></h2>
    <div class="reclist">${list.map((r) => `
      <button data-id="${r.id}">№${r.number} · ${r.date} · <b>${money(r.total)}</b></button>`).join('')
      || '<p class="muted">Чеков пока нет.</p>'}</div>
    <div class="modal-actions"><button id="c">Закрыть</button></div>`);
  $('c').onclick = closeModal;
  document.querySelectorAll('.reclist button').forEach((b) => b.onclick = async () => {
    const r = list.find((x) => x.id === b.dataset.id);
    if (!r) return;
    const ok = await allowAction('act_refund', 'Возврат по чеку');
    if (!ok) return;
    if (!confirm(`Вернуть чек №${r.number} на ${money(r.total)}?`)) return;
    const ref = { ...r, id: uuid(), isRefund: true, refundOf: r.id, date: new Date().toLocaleString('ru-RU') };
    await K.receiptAdd(ref);
    await K.outboxAdd({ id: ref.id, entity: 'sale', entityId: ref.id, op: 'insert', payload: ref });
    logAction('act_refund', { productName: 'Чек №' + r.number, amount: r.total, approvedBy: ok.approvedBy });
    await K.print(ref);
    closeModal(); updatePending(); trySync();
    toast('Возврат по чеку №' + r.number + ' · ' + money(r.total));
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
    // Категория нужна вкладкам каталога, plu — весовому штрихкоду.
    category: g.category_name ?? g.category ?? null,
    plu: g.plu_code ?? g.plu ?? null,
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
    // СВЯЗЬ ВЕРНУЛАСЬ — сказать один раз. Кассир видел, что чеки
    // копятся, и должен узнать, что они ушли: иначе он будет ждать и
    // звонить, хотя всё уже хорошо.
    if (netWasDown) {
      netWasDown = false;
      toast('Связь вернулась — чеки ушли на сервер');
    }
  } catch {
    setDot(false);
    // СВЯЗЬ ПРОПАЛА — СКАЗАТЬ ОДИН РАЗ, а не при каждой проверке.
    // Правило донора, и оно верное с двух сторон.
    //
    // У меня не говорилось ВОВСЕ: точка в углу гасла, но её не
    // замечают за работой. Кассир бьёт чеки час, уверенный, что всё
    // уходит, а они копятся — и узнаёт об этом при закрытии смены,
    // когда сверка не сойдётся.
    //
    // Повторять каждые тридцать секунд тоже нельзя: сообщение закроет
    // товар, помешает пробивать, и кассир перестанет читать их вовсе —
    // а потом пропустит важное.
    if (!netWasDown) {
      netWasDown = true;
      toast('Связь пропала — чеки копятся и уйдут сами', true);
    }
  }
  updatePending();
}
/* Была ли связь в прошлый раз. Нужна, чтобы сказать о пропаже и
   возврате ПО ОДНОМУ разу, а не тридцать раз в минуту. */
let netWasDown = false;
function syncLoop() { trySync(); setInterval(trySync, 30000); }
async function updatePending() {
  const list = (await K.outboxPending()).data || [];
  const n = list.length;
  $('pendingLabel').textContent = n ? `не отправлено: ${n}` : '';
  $('pendingLabel').classList.toggle('warn', n > 0);

  // Автономный режим ограничен тремя сутками. Счётчик «не отправлено: 2»
  // не говорит главного — сколько ещё можно так работать. За два часа без
  // связи волноваться не о чем, а за двое суток — пора звать интернет.
  const el = $('offlineLabel');
  if (el) {
    const ts = list.map((e) => Date.parse(e.clientTs || 0)).filter((t) => t > 0);
    const oldest = ts.length ? Math.min(...ts) : 0;
    const hoursWaiting = oldest ? Math.floor((Date.now() - oldest) / 3600000) : 0;
    const left = 72 - hoursWaiting;
    const showIt = n > 0 && oldest > 0 && hoursWaiting >= 1;
    el.classList.toggle('hidden', !showIt);
    el.classList.toggle('bad', left <= 12);
    el.textContent = showIt
      ? (left > 0 ? `без связи ${hoursWaiting} ч · осталось ${left} ч` : 'автономные трое суток истекли')
      : '';
  }

  // Номер текущего чека: кассир называет его при возврате и при разборе
  // расхождений, и искать его в бумажной ленте — время при покупателях.
  const rc = $('receiptLabel');
  if (rc) rc.textContent = S.lastNumber ? 'Чек №' + S.lastNumber : '';
}
function setDot(ok) { $('syncDot').className = 'dot ' + (ok ? 'ok' : 'bad'); }

// ── Сообщения вместо системных окон ──────────────────────────────────
// Системное окно надо закрыть, и пока его не закрыли, очередь стоит.
// Сообщение появляется само и уходит само.
let toastTimer = null;
function toast(text, bad) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function focusScanner() {
  if (!$('modal').classList.contains('hidden')) return;
  if (paying) { $('pCash')?.focus(); return; }
  $('search')?.focus();
}

/**
 * ДИСПЛЕЙ ПОКУПАТЕЛЯ — отдельная страница display.html.
 *
 * В программе второго окна нет, и поддержки второго монитора не
 * написано. Поэтому дисплей открывается кнопкой как отдельное окно и
 * переносится на второй монитор средствами Windows — работает без
 * доработок в electron/.
 *
 * Касса только рассказывает ему состояние чека: сама страница ничего не
 * считает и никуда не пишет. Если её закрыть — на продаже это не
 * отражается никак.
 */
let dispWin = null;
function pushDisplay() {
  const total = cartTotal();
  let change = null, changeLabel = 'СДАЧА';
  if (paying && (payWay === 'cash' || payWay === 'mixed')) {
    const got = Number($('pCash')?.value || 0) + (payWay === 'mixed' ? Number($('pCard')?.value || 0) : 0);
    if (got >= total) change = got - total;
    else { change = total - got; changeLabel = 'НЕ ХВАТАЕТ'; }
  }
  const payload = {
    shop: S.store?.name || SET.receiptHeader || 'Магазин',
    items: cart.map((l) => ({ name: l.name, qty: l.qty, price: l.price, total: l.price * l.qty - (l.discount || 0) })),
    total, paying, change, changeLabel,
    note: cartDiscount ? 'Скидка на чек −' + money(cartDiscount) : '',
  };
  try { localStorage.setItem('tabys.display', JSON.stringify(payload)); } catch { /* нет хранилища — работает сообщение окну */ }
  try { if (dispWin && !dispWin.closed) dispWin.postMessage({ tabysDisplay: payload }, '*'); } catch { /* окно закрыли */ }
}

function openDisplay() {
  closeModal();
  dispWin = window.open(new URL('display.html', APP_BASE).href, 'tabysDisplay', 'width=1000,height=620');
  if (!dispWin) { toast('Окно дисплея не открылось', true); return; }
  toast('Дисплей открыт — перетащите его на второй монитор');
  setTimeout(pushDisplay, 400);
}

// ── Горячие клавиши: для кассы с клавиатурой ─────────────────────────
document.addEventListener('keydown', (e) => {
  if ($('scr-sale').classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    if (!$('modal').classList.contains('hidden')) { closeModal(); return; }
    if (paying) payClose();
    return;
  }
  if (!$('modal').classList.contains('hidden')) return;
  if (e.key === 'F2') { e.preventDefault(); $('btnPay').onclick(); }
  if (e.key === 'F4') { e.preventDefault(); padMode = 'qty'; padNum = ''; drawPad(); }
  if (e.key === 'F6') { e.preventDefault(); $('btnPrice').onclick(); }
  if (e.key === 'F8') { e.preventDefault(); padMode = 'sum'; padNum = ''; drawPad(); }
});

// Нажатия на цифры не должны забирать фокус у поиска: сканер «печатает»
// в него код и жмёт Enter, и если фокус уехал — код уйдёт в пустоту.
$('pad').addEventListener('mousedown', (e) => e.preventDefault());
$('padModes').addEventListener('mousedown', (e) => {
  if (!paying) e.preventDefault();
});

/* ═══════════════════════════════════════════════════════════════════
   ЭКРАННАЯ КЛАВИАТУРА (цифровая) ДЛЯ ЛИСТОВ

   Зачем: на кассовом планшете системной клавиатуры может не быть вовсе.
   Тогда кассир физически не может ввести сумму размена или пересчитать
   кассу при закрытии смены — работа встаёт.

   Урок соседнего проекта, слово в слово: у них один экран подключил
   клавиатуру, но ЗАБЫЛ ЕЁ ОТРИСОВАТЬ — поле молча не принимало ввод,
   и кассир не мог закрыть смену. Поэтому здесь клавиатура появляется
   САМА на любом числовом поле, а не подключается вручную к каждому.
   Забыть невозможно: нечего забывать.

   Единственное исключение — поля оплаты в правой колонке: там цифры и
   так стоят под рукой, постоянно и на одном месте (data-nokeypad).
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
    // Лист сдвигает содержимое правее, чтобы клавиатура не закрывала ни
    // подписи, ни кнопки: закрытая кнопка — это та же ситуация, что у
    // соседей: кассир не смог закрыть смену.
    document.body.classList.add('pad-on');
  };
  const hide = () => { pad?.classList.remove('on'); target = null; document.body.classList.remove('pad-on'); };

  // Ловим фокус на всех числовых полях — включая те, что появятся позже
  // (листы оплаты и смены создаются на лету).
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el?.tagName === 'INPUT' && el.getAttribute('inputmode') === 'numeric' && !el.hasAttribute('data-nokeypad')) show(el);
    else if (!el?.closest?.('.keypad-float')) hide();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.keypad-float') && e.target.getAttribute?.('inputmode') !== 'numeric') hide();
  });
})();
