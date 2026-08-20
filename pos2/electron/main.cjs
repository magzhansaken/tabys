/*
 * КАССА «ТАБЫС» ДЛЯ WINDOWS — оболочка.
 *
 * Страница лежит ВНУТРИ программы и открывается с диска. Значит касса
 * поднимается мгновенно и без сети — даже при первом запуске в день,
 * когда интернет ещё не дали.
 *
 * Чем это лучше браузера:
 *   печать идёт сама, без окна «выберите принтер» на каждый чек;
 *   денежный ящик открывается, чего браузер не умеет вовсе;
 *   нет адресной строки, вкладок и случайного закрытия посреди смены;
 *   планшет включили — касса открылась.
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let forceClose = false;

/* ── ЖУРНАЛ ОБОЛОЧКИ ──────────────────────────────────────────────
 *
 * Владелец звонит «чеки не печатаются» — а магазин в другом городе.
 * Что случилось: касса не пыталась печатать, принтер молчал или
 * печатала не в тот принтер? Без журнала это гадание и поездка.
 *
 * Пишем ТОЛЬКО про печать, ящик и обновление: журнал, куда пишут всё,
 * читать никто не станет.
 */
const LOG = () => path.join(app.getPath('userData'), 'kassa.log');

function log(msg) {
  try {
    fs.appendFileSync(LOG(), `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch { /* журнал не должен ронять кассу */ }
}

/* Не даём журналу расти без края: полмегабайта — тысячи строк, больше
   при разборе всё равно не читают. */
function trimLog() {
  try {
    const p = LOG();
    if (!fs.existsSync(p) || fs.statSync(p).size < 512 * 1024) return;
    const rows = fs.readFileSync(p, 'utf8').split('\n');
    fs.writeFileSync(p, rows.slice(-2000).join('\n'), 'utf8');
  } catch { /* не вышло — не беда */ }
}

/* ── ОДНА КОПИЯ КАССЫ ─────────────────────────────────────────────
 *
 * Две копии считают номера чеков от своего: пойдут ДВА чека под
 * номером 57, и налоговая увидит задвоение. Разбираться будет
 * владелец, и объяснить он ничего не сможет.
 *
 * Вторую не пускаем вовсе, а первую поднимаем наверх: кассир ткнул в
 * ярлык дважды — увидит свою кассу, а не пустое место.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366,
    height: 768,
    fullscreen: true,
    autoHideMenuBar: true,
    // Тон кассы: при загрузке не мигает белым в тёмном зале.
    backgroundColor: '#141414',
    title: 'Табыс · Касса',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,   // страница не имеет доступа к системе
      nodeIntegration: false,   // иначе любой скрипт получит файлы
      spellcheck: false,
    },
  });

  win.setMenu(null);

  /* ПОЛНЫЙ ЭКРАН НЕ ВЫКЛЮЧАЕТСЯ.
   *
   * F11 и Escape выпускали окно, и появлялась рамка с крестиком:
   * кассир задел клавишу локтем — и может закрыть кассу или свернуть
   * её посреди очереди.
   *
   * Касса не программа, из которой выходят. Это рабочее место, занятое
   * сменой целиком. Закрыть можно только через предупреждение о
   * неотправленных чеках — оно ниже.
   */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11' || input.key === 'Escape') e.preventDefault();
    // Ctrl+W и Ctrl+R — случайное закрытие и перезагрузка посреди чека.
    if (input.control && (input.key === 'w' || input.key === 'r')) e.preventDefault();
  });

  /* ЗАКРЫТИЕ С ПРЕДУПРЕЖДЕНИЕМ О НЕОТПРАВЛЕННЫХ ЧЕКАХ.
   *
   * Чеки лежат на диске и никуда не денутся — уйдут при следующем
   * запуске. Но кассир должен знать: пока этого не случилось, в отчёте
   * владельца их нет, и вечерняя сверка не сойдётся.
   *
   * Число публикует сама касса в window.__tabysPending.
   */
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    win.webContents.executeJavaScript('window.__tabysPending || 0')
      .then((n) => {
        if (!n) { forceClose = true; win.close(); return; }
        const r = dialog.showMessageBoxSync(win, {
          type: 'warning',
          buttons: ['Остаться', 'Всё равно закрыть'],
          defaultId: 0,
          cancelId: 0,
          title: 'Есть неотправленные чеки',
          message: `Не ушло на сервер: ${n}`,
          detail: 'Чеки сохранены и уйдут при следующем запуске, когда появится '
            + 'связь. Но пока этого не случится, в отчётах их не будет.',
        });
        if (r === 1) { forceClose = true; win.close(); }
      })
      .catch(() => { forceClose = true; win.close(); });
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  log(`касса запущена · версия ${app.getVersion()}`);
  trimLog();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

/* ── Ответы странице ──────────────────────────────────────────────
 * Каждый ответ в одном виде: { ok, data } или { ok:false, error }.
 * Страница не должна гадать, что пришло, и не должна падать от отказа.
 */
const safe = (fn) => async (...a) => {
  try { return { ok: true, data: await fn(...a) }; }
  catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
};

ipcMain.handle('app:version', safe(async () => app.getVersion()));

/* Открыть журнал. Владелец звонит — говорим «меню → Журнал печати», и
   он присылает файл вместо того, чтобы описывать беду словами. */
ipcMain.handle('log:open', safe(async () => {
  const p = LOG();
  if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
  await shell.openPath(p);
  return true;
}));

/* Записать в журнал из кассы: печать, ящик, обновление. */
ipcMain.handle('log:write', safe(async (_e, msg) => {
  log(String(msg).slice(0, 300));
  trimLog();
  return true;
}));

/* ЗАКРЫТЬ КАССУ. Отдельным путём, а не крестиком: крестика нет вовсе.
   Проходит через то же предупреждение о неотправленных чеках. */
ipcMain.handle('app:quit', safe(async () => { if (win) win.close(); return true; }));

module.exports = { log, trimLog };
