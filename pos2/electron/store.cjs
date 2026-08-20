/*
 * ХРАНИЛИЩЕ КАССЫ — на диске, в файлах.
 *
 * ПОЧЕМУ НЕ В БРАУЗЕРЕ. У донора очередь чеков лежала в хранилище
 * страницы, и они на этом обожглись: «у страницы с сервера
 * происхождение https, у страницы с диска — file, а очередь у разных
 * происхождений разная. Переключение туда-сюда РАЗДВАИВАЛО БЫ ДЕНЬГИ».
 *
 * Здесь файлы. Откуда бы страница ни грузилась, чеки в одном месте, и
 * переживают они не только перезагрузку, но и переустановку кассы —
 * достаточно не трогать папку.
 *
 * ЧЕКИ И ОЧЕРЕДЬ ПИШУТСЯ ПОСТРОЧНО (по записи в строке). Один
 * повреждённый чек не уносит с собой остальные: при чтении битая
 * строка пропускается, а не роняет всё хранилище.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const dir = () => app.getPath('userData');
const file = (n) => path.join(dir(), n);

const SETTINGS = 'settings.json';
const STATE    = 'state.json';
const CATALOG  = 'catalog.json';
const OUTBOX   = 'outbox.jsonl';    // очередь на сервер
const RECEIPTS = 'receipts.jsonl';  // чеки для перепечатки
const REJECTED = 'rejected.json';   // сервер не принял
const PASSES   = 'passes.json';     // пропуска без сети

/* ── Чтение и запись ──────────────────────────────────────────────
 *
 * Пишем ЧЕРЕЗ ВРЕМЕННЫЙ ФАЙЛ: если касса выключится посреди записи,
 * старый файл останется целым. Иначе кассир получит пустые настройки
 * после отключения света — а это привязка, права и предел скидки.
 */
function readJson(name, def) {
  try {
    const p = file(name);
    if (!fs.existsSync(p)) return def;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return def; }
}

function writeJson(name, value) {
  const p = file(name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, p);      // замена целиком, без промежуточного состояния
  return value;
}

/* Построчное хранилище: одна запись — одна строка. */
function appendLine(name, row) {
  fs.appendFileSync(file(name), JSON.stringify(row) + '\n', 'utf8');
  return row;
}

function readLines(name, limit) {
  try {
    const p = file(name);
    if (!fs.existsSync(p)) return [];
    const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const take = limit ? rows.slice(-limit) : rows;
    // Битую строку ПРОПУСКАЕМ, а не роняем всё: один испорченный чек
    // не должен унести с собой смену.
    return take.map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/* ── НАСТРОЙКИ ────────────────────────────────────────────────────
 * Их задаёт владелец при установке и меняет редко.
 */
const SETTINGS_DEFAULT = {
  apiUrl: 'https://tabys.duckdns.org/api',
  printer: '',            // пусто — принтер не выбран
  printWidth: 48,         // 80 мм лента: 48 знаков в строке
  printCopies: 1,
  idleLockMin: 3,         // замок при простое; 0 — не запирать
  lang: 'ru',             // язык кассы; чек всегда по-русски
};

const getSettings = () => ({ ...SETTINGS_DEFAULT, ...readJson(SETTINGS, {}) });
const saveSettings = (patch) => writeJson(SETTINGS, { ...getSettings(), ...patch });

/* ── СОСТОЯНИЕ ────────────────────────────────────────────────────
 * Меняется в работе: кто вошёл, какая смена, сколько в ящике.
 */
const STATE_DEFAULT = {
  deviceToken: null,      // привязка кассы
  deviceId: null,
  accountId: null,
  cashRegisterId: null,
  storeName: '',
  employee: null,         // кто за кассой
  shift: null,            // открытая смена
  lastNumber: 0,          // номер последнего чека
  cashInDrawer: 0,        // наличные — считаем НА КАССЕ, без сервера
  parked: [],             // отложенные чеки
};

const getState = () => ({ ...STATE_DEFAULT, ...readJson(STATE, {}) });
const saveState = (patch) => writeJson(STATE, { ...getState(), ...patch });

/* ── КАТАЛОГ С ВОЗРАСТОМ ──────────────────────────────────────────
 *
 * Касса без связи торгует по сохранённому — это верно, их довод:
 * «несравнимо меньшая беда, чем закрытая касса».
 *
 * Но возраст храним рядом: владелец поднял цены вчера, а касса не
 * выходила в сеть три дня — она продаёт по старым, и не знает об этом
 * никто.
 */
const saveCatalog = (items) => writeJson(CATALOG, { at: Date.now(), items });
const getCatalog = () => readJson(CATALOG, { at: 0, items: [] });
const catalogAgeDays = () => {
  const c = getCatalog();
  return c.at ? Math.floor((Date.now() - c.at) / 86400000) : null;
};

/* ── ОЧЕРЕДЬ НА СЕРВЕР ────────────────────────────────────────────
 *
 * Чек сперва ложится сюда, потом уходит. Порядок именно такой: если
 * упасть между записью и отправкой, чек цел. Наоборот — деньги
 * пропали бы молча.
 */
const outboxAdd = (row) => appendLine(OUTBOX, row);
const outboxPending = () => readLines(OUTBOX);

/* Вычеркнуть отправленное. Переписываем файл целиком: очередь короткая
   (десятки строк), а перезапись проще и надёжнее правки на месте. */
function outboxAck(ids) {
  const left = outboxPending().filter((r) => !ids.includes(r.id));
  const tmp = file(OUTBOX) + '.tmp';
  fs.writeFileSync(tmp, left.map((r) => JSON.stringify(r)).join('\n') + (left.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file(OUTBOX));
  return left.length;
}

/* ── ЧЕКИ ДЛЯ ПЕРЕПЕЧАТКИ ────────────────────────────────────────
 * Кончилась лента, отошёл провод — чек можно напечатать заново.
 */
const receiptAdd = (r) => appendLine(RECEIPTS, r);
const receiptsRecent = (n = 50) => readLines(RECEIPTS, n).reverse();

/* ── СЕРВЕР НЕ ПРИНЯЛ ─────────────────────────────────────────────
 *
 * Их правило: «деньги не должны пропадать молча». Отклонённый чек
 * уходит сюда, а не крутится в очереди вечно — иначе она не пустеет
 * никогда, и кассир перестаёт верить счётчику.
 */
const rejectedAll = () => readJson(REJECTED, []);
const rejectedAdd = (rows) => writeJson(REJECTED, [...rejectedAll(), ...rows].slice(-50));
const rejectedClear = () => writeJson(REJECTED, []);

/* ── ПРОПУСКА ─────────────────────────────────────────────────────
 *
 * След кода каждого, кто входил на этой кассе при связи. Без сети
 * пускаем по нему — каждого под СВОИМ именем: кассиры сменяются, и
 * вечерний не должен торговать под именем утреннего.
 *
 * Сам код не храним: с отпечатком нельзя войти на другой кассе.
 */
const passesAll = () => readJson(PASSES, {});
const passSave = (print, pass) => writeJson(PASSES, { ...passesAll(), [print]: pass });
const passRead = (print) => passesAll()[print] || null;

module.exports = {
  dir, file,
  getSettings, saveSettings,
  getState, saveState,
  saveCatalog, getCatalog, catalogAgeDays,
  outboxAdd, outboxPending, outboxAck,
  receiptAdd, receiptsRecent,
  rejectedAll, rejectedAdd, rejectedClear,
  passesAll, passSave, passRead,
};
