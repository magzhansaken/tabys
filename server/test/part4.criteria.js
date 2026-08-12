/**
 * ★ КРИТЕРИЙ ЧАСТИ 4: «касса торгует сутки без интернета, потом всё честно доезжает».
 * Сервер ГАСИТСЯ по-настоящему. Касса работает на локальной SQLite (схема drift
 * из pos/lib/data/local_schema.dart). Потом сеть возвращается — сверяем всё до тенге.
 */
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');

const PORT = process.env.CRIT4_PORT || '3171';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const call = async (p, o = {}) => {
  const r = await fetch(API + p, { method: o.method ?? 'POST', headers: { 'Content-Type': 'application/json', ...(o.headers ?? {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const phone = () => '+7701' + Math.floor(1000000 + Math.random() * 8999999);

// ============ ЛОКАЛЬНАЯ БАЗА КАССЫ (схема из pos/lib/data/local_schema.dart) ============
function localDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE staff (id TEXT PRIMARY KEY, first_name TEXT, pin_hash TEXT, permissions TEXT);
    CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT, price REAL, cost REAL, barcode TEXT, track_stock INTEGER DEFAULT 1);
    CREATE TABLE local_shift (id TEXT PRIMARY KEY, number INTEGER, opened_at TEXT, opening_float REAL, closed_at TEXT);
    CREATE TABLE local_sale (id TEXT PRIMARY KEY, shift_id TEXT, local_number TEXT, total REAL, cost_total REAL,
      paid_cash REAL DEFAULT 0, paid_card REAL DEFAULT 0, paid_qr REAL DEFAULT 0, created_at TEXT);
    CREATE TABLE local_sale_item (id TEXT PRIMARY KEY, sale_id TEXT, product_id TEXT, qty REAL, price REAL, cost REAL, total REAL);
    CREATE TABLE outbox (id TEXT PRIMARY KEY, client_seq INTEGER, entity TEXT, entity_id TEXT, op TEXT,
      payload TEXT, client_ts TEXT, sent_at TEXT);
    CREATE TABLE sync_state (id INTEGER PRIMARY KEY, next_client_seq INTEGER DEFAULT 1);
    INSERT INTO sync_state (id) VALUES (1);
  `);
  return db;
}

/** Клиентское ядро кассы: продажа считается локально и целиком. */
class LocalPos {
  constructor(db) { this.db = db; }
  enqueue(entity, entityId, op, payload) {
    const seq = this.db.prepare('SELECT next_client_seq n FROM sync_state WHERE id=1').get().n;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO outbox (id, client_seq, entity, entity_id, op, payload, client_ts) VALUES (?,?,?,?,?,?,?)`)
      .run(id, seq, entity, entityId, op, JSON.stringify(payload), new Date().toISOString());
    this.db.prepare('UPDATE sync_state SET next_client_seq=? WHERE id=1').run(seq + 1);
    return id;
  }
  openShift(number, float) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO local_shift (id, number, opened_at, opening_float) VALUES (?,?,?,?)')
      .run(id, number, new Date().toISOString(), float);
    this.enqueue('shift', id, 'insert', { number, openingFloat: float, openedAt: new Date().toISOString() });
    return id;
  }
  /** Чек считается на кассе целиком, включая себестоимость. */
  sell(shiftId, lines, payment) {
    const id = randomUUID();
    let total = 0, cost = 0;
    const items = [];
    for (const l of lines) {
      const p = this.db.prepare('SELECT * FROM products WHERE id=?').get(l.productId);
      const lineTotal = Math.round(p.price * l.qty * 100) / 100;
      total += lineTotal; cost += p.cost * l.qty;
      const iid = randomUUID();
      this.db.prepare('INSERT INTO local_sale_item (id, sale_id, product_id, qty, price, cost, total) VALUES (?,?,?,?,?,?,?)')
        .run(iid, id, p.id, l.qty, p.price, p.cost, lineTotal);
      items.push({ productId: p.id, qty: l.qty, price: p.price, cost: p.cost, total: lineTotal });
    }
    total = Math.round(total * 100) / 100; cost = Math.round(cost * 100) / 100;
    const local = `${shiftId.slice(0, 4)}-${this.db.prepare('SELECT count(*) n FROM local_sale').get().n + 1}`;
    this.db.prepare(`INSERT INTO local_sale (id, shift_id, local_number, total, cost_total, paid_cash, paid_card, paid_qr, created_at)
                     VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, shiftId, local, total, cost, payment.cash ?? 0, payment.card ?? 0, payment.qr ?? 0, new Date().toISOString());
    this.enqueue('sale', id, 'insert', { shiftId, localNumber: local, total, costTotal: cost, items, payment });
    return { id, total, cost, localNumber: local };
  }
  pending() { return this.db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY client_seq').all(); }
  totals() {
    const r = this.db.prepare(`SELECT count(*) n, coalesce(sum(total),0) revenue, coalesce(sum(cost_total),0) cost,
                                      coalesce(sum(paid_cash),0) cash, coalesce(sum(paid_card),0) card, coalesce(sum(paid_qr),0) qr
                               FROM local_sale`).get();
    return r;
  }
}

let srv = null;
const start = async () => {
  srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
    env: { ...process.env, PORT, NODE_ENV: 'test', PGUSER: process.env.PGUSER || 'shop_app', PGPASSWORD: process.env.PGPASSWORD || 'change_me_in_prod', PGDATABASE: process.env.PGDATABASE || 'shop_dev' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 40; i++) { try { await fetch(API + '/health'); return; } catch { await new Promise((r) => setTimeout(r, 300)); } }
  throw new Error('сервер не поднялся');
};
const stop = async () => {
  if (srv) { srv.kill('SIGKILL'); srv = null; }
  for (let i = 0; i < 15; i++) { try { await fetch(API + '/health'); await new Promise((r) => setTimeout(r, 200)); } catch { return true; } }
  return false;
};

(async () => {
  const { DbService } = require('../dist/db/db.service');
  const db = new DbService();
  await start();

  // ---------- подготовка: магазин, товары, касса ----------
  const ph = phone();
  let r = await call('/auth/otp', { body: { phone: ph } });
  r = await call('/auth/register', { body: { phone: ph, code: r.data.devCode, businessName: 'Магазин 24 часа', ownerName: 'Айгуль', password: 'Password123' } });
  const auth = { Authorization: `Bearer ${r.data.access}` };
  const accountId = r.data.employee.accountId;
  const tx = (fn) => db.withTenant(accountId, fn);

  const ctx = await tx(async (c) => {
    const store = (await c.query(`SELECT id FROM store LIMIT 1`)).rows[0].id;
    const wh = (await c.query(`SELECT id FROM warehouse WHERE is_primary LIMIT 1`)).rows[0].id;
    const reg = (await c.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, store, wh])).rows[0].id;
    const sht = (await c.query(`SELECT id FROM unit WHERE short_name='шт' LIMIT 1`)).rows[0].id;
    const rt = (await c.query(`SELECT id FROM price_type WHERE code='retail' LIMIT 1`)).rows[0].id;
    const cashier = (await c.query(`INSERT INTO employee (account_id, role_id, first_name, phone, can_login_pos, pos_pin_hash) VALUES ($1,(SELECT id FROM role WHERE code='cashier'),'Марат',$2,true,$3) RETURNING id`,
      [accountId, phone(), bcrypt.hashSync('1234', 4)])).rows[0].id;
    const goods = [];
    for (const [name, price, cost] of [['Молоко', 450, 380], ['Хлеб', 150, 100], ['Сигареты', 750, 600], ['Вода', 120, 80]]) {
      const id = (await c.query(`INSERT INTO product (account_id, name, kind, unit_id, purchase_price) VALUES ($1,$2,'simple',$3,$4) RETURNING id`, [accountId, name, sht, cost])).rows[0].id;
      await c.query(`INSERT INTO product_price (account_id, product_id, price_type_id, value) VALUES ($1,$2,$3,$4)`, [accountId, id, rt, price]);
      goods.push({ id, name, price, cost });
    }
    return { store, wh, reg, cashier, goods };
  });

  // товар на складе: по 500 каждого
  const { StockService } = require('../dist/stock/stock.service');
  const { SyncService } = require('../dist/sync/sync.service');
  const { GoodsService } = require('../dist/goods/goods.service');
  const stock = new StockService(db, new SyncService(db, { notifyAccount: () => 0, connectionsOf: () => 0 }), new GoodsService(db));
  const sup = await stock.createDoc(accountId, { kind: 'supply', warehouseId: ctx.wh });
  for (const g of ctx.goods) await stock.addItem(accountId, sup.id, { productId: g.id, qty: 500, price: g.cost });
  await stock.process(accountId, sup.id);
  ok(true, 'Магазин готов: 4 товара по 500 шт на складе');

  // ---------- касса привязалась и скачала данные ----------
  const pc = await call('/auth/devices/pairing-code', { headers: auth, body: { cashRegisterId: ctx.reg } });
  const pr = await call('/pos/pair', { body: { code: pc.data.code, platform: 'windows', appVersion: '1.0.0' } });
  const devToken = pr.data.deviceToken;
  const local = localDb();
  const pos = new LocalPos(local);
  for (const g of ctx.goods) local.prepare('INSERT INTO products (id, name, price, cost) VALUES (?,?,?,?)').run(g.id, g.name, g.price, g.cost);
  ok(local.prepare('SELECT count(*) n FROM products').get().n === 4, 'Касса привязана, каталог лежит в локальной базе');

  // ---------- ★ ГАСИМ СЕТЬ НА СУТКИ ----------
  ok(await stop(), '★ ИНТЕРНЕТ ПРОПАЛ (провайдер лёг на сутки — обычное дело в магазине у дома)');
  let dead = false;
  try { await fetch(API + '/health'); } catch { dead = true; }
  ok(dead, 'Сервер действительно недоступен');

  // ---------- СУТКИ ТОРГОВЛИ БЕЗ ИНТЕРНЕТА ----------
  const t0 = Date.now();
  const shiftId = pos.openShift(1, 5000);
  ok(!!shiftId, 'Смена открыта офлайн — касса не спрашивает сервер');

  let expectedRevenue = 0, expectedCost = 0, expectedCash = 0, expectedCard = 0, expectedQr = 0;
  const soldQty = {};
  for (const g of ctx.goods) soldQty[g.id] = 0;

  // 240 чеков — сутки работы магазина у дома
  for (let i = 0; i < 240; i++) {
    const lines = [];
    const n = 1 + (i % 3);
    for (let k = 0; k < n; k++) {
      const g = ctx.goods[(i + k) % 4];
      const qty = 1 + ((i + k) % 2);
      lines.push({ productId: g.id, qty });
      soldQty[g.id] += qty;
    }
    const sum = lines.reduce((s, l) => s + ctx.goods.find((g) => g.id === l.productId).price * l.qty, 0);
    const method = i % 3 === 0 ? { cash: sum } : i % 3 === 1 ? { card: sum } : { qr: sum };
    const sale = pos.sell(shiftId, lines, method);
    expectedRevenue += sale.total; expectedCost += sale.cost;
    expectedCash += method.cash ?? 0; expectedCard += method.card ?? 0; expectedQr += method.qr ?? 0;
  }
  const elapsed = Date.now() - t0;
  const t = pos.totals();
  ok(t.n === 240, `За сутки офлайн пробито ${t.n} чеков (${elapsed} мс) — покупатели ничего не заметили`);
  ok(Math.abs(t.revenue - expectedRevenue) < 0.01, `Выручка посчитана на кассе: ${t.revenue} ₸`);
  ok(Math.abs(t.cost - expectedCost) < 0.01, `Себестоимость посчитана на кассе: ${t.cost} ₸ — сервер её не пересчитывает`);
  ok(pos.pending().length === 241, `В очереди ${pos.pending().length} событий (смена + 240 чеков) — ничего не потеряно`);

  const seqs = pos.pending().map((e) => e.client_seq);
  ok(seqs[0] === 1 && seqs[seqs.length - 1] === 241 && new Set(seqs).size === 241,
     'Нумерация событий сплошная 1…241 — сервер увидит, если что-то не доехало');

  // ---------- ★ ИНТЕРНЕТ ВЕРНУЛСЯ ----------
  await start();
  ok(true, '★ ИНТЕРНЕТ ВЕРНУЛСЯ — очередь поехала');

  const H = { 'X-Device-Token': devToken };
  const all = pos.pending();
  let accepted = 0;
  const tSync = Date.now();
  for (let i = 0; i < all.length; i += 100) {          // батчами, как настоящий клиент
    const batch = all.slice(i, i + 100).map((e) => ({
      id: e.id, entity: e.entity, entityId: e.entity_id, op: e.op,
      payload: JSON.parse(e.payload), clientSeq: e.client_seq, clientTs: e.client_ts,
    }));
    const res = await call('/sync/push', { headers: H, body: { events: batch } });
    accepted += res.data.accepted ?? 0;
  }
  const syncMs = Date.now() - tSync;
  ok(accepted === 241, `Все 241 событие приняты сервером за ${syncMs} мс`);
  for (const e of all) local.prepare('UPDATE outbox SET sent_at=? WHERE id=?').run(new Date().toISOString(), e.id);
  ok(pos.pending().length === 0, 'Очередь пуста — но только после подтверждения сервера');

  // ---------- ЧЕСТНО ЛИ ДОЕХАЛО ----------
  const onServer = await tx(async (c) => (await c.query(
    `SELECT count(*)::int n FROM oplog WHERE entity='sale' AND applied_at IS NOT NULL`)).rows[0].n);
  ok(onServer === 240, `На сервере 240 чеков — ровно столько, сколько пробили офлайн`);

  const sums = await tx(async (c) => (await c.query(
    `SELECT count(*)::int n,
            sum((payload->>'total')::numeric) AS revenue,
            sum((payload->>'costTotal')::numeric) AS cost
       FROM oplog WHERE entity='sale'`)).rows[0]);
  ok(Math.abs(Number(sums.revenue) - expectedRevenue) < 0.01,
     `★ Выручка совпала до тенге: касса ${expectedRevenue} ₸ = сервер ${Number(sums.revenue)} ₸`);
  ok(Math.abs(Number(sums.cost) - expectedCost) < 0.01,
     `★ Себестоимость совпала до тенге: ${Number(sums.cost)} ₸`);

  // повторная отправка (сеть моргнула, клиент переслал)
  const again = await call('/sync/push', { headers: H, body: {
    events: all.slice(0, 50).map((e) => ({ id: e.id, entity: e.entity, entityId: e.entity_id, op: e.op,
      payload: JSON.parse(e.payload), clientSeq: e.client_seq, clientTs: e.client_ts })) } });
  ok(again.data.results.every((x) => x.result === 'duplicate'), '★ Повторная отправка не создала ни одного дубля продажи');
  const stillN = await tx(async (c) => (await c.query(`SELECT count(*)::int n FROM oplog WHERE entity='sale'`)).rows[0].n);
  ok(stillN === 240, 'Чеков на сервере по-прежнему 240');

  // ---------- ПРОПУСКОВ НЕТ ----------
  const gaps = await tx(async (c) => (await c.query(
    `SELECT * FROM sync_device_gaps($1, (SELECT id FROM device WHERE cash_register_id=$2 LIMIT 1))`,
    [accountId, ctx.reg])).rows);
  ok(gaps.length === 0, 'Дырок в нумерации нет — сервер подтверждает, что касса отдала всё');

  const ready = await call('/admin/sync/readiness', { method: 'GET', headers: auth });
  ok(ready.data.ready === true, '★ Сервер говорит: все данные получены, можно проводить инвентаризацию');

  // ---------- ОСТАТКИ СОШЛИСЬ ----------
  // (движения по складу применяет обработчик продаж — Часть 4.7; здесь проверяем факт доставки)
  const cashCheck = await tx(async (c) => (await c.query(
    `SELECT sum((payload->'payment'->>'cash')::numeric) AS cash,
            sum((payload->'payment'->>'card')::numeric) AS card,
            sum((payload->'payment'->>'qr')::numeric) AS qr
       FROM oplog WHERE entity='sale'`)).rows[0]);
  ok(Math.abs(Number(cashCheck.cash ?? 0) - expectedCash) < 0.01, `Наличные сошлись: ${Number(cashCheck.cash)} ₸`);
  ok(Math.abs(Number(cashCheck.card ?? 0) - expectedCard) < 0.01, `Карта сошлась: ${Number(cashCheck.card)} ₸`);
  ok(Math.abs(Number(cashCheck.qr ?? 0) - expectedQr) < 0.01, `QR сошёлся: ${Number(cashCheck.qr)} ₸`);

  await db.onModuleDestroy();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv?.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e); srv?.kill(); process.exit(1); });
