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
  screen('sale', (state) => buildSale(app(), state, {
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
      go('pay');
    },
  }));

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
      const r = await unlock({ pin, state: S, store: K,
        deviceToken: S.deviceToken, offlineLogin });
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
      await K.print(receiptLines(receipt, { width: paperWidth(SET) }), { title: `чек №${receipt.number}` });
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
      CATALOG = [];
      toast($('toasts'), e.message, 'warn');
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
