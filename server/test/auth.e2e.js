/**
 * E2E-тест аутентификации (1.2). Поднимает реальный сервер, ходит по HTTP,
 * пишет в реальный PostgreSQL под ролью shop_app (с включённым RLS).
 * Запуск: node test/auth.e2e.js
 */
const { spawn } = require('child_process');
const { Client } = require('pg');

const API = 'http://127.0.0.1:3111';
let pass = 0, fail = 0;

const ok = (cond, name, extra = '') => {
  if (cond) { console.log(`✔ ${name}`); pass++; }
  else { console.log(`✘ ${name} ${extra}`); fail++; }
};

const call = async (path, opts = {}) => {
  const r = await fetch(API + path, {
    method: opts.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
};

const phone = () => '+7701' + String(Math.floor(1000000 + Math.random() * 8999999));

async function main() {
  // ---------- 1. РЕГИСТРАЦИЯ ВЛАДЕЛЬЦА ----------
  // лимит запросов кода проверяем на отдельном номере
  const limPhone = phone();
  for (let i = 0; i < 3; i++) await call('/auth/otp', { body: { phone: limPhone, purpose: 'register' } });
  let r = await call('/auth/otp', { body: { phone: limPhone, purpose: 'register' } });
  ok(r.status === 400, 'Больше 3 запросов кода в час — отказ (защита от SMS-бомбинга)');

  const ownerPhone = phone();
  r = await call('/auth/otp', { body: { phone: ownerPhone, purpose: 'register' } });
  ok(r.status === 201 && r.data.devCode, 'OTP-код на телефон отправлен', JSON.stringify(r.data));
  const code = r.data.devCode;

  r = await call('/auth/register', {
    body: { phone: ownerPhone, code, businessName: 'Магазин Тест', ownerName: 'Айгуль', password: 'Aigul12345', lang: 'kk' },
  });
  ok(r.status === 201 && r.data.access && r.data.refresh, 'Регистрация по SMS-коду прошла, токены выданы', JSON.stringify(r.data));
  ok(r.data.employee?.isOwner === true, 'Зарегистрированный — владелец аккаунта');
  ok(r.data.employee?.isShiftAdmin === true, 'У владельца всегда включён «администратор смены» (модель Wipon)');
  const owner = r.data;
  const accountId = owner.employee.accountId;

  r = await call('/auth/register', {
    body: { phone: ownerPhone, code, businessName: 'Ещё магазин', ownerName: 'Кто-то', password: 'Aigul12345' },
  });
  // Код по умолчанию не требуется (модерация оператором вместо СМС),
  // но повторная регистрация того же номера всё равно отбивается.
  ok(r.status === 400 || r.status === 401, 'Повторная регистрация того же номера отклонена');

  // ---------- 2. ВХОД В КАБИНЕТ ----------
  r = await call('/auth/login', { body: { phone: ownerPhone, password: 'Aigul12345' } });
  ok(r.status === 201 && r.data.access, 'Вход по телефону и паролю');

  r = await call('/auth/login', { body: { phone: ownerPhone, password: 'wrong' } });
  ok(r.status === 401, 'Неверный пароль отклонён');

  const victim = phone();
  for (let i = 0; i < 5; i++) await call('/auth/login', { body: { phone: victim, password: 'x' } });
  r = await call('/auth/login', { body: { phone: victim, password: 'x' } });
  ok(r.status === 403, 'После 5 неудач — блокировка на 5 минут (защита от перебора)');

  // ---------- 3. РОТАЦИЯ REFRESH И ДЕТЕКТ КРАЖИ ----------
  r = await call('/auth/refresh', { body: { refresh: owner.refresh } });
  ok(r.status === 201 && r.data.refresh && r.data.refresh !== owner.refresh, 'Refresh выдал новую пару токенов (ротация)');
  const rotated = r.data;

  r = await call('/auth/refresh', { body: { refresh: owner.refresh } });
  ok(r.status === 401, 'Повторное использование старого refresh — отказ (детект кражи)');

  r = await call('/auth/refresh', { body: { refresh: rotated.refresh } });
  ok(r.status === 401, 'После детекта кражи погашено всё семейство токенов, даже свежий');

  // ---------- 4. НОВЫЙ ВХОД, СОЗДАНИЕ КАССИРА ----------
  r = await call('/auth/login', { body: { phone: ownerPhone, password: 'Aigul12345' } });
  const auth = { Authorization: `Bearer ${r.data.access}` };

  r = await call('/auth/me', { method: 'GET', headers: auth });
  ok(r.status === 200 && r.data.permissions['*'], 'GET /auth/me отдаёт права владельца');

  // кассира и кассу заводим напрямую в БД (их API — Часть 1.4)
  const db = new Client({ host: 'localhost', user: process.env.PGUSER || 'shop_app', password: process.env.PGPASSWORD || 'change_me_in_prod', database: process.env.PGDATABASE || 'shop_dev' });
  await db.connect();
  await db.query('BEGIN'); await db.query(`SET LOCAL app.account_id = '${accountId}'`);
  const storeId = (await db.query('SELECT id FROM store LIMIT 1')).rows[0].id;
  const whId = (await db.query('SELECT id FROM warehouse LIMIT 1')).rows[0].id;
  const cashierPhone = phone();
  const cashierId = (await db.query(
    `INSERT INTO employee (account_id, role_id, first_name, phone, password_hash, can_login_pos, can_login_admin, badge_barcode)
     VALUES ($1,(SELECT id FROM role WHERE code='cashier'),'Марат',$2,$3,true,false,'BADGE-CASHIER') RETURNING id`,
    [accountId, cashierPhone, '$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345'])).rows[0].id;
  await db.query(`INSERT INTO employee_store (employee_id, store_id, account_id) VALUES ($1,$2,$3)`, [cashierId, storeId, accountId]);
  const registerId = (await db.query(
    `INSERT INTO cash_register (account_id, store_id, warehouse_id, name) VALUES ($1,$2,$3,'Касса 1') RETURNING id`,
    [accountId, storeId, whId])).rows[0].id;
  const ownerId = (await db.query(`SELECT id FROM employee WHERE is_owner`)).rows[0].id;
  await db.query('COMMIT');

  // ---------- 4б. СМЕНА ПАРОЛЯ (модель Wipon: текущий → новый) ----------
  r = await call('/auth/password/change', { headers: auth, body: { currentPassword: 'wrong', newPassword: 'NewPass12345' } });
  ok(r.status === 401, 'Смена пароля без знания текущего отклонена');

  r = await call('/auth/password/change', { headers: auth, body: { currentPassword: 'Aigul12345', newPassword: 'NewPass12345' } });
  ok(r.status === 201, 'Пароль сменён по текущему паролю');

  r = await call('/auth/login', { body: { phone: ownerPhone, password: 'NewPass12345' } });
  ok(r.status === 201, 'Вход по новому паролю работает');
  const auth3 = { Authorization: `Bearer ${r.data.access}` };

  r = await call('/auth/login', { body: { phone: ownerPhone, password: 'Aigul12345' } });
  ok(r.status === 401, 'Старый пароль больше не работает');

  // ---------- 5. PIN ----------
  Object.assign(auth, auth3);   // дальше работаем свежим токеном
  r = await call('/auth/employees/pin', { headers: auth, body: { employeeId: cashierId, pin: '1234' } });
  ok(r.status === 201 && r.data.ok, 'PIN кассиру установлен');

  r = await call('/auth/employees/pin', { headers: auth, body: { employeeId: ownerId, pin: '1234' } });
  ok(r.status === 400, 'Одинаковый PIN у двух сотрудников запрещён (иначе подписи операций врут)');

  r = await call('/auth/employees/pin', { headers: auth, body: { employeeId: ownerId, pin: '9999' } });
  ok(r.status === 201, 'Владельцу выдан свой PIN');

  r = await call('/auth/employees/pin', { headers: auth, body: { employeeId: cashierId, pin: '12' } });
  ok(r.status === 400, 'PIN не из 4 цифр отклонён');

  // ---------- 6. КАССИР НЕ ХОДИТ В КАБИНЕТ ----------
  r = await call('/auth/login', { body: { phone: cashierPhone, password: 'anything' } });
  ok(r.status === 401, 'Кассир не может войти в кабинет (can_login_admin=false)');

  // ---------- 7. ПРИВЯЗКА УСТРОЙСТВА ОДНОРАЗОВЫМ КЛЮЧОМ (модель UMAG) ----------
  r = await call('/auth/devices/pairing-code', { headers: auth, body: { cashRegisterId: registerId, name: 'ПК в зале' } });
  ok(r.status === 201 && r.data.code?.length === 8, 'Одноразовый ключ привязки сгенерирован в кабинете');
  const pairCode = r.data.code;

  r = await call('/pos/pair', { body: { code: pairCode, platform: 'windows', appVersion: '1.0.0' } });
  ok(r.status === 201 && r.data.deviceToken, 'Касса привязалась по ключу и получила токен устройства');
  const devToken = r.data.deviceToken;

  r = await call('/pos/pair', { body: { code: pairCode, platform: 'android', appVersion: '1.0.0' } });
  ok(r.status === 401, 'Ключ одноразовый: вторая касса по нему не привяжется');

  r = await call('/pos/pair', { body: { code: 'FFFFFFFF', platform: 'windows', appVersion: '1.0.0' } });
  ok(r.status === 401, 'Выдуманный ключ отклонён');

  // ---------- 8. ПАКЕТ ДЛЯ ОФЛАЙНА ----------
  r = await call('/pos/bootstrap', { method: 'GET', headers: { 'X-Device-Token': devToken } });
  const bs = r.data;
  ok(r.status === 200 && bs.staff?.length >= 2, 'Bootstrap отдал сотрудников для офлайн-входа');
  ok(bs.staff.every((s) => s.pos_pin_hash), 'Хэши PIN уехали на устройство → вход работает без интернета');
  ok(!!bs.posProfile && bs.posProfile.allow_credit_sale === true, 'Разрешения кассы уехали на устройство (профиль точки)');

  r = await call('/pos/bootstrap', { method: 'GET', headers: { 'X-Device-Token': 'fake-token-abc123' } });
  ok(r.status === 401, 'Поддельный токен устройства отклонён');

  // ---------- 9. ВХОД НА КАССУ ПО PIN ----------
  r = await call('/pos/login', { headers: { 'X-Device-Token': devToken }, body: { pin: '1234' } });
  ok(r.status === 201 && r.data.sessionId, 'Кассир вошёл на кассу по PIN');
  ok(r.data.employee.employeeId === cashierId, 'Сессия подписана правильным сотрудником');
  ok(r.data.employee.canSeeRevenue === false, 'Кассир не видит выручку (право из роли, модель Wipon)');

  r = await call('/pos/login', { headers: { 'X-Device-Token': devToken }, body: { pin: '0000' } });
  ok(r.status === 401, 'Неверный PIN отклонён');

  r = await call('/pos/switch-user', { headers: { 'X-Device-Token': devToken }, body: { pin: '9999' } });
  ok(r.status === 201 && r.data.employee.isOwner, 'Переключение на владельца внутри смены (модель Wipon)');

  await db.query('BEGIN'); await db.query(`SET LOCAL app.account_id = '${accountId}'`);
  const sessions = await db.query(`SELECT count(*)::int AS n FROM pos_session WHERE ended_at IS NULL`);
  await db.query('COMMIT');
  ok(sessions.rows[0].n === 1, 'Активная сессия на устройстве всегда одна (предыдущая закрыта)');

  // ---------- 10. ПОДТВЕРЖДЕНИЕ ДЕЙСТВИЯ СТАРШИМ (расширенный UMAG) ----------
  r = await call('/pos/approve', {
    headers: { 'X-Device-Token': devToken },
    body: { requestedBy: cashierId, action: 'refund', pin: '9999', entity: 'sale', offline: true },
  });
  ok(r.status === 201 && r.data.approved, 'Возврат подтверждён PIN владельца (работает офлайн)');
  ok(r.data.approvedBy === ownerId, 'В журнале записано, КТО именно разрешил операцию');

  r = await call('/pos/approve', {
    headers: { 'X-Device-Token': devToken },
    body: { requestedBy: cashierId, action: 'refund', pin: '1234' },
  });
  ok(r.status === 403, 'Кассир не может подтвердить сам себе (нужен администратор)');

  r = await call('/pos/approve', {
    headers: { 'X-Device-Token': devToken },
    body: { requestedBy: cashierId, action: 'refund', badge: 'BADGE-CASHIER' },
  });
  ok(r.status === 403, 'Бейдж кассира не годится для подтверждения');

  const ap = await db.query(`SELECT approved_by, requested_by, method FROM action_approval WHERE account_id=$1`, [accountId]);
  await db.query('BEGIN'); await db.query(`SET LOCAL app.account_id = '${accountId}'`);
  const ap2 = await db.query(`SELECT approved_by, requested_by, method, offline FROM action_approval`);
  await db.query('COMMIT');
  ok(ap2.rows.length === 1 && ap2.rows[0].offline === true, 'Подтверждение сохранено с пометкой «офлайн» и двумя подписями');

  // ---------- 11. ПРАВА ----------
  const cashierCtxLogin = await call('/pos/login', { headers: { 'X-Device-Token': devToken }, body: { pin: '1234' } });
  ok(cashierCtxLogin.data.employee.permissions.pos?.view === true, 'У кассира есть право на кассу');
  ok(!cashierCtxLogin.data.employee.permissions.finance, 'У кассира нет прав на финансы');

  // ---------- 12. «ВЫДАТЬ ДОСТУП» ПОДДЕРЖКЕ (модель UMAG) ----------
  const supportPhone = phone();
  r = await call('/auth/support/grant', { headers: auth, body: { phone: supportPhone, hours: 2 } });
  ok(r.status === 201 && r.data.id, 'Владелец выдал доступ техспециалисту (пароль не передаётся)');
  const accessId = r.data.id;

  const grants = await db.query(`SELECT * FROM auth_list_support_grants($1)`, [supportPhone]);
  ok(grants.rows.length === 1 && grants.rows[0].account_id === accountId, 'Специалист видит выданный ему доступ');

  r = await call('/auth/support/revoke', { headers: auth, body: { accessId } });
  const after = await db.query(`SELECT * FROM auth_list_support_grants($1)`, [supportPhone]);
  ok(after.rows.length === 0, 'Доступ отозван кнопкой — специалист больше не войдёт');

  // ---------- 13. МУЛЬТИТЕНАНТНОСТЬ ЧЕРЕЗ API ----------
  const p2 = phone();
  let o2 = await call('/auth/otp', { body: { phone: p2, purpose: 'register' } });
  o2 = await call('/auth/register', {
    body: { phone: p2, code: o2.data.devCode, businessName: 'Чужой магазин', ownerName: 'Ержан', password: 'Erzhan12345' },
  });
  const auth2 = { Authorization: `Bearer ${o2.data.access}` };
  r = await call('/auth/devices/pairing-code', { headers: auth2, body: { cashRegisterId: registerId } });
  ok(r.status === 403, 'Чужой аккаунт не может выдать ключ привязки к нашей кассе', JSON.stringify(r.data));

  await db.end();

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  process.exit(fail ? 1 : 0);
}

// поднимаем сервер и ждём готовности
const srv = spawn('node', ['dist/main.js'], {
  cwd: __dirname + '/..',
  env: { ...process.env, PORT: '3111', NODE_ENV: 'test', PGUSER: process.env.PGUSER || 'shop_app', PGPASSWORD: process.env.PGPASSWORD || 'change_me_in_prod', PGDATABASE: process.env.PGDATABASE || 'shop_dev' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => { const s = d.toString(); if (s.includes('Error') && !s.includes('Nest')) process.stderr.write(s); });

const wait = async () => {
  for (let i = 0; i < 40; i++) {
    try { await fetch(API + '/auth/me'); return true; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  return false;
};
wait().then(async (up) => {
  if (!up) { console.error('Сервер не поднялся'); srv.kill(); process.exit(1); }
  try { await main(); } catch (e) { console.error('ОШИБКА ТЕСТА:', e); process.exit(1); }
  finally { srv.kill(); }
});
