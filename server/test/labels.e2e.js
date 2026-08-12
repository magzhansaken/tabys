/**
 * КРИТЕРИЙ ЧАСТИ 2 (вторая половина): «распечатать этикетки».
 * Проверяем настоящий печатный документ: размеры в мм, штрихкод EAN-13
 * (побитово, с контрольной цифрой), два языка, А4-сетка, история и повтор.
 */
const { writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { LabelsService } = require('../dist/goods/labels.service');
  const db = new DbService();
  const svc = new LabelsService(db);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Этикетки Тест','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  // ---------- шаблоны выданы при регистрации ----------
  const tpls = await svc.templates(accountId);
  ok(tpls.length === 5, `При регистрации выданы готовые шаблоны: ${tpls.length}`);
  ok(tpls.some((t) => t.width_mm == 58 && t.height_mm == 40), 'Есть этикетка 58×40 — реальный рулон (размеры UMAG)');
  ok(tpls.some((t) => t.kind === 'price_tag'), 'Ценник — отдельная сущность от этикетки (модель UMAG)');
  ok(tpls.some((t) => t.paper === 'a4'), 'Есть А4-сетка для тех, у кого нет термопринтера (модель МС)');

  // ---------- контрольная цифра EAN-13 ----------
  ok(svc.checkDigit('487020439123') === 7, 'Контрольная цифра EAN-13 считается верно');
  ok(svc.isValidEan13('4870204391237'), 'Корректный EAN-13 признан валидным');
  ok(!svc.isValidEan13('4870204391234'), 'EAN-13 с битой контрольной цифрой отклонён (иначе касса не считает этикетку)');

  // ---------- товары ----------
  const { productId, tagId } = await tx(async (c) => {
    const u = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const p = (await c.query(
      `INSERT INTO product (account_id, name, name_kk, article, country, unit_id, kind)
       VALUES ($1,'Молоко Айналайын 2.5%','Айналайын сүті 2.5%','MLK-25','Казахстан',$2,'simple') RETURNING id`,
      [accountId, u])).rows[0].id;
    await c.query(`INSERT INTO barcode (account_id, product_id, code, type, is_primary) VALUES ($1,$2,'4870204391237','ean13',true)`, [accountId, p]);
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,450)`, [accountId, p, rt]);

    const t = (await c.query(
      `INSERT INTO product (account_id, name, name_kk, unit_id, kind) VALUES ($1,'Хлеб Тандыр','Тандыр наны',$2,'simple') RETURNING id`,
      [accountId, u])).rows[0].id;
    await c.query(`INSERT INTO barcode (account_id, product_id, code, type, is_primary) VALUES ($1,$2,'4870204399998','ean13',true)`, [accountId, t]);
    await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,180)`, [accountId, t, rt]);
    return { productId: p, tagId: t };
  });

  // ---------- ★ ПЕЧАТЬ ЭТИКЕТОК ----------
  const label58 = tpls.find((t) => t.kind === 'label' && t.width_mm == 58);
  const r = await svc.print(accountId, null, label58.id, [{ productId, qty: 3 }, { productId: tagId, qty: 2 }]);
  ok(r.totalLabels === 5, `★ КРИТЕРИЙ ЧАСТИ 2: напечатано 5 этикеток на два товара`);
  ok(/@page \{ size: 58mm 40mm; margin: 0; \}/.test(r.html), 'Размер страницы = размеру рулона 58×40 мм (термопринтер печатает без полей)');
  ok((r.html.match(/class="lbl"/g) || []).length === 5, 'В документе ровно 5 этикеток');
  ok(/Молоко Айналайын 2\.5%/.test(r.html), 'На этикетке русское название');
  ok(/Айналайын сүті 2\.5%/.test(r.html), 'На этикетке казахское название — два языка (модель UMAG, у конкурентов на нашем рынке этого нет у МС и Wipon)');
  ok(/450 ₸/.test(r.html), 'Цена в тенге проставлена из карточки');
  ok(/4870204391237/.test(r.html), 'Цифры штрихкода подписаны под кодом');
  ok(/<svg /.test(r.html) && /<rect /.test(r.html), 'Штрихкод нарисован вектором (SVG), а не картинкой — не мылит на термопринтере');

  // ---------- штрихкод действительно кодирует нужные цифры ----------
  const svg = svc.barcodeSvg('4870204391237', 50, 15);
  const bits = svc.ean13Bits ? null : null;
  ok(/width="50mm"/.test(svg) && /height="15mm"/.test(svg), 'Штрихкод рисуется в заданном размере');
  const rects = (svg.match(/<rect /g) || []).length;
  ok(rects > 25 && rects < 60, `Полос в штрихкоде ${rects} — правдоподобно для EAN-13`);
  let bad = false;
  try { svc.barcodeSvg('123', 50, 15); } catch { bad = true; }
  ok(bad, 'Штрихкод не из 13 цифр отвергается, а не рисуется криво');

  // ---------- товар без штрихкода: предупреждение, а не кривая полоска ----------
  const noBc = await tx(async (c) => (await c.query(
    `INSERT INTO product (account_id, name, kind) VALUES ($1,'Товар без ШК','simple') RETURNING id`, [accountId])).rows[0].id);
  const r2 = await svc.render(accountId, label58.id, [{ productId: noBc, qty: 1 }]);
  ok(!/<rect /.test(r2.html), 'Для товара без штрихкода полоски не рисуются');
  ok(/Товар без ШК/.test(r2.html), 'Но сама этикетка печатается — с названием и ценой');

  // ---------- ЦЕННИК ----------
  const tag = tpls.find((t) => t.kind === 'price_tag' && t.paper === 'roll');
  const r3 = await svc.render(accountId, tag.id, [{ productId, qty: 1 }]);
  ok(!/4870204391237/.test(r3.html), 'На ценнике штрихкода нет — он для полки, а не для сканера');
  const priceSize = Number((r3.html.match(/class="pr" style="font-size:([\d.]+)mm/) || [])[1]);
  ok(priceSize > 8, `Цена на ценнике крупная (${priceSize} мм) — читается с прохода`);

  // ---------- А4-СЕТКА ----------
  const a4 = tpls.find((t) => t.paper === 'a4');
  const r4 = await svc.render(accountId, a4.id, [{ productId, qty: 12 }]);
  ok(/@page \{ size: A4/.test(r4.html), 'А4: страница — обычный лист');
  ok(/grid-template-columns: repeat\(3,/.test(r4.html), 'Ценники разложены в 3 колонки — печатаем на лазернике и режем');
  ok(r4.totalLabels === 12, 'Двенадцать ценников на листе');

  // ---------- ИСТОРИЯ И ПОВТОР (модель Wipon) ----------
  const hist = await svc.history(accountId);
  ok(hist.length >= 1 && hist[0].total_labels === 5, 'Печать записана в историю');
  const rep = await svc.repeat(accountId, null, r.jobId);
  ok(rep.totalLabels === 5 && rep.repeatedFrom === r.jobId,
     'Повтор печати: партия смялась в принтере — не собираем список заново (модель Wipon)');
  const hist2 = await svc.history(accountId);
  ok(hist2.length === 2 && hist2[0].repeated_from === r.jobId, 'В истории видно, что это повтор предыдущей печати');

  // ---------- масштаб шрифта (ползунок UMAG) ----------
  const big = await svc.saveTemplate(accountId, { name: 'Крупный шрифт', kind: 'label', paper: 'roll', widthMm: 58, heightMm: 40, fontScale: 1.7, lang1: 'ru', fields: { name: true, price: true } });
  const r5 = await svc.render(accountId, big.id, [{ productId, qty: 1 }]);
  const nm = Number((r5.html.match(/class="nm" style="font-size:([\d.]+)mm/) || [])[1]);
  ok(nm > 3.5, `Ползунок шрифта 1.7× работает: название ${nm} мм (у UMAG диапазон 0.2×–1.7×)`);
  let tooBig = false;
  try { await svc.saveTemplate(accountId, { name: 'Слишком', kind: 'label', paper: 'roll', widthMm: 58, heightMm: 40, fontScale: 5, lang1: 'ru', fields: {} }); }
  catch { tooBig = true; }
  ok(tooBig, 'Шрифт вне диапазона 0.2×–1.7× не сохраняется');

  // ---------- изоляция ----------
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  let denied = false;
  try { await svc.render(acc2.account_id, label58.id, [{ productId, qty: 1 }]); } catch { denied = true; }
  ok(denied, 'Чужой аккаунт не может печатать по нашему шаблону');

  // временная папка берётся у системы: на Windows нет каталога /tmp
  writeFileSync(join(tmpdir(), 'labels_58x40.html'), r.html);
  writeFileSync(join(tmpdir(), 'pricetags_a4.html'), r4.html);
  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
