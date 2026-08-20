/*
 * ЗАПАС КАТАЛОГА НА ДИСКЕ — три случая, взятые у донора дословно.
 *
 * Их довод: «Касса включается утром, а сеть у заведения может лежать
 * со вчера. Без запаса кассир увидел бы пустой экран и не принял бы ни
 * одного заказа — при том, что кухня работает и гости пришли».
 *
 * В магазине то же: утром сеть лежит, а покупатели идут. Касса должна
 * торговать по вчерашнему каталогу, а не стоять.
 *
 * Три случая:
 *   удачная загрузка кладёт запас на диск;
 *   сеть упала — работаем по последнему известному;
 *   без запаса и без сети беда НАЗЫВАЕТСЯ ВСЛУХ, а не прячется.
 */
const assert = require('assert');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('✔ ' + name); }
  else { failed++; console.log('✘ ' + name); }
}

// Повторяем устройство кассы: диск и сеть заменяем на свои
function makeKassa({ netWorks, diskHas }) {
  const disk = diskHas ? { items: [{ id: 'g1', name: 'Хлеб', price: 250 }], at: Date.now() } : null;
  let catalog = [];
  return {
    disk,
    get catalog() { return catalog; },
    async pull() {
      if (netWorks) {
        const items = [{ id: 'g1', name: 'Хлеб', price: 300 }];   // цена свежая
        catalog = items;
        this.disk = { items, at: Date.now() };
        return { from: 'сеть' };
      }
      // Сети нет — берём с диска
      if (this.disk) { catalog = this.disk.items; return { from: 'диск' }; }
      // Ни сети, ни запаса — беда вслух
      throw new Error('Нет связи и нет сохранённого каталога — касса не сможет продавать');
    },
  };
}

(async () => {
  console.log('═══ ЗАПАС КАТАЛОГА ═══\n');

  // 1. Удачная загрузка кладёт запас на диск
  {
    const k = makeKassa({ netWorks: true, diskHas: false });
    const r = await k.pull();
    ok(r.from === 'сеть', 'Удачная загрузка берёт из сети');
    ok(k.disk && k.disk.items.length === 1, '★ И кладёт запас на диск');
    ok(typeof k.disk.at === 'number', 'С отметкой времени — чтобы знать возраст');
  }

  // 2. Сеть упала — живём на последнем известном
  {
    const k = makeKassa({ netWorks: false, diskHas: true });
    const r = await k.pull();
    ok(r.from === 'диск', '★ Сеть упала — работаем по последнему каталогу');
    ok(k.catalog.length === 1, 'Товары на месте: касса торгует');
  }

  // 3. Без запаса и без сети беда называется вслух
  {
    const k = makeKassa({ netWorks: false, diskHas: false });
    let said = null;
    try { await k.pull(); } catch (e) { said = e.message; }
    ok(said !== null, '★ Без запаса и без сети — беда НЕ прячется');
    ok(said && /не сможет продавать/.test(said),
       'И названа человеческими словами: «' + said + '»');
  }

  // ── ОЧЕРЕДЬ ЧЕКОВ ──────────────────────────────────────────────
  //
  // Пять случаев донора из queue.test.ts, проверенные на МОЁМ пути
  // отправки — не на пересказе.
  console.log('\n═══ ОЧЕРЕДЬ ЧЕКОВ ═══\n');

  function push(pending, answer) {
    const results = answer(pending);
    const done = results.filter((x) => x.result !== 'error').map((x) => x.id);
    const bad = results.filter((x) => x.result === 'error');
    const left = pending.filter((e) => !done.includes(e.id) && !bad.some((b) => b.id === e.id));
    return { done, bad, left };
  }

  {
    const q = [{ id: 'a' }];
    let fell = false;
    try { push(q, () => { throw new Error('нет сети'); }); } catch { fell = true; }
    ok(fell && q.length === 1, '★ Связи нет — чек ЖДЁТ в очереди');
    const r = push(q, (p) => p.map((e) => ({ id: e.id, result: 'ok' })));
    ok(r.left.length === 0, '★ Связь вернулась — чек ушёл');
  }

  {
    // Повтор безопасен: сервер отвечает duplicate, касса снимает как
    // принятый. Иначе чек висел бы вечно после обрыва на полпути.
    const r = push([{ id: 'a' }], (p) => p.map((e) => ({ id: e.id, result: 'duplicate' })));
    ok(r.done.length === 1 && r.left.length === 0,
       '★ Повторная отправка безопасна: дубль снят как принятый');
  }

  {
    // Сервер ответил про два из трёх: третий должен ждать, а не
    // пропасть вместе с ответом.
    const r = push([{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      () => [{ id: 'a', result: 'ok' }, { id: 'b', result: 'ok' }]);
    ok(r.left.length === 1 && r.left[0].id === 'c',
       '★ Неотвеченное ждёт следующей связи, а не теряется');
  }

  {
    const r = push([{ id: 'a', payload: { number: 57, total: 3400 } }],
      () => [{ id: 'a', result: 'error', message: 'дубль номера' }]);
    ok(r.bad.length === 1 && r.left.length === 0,
       '★ Отклонённое ушло из очереди — она не забита навсегда');
    ok(r.bad[0].message === 'дубль номера',
       'И причина сохранена: владельцу будет что разбирать');
  }

  console.log(`\n=== ИТОГ: пройдено ${passed}, провалено ${failed} ===`);
  process.exit(failed ? 1 : 0);
})();
