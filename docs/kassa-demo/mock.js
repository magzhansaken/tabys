/* ЗАГЛУШКА ДАННЫХ — чтобы касса открывалась в браузере без системы.
   В настоящей кассе данные приходят через защищённый мост из программы.
   Здесь они поддельные, но правдоподобные: длинные названия товаров,
   суммы до десятков тысяч, кириллица — то, на чём ломается вёрстка. */
const CATALOG = [
  { id:'1', name:'Молоко Айран 1л 2,5% пастеризованное', price:480, barcodes:['4870001234567'] },
  { id:'2', name:'Хлеб бородинский нарезной 400г', price:250, barcodes:['4870001234568'] },
  { id:'3', name:'Кофе Латте 0,3л', price:900, barcodes:['4870001234569'] },
  { id:'4', name:'Вода Асем-Ай негазированная 5л', price:390, barcodes:['4870001234570'] },
  { id:'5', name:'Сахар-песок Аксу 1кг', price:520, barcodes:['4870001234571'] },
  { id:'6', name:'Масло подсолнечное Шедевр 1л', price:1180, barcodes:['4870001234572'] },
  { id:'7', name:'Чай Пиала Голд 250г', price:1450, barcodes:['4870001234573'] },
  { id:'8', name:'Печенье Юбилейное 313г', price:640, barcodes:['4870001234574'] },
  { id:'9', name:'Сигареты Winston синие', price:1200, barcodes:['4870001234575'] },
  { id:'10', name:'Пакет-майка 30х55', price:25, barcodes:['4870001234576'] },
];
let STATE = {
  deviceToken:'demo', employee:{ id:'e1', name:'Асель' },
  shift:{ id:'sh1', openedAt:new Date().toISOString(), openingFloat:5000 },
  lastNumber:41, parked:[], lastSeq:3,
};
const wrap = (data) => Promise.resolve({ ok:true, data });
window.kassa = {
  isDesktop:true,
  version: () => wrap('1.2.0'),
  getSettings: () => wrap({ apiUrl:'https://tabys.duckdns.org/api', printer:'', printWidth:48, openDrawerOnCash:true }),
  saveSettings: (n) => wrap(n),
  getState: () => wrap(STATE),
  saveState: (n) => { STATE = { ...STATE, ...n }; return wrap(STATE); },
  getCatalog: () => wrap(CATALOG),
  saveCatalog: () => wrap(CATALOG.length),
  outboxAdd: () => wrap({}),
  outboxPending: () => wrap([{ id:'x' }, { id:'y' }]),
  outboxAck: () => wrap(0),
  receiptAdd: () => wrap(true),
  receiptsRecent: () => wrap([
    { id:'r1', number:41, date:'11.08.2026 14:32', total:2410 },
    { id:'r2', number:40, date:'11.08.2026 14:18', total:780 },
    { id:'r3', number:39, date:'11.08.2026 13:55', total:15640 },
  ]),
  print: () => wrap(true),
  printDiagnostic: () => wrap(true),
  printers: () => wrap(['XPrinter XP-58','Rongta RP80']),
  openDrawer: () => wrap(true),
  updateCheck: () => wrap({ available:false }),
  updateDownload: () => wrap({}),
  updateInstall: () => wrap(true),
  onUpdateProgress: () => {},
  // права на кассе, журнал, бонусы
  approve: (pin) => wrap(pin === '3333'
    ? { ok: true, employeeId: 'a1', name: 'Динара' }
    : { ok: false, reason: 'PIN не подошёл. Нужен PIN администратора' }),
  logAction: () => wrap({ ok: true }),
  posSettings: () => wrap({
    act_refund: 'everyone', act_refund_free: 'admin_only',
    act_remove_item: 'everyone', act_reduce_qty: 'everyone',
    act_discount: 'everyone', act_price_change: 'admin_only', act_cash_out: 'admin_only',
    discount_allowed: true, discount_max_pct: 15, no_price_down: true,
    receipt_header: 'Магазин Береке · ул. Абая 15', receipt_footer: 'Спасибо за покупку!',
  }),
  bonusSpendable: (id, total) => wrap({ canSpend: Math.floor(total * 0.5), reason: null }),
};
