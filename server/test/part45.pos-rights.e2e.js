/**
 * ★ ЧАСТЬ 45 — Права по действиям на кассе, скидки, журнал.
 *
 * Модель UMAG, доведённая: не запрет, а разрешение с подтверждением.
 */
const { spawn } = require('child_process');
const PORT = '3397';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7717' + Math.floor(1000000 + Math.random() * 8999999);
let TOK = '', DEV = '';
const j = async (m, p, b, dev = false) => {
  const r = await fetch(API + p, { method: m,
    headers: { 'Content-Type': 'application/json',
      ...(dev ? { 'X-Device-Token': DEV } : TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};
const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

(async () => {
  ok(await wait(), 'Сервер поднялся');
  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Права Тест', ownerName: 'Владелец', password: 'Password123' });
  TOK = r.d.access;

  // ---------- УМОЛЧАНИЯ ----------
  r = await j('GET', '/pos-settings');
  ok(r.d?.act_refund === 'everyone', 'Возврат по умолчанию доступен всем — обычная операция');
  ok(r.d?.act_refund_free === 'admin_only',
     '★ Возврат БЕЗ чека по умолчанию только с администратором — проверить покупку нечем');
  ok(r.d?.act_cash_out === 'admin_only', 'Изъятие денег — тоже с администратором');
  ok(r.d?.discount_allowed === true && Number(r.d?.discount_max_pct) === 100,
     'Скидки разрешены без потолка — новый магазин работает сразу');

  r = await j('GET', '/pos-settings/actions');
  ok(Array.isArray(r.d) && r.d.length === 7, `★ Семь ограничиваемых действий: ${r.d?.length}`);
  ok(r.d.every((a) => a.why), '★ У каждого написано ЗАЧЕМ — владелец не гадает, что включать');

  // ---------- НАСТРОЙКА ----------
  r = await j('PATCH', '/pos-settings', { discount_max_pct: 15, no_price_down: true, act_discount: 'admin_only' });
  ok(Number(r.d?.discount_max_pct) === 15, '★ Потолок скидки 15%: уступить можно, раздать нельзя');
  ok(r.d?.no_price_down === true, 'Запрет снижения цены включён');

  r = await j('PATCH', '/pos-settings', { discount_max_pct: 150 });
  ok(r.status === 400, 'Потолок больше 100% отбит');

  // ---------- ПОДТВЕРЖДЕНИЕ PIN ----------
  const me = (await j('GET', '/auth/me')).d;
  await j('PATCH', `/auth/employees/${me.employeeId}`, { pin: '4321' });

  r = await j('POST', '/admin/stores/registers', { name: 'Касса 1' });
  r = await j('POST', '/auth/devices/pairing-code', { cashRegisterId: r.d.id });
  r = await j('POST', '/pos/pair', { code: r.d.code, platform: 'windows', appVersion: '1.5.0' });
  DEV = r.d.deviceToken;

  r = await j('GET', '/pos/settings', null, true);
  ok(Number(r.d?.discount_max_pct) === 15, '★ Касса получает настройки по токену устройства');

  r = await j('POST', '/pos/settings/approve', { pin: '4321' }, true);
  ok(r.d?.ok && r.d?.name, `★ PIN владельца подошёл: разрешил ${r.d?.name}`);
  ok(!!r.d?.employeeId, 'Возвращается кто именно разрешил — для журнала');

  r = await j('POST', '/pos/settings/approve', { pin: '0000' }, true);
  ok(r.d?.ok === false && /PIN/.test(r.d?.reason ?? ''), 'Чужой PIN отбит с понятной причиной');

  // ---------- ЖУРНАЛ ----------
  await j('POST', '/pos/settings/log', { action: 'discount', productName: 'Молоко', amount: 200,
    employeeId: me.employeeId, approvedBy: me.employeeId }, true);
  await j('POST', '/pos/settings/log', { action: 'remove_item', productName: 'Хлеб', amount: 250,
    employeeId: me.employeeId }, true);
  await j('POST', '/pos/settings/log', { action: 'refund_free', productName: 'Кофе', amount: 900,
    employeeId: me.employeeId, approvedBy: me.employeeId }, true);

  r = await j('GET', '/pos-settings/action-log');
  ok(r.d?.count === 3, `★ Журнал действий: ${r.d?.count} записи`);
  ok(r.d?.items?.[0]?.employee, 'Видно, кто сделал');
  ok(r.d?.items?.some((x) => x.approved_by), '★ И кто разрешил — без этого журнал бесполезен');
  ok(r.d?.byEmployee?.[0]?.total === 3,
     `★ Сводка по людям: ${r.d?.byEmployee?.[0]?.employee} — ${r.d?.byEmployee?.[0]?.total} действия`);
  ok(r.d.byEmployee[0].discounts === 1 && r.d.byEmployee[0].removals === 1,
     'Разложено по видам: скидки, отмены, возвраты — видно, у кого чего больше');

  // ---------- БОНУСЫ НА КАССЕ ----------
  await j('POST', '/loyalty/programs', { name: 'Кэшбэк', kind: 'cashback', earnPercent: 3, spendPercent: 50 });
  r = await j('POST', '/contragents', { name: 'Марат', phone: '+77011112233', roles: ['customer'] });
  const cust = r.d.id;
  r = await j('GET', `/pos/bonus/spendable?customerId=${cust}&total=10000`, null, true);
  ok(r.status === 200 && 'canSpend' in (r.d ?? {}),
     '★ Касса спрашивает сервер, сколько бонусов списать — правило живёт в одном месте');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
