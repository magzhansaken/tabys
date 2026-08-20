/*
 * МОСТ МЕЖДУ КАССОЙ И ОБОЛОЧКОЙ.
 *
 * Страница не имеет доступа к системе — только к этому списку. Так
 * случайный скрипт не доберётся до файлов и запуска программ, а список
 * читается сверху вниз: видно, что касса вообще умеет.
 */
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, arg) => ipcRenderer.invoke(channel, arg);

contextBridge.exposeInMainWorld('K', {
  version: () => call('app:version'),

  /* Журнал печати. Владелец присылает файл вместо того, чтобы
     описывать беду словами. */
  openLog: () => call('log:open'),
  log: (msg) => call('log:write', msg),

  /* Закрыть кассу. Крестика нет вовсе: закрытие идёт этим путём и
     проходит через предупреждение о неотправленных чеках. */
  quit: () => call('app:quit'),

  /* Хранилище на диске. Чеки и очередь живут в файлах, а не в
     хранилище страницы: иначе при смене происхождения они бы
     раздвоились — на этом обжёгся донор. */
  getSettings: () => call('settings:get'),
  saveSettings: (p) => call('settings:save', p),
  getState: () => call('state:get'),
  saveState: (p) => call('state:save', p),

  saveCatalog: (i) => call('catalog:save', i),
  getCatalog: () => call('catalog:get'),
  catalogAge: () => call('catalog:age'),

  outboxAdd: (r) => call('outbox:add', r),
  outboxPending: () => call('outbox:pending'),
  outboxAck: (ids) => call('outbox:ack', ids),

  receiptAdd: (r) => call('receipts:add', r),
  receiptsRecent: (n) => call('receipts:recent', n),

  rejectedAll: () => call('rejected:all'),
  rejectedAdd: (r) => call('rejected:add', r),
  rejectedClear: () => call('rejected:clear'),

  passSave: (print, pass) => call('pass:save', { print, pass }),
  passRead: (print) => call('pass:read', print),
  passCount: () => call('pass:count'),

  /* Печать. Лента собирается на стороне кассы, сюда приходит готовой:
     оболочка не должна знать, как выглядит чек. */
  print: (lines, opts) => call('print:lines', { lines, ...(opts || {}) }),
  printers: () => call('print:printers'),
  openDrawer: () => call('print:drawer'),
});
