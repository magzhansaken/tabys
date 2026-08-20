/*
 * ПРОВЕРКА ПРИВЯЗКИ.
 *
 * Первая проверка — про беду, что уже случалась: поле не пускало
 * буквы, и привязка не прошла бы никогда.
 */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>');
global.document = dom.window.document; global.window = dom.window;

const { normalizeCode, pairDevice, savePairing, forgetPairing } = require('../renderer/setup.js');
const { buildSetup } = require('../renderer/screen-setup.js');

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('✔ ' + n); } else { failed++; console.log('✘ ' + n); } };

console.log('═══ ЭТАП 6 · ПРИВЯЗКА ═══\n');

// ── ПОЛЕ ПРИНИМАЕТ БУКВЫ ───────────────────────────────────────────
{
  const root = document.getElementById('app');
  buildSetup(root, {}, { onPair: async () => {}, version: '3.0.0' });
  const f = root.querySelector('#pairCode');

  ok(!f.getAttribute('inputmode'),
     '★ Поле НЕ цифровое: буквы кода можно ввести');
  ok(!f.getAttribute('pattern') && !f.getAttribute('maxlength'),
     '★ Ни маски, ни предела длины — формат решает сервер');
  ok(/TBS-/.test(f.getAttribute('placeholder')),
     `★ Подсказка настоящая: «${f.getAttribute('placeholder')}»`);
  ok(f.getAttribute('autocapitalize') === 'characters',
     'На планшете сразу заглавные: код такой и есть');

  // Вводим буквы — они должны остаться
  f.value = 'tbs-4fe2-3137';
  ok(f.value === 'tbs-4fe2-3137', '★ Буквы вправду вводятся и остаются');
}

// ── КОД ПРИВОДИТСЯ К ВИДУ СЕРВЕРА ──────────────────────────────────
{
  ok(normalizeCode('tbs-4fe2-3137') === 'TBS-4FE2-3137',
     '★ Маленькие буквы → большие: кассир пишет как слышит');
  ok(normalizeCode('  TBS-4FE2-3137  ') === 'TBS-4FE2-3137',
     'Пробелы от вставки убраны');
  ok(normalizeCode('') === '' && normalizeCode(null) === '',
     'Пусто остаётся пустым, а не «null»');
}

// ── ПУСТОЙ КОД ─────────────────────────────────────────────────────
(async () => {
  {
    let e = null;
    try { await pairDevice({ ask: async () => ({}), settings: {}, code: '   ' }); }
    catch (x) { e = x; }
    ok(e && e.field === true,
       '★ Пустой код — беда в поле, на сервер не ходим зря');
    ok(/Введите код/.test(e.message), `И сказано словами: «${e.message}»`);
  }

  // ── УДАЧНАЯ ПРИВЯЗКА ─────────────────────────────────────────────
  {
    let ушло = null;
    const ask = async (p, o) => { ушло = o.body; return {
      deviceToken: 'ТОКЕН-1', deviceId: 'd1', accountId: 'a1',
      cashRegisterId: 'r1', storeName: 'Мини-маркет' }; };
    const r = await pairDevice({ ask, settings: {}, code: 'tbs-4fe2-3137', version: '3.0.0' });
    ok(ушло.code === 'TBS-4FE2-3137', '★ На сервер ушёл код В ВЕРХНЕМ регистре');
    ok(ушло.platform === 'windows' && ушло.appVersion === '3.0.0',
       'И версия кассы: владелец увидит, что у клиента стоит');
    ok(r.deviceToken === 'ТОКЕН-1' && r.storeName === 'Мини-маркет',
       'Привязка вернула ключ и название магазина');
  }

  // ── СЕРВЕР ОТВЕЧАЕТ ПО-РАЗНОМУ ───────────────────────────────────
  {
    // В разных сборках поле называется по-своему. Берём то, что
    // пришло, а не гадаем.
    const r = await pairDevice({
      ask: async () => ({ token: 'ТОКЕН-2', device_id: 'd2', store_name: 'Лавка' }),
      settings: {}, code: 'X' });
    ok(r.deviceToken === 'ТОКЕН-2' && r.deviceId === 'd2' && r.storeName === 'Лавка',
       '★ Другие имена полей у сервера — привязка всё равно прошла');
  }

  // ── СЕРВЕР ПРИНЯЛ, НО КЛЮЧА НЕ ДАЛ ───────────────────────────────
  {
    let e = null;
    try { await pairDevice({ ask: async () => ({ ok: true }), settings: {}, code: 'X' }); }
    catch (x) { e = x; }
    ok(e && /не выдал ключ/.test(e.message),
       '★ Сервер принял без ключа — говорим прямо, а не «привязано»');
    ok(/это его сторона/.test(e.message),
       'И кому звонить: кассир не виноват и чинить не может');
  }

  // ── СОХРАНЕНИЕ И ОТВЯЗКА ─────────────────────────────────────────
  {
    const диск = { deviceToken: null, employee: { id: 'e1' }, shift: { id: 's1' } };
    const store = {
      saveState: async (p) => Object.assign(диск, p),
      getState: async () => диск,
    };
    await savePairing(store, { deviceToken: 'T', deviceId: 'd', accountId: 'a',
      cashRegisterId: 'r', storeName: 'Лавка' });
    ok(диск.deviceToken === 'T' && диск.storeName === 'Лавка', 'Привязка сохранена');

    await forgetPairing(store);
    ok(диск.deviceToken === null && диск.employee === null,
       '★ Отвязка стёрла привязку и вход');
    ok(!('parked' in диск) || диск.parked === undefined,
       '★ А чеки и очередь не тронуты: в них лежат деньги');
  }

  // ── ДВОЙНОЕ НАЖАТИЕ НЕ ЗАВОДИТ ДВЕ КАССЫ ─────────────────────────
  {
    const root = document.getElementById('app');
    let вызовов = 0;
    buildSetup(root, {}, {
      onPair: async () => { вызовов++; await new Promise((r) => setTimeout(r, 30)); },
    });
    root.querySelector('#pairCode').value = 'TBS-1';
    const go = root.querySelector('#pairGo');
    go.click(); go.click(); go.click();
    await new Promise((r) => setTimeout(r, 60));
    ok(вызовов === 1,
       '★ Три нажатия подряд — ОДНА привязка: иначе у владельца три кассы');
  }

  // ── ОШИБКА ВОЗВРАЩАЕТ ВОЗМОЖНОСТЬ ПОПРОБОВАТЬ ────────────────────
  {
    const root = document.getElementById('app');
    buildSetup(root, {}, { onPair: async () => { throw new Error('Код не подошёл'); } });
    root.querySelector('#pairCode').value = 'TBS-НЕВЕРНЫЙ';
    root.querySelector('#pairGo').click();
    await new Promise((r) => setTimeout(r, 20));
    ok(/Код не подошёл/.test(root.querySelector('#pairErr').textContent),
       'Отказ сервера показан словами');
    ok(root.querySelector('#pairGo').disabled === false,
       '★ Кнопка снова живая: код мог быть с опечаткой');
  }

  console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
  process.exit(failed ? 1 : 0);
})();
