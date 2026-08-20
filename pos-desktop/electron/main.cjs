/**
 * ТАБЫС КАССА — главный процесс.
 *
 * Почему настольное приложение, а не сайт: касса не имеет права
 * останавливаться при пропаже интернета. Здесь чек сохраняется в файл на
 * диске мгновенно, а на сервер уезжает потом, когда связь вернётся.
 * Вкладку браузера можно закрыть и потерять данные — программу нельзя.
 *
 * Разделение обязанностей:
 *   main.cjs     — окно, файлы, сеть, печать (полные права)
 *   preload.cjs  — узкий мост: страница получает ровно нужные команды
 *   renderer/    — экраны кассы, к железу доступа не имеют
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { printReceipt, listPrinters, openCashDrawer, printDiagnostic } = require('./printer.cjs');
const store = require('./store.cjs');
const updater = require('./updater.cjs');

const isDev = !app.isPackaged;
let win = null;

/*
 * ЖУРНАЛ ОБОЛОЧКИ — взят у донора вместе с доводом:
 *
 *   «Без него разбор "чек не вышел" превращается в гадание: печатала ли
 *    программа, ответил ли принтер, какой именно. Файл маленький,
 *    пишется только по делу.»
 *
 * Владелец звонит «чеки не печатаются» — а магазин в другом городе.
 * Без журнала не узнать: касса не пыталась печатать, принтер молчал
 * или печатала не в тот принтер. Приходится ехать и смотреть глазами.
 *
 * Пишем ТОЛЬКО про печать, ящик и обновление: журнал, куда пишут всё,
 * читать никто не станет.
 */
