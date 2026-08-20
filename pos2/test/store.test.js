/*
 * ПРОВЕРКА ХРАНИЛИЩА — на настоящем диске, а не в памяти.
 *
 * Проверяем то, чем оно и ценно: переживёт ли выключение света,
 * не унесёт ли одна битая строка всю смену, лягут ли чеки по порядку.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Подменяем папку кассы на временную: настоящую трогать нельзя.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kassa-'));
const orig = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { app: { getPath: () => tmp } };
  return orig.apply(this, [req, ...rest]);
};

const store = require('../electron/store.cjs');
const { newId } = require('../renderer/ids.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

console.log('═══ ЭТАП 3 · ХРАНИЛИЩЕ ═══\n');

// ── НАСТРОЙКИ ──────────────────────────────────────────────────────
{
  const s = store.getSettings();
  ok(s.apiUrl && s.printWidth === 48, 'Настройки по умолчанию есть: касса заработает сразу');
  ok(s.idleLockMin === 3, 'Замок при простое — три минуты');
  store.saveSettings({ printer: 'XP-80C' });
  ok(store.getSettings().printer === 'XP-80C', 'Правка сохранилась');
  ok(store.getSettings().printWidth === 48, '★ И не стёрла остальное: правим одно поле');
}

// ── СОСТОЯНИЕ ──────────────────────────────────────────────────────
{
  store.saveState({ cashInDrawer: 45000 });
  store.saveState({ lastNumber: 57 });
  const st = store.getState();
  ok(st.cashInDrawer === 45000 && st.lastNumber === 57,
     '★ Две правки подряд не затирают друг друга');
}

// ── ЗАПИСЬ ПЕРЕЖИВЁТ ВЫКЛЮЧЕНИЕ СВЕТА ──────────────────────────────
{
  // Пишем через временный файл: если света не станет посреди записи,
  // старый файл останется целым.
  const before = fs.readFileSync(path.join(tmp, 'state.json'), 'utf8');
  ok(JSON.parse(before).cashInDrawer === 45000, '★ Настройки лежат на диске целыми');
  ok(!fs.existsSync(path.join(tmp, 'state.json.tmp')),
     'Временный файл убран за собой');
}

// ── ОЧЕРЕДЬ ────────────────────────────────────────────────────────
{
  const a = newId(), b = newId(), c = newId();
  store.outboxAdd({ id: a, entity: 'sale' });
  store.outboxAdd({ id: b, entity: 'sale' });
  store.outboxAdd({ id: c, entity: 'sale' });
  ok(store.outboxPending().length === 3, 'Три чека в очереди');

  const left = store.outboxAck([a, c]);
  ok(left === 1 && store.outboxPending()[0].id === b,
     '★ Ушедшие вычеркнуты, неотвеченный ждёт');
}

// ── БИТАЯ СТРОКА НЕ УНОСИТ СМЕНУ ───────────────────────────────────
{
  fs.appendFileSync(path.join(tmp, 'outbox.jsonl'), '{битая строка\n', 'utf8');
  store.outboxAdd({ id: newId(), entity: 'sale' });
  const rows = store.outboxPending();
  ok(rows.length === 2, '★ Битая строка пропущена, остальные целы');
}

// ── ЧЕКИ ДЛЯ ПЕРЕПЕЧАТКИ ───────────────────────────────────────────
{
  store.receiptAdd({ id: newId(), number: 57, total: 3400 });
  store.receiptAdd({ id: newId(), number: 58, total: 1200 });
  const r = store.receiptsRecent(5);
  ok(r[0].number === 58, '★ Последний чек первым: его и перепечатывают');
}

// ── СЕРВЕР НЕ ПРИНЯЛ ───────────────────────────────────────────────
{
  store.rejectedAdd([{ number: 59, reason: 'дубль номера' }]);
  ok(store.rejectedAll().length === 1, 'Отклонённый отложен');
  ok(store.rejectedAll()[0].reason === 'дубль номера',
     '★ С причиной: владельцу будет что разбирать');
  store.rejectedClear();
  ok(store.rejectedAll().length === 0, 'Список чистится');
  ok(store.receiptsRecent(5).length === 2,
     '★ А сами чеки на кассе остались: чистили список, не деньги');
}

// ── ПРОПУСКА ───────────────────────────────────────────────────────
{
  store.passSave('след-айгуль', { employee: { id: 'e1', name: 'Айгуль' } });
  store.passSave('след-ерлан', { employee: { id: 'e2', name: 'Ерлан' } });
  ok(store.passRead('след-ерлан').employee.name === 'Ерлан',
     '★ Пропуск у КАЖДОГО, кто входил: сменщик войдёт под своим именем');
  ok(store.passRead('след-чужой') === null, 'Чужой след не пускает');
}

// ── КАТАЛОГ И ЕГО ВОЗРАСТ ──────────────────────────────────────────
{
  store.saveCatalog([{ id: 'g1', name: 'Хлеб', price: 250 }]);
  ok(store.getCatalog().items.length === 1, 'Каталог сохранён');
  ok(store.catalogAgeDays() === 0, '★ Возраст считается: сегодня — ноль дней');

  // Подделываем дату: будто каталог трёхдневный
  const c = store.getCatalog();
  fs.writeFileSync(path.join(tmp, 'catalog.json'),
    JSON.stringify({ at: Date.now() - 3 * 86400000, items: c.items }), 'utf8');
  ok(store.catalogAgeDays() === 3,
     '★ Трёхдневный каталог виден: касса продаёт по старым ценам, и мы это знаем');
}

// ── ПУСТОЙ ДИСК НЕ РОНЯЕТ КАССУ ────────────────────────────────────
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kassa2-'));
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { app: { getPath: () => tmp2 } };
    return orig.apply(this, [req, ...rest]);
  };
  delete require.cache[require.resolve('../electron/store.cjs')];
  const s2 = require('../electron/store.cjs');
  ok(s2.getState().cashInDrawer === 0 && s2.outboxPending().length === 0,
     '★ Первый запуск: пустой диск даёт пустое, а не падение');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
process.exit(failed ? 1 : 0);
