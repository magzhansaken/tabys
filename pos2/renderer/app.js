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

    onTab: (t) => { tab = t; query = ''; go('sale'); },
    onSearch: (q) => { query = q; go('sale'); },
    onPick: (g, qty) => { addToCart(cart, g, qty || 1, newId); go('sale'); },
    onPay: () => {
      const блок = payBlock(cart);
      if (блок) { toast($('toasts'), блок, 'warn'); return; }
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
      if (currentScreen() !== 'sale') return;
      const r = resolveScan(code, CATALOG, { prefixes: SET.scalePrefixes });
      if (!r.ok) { toast($('toasts'), r.said, 'warn'); return; }
      addToCart(cart, r.good, r.qty, newId);
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
