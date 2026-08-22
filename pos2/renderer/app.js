/*
 * ЖИВАЯ КАССА: связывает всё воедино.
 *
 * Здесь нет правил — только связи. Каждое правило живёт в своём файле
 * и проверено отдельно; здесь они соединяются в работающую кассу.
 *
 * ПОРЯДОК ЗАПУСКА:
 *   читаем настройки и состояние с диска;
 *   решаем, какой экран показать — по состоянию, а не по порядку;
 *   заводим кольцо отправки, замок простоя и канарейку.
 */

(function () {
  // ── Состояние в памяти ─────────────────────────────────────────
  let SET = {};          // настройки
  let S = {};            // состояние: привязка, кассир, смена
  let CATALOG = [];      // товары
  let cart = [];         // текущий чек
  let cartDiscount = 0;
  let tab = null;        // вкладка каталога
  let query = '';        // строка поиска

  const $ = (id) => document.getElementById(id);
  const app = () => $('app');
  const money = (v) => num(v) + ' ₸';

  const watch = makeNetWatch((m, kind) => toast($('toasts'), m, kind === 'ok' ? 'ok' : 'warn'));

  /* Канарейка ставится ПЕРВОЙ: если касса упадёт на запуске, мы всё
     равно узнаем. */
  const crash = makeCrashReporter({
    fetchIt: (u, o) => fetch(u, o),
    getSettings: async () => SET,
    getState: async () => S,
  });
  crash.wire(window);

  // ── Показ экранов ──────────────────────────────────────────────
  function go(name, ctx) {
    // Уборка прошлого экрана: снимаем его обработчики клавиш.
    const el = app();
    if (el.__cleanup) { try { el.__cleanup(); } catch { /* уже убран */ } el.__cleanup = null; }
    const r = show(name, S, ctx || {});
    if (!r.ok) toast($('toasts'), r.reason, 'warn');
    return r;
  }

  // ── Сборщики экранов ───────────────────────────────────────────
  screen('setup', (state, ctx) => buildSetup(app(), state, {
    version: SET.version,
    onPair: async (code) => {
      const p = await pairDevice({ ask, settings: SET, code, version: SET.version });
      S = (await K.saveState({
        deviceToken: p.deviceToken, deviceId: p.deviceId, accountId: p.accountId,
        cashRegisterId: p.cashRegisterId, storeName: p.storeName,
        registerName: p.registerName,
      })).data;
      toast($('toasts'), `Касса привязана: ${S.storeName}`);
      await pullCatalog();
      go('pin');
    },
  }));

  screen('pin', (state) => buildPin(app(), state, {
    onPin: async (pin) => {
      const r = await login({ ask, store: K, settings: SET,
        deviceToken: S.deviceToken, pin });
      if (!r.ok) return r;
      S = (await K.saveState({ employee: r.employee })).data;
      idle.unlock();
      go(S.shift ? 'sale' : 'shift');
      return { ok: true };
    },
    /* ОТВЯЗАТЬ КАССУ. Найдено вами: касса стояла на «Введите свой
       код», а кодов нет — и выхода не было, кроме поиска файлов.

       Стираем ТОЛЬКО привязку: чеки и очередь не трогаем — в них
       лежат деньги, и они уйдут, когда кассу привяжут снова. */
    onReset: async () => {
      const сколько = ((await K.outboxPending()).data || []).length;

      const да = await askSure($('modal'), {
        title: 'Отвязать кассу от магазина?',
        text: (сколько
          ? `Не отправлено чеков: ${сколько}. Они СОХРАНЯТСЯ и уйдут, когда `
            + 'кассу привяжут снова.\n\n'
          : '')
          + 'Кассу придётся привязывать заново — кодом из кабинета.',
        yes: 'Отвязать', danger: true,
      });
      if (!да) return;

      await forgetPairing(K);
      S = (await K.getState()).data;
      CATALOG = [];
      cart = []; cartDiscount = 0;
      toast($('toasts'), 'Касса отвязана — введите код из кабинета');
      go('setup');
    },

    onClockOut: async (pin) => {
      const r = await clockOut({ ask, settings: SET, deviceToken: S.deviceToken, pin });
      toast($('toasts'), r.ok
        ? farewellText(r.name, r.workedMin)
        : r.said, r.ok ? 'ok' : 'warn');
      return r.ok ? { ok: true } : r;
    },
  }));

  screen('shift', (state) => buildShift(app(), state, {
    money,
    onOpen: async (float) => {
      await openShift({ store: K, openingCash: float, newId });
      S = (await K.getState()).data;
      go('sale');
    },
    onClose: async (fact) => {
      const c = await closeShift({ store: K, state: S, factCash: fact, newId });
      S = (await K.getState()).data;
      toast($('toasts'), c.diff === 0 ? 'Смена закрыта, сходится'
        : `Смена закрыта · ${c.diff > 0 ? 'излишек' : 'не хватает'} ${money(Math.abs(c.diff))}`);
      go('pin');
    },
  }));

  /* ИМЕНА ДОЛЖНЫ СХОДИТЬСЯ. Найдено запуском: экран ждал goods, а
     связка слала catalog — и экран продажи выходил ПУСТЫМ.
     Проверки этого не видели: экран проверялся своим набором, а связка
     не проверялась вовсе. */
  screen('sale', (state) => {
    /* ВЕРХНЯЯ СТРОКА: где мы, кто за кассой, жива ли связь. Кассир
       видит это, не отрывая рук от товара. */
    buildTopBar($('topbar'), state, {
      netDown: watch.isDown, pending: pendingCount, rejected: rejectedCount, money,
      onMenu: () => openMenu(),
      onLock: () => { $('lock').classList.remove('hidden'); go('locked'); },
    });
    return buildSale(app(), state, {
    // То, что видно сейчас: вкладка или найденное.
    goods: pickGoods(CATALOG, { tab, query }),
    cart, cartDiscount, tab, query, money,
    tabs: catTabs(CATALOG),
    /* ПОЛОСА МАРОК. Кассир видит состояние, не считая строки глазами.
       Имя свёртки — marksReady: найдено запуском, связка звала
       несуществующее markBar и падала молча. */
    markBar: (() => {
      const есть = (cart || []).some((l) => l.marked);
      if (!есть) return null;
      const r = marksReady(cart);
      return r.ok
        ? { kind: 'ok', title: 'Марки собраны',
            note: 'Коды уйдут в чеке и выведут товар из оборота' }
        : { kind: 'need', title: `Нужно марок: ${r.left}`,
            note: 'Отсканируйте Data Matrix на каждой штуке — без кода чек нельзя' };
    })(),

    onTab: (t) => { tab = t; query = ''; go('sale'); },
    onSearch: (q) => { query = q; go('sale'); },
    onPick: (g, qty) => { addToCart(cart, g, qty || 1, newId); go('sale'); },

    /* ПРАВКА СТРОКИ ЧЕКА. Уменьшение идёт через одну дверь: там же
       снимаются марки. Иначе убрали бутылку, а марка осталась и ушла
       бы в налоговую как проданная. */
    onLine: async (i, act) => {
      const l = cart[i];
      if (!l) return;
      const было = l.qty;
      const стало = act === 'plus' ? было + 1 : было - 1;

      const r = await setQty(cart, l, стало, {
        allow: (действие) => allow(действие, {
          settings: SET, employee: S.employee,
          askPin: async (t) => askPinFor(t),
          ask, store: K, deviceToken: S.deviceToken,
        }),
        trimMarks,
      });

      if (!r.ok && r.said) toast($('toasts'), r.said, 'warn');
      go('sale');
    },
    onPay: () => {
      /* БЕЗ МАРОК К ОПЛАТЕ НЕ ПУСКАЕМ, и отказ НАЗЫВАЕТ ТОВАР: узнать
         об этом после того, как покупатель достал деньги, хуже всего. */
      const r = marksReady(cart);
      if (!r.ok) { toast($('toasts'), r.said, 'warn'); return; }

      /* ПРОВЕРКА ВОЗРАСТА. Спрашиваем ОДИН РАЗ за чек, при закрытии:
         дёргать на каждой бутылке значит злить и кассира, и очередь.
         В Казахстане продажа табака и алкоголя несовершеннолетнему —
         штраф до 200 МРП на продавца ЛИЧНО. */
      const в = ageCheck(cart);
      if (в.need) {
        askAge(в);
        return;
      }

      go('pay');
    },

    /* ── КНОПКИ ПРИ ПОКУПАТЕЛЕ ──────────────────────────────────── */
    onPrice: () => priceCheck(),
    onDiscount: () => askDiscount(),
    onPark: () => parkNow(),
    onClear: async () => {
      const да = await askSure($('modal'), {
        title: 'Очистить чек?',
        text: `В чеке ${cart.length} ${plural(cart.length, 'позиция', 'позиции', 'позиций')}. `
          + 'Они пропадут — отложите чек, если он ещё нужен',
        yes: 'Очистить', danger: true,
      });
      if (!да) return;
      cart = []; cartDiscount = 0;
      go('sale');
    },
    });
  });

  screen('pay', () => buildPay(app(), S, {
    due: cartTotal(cart, cartDiscount),
    ways: WAYS, lastWay: lastWay(SET), tenderOptions, money,
    onBack: () => go('sale'),
    onPay: (d) => finishSale(d),
  }));

  screen('paid', (state, ctx) => buildPaid($('paid'), ctx.view, {
    money,
    onDone: () => { $('paid').classList.add('hidden'); go('sale'); },
  }));

  screen('locked', (state) => buildLock($('lock'), state, {
    onUnlock: async (pin) => {
      /* Замку тот же путь входа, что и экрану кода: сперва сервер,
         не вышло — пропуск с диска. Иначе касса, заперевшаяся ДО
         первого входа, не отпирается ничем. */
      const r = await unlock({ pin, state: S, store: K,
        deviceToken: S.deviceToken, offlineLogin,
        login, ask, settings: SET });
      if (!r.ok) return r;
      if (r.changed) {
        S = (await K.saveState({ employee: r.employee })).data;
        toast($('toasts'), r.said);
      }
      $('lock').classList.add('hidden');
      idle.unlock();
      go(S.shift ? 'sale' : 'shift');
      return { ok: true };
    },
  }));

  /* ОКНО КОДА СТАРШЕГО. Кассир жмёт «убрать позицию», а прав нет —
     зовём старшего его же клавиатурой, той, что он знает. */
  function askPinFor(title) {
    return new Promise((resolve) => {
      const root = $('modal');
      openModal(root, `
        <h2>${title}</h2>
        <p class="muted">Нужен код старшего смены</p>
        <div class="dots" id="apDots"></div>
        <div class="gate-err" id="apErr"></div>
        <div class="keypad" id="apPad"></div>
        <div class="row-actions"><button id="apNo">Отмена</button></div>`,
        () => resolve(null));

      let pin = '';
      const dots = root.querySelector('#apDots');
      const draw = () => {
        dots.innerHTML = [0, 1, 2, 3]
          .map((i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
      };

      const pad = root.querySelector('#apPad');
      for (const k of ['1','2','3','4','5','6','7','8','9','C','0','⌫']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = k;
        b.className = (k === 'C' || k === '⌫') ? 'kb-aux' : '';
        b.onclick = () => {
          if (k === 'C') pin = '';
          else if (k === '⌫') pin = pin.slice(0, -1);
          else if (pin.length < 4) pin += k;
          draw();
          if (pin.length === 4) { const код = pin; closeModal(root); resolve(код); }
        };
        pad.appendChild(b);
      }
      root.querySelector('#apNo').onclick = () => { closeModal(root); resolve(null); };
      draw();
    });
  }

  /* ═══ МЕНЮ КАССЫ ══════════════════════════════════════════════
   *
   * НАЙДЕНО ВАМИ: касса умела всё — отложенные чеки, возвраты, отчёты,
   * инкассацию, перепечатку — и НЕ ПОКАЗЫВАЛА НИЧЕГО. Девятнадцать дел
   * без единой кнопки, которая к ним ведёт.
   *
   * Проверки этого не видели: они зовут свёртки напрямую, минуя экран.
   */
  let pendingCount = 0;
  let rejectedCount = 0;

  function openMenu() {
    buildMenu($('modal'), { ...S, lang: SET.lang }, {
      openSheet, closeModal, money,
      hasCart: cart.length, parked: (S.parked || []).length, rejected: rejectedCount,
      on: (дело) => делай(дело),
    });
  }

  async function делай(дело) {
    switch (дело) {
      case 'park': return parkNow();
      case 'unpark': return openParked();
      case 'discount': return askDiscount();
      case 'reprint': return reprintLast();

      case 'refund': return openRefund();
      case 'cash_in': case 'cash_out': case 'collection': return askCashMove(дело);
      case 'drawer': return openDrawerNow();

      case 'xreport': return printReport('x');
      case 'shift_close': return go('shift');
      case 'rejected': return openRejected();

      case 'printer': return openPrinterSheet();
      case 'log': return K.openLog().catch(() => toast($('toasts'), 'Журнал не открылся', 'warn'));
      case 'lang': return switchLang();
      case 'keys': return openKeysHelp();
      case 'price': return priceCheck();
      case 'logout': return logoutNow();
      default: return null;
    }
  }

  /* ── ВОЗРАСТ ──────────────────────────────────────────────────
   *
   * Окно с ДВУМЯ РАВНЫМИ кнопками. Не «да/отмена»: отказ — это не
   * ошибка кассира, а обычный ход дела. Покупатель без документа или
   * младше — товар снимается, остальное пробивается.
   */
  function askAge(в) {
    const card = openSheet($('modal'), {
      title: 'Спросите документ',
      html: `
        <div class="age-what">${esc(в.what.join(', '))}</div>
        <div class="age-year">${в.bornBefore}</div>
        <p class="muted">год рождения или раньше — тогда можно продавать.
          Продажа с ${в.years} лет.</p>
        <div class="row-actions">
          <button id="ageNo" class="bad">Нет документа</button>
          <button id="ageYes" class="primary">Проверил, всё верно</button>
        </div>`,
    });

    card.querySelector('#ageYes').onclick = () => {
      closeModal($('modal'));
      go('pay');
    };

    card.querySelector('#ageNo').onclick = () => {
      const r = ageAnswer(cart, false);
      cart = r.cart;
      closeModal($('modal'));
      toast($('toasts'), r.said, 'warn');
      go('sale');
    };
  }

  /* ── ПРОВЕРКА ЦЕНЫ ────────────────────────────────────────────
   *
   * Покупатель подходит: «сколько стоит?» Кассир подносит товар к
   * сканеру и ВИДИТ ЦЕНУ, не пробивая его.
   *
   * Без этого товар сразу падает в чек, и его надо убирать — а на
   * отмену может понадобиться старший. Это случается по десять раз за
   * смену: ценник оторвался, покупатель сомневается, товар с полки без
   * цены.
   */
  let ценаЖдёт = false;

  function priceCheck() {
    ценаЖдёт = true;

    const card = openSheet($('modal'), {
      title: 'Сколько стоит?',
      html: `
        <p class="muted">Поднесите товар к сканеру — цена покажется здесь.
          В чек он НЕ попадёт.</p>
        <div id="pcOut" class="pc-empty">жду товар…</div>
        <div class="row-actions"><button id="pcClose">Закрыть</button></div>`,
      onClose: () => { ценаЖдёт = false; },
    });

    card.querySelector('#pcClose').onclick = () => {
      ценаЖдёт = false;
      closeModal($('modal'));
    };
  }

  /** Показать цену отсканированного, не трогая чек. */
  function showPrice(code) {
    const out = $('modal').querySelector('#pcOut');
    if (!out) return;

    const r = resolveScan(code, CATALOG, { prefixes: SET.scalePrefixes });
    if (!r.ok) {
      out.className = 'pc-bad';
      out.textContent = r.said;
      return;
    }

    const g = r.good;
    const весовой = r.from === 'весы';
    out.className = 'pc-good';
    out.innerHTML = `
      <div class="pc-name">${esc(g.name)}</div>
      <div class="pc-price">${money(g.price)}${весовой ? ' за кг' : ''}</div>
      ${весовой
        ? `<div class="pc-note">${String(r.qty).replace('.', ',')} кг → `
          + `${money(Math.round(g.price * r.qty))}</div>`
        : ''}
      ${g.marked ? '<div class="pc-note">нужна марка при продаже</div>' : ''}`;
  }

  /* ── ОТЛОЖЕННЫЕ ЧЕКИ ──────────────────────────────────────────── */
  async function parkNow() {
    /* Свёртка сама пишет в хранилище: чек должен лечь на диск ДО того,
       как исчезнет с экрана. Иначе касса перезапустится, пока
       покупатель ходит за деньгами, и чек пропадёт. */
    const r = await parkCart(K, cart, { newId, who: S.employee && S.employee.name });
    if (!r.ok) { toast($('toasts'), r.said, 'warn'); return; }
    S = (await K.getState()).data;
    cart = []; cartDiscount = 0;
    toast($('toasts'), 'Чек отложен — касса свободна');
    go('sale');
  }

  async function openParked() {
    /* СПИСОК БЕРЁМ С ДИСКА, а не из памяти.
     *
     * parkCart пишет ПРЯМО НА ДИСК — так и надо: чек должен лечь до
     * того, как исчезнет с экрана. Но в памяти его нет, пока не
     * перечитаем.
     *
     * Кассир откладывал чек, тут же открывал «Отложенные» — и видел
     * старый список, а на живой чек получал «Этот чек уже забрали». */
    S = (await K.getState()).data || S;
    const список = S.parked || [];
    if (!список.length) { toast($('toasts'), 'Отложенных чеков нет', 'warn'); return; }

    /* СТАРЫЙ ЧЕК СЧИТАЕМ САМИ. Свёртки staleParked нет — связка звала
       несуществующее, и окно НЕ ОТКРЫВАЛОСЬ ВОВСЕ: падало молча, а
       кассир видел пустоту.

       Два часа: за это время покупатель либо вернулся, либо ушёл
       насовсем. Не удаляем — вдруг это заказ, который ждут. Решает
       кассир. */
    const ДАВНО_МС = 2 * 60 * 60 * 1000;
    const давно = (p) => p.at && (Date.now() - new Date(p.at).getTime()) > ДАВНО_МС;

    const html = список.map((p) => `
      <button class="menu-item" data-take="${p.id}">
        <span class="menu-name">${new Date(p.at).toLocaleTimeString('ru-RU',
          { hour: '2-digit', minute: '2-digit' })} · ${(p.lines || []).length} ${
          plural((p.lines || []).length, 'позиция', 'позиции', 'позиций')} · ${money(p.total)}</span>
        <span class="menu-hint">${давно(p)
          ? 'Отложен давно — покупатель мог не вернуться' : 'Забрать обратно'}</span>
      </button>`).join('');

    const card = openSheet($('modal'), { title: 'Отложенные чеки', html: `<div class="menu">${html}</div>` });
    card.querySelectorAll('[data-take]').forEach((b) => {
      b.onclick = async () => {
        if (cart.length) {
          const да = await askSure($('modal'), {
            title: 'В кассе уже есть чек',
            text: 'Он пропадёт. Сперва отложите его или закройте',
            yes: 'Заменить', danger: true,
          });
          if (!да) return;
        }
        /* Свёртка САМА ходит в хранилище и отдаёт lines, а не cart.
           Связка звала её по-старому — чек не возвращался. */
        const r = await unparkCart(K, b.dataset.take);
        if (!r.ok) { toast($('toasts'), r.said, 'warn'); return; }
        cart = r.lines;
        cartDiscount = 0;
        S = (await K.getState()).data;
        closeModal($('modal'));
        go('sale');
      };
    });
  }

  /* ── СКИДКА НА ЧЕК ────────────────────────────────────────────── */
  function askDiscount() {
    const база = cartTotal(cart, 0);
    if (!база) { toast($('toasts'), 'Чек пуст — скидывать не с чего', 'warn'); return; }

    const cap = capFor({ shopMaxPct: SET.discountMaxPct, employee: S.employee });
    const подсказка = capHint({ base: база, capPct: cap,
      employee: S.employee, shopMaxPct: SET.discountMaxPct });

    const card = openSheet($('modal'), {
      title: 'Скидка на чек',
      html: `
        <p class="muted">В чеке ${money(база)}${подсказка ? `<br>${подсказка}` : ''}</p>
        <div class="pay-notes" id="dcPre"></div>
        <input id="dcSum" class="field" inputmode="numeric" placeholder="сумма скидки">
        <div class="gate-err" id="dcErr"></div>
        <div class="row-actions">
          <button id="dcOff">Убрать скидку</button>
          <button id="dcGo" class="primary">Применить</button>
        </div>`,
    });

    const поле = card.querySelector('#dcSum');
    const ряд = card.querySelector('#dcPre');
    const err = card.querySelector('#dcErr');

    /* ОБЫЧНЫЕ СКИДКИ КНОПКАМИ: кассир жмёт одну вместо набора цифр.
       Процент переводим в СУММУ сразу — их правило: иначе она поплывёт,
       когда в чек добавят товар. */
    for (const p of PRESETS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p + '%';
      b.onclick = () => { поле.value = String(pctToAmount(база, p)); err.textContent = ''; };
      ряд.appendChild(b);
    }

    card.querySelector('#dcOff').onclick = async () => {
      cartDiscount = 0; closeModal($('modal')); go('sale');
    };

    card.querySelector('#dcGo').onclick = async () => {
      const r = checkDiscount(Number(поле.value) || 0, { base: база, capPct: cap });
      if (!r.ok) {
        if (!r.needSenior) { err.textContent = r.said; return; }
        /* СВЕРХ ПОТОЛКА — не отказ, а «нужен старший». Разница важна:
           отказ кассир воспримет как поломку. */
        const pin = await askPinFor('Скидка сверх вашего предела');
        if (!pin) return;
        const a = await approveByPin(pin, { ask, store: K,
          deviceToken: S.deviceToken, settings: SET, action: 'discount' });
        if (!a.ok) { err.textContent = a.said; return; }
        if (a.offlineNote) toast($('toasts'), a.offlineNote, 'warn');
      }
      cartDiscount = Math.round(Number(поле.value) || 0);
      closeModal($('modal'));
      go('sale');
    };

    setTimeout(() => поле.focus(), 0);
  }

  /* ── ДЕНЬГИ МИМО ЧЕКОВ ────────────────────────────────────────── */
  function askCashMove(вид) {
    const имя = MOVE_NAME[вид] || вид;
    const card = openSheet($('modal'), {
      title: имя,
      html: `
        <p class="muted">В ящике сейчас ${money(S.cashInDrawer || 0)}</p>
        <input id="cmSum" class="field" inputmode="numeric" placeholder="сумма">
        ${вид === 'cash_out'
          ? '<input id="cmNote" class="field" placeholder="на что взяли — обязательно">'
          : ''}
        <div class="gate-err" id="cmErr"></div>
        <div class="row-actions"><button id="cmGo" class="primary">Записать</button></div>`,
    });

    const поле = card.querySelector('#cmSum');
    const примечание = card.querySelector('#cmNote');
    const err = card.querySelector('#cmErr');

    card.querySelector('#cmGo').onclick = async () => {
      /* ПРИЧИНА ОБЯЗАТЕЛЬНА ДЛЯ ИЗЪЯТИЯ. «Взяли 5 000» без слов — дыра
         в отчёте, и виноватым окажется кассир. */
      if (вид === 'cash_out' && !(примечание.value || '').trim()) {
        err.textContent = 'Напишите, на что взяли — иначе в отчёте будет дыра';
        return;
      }

      const r = buildCashMove({ type: вид, amount: Number(поле.value) || 0,
        note: примечание ? примечание.value : '', state: S, newId });
      if (!r.ok) { err.textContent = r.said; return; }

      await K.outboxAdd({ id: r.move.id, entity: 'cash_move', entityId: r.move.id,
        op: 'insert', payload: r.move, clientTs: r.move.at });
      S = (await K.saveState({
        cashInDrawer: (S.cashInDrawer || 0) + r.move.delta })).data;

      closeModal($('modal'));
      toast($('toasts'), `${имя}: ${money(r.move.amount)} · в ящике ${money(S.cashInDrawer)}`);
      sync.once();
      go('sale');
    };
    setTimeout(() => поле.focus(), 0);
  }

  async function openDrawerNow() {
    const r = await K.openDrawer();
    toast($('toasts'), r && r.ok ? 'Ящик открыт'
      : (r && r.error) || 'Ящик не открылся — проверьте принтер', r && r.ok ? 'ok' : 'warn');
  }

  /* ── ОТЧЁТЫ ───────────────────────────────────────────────────── */
  async function printReport(вид) {
    const чеки = ((await K.receiptsRecent(500)).data) || [];
    const свод = reportSummary({ receipts: чеки, moves: [], shift: S.shift, state: S });
    const lines = reportLines(вид, { summary: свод, shift: S.shift, state: S,
      width: SET.printWidth === 32 ? 32 : 48 });
    try {
      await K.print(lines, { title: вид === 'z' ? 'Z-отчёт' : 'X-отчёт' });
      toast($('toasts'), вид === 'z' ? 'Z-отчёт напечатан' : 'X-отчёт напечатан · смена продолжается');
    } catch (e) {
      toast($('toasts'), (e && e.message) || 'Не вышло напечатать', 'warn');
    }
  }

  /* ── ЧЕКИ, КОТОРЫХ НЕТ В ОТЧЁТЕ ───────────────────────────────── */
  async function openRejected() {
    const список = ((await K.rejectedAll()).data) || [];
    if (!список.length) { toast($('toasts'), 'Все чеки приняты сервером'); return; }

    const html = список.map((r) => `
      <div class="menu-item" style="cursor:default">
        <span class="menu-name">Чек №${r.number ?? '—'} · ${money(r.total || 0)}</span>
        <span class="menu-hint">${esc(r.reason || 'сервер не принял')}</span>
      </div>`).join('');

    openSheet($('modal'), {
      title: `Сервер не принял: ${список.length}`,
      html: `<p class="muted">Деньги за эти чеки в ящике, а в отчёте владельца их нет. `
        + `Покажите ему этот список.</p><div class="menu">${html}</div>`,
    });
  }

  /* ── ПЕЧАТЬ ───────────────────────────────────────────────────── */
  async function reprintLast() {
    const чеки = ((await K.receiptsRecent(1)).data) || [];
    if (!чеки.length) { toast($('toasts'), 'Печатать нечего — чеков ещё не было', 'warn'); return; }
    try {
      await K.print(receiptLines(чеки[0], { width: SET.printWidth === 32 ? 32 : 48 }),
        { title: `повтор чека №${чеки[0].number}` });
      toast($('toasts'), `Чек №${чеки[0].number} напечатан заново`);
    } catch (e) {
      toast($('toasts'), (e && e.message) || 'Не вышло напечатать', 'warn');
    }
  }

  async function openPrinterSheet() {
    const r = await K.printers();
    const список = (r && r.data) || [];

    const html = список.length ? список.map((p) => `
      <button class="menu-item" data-pr="${esc(p.name)}">
        <span class="menu-name">${esc(p.name)}${p.name === SET.printer ? ' ✓' : ''}</span>
        <span class="menu-hint">${p.virtual
          ? 'ПЕЧАТЬ В ФАЙЛ — чеки на бумагу НЕ выйдут'
          : 'чековый принтер'}</span>
      </button>`).join('')
      : '<p class="muted">Принтеров не найдено. Проверьте, что он включён и установлен в Windows</p>';

    const card = openSheet($('modal'), { title: 'Настройки печати',
      html: `<div class="menu">${html}</div>
        <div class="row-actions"><button id="prTest">Пробная печать</button></div>` });

    card.querySelectorAll('[data-pr]').forEach((b) => {
      b.onclick = async () => {
        SET = (await K.saveSettings({ printer: b.dataset.pr })).data;
        closeModal($('modal'));
        toast($('toasts'), `Принтер: ${SET.printer}`);
      };
    });

    card.querySelector('#prTest').onclick = async () => {
      try {
        await K.print([{ text: 'ПРОБНАЯ ПЕЧАТЬ', type: 'center', bold: true },
          { text: new Date().toLocaleString('ru-RU'), type: 'center' },
          { text: '' }, { text: '' }], { title: 'проба' });
        toast($('toasts'), 'Если бумага вышла — принтер настроен');
      } catch (e) {
        toast($('toasts'), (e && e.message) || 'Не вышло напечатать', 'warn');
      }
    };
  }

  /* ── ЯЗЫК И КЛАВИШИ ───────────────────────────────────────────── */
  async function switchLang() {
    const был = SET.lang === 'kz' ? 'kz' : 'ru';
    SET = (await K.saveSettings({ lang: был === 'kz' ? 'ru' : 'kz' })).data;
    toast($('toasts'), SET.lang === 'kz'
      ? 'Тіл: қазақша. Чек әрқашан орысша басылады'
      : 'Язык: русский. Чек всегда печатается по-русски');
    go('sale');
  }

  function openKeysHelp() {
    const html = hotkeyHelp().map((k) => `
      <div class="menu-item" style="cursor:default">
        <span class="menu-name">${esc(k.key)}</span>
        <span class="menu-hint">${esc(k.name)}</span>
      </div>`).join('');
    openSheet($('modal'), { title: 'Горячие клавиши',
      html: `<p class="muted">Работают, когда курсор не в поле ввода</p>
        <div class="menu">${html}</div>` });
  }

  /* ── ВЫХОД ────────────────────────────────────────────────────── */
  async function logoutNow() {
    const план = planLogout({ cart, state: S });
    if (план.warnings.length) {
      const да = await askSure($('modal'), {
        title: 'Выйти из кассы?',
        text: план.warnings.map((w) => w.said).join('\n\n'),
        yes: 'Выйти', danger: true,
      });
      if (!да) return;
    }
    cart = []; cartDiscount = 0;
    S = (await K.saveState({ employee: null })).data;
    go('pin');
  }

  /* ── ВОЗВРАТ ──────────────────────────────────────────────────── */
  async function openRefund() {
    const чеки = ((await K.receiptsRecent(30)).data) || [];
    /* ВОЗВРАТ ВОЗВРАТА НЕ ДЕЛАЮТ.
     *
     * Найдено на боевом сервере: кассир вернул чек, который сам был
     * возвратом. Список отсеивал по полю «kind», а возврат помечен
     * «isRefund» — фильтр не работал ВОВСЕ.
     *
     * Сервер такое запрещает: «Нельзя вернуть возврат». Но касса должна
     * не давать этого сделать, а не полагаться на отказ сервера —
     * кассир к тому времени уже отдал бы деньги из ящика. */
    const продажи = чеки.filter((r) => !r.isRefund && r.kind !== 'refund'
      && !r.ofReceiptId);
    if (!продажи.length) { toast($('toasts'), 'Чеков этой кассы ещё нет', 'warn'); return; }

    const html = продажи.map((r) => `
      <button class="menu-item" data-rec="${r.id}">
        <span class="menu-name">Чек №${r.number} · ${money(r.total)}</span>
        <span class="menu-hint">${new Date(r.at).toLocaleString('ru-RU',
          { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          · ${(r.items || []).length} поз.</span>
      </button>`).join('');

    const card = openSheet($('modal'), { title: 'Возврат — выберите чек',
      html: `<div class="menu">${html}</div>` });

    card.querySelectorAll('[data-rec]').forEach((b) => {
      b.onclick = () => {
        const чек = продажи.find((r) => r.id === b.dataset.rec);
        closeModal($('modal'));
        refundLines2(чек);
      };
    });
  }

  /** Что именно возвращаем из чека. */
  function refundLines2(чек) {
    const html = (чек.items || []).map((it, i) => `
      <div class="cart-row">
        <div class="cart-name">${esc(it.name)}</div>
        <div class="cart-qty">
          <button data-m="${i}">−</button>
          <span data-q="${i}">0</span>
          <button data-p="${i}">+</button>
        </div>
        <div class="cart-sum">${money(Math.round(it.price * it.qty))}</div>
      </div>`).join('');

    const выбор = (чек.items || []).map(() => 0);

    /* ДЕНЬГИ ВОЗВРАЩАЮТСЯ ТЕМ ЖЕ ПУТЁМ, КАКИМ ПРИШЛИ.
     *
     * Было: возврат ВСЕГДА наличными, чем бы ни платили. Покупатель
     * платил картой 5 000 и получал живые деньги из ящика.
     *
     * Ящик пустел, а по карте деньги оставались у магазина — кассир не
     * сдавал смену. И это подарок покупателю: так обналичивают карты.
     *
     * Подставляем ТОТ способ, чем платили. Но кассир может сменить:
     * бывает, терминал не отвечает и владелец велит отдать наличными. */
    const чемПлатили = чек.way === 'mixed'
      ? (чек.card > 0 ? 'card' : 'cash')
      : (чек.way || 'cash');

    let способ = чемПлатили;
    let причина = REASONS[0];

    const card = openSheet($('modal'), {
      title: `Возврат по чеку №${чек.number}`,
      html: `${html}

        <div class="rf-block">
          <div class="rf-title">Куда вернуть</div>
          <div class="rf-ways" id="rfWays"></div>
          <div class="rf-note" id="rfWayNote"></div>
        </div>

        <div class="rf-block">
          <div class="rf-title">Причина</div>
          <div class="rf-reasons" id="rfReasons"></div>
        </div>

        <div class="gate-err" id="rfErr"></div>
        <div class="row-actions"><button id="rfGo" class="bad">Вернуть деньги</button></div>`,
    });

    /* СПОСОБЫ ВОЗВРАТА. «В долг» и «смешанно» не показываем: долг
       прощают правкой в кабинете, а смешанный возврат — это два
       возврата, и кассир запутается при очереди. */
    const рядСпособов = card.querySelector('#rfWays');
    const заметка = card.querySelector('#rfWayNote');

    const покажиЗаметку = () => {
      заметка.textContent = способ === чемПлатили
        ? `Чек оплачен ${wayBy(чемПлатили)} — возвращаем туда же`
        : `ВНИМАНИЕ: платили ${wayBy(чемПлатили)}, `
          + `а вернуть хотите ${wayBy(способ)}`;
      заметка.className = 'rf-note' + (способ === чемПлатили ? '' : ' warn');
    };

    for (const w of ['cash', 'card', 'qr']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = wayName(w);
      b.className = w === способ ? 'on' : '';
      b.onclick = () => {
        способ = w;
        [...рядСпособов.children].forEach((x) => {
          x.className = x.textContent === wayName(w) ? 'on' : '';
        });
        покажиЗаметку();
      };
      рядСпособов.appendChild(b);
    }
    покажиЗаметку();

    /* ПРИЧИНА — КНОПКАМИ, а не вписана намертво. Владелец читает её в
       отчёте: «брак» и «покупатель передумал» значат для него разное. */
    const рядПричин = card.querySelector('#rfReasons');
    for (const r of REASONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r;
      b.className = r === причина ? 'on' : '';
      b.onclick = () => {
        причина = r;
        [...рядПричин.children].forEach((x) => {
          x.className = x.textContent === r ? 'on' : '';
        });
      };
      рядПричин.appendChild(b);
    }

    const draw = () => выбор.forEach((v, i) => {
      card.querySelector(`[data-q="${i}"]`).textContent = String(v);
    });

    card.querySelectorAll('[data-p]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.p);
        const мах = чек.items[i].qty - (чек.items[i].returned || 0);
        выбор[i] = Math.min(мах, выбор[i] + 1);
        draw();
      };
    });
    card.querySelectorAll('[data-m]').forEach((b) => {
      b.onclick = () => { const i = Number(b.dataset.m); выбор[i] = Math.max(0, выбор[i] - 1); draw(); };
    });

    card.querySelector('#rfGo').onclick = async () => {
      const план = planRefund(чек, выбор);
      const err = card.querySelector('#rfErr');
      if (!план.ok) { err.textContent = план.said; return; }

      /* ВОЗВРАТ — ДЕНЬГИ ИЗ КАССЫ. Спрашиваем разрешение по правилу
         магазина: это самое опасное действие за смену. */
      const a = await allow('refund', {
        settings: SET, employee: S.employee,
        askPin: (t) => askPinFor(t), ask, store: K, deviceToken: S.deviceToken,
      });
      if (!a.ok) { if (a.said) err.textContent = a.said; return; }

      /* ХВАТАЕТ ЛИ ДЕНЕГ — спрашиваем ТОЛЬКО для наличных: на карту
         возвращают через терминал, ящик при этом не трогают. */
      if (способ === 'cash') {
        const хватит = cashEnough(S.cashInDrawer || 0, план.total);
        if (!хватит.ok) { err.textContent = хватит.said; return; }
      }

      const r = buildRefund({ receipt: чек, plan: план, reason: причина,
        way: способ, approval: a, state: S, newId });

      await K.receiptAdd(r);
      await K.outboxAdd({ id: r.id, entity: 'refund', entityId: r.id,
        op: 'insert', payload: r, clientTs: r.at });
      S = (await K.saveState({ lastNumber: r.number,
        cashInDrawer: (S.cashInDrawer || 0) + (r.cashDelta || 0) })).data;

      try { await K.print(receiptLines(r, { width: SET.printWidth === 32 ? 32 : 48 }), { title: 'возврат' }); }
      catch { toast($('toasts'), 'Возврат прошёл, но чек не напечатался', 'warn'); }

      closeModal($('modal'));
      /* Говорим, КУДА вернули: кассир диктует это покупателю, а «на
         карту» значит «ждите два-три дня». */
      toast($('toasts'), способ === 'cash'
        ? `Возврат ${money(план.total)} наличными · в ящике ${money(S.cashInDrawer)}`
        : `Возврат ${money(план.total)} ${wayBy(способ)} — `
          + 'деньги придут в течение двух-трёх дней');
      sync.once();
      go('sale');
    };

    draw();
  }

  // ── Продажа доводится до конца ─────────────────────────────────
  async function finishSale({ way, cash, card }) {
    const due = cartTotal(cart, cartDiscount);
    const receipt = buildReceipt({ cart, cartDiscount, way, cash, card, due,
      state: S, newId });

    /* СПЕРВА НА ДИСК, потом печать и отправка. Упадём между — чек цел.
       Наоборот: деньги взяли, а чека нет. */
    await K.receiptAdd(receipt);
    await K.outboxAdd({ id: receipt.id, entity: 'sale', entityId: receipt.id,
      op: 'insert', payload: receipt, clientTs: receipt.at });

    S = (await K.saveState({
      lastNumber: receipt.number,
      cashInDrawer: (S.cashInDrawer || 0) + receipt.cashDelta,
    })).data;
    await rememberWay(K, way);

    // Печать может не выйти — оплата уже прошла, и это надо сказать.
    let печать = true;
    try {
      await K.print(receiptLines(receipt, { width: SET.printWidth === 32 ? 32 : 48 }), { title: `чек №${receipt.number}` });
    } catch { печать = false; }

    cart = []; cartDiscount = 0;
    const view = paidView(receipt, { printFailed: !печать });

    $('paid').classList.remove('hidden');
    go('paid', { view });
    sync.once();
  }

  // ── Каталог ────────────────────────────────────────────────────
  async function pullCatalog() {
    try {
      const r = await loadCatalog({ ask, store: K, settings: SET,
        deviceToken: S.deviceToken });
      CATALOG = r.items;
      const п = catalogWarning(r.ageDays);
      if (п) toast($('toasts'), п, 'warn');
    } catch (e) {
      /* КАТАЛОГ С ДИСКА НЕ СТИРАЕМ. Найдено живьём: связь пропала —
         CATALOG становился пустым, и касса СЛЕПЛА. Товары лежали на
         диске, а на экране пусто и «товар не найден» на каждый скан.
         Ради этого запас на диске и делался. */
      const запас = ((await K.getCatalog()).data || {}).items || [];
      if (запас.length) {
        CATALOG = запас;
        const дней = (await K.catalogAge()).data;
        const п = catalogWarning(дней);
        toast($('toasts'), п || 'Нет связи — работаю по сохранённому каталогу', 'warn');
      } else {
        CATALOG = [];
        toast($('toasts'), e.message, 'warn');
      }
    }
  }

  // ── Замок простоя ──────────────────────────────────────────────
  const idle = makeIdleWatch({
    minutes: SET.idleLockMin,
    onLock: () => {
      if (!S.employee) return;      // некого запирать
      $('lock').classList.remove('hidden');
      go('locked');
    },
  });

  for (const e of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(e, () => idle.touch(), { passive: true });
  }

  // ── Кольцо отправки ────────────────────────────────────────────
  const sync = makeSyncLoop({
    ask, ping, store: K,
    getSettings: async () => SET,
    getState: async () => S,
    watch,
    onChange: (r) => {
      // Число неотправленных публикуем для оболочки: она спросит его
      // при закрытии кассы.
      window.__tabysPending = r.left || 0;
    },
  });

  // ── Сканер ─────────────────────────────────────────────────────
  const scanner = makeScanner({
    onCode: (code) => {
      /* ПРОВЕРКА ЦЕНЫ ОТКРЫТА — показываем цену и НЕ кладём в чек.
         Ради этого она и нужна: узнать цену, не пробивая. */
      if (ценаЖдёт) { showPrice(code); return; }

      /* НЕ НА ТОМ ЭКРАНЕ — не молчим. Кассир сканирует, а касса стоит
         на оплате или смене: без слов он решит, что сканер сломан. */
      if (currentScreen() !== 'sale') {
        toast($('toasts'), 'Сканер работает на экране продажи', 'warn');
        return;
      }
      const r = resolveScan(code, CATALOG, { prefixes: SET.scalePrefixes });
      if (!r.ok) { toast($('toasts'), r.said, 'warn'); return; }
      addToCart(cart, r.good, r.qty, newId);
      toast($('toasts'), `${r.good.name} · ${money(r.good.price)}`);
      go('sale');
    },
  });

  wireHotkeys(document, {
    scanner,
    isBusy: () => hasModal(),
    onAction: (a) => {
      if (a === 'pay' && currentScreen() === 'sale') go('pay');
      if (a === 'price' && currentScreen() === 'sale') priceCheck();
      if (a === 'drawer') K.openDrawer();
      if (a === 'close') closeModal();
    },
  });

  wireEscape(document);

  // ── Запуск ─────────────────────────────────────────────────────
  (async function start() {
    SET = (await K.getSettings()).data || {};
    S = (await K.getState()).data || {};
    SET.version = ((await K.version()).data) || '';
    CATALOG = ((await K.getCatalog()).data || {}).items || [];

    if (S.deviceToken) { pullCatalog(); sync.start(); }

    // Куда встать — решает состояние, а не порядок вызовов.
    go(startScreen(S));
    idle.arm();
  })();
})();
