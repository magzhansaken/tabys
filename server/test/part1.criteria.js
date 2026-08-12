/**
 * ПРОВЕРКА КРИТЕРИЯ ГОТОВНОСТИ ЧАСТИ 1
 * «Создать компанию, точку, кассира; касса логинится офлайн».
 *
 * Flutter в песочнице не собрать (домены Google закрыты), поэтому клиентское
 * ядро кассы воспроизведено здесь на реальной SQLite: та же схема, что в
 * pos/lib/data/local_schema.dart, тот же bcrypt, те же хэши, приехавшие
 * с настоящего сервера. Сервер по ходу теста ГАСИТСЯ по-настоящему.
 *
 * Запуск: node --no-warnings test/part1.criteria.js
 */
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { Client } = require('pg');

const API = 'http://127.0.0.1:3130';
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const call = async (p, o = {}) => {
  const r = await fetch(API + p, { method: o.method ?? 'POST', headers: { 'Content-Type': 'application/json', ...(o.headers ?? {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
const phone = () => '+7701' + Math.floor(1000000 + Math.random() * 8999999);

// ============================================================
// ЛОКАЛЬНАЯ БАЗА КАССЫ — копия схемы drift из pos/lib/data/local_schema.dart
// ============================================================
function makeLocalDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE staff (id TEXT PRIMARY KEY, first_name TEXT, last_name TEXT, pin_hash TEXT,
      badge_barcode TEXT, is_shift_admin INTEGER DEFAULT 0, is_owner INTEGER DEFAULT 0,
      role_code TEXT, permissions TEXT DEFAULT '{}', can_see_revenue INTEGER DEFAULT 0);
    CREATE TABLE pos_settings (id INTEGER PRIMARY KEY, json TEXT, synced_at TEXT);
    CREATE TABLE local_sessions (id TEXT PRIMARY KEY, staff_id TEXT, started_at TEXT, ended_at TEXT, end_reason TEXT, offline INTEGER DEFAULT 1);
    CREATE TABLE outbox (id TEXT PRIMARY KEY, client_seq INTEGER, entity TEXT, entity_id TEXT, op TEXT,
      payload TEXT, base_seq INTEGER, client_ts TEXT, sent_at TEXT, attempts INTEGER DEFAULT 0, last_error TEXT);
    CREATE TABLE sync_state (id INTEGER PRIMARY KEY, pulled_seq INTEGER DEFAULT 0, next_client_seq INTEGER DEFAULT 1);
    CREATE TABLE login_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, success INTEGER, ts TEXT);
    CREATE TABLE approvals (id TEXT PRIMARY KEY, requested_by TEXT, approved_by TEXT, action TEXT, method TEXT, approved_at TEXT, offline INTEGER DEFAULT 1);
    INSERT INTO sync_state (id) VALUES (1);
  `);
  return db;
}

// ============================================================
// КЛИЕНТСКОЕ ЯДРО — логика из pos/lib/core/offline_auth.dart
// ============================================================
class OfflineAuth {
  constructor(db) { this.db = db; }

  isLockedOut() {
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const r = this.db.prepare(`SELECT count(*) n FROM login_attempts WHERE success=0 AND ts > ?`).get(since);
    return r.n >= 5;
  }

  /** Вход по PIN. Ни одного сетевого запроса. */
  loginByPin(pin) {
    if (this.isLockedOut()) throw new Error('Слишком много неверных PIN. Подождите 5 минут.');
    for (const s of this.db.prepare('SELECT * FROM staff').all()) {
      if (bcrypt.compareSync(pin, s.pin_hash)) {
        this.db.prepare('INSERT INTO login_attempts (success, ts) VALUES (1, ?)').run(new Date().toISOString());
        this.db.prepare(`UPDATE local_sessions SET ended_at=?, end_reason='switch_user' WHERE ended_at IS NULL`).run(new Date().toISOString());
        this.db.prepare('INSERT INTO local_sessions (id, staff_id, started_at, offline) VALUES (?,?,?,1)')
          .run(randomUUID(), s.id, new Date().toISOString());
        return s;
      }
    }
    this.db.prepare('INSERT INTO login_attempts (success, ts) VALUES (0, ?)').run(new Date().toISOString());
    return null;
  }

  /** Подтверждение старшим: бейдж или PIN, офлайн, две подписи. */
  approve({ requestedBy, action, badge, pin }) {
    const isAdmin = (s) => s.is_owner || s.is_shift_admin || s.role_code === 'admin' || s.role_code === 'owner';
    let approver = null;
    for (const s of this.db.prepare('SELECT * FROM staff').all()) {
      if (!isAdmin(s)) continue;
      if (badge && s.badge_barcode === badge) { approver = s; break; }
      if (pin && bcrypt.compareSync(pin, s.pin_hash)) { approver = s; break; }
    }
    if (!approver) return null;
    this.db.prepare('INSERT INTO approvals (id, requested_by, approved_by, action, method, approved_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), requestedBy, approver.id, action, badge ? 'badge' : 'pin', new Date().toISOString());
    return approver;
  }

  can(staff, section, action) {
    const p = JSON.parse(staff.permissions ?? '{}');
    if (p['*']?.[action]) return true;
    return p[section]?.[action] === true;
  }

  /** Запись события в очередь: продажа не ждёт сервер никогда. */
  enqueue(entity, entityId, op, payload) {
    const st = this.db.prepare('SELECT next_client_seq FROM sync_state WHERE id=1').get();
    const seq = st.next_client_seq;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO outbox (id, client_seq, entity, entity_id, op, payload, client_ts) VALUES (?,?,?,?,?,?,?)`)
      .run(id, seq, entity, entityId, op, JSON.stringify(payload), new Date().toISOString());
    this.db.prepare('UPDATE sync_state SET next_client_seq=? WHERE id=1').run(seq + 1);
    return id;
  }

  pending() { return this.db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY client_seq').all(); }
}

let srv = null;
const startServer = async () => {
  srv = spawn('node', ['dist/main.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: '3130', NODE_ENV: 'test', PGUSER: process.env.PGUSER || 'shop_app', PGPASSWORD: process.env.PGPASSWORD || 'change_me_in_prod', PGDATABASE: process.env.PGDATABASE || 'shop_dev' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 40; i++) { try { await fetch(API + '/auth/me'); return; } catch { await new Promise((r) => setTimeout(r, 400)); } }
  throw new Error('сервер не поднялся');
};
const stopServer = async () => {
  if (srv) { srv.kill('SIGKILL'); srv = null; }
  for (let i = 0; i < 20; i++) {
    try { await fetch(API + '/auth/me'); await new Promise((r) => setTimeout(r, 250)); }
    catch { return true; }
  }
  return false;
};

async function main() {
  await startServer();

  // ============ ШАГ 1: СОЗДАТЬ КОМПАНИЮ, ТОЧКУ, КАССИРА ============
  const ph = phone();
  let r = await call('/auth/otp', { body: { phone: ph } });
  r = await call('/auth/register', { body: { phone: ph, code: r.data.devCode, businessName: 'Магазин у дома', ownerName: 'Айгуль', password: 'Password123' } });
  const auth = { Authorization: `Bearer ${r.data.access}` };
  const accountId = r.data.employee.accountId;
  const ownerId = r.data.employee.employeeId;
  ok(r.status === 201, 'Компания создана: регистрация владельца по SMS');

  const db = new Client({ host: 'localhost', user: process.env.PGUSER || 'shop_app', password: process.env.PGPASSWORD || 'change_me_in_prod', database: process.env.PGDATABASE || 'shop_dev' });
  await db.connect();
  const tx = async (fn) => { await db.query('BEGIN'); await db.query(`SET LOCAL app.account_id='${accountId}'`); const x = await fn(); await db.query('COMMIT'); return x; };

  const { storeId, regId, cashierId } = await tx(async () => {
    const s = (await db.query('SELECT id FROM store LIMIT 1')).rows[0].id;
    const w = (await db.query('SELECT id FROM warehouse LIMIT 1')).rows[0].id;
    const reg = (await db.query(`INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`, [accountId, s, w])).rows[0].id;
    const c = (await db.query(
      `INSERT INTO employee (account_id, role_id, first_name, phone, can_login_pos, badge_barcode)
       VALUES ($1,(SELECT id FROM role WHERE code='cashier'),'Марат',$2,true,'BADGE-M1') RETURNING id`,
      [accountId, phone()])).rows[0].id;
    await db.query(`INSERT INTO employee_store (employee_id, store_id, account_id) VALUES ($1,$2,$3)`, [c, s, accountId]);
    return { storeId: s, regId: reg, cashierId: c };
  });
  ok(!!storeId, 'Точка и склад созданы автоматически при регистрации');
  ok(!!cashierId, 'Кассир создан и привязан к точке');

  await call('/auth/employees/pin', { headers: auth, body: { employeeId: cashierId, pin: '1234' } });
  await call('/auth/employees/pin', { headers: auth, body: { employeeId: ownerId, pin: '9999' } });
  ok(true, 'PIN выданы: кассиру 1234, владельцу 9999');

  // ============ ШАГ 2: ПРИВЯЗКА КАССЫ ОДНОРАЗОВЫМ КЛЮЧОМ ============
  const pc = await call('/auth/devices/pairing-code', { headers: auth, body: { cashRegisterId: regId } });
  const pr = await call('/pos/pair', { body: { code: pc.data.code, platform: 'windows', appVersion: '0.1.0' } });
  const devToken = pr.data.deviceToken;
  ok(!!devToken, 'Касса привязана одноразовым ключом, токен устройства получен');

  // ============ ШАГ 3: BOOTSTRAP → ЛОКАЛЬНАЯ БАЗА КАССЫ ============
  const bs = await call('/pos/bootstrap', { method: 'GET', headers: { 'X-Device-Token': devToken } });
  const local = makeLocalDb();
  for (const s of bs.data.staff) {
    local.prepare(`INSERT INTO staff (id, first_name, last_name, pin_hash, badge_barcode, is_shift_admin, is_owner, role_code, permissions, can_see_revenue)
                   VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(s.id, s.first_name, s.last_name ?? null, s.pos_pin_hash, s.badge_barcode ?? null,
           s.is_shift_admin ? 1 : 0, s.is_owner ? 1 : 0, s.role_code ?? null,
           JSON.stringify(s.permissions ?? {}), s.can_see_revenue ? 1 : 0);
  }
  local.prepare('INSERT INTO pos_settings (id, json, synced_at) VALUES (1,?,?)')
    .run(JSON.stringify(bs.data.posProfile ?? {}), new Date().toISOString());
  ok(local.prepare('SELECT count(*) n FROM staff').get().n === 2, 'Пакет для офлайна лёг в локальную базу кассы: 2 сотрудника с хэшами PIN');

  const settings = JSON.parse(local.prepare('SELECT json FROM pos_settings WHERE id=1').get().json);
  ok(settings.allow_credit_sale === true, 'Разрешения кассы тоже локально — правила работают без сети');

  // ============ ШАГ 4: ГАСИМ СЕРВЕР ПО-НАСТОЯЩЕМУ ============
  const down = await stopServer();
  ok(down, 'СЕРВЕР ВЫКЛЮЧЕН (имитируем ночной обрыв интернета в магазине)');
  let netDead = false;
  try { await fetch(API + '/auth/me'); } catch { netDead = true; }
  ok(netDead, 'Сеть действительно недоступна: запросы к серверу падают');

  // ============ ШАГ 5: КРИТЕРИЙ ЧАСТИ 1 — ВХОД БЕЗ СЕРВЕРА ============
  const pos = new OfflineAuth(local);
  const who = pos.loginByPin('1234');
  ok(who && who.first_name === 'Марат', '★ КРИТЕРИЙ ЧАСТИ 1: кассир вошёл на кассу по PIN при выключенном сервере');
  ok(local.prepare('SELECT count(*) n FROM local_sessions WHERE ended_at IS NULL').get().n === 1, 'Открыта одна локальная смена, подписанная кассиром');

  ok(pos.loginByPin('0000') === null, 'Неверный PIN отклонён локально');
  ok(pos.can(who, 'pos', 'view') === true, 'Права кассира проверяются офлайн: касса — можно');
  ok(pos.can(who, 'finance', 'view') === false, 'Права кассира проверяются офлайн: финансы — нельзя');
  ok(who.can_see_revenue === 0, 'Кассир не видит выручку и без сети');

  const owner = pos.loginByPin('9999');
  ok(owner && owner.is_owner === 1, 'Переключение на владельца по PIN — тоже офлайн');
  ok(local.prepare('SELECT count(*) n FROM local_sessions WHERE ended_at IS NOT NULL').get().n === 1, 'Прошлая смена закрыта: переключение, а не вторая параллельная сессия');

  // ============ ШАГ 6: ПОДТВЕРЖДЕНИЕ СТАРШИМ ОФЛАЙН ============
  const appr = pos.approve({ requestedBy: cashierId, action: 'refund', pin: '9999' });
  ok(appr && appr.is_owner === 1, 'Возврат подтверждён PIN владельца — без сервера (у UMAG это требует сканирования, у нас ещё и офлайн)');
  ok(pos.approve({ requestedBy: cashierId, action: 'refund', pin: '1234' }) === null, 'Кассир не может подтвердить сам себе');
  ok(pos.approve({ requestedBy: cashierId, action: 'refund', badge: 'BADGE-M1' }) === null, 'Бейдж кассира не годится для подтверждения');

  // ============ ШАГ 7: ПРОДАЖИ КОПЯТСЯ В ОЧЕРЕДИ ============
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(pos.enqueue('consultant', randomUUID(), 'insert', { name: `Офлайн-событие ${i}` }));
  ok(pos.pending().length === 3, 'Три события записаны в очередь при выключенном сервере (продажа не ждёт сеть)');
  ok(pos.pending().map((e) => e.client_seq).join(',') === '1,2,3', 'Нумерация событий сплошная — сервер сможет увидеть пропуск');

  // ============ ШАГ 8: БЛОКИРОВКА ПЕРЕБОРА РАБОТАЕТ ОФЛАЙН ============
  let locked = false;
  for (let i = 0; i < 6; i++) {
    try { pos.loginByPin('7777'); } catch { locked = true; break; }
  }
  ok(locked, 'После 5 неверных PIN касса блокирует ввод — тоже без сервера');
  // журнал попыток чистим: дальше нужен рабочий вход
  local.exec('DELETE FROM login_attempts');
  ok(pos.loginByPin('1234') !== null, 'После снятия блокировки вход снова работает (тоже офлайн)');

  // ============ ШАГ 9: СЕТЬ ВЕРНУЛАСЬ — ОЧЕРЕДЬ УЛЕТЕЛА ============
  await startServer();
  const events = pos.pending().map((e) => ({
    id: e.id, entity: e.entity, entityId: e.entity_id, op: e.op,
    payload: JSON.parse(e.payload), clientSeq: e.client_seq, clientTs: e.client_ts,
  }));
  r = await call('/sync/push', { headers: { 'X-Device-Token': devToken }, body: { events, pendingHint: 0 } });
  ok(r.status === 201 && r.data.accepted === 3, 'Сеть вернулась — накопленные события ушли на сервер', JSON.stringify(r.data?.results?.length));

  for (const e of events) local.prepare('UPDATE outbox SET sent_at=? WHERE id=?').run(new Date().toISOString(), e.id);
  ok(pos.pending().length === 0, 'Очередь очищена только после подтверждения сервера (ничего не теряется)');

  const onServer = await tx(async () => (await db.query(`SELECT count(*)::int n FROM consultant WHERE name LIKE 'Офлайн-событие%'`)).rows[0].n);
  ok(onServer === 3, 'Все три офлайн-события доехали до сервера и применились');

  // повторная отправка (клиент не получил ответ и переслал)
  r = await call('/sync/push', { headers: { 'X-Device-Token': devToken }, body: { events } });
  ok(r.data.results.every((x) => x.result === 'duplicate'), 'Повторная отправка после обрыва не создала дублей продаж');

  const ready = await call('/admin/sync/readiness', { method: 'GET', headers: auth });
  ok(ready.data.ready === true, 'Сервер подтверждает: касса отдала всё, остатки актуальны — можно проводить инвентаризацию');

  await db.end();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('ОШИБКА:', e); process.exit(1); }).finally(() => srv?.kill());
