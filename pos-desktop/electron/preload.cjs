/**
 * МОСТ между экранами кассы и системой.
 *
 * Страница кассы — обычная веб-страница и к железу доступа не имеет.
 * Мост даёт ей РОВНО перечисленные команды, не больше. Без этого любой
 * скрипт на странице получил бы файловую систему и запуск программ —
 * на кассе, где ходят деньги, это недопустимо.
 */
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('kassa', {
  isDesktop: true,

  // настройки (адрес сервера, выбранный принтер)
  getSettings: () => call('settings:get'),
  saveSettings: (next) => call('settings:save', next),

  // состояние (токен устройства, кассир, смена)
  getState: () => call('state:get'),
  saveState: (next) => call('state:save', next),

  // каталог товаров: лежит на диске, чтобы продавать без интернета
  getCatalog: () => call('catalog:get'),
  saveCatalog: (items) => call('catalog:save', items),

  // очередь событий на сервер (чеки, смены) — переживает выключение
  outboxAdd: (event) => call('outbox:add', event),
  outboxPending: () => call('outbox:pending'),
  outboxAck: (ids) => call('outbox:ack', ids),

  // местная история чеков — для возвратов и «повторить чек»
  receiptAdd: (r) => call('receipts:add', r),
  receiptsRecent: (n) => call('receipts:recent', n),

  // печать
  print: (data) => call('print:receipt', data),
  printers: () => call('print:printers'),
  openDrawer: () => call('print:drawer'),
  printDiagnostic: () => call('print:diagnostic'),

  version: () => call('app:version'),

  // права на кассе, журнал действий, бонусы
  approve: (pin) => call('pos:approve', pin),
  logAction: (d) => call('pos:log', d),
  logRead: () => call('pos:log-read'),
  bonusSpendable: (customerId, total) => call('pos:bonus-spendable', { customerId, total }),
  posSettings: () => call('pos:settings'),

  // обновление кассы
  updateCheck: () => call('update:check'),
  updateDownload: () => call('update:download'),
  updateInstall: (file) => call('update:install', file),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
});
