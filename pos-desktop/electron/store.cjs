/**
 * МЕСТНОЕ ХРАНИЛИЩЕ КАССЫ.
 *
 * Почему файлы, а не встроенная база: любая настоящая база для Electron —
 * это внешний модуль, который надо пересобирать под каждую версию, и он
 * ломается при обновлениях. Для магазина у дома, где за день проходит
 * несколько сотен чеков, простых файлов достаточно, а надёжность выше:
 * нечему ломаться.
 *
 * ГЛАВНОЕ ПРАВИЛО — АТОМАРНАЯ ЗАПИСЬ. Пишем во временный файл и только
 * потом переименовываем поверх основного. Переименование в файловой
 * системе неделимо: либо старый файл целиком, либо новый целиком.
 * Если свет выключат посреди записи, касса не проснётся с обрывком.
 *
 * Очередь на сервер — построчный файл (одно событие = одна строка).
 * Дописать строку дешевле и безопаснее, чем переписывать весь файл:
 * при сбое теряется максимум последняя строка, а не вся очередь.
 */
const fs = require('fs');
const path = require('path');

/**
 * Где лежат данные. Обычно это папка пользователя, которую даёт Electron.
 * Но папку можно задать переменной окружения — и это не «для удобства»:
 * без такой возможности хранилище невозможно проверить тестами, потому
 * что тест не поднимает окно программы. Касса считает деньги, и её
 * хранилище обязано быть проверяемым.
 */
let _dir = null;
const dir = () => {
  if (_dir) return _dir;
  if (process.env.TABYS_DATA_DIR) { _dir = process.env.TABYS_DATA_DIR; }
  else { _dir = require('electron').app.getPath('userData'); }
  if (!fs.existsSync(_dir)) fs.mkdirSync(_dir, { recursive: true });
  return _dir;
};
const file = (name) => path.join(dir(), name);

/** Атомарная запись: временный файл → переименование поверх. */
function writeAtomic(name, text) {
  const target = file(name);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, target);          // неделимая операция
}

function readJson(name, fallback) {
  try {
    const p = file(name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    // Файл испорчен — не роняем кассу, а откатываемся к пустому значению
    // и сохраняем испорченный рядом, чтобы можно было разобраться.
    try { fs.renameSync(file(name), file(name + '.broken-' + Date.now())); } catch {}
    console.error('[хранилище] испорчен', name, e.message);
    return fallback;
  }
}

// ── Настройки: адрес сервера, принтер ────────────────────────────────
const DEFAULT_SETTINGS = {
  apiUrl: 'https://tabys.duckdns.org/api',
  printer: '',                  // пусто = принтер по умолчанию в Windows
  printWidth: 48,               // знаков в строке: 48 для 80мм, 32 для 58мм
  openDrawerOnCash: true,
};
const readSettings = () => ({ ...DEFAULT_SETTINGS, ...readJson('settings.json', {}) });
const saveSettings = (next) => {
  const merged = { ...readSettings(), ...next };
  writeAtomic('settings.json', JSON.stringify(merged, null, 2));
  return merged;
};

// ── Состояние: токен устройства, кассир, смена ───────────────────────
const readState = () => readJson('state.json', {
  deviceToken: null, store: null, register: null,
  employee: null, shift: null, lastSync: null,
});
const saveState = (next) => {
  const merged = { ...readState(), ...next };
  writeAtomic('state.json', JSON.stringify(merged));
  return merged;
};

// ── Каталог товаров: чтобы продавать без интернета ───────────────────
const readCatalog = () => readJson('catalog.json', []);
const saveCatalog = (items) => {
  writeAtomic('catalog.json', JSON.stringify(items));
  return items.length;
};

// ── Очередь на сервер ────────────────────────────────────────────────
const OUTBOX = 'outbox.jsonl';

/**
 * Добавить событие. Номер по устройству (clientSeq) СКВОЗНОЙ и растёт
 * без пропусков — сервер по нему видит, всё ли доехало. Идентификатор
 * задаёт касса, поэтому повторная отправка не задваивает чек.
 */
function addToOutbox(event) {
  const state = readState();
  const seq = (state.lastSeq || 0) + 1;
  saveState({ lastSeq: seq });
  const row = { ...event, clientSeq: seq, clientTs: new Date().toISOString() };
  fs.appendFileSync(file(OUTBOX), JSON.stringify(row) + '\n', 'utf8');
  return row;
}

function readOutbox() {
  try {
    const p = file(OUTBOX);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }   // битую строку пропускаем
    }).filter(Boolean);
  } catch { return []; }
}

/**
 * Убрать доставленные. Чистим ТОЛЬКО после подтверждения сервера:
 * пока сервер не сказал «принял», событие остаётся в очереди, даже
 * если касса выключится.
 */
function ackOutbox(ids) {
  const set = new Set(ids);
  const left = readOutbox().filter((e) => !set.has(e.id));
  writeAtomic(OUTBOX, left.map((e) => JSON.stringify(e)).join('\n') + (left.length ? '\n' : ''));
  return left.length;
}

// ── Местная история чеков: для возвратов и повтора печати ────────────
const RECEIPTS = 'receipts.jsonl';
function addReceipt(r) {
  fs.appendFileSync(file(RECEIPTS), JSON.stringify(r) + '\n', 'utf8');
  return true;
}
function recentReceipts(n = 50) {
  try {
    const p = file(RECEIPTS);
    if (!fs.existsSync(p)) return [];
    const rows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    return rows.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).reverse();
  } catch { return []; }
}

module.exports = {
  readSettings, saveSettings, readState, saveState,
  readCatalog, saveCatalog,
  addToOutbox, readOutbox, ackOutbox,
  addReceipt, recentReceipts,
};
