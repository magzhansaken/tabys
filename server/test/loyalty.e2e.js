/**
 * ЧАСТЬ 10 — ЛОЯЛЬНОСТЬ И МАРКЕТИНГ.
 * Эталон — Wipon Cashback. У UMAG модуля нет вовсе (только поле «бонусы»
 * в карточке) — это наше видимое преимущество №2 после офлайна.
 */
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) < eps;

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const { LoyaltyService, MockSmsGateway, smsCost } = require('../dist/loyalty/loyalty.service');
  const { PosService } = require('../dist/pos/pos.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const { ContragentService } = require('../dist/contragents/contragent.service');

  const db = new DbService();
  const goods = new GoodsService(db);
  const svc = new LoyaltyService(db);
  const pos = new PosService(db, goods);
  const stock = new StockService(db, new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 }), goods);
  const cps = new ContragentService(db);
  const sms = new MockSmsGateway();
  svc.setSmsGateway(sms);

  const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);
  const acc = (await db.raw(`SELECT * FROM register_account($1,'Магазин Лояльность','Айгуль','ru')`, [phone])).rows[0];
  const accountId = acc.account_id, ownerId = acc.employee_id;
  const tx = (fn) => db.withTenant(accountId, fn);

  const ctx = await tx(async (c) => {
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const coffee = (await c.query(`INSERT INTO category (account_id, name) VALUES ($1,'Кофе') RETURNING id`, [accountId])).rows[0].id;
    const bakery = (await c.query(`INSERT INTO category (account_id, name) VALUES ($1,'Выпечка') RETURNING id`, [accountId])).rows[0].id;
    const g = {};
    for (const [k, name, price, cost, cat] of [
      ['latte', 'Латте', 700, 200, coffee],
      ['espresso', 'Эспрессо', 500, 150, coffee],
      ['bun', 'Булочка', 300, 100, bakery],
      ['milk', 'Молоко', 500, 300, null],
    ]) {
      const id = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, category_id, purchase_price) VALUES ($1,$2,'simple',$3,$4,$5) RETURNING id`, [accountId, name, sht, cat, cost])).rows[0].id;
      await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,$4)`, [accountId, id, rt, price]);
      g[k] = id;
    }
    return { store, wh, reg, coffee, bakery, ...g };
  });
  const sup = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh, employeeId: ownerId });
  for (const k of ['latte', 'espresso', 'bun', 'milk']) await stock.addItem(accountId, sup.id, { productId: ctx[k], qty: 500, price: 200 });
  await stock.process(accountId, sup.id);

  // ============ 10.1 БОНУСНЫЕ ПРОГРАММЫ (границы Wipon) ============
  let bad = false;
  try { await svc.createProgram(accountId, { name: 'Жадная', earnPercent: 50 }); } catch (e) { bad = /от 0 до 10/.test(e.message); }
  ok(bad, 'Процент начисления выше 10% отклонён — граница из документации Wipon');
  try { bad = false; await svc.createProgram(accountId, { name: 'Х', spendPercent: 95 }); } catch (e) { bad = /до 90/.test(e.message); }
  ok(bad, 'Списание больше 90% чека отклонено (граница Wipon)');
  try { bad = false; await svc.createProgram(accountId, { name: 'Х', expireDays: 5 }); } catch (e) { bad = /от 10 до 360/.test(e.message); }
  ok(bad, 'Срок сгорания вне 10–360 дней отклонён (граница Wipon)');

  const prog = await svc.createProgram(accountId, {
    name: 'Накопительные бонусы', earnPercent: 5, spendPercent: 30, maxSpend: 2000, minPurchase: 1000, expireDays: 30,
  });
  ok(Number(prog.earn_percent) === 5 && Number(prog.expire_days) === 30, 'Программа «Накопительные бонусы» создана');

  const prog2 = await svc.createProgram(accountId, { name: 'Вторая накопительная', earnPercent: 7 });
  const all = await svc.programs(accountId);
  ok(all.filter((p) => p.kind === 'cashback' && p.is_active).length === 1,
     'Активна только одна накопительная программа — иначе непонятно, какая сработала');
  ok(all.find((p) => p.is_active && p.kind === 'cashback').id === prog2.id,
     'Новая программа заменила старую, а не встала рядом');
  // возвращаем в бой первую: дальше проверяем её параметры (5%, 30%, макс 2000)
  await tx(async (c) => {
    await c.query(`UPDATE loyalty_program SET is_active=false WHERE id=$1`, [prog2.id]);
    await c.query(`UPDATE loyalty_program SET is_active=true WHERE id=$1`, [prog.id]);
  });

  await svc.createProgram(accountId, { kind: 'welcome', name: 'Приветственные', bonusAmount: 500, bonusValidDays: 14 });
  await svc.createProgram(accountId, { kind: 'birthday', name: 'День рождения', bonusAmount: 1000, bonusValidDays: 7 });
  ok((await svc.programs(accountId)).length === 4, 'Три вида программ: накопительные, приветственные, день рождения (набор Wipon)');

  // ============ ★ ПРИВЕТСТВЕННЫЕ БОНУСЫ ============
  const azamat = await cps.create(accountId, { name: 'Азамат', phone: '+77015551234' });
  const join = await svc.joinLoyalty(accountId, azamat.id, '1990-07-17');
  ok(join.joined && join.welcomeBonus === 500 && join.card,
     `★ Регистрация в программе: приветственные ${join.welcomeBonus} ₸, номер карты ${join.card}`);
  const again = await svc.joinLoyalty(accountId, azamat.id);
  ok(!again.joined && /уже в программе/.test(again.reason), 'Второй раз приветственные не начисляются');

  const bal0 = await svc.balance(accountId, azamat.id);
  ok(bal0.balance === 500 && bal0.expiringSoon?.amount === 500,
     `Баланс ${bal0.balance} ₸, и сразу видно, что скоро сгорит (срок 14 дней)`);

  // ============ ★ НАЧИСЛЕНИЕ ============
  const sh = await pos.openShift(accountId, { cashRegisterId: ctx.reg, employeeId: ownerId, openingFloat: 5000 });
  const s1 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId, customerId: azamat.id });
  const c1 = await pos.addToCart(accountId, s1.id, { productId: ctx.milk, qty: 1 });   // 500 ₸ — мало
  const p1 = await pos.pay(accountId, s1.id, [{ method: 'cash', amount: Number(c1.total), received: 500 }]);
  const e1 = await svc.earn(accountId, p1.id);
  ok(e1.earned === 0 && /начисляются от 1000/.test(e1.reason),
     `Чек 500 ₸ — бонусы не начислены: «${e1.reason}» (правило Wipon: покупка от 1000 ₸)`);

  const s2 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId, customerId: azamat.id });
  const c2 = await pos.addToCart(accountId, s2.id, { productId: ctx.milk, qty: 8 });   // 4000 ₸
  const p2 = await pos.pay(accountId, s2.id, [{ method: 'card', amount: Number(c2.total) }]);
  const e2 = await svc.earn(accountId, p2.id);
  ok(e2.earned === 200, `★ Чек 4000 ₸ → начислено ${e2.earned} ₸ (5%)`);
  ok(/Начислено бонусов: 200 ₸, действуют до/.test(e2.receiptLine),
     `На чеке видно, что начислено и когда сгорит: «${e2.receiptLine}»`);
  const dup = await svc.earn(accountId, p2.id);
  ok(dup.earned === 0 && /уже начислены/.test(dup.reason), 'Повторное начисление за тот же чек не проходит');

  // ============ ★ СПИСАНИЕ: три ограничения Wipon ============
  const sp1 = await svc.spendable(accountId, azamat.id, 3000);
  ok(sp1.canSpend === 700 && sp1.balance === 700, `Баланс ${sp1.balance} ₸, к списанию ${sp1.canSpend} ₸`);
  const sp2 = await svc.spendable(accountId, azamat.id, 1000);
  ok(sp2.canSpend === 300 && /не больше 30% чека/.test(sp2.hint),
     `★ Чек 1000 ₸ → списать можно 300 ₸: «${sp2.hint}». Кассиру придётся сказать это вслух`);

  await tx(async (c) => c.query(`SELECT apply_bonus_move($1,$2,10000::numeric,'manual',NULL,NULL,NULL,'Тест',NULL)`, [accountId, azamat.id]));
  const sp3 = await svc.spendable(accountId, azamat.id, 50000);
  ok(sp3.canSpend === 2000 && /Максимум за одну покупку — 2000/.test(sp3.hint),
     `★ Упёрлись в максимум за покупку: ${sp3.canSpend} ₸ — «${sp3.hint}»`);

  const s3 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId, customerId: azamat.id });
  const c3 = await pos.addToCart(accountId, s3.id, { productId: ctx.latte, qty: 10 });  // 7000 ₸
  const spend = await svc.spend(accountId, { counterpartyId: azamat.id, saleId: s3.id, amount: 2000, saleTotal: Number(c3.total), employeeId: ownerId });
  ok(spend.spent === 2000 && near(spend.balance, 8700), `Списано ${spend.spent} ₸, остаток ${spend.balance} ₸`);
  let tooMuch = false;
  try { await svc.spend(accountId, { counterpartyId: azamat.id, saleId: s3.id, amount: 5000, saleTotal: 7000 }); } catch { tooMuch = true; }
  ok(tooMuch, 'Списать больше лимита нельзя');

  // ★ бонусы не начисляются на бонусы
  const p3 = await pos.pay(accountId, s3.id, [{ method: 'bonus', amount: 2000 }, { method: 'cash', amount: 5000, received: 5000 }]);
  ok(Number(p3.paid_bonus) === 2000 && Number(p3.paid_cash) === 5000,
     `★ Смешанная оплата: ${p3.paid_bonus} ₸ бонусами + ${p3.paid_cash} ₸ наличными. Проверка нашла: способ «bonus» был в перечислении с Части 4, но касса его не разносила`);
  let bonusNoCustomer = false;
  const sx = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  await pos.addToCart(accountId, sx.id, { productId: ctx.milk, qty: 1 });
  try { await pos.pay(accountId, sx.id, [{ method: 'bonus', amount: 500 }]); } catch (e) { bonusNoCustomer = /выбранным покупателем/.test(e.message); }
  ok(bonusNoCustomer, 'Бонусами без покупателя платить нельзя — бонусы принадлежат человеку');
  const e3 = await svc.earn(accountId, p3.id);
  ok(e3.earned === 250,
     `★ Чек 7000 ₸, из них 2000 бонусами → начислено ${e3.earned} ₸ с 5000 реальных денег, а не с 7000. Бонусы на бонусы — это вечный двигатель`);

  // ============ ★ FIFO И СГОРАНИЕ ============
  const marat = await cps.create(accountId, { name: 'Марат', phone: '+77015559999' });
  await svc.joinLoyalty(accountId, marat.id);
  await tx(async (c) => {
    // старое начисление сгорает завтра, новое — через месяц
    await c.query(`SELECT apply_bonus_move($1,$2,300::numeric,'earn',NULL,NULL,NULL,'Старое',now() + interval '1 day')`, [accountId, marat.id]);
    await c.query(`SELECT apply_bonus_move($1,$2,700::numeric,'earn',NULL,NULL,NULL,'Новое',now() + interval '30 days')`, [accountId, marat.id]);
  });
  const s4 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId, customerId: marat.id });
  await pos.addToCart(accountId, s4.id, { productId: ctx.latte, qty: 5 });
  await svc.spend(accountId, { counterpartyId: marat.id, saleId: s4.id, amount: 400, saleTotal: 3500, employeeId: ownerId });
  // порядок сгорания у Марата: «Старое» (1 день) → приветственные (14 дней) → «Новое» (30 дней)
  const fifo = await tx(async (c) => (await c.query(
    `SELECT coalesce(comment,'') AS comment, amount, used_amount FROM bonus_move
      WHERE counterparty_id=$1 AND amount > 0 ORDER BY expires_at`, [marat.id])).rows);
  ok(fifo[0].comment === 'Старое' && Number(fifo[0].used_amount) === 300,
     '★ Списываем сначала то, что сгорит раньше: «Старое» израсходовано целиком (300 из 300)');
  ok(/Приветственные/.test(fifo[1].comment) && Number(fifo[1].used_amount) === 100,
     'Остаток взят из приветственных (100 из 500) — они сгорают следующими');
  ok(fifo[2].comment === 'Новое' && Number(fifo[2].used_amount) === 0,
     '★ «Новое» не тронуто: у клиента не сгорит то, что он только что заработал');

  await tx(async (c) => c.query(`UPDATE bonus_move SET expires_at = now() - interval '1 hour' WHERE counterparty_id=$1 AND comment='Новое'`, [marat.id]));
  const exp = await svc.expireBonuses(accountId);
  ok(exp.clients === 1 && near(exp.total, 700), `★ Сгорело неизрасходованное «Новое» целиком: ${exp.total} ₸`);
  const balM = await svc.balance(accountId, marat.id);
  // 500 приветственных + 300 старых + 700 новых − 400 списано − 700 сгорело
  ok(near(balM.balance, 400) && near(balM.expiredTotal, 700), `Баланс Марата ${balM.balance} ₸, сгорело всего ${balM.expiredTotal} ₸`);

  // проверка: испорченный баланс пересобирается из движений
  await tx(async (c) => c.query(`UPDATE bonus_balance SET balance = 99999 WHERE counterparty_id=$1`, [marat.id]));
  await db.raw(`SELECT recalc_bonus_balance($1,$2)`, [accountId, marat.id]);
  ok(near((await svc.balance(accountId, marat.id)).balance, 400), 'Баланс бонусов пересобран из движений — принцип из 1.3');

  // ============ ★ ВОЗВРАТ ============
  const before = (await svc.balance(accountId, azamat.id)).balance;
  const ref = await pos.refund(accountId, { saleId: p2.id, shiftId: sh.id, employeeId: ownerId });
  const rr = await svc.handleRefund(accountId, ref.id, p2.id);
  ok(rr.revoked === 200, `★ Возврат покупки: начисленные 200 ₸ отозваны — иначе возврат становится способом печатать бонусы`);
  ok(near((await svc.balance(accountId, azamat.id)).balance, before - 200), 'Баланс уменьшился ровно на отозванное');

  // ============ ★ ДЕНЬ РОЖДЕНИЯ ============
  // Азамат при регистрации получил день рождения 17 июля — если сегодня это
  // тот же день, он тоже именинник. Считаем ожидание от факта, а не от догадки.
  await tx(async (c) => c.query(`UPDATE counterparty SET birthday = make_date(1990, extract(month from current_date)::int, extract(day from current_date)::int) WHERE id=$1`, [marat.id]));
  const expectBd = await tx(async (c) => Number((await c.query(
    `SELECT count(*) n FROM counterparty WHERE account_id=$1 AND birthday IS NOT NULL
       AND extract(month FROM birthday)=extract(month FROM current_date)
       AND extract(day FROM birthday)=extract(day FROM current_date)`, [accountId])).rows[0].n));
  const bd = await svc.grantBirthdayBonuses(accountId);
  ok(bd.granted === expectBd && bd.clients[0].amount === 1000,
     `★ Именинникам начислено автоматически: ${bd.granted} клиенту(ам) по ${bd.clients[0].amount} ₸ (Wipon)`);
  const bd2 = await svc.grantBirthdayBonuses(accountId);
  ok(bd2.granted === 0, 'Второй раз в тот же день не начисляем');

  // ============ 10.2 ★ АКЦИИ — нет ни у кого из троих ============
  await svc.createPromo(accountId, { kind: 'n_plus_one', name: 'Третий кофе бесплатно', categoryId: ctx.coffee, buyQty: 2, freeQty: 1 });
  const s5 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  await pos.addToCart(accountId, s5.id, { productId: ctx.latte, qty: 2 });      // 1400
  await pos.addToCart(accountId, s5.id, { productId: ctx.espresso, qty: 1 });   // 500
  const promo1 = await svc.applyPromos(accountId, s5.id);
  ok(promo1.applied.length === 1 && promo1.applied[0].freeQty === 1 && promo1.applied[0].product === 'Эспрессо',
     `★ N+1: купил 3 кофе — дешёвый эспрессо в подарок (${promo1.totalDiscount} ₸). Магазин не должен дарить латте вместо эспрессо`);
  const s5total = await tx(async (c) => (await c.query(`SELECT total FROM sale WHERE id=$1`, [s5.id])).rows[0].total);
  ok(near(s5total, 1400), `Чек пересчитан: ${s5total} ₸ вместо 1900`);

  const s6 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  await pos.addToCart(accountId, s6.id, { productId: ctx.latte, qty: 2 });
  const promo0 = await svc.applyPromos(accountId, s6.id);
  ok(promo0.applied.length === 0, 'Два кофе — подарка нет: до тройки не хватает');

  // счастливые часы
  await svc.createPromo(accountId, {
    kind: 'happy_hours', name: 'Выпечка после обеда', categoryId: ctx.bakery,
    percent: 30, hourFrom: 14, hourTo: 16, weekdays: [1, 2, 3, 4, 5],
  });
  const s7 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  await pos.addToCart(accountId, s7.id, { productId: ctx.bun, qty: 4 });   // 1200
  const monday15 = new Date('2026-07-20T15:00:00');   // понедельник, 15:00
  const hh = await svc.applyPromos(accountId, s7.id, monday15);
  ok(hh.applied.length === 1 && near(hh.applied[0].discount, 360),
     `★ Счастливые часы: понедельник 15:00 → скидка 30% = ${hh.applied[0].discount} ₸`);

  const s8 = await pos.newSale(accountId, { shiftId: sh.id, employeeId: ownerId });
  await pos.addToCart(accountId, s8.id, { productId: ctx.bun, qty: 4 });
  const morning = await svc.applyPromos(accountId, s8.id, new Date('2026-07-20T10:00:00'));
  ok(morning.applied.length === 0, 'В 10 утра акции нет — не те часы');
  const sunday = await svc.applyPromos(accountId, s8.id, new Date('2026-07-19T15:00:00'));
  ok(sunday.applied.length === 0, 'В воскресенье акции нет — не тот день недели');

  // ============ 10.3 СЕГМЕНТЫ ============
  const seg = await svc.createSegment(accountId, { name: 'ВИП', color: '#FF0000' });
  await svc.addToSegment(accountId, seg.id, [azamat.id, marat.id]);
  const segs = await svc.segments(accountId);
  ok(segs[0].members === 2 && segs[0].color === '#FF0000', 'Ручной сегмент: название, цвет, счётчик клиентов (модель Wipon)');

  await svc.createSegment(accountId, { name: 'Давно не заходили', autoRule: 'lapsed' });
  await svc.createSegment(accountId, { name: 'Новички', autoRule: 'new' });
  const auto = await svc.refreshAutoSegments(accountId);
  ok(auto.find((a) => a.rule === 'new').members === 2,
     '★ Автоматические сегменты: система сама нашла новичков. У Wipon клиентов в сегмент добавляют руками — это работает, пока их сорок');

  // ============ 10.4 ★ РАССЫЛКИ: цена ДО отправки ============
  const lat = smsCost('Sale today! Discount 30%');
  const cyr = smsCost('Акция сегодня! Скидка 30%');
  ok(lat.segments === 1 && cyr.segments === 1, 'Короткий текст — одна SMS на любом языке');
  const longRu = smsCost('Уважаемый клиент! Приглашаем вас на большую распродажу в эту субботу. Скидки до 50% на весь ассортимент магазина. Ждём вас с 9 до 21 часа!');
  ok(longRu.encoding === 'кириллица' && longRu.segments === 3,
     `★ Кириллица: ${longRu.length} символов → ${longRu.segments} SMS. Латиницей влезло бы в 1 — вот почему Wipon считает «по длине и языку»`);
  ok(/латиницей влез бы/i.test(longRu.hint), `Подсказка владельцу: «${longRu.hint}»`);

  const est = await svc.estimateCampaign(accountId, { text: 'Акция! Скидка 30%', segmentId: seg.id });
  ok(est.recipients === 2 && est.totalCost === 12, `★ Прогноз ДО отправки: ${est.recipients} клиента, ${est.totalCost} ₸ (деталь Wipon)`);

  const camp = await svc.createCampaign(accountId, { name: 'Июльская акция', text: 'Акция! Скидка 30%', segmentId: seg.id, employeeId: ownerId });
  ok(Number(camp.cost_estimate) === 12 && camp.recipients === 2, 'Рассылка создана с прогнозом затрат');
  const sent = await svc.sendCampaign(accountId, camp.id);
  ok(sent.sent === 2 && sent.failed === 0 && sms.sent.length === 2, `Отправлено ${sent.sent} SMS`);
  ok(sms.sent[0].text === 'Акция! Скидка 30%', 'Текст дошёл до шлюза');
  const resend = await svc.sendCampaign(accountId, camp.id);
  ok(!resend.sent && /уже отправлена/.test(resend.reason), 'Повторная отправка рассылки не задваивает SMS');

  // повод для рассылки: у кого сгорают бонусы
  const soon = await svc.expiringSoon(accountId, 30);
  ok(soon.length >= 1 && soon[0].amount > 0, `Кому скоро сгорят бонусы: ${soon.length} клиент — готовый повод для рассылки`);

  // ============ 10.5 WALLET ============
  const card = await svc.walletCard(accountId, azamat.id);
  ok(card.cardNumber === join.card && card.holder === 'Азамат', 'Wallet-карта: номер и владелец');
  ok(card.applePass.storeCard.primaryFields[0].value.includes('₸') && card.googlePass.loyaltyPoints,
     'Структуры пасса для Apple Wallet и Google Wallet (обе платформы, как у Wipon)');
  ok(card.qrData === `LOYALTY:${join.card}` && card.applePass.barcode.format === 'PKBarcodeFormatQR',
     'QR-код для сканирования на кассе (сценарий Wipon: регистрация и списание по QR)');
  ok(!card.ready && /сертификат Apple Pass Type ID/.test(card.note),
     `★ Честно: «${card.note}» — это не код, это учётные записи и деньги. Wipon держит Wallet в тарифе PRO ровно поэтому`);

  const found = await svc.findByCard(accountId, `LOYALTY:${join.card}`);
  ok(found?.id === azamat.id && found.bonuses > 0, `Касса сканирует QR → нашла Азамата с ${found.bonuses} ₸ бонусов`);
  ok((await svc.findByCard(accountId, 'НЕТ-ТАКОЙ')) === null, 'Неизвестная карта — не находится');

  // ============ АНАЛИТИКА (показатели Wipon) ============
  const an = await svc.analytics(accountId, new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000).toISOString());
  ok(an.bonuses.earned > 0 && an.bonuses.spent > 0 && an.bonuses.expired === 700,
     `Аналитика: начислено ${an.bonuses.earned} ₸, потрачено ${an.bonuses.spent} ₸, сгорело ${an.bonuses.expired} ₸`);
  ok(an.clients.total === 2 && an.clients.withBonuses >= 1, 'Клиенты: всего и с бонусами (показатели Wipon)');
  ok(an.sales.withCard > 0 && an.sales.cardShare > 0, `Доля чеков с картой: ${an.sales.cardShare}%`);
  ok(typeof an.effect === 'string' && an.effect.length > 10,
     `★ Главный вопрос владельца — окупается ли программа: «${an.effect}»`);

  // ============ ИЗОЛЯЦИЯ ============
  const ph2 = '+7702' + Math.floor(1000000 + Math.random() * 8999999);
  const acc2 = (await db.raw(`SELECT * FROM register_account($1,'Чужой','Ержан','ru')`, [ph2])).rows[0];
  ok((await svc.programs(acc2.account_id)).length === 0, 'Чужой аккаунт не видит наши программы');
  ok((await svc.findByCard(acc2.account_id, join.card)) === null, 'И не найдёт нашего клиента по карте');

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); });