const LOG = path.join(app.getPath('userData'), 'kassa.log');
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}\n`;
  // Журнал не должен ронять кассу: не записалось — и ладно.
  try { fs.appendFileSync(LOG, line, 'utf8'); } catch { /* нет места на диске */ }
};

/* Не даём журналу расти без края: полмегабайта — это тысячи строк,
   больше при разборе всё равно не читают. Старое отрезаем. */
function trimLog() {
  try {
    if (!fs.existsSync(LOG)) return;
    if (fs.statSync(LOG).size < 512 * 1024) return;
    const rows = fs.readFileSync(LOG, 'utf8').split('\n');
    fs.writeFileSync(LOG, rows.slice(-2000).join('\n'), 'utf8');
  } catch { /* не вышло — не беда */ }
}

// Настройки лежат рядом с данными пользователя, а не в папке программы:
// в Program Files запись запрещена без прав администратора.
const dataDir = app.getPath('userData');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 768,           // типичный кассовый планшет
    minWidth: 1024, minHeight: 600,
    // ПОЛНЫЙ ЭКРАН СРАЗУ — как у донора, проверено на боевых кассах.
    //
    // Раньше окно открывалось обычным, с крестиком в углу. Кассир
    // задевает его локтем посреди смены — и касса закрывается при
    // очереди. Касса не программа, а рабочее место: у него нет
    // «свернуть» и «закрыть».
    //
    // Выйти всё равно можно: F11 разворачивает обратно, Escape тоже.
    // Это для наладчика, а не для кассира.
    fullscreen: true,
    backgroundColor: '#0f172a',          // при загрузке не мигает белым
    autoHideMenuBar: true,               // кассиру меню не нужно
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,            // страница не имеет доступа к системе
      nodeIntegration: false,            // иначе любой скрипт получит файлы и запуск программ
      spellcheck: false,
    },
  });

  // Страница грузится С ДИСКА, а не по сети: касса должна открываться
  // даже когда интернета нет вовсе.
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Полноэкранный режим по F11, выход по Esc — кассиру удобно, но не запирает.
  win.webContents.on('before-input-event', (_e, input) => {
      // ПОЛНЫЙ ЭКРАН НЕ ВЫКЛЮЧАЕТСЯ. Раньше F11 и Escape выпускали
      // окно, и появлялась рамка с крестиком: кассир задел клавишу —
      // и может закрыть кассу или свернуть её посреди очереди.
      //
      // У донора этих клавиш нет вовсе, и это верно: касса не
      // программа, из которой выходят. Это рабочее место, занятое
      // сменой целиком. Закрыть можно только с предупреждением о
      // неотправленных чеках.
      if (input.type === 'keyDown' && (input.key === 'F11' || input.key === 'Escape')) {
        e.preventDefault();
      }
    if (input.type === 'keyDown' && input.key === 'F12' && isDev) win.webContents.openDevTools();
  });

  // Закрытие с подтверждением: случайный клик по крестику посреди чека
  // не должен ронять кассу.
  win.on('close', (e) => {
    if (app.quitting) return;
    e.preventDefault();
    const r = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Остаться', 'Закрыть кассу'], defaultId: 0, cancelId: 0,
      title: 'Закрыть кассу?',
      message: 'Незавершённый чек будет потерян. Закрыть программу?',
    });
    if (r === 1) { app.quitting = true; app.quit(); }
  });
}

/* ВТОРАЯ КОПИЯ КАССЫ — часть 7 разбора их экрана. У них это ловится
 * как «касса открыта в двух вкладках — закройте лишнюю».
 *
 * Чем это грозит: обе копии считают номера чеков от своего. Пойдут ДВА
 * чека под номером 57, и налоговая увидит задвоение. Разбираться будет
 * владелец, и объяснить он ничего не сможет.
 *
 * Вторую копию не пускаем вовсе, а первую поднимаем наверх: кассир
 * ткнул в ярлык дважды — увидит свою же кассу, а не пустое место.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── Команды со страницы кассы ────────────────────────────────────────
// Каждая — с обработкой ошибки: сбой печати или сети не должен ронять кассу.
const safe = (fn) => async (...a) => {
  try { return { ok: true, data: await fn(...a) }; }
  catch (e) { console.error('[касса]', e); return { ok: false, error: String(e.message || e) }; }
};

ipcMain.handle('settings:get', safe(async () => store.readSettings()));
ipcMain.handle('settings:save', safe(async (_e, next) => store.saveSettings(next)));

ipcMain.handle('state:get', safe(async () => store.readState()));
ipcMain.handle('state:save', safe(async (_e, next) => store.saveState(next)));

ipcMain.handle('catalog:get', safe(async () => store.readCatalog()));
ipcMain.handle('catalog:save', safe(async (_e, items) => store.saveCatalog(items)));

ipcMain.handle('outbox:add', safe(async (_e, event) => store.addToOutbox(event)));
ipcMain.handle('outbox:pending', safe(async () => store.readOutbox()));
ipcMain.handle('outbox:ack', safe(async (_e, ids) => store.ackOutbox(ids)));

ipcMain.handle('receipts:add', safe(async (_e, r) => store.addReceipt(r)));
ipcMain.handle('receipts:recent', safe(async (_e, n) => store.recentReceipts(n)));

/* ПЕЧАТЬ ЧЕКА — с записью в журнал. Пишем ровно то, что спросят при
   разборе: пыталась ли касса печатать, каким принтером, чем кончилось.
   Три вопроса — три поля, больше не нужно. */
ipcMain.handle('print:receipt', safe(async (_e, data) => {
  const who = (store.getSettings().printer) || 'принтер по умолчанию';
  const num = data && data.number != null ? `чек №${data.number}` : 'чек';
  try {
    const r = await printReceipt(data);
    log(`печать: ${num} · ${who} · вышел`);
    trimLog();
    return r;
  } catch (e) {
    // Пишем причину дословно: «нет бумаги» и «принтер не найден» —
    // разные беды, и чинят их по-разному.
    log(`печать: ${num} · ${who} · ОШИБКА: ${e && e.message}`);
    trimLog();
    throw e;
  }
}));
ipcMain.handle('print:printers', safe(async () => listPrinters()));

/* Открыть журнал. Владелец звонит — говорим «меню → Журнал печати», и
   он присылает файл, вместо того чтобы описывать беду словами. */
ipcMain.handle('log:open', safe(async () => {
  if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, '', 'utf8');
  await shell.openPath(LOG);
  return true;
}));
ipcMain.handle('print:drawer', safe(async () => openCashDrawer()));
ipcMain.handle('print:diagnostic', safe(async () => printDiagnostic()));

ipcMain.handle('app:version', safe(async () => app.getVersion()));

// Обращения к серверу, которым нужен токен устройства. Идут из главного
// процесса, а не со страницы: токен не должен попадать в код экранов.
const srv = async (path, opts = {}) => {
  const s = store.readSettings(), st = store.readState();
  const r = await fetch(s.apiUrl.replace(/\/$/, '') + path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Device-Token': st.deviceToken ?? '' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  return r.json();
};

ipcMain.handle('pos:approve', safe(async (_e, pin) => srv('/pos/settings/approve', { method: 'POST', body: { pin } })));

/* КАССИР УХОДИТ — закрыть явку. Идёт через оболочку, потому что нужен
   токен устройства: уходит человек с ЭТОЙ кассы, а не вообще. */
ipcMain.handle('pos:clock-out', safe(async (_e, pin) =>
  srv('/pos/clock-out', { method: 'POST', body: { pin } })));
ipcMain.handle('pos:log', safe(async (_e, d) => srv('/pos/settings/log', { method: 'POST', body: d })));
// Чтение журнала — для показа при пересменке: сменщик видит, что делали
// до него. Это снимает главное условие кражи — незаметность.
ipcMain.handle('pos:log-read', safe(async () => srv('/pos/settings/log')));
ipcMain.handle('pos:settings', safe(async () => srv('/pos/settings')));
ipcMain.handle('pos:bonus-spendable', safe(async (_e, d) =>
  srv(`/pos/bonus/spendable?customerId=${encodeURIComponent(d.customerId)}&total=${d.total}`)));

// Обновление. Ход скачивания шлём на страницу, чтобы полоса двигалась:
// молчащая полоса на файле в сотни мегабайт выглядит как зависание.
ipcMain.handle('update:check', safe(async () => updater.check()));
ipcMain.handle('update:download', safe(async () => updater.download((p) => {
  win?.webContents.send('update:progress', p);
})));
ipcMain.handle('update:install', safe(async (_e, file) => updater.install(file)));
