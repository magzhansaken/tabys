/** Подчасти 2.5–2.6: архив, фильтры, упаковки, цены по точкам. */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { CatalogService } = require('../dist/goods/catalog.service');
  const db = new DbService();
  const svc = new CatalogService(db);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Каталог Тест','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  const ids = await tx(async (c) => {
    const shtId = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const kgId = (await c.query(`SELECT id FROM unit WHERE short_name='кг' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const store1 = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const store2 = (await c.query(`INSERT INTO store (account_id, name) VALUES ($1,'Точка на рынке') RETURNING id`, [accountId])).rows[0].id;
    const cat = (await c.query(`INSERT INTO category (account_id, name) VALUES ($1,'Табак') RETURNING id`, [accountId])).rows[0].id;

    const cig = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, category_id, marking, ntin, purchase_price, min_price)
      VALUES ($1,'Сигареты Winston','simple',$2,$3,'tobacco','04870201112223',600,700) RETURNING id`, [accountId, shtId, cat])).rows[0].id;
    await c.query(`INSERT INTO barcode (account_id, product_id, code, type, is_primary) VALUES ($1,$2,'4870201112223','ean13',true)`, [accountId, cig]);
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,750)`, [accountId, cig, rt]);

    const app = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id) VALUES ($1,'Яблоки Апорт','weight',$2) RETURNING id`, [accountId, kgId])).rows[0].id;
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,890)`, [accountId, app, rt]);

    const bun = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id) VALUES ($1,'Набор к чаю','bundle',$2) RETURNING id`, [accountId, shtId])).rows[0].id;
    const cake = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id) VALUES ($1,'Печенье','simple',$2) RETURNING id`, [accountId, shtId])).rows[0].id;
    await c.query(`INSERT INTO bundle_item (account_id, bundle_id, component_id, qty) VALUES ($1,$2,$3,2)`, [accountId, bun, cake]);
    return { cig, app, bun, cake, store1, store2, cat };
  });

  // ---------- ФИЛЬТРЫ (набор Wipon + смарт-фильтр UMAG) ----------
  let r = await svc.filter(accountId, {});
  ok(r.total === 4, `Все товары: ${r.total}`);
  r = await svc.filter(accountId, { noNtin: true });
  ok(r.total === 3 && r.items.every((i) => !i.ntin), 'Смарт-фильтр «код НКТ = нет» (UMAG): 3 позиции требуют заполнения');
  r = await svc.filter(accountId, { hasNtin: true });
  ok(r.total === 1, 'Фильтр «синхронизирован с НКТ» (Wipon): 1 позиция');
  r = await svc.filter(accountId, { weightOnly: true });
  ok(r.total === 1 && r.items[0].name === 'Яблоки Апорт', 'Вкладка «Весовые» (UMAG)');
  r = await svc.filter(accountId, { marked: true });
  ok(r.total === 1 && r.items[0].name === 'Сигареты Winston', 'Фильтр по маркированным товарам');
  r = await svc.filter(accountId, { categoryId: ids.cat });
  ok(r.total === 1, 'Фильтр по категории');
  r = await svc.filter(accountId, { priceFrom: 800 });
  ok(r.total === 1 && r.items[0].name === 'Яблоки Апорт', 'Фильтр по цене продажи (Wipon)');
  r = await svc.filter(accountId, { q: '4870201112223' });
  ok(r.total === 1 && r.items[0].name === 'Сигареты Winston', 'Поиск по штрихкоду');
  r = await svc.filter(accountId, { q: 'ябло' });
  ok(r.total === 1, 'Поиск по части слова');
  r = await svc.filter(accountId, { changedFrom: new Date(Date.now() - 60000).toISOString() });
  ok(r.total === 4, 'Фильтр «по последнему изменению» (Wipon)');

  // ---------- АРХИВ (модель МС: скрыт, но не удалён) ----------
  const a = await svc.archive(accountId, [ids.app]);
  ok(a.affected === 1, 'Товар отправлен в архив');
  r = await svc.filter(accountId, {});
  ok(r.total === 3 && !r.items.some((i) => i.name === 'Яблоки Апорт'), 'Архивный товар пропал из основного списка');
  r = await svc.filter(accountId, { archived: true });
  ok(r.total === 1 && r.items[0].name === 'Яблоки Апорт', 'Но он виден в архиве — «скрыт, но не удалён» (цитата МС)');
  const alive = await tx(async (c) => (await c.query(`SELECT deleted_at FROM product WHERE id=$1`, [ids.app])).rows[0].deleted_at);
  ok(alive === null, 'Физически товар не удалён: на него ссылаются прошлые продажи');
  const back = await svc.archive(accountId, [ids.app], false);
  ok(back.affected === 1, 'Восстановление из архива одной кнопкой');
  r = await svc.filter(accountId, {});
  ok(r.total === 4, 'Товар вернулся в список');

  // ---------- АРХИВ НЕ ЛОМАЕТ КОМПЛЕКТЫ ----------
  const blocked = await svc.archive(accountId, [ids.cake]);
  ok(blocked.affected === 0 && blocked.blocked.includes('Печенье'),
     'Товар из комплекта не архивируется — иначе набор продавался бы и списывал несуществующее');
  ok(/входят в комплекты/.test(blocked.message), 'Владельцу объяснено, почему нельзя и что делать');

  // ---------- УПАКОВКИ (модель МС: блок сигарет = 10 пачек) ----------
  const pkg = await svc.addPackage(accountId, { productId: ids.cig, name: 'Блок', quantity: 10, barcode: '4870201112230', defaultPurchase: true });
  ok(pkg.quantity == 10, 'Упаковка «Блок» = 10 пачек (МС; ни UMAG, ни Wipon так не умеют)');
  const pkgs = await svc.packages(accountId, ids.cig);
  ok(pkgs.length === 1 && pkgs[0].barcode === '4870201112230', 'У блока свой штрихкод — сканируешь блок при приёмке, пачку на кассе');
  let badPkg = false;
  try { await svc.addPackage(accountId, { productId: ids.cig, name: 'Пустая', quantity: 0 }); } catch { badPkg = true; }
  ok(badPkg, 'Упаковка с нулевым количеством отклонена');

  // сканирование блока даёт 10 штук
  const { GoodsService } = require('../dist/goods/goods.service');
  const goods = new GoodsService(db);
  const scan = await goods.scan(accountId, '4870201112230');
  ok(scan && (scan.quantity == 10 || scan.package_qty == 10 || scan.source === 'package'),
     'Сканирование блока распознаётся как упаковка', JSON.stringify(scan));

  // ---------- ЦЕНЫ ПО ТОЧКАМ (у Wipon это платный модуль) ----------
  await svc.setPrice(accountId, { productId: ids.cig, value: 800, storeId: ids.store2 });
  const p1 = await svc.priceFor(accountId, ids.cig, ids.store1);
  const p2 = await svc.priceFor(accountId, ids.cig, ids.store2);
  ok(p1.value === 750 && !p1.fromStore, 'В магазине у дома цена общая — 750 ₸');
  ok(p2.value === 800 && p2.fromStore, 'На рынке своя цена — 800 ₸ (Wipon берёт за это отдельные деньги)');
  const all = await svc.prices(accountId, ids.cig);
  ok(all.length === 2, 'В карточке видно обе цены: общая и по точке');

  // ---------- ОПТОВАЯ ЦЕНА ----------
  await svc.setPrice(accountId, { productId: ids.cig, typeCode: 'wholesale', value: 700 });
  const w = await svc.priceFor(accountId, ids.cig, null, 'wholesale');
  ok(w.value === 700, 'Оптовая цена задана отдельным типом (UMAG: продажная и оптовая)');

  // ---------- МИНИМАЛЬНАЯ ЦЕНА (МС: защита от продажи в убыток) ----------
  let low = false;
  try { await svc.setPrice(accountId, { productId: ids.cig, value: 650 }); } catch (e) { low = /минимальной/.test(e.message); }
  ok(low, 'Цена ниже минимальной отклонена — защита от продажи в убыток (модель МС)');

  // ---------- ИЗОЛЯЦИЯ ----------
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  const foreign = await svc.filter(acc2.account_id, {});
  ok(foreign.total === 0, 'Чужой аккаунт не видит наш каталог');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
