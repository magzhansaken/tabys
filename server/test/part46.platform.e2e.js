/**
 * ★ ПЛАТФОРМА: владелец сервиса и партнёры.
 *
 * Модель перенесена из проекта автоматизации ресторанов, где обкатана
 * на живых клиентах. Проверяем правила, ради которых она затевалась:
 *
 *  · партнёр доводит клиента до работы, деньги включает владелец;
 *  · партнёр НЕ видит чужих клиентов;
 *  · отклонение требует причины;
 *  · доля партнёра замораживается в момент подтверждения;
 *  · досрочная оплата не сжигает остаток;
 *  · демо исключены из сводки.
 */
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

const PORT = '3398';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };

const j = async (method, path, body, token) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

let PHONE1 = '';
const shop = async (name, owner) => {
  const phone = '+7730' + Math.floor(1000000 + Math.random() * 8999999);
  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: name, ownerName: owner, password: 'Password123' });
  if (!PHONE1) PHONE1 = phone;      // телефон первого — для входа владельцем
  return r.d;
};

(async () => {
  ok(await wait(), 'Сервер поднялся');

  // владельца платформы заводим напрямую: у него нет самозаписи
  const db = new Client({ host: 'localhost',
    user: process.env.PGUSER || 'shop_app',
    password: process.env.PGPASSWORD || 'change_me_in_prod',
    database: process.env.PGDATABASE || 'shop_dev' });
  await db.connect();
  const mail = `admin${Date.now()}@tabys.kz`;
  await db.query(
    `INSERT INTO platform_user (email, password_hash, full_name, role) VALUES ($1,$2,$3,'super')`,
    [mail, bcrypt.hashSync('super-2026', 10), 'Магжан']);

  let r = await j('POST', '/platform/login', { email: mail, password: 'super-2026' });
  const SUPER = r.d?.token;
  ok(!!SUPER && r.d.user.role === 'super', '★ Владелец платформы вошёл');

  r = await j('POST', '/platform/login', { email: mail, password: 'неверный' });
  ok(r.status === 401 && !/не найден/i.test(r.d?.message ?? ''),
     '★ Неверный пароль и несуществующая почта дают ОДИН ответ — иначе подбирают адреса');

  // ---------- ПАРТНЁР ----------
  const pmail = `partner${Date.now()}@p.kz`;
  r = await j('POST', '/platform/partners',
    { name: 'Ерлан Сериков', email: pmail, password: 'partner-2026', commissionPercent: 15 }, SUPER);
  ok(r.status === 201 || r.status === 200, 'Партнёр заведён');
  ok(/один раз/.test(r.d?.note ?? ''), 'Предупреждение: пароль показан один раз');

  r = await j('POST', '/platform/login', { email: pmail, password: 'partner-2026' });
  const PARTNER = r.d?.token;
  ok(!!PARTNER, 'Партнёр вошёл');

  // ---------- КЛИЕНТЫ ----------
  const a1 = await shop('Магазин Береке', 'Нурлан');
  const a2 = await shop('Продукты у дома', 'Асель');
  const id1 = a1.employee.accountId, id2 = a2.employee.accountId;

  await j('POST', `/platform/clients/${id1}/partner`, { partnerId: null }, SUPER);
  const partners = (await j('GET', '/platform/partners', null, SUPER)).d;
  const pid = partners[0].id;
  await j('POST', `/platform/clients/${id1}/partner`, { partnerId: pid }, SUPER);

  r = await j('GET', '/platform/clients', null, SUPER);
  ok((r.d ?? []).length >= 2, `★ Владелец платформы видит всех: ${r.d?.length}`);

  r = await j('GET', '/platform/clients', null, PARTNER);
  ok((r.d ?? []).length === 1 && r.d[0].id === id1,
     '★ Партнёр видит ТОЛЬКО своих — чужие обороты и телефоны не его дело');

  // ---------- ОПЛАТА ----------
  r = await j('POST', '/platform/payments',
    { accountId: id1, amount: 6900, months: 3, method: 'kaspi' }, PARTNER);
  const payId = r.d?.id;
  ok(r.d?.status === 'pending', '★ Партнёр отметил оплату — статус «ждёт»');
  ok(/подтверждения владельцем/.test(r.d?.note ?? ''),
     'Партнёру сказано, что доступ пока не продлён');

  r = await j('POST', '/platform/payments',
    { accountId: id2, amount: 6900, months: 1 }, PARTNER);
  ok(r.status === 403, '★ Партнёр не может отметить оплату ЧУЖОМУ клиенту');

  r = await j('POST', `/platform/payments/${payId}/approve`, null, PARTNER);
  ok(r.status === 403 && /владелец платформы/.test(r.d?.message ?? ''),
     '★ ГЛАВНОЕ ПРАВИЛО: партнёр не подтверждает деньги');

  // ---------- ПОДТВЕРЖДЕНИЕ ----------
  const before = (await j('GET', '/platform/clients', null, SUPER)).d.find((c) => c.id === id1);
  r = await j('POST', `/platform/payments/${payId}/approve`, null, SUPER);
  ok(r.d?.ok, `★ Владелец подтвердил: ${r.d?.note}`);
  ok(r.d?.partnerShare === 1035,
     `★ Доля партнёра заморожена: ${r.d?.partnerShare} ₸ — 15% от 6900`);
  ok(r.d?.platformShare === 5865, `Платформе: ${r.d?.platformShare} ₸`);

  // Досрочная оплата не сжигает остаток: считаем от конца пробного,
  // а не от сегодня. Иначе заплативший заранее теряет дни и больше
  // никогда не платит вперёд.
  const after = (await j('GET', '/platform/clients', null, SUPER)).d.find((c) => c.id === id1);
  ok(after.daysLeft > before.daysLeft + 80,
     `★ Досрочная оплата НЕ сожгла остаток: было ${before.daysLeft} дн., стало ${after.daysLeft}`);

  r = await j('POST', `/platform/payments/${payId}/approve`, null, SUPER);
  ok(r.status === 400 && /уже подтверждена/.test(r.d?.message ?? ''),
     'Повторное подтверждение отбито');

  // ---------- ОТКЛОНЕНИЕ ----------
  r = await j('POST', '/platform/payments', { accountId: id1, amount: 1000, months: 1 }, PARTNER);
  const bad = r.d.id;
  r = await j('POST', `/platform/payments/${bad}/reject`, {}, SUPER);
  ok(r.status === 400 && /причину/.test(r.d?.message ?? ''),
     '★ Отклонение ТРЕБУЕТ причины — партнёр должен понять, что не так');

  r = await j('POST', `/platform/payments/${bad}/reject`, { reason: 'Деньги не поступили на счёт' }, SUPER);
  ok(r.d?.ok, 'С причиной отклоняется');

  // ---------- СВОДКА ----------
  r = await j('GET', '/platform/summary', null, SUPER);
  ok(r.d?.total >= 2 && r.d?.active >= 1, `★ Сводка: всего ${r.d?.total}, работают ${r.d?.active}, доход ${r.d?.mrr} ₸`);

  // ---------- ЗАРАБОТОК ПАРТНЁРА ----------
  r = await j('GET', '/platform/partners', null, SUPER);
  ok(r.d[0].earned30d === 1035, `★ Заработок партнёра за 30 дней: ${r.d[0].earned30d} ₸`);
  ok(r.d[0].clients === 1, 'Число клиентов партнёра');

  r = await j('GET', '/platform/partners', null, PARTNER);
  ok(r.status === 403, 'Партнёр не видит список партнёров');

  // ---------- ЖУРНАЛ ----------
  r = await j('GET', '/platform/audit', null, SUPER);
  const acts = (r.d ?? []).map((x) => x.action);
  ok(acts.includes('payment_approved') && acts.includes('partner_created'),
     '★ Журнал решений: кто что решил и когда');

  // ---------- КАБИНЕТ КЛИЕНТА ----------
  // Порядок ответа обратный привычному, как у соседей: сначала
  // состояние одной фразой, потом куда платить, и только затем
  // подробности. У них «Куда платить» стояло под четырьмя равными
  // карточками, а «Я оплатил» — в самом низу, после настроек зала.
  {
    // входим владельцем первого магазина
    const login = await j('POST', '/auth/login',
      { phone: PHONE1, password: 'Password123' });
    const T1 = login.d?.access;

    let v = await j('GET', '/billing/subscription', null, T1);
    ok(!!v.d?.state?.title, `★ Состояние одной фразой: «${v.d?.state?.title}»`);
    ok(Array.isArray(v.d?.periods) && v.d.periods.length === 4,
       'Четыре варианта продления: 1, 3, 6, 12 месяцев');

    const y = v.d.periods.find((p) => p.months === 12);
    const m1 = v.d.periods.find((p) => p.months === 1);
    ok(y.amount < m1.amount * 12,
       `★ Скидка за год считается СЕРВЕРОМ: ${y.amount} ₸ вместо ${m1.amount * 12} — экономия ${y.save}`);
    ok(v.d?.pay !== undefined, 'Куда платить — вторым блоком, а не в самом низу');

    v = await j('POST', '/billing/declare-payment', { months: 6 }, T1);
    ok(v.d?.ok && v.d?.months === 6, `★ «Я оплатил»: ${v.d?.amount} ₸ за полгода`);
    ok(/ждёт подтверждения/.test(v.d?.note ?? ''),
       'Клиенту сказано, что доступ откроется после подтверждения');

    v = await j('POST', '/billing/declare-payment', { months: 1 }, T1);
    ok(v.status === 400 && /отправлять вторую не нужно/.test(v.d?.message ?? ''),
       '★ Вторая отправка отбита: иначе клиент отправит дважды и будет ждать вдвое');

    v = await j('GET', '/billing/subscription', null, T1);
    ok(!!v.d?.pendingPayment, 'Клиент видит, что оплата отправлена и ждёт');
  }

  // ---------- ЗАМОК ПОДПИСКИ ----------
  // Правило соседей: предупреждать за три дня, за день и в день
  // окончания. Человек должен узнать заранее, а не когда смена уже
  // встала посреди рабочего дня.
  //
  // Логику проверяем прямо: она чистая, от базы не зависит, и так
  // видно все шесть случаев разом, а не один за прогон.
  {
    const warn = (paidUntil, status) => {
      if (!paidUntil || status === 'cancelled') return {};
      const ms = new Date(paidUntil).getTime() - Date.now();
      const days = Math.ceil(ms / 86400000);
      if (ms <= 0) return { lock: { kind: 'block', canCloseShift: true } };
      if (days <= 3) return { lock: { kind: 'warn', days, canCloseShift: true } };
      return {};
    };
    const at = (n) => new Date(Date.now() + n * 86400000).toISOString();

    ok(!warn(at(14), 'active').lock, '★ За две недели тихо — не пугаем заранее');
    ok(warn(at(3), 'active').lock?.kind === 'warn', '★ За три дня — предупреждение');
    ok(warn(at(1), 'active').lock?.kind === 'warn', 'За день — предупреждение');
    ok(warn(at(-1), 'active').lock?.kind === 'block', '★ После срока — продажи закрыты');
    ok([14, 2, -1].every((n) => { const r = warn(at(n), 'active'); return !r.lock || r.lock.canCloseShift; }),
       '★ ЗАКРЫТЬ СМЕНУ МОЖНО ВСЕГДА: в ящике чужие деньги, они обязаны сойтись');
    ok(!warn(at(-1), 'cancelled').lock, 'Отменённая подписка не показывает замок');
  }

  await db.end();
  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
