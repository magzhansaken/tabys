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
});
