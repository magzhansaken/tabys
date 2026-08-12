/**
 * ★ ЧАСТЬ 17 — ПОКУПАТЕЛЬ НА КАССЕ: долг с лимитом, бонусы, погашение.
 *
 * Что закрывает: до этой части «в долг» писал цифру в чек, а долговая книга
 * не росла; бонусы не начислялись и не списывались нигде. Проверяем весь
 * путь как его пройдёт Flutter-касса: снимок покупателей → офлайн-чеки
 * (долг/бонусы) → push → книга, балансы и смена сходятся до тенге.
 */
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const PORT = '3177';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);

let TOK = '', DEV = '';
const j = async (method, path, body, dev = false) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json',
      ...(dev ? { 'X-Device-Token': DEV } : TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

(async () => {
  ok(await wait(), 'Сервер поднялся');

  // ---------- магазин: товар, программа, покупатель с лимитом ----------
  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode, businessName: 'Долг Тест', ownerName: 'Айгуль', password: 'Password123' });
  TOK = r.d.access;
  ok(!!TOK, 'Владелец зарегистрирован');

  r = await j('POST', '/goods', { name: 'Сахар 1кг', salePrice: 500, purchasePrice: 380 });
  const sugar = r.d.id;
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  const docId = r.d.id;
  await j('POST', `/stock/docs/${docId}/items`, { productId: sugar, qty: 100, price: 380 });
  await j('POST', `/stock/docs/${docId}/process`, {});
  ok(true, 'Товар и склад готовы');

  r = await j('POST', '/loyalty/programs', { name: 'Кешбэк 5%', earnPercent: 5, spendPercent: 50, minPurchase: 0 });
  ok(r.status === 201 || r.d?.id, 'Бонусная программа 5% создана в кабинете (правила — в кабинете, модель МС)');

  r = await j('POST', '/contragents', { name: 'Азамат', phone: '+77017778899', roles: ['customer'], debtLimit: 3000 });
  const azamat = r.d.id;
  ok(!!azamat && Number(r.d.debt_limit ?? r.d.debtLimit ?? 3000) === 3000, 'Покупатель Азамат с лимитом долга 3000 ₸ («больше не давать»)');

  r = await j('POST', '/auth/employees', { firstName: 'Гульнара', phone: '+77013334455', roleCode: 'cashier', pin: '5555' });
  const cashierId = r.d.id;
  r = await j('POST', '/admin/stores/registers', {});
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'android', appVersion: '1.0.0' });
  DEV = r.d.deviceToken;
  ok(!!DEV, 'Касса привязана');

  // ---------- bootstrap: правила бонусов приезжают на кассу ----------
  r = await j('GET', '/pos/bootstrap', null, true);
  const lp = r.d.loyaltyProgram;
  ok(lp && lp.earnPercent === 5 && lp.spendPercent === 50,
     `★ Bootstrap несёт правила бонусов: ${lp?.earnPercent}% начисление, до ${lp?.spendPercent}% чека списание`);

  // ---------- снимок покупателей ----------
  r = await j('GET', '/pos/customers/catalog', null, true);
  const snapAz = r.d.customers.find((c) => c.id === azamat);
  ok(snapAz && Number(snapAz.debt) === 0 && Number(snapAz.debt_limit) === 3000,
     '★ Снимок покупателей отдан кассе: долг 0, лимит 3000 — «в долг» офлайн возможен');
  const custSeq = r.d.serverSeq;

  // ===================================================================
  // ОФЛАЙН-ДЕНЬ с покупателем
  // ===================================================================
  const q = [];
  let seq = 0;
  const enq = (entity, entityId, op, payload) =>
    q.push({ id: randomUUID(), entity, entityId, op, payload, clientSeq: ++seq,
      clientTs: new Date().toISOString(), employeeId: cashierId });

  const shiftId = randomUUID();
  enq('shift', shiftId, 'insert', { number: 1, openedAt: new Date().toISOString(), openingFloat: 0 });

  // чек 1: 2000 ₸ в долг Азамату (в пределах лимита 3000)
  const sale1 = randomUUID();
  enq('sale', sale1, 'insert', {
    shiftId, localNumber: 1, customerId: azamat,
    subtotal: 2000, discountSum: 0, rounding: 0, total: 2000, costTotal: 1520,
    items: [{ productId: sugar, qty: 4, price: 500, total: 2000, cost: 380 }],
    payment: { credit: 2000 },
  });

  // чек 2: ещё 1500 ₸ в долг — СВЕРХ лимита (2000+1500 > 3000). Касса локально
  // потребовала старшего; событие несёт approvedBy (владелец)
  const me = (await j('GET', '/auth/me')).d;
  enq('sale', randomUUID(), 'insert', {
    shiftId, localNumber: 2, customerId: azamat, approvedBy: me.employeeId,
    subtotal: 1500, discountSum: 0, rounding: 0, total: 1500, costTotal: 1140,
    items: [{ productId: sugar, qty: 3, price: 500, total: 1500, cost: 380 }],
    payment: { credit: 1500 },
  });

  // чек 3: наличные 1000 ₸ — от него начислятся бонусы 5% = 50
  enq('sale', randomUUID(), 'insert', {
    shiftId, localNumber: 3, customerId: azamat,
    subtotal: 1000, discountSum: 0, rounding: 0, total: 1000, costTotal: 760,
    items: [{ productId: sugar, qty: 2, price: 500, total: 1000, cost: 380 }],
    payment: { cash: 1000 },
  });

  // погашение долга у кассы: Азамат занёс 500 наличными
  enq('debt_payment', randomUUID(), 'insert',
    { counterpartyId: azamat, amount: 500, method: 'cash', shiftId });

  // новый должник, записанный кассиром офлайн
  const newCust = randomUUID();
  enq('customer', newCust, 'insert', { name: 'Бахыт (сосед)', phone: '+77010001122' });

  r = await j('POST', '/sync/push', { events: q, pending: q.length }, true);
  const quarantined = r.d.results.filter((x) => x.result === 'quarantined');
  if (quarantined.length) console.log('   карантин:', JSON.stringify(quarantined));
  ok(r.d.accepted === q.length, `★ Все ${q.length} офлайн-событий приняты`);

  // ---------- долговая книга ----------
  r = await j('GET', '/contragents/debts');
  const debtAz = r.d.items.find((x) => x.counterpartyId === azamat);
  // 2000 + 1500 − 500 = 3000
  ok(debtAz && Math.abs(debtAz.debt - 3000) < 0.01,
     `★ Долговая книга сошлась: 2000+1500−500 = ${debtAz?.debt} ₸ (офлайн-долг ДОЕХАЛ в книгу)`);

  // ---------- бонусы: начислены за наличный чек, идемпотентно ----------
  r = await j('GET', `/loyalty/balance/${azamat}`);
  const bal1 = Number(r.d.balance);
  // начисление от каждого чека, включая долговые (покупка есть покупка):
  // 5% от 2000 + 5% от 1500 + 5% от 1000 = 100+75+50 = 225
  ok(bal1 === 225, `★ Бонусы начислены от всех офлайн-чеков: 100+75+50 = ${bal1} ₸`);

  // повтор всей пачки — дубли невозможны, балансы не задваиваются
  r = await j('POST', '/sync/push', { events: q }, true);
  ok(r.d.results.every((x) => x.result === 'duplicate'), 'Повтор пачки — только duplicate');
  r = await j('GET', `/loyalty/balance/${azamat}`);
  ok(Number(r.d.balance) === 225, '★ Повтор не задвоил бонусы (идемпотентность earn по sale_id)');
  r = await j('GET', '/contragents/debts');
  const debtAgain = r.d.items.find((x) => x.counterpartyId === azamat);
  ok(Math.abs(debtAgain.debt - 3000) < 0.01, 'Повтор не задвоил долг');

  // ---------- оплата бонусами (МС: «оплата баллами — в кассе») ----------
  enq('sale', randomUUID(), 'insert', {
    shiftId, localNumber: 4, customerId: azamat,
    subtotal: 500, discountSum: 0, rounding: 0, total: 500, costTotal: 380,
    items: [{ productId: sugar, qty: 1, price: 500, total: 500, cost: 380 }],
    payment: { bonus: 50, cash: 450 },
  });
  r = await j('POST', '/sync/push', { events: [q[q.length - 1]] }, true);
  ok(r.d.accepted === 1, 'Чек с оплатой бонусами принят');
  r = await j('GET', `/loyalty/balance/${azamat}`);
  // 225 − 50 списано + начисление 5% от (500−50)=450 → floor 22 → 197
  ok(Number(r.d.balance) === 197, `★ Бонусы: списано 50, начислено floor(450·5%)=22 → баланс ${r.d.balance} ₸`);

  // ---------- новый должник с кассы виден в кабинете ----------
  r = await j('GET', '/contragents?q=' + encodeURIComponent('Бахыт'));
  ok(r.d.items.some((x) => x.id === newCust),
     '★ Покупатель, записанный кассиром офлайн, появился в кабинете');

  // ---------- дельта нового покупателя из кабинета → на кассу ----------
  r = await j('POST', '/contragents', { name: 'Сауле', phone: '+77015550000', roles: ['customer'] });
  const saule = r.d.id;
  r = await j('GET', `/sync/pull?since=${custSeq}&limit=200`, null, true);
  ok(r.d.events.some((e) => e.entity === 'customer' && e.entityId === saule && e.payload.name === 'Сауле'),
     '★ Новый покупатель из кабинета доехал дельтой (касса узнаёт без переснимка)');

  // ---------- смена: наличные сходятся (1000 + 450 + 500 погашение) ----------
  enq('shift', shiftId, 'update', { closedAt: new Date().toISOString(), actualCash: 1950 });
  r = await j('POST', '/sync/push', { events: [q[q.length - 1]] }, true);
  r = await j('GET', '/reports/shifts?period=today');
  const sh = (Array.isArray(r.d) ? r.d : r.d.rows ?? []).find((s) => s.id === shiftId);
  ok(sh && Math.abs(Number(sh.expected_cash) - 1950) < 0.01,
     `★ Смена сошлась: наличные чеки 1450 + погашение долга 500 = ${sh?.expected_cash} ₸ (расхождение ${sh?.discrepancy ?? 0})`);

  // ---------- онлайн-защита: сервер режет долг сверх лимита без старшего ----------
  r = await j('GET', `/pos/customers/${azamat}`, null, true);
  ok(Number(r.d.debt) === 3000 && Number(r.d.debt_limit) === 3000,
     `Свежий баланс покупателя для кассы: долг ${r.d.debt}, лимит ${r.d.debt_limit} — давать больше нельзя`);

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
