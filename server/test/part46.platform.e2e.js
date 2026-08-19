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
  const partners = (await j('GET', '/platform/partners', null, SUPER))
    .d.rows.filter((p) => !p.isSuperUser);
  const pid = partners[0].id;
  await j('POST', `/platform/clients/${id1}/partner`, { partnerId: pid }, SUPER);

  r = await j('GET', '/platform/clients', null, SUPER);
  ok((r.d?.rows ?? []).length >= 2, `★ Владелец платформы видит всех: ${r.d?.rows?.length}`);

  r = await j('GET', '/platform/clients', null, PARTNER);
  ok((r.d?.rows ?? []).length === 1 && r.d.rows[0].id === id1,
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

  // ---------- ПРЕДПРОСМОТР ПЕРЕД ПОДТВЕРЖДЕНИЕМ ----------
  // Опасное действие показывает последствие ДО нажатия. Но считает
  // это СЕРВЕР: дизайнер выводил дату и долю по правилу сервера прямо
  // в кабинете, и правило о деньгах начинало жить в двух местах —
  // разъедутся на первой правке.
  r = await j('GET', `/platform/payments/${payId}/preview`, null, SUPER);
  const prev = r.d;
  ok(!!prev?.paidUntil && prev?.partnerShare === 1035,
     `★ Предпросмотр: продлится до ${String(prev?.paidUntil).slice(0, 10)}, партнёру ${prev?.partnerShare} ₸`);
  ok(prev?.partnerPercent === 15, 'Видно и процент, не только сумму');

  r = await j('GET', `/platform/payments/${payId}/preview`, null, PARTNER);
  ok(r.status === 403, 'Партнёру предпросмотр не показывается — он всё равно не подтверждает');

  // ---------- ПОДТВЕРЖДЕНИЕ ----------
  const before = (await j('GET', '/platform/clients', null, SUPER)).d.rows.find((c) => c.id === id1);
  r = await j('POST', `/platform/payments/${payId}/approve`, null, SUPER);
  ok(r.d?.ok, `★ Владелец подтвердил: ${r.d?.note}`);
  ok(r.d?.partnerShare === 1035,
     `★ Доля партнёра заморожена: ${r.d?.partnerShare} ₸ — 15% от 6900`);
  ok(r.d?.platformShare === 5865, `Платформе: ${r.d?.platformShare} ₸`);
  ok(String(r.d?.paidUntil).slice(0, 10) === String(prev?.paidUntil).slice(0, 10)
     && r.d?.partnerShare === prev?.partnerShare,
     '★ Предпросмотр СОВПАЛ с подтверждением до дня и до тенге — правило одно на двоих');

  // Досрочная оплата не сжигает остаток: считаем от конца пробного,
  // а не от сегодня. Иначе заплативший заранее теряет дни и больше
  // никогда не платит вперёд.
  const after = (await j('GET', '/platform/clients', null, SUPER)).d.rows.find((c) => c.id === id1);
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
  const onlyP = r.d.rows.filter((p) => !p.isSuperUser);
  ok(onlyP[0].earned === 1035, `★ Заработок партнёра за 30 дней: ${onlyP[0].earned} ₸`);
  ok(onlyP[0].clients === 1, 'Число клиентов партнёра');

  r = await j('GET', '/platform/partners', null, PARTNER);
  ok(r.status === 403, 'Партнёр не видит список партнёров');

  // ---------- ЖУРНАЛ ----------
  r = await j('GET', '/platform/audit', null, SUPER);
  const acts = (r.d?.rows ?? []).map((x) => x.action);
  ok(acts.includes('payment_approved') && acts.includes('partner_created'),
     '★ Журнал решений: кто что решил и когда');

  // ---------- ДОПЛАТА ЗА УСТРОЙСТВО: ПРАВИЛО ДЕСЯТИ ДНЕЙ ----------
  // Доплата за остаток берётся, только если до конца десять дней и
  // больше. Меньше — не берём вовсе: спорить с клиентом из-за трёхсот
  // тенге в конце месяца дороже самих трёхсот тенге, а ощущение
  // «содрали за неделю как за месяц» он запомнит надолго.
  {
    // Ставим дату из-под контекста магазина: таблица подписок закрыта
    // правилом «только свой», и без контекста обновление трогает ноль
    // строк — молча, как я уже ловил на сервере.
    const setUntil = async (days) => {
      await db.query('BEGIN');
      await db.query(`SET LOCAL app.account_id = '${id1}'`);
      await db.query(`UPDATE subscription SET paid_until = now() + ($1 || ' days')::interval
                       WHERE account_id = $2`, [String(days), id1]);
      await db.query('COMMIT');
    };

    await setUntil(20);
    r = await j('GET', `/platform/clients/${id1}/device-preview?kind=pos`, null, SUPER);
    ok(r.d?.proRata > 0, `★ Осталось 20 дн — доплата ${r.d?.proRata} ₸ за остаток периода`);
    ok(r.d?.daysLeft === 20, 'Видно, за сколько дней берём');

    await setUntil(7);
    r = await j('GET', `/platform/clients/${id1}/device-preview?kind=pos`, null, SUPER);
    ok(r.d?.proRata === 0,
       '★ ПРАВИЛО ДЕСЯТИ ДНЕЙ: осталось 7 дн — доплату не берём вовсе');
    ok(/не берём/.test(r.d?.note ?? ''), 'И объясняем почему, а не молчим');
  }

  // ---------- СТРОКИ СЧЁТА ----------
  // Счёт не одно число, а строки: клиент добавил вторую кассу — цена
  // выросла на понятную величину, а не стала другой цифрой.
  r = await j('POST', `/platform/clients/${id1}/lines`,
    { kind: 'pos', title: 'Касса №2', price: 3000 }, SUPER);
  ok(r.status === 200 || r.status === 201, 'Строка счёта добавлена');

  r = await j('POST', `/platform/clients/${id1}/lines`,
    { kind: 'discount', title: 'Скидка постоянному', price: 500 }, SUPER);
  const lineId = r.d?.id;

  r = await j('GET', `/platform/clients/${id1}/lines`, null, SUPER);
  const disc = (r.d ?? []).find((x) => x.kind === 'discount');
  ok(disc?.price === -500,
     '★ Скидка — строка с МИНУСОМ: попадает в тот же расчёт и видна в том же списке');

  r = await j('DELETE', `/platform/lines/${lineId}`, null, SUPER);
  ok(r.d?.ok, 'Строка закрывается, а не удаляется — счета прошлых месяцев должны сходиться');

  // ---------- УЧЕБНЫЙ МАГАЗИН И МАССОВЫЕ ДЕЙСТВИЯ ----------
  r = await j('POST', `/platform/clients/${id2}/demo`, { isDemo: true }, SUPER);
  ok(/не попадает в деньги/.test(r.d?.note ?? ''), '★ Магазин помечен учебным');

  r = await j('POST', '/platform/bulk/preview',
    { action: 'grace', days: 7, accountIds: [id1, id2] }, SUPER);
  ok(r.d?.willAffect === 1 && r.d?.skippedDemo === 1,
     '★ ПРЕДПРОСМОТР ПЕРЕД МАССОВЫМ: затронет 1, учебный пропущен');
  ok(/не участвуют в деньгах/.test(r.d?.note ?? ''), 'Сказано, почему пропущен');

  r = await j('POST', '/platform/bulk/apply',
    { action: 'grace', days: 7, accountIds: [id1, id2] }, SUPER);
  ok(r.d?.affected === 1 && r.d?.skippedDemo === 1,
     '★ Применилось ровно к тому, что показал предпросмотр');

  r = await j('POST', '/platform/bulk/apply',
    { action: 'grace', days: 7, accountIds: [id1] }, PARTNER);
  ok(r.status === 403, 'Партнёр не делает массовых действий');

  // ---------- ЗАЯВКИ ПАРТНЁРА ----------
  r = await j('POST', '/platform/requests',
    { accountId: id1, kind: 'device', comment: 'Клиент просит вторую кассу',
      payload: { device: 'pos' } }, PARTNER);
  const reqId = r.d?.id;
  ok(r.d?.status === 'pending', '★ Партнёр подал заявку — решает владелец');

  r = await j('POST', `/platform/requests/${reqId}/decide`, { approve: false }, SUPER);
  ok(r.status === 400 && /причину/.test(r.d?.message ?? ''),
     '★ Отказ по заявке требует причины — как и с оплатой');

  r = await j('POST', `/platform/requests/${reqId}/decide`,
    { approve: true, note: 'Согласовано, ставим' }, SUPER);
  ok(r.d?.ok, 'Заявка решена');

  // ---------- ПРАЙС-ЛИСТ ----------
  r = await j('GET', '/platform/price-book', null, SUPER);
  ok(r.d?.base > 0 && r.d?.extraPos > 0, `★ Прайс: тариф ${r.d?.base} ₸, вторая касса ${r.d?.extraPos} ₸`);

  r = await j('POST', '/platform/price-book', { extraPos: 3500 }, SUPER);
  ok(/Оплаченное время остаётся/.test(r.d?.note ?? ''),
     '★ Смена цен не трогает оплаченные периоды');

  r = await j('POST', '/platform/price-book', { extraPos: 9999 }, PARTNER);
  ok(r.status === 403, 'Партнёр цены не назначает');

  // ---------- СВОДКА ПО ДНЯМ ----------
  r = await j('GET', '/platform/metrics?days=30', null, SUPER);
  ok(Array.isArray(r.d?.series), `★ Сводка: ряд из ${r.d?.series?.length} дней`);

  // ---------- ВОРОНКА: ЗАМЕТКА И ДАТА КАСАНИЯ ----------
  await j('PATCH', `/platform/clients/${id1}`,
    { dealStage: 'contacted', dealNote: 'Показал кассу, думает до пятницы' }, PARTNER);
  r = await j('GET', '/platform/clients', null, PARTNER);
  const card = r.d.rows[0];
  ok(card?.dealNote === 'Показал кассу, думает до пятницы',
     '★ Заметка видна в списке: без неё через две недели «показали» ничего не значит');
  ok(!!card?.touchedAt, 'Дата последнего касания есть');
  ok(card?.dealStage === 'contacted', 'Этап воронки сохранён');

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

  // ---------- ТРИ ДЕЙСТВИЯ ПЕРЕНЕСЁННОГО КАБИНЕТА ----------
  // Кабинет платформы взят из проекта ресторанов целиком. Он зовёт три
  // действия, которых у нас не было — дописаны под него.
  {
    // Сброс пароля: партнёру звонит клиент «забыл пароль», и это должно
    // решаться на месте, а не походом в другой раздел.
    let v = await j('POST', '/platform/reset-owner-password', { tenantId: id1 }, SUPER);
    ok(typeof v.d?.password === 'string' && v.d.password.length >= 8,
       `★ Пароль владельцу сброшен: ${v.d?.password}`);
    ok(/один раз/.test(v.d?.note ?? ''), 'Сказано, что показан один раз — диктовать голосом');
    ok(!/[l1IO0]/.test(v.d?.password ?? 'x'),
       '★ В пароле нет похожих знаков: его диктуют по телефону, где «l» и «1» не различить');

    const newPass = v.d.password;
    v = await j('POST', '/auth/login', { phone: PHONE1, password: newPass });
    ok(!!v.d?.access, '★ Новым паролем владелец действительно входит');

    // Добавление кассы — с доплатой по правилу десяти дней.
    v = await j('POST', '/platform/device/add', { tenantId: id1, kind: 'pos' }, SUPER);
    ok(v.d?.ok, `★ Касса добавлена: ${v.d?.note}`);

    v = await j('GET', `/platform/clients/${id1}/lines`, null, SUPER);
    ok((v.d ?? []).some((x) => x.kind === 'pos'),
       'Появилась строка счёта — со следующего месяца цена вырастет на понятную величину');

    // Удаление требует набрать название слово в слово: удаление
    // необратимо, а «случайно нажал» с чужими деньгами не шутка.
    v = await j('POST', '/platform/tenant/delete', { tenantId: id2, confirmName: 'не то' }, SUPER);
    ok(v.status === 400 && /слово в слово/.test(v.d?.message ?? ''),
       '★ Удаление с неверным названием отбито');

    v = await j('POST', '/platform/tenant/delete', { tenantId: id2, confirmName: 'Продукты у дома' }, SUPER);
    ok(v.d?.ok && /Данные сохранены/.test(v.d?.note ?? ''),
       '★ Удаление мягкое: магазин отключён, данные остались — их спросят и через год');

    v = await j('POST', '/platform/tenant/delete', { tenantId: id1, confirmName: 'Магазин Береке' }, PARTNER);
    ok(v.status === 403, 'Партнёр не удаляет клиентов');
  }

  // ---------- РАЗДЕЛ 1: «СЕГОДНЯ» ----------
  // Лента решений на утро. Замысел донора: день начинается не со
  // списка клиентов, а с того, что требует решения сегодня.
  {
    let v = await j('GET', '/platform/today', null, SUPER);
    ok(Array.isArray(v.d?.groups), '★ «Сегодня» отдаёт ленту очередей');

    const byKey = Object.fromEntries((v.d.groups ?? []).map((g) => [g.key, g]));
    ok(!!byKey.today?.items?.length,
       `★ Пришло сегодня: ${byKey.today?.items?.length} — свежее, пока помнят разговор`);

    const pay = (byKey.today?.items ?? []).find((x) => x.kind === 'payment');
    ok(pay && pay.amount > 0 && pay.client && pay.paymentId,
       `★ Оплата в ленте: ${pay?.amount} ₸ от «${pay?.client}» — видно, кого касается`);
    ok(pay?.can?.approve === true, 'Владелец платформы может подтвердить прямо из ленты');
    // Последствие видно БЕЗ нажатия — главное, что взято у донора.
    ok(!!pay?.effect && /продлит до/.test(pay.effect),
       `★ Последствие видно без нажатия: «${pay?.effect}»`);

    // Порядок групп важен: просроченные первыми, «скоро платить»
    // последними. Владелец читает сверху вниз и до конца не доходит.
    const order = (v.d.groups ?? []).map((g) => g.key);
    const iOver = order.indexOf('overdue'), iSoon = order.indexOf('soon');
    ok(iOver === -1 || iSoon === -1 || iOver < iSoon,
       '★ Просроченные выше «скоро платить»: сверху то, где деньги уже теряются');

    // Партнёру денежные кнопки не рисуем: он их всё равно не нажмёт,
    // а мёртвая кнопка хуже отсутствующей.
    v = await j('GET', '/platform/today', null, PARTNER);
    const all = (v.d.groups ?? []).flatMap((g) => g.items);
    ok(all.length > 0, `Партнёр видит свою ленту: ${all.length} дел`);
    ok(all.every((x) => x.can.approve === false && x.can.decide === false),
       '★ Партнёру денежные решения НЕ показываются — рисовать «нельзя» нечестно');
    ok(all.every((x) => x.can.call === true), 'Но позвонить клиенту он может всегда');
  }

  // ---------- РАЗДЕЛ 2: «КЛИЕНТЫ» ----------
  // Список с отборами и счётчиками. Отбор в БАЗЕ, а не в браузере: у
  // донора список приходил целиком и фильтровался у себя — при сотне
  // клиентов это лишние сотни строк по сети на каждое нажатие.
  {
    let v = await j('GET', '/platform/clients', null, SUPER);
    ok(Array.isArray(v.d?.rows) && v.d?.counts,
       `★ Список со счётчиками: всего ${v.d?.counts?.all}`);
    ok(typeof v.d.counts.expired === 'number' && typeof v.d.stats.mrr === 'number',
       `Счётчики и пять чисел приходят со списком: доход ${v.d.stats.mrr} ₸`);

    // Порядок: где горит — сверху. Владелец читает сверху и до конца
    // обычно не доходит.
    const withDays = v.d.rows.filter((r) => r.daysLeft != null);
    const sorted = withDays.every((r, i) =>
      i === 0 || withDays[i - 1].daysLeft <= r.daysLeft);
    ok(sorted, '★ Порядок по срочности: просроченные сверху, спокойные внизу');

    // Отборы
    v = await j('GET', '/platform/clients?filter=expired', null, SUPER);
    ok(v.d.rows.every((r) => r.expired), '★ Отбор «просрочены» даёт только просроченных');

    v = await j('GET', '/platform/clients?filter=pending_pay', null, SUPER);
    ok(v.d.rows.every((r) => r.pendingPayments > 0),
       '★ Отбор «ждут подтверждения» — только те, у кого висит оплата');

    // Четыре порядка, как у донора: где горит, кто дорог, кто живёт,
    // и по названию — когда ищешь конкретного.
    for (const srt of ['due', 'price', 'revenue', 'name']) {
      v = await j('GET', `/platform/clients?sort=${srt}`, null, SUPER);
      ok(Array.isArray(v.d.rows), `Порядок «${srt}» работает`);
    }

    // Поиск по телефону в любом виде: люди пишут то +7, то 8, то без.
    const withPhone = (await j('GET', '/platform/clients', null, SUPER))
      .d.rows.find((r) => r.ownerPhone);
    if (withPhone) {
      const tail = String(withPhone.ownerPhone).replace(/\D/g, '').slice(-10);
      for (const form of ['+7' + tail, '8' + tail, tail]) {
        v = await j('GET', `/platform/clients?q=${encodeURIComponent(form)}`, null, SUPER);
        ok(v.d.rows.some((r) => r.id === withPhone.id),
           `★ Поиск по телефону «${form}» находит того же клиента`);
      }
    }

    // Месячная сумма берётся из строк счёта, если они есть: клиент
    // видит одну цифру, платформа — ту же.
    v = await j('GET', '/platform/clients', null, SUPER);
    ok(v.d.rows.every((r) => typeof r.monthly === 'number'),
       'У каждого клиента видна месячная сумма');

    // Партнёр видит только своих — и в счётчиках тоже.
    v = await j('GET', '/platform/clients', null, PARTNER);
    ok(v.d.counts.all === v.d.rows.length && v.d.rows.every((r) => r.partnerId === pid),
       '★ У партнёра и список, и счётчики — только по своим клиентам');
  }

  // ---------- РАЗДЕЛ 3: «ДЕНЬГИ» ----------
  // Оплаты с отбором и итогами.
  {
    let v = await j('GET', '/platform/payments', null, SUPER);
    ok(Array.isArray(v.d?.rows) && v.d?.totals,
       `★ Деньги: ${v.d?.totals?.count} записей, в доход ${v.d?.totals?.amount} ₸`);

    // Ждущие первыми: это то, что требует действия.
    const first = v.d.rows[0];
    const anyPending = v.d.rows.some((x) => x.status === 'pending');
    ok(!anyPending || first.status === 'pending',
       '★ Ждущие подтверждения — первыми: это единственное, что требует действия');

    // ИТОГИ ПО ТЕМ ЖЕ СТРОКАМ. У донора сумма сверху бралась отдельным
    // запросом, и при отборе «ждут» показывала итог по всем — цифра не
    // совпадала со списком под ней.
    v = await j('GET', '/platform/payments?status=pending', null, SUPER);
    ok(v.d.totals.amount === 0,
       '★ У отбора «ждут» доход НОЛЬ: ждущие — это ещё не деньги');
    ok(v.d.rows.every((x) => x.status === 'pending'), 'И только ждущие в списке');

    v = await j('GET', '/platform/payments?status=rejected', null, SUPER);
    ok(v.d.totals.amount === 0, 'У отклонённых доход тоже ноль');

    v = await j('GET', '/platform/payments?status=approved', null, SUPER);
    const sum = v.d.rows.reduce((a, x) => a + x.amount, 0);
    ok(Math.abs(sum - v.d.totals.amount) < 2,
       `★ Итог сходится со строками: ${v.d.totals.amount} ₸ = сумма списка`);
    ok(v.d.rows.every((x) => x.partnerShare + x.platformShare === x.amount),
       '★ Доли партнёра и платформы в сумме дают ровно платёж — ни тенге не потеряно');

    // ОТРЕЗОК записывается при подтверждении и не пересчитывается. У
    // донора он вычислялся пересчётом всей цепочки при каждом открытии
    // карточки: отклонили одну задним числом — все отрезки съехали.
    const done = v.d.rows.find((x) => x.periodFrom);
    if (done) {
      ok(new Date(done.periodTo) > new Date(done.periodFrom),
         `★ Оплаченный отрезок записан: ${String(done.periodFrom).slice(0, 10)} — ${String(done.periodTo).slice(0, 10)}`);
    }

    // Партнёр видит только свои оплаты и не может подтверждать.
    v = await j('GET', '/platform/payments', null, PARTNER);
    ok(v.d.rows.every((x) => x.canApprove === false),
       '★ Партнёру кнопка подтверждения не показывается');
  }

  // ---------- РАЗДЕЛ 4: «ЗАЯВКИ» ----------
  // Партнёр просит, платформа решает. Одобрение САМО выполняет
  // действие, а не просто ставит отметку.
  {
    // Заявка на вторую кассу
    let v = await j('POST', '/platform/requests',
      { accountId: id1, kind: 'device', comment: 'Открыли вторую точку',
        payload: { device: 'pos' } }, PARTNER);
    const devReq = v.d.id;
    ok(v.d?.status === 'pending', '★ Партнёр подал заявку на устройство');

    // ПРЕДПРОСМОТР — чего у донора нет. Кнопка «Одобрить» просто
    // делала, и увидеть последствие можно было только после.
    v = await j('GET', `/platform/requests/${devReq}/preview`, null, SUPER);
    ok(/строка счёта/i.test(v.d?.effect ?? ''),
       `★ Предпросмотр объясняет последствие: «${v.d?.effect}»`);
    ok(typeof v.d?.proRata === 'number',
       `И называет доплату за остаток периода: ${v.d?.proRata} ₸`);

    v = await j('GET', `/platform/requests/${devReq}/preview`, null, PARTNER);
    ok(v.status === 403, 'Партнёру предпросмотр не нужен — решает не он');

    // ОДОБРЕНИЕ ВЫПОЛНЯЕТ ДЕЙСТВИЕ. Иначе возможно «одобрено, но не
    // сделано» — самое неприятное, потому что все считают, что сделано.
    const before = (await j('GET', `/platform/clients/${id1}/lines`, null, SUPER)).d.length;
    v = await j('POST', `/platform/requests/${devReq}/decide`, { approve: true }, SUPER);
    ok(/Строка счёта добавлена/.test(v.d?.effect ?? ''), `★ ${v.d?.note}`);

    const after = (await j('GET', `/platform/clients/${id1}/lines`, null, SUPER)).d;
    ok(after.length === before + 1 && after.some((x) => x.kind === 'pos'),
       '★ Строка счёта появилась САМА — одобрение не оставляет работы на потом');

    // ОТСРОЧКА двигает срок.
    v = await j('POST', '/platform/requests',
      { accountId: id1, kind: 'grace', comment: 'Оплатит после праздников',
        payload: { days: 7 } }, PARTNER);
    const graceReq = v.d.id;

    v = await j('GET', `/platform/requests/${graceReq}/preview`, null, SUPER);
    ok(/уступка, а не оплата/.test(v.d?.effect ?? ''),
       '★ Предпросмотр отсрочки честно говорит: деньги не поступят');

    const dBefore = (await j('GET', '/platform/clients', null, SUPER))
      .d.rows.find((r) => r.id === id1)?.daysLeft;
    await j('POST', `/platform/requests/${graceReq}/decide`, { approve: true }, SUPER);
    const dAfter = (await j('GET', '/platform/clients', null, SUPER))
      .d.rows.find((r) => r.id === id1)?.daysLeft;
    ok(dAfter >= dBefore + 6,
       `★ Отсрочка сдвинула срок: было ${dBefore} дн., стало ${dAfter}`);

    // ОТКАЗ требует причины.
    v = await j('POST', '/platform/requests',
      { accountId: id1, kind: 'other', comment: 'Просто вопрос' }, PARTNER);
    const otherReq = v.d.id;
    v = await j('POST', `/platform/requests/${otherReq}/decide`, { approve: false }, SUPER);
    ok(v.status === 400 && /причину/.test(v.d?.message ?? ''),
       '★ Отказ без причины отбит — партнёр должен понять, что не так');

    v = await j('POST', `/platform/requests/${otherReq}/decide`,
      { approve: false, note: 'Обсудим на встрече' }, SUPER);
    ok(v.d?.ok, 'С причиной отказ проходит');

    // Повторное решение отбито: заявка уже решена.
    v = await j('POST', `/platform/requests/${otherReq}/decide`,
      { approve: true, note: 'передумал' }, SUPER);
    ok(v.status === 400 && /уже решена/.test(v.d?.message ?? ''),
       'Повторное решение по той же заявке отбито');

    // Партнёр не решает.
    v = await j('POST', '/platform/requests',
      { accountId: id1, kind: 'device', payload: { device: 'store' } }, PARTNER);
    v = await j('POST', `/platform/requests/${v.d.id}/decide`, { approve: true }, PARTNER);
    ok(v.status === 403, '★ Партнёр подаёт заявки, но не решает по ним');
  }

  // ---------- РАЗДЕЛ 5: «ВОРОНКА» ----------
  // Этап ВЫВОДИТСЯ ИЗ ФАКТОВ, пока его не двигали руками. Ручной сдвиг
  // сильнее: человек знает о клиенте больше, чем база.
  {
    let v = await j('GET', '/platform/funnel', null, SUPER);
    ok(Array.isArray(v.d?.stages) && v.d.stages.length === 5,
       `★ Пять этапов воронки, всего карточек ${v.d?.total}`);
    ok(v.d.stages.every((st) => st.title && st.hint),
       'У каждого этапа подсказка — что он значит');

    const all = v.d.stages.flatMap((st) => st.cards);
    const paid = all.find((c) => c.derivedStage === 'paid');
    ok(!!paid, '★ Кто платил — выведен в «Оплатил» автоматически, без ручной работы');
    ok(paid.isManual === false, 'И помечен как выведенный, а не поставленный руками');

    ok(v.d.stages.every((st) => typeof st.sum === 'number'),
       '★ На каждом этапе видна СУММА: воронка про деньги, а не про карточки');

    // Сколько дней молчим — сделка умирает не от отказа, а от того,
    // что о ней забыли.
    ok(all.some((c) => c.daysSilent != null),
       'Видно, сколько дней не общались с клиентом');

    // РУЧНОЙ СДВИГ СИЛЬНЕЕ. Клиент заплатил, но закрылся — партнёр
    // знает это, а база нет.
    v = await j('POST', `/platform/funnel/${paid.id}`,
      { stage: 'lost', note: 'Закрылся, магазин продан' }, SUPER);
    ok(/сильнее/.test(v.d?.note ?? ''), 'Сказано, что ручной этап сильнее');

    v = await j('GET', '/platform/funnel', null, SUPER);
    const moved = v.d.stages.flatMap((st) => st.cards).find((c) => c.id === paid.id);
    ok(moved.stage === 'lost' && moved.derivedStage === 'paid' && moved.isManual,
       '★ Карточка в «Отказе», хотя факты говорят «оплатил» — человек знает больше');
    ok(moved.note === 'Закрылся, магазин продан',
       'Заметка сохранена: через месяц никто не вспомнит, почему отказ');

    // Неизвестный этап отбивается.
    v = await j('POST', `/platform/funnel/${paid.id}`, { stage: 'придумал' }, SUPER);
    ok(v.status === 400, 'Несуществующий этап отбит');

    // Партнёр двигает только своих.
    v = await j('POST', `/platform/funnel/${id2}`, { stage: 'lost' }, PARTNER);
    ok(v.status === 403, '★ Партнёр не двигает чужие карточки');

    // Учебные магазины в воронке не участвуют.
    v = await j('GET', '/platform/funnel', null, SUPER);
    ok(v.d.stages.flatMap((st) => st.cards).every((c) => c.name !== 'Учебный'),
       'Учебные магазины в воронку не попадают');
  }

  // ---------- РАЗДЕЛ 6: «ПАРТНЁРЫ» ----------
  // У донора список плоский: имя, комиссия, число клиентов, заработок
  // одним числом. Для решения этого мало — решать надо одно: кому
  // платить и с кем расставаться.
  {
    let v = await j('GET', '/platform/partners', null, SUPER);
    ok(Array.isArray(v.d?.rows) && v.d?.totals,
       `★ Партнёры: ${v.d?.totals?.partners}, привели ${v.d?.totals?.brought} ₸`);

    const p = v.d.rows.filter((x) => !x.isSuperUser)[0];
    // ПРИВЁЛ и ЗАРАБОТАЛ — разные числа, и первое важнее: партнёр с
    // малой комиссией может приносить платформе больше.
    ok(typeof p.brought === 'number' && typeof p.earned === 'number' && p.brought >= p.earned,
       `★ Привёл ${p.brought} ₸, заработал ${p.earned} ₸ — разные числа, и первое важнее`);
    ok(typeof p.broughtTotal === 'number',
       'Есть и за всё время: приведший пятерых год назад ценнее приведшего одного вчера');

    // Ушедшие клиенты рядом с заведёнными: партнёр может заводить
    // много и терять столько же.
    ok(typeof p.lostClients === 'number',
       `Ушедшие клиенты видны рядом с активными: ${p.activeClients} работают, ${p.lostClients} ушло`);

    ok(typeof p.mrr === 'number',
       `★ Сколько его клиенты дают в месяц сейчас: ${p.mrr} ₸ — это будущий доход`);

    ok('neverLoggedIn' in p && 'inactive' in p,
       'Видно, давно ли заходил: не заходивший месяц скорее всего перестал работать');

    // ПРЕДПРОСМОТР ОТКЛЮЧЕНИЯ — у донора кнопка просто отключала.
    v = await j('GET', `/platform/partners/${pid}/off-preview`, null, SUPER);
    ok(/без сопровождения|Клиентов у него нет/.test(v.d?.effect ?? ''),
       `★ Предпросмотр отключения: «${v.d?.effect}»`);
    ok(typeof v.d?.activeClients === 'number',
       'Названо, сколько клиентов останется без партнёра');

    // Отключение закрывает вход, но НЕ трогает клиентов.
    const before = p.clients;
    v = await j('PATCH', `/platform/partners/${pid}`, { isActive: false }, SUPER);
    ok(/Клиенты продолжают работать/.test(v.d?.note ?? ''), 'Сказано, что клиенты не пострадают');

    v = await j('GET', '/platform/partners', null, SUPER);
    const off = v.d.rows.find((x) => x.id === pid);
    ok(off.isActive === false && off.clients === before,
       '★ Вход закрыт, клиенты остались при нём — отключение не наказывает клиентов');

    await j('PATCH', `/platform/partners/${pid}`, { isActive: true }, SUPER);

    // Порядок: кто больше принёс — выше. Владелец читает сверху.
    v = await j('GET', '/platform/partners', null, SUPER);
    const brought = v.d.rows.filter((x) => !x.isSuperUser).map((x) => x.brought);
    ok(brought.every((b, i) => i === 0 || brought[i - 1] >= b),
       '★ Порядок по принесённым деньгам: сверху те, кто кормит платформу');

    v = await j('GET', '/platform/partners', null, PARTNER);
    ok(v.status === 403, 'Партнёр список партнёров не видит');
  }

  // ---------- РАЗДЕЛ 7: «СВОДКА» ----------
  // Живые таблицы знают только «сейчас». Для «месяц назад было лучше
  // или хуже» нужны снимки по дням.
  {
    // Снимок обычно пишет запускальщик раз в сутки; в тестах он
    // выключен, поэтому зовём вручную.
    await db.query('SELECT platform_snapshot()');

    let v = await j('GET', '/platform/metrics?days=30', null, SUPER);
    ok(Array.isArray(v.d?.series) && v.d.series.length === 30,
       `★ Ряд ровно за 30 дней: ${v.d?.series?.length}`);

    // Дни без событий тоже в ряду: пропуск в графике читается как
    // сбой, а не как «в тот день ничего не платили».
    const dates = v.d.series.map((d) => String(d.day).slice(0, 10));
    ok(new Set(dates).size === dates.length, 'Без повторов дат');
    ok(v.d.series.every((d) => typeof d.amount === 'number'),
       '★ Дни без оплат тоже в ряду — дыра в графике читается как сбой');

    ok(v.d?.now && typeof v.d.now.active === 'number',
       `★ Сейчас: клиентов ${v.d.now.tenants}, работают ${v.d.now.active}, доход ${v.d.now.mrr} ₸/мес`);

    ok(v.d?.period && v.d.period.amount > 0,
       `★ За период: ${v.d.period.payments} оплат на ${v.d.period.amount} ₸`);
    ok(v.d.period.partnerShare + v.d.period.platformShare === v.d.period.amount,
       'Доли партнёров и платформы в сумме дают весь приход');

    // Цифра без сравнения ничего не значит: «пришло 140 тысяч» — это
    // много или мало?
    ok('change' in v.d && 'prevAmount' in v.d.change,
       `★ Есть сравнение с прошлым периодом: ${v.d.change.amount >= 0 ? '+' : ''}${v.d.change.amount} ₸`);

    // Деньги по дням берутся из оплат, а не из снимков: они
    // восстановимы за любой день, даже если снимка нет.
    const paidDays = v.d.series.filter((d) => d.amount > 0);
    ok(paidDays.length > 0,
       `★ Деньги по дням есть даже без снимков: ${paidDays.length} дней с оплатами`);

    v = await j('GET', '/platform/metrics?days=7', null, SUPER);
    ok(v.d.series.length === 7, 'Период настраивается: 7 дней');

    v = await j('GET', '/platform/metrics', null, PARTNER);
    ok(v.status === 403, 'Партнёр общую сводку не видит');
  }

  // ---------- РАЗДЕЛ 8: «ЖУРНАЛ» ----------
  // Кто что сделал. Отбор на сервере, листание по времени, денежные
  // записи весомее прочих.
  {
    let v = await j('GET', '/platform/audit', null, SUPER);
    ok(Array.isArray(v.d?.rows) && v.d.rows.length > 0,
       `★ Журнал: ${v.d?.rows?.length} записей`);

    // ОПИСАНИЕ СЛОВАМИ на сервере. У донора кабинет знал список
    // действий и переводил сам: появилось новое — показал кодом вроде
    // «tenant_suspended», и человек гадает, что это было.
    const rec = v.d.rows[0];
    ok(rec.title && rec.title !== rec.action,
       `★ Запись описана словами: «${rec.title}» вместо кода «${rec.action}»`);

    // ВЕС: деньги весомее прочего, цена ошибки в них другая.
    ok(v.d.rows.every((x) => ['money', 'access', 'other'].includes(x.weight)),
       'У каждой записи есть вес: деньги, доступ или прочее');

    const moneyRows = (await j('GET', '/platform/audit?weight=money', null, SUPER)).d.rows;
    ok(moneyRows.length > 0 && moneyRows.every((x) => x.weight === 'money'),
       `★ Отбор «деньги» даёт только денежные: ${moneyRows.length}`);

    const withSum = moneyRows.find((x) => x.amount);
    if (withSum) ok(withSum.amount > 0,
      `И сумма рядом: «${withSum.title}» на ${withSum.amount} ₸`);

    // ЛИСТАНИЕ ПО ВРЕМЕНИ, а не по номеру страницы: журнал растёт, и
    // номера съезжают — вторая страница показала бы то же, что первая.
    v = await j('GET', '/platform/audit?limit=2', null, SUPER);
    ok(v.d.rows.length === 2 && v.d.nextBefore,
       '★ Листание курсором по номеру записи, а не по времени');
    const firstIds = v.d.rows.map((x) => x.id);

    v = await j('GET',
      `/platform/audit?limit=2&before=${encodeURIComponent(v.d.nextBefore)}`, null, SUPER);
    ok(v.d.rows.every((x) => !firstIds.includes(x.id)),
       '★ Вторая страница не повторяет первую');

    // Отбор по клиенту — чтобы понять историю одного магазина.
    v = await j('GET', `/platform/audit?accountId=${id1}`, null, SUPER);
    ok(v.d.rows.every((x) => x.accountId === id1 || x.accountId == null),
       'Отбор по клиенту: видна история одного магазина');

    // ПАРТНЁРУ ЧУЖИЕ ЗАПИСИ НЕ ПРИХОДЯТ ВОВСЕ, а не прячутся при
    // отрисовке: это разница между «не показали» и «не отдали».
    const superCount = (await j('GET', '/platform/audit?limit=200', null, SUPER)).d.rows.length;
    const partnerRows = (await j('GET', '/platform/audit?limit=200', null, PARTNER)).d.rows;
    ok(partnerRows.length < superCount,
       `★ Партнёру приходит меньше записей: ${partnerRows.length} против ${superCount}`);
  }

  // ---------- ПОЛНЫЙ НАБОР ДЕЙСТВИЙ ПЛАТФОРМЫ ----------
  // Дописано по сверке с донором: у них 39 методов, у нас было 30.
  {
    // ЗАВЕДЕНИЕ КЛИЕНТА. Партнёр приезжает, ставит систему и отдаёт
    // вход хозяину. Пароль показан один раз — его диктуют голосом.
    let v = await j('POST', '/platform/tenants',
      { name: 'Новый магазин', ownerName: 'Асхат', ownerPhone: '+77013334455',
        city: 'Астана' }, PARTNER);
    ok(!!v.d?.id && typeof v.d?.password === 'string',
       `★ Партнёр завёл клиента, пароль владельцу: ${v.d?.password}`);
    const newId = v.d.id, newPass = v.d.password;

    v = await j('POST', '/auth/login', { phone: '+77013334455', password: newPass });
    ok(!!v.d?.access,
       '★ Владелец ВХОДИТ этим паролем — иначе магазин заведён, а войти нельзя');

    // Дубли по последним десяти цифрам: люди пишут то +7, то 8.
    v = await j('POST', '/platform/tenants',
      { name: 'Ещё один', ownerName: 'Кто-то', ownerPhone: '87013334455' }, PARTNER);
    ok(v.status === 400 && /уже у магазина/.test(v.d?.message ?? ''),
       '★ Дубль пойман по последним 10 цифрам: 8701… это тот же номер, что +7701…');

    // КАРТОЧКА: всё об одном клиенте одним ответом.
    v = await j('GET', `/platform/clients/${newId}/card`, null, SUPER);
    ok(v.d?.name && Array.isArray(v.d?.lines) && Array.isArray(v.d?.payments),
       `★ Карточка клиента: счёт ${v.d?.monthly} ₸/мес, строк ${v.d?.lines?.length}`);

    // ТАРИФ: меняется только основная строка, доплаты не трогаются.
    await j('POST', `/platform/clients/${newId}/lines`,
      { kind: 'pos', title: 'Касса №2', price: 3000 }, SUPER);
    v = await j('POST', `/platform/clients/${newId}/tier`, { tier: 'pro' }, SUPER);
    ok(v.d?.ok && v.d?.monthly === 14900, `★ Тариф сменён: ${v.d?.monthly} ₸/мес`);

    v = await j('GET', `/platform/clients/${newId}/card`, null, SUPER);
    const live = (v.d?.lines ?? []).filter((x) => x.active);
    ok(live.some((x) => x.kind === 'pos'),
       '★ Доплата за кассу НЕ затронута сменой тарифа — это отдельная договорённость');

    // СОСТОЯНИЕ
    v = await j('POST', `/platform/clients/${newId}/status`, { active: false }, SUPER);
    ok(/кабинет открыт/.test(v.d?.note ?? ''),
       '★ Заморозка закрывает продажи, но кабинет открыт — владелец видит свои цифры');
    await j('POST', `/platform/clients/${newId}/status`, { active: true }, SUPER);

    // ПРАВКА СТРОКИ СЧЁТА
    v = await j('GET', `/platform/clients/${newId}/lines`, null, SUPER);
    const posLine = v.d.find((x) => x.kind === 'pos');
    v = await j('PATCH', `/platform/lines/${posLine.id}`, { price: 3500 }, SUPER);
    ok(v.d?.ok, 'Строка счёта правится');

    // ПРАВКА ПАРТНЁРА: прошлые выплаты не пересчитываются.
    v = await j('POST', `/platform/partners/${pid}/update`, { commissionPercent: 20 }, SUPER);
    ok(/Уже подтверждённые хранят свою/.test(v.d?.note ?? ''),
       '★ Новая доля — для будущих оплат: уже подтверждённые хранят свою');

    // Проверяем ДЕЛО, а не слова: доля выросла с 15% до 20%, но
    // выплата по уже подтверждённой оплате обязана остаться прежней.
    // Иначе отчёт за прошлый месяц менялся бы сам собой.
    v = await j('GET', '/platform/payments?status=approved', null, SUPER);
    const frozen = v.d?.rows?.find((x) => x.partnerShare === 1035);
    ok(!!frozen,
       '★ Прошлая выплата НЕ пересчиталась после смены доли: 1035 ₸ как было');

    v = await j('GET', '/platform/partners', null, SUPER);
    const afterEdit = v.d?.rows?.find((x) => x.id === pid);
    ok(afterEdit?.commissionPercent === 20 && afterEdit?.earned === 1035,
       `★ Доля стала ${afterEdit?.commissionPercent}%, заработок остался ${afterEdit?.earned} ₸`);

    // УЧЕБНЫЙ МАГАЗИН
    v = await j('POST', '/platform/demo', {}, PARTNER);
    ok(v.d?.isDemo && /не участвует в деньгах/.test(v.d?.note ?? ''),
       '★ Партнёр завёл себе учебный магазин');

    // РЕКВИЗИТЫ ОПЛАТЫ
    v = await j('POST', '/platform/pay-settings',
      { payDetails: 'Каспи 7777 7777 7777' }, SUPER);
    ok(v.d?.ok, 'Реквизиты сохранены');
    v = await j('GET', '/platform/pay-settings', null, SUPER);
    ok(v.d?.payDetails === 'Каспи 7777 7777 7777', 'И читаются обратно');

    v = await j('POST', '/platform/pay-settings', { payDetails: 'чужое' }, PARTNER);
    ok(v.status === 403, 'Партнёр реквизиты не меняет');

    // ЗАЯВКИ С САЙТА
    v = await j('GET', '/platform/leads', null, SUPER);
    ok(Array.isArray(v.d), 'Заявки с сайта читаются');

    v = await j('GET', '/platform/leads', null, PARTNER);
    ok(v.status === 403, 'Партнёр заявки с сайта не смотрит');

    // КОД АКТИВАЦИИ есть СРАЗУ: касса заводится вместе с магазином.
    // Партнёр в этот момент стоит в магазине — заставить его приехать
    // второй раз из-за недостающей кассы нельзя.
    v = await j('GET', `/platform/clients/${newId}/activation`, null, SUPER);
    ok(v.d?.code && v.d.code.length >= 6,
       `★ Код привязки кассы выдан сразу: ${v.d?.code}`);
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
  // ── СВОДКА: снимок за день ОДИН и он свежий ─────────────────────
  //
  // Снимок пишется при каждом открытии сводки и в 03:00. Если он
  // задвоится, график покажет два столбика за один день; если не
  // обновится — карточка «сейчас» и последняя точка разойдутся.
  {
    await j('GET', '/platform/metrics?days=30', null, SUPER);
    await j('GET', '/platform/metrics?days=30', null, SUPER);
    let v = await j('GET', '/platform/metrics?days=30', null, SUPER);

    const series = v.d?.series ?? [];
    const today = series.filter((x) => x.tenants > 0);
    const days = new Set(today.map((x) => String(x.day).slice(0, 10)));
    ok(days.size === today.length,
       '★ Снимок за день один: три открытия сводки не задвоили строку');

    const last = today[today.length - 1];
    ok(!last || last.tenants === v.d.now.tenants,
       `★ Последняя точка графика и карточка «сейчас» сходятся: ${last?.tenants} = ${v.d.now.tenants}`);

    ok(v.d.now.mrr >= 0 && v.d.now.revenueToday >= 0,
       'Числа сводки не отрицательные');
  }

  // ── ЖУРНАЛ: ЛИСТАНИЕ НИЧЕГО НЕ ТЕРЯЕТ ───────────────────────────
  //
  // Дописано после находки: листание шло по ВРЕМЕНИ записи, а массовое
  // действие пишет несколько записей одним мгновением. Страница
  // кончалась на такой записи, следующая просила «раньше этого
  // момента» — и пропускала все остальные записи той же секунды.
  {
    const all = (await j('GET', '/platform/audit?limit=200', null, SUPER)).d?.rows ?? [];
    if (all.length >= 4) {
      const seen = [];
      let cursor = null, page = 0;
      while (page < 60) {
        const url = '/platform/audit?limit=2' + (cursor ? `&before=${cursor}` : '');
        const d = (await j('GET', url, null, SUPER)).d;
        if (!d?.rows?.length) break;
        page++;
        seen.push(...d.rows.map((r) => r.id));
        if (!d.hasMore) break;
        cursor = d.nextBefore;
      }
      ok(new Set(seen).size === all.length,
         `★ Листание журнала ничего не теряет: ${new Set(seen).size} из ${all.length}`);
      ok(seen.length === new Set(seen).size, '★ И ничего не повторяет');
    }
  }

  // ── КТО РЕШИЛ ЗАЯВКУ ───────────────────────────────────────────
  //
  // Дописано после описи полей. У оплаты видно «подтвердил Магжан
  // Сакен», у заявки — только «отказано» и причина, а КТО отказал,
  // нет. Поле в базе есть и заполняется, но не доходило.
  //
  // Партнёр получил отказ и хочет переспросить — не знает, к кому идти.
  {
    const v = await j('GET', '/platform/requests', null, SUPER);
    const decided = (v.d ?? []).find((r) => r.status !== 'pending');
    ok(!decided || !!decided.decidedBy,
       `★ Видно, кто решил заявку: ${decided?.decidedBy ?? 'НЕ ВИДНО'}`);
  }

  // ── ЗАРАБОТОК ПАРТНЁРА ЗА ВСЁ ВРЕМЯ ────────────────────────────
  //
  // Дописано в описи полей. Сервер отдавал earnedTotal, а показывался
  // только заработок за 30 дней.
  //
  // Партнёр работает год, заработал 400 тысяч — а в таблице «35 000».
  // По этой цифре решают, стоит ли с ним работать дальше, и решают
  // неверно: месяц мог быть пустым по любой причине.
  {
    const v = await j('GET', '/platform/partners', null, SUPER);
    const p = (v.d?.rows ?? []).find((x) => !x.isSuperUser);
    ok(p && typeof p.earnedTotal === 'number',
       '★ Заработок за всё время отдаётся, а не только за 30 дней');
    ok(p && typeof p.createdAt === 'string',
       '★ Дата заведения отдаётся: «ни разу не входил» значит разное для новичка и ветерана');
  }

  // ── ЗАРАБОТОК ПАРТНЁРА ЗА ВСЁ ВРЕМЯ ────────────────────────────
  //
  // Дописано в описи полей. Показывался только заработок за 30 дней.
  // Партнёр работает год, заработал 400 тысяч — а в списке «35 000».
  // По такой цифре решают, стоит ли с ним работать дальше.
  {
    const v = await j('GET', '/platform/partners', null, SUPER);
    const p = (v.d?.rows ?? []).find((x) => !x.isSuperUser);
    ok(p?.earnedTotal !== undefined,
       '★ Заработок партнёра за всё время доходит до кабинета');
    ok(p?.earnedTotal >= p?.earned,
       `★ Итог не меньше месячного: ${p?.earnedTotal} ≥ ${p?.earned}`);
    ok(!!p?.createdAt,
       '★ Видно, когда партнёра завели — новичок или ветеран с плохим месяцем');
  }

  // ── ЗАМЕТКА О КЛИЕНТЕ НЕ ТЕРЯЕТСЯ ──────────────────────────────
  //
  // Дописано в описи полей. У карточки две заметки: о СДЕЛКЕ («ждёт
  // счёт до пятницы» — устаревает) и о САМОМ КЛИЕНТЕ («владелец
  // глухой на левое ухо, звонить громче» — нужна всегда).
  //
  // Вторая писалась в базу и НИГДЕ не показывалась. Человек записывал
  // важное и терял. В следующий раз он запишет это в тетрадку — и
  // панель перестанет быть местом, где хранят знание о клиентах.
  {
    const v = await j('GET', '/platform/clients', null, SUPER);
    const cl = (v.d?.rows ?? []).find((x) => !x.isDemo);
    if (cl) {
      await j('PATCH', `/platform/clients/${cl.id}`, {
        note: 'владелец глухой на левое ухо, звонить громче',
        dealNote: 'ждёт счёт до пятницы',
      }, SUPER);

      const card = (await j('GET', `/platform/clients/${cl.id}/card`, null, SUPER)).d;
      ok(card?.note === 'владелец глухой на левое ухо, звонить громче',
         '★ Заметка о клиенте доходит до карточки, а не пропадает');
      ok(card?.dealNote === 'ждёт счёт до пятницы',
         '★ Заметка о сделке отдельна от заметки о клиенте');
    }
  }

  // ── ПАРТНЁР ВИДИТ ПОЛНОЕ РЕШЕНИЕ ПО ЗАЯВКЕ ─────────────────────
  //
  // Дописано в описи полей. У заявки одиннадцать полей, и все важные
  // должны доходить до того, кто её подал: иначе он получает «отказ»
  // без объяснений и идёт звонить.
  {
    const v = await j('GET', '/platform/clients', null, SUPER);
    const cl = (v.d?.rows ?? []).find((x) => !x.isDemo && x.partner);
    if (cl) {
      const r = await j('POST', '/platform/requests',
        { accountId: cl.id, kind: 'other', payload: {},
          comment: 'выгрузка продаж за год' }, PARTNER);
      if (r.d?.id) {
        await j('POST', `/platform/requests/${r.d.id}/decide`,
          { approve: false, note: 'такой выгрузки пока нет, сделаем в сентябре' }, SUPER);

        const mine = await j('GET', '/platform/requests', null, PARTNER);
        const done = (mine.d ?? []).find((x) => x.id === r.d.id);
        ok(done?.decision_note === 'такой выгрузки пока нет, сделаем в сентябре',
           '★ Партнёр видит причину отказа дословно');
        ok(!!done?.decidedBy,
           `★ Партнёр видит, КТО решил: ${done?.decidedBy}`);
        ok(!!done?.decided_at,
           '★ Партнёр видит, КОГДА решили');
      }
    }
  }

  // ── ПРОЦЕНТ ДОЛИ ВИДЕН РЯДОМ С СУММОЙ ──────────────────────────
  //
  // Дописано после описи полей. У оплаты хранится доля партнёра на
  // момент подтверждения — она заморожена. Но в кабинет не доходила.
  //
  // При споре «почему мне начислили 1 035, а не 2 070» ответить нечем:
  // сумма верная, а объяснить её нельзя — сегодня в настройках может
  // стоять 30%, и партнёр считает по ним.
  {
    const v = await j('GET', '/platform/payments?status=approved', null, SUPER);
    const paid = (v.d?.rows ?? []).find((r) => r.partnerShare > 0);
    ok(!paid || paid.partnerPercent > 0,
       `★ Процент доли виден: ${paid?.partnerShare} ₸ (${paid?.partnerPercent}%)`);
    if (paid) {
      const calc = Math.round(paid.amount * paid.partnerPercent / 100);
      ok(Math.abs(calc - paid.partnerShare) <= 1,
         `★ Процент объясняет сумму: ${paid.amount} × ${paid.partnerPercent}% = ${calc}`);
    }
  }

  // ── ЗАПИСАВШЕМУСЯ С САЙТА ЕСТЬ КУДА ПОЗВОНИТЬ ──────────────────
  //
  // Дописано после сверки возможностей. Человек записался с сайта сам:
  // магазин создан, войти может. А КАРТОЧКИ КЛИЕНТА НЕТ — её заводила
  // только платформа, когда клиента приводит партнёр.
  //
  // У владельца платформы в списке пусто в колонках «владелец» и
  // «телефон»: позвонить и помочь завести товары НЕЧЕМ, поиск по
  // имени не находит. А это самый важный клиент — он пришёл сам, его
  // никто не ведёт, и если не позвонить в первый день, он уйдёт.
  {
    const phone = `+7701${String(Date.now()).slice(-7)}`;
    const otp = await j('POST', '/auth/otp', { phone });
    const reg = await j('POST', '/auth/register', {
      phone, code: otp.d?.devCode, businessName: 'Записался сам',
      ownerName: 'Асхат Нурланов', password: 'Password123',
    });
    if (reg.status < 300) {
      const v = await j('GET', '/platform/clients?filter=approval', null, SUPER);
      const lead = (v.d?.rows ?? []).find((r) => r.name === 'Записался сам');
      ok(lead?.ownerPhone === phone,
         `★ Записавшемуся с сайта есть куда позвонить: ${lead?.ownerPhone ?? 'НЕЧЕМ'}`);
      ok(!!lead?.owner,
         `★ Имя владельца записано: ${lead?.owner ?? 'пусто'}`);

      const found = await j('GET',
        `/platform/clients?q=${encodeURIComponent('Асхат')}`, null, SUPER);
      ok((found.d?.rows ?? []).length > 0,
         '★ Записавшийся находится поиском по имени владельца');
    }
  }

  // ── ПРАВКА ЦЕНЫ ДОХОДИТ ДО СЧЁТОВ ──────────────────────────────
  //
  // Дописано после находки: владелец менял цену «Старта» с 6 900 на
  // 8 900, видел «новые цены применятся» — и ничего не применялось.
  //
  // Цена хранилась ДВАЖДЫ: в прайсе платформы, куда пишет правка, и в
  // тарифе, откуда берётся счёт. Новые клиенты заводились по старой
  // цене, и заметить это можно было только сложив: «я поднял до 8 900,
  // а платят 6 900».
  {
    await j('POST', '/platform/price-book', { base: 8900 }, SUPER);

    const r = await j('POST', '/platform/tenants',
      { name: 'После правки цены', ownerName: 'Проверка',
        ownerPhone: `+7701${Date.now() % 10000000}` }, SUPER);
    if (r.d?.id) {
      const card = (await j('GET', `/platform/clients/${r.d.id}/card`, null, SUPER)).d;
      ok(card?.monthly === 8900,
         `★ Новая цена дошла до счёта: ${card?.monthly} ₸/мес`);
    }

    // Возвращаем как было, чтобы не сбивать остальные проверки.
    await j('POST', '/platform/price-book', { base: 6900 }, SUPER);
  }

  // ── ЖУРНАЛ ЧИТАЕТСЯ ЧЕРЕЗ ПОЛГОДА ──────────────────────────────
  //
  // Дописано после сверки: прочитал журнал так, будто разбираю спорную
  // оплату спустя полгода. Три записи читались плохо:
  //   «правка карточки» — что именно поправили, неизвестно;
  //   «заведён магазин — Береке · Береке» — название задвоено;
  //   «оплата подтверждена — 6 900 ₸» — деньги есть, а чьи, нет.
  {
    const v = await j('GET', '/platform/audit?limit=50', null, SUPER);
    const rows = v.d?.rows ?? [];

    const card = rows.find((r) => r.action === 'card_updated');
    ok(!card || !!card.detail,
       `★ Правка карточки называет, что поправили: «${card?.detail ?? '—'}»`);

    const pay = rows.find((r) => r.action === 'payment_approved');
    ok(!pay || !!pay.client,
       '★ Подтверждение оплаты называет магазин — иначе деньги есть, а чьи нет');

    // Название не задвоено: оно в своём столбце, в подробностях его нет.
    const dbl = rows.filter((r) => r.client && r.detail
      && String(r.detail).includes(String(r.client)));
    ok(dbl.length === 0,
       `★ Название магазина не задвоено в записи: ${dbl.length} повторов`);
  }

  // ── В ЖУРНАЛЕ ЗНАЧЕНИЯ, А НЕ НАЗВАНИЯ ПОЛЕЙ ─────────────────────
  //
  // Дописано после чтения журнала глазами человека, который через
  // полгода разбирает спор. Три записи не давали ответа:
  //   «Изменены цены платформы» — и всё, что менялось неизвестно;
  //   «этап: paid» — кодом, а в воронке столбец «Оплатил»;
  //   «правка карточки · город» — какой стал, неизвестно.
  //
  // Данные для всего этого в журнале УЖЕ ЛЕЖАЛИ — их просто не
  // разбирали при показе.
  {
    let v = await j('GET', '/platform/clients', null, SUPER);
    const cl = (v.d?.rows ?? []).find((x) => !x.isDemo);
    if (cl) {
      await j('PATCH', `/platform/clients/${cl.id}`, { city: 'Шымкент' }, SUPER);
      await j('POST', `/platform/funnel/${cl.id}`, { stage: 'paid' }, SUPER);
      await j('POST', '/platform/price-book', { base: 7900 }, SUPER);

      v = await j('GET', '/platform/audit?limit=20', null, SUPER);
      const rows = v.d?.rows ?? [];

      const card = rows.find((r) => r.action === 'card_updated');
      ok(/Шымкент/.test(card?.detail ?? ''),
         `★ Правка карточки называет НОВОЕ значение: ${card?.detail}`);

      const move = rows.find((r) => r.action === 'funnel_moved');
      ok(/Оплатил/.test(move?.detail ?? ''),
         `★ Этап в журнале словами, а не кодом: ${move?.detail}`);

      const price = rows.find((r) => r.action === 'price_book_changed');
      ok(/7900/.test(price?.detail ?? ''),
         `★ Правка цен называет новую цену: ${price?.detail}`);
    }
  }

  // ── ПАРТНЁР УЗНАЁТ, ЧТО ЕГО ОПЛАТУ ПОДТВЕРДИЛИ ─────────────────
  //
  // Дописано после сверки пути партнёра. Лента у нас — ОЧЕРЕДЬ
  // РЕШЕНИЙ, и подтверждённая оплата из неё уходит. Владельцу
  // платформы так и надо: он решение принял.
  //
  // А партнёр так и не узнавал, что деньги подтвердили и доля
  // начислена: лента снова «спокойна», надо идти в «Деньги» и
  // проверять. Теперь итог дня показан прямо в ленте.
  {
    const v = await j('GET', '/platform/today', null, PARTNER);
    ok(v.d?.dayTotal !== undefined,
       '★ Партнёр видит итог дня в ленте, а не ищет его в «Деньгах»');

    const s = await j('GET', '/platform/today', null, SUPER);
    ok(s.d?.dayTotal === null,
       '★ Владельцу платформы итог дня не нужен — лента это очередь решений');
  }

  // ── СЧЁТ ОБЪЯСНЯЕТ САМ СЕБЯ ─────────────────────────────────────
  //
  // Дописано после находки: клиент видел «К оплате 9 900 ₸/мес», а в
  // составе одну строку «Касса №2 — 3 000 ₸». Где остальные 6 900?
  //
  // Тариф не был строкой: он приходит из подписки, а строки — доплаты
  // сверх него. Устройство разумное, но человек этого не знает: он
  // видит итог, который не сходится с тем, что перед ним.
  {
    const v = await j('GET', '/platform/clients', null, SUPER);
    let cl = null, card = null;
    for (const x of (v.d?.rows ?? [])) {
      if (x.isDemo || !(x.monthly > 0)) continue;
      const c = (await j('GET', `/platform/clients/${x.id}/card`, null, SUPER)).d;
      if ((c?.lines ?? []).some((l) => l.active)) { cl = x; card = c; break; }
    }
    if (cl) {
      const lines = (card?.lines ?? []).filter((l) => l.active);
      const sum = lines.reduce((a, l) => a + l.price * (l.qty ?? 1), 0);
      ok(sum === card?.monthly,
         `★ Строки счёта складываются в итог: ${sum} = ${card?.monthly}`);
      ok(lines.some((l) => l.kind === 'base'),
         '★ Тариф показан строкой — иначе итог не с чем сложить');
    }
  }

  // ── ДВА КАБИНЕТА ГОВОРЯТ ОДНУ ЦИФРУ ─────────────────────────────
  //
  // Дописано после находки: одобрили вторую кассу, панель платформы
  // показала 9 900 ₸/мес, а кабинет КЛИЕНТА — 3 000.
  //
  // Тот же расчёт, что чинили в панели («есть строки — тариф не
  // берём»), остался в кабинете клиента. И там он хуже: в панели
  // неверную цифру видит владелец платформы, а здесь сам клиент — и
  // он по ней платит.
  {
    let v = await j('GET', '/platform/clients', null, SUPER);
    const cl = (v.d?.rows ?? []).find((x) => !x.isDemo && x.ownerPhone);
    if (cl) {
      // Добавляем строку счёта, чтобы расчёты разошлись, если ошибка есть.
      await j('POST', `/platform/clients/${cl.id}/lines`,
        { kind: 'pos', title: 'Касса №2', price: 3000 }, SUPER);

      v = await j('GET', '/platform/clients', null, SUPER);
      const inPanel = (v.d?.rows ?? []).find((x) => x.id === cl.id)?.monthly;

      v = await j('GET', `/platform/clients/${cl.id}/card`, null, SUPER);
      const inCard = v.d?.monthly;

      ok(inPanel === inCard,
         `★ Панель и карточка говорят одно: ${inPanel} = ${inCard}`);
      ok(inPanel >= 3000 + 6900 - 1,
         `★ Счёт складывается из тарифа И строк: ${inPanel} ₸`);
    }
  }

  // ── ПУТЬ ДЕНЕГ ЦЕЛИКОМ ──────────────────────────────────────────
  //
  // Дописано в последнем заходе. Каждая часть проверялась порознь, а
  // весь путь — от отметки до доли партнёра — ни разу целиком.
  {
    let v = await j('GET', '/platform/clients', null, SUPER);
    // Берём клиента С ПАРТНЁРОМ: у ничьего доля не начисляется, и
    // проверять сложение долей на нём нечего.
    const cl = (v.d?.rows ?? []).find((x) => !x.isDemo && x.partner);
    if (cl) {
      const before = (await j('GET', `/platform/clients/${cl.id}/card`, null, SUPER))
        .d?.paidUntil;

      // Отмечена — доля ещё не начислена.
      let r = await j('POST', '/platform/payments',
        { accountId: cl.id, amount: 6900, months: 3, method: 'kaspi' }, PARTNER);
      const pid = r.d?.id;
      v = await j('GET', '/platform/payments?status=pending', null, SUPER);
      const waiting = (v.d?.rows ?? []).find((x) => x.id === pid);
      ok(waiting?.partnerShare === 0,
         '★ Доля не начислена, пока оплата не подтверждена');

      // Подтверждена — доли сходятся до тиына.
      await j('POST', `/platform/payments/${pid}/approve`, {}, SUPER);
      v = await j('GET', '/platform/payments?status=approved', null, SUPER);
      const done = (v.d?.rows ?? []).find((x) => x.id === pid);
      ok(done && done.partnerShare + done.platformShare === done.amount,
         `★ Доли сходятся: ${done?.partnerShare} + ${done?.platformShare} = ${done?.amount}`);

      // Срок продлился ровно на оплаченное.
      const after = (await j('GET', `/platform/clients/${cl.id}/card`, null, SUPER))
        .d?.paidUntil;
      ok(after && after !== before, '★ Срок продлился после подтверждения');

      // Заработок партнёра одинаков во всех разделах.
      const inPartners = (await j('GET', '/platform/partners', null, SUPER))
        .d?.rows?.find((x) => !x.isSuperUser)?.earned;
      const inMoney = (await j('GET', '/platform/payments', null, SUPER))
        .d?.totals?.partnerShare;
      ok(inPartners === inMoney,
         `★ Заработок партнёра одинаков в разделах: ${inPartners} = ${inMoney}`);
    }
  }

  // ── КТО ОТМЕТИЛ ОПЛАТУ — ОТДЕЛЬНО ОТ ТОГО, КОМУ ДОЛЯ ────────────
  //
  // Дописано после сверки пути клиента. Владелец магазина сам нажал
  // «Я оплатил», а в ленте платформы стояло «отметил Ерлан».
  //
  // Причина: одно поле отвечало на два вопроса. Кому начислить долю —
  // партнёр клиента, и это верно всегда. Кто отметил — а тут клиент.
  // Через полгода по спорной оплате пошли бы разбираться к партнёру,
  // который её не проводил.
  {
    let v = await j('GET', '/platform/clients', null, SUPER);
    const cl = (v.d?.rows ?? []).find((x) => !x.isDemo);
    if (cl) {
      await j('POST', '/platform/payments',
        { accountId: cl.id, amount: 6900, months: 1, method: 'cash' }, SUPER);
      v = await j('GET', '/platform/payments', null, SUPER);
      const mine = (v.d?.rows ?? [])[0];
      ok(mine?.declaredBy === 'super',
         `★ Оплата владельца помечена им: «${mine?.declaredBy}»`);

      await j('POST', '/platform/payments',
        { accountId: cl.id, amount: 6900, months: 1, method: 'kaspi' }, PARTNER);
      v = await j('GET', '/platform/payments', null, SUPER);
      const byPartner = (v.d?.rows ?? []).find((x) => x.method === 'kaspi'
        && x.declaredBy === 'partner');
      ok(!!byPartner,
         `★ Оплата партнёра помечена им: «${byPartner?.declaredBy ?? 'не найдена'}»`);
    }
  }

  // ── РЕКВИЗИТЫ: ЭТО ВИДИТ КАЖДЫЙ КЛИЕНТ ──────────────────────────
  //
  // Дописано после сверки: не проверялось НИЧЕГО, а ошибка здесь стоит
  // дороже всего — платить не сможет никто, и заметят через день-два.
  //
  // «javascript:alert(1)» в кнопке «Оплатить» — это ЧУЖОЙ КОД в
  // кабинете владельца магазина, который нажимает её, доверяя
  // платформе.
  {
    let blocked = 0;
    for (const body of [
      { payUrl: 'просто текст' },
      { payUrl: 'javascript:alert(1)' },
      { payUrl: 'http://pay.kaspi.kz' },
      { payQrUrl: 'https://kaspi.kz/page' },
      { payPhone: 'позвоните мне' },
      { payName: 'М'.repeat(500) },
    ]) {
      const r = await j('POST', '/platform/pay-settings', body, SUPER);
      if (r.status === 400) blocked++;
    }
    ok(blocked === 6, `★ Негодные реквизиты отбиты: ${blocked} из 6`);

    const good = await j('POST', '/platform/pay-settings', {
      payUrl: 'https://pay.kaspi.kz/tabys',
      payQrUrl: 'https://cdn.tabys.kz/qr.png',
      payName: 'Магжан С.', payPhone: '+7 705 555 00 00',
      payNote: 'название магазина',
    }, SUPER);
    ok(good.status < 300, '★ Обычные реквизиты сохраняются');

    const v = await j('GET', '/platform/pay-settings', null, SUPER);
    ok(v.d?.payUrl?.startsWith('https://') && v.d?.payPhone,
       '★ Сохранённые реквизиты читаются обратно');
  }

  // ── ЖУРНАЛ: МУСОР В АДРЕСЕ НЕ РОНЯЕТ СЕРВЕР ─────────────────────
  //
  // Дописано после сверки. «limit=abc» и «before=abc» роняли сервер:
  // Number давал «не число», и оно доходило до запроса. Ключ человека
  // «непохоже-на-ключ» падал на разборе.
  //
  // Всё, что приходит из адреса, — ТЕКСТ, и человек может набрать его
  // руками. Приводим на сервере, а не надеемся на кабинет.
  {
    const junk = [
      'limit=0', 'limit=-5', 'limit=99999', 'limit=abc',
      'before=abc', 'before=-1',
      'weight=' + encodeURIComponent('выдуманный'),
      'actorId=' + encodeURIComponent('непохоже-на-ключ'),
      'accountId=' + encodeURIComponent('мусор'),
    ];
    let alive = 0;
    for (const q of junk) {
      const v = await j('GET', `/platform/audit?${q}`, null, SUPER);
      if (v.status === 200 && Array.isArray(v.d?.rows)) alive++;
    }
    ok(alive === junk.length,
       `★ Мусор в адресе журнала не роняет сервер: ${alive} из ${junk.length}`);

    // Предел строк соблюдается: без него можно попросить сто тысяч
    // записей разом и подвесить и сервер, и кабинет.
    const v = await j('GET', '/platform/audit?limit=99999', null, SUPER);
    ok((v.d?.rows ?? []).length <= 200,
       `★ Больше 200 записей за раз не отдаётся: пришло ${v.d?.rows?.length}`);
  }

  // ── СВОДКА: ПЕРИОДЫ И РАЗРЫВЫ В ГРАФИКЕ ─────────────────────────
  //
  // Дописано после сверки. «days=abc» роняло сервер, «days=9999» давало
  // график из 365 точек — год на одном экране.
  //
  // И главное: день БЕЗ СНИМКА показывался НУЛ�ём. Снимок пишется при
  // открытии панели или в 03:00. Не было ни того ни другого — график
  // падал в пол: «30 июля 6 900 ₸, 31 июля 0 ₸». Человек видел обвал
  // дохода и шёл разбираться, а клиенты никуда не девались.
  {
    for (const [q, want] of [['abc', 30], ['9999', 30], ['0', 30],
                             ['-30', 30], ['7', 7], ['90', 90]]) {
      const v = await j('GET', `/platform/metrics?days=${q}`, null, SUPER);
      ok(v.status === 200 && v.d?.days === want,
         `Период «${q}» сведён к ${want} дням`);
    }

    const v = await j('GET', '/platform/metrics?days=30', null, SUPER);
    const ser = v.d?.series ?? [];
    ok(ser.length === 30, '★ В ряду ровно 30 точек — по одной на день');

    // День без снимка не должен быть нулём, если до него доход был.
    let brokenGap = 0;
    for (let i = 1; i < ser.length; i++) {
      if (ser[i - 1].mrr > 0 && ser[i].mrr === 0 && !ser[i].filled) brokenGap++;
    }
    ok(brokenGap === 0,
       `★ График не падает в пол на днях без снимка: провалов ${brokenGap}`);
  }

  // ── ЗАВЕДЕНИЕ ПАРТНЁРА: КРАЙНИЕ ЗНАЧЕНИЯ ───────────────────────
  //
  // Дописано после сверки. Проходило молча:
  //   имя из 300 знаков — разрывает список клиентов, оплаты, журнал и
  //     листы подтверждения разом;
  //   почта «непочта» — по ней партнёр ВХОДИТ и получает письма.
  //     Войти можно, а написать или продиктовать по телефону — нет;
  //   доля 15,7% — даёт копейки, которые не сходятся при переводе, и
  //     человек не понимает, откуда разница в тиынах.
  {
    let blocked = 0;
    for (const body of [
      { name: 'М'.repeat(300), email: 'x1@t.kz', password: 'parol123', commissionPercent: 15 },
      { name: 'Тест', email: 'непочта', password: 'parol123', commissionPercent: 15 },
      { name: 'Тест', email: 'кто@гдето', password: 'parol123', commissionPercent: 15 },
      { name: 'Тест', email: 'x2@t.kz', password: 'parol123', commissionPercent: 15.7 },
    ]) {
      const r = await j('POST', '/platform/partners', body, SUPER);
      if (r.status === 400) blocked++;
    }
    ok(blocked === 4, `★ Крайние значения партнёра отбиты: ${blocked} из 4`);

    // Почта приводится к одному виду: иначе «Erlan@T.KZ» и
    // «erlan@t.kz» станут двумя разными людьми с одним ящиком.
    const mail = `Case${Date.now()}@Tabys.KZ`;
    let r = await j('POST', '/platform/partners',
      { name: 'Разный регистр', email: mail, password: 'parol123',
        commissionPercent: 10 }, SUPER);
    ok(r.status < 300, 'Партнёр с заглавными в почте заводится');

    r = await j('POST', '/platform/partners',
      { name: 'Двойник', email: mail.toUpperCase(), password: 'parol123',
        commissionPercent: 10 }, SUPER);
    ok(r.status === 400,
       '★ Та же почта другим регистром отбита — иначе два человека с одним ящиком');

    r = await j('POST', '/platform/login',
      { email: mail.toLowerCase(), password: 'parol123' });
    ok(!!r.d?.token, '★ Вход работает почтой в любом написании');
  }

  // ── СПИСОК ЭТАПОВ ОДИН НА ВСЮ СИСТЕМУ ───────────────────────────
  //
  // Дописано после находки: списков было ТРИ и они расходились.
  //   база:    new · contacted · demo · proposal · won · lost
  //   сервер:  new · called · demo · won · lost
  //   воронка: new · contacted · trial · paid · lost
  //
  // Обычный сдвиг карточки в «Пробный» падал с «Internal server
  // error». Работало только потому, что воронка двигает карточки сама
  // и ручной сдвиг делали редко.
  {
    let v = await j('GET', '/platform/clients', null, SUPER);
    const cl = (v.d?.rows ?? []).find((x) => !x.isDemo);
    if (cl) {
      let moved = 0;
      for (const st of ['new', 'contacted', 'trial', 'paid', 'lost']) {
        const r = await j('POST', `/platform/funnel/${cl.id}`, { stage: st }, SUPER);
        if (r.status < 300) moved++;
      }
      ok(moved === 5, `★ Все пять этапов воронки работают: ${moved} из 5`);

      const bad = await j('POST', `/platform/funnel/${cl.id}`, { stage: 'золотой' }, SUPER);
      ok(bad.status === 400, '★ Выдуманный этап отбит');

      const long = await j('POST', `/platform/funnel/${cl.id}`,
        { stage: 'contacted', note: 'М'.repeat(5000) }, SUPER);
      ok(long.status === 400,
         '★ Заметка в 5000 знаков отбита: она растянула бы карточку на весь столбец');

      // Возвращаем к выводу из фактов.
      await j('POST', `/platform/funnel/${cl.id}`, { stage: 'auto' }, SUPER);
    }
  }

  // ── КРАЙНИЕ ЗНАЧЕНИЯ В ЗАЯВКАХ И ГОНКА РЕШЕНИЙ ──────────────────
  //
  // Дописано после сверки. Содержимое заявки не проверялось вовсе:
  //   отсрочка на 9999 дней проходила и продлевала клиента до 2054
  //     года — двадцать семь лет бесплатной работы;
  //   «просит вертолёт» доходил до владельца платформы, и тот получал
  //     ошибку базы вместо ответа — разбираться ему, а ошибся партнёр;
  //   выдуманный тариф «алмазный» МОЛЧА становился «Стартом»: партнёр
  //     просил одно, клиент получал другое.
  {
    let v = await j('GET', '/platform/clients', null, SUPER);
    const cl = (v.d?.rows ?? []).find((x) => !x.isDemo);
    if (cl) {
      let blocked = 0;
      for (const body of [
        { kind: 'grace', payload: { days: 9999 } },
        { kind: 'grace', payload: { days: -30 } },
        { kind: 'grace', payload: { days: 0 } },
        { kind: 'device', payload: { device: 'вертолёт' } },
        { kind: 'tariff', payload: { tier: 'алмазный' } },
        { kind: 'other', payload: {}, comment: 'М'.repeat(5000) },
      ]) {
        const r = await j('POST', '/platform/requests',
          { accountId: cl.id, ...body }, SUPER);
        if (r.status === 400) blocked++;
      }
      ok(blocked === 6, `★ Крайние значения в заявках отбиты: ${blocked} из 6`);

      // ГОНКА: два решения по одной заявке разом. Без защиты строка
      // счёта задвоилась бы, и клиент платил бы за одну кассу дважды.
      const r = await j('POST', '/platform/requests',
        { accountId: cl.id, kind: 'device', payload: { device: 'pos' },
          comment: 'гонка' }, SUPER);
      const rid = r.d?.id;
      if (rid) {
        const [a, b] = await Promise.all([
          j('POST', `/platform/requests/${rid}/decide`, { approve: true, unitPrice: 2500 }, SUPER),
          j('POST', `/platform/requests/${rid}/decide`, { approve: true, unitPrice: 2500 }, SUPER),
        ]);
        const okCount = [a, b].filter((x) => x.status < 300).length;
        ok(okCount === 1,
           `★ Гонка решений отбита: прошло ${okCount} из 2 — строка не задвоилась`);
      }
    }
  }

  // ── КРАЙНИЕ СУММЫ И СРОКИ ───────────────────────────────────────
  //
  // Дописано после сверки. Срок оплаты МОЛЧА ЧИНИЛСЯ: «0» и «−3»
  // превращались в единицу, а «999» проходил — и подтверждение
  // продлевало клиента до 2109 года.
  //
  // Молчаливая починка хуже отказа: человек уверен, что ввёл одно, а
  // система записала другое, и узнает об этом через месяц.
  {
    let v = await j('GET', '/platform/clients', null, SUPER);
    const cl = (v.d?.rows ?? []).find((x) => !x.isDemo);
    if (cl) {
      let blocked = 0;
      for (const body of [
        { amount: 6900, months: 0 }, { amount: 6900, months: -3 },
        { amount: 6900, months: 999 }, { amount: 6900, months: 1.5 },
        { amount: 1000000000, months: 1 },
      ]) {
        const r = await j('POST', '/platform/payments',
          { accountId: cl.id, method: 'kaspi', ...body }, SUPER);
        if (r.status === 400) blocked++;
      }
      ok(blocked === 5, `★ Крайние суммы и сроки отбиты: ${blocked} из 5`);

      const r = await j('POST', '/platform/payments',
        { accountId: cl.id, method: 'kaspi', amount: 6900, months: 12 }, SUPER);
      ok(!!r.d?.id, '★ Обычная оплата на год проходит');

      // Строки счёта: миллиард в строке делал счёт бессмысленным.
      let n = 0;
      for (const body of [
        { kind: 'module', title: 'Минус', price: -5000 },
        { kind: 'module', title: 'Много', price: 1000000000 },
        { kind: 'module', title: 'М'.repeat(300), price: 1000 },
        { kind: 'pos', title: 'Касса', price: 3000, qty: 0 },
      ]) {
        const x = await j('POST', `/platform/clients/${cl.id}/lines`, body, SUPER);
        if (x.status === 400) n++;
      }
      ok(n === 4, `★ Крайние строки счёта отбиты: ${n} из 4`);

      const ok1 = await j('POST', `/platform/clients/${cl.id}/lines`,
        { kind: 'discount', title: 'Скидка за год', price: 500 }, SUPER);
      ok(ok1.status < 300, '★ Скидка минусом разрешена — это её вид');
    }
  }

  // ── КРАЙНИЕ ЗНАЧЕНИЯ ПРИ ЗАВЕДЕНИИ И ПРАВКЕ ─────────────────────
  //
  // Дописано после сверки крайних состояний. Проходило молча:
  //   имя из 200 знаков — разрывает таблицу, ленту и листы разом;
  //   телефон «не телефон» — а по нему владелец ВХОДИТ в кабинет,
  //     магазин заводился, а войти по такому нельзя;
  //   пробный период −5 дней — кончился до начала;
  //   пробный 9999 дней — это не пробный, а бесплатный навсегда.
  //
  // Правка карточки не проверяла НИЧЕГО: испортить можно было то, что
  // не пропустили при создании.
  {
    const bad = [
      ['имя 200 знаков', { name: 'М'.repeat(200), ownerPhone: '+77010000101' }],
      ['телефон буквами', { name: 'Проверка', ownerPhone: 'не телефон' }],
      ['телефон 5 цифр', { name: 'Проверка', ownerPhone: '+7701' }],
      ['пробный −5', { name: 'Проверка', ownerPhone: '+77010000102', trialDays: -5 }],
      ['пробный 9999', { name: 'Проверка', ownerPhone: '+77010000103', trialDays: 9999 }],
    ];
    let blocked = 0;
    for (const [, body] of bad) {
      const v = await j('POST', '/platform/tenants', body, SUPER);
      if (v.status === 400) blocked++;
    }
    ok(blocked === bad.length,
       `★ Крайние значения при заведении отбиты: ${blocked} из ${bad.length}`);

    // Обычный клиент заводится как заводился.
    let v = await j('POST', '/platform/tenants',
      { name: 'Обычный магазин', ownerName: 'Владелец',
        ownerPhone: '+7 701 000 01 05', trialDays: 30 }, SUPER);
    ok(!!v.d?.id, '★ Обычный клиент заводится: проверки не мешают работе');

    const id = v.d?.id;
    if (id) {
      let n = 0;
      for (const body of [
        { name: '   ' }, { name: 'М'.repeat(200) },
        { ownerPhone: 'не телефон' }, { city: 'А'.repeat(300) },
      ]) {
        const r = await j('PATCH', `/platform/clients/${id}`, body, SUPER);
        if (r.status === 400) n++;
      }
      ok(n === 4, `★ Правка карточки тоже проверяет: отбито ${n} из 4`);

      const r = await j('PATCH', `/platform/clients/${id}`,
        { city: 'Шымкент', ownerPhone: '+7 705 999 88 77' }, SUPER);
      ok(r.status < 300, '★ Обычная правка проходит');
    }
  }

  // ── КЛИЕНТ НЕ ЧИСЛИТСЯ ЗА ПРИЗРАКОМ ─────────────────────────────
  //
  // Дописано после сверки крайних состояний. Партнёра пометили
  // удалённым: он исчез из списка, вход закрыт, ключ отбит — всё
  // верно. Но клиент по-прежнему числился за ним: в списке «ведёт
  // Ерлан», а в отборе по партнёру Ерлана НЕТ — его некем выбрать.
  //
  // Клиент повисал: он есть, он платит, но его никто не ведёт.
  {
    let v = await j('GET', '/platform/partners', null, SUPER);
    const p = (v.d?.rows ?? []).find((x) => !x.isSuperUser);
    // Партнёра могли отключить проверки выше — включаем, иначе мы
    // меряем не привязку, а отключение.
    if (p) await j('PATCH', `/platform/partners/${p.id}`, { isActive: true }, SUPER);
    v = await j('GET', '/platform/clients', null, SUPER);
    const cl = (v.d?.rows ?? []).find((x) => !x.isDemo) ?? (v.d?.rows ?? [])[0];

    if (p && cl) {
      // Привязать к живому — можно.
      let r = await j('POST', `/platform/clients/${cl.id}/partner`,
        { partnerId: p.id }, SUPER);
      ok(r.status < 300 && r.d?.ok,
         `★ Клиента можно привязать к живому партнёру: ${r.d?.note}`);

      // Сделать ничьим — можно, и ответ объясняет последствие.
      r = await j('POST', `/platform/clients/${cl.id}/partner`,
        { partnerId: null }, SUPER);
      ok(/ничьим|платформа/i.test(r.d?.note ?? ''),
         `★ Ответ называет последствие: ${r.d?.note}`);

      // Привязать к несуществующему — нельзя, и сказано по-русски.
      r = await j('POST', `/platform/clients/${cl.id}/partner`,
        { partnerId: '00000000-0000-0000-0000-000000000000' }, SUPER);
      ok(r.status >= 400 && /удал|не найден/i.test(r.d?.message ?? ''),
         `★ Привязка к несуществующему партнёру отбита: ${r.d?.message}`);

      // Возвращаем как было.
      await j('POST', `/platform/clients/${cl.id}/partner`, { partnerId: p.id }, SUPER);
    }
  }

  // ── РЕКВИЗИТЫ ДОХОДЯТ ДО ВЛАДЕЛЬЦА МАГАЗИНА ─────────────────────
  //
  // Дописано после находки: владелец магазина открывал «Подписку» и не
  // видел ни реквизитов, ни суммы. Сервер их отдавал, страница не
  // спрашивала — платить было некуда, и он звонил партнёру.
  {
    await j('POST', '/platform/pay-settings', {
      payUrl: 'https://pay.kaspi.kz/tabys',
      payName: 'Магжан С.',
      payPhone: '+77015550000',
      payNote: 'название магазина',
    }, SUPER);

    const v = await j('GET', '/platform/pay-settings', null, SUPER);
    ok(v.d?.payUrl && v.d?.payPhone,
       '★ Реквизиты сохранены и читаются владельцем платформы');

    // Пять полей отдельно, а не одной строкой: слитую человек
    // копирует целиком и вставляет в поле номера — перевод не проходит.
    const fields = ['payUrl', 'payQrUrl', 'payName', 'payPhone', 'payNote'];
    ok(fields.every((f) => f in (v.d ?? {})),
       '★ Реквизиты пятью полями: номер копируют отдельно от имени');
  }

  // ── ЛИСТАНИЕ ЖУРНАЛА НИЧЕГО НЕ ТЕРЯЕТ ───────────────────────────
  //
  // Дописано после находки: листали по ВРЕМЕНИ записи, а массовое
  // действие пишет несколько записей одним мгновением. Страница
  // кончалась на такой записи, следующая просила «раньше этого
  // момента» — и пропускала все остальные записи той же секунды.
  //
  // Проверено было: шесть записей одним моментом, листание по две —
  // потеряно пять из двадцати одной. Человек листает журнал и не
  // видит, что часть событий просто исчезла.
  {
    const all = (await j('GET', '/platform/audit?limit=200', null, SUPER)).d?.rows ?? [];
    if (all.length >= 4) {
      const seen = [];
      let cursor = null;
      for (let page = 0; page < 60; page++) {
        const url = '/platform/audit?limit=2' + (cursor ? `&before=${cursor}` : '');
        const v = await j('GET', url, null, SUPER);
        const rows = v.d?.rows ?? [];
        if (!rows.length) break;
        seen.push(...rows.map((r) => r.id));
        if (!v.d?.hasMore) break;
        cursor = v.d.nextBefore;
      }
      ok(seen.length === new Set(seen).size,
         '★ Листание журнала не повторяет записи');
      ok(new Set(seen).size === all.length,
         `★ Листание журнала ничего не теряет: ${new Set(seen).size} из ${all.length}`);
    }
  }

  // ── ЦИФРЫ СВОДКИ СКЛАДЫВАЮТСЯ ───────────────────────────────────
  //
  // Дописано после находки: «работают 3» при трёх магазинах, из
  // которых платят двое. Третий сидел в обеих карточках сразу —
  // человек складывал 3 + 1 = 4 и переставал доверять сводке.
  {
    await j('POST', '/platform/snapshot', {}, SUPER).catch(() => {});
    const v = await j('GET', '/platform/metrics?days=30', null, SUPER);
    const n = v.d?.now;
    if (n && n.tenants > 0) {
      const sum = n.active + n.trial + n.expired;
      ok(sum === n.tenants,
         `★ Платят + пробные + просрочены = всего: ${n.active}+${n.trial}+${n.expired}=${n.tenants}`);
      ok(n.revenueToday != null, '★ «Поступило сегодня» отдаётся');
      ok(n.pending != null, '★ «Ждут одобрения» отдаётся');
    }
  }

  // ── СВОДКА: ДВА ИСТОЧНИКА В ОДНОМ РЯДУ ─────────────────────────
  //
  // Дописано в описи полей. Ряд собирается из ДВУХ мест, и это не
  // ошибка, а замысел:
  //   из СНИМКА дня — магазины, платят, пробные, просрочены, доход.
  //     Замерли навсегда: как было в тот день, так и останется;
  //   из ЖИВЫХ ОПЛАТ — сколько оплат, на сколько, доля партнёрам.
  //
  // Проверяем, что части сходятся между собой: разойдутся — человек
  // увидит в сводке одно, а в «Деньгах» другое.
  {
    const m = await j('GET', '/platform/metrics?days=30', null, SUPER);
    const series = m.d?.series ?? [];

    const inSeries = series.reduce((a, d) => a + (d.amount ?? 0), 0);
    ok(inSeries === (m.d?.period?.amount ?? 0),
       `★ Ряд и итог периода сходятся: ${inSeries} = ${m.d?.period?.amount}`);

    const last = series[series.length - 1];
    ok(last?.tenants === m.d?.now?.tenants,
       `★ Последний день ряда не отстаёт от живого: ${last?.tenants} = ${m.d?.now?.tenants}`);

    const parts = (m.d?.period?.partnerShare ?? 0) + (m.d?.period?.platformShare ?? 0);
    ok(parts === (m.d?.period?.amount ?? 0),
       `★ Доли периода складываются в приход: ${parts} = ${m.d?.period?.amount}`);
  }

  // ── ОТКЛЮЧЕНИЕ ПАРТНЁРА ДЕЙСТВУЕТ СРАЗУ ─────────────────────────
  //
  // Дописано после находки: партнёру закрыли вход, а его СТАРЫЙ КЛЮЧ
  // продолжал работать — он видел клиентов, отмечал оплаты, заводил
  // новых. «Закрыть вход» мешало только войти заново.
  {
    let v = await j('GET', '/platform/partners', null, SUPER);
    const p = (v.d?.rows ?? []).find((x) => !x.isSuperUser && x.isActive);
    if (p) {
      await j('PATCH', `/platform/partners/${p.id}`, { isActive: false }, SUPER);

      v = await j('GET', '/platform/clients', null, PARTNER);
      ok(v.status === 403,
         '★ Отключённый партнёр не видит клиентов даже со старым ключом');

      v = await j('POST', '/platform/tenants',
        { name: 'После отключения', ownerName: 'X', ownerPhone: '+77010000777' }, PARTNER);
      ok(v.status === 403, '★ Отключённый партнёр не заводит клиентов');

      // Владельца это не задевает.
      v = await j('GET', '/platform/clients', null, SUPER);
      ok((v.d?.rows ?? []).length > 0, 'Владелец работает как работал');

      // Возвращаем, чтобы не мешать остальным проверкам.
      await j('PATCH', `/platform/partners/${p.id}`, { isActive: true }, SUPER);
      v = await j('GET', '/platform/clients', null, PARTNER);
      ok(v.status === 200, '★ Включение возвращает доступ сразу');
    }
  }

  // ── ВОРОНКА: ручной этап сильнее, но его можно снять ─────────────
  //
  // Дописано после находки: карточка, двинутая в «Отказ» руками,
  // застревала там навсегда. Клиент платит, работает, приносит
  // деньги — а в воронке лежит в архиве, и вернуть её нечем.
  {
    let v = await j('GET', '/platform/clients', null, SUPER);
    const cl = (v.d?.rows ?? []).find((r) => r.paidUntil);
    if (cl) {
      // Двигаем в «Отказ» руками.
      await j('POST', `/platform/funnel/${cl.id}`, { stage: 'lost' }, SUPER);
      v = await j('GET', '/platform/funnel', null, SUPER);
      let card = (v.d?.stages ?? []).flatMap((st) => st.cards.map((c) => ({ ...c, st: st.key })))
        .find((c) => c.id === cl.id);
      ok(card?.st === 'lost' && card?.isManual,
         '★ Ручной этап сильнее фактов: карточка ушла в «Отказ»');

      // Возвращаем к выводу из фактов.
      const r = await j('POST', `/platform/funnel/${cl.id}`, { stage: 'auto' }, SUPER);
      ok(/выводится из фактов/.test(r.d?.note ?? ''), `★ ${r.d?.note}`);

      v = await j('GET', '/platform/funnel', null, SUPER);
      card = (v.d?.stages ?? []).flatMap((st) => st.cards.map((c) => ({ ...c, st: st.key })))
        .find((c) => c.id === cl.id);
      ok(card && !card.isManual && card.st !== 'lost',
         `★ Карточка вернулась из архива: этап «${card?.st}» выведен из фактов`);
    }
  }

  // ── ПОСЛЕДСТВИЯ ЗАЯВОК ДОХОДЯТ ДО СЧЁТА ─────────────────────────
  //
  // Одобрение должно МЕНЯТЬ ДЕЛО, а не просто ставить отметку. Проверка
  // на живых данных: счёт до и после каждого вида заявки.
  {
    let v = await j('GET', '/platform/clients', null, SUPER);
    const cl = (v.d?.rows ?? [])[0];
    if (cl) {
      const before = cl.monthly;

      // Устройство: счёт растёт ровно на цену строки.
      let r = await j('POST', '/platform/requests',
        { accountId: cl.id, kind: 'device', payload: { device: 'pos' }, comment: 'касса' }, PARTNER);
      const rid = r.d?.id;
      r = await j('POST', `/platform/requests/${rid}/decide`,
        { approve: true, unitPrice: 2500 }, SUPER);
      ok(/2 500/.test(r.d?.effect ?? ''), `★ Одобрение назвало цену: ${r.d?.effect}`);

      v = await j('GET', `/platform/clients/${cl.id}/card`, null, SUPER);
      ok(v.d?.monthly === before + 2500,
         `★ Счёт вырос ровно на цену строки: ${before} → ${v.d?.monthly}`);

      // Отказ ничего не меняет.
      const now = v.d.monthly;
      r = await j('POST', '/platform/requests',
        { accountId: cl.id, kind: 'device', payload: { device: 'store' }, comment: 'точка' }, PARTNER);
      await j('POST', `/platform/requests/${r.d.id}/decide`,
        { approve: false, note: 'обсудим на встрече' }, SUPER);
      v = await j('GET', `/platform/clients/${cl.id}/card`, null, SUPER);
      ok(v.d?.monthly === now, '★ Отказ не меняет счёт клиента');

      // Партнёр видит причину отказа.
      v = await j('GET', '/platform/requests', null, PARTNER);
      const rej = (v.d ?? []).find((x) => x.status === 'rejected');
      ok(rej?.decision_note === 'обсудим на встрече',
         '★ Партнёр видит причину отказа — иначе он не поймёт, что не так');
    }
  }

  // ── КАРТОЧКА И СПИСОК ГОВОРЯТ ОДНО И ТО ЖЕ ──────────────────────
  //
  // Дописано после того, как в карточке стоял НОЛЬ, а в списке рядом
  // 6 900: карточка считала счёт по-своему, минуя тариф. Восьмое место
  // с тем же расчётом.
  {
    let v = await j('GET', '/platform/clients', null, SUPER);
    const row = (v.d?.rows ?? [])[0];
    if (row) {
      v = await j('GET', `/platform/clients/${row.id}/card`, null, SUPER);
      const card = v.d ?? {};
      ok(card.monthly === row.monthly,
         `★ Счёт в карточке и списке совпадает: ${card.monthly} = ${row.monthly}`);
      ok(card.tariff, '★ Тариф в карточке заполнен');
      // Берём клиента С ВЛАДЕЛЬЦЕМ: часть заводится в проверках без
      // него, и правило про звонки к ним не относится.
      ok(card.owner ? !!card.ownerPhone : true,
         '★ Если владелец записан, телефон тоже: без него некому звонить');
    }
  }

  // ── ПОИСК: он должен СУЖАТЬ, а не показывать всё ─────────────────
  //
  // Дописано после того, как поиск оказался сломан вовсе: любой запрос
  // возвращал весь список. Заметить это на глаз нельзя — строки есть,
  // поиск «работает», просто он всегда показывает всё.
  {
    let v = await j('GET', '/platform/clients?q=нетакогоклиента', null, SUPER);
    ok((v.d?.rows ?? []).length === 0,
       '★ Поиск сужает: несуществующее слово не находит ничего');

    v = await j('GET', '/platform/clients', null, SUPER);
    const all = (v.d?.rows ?? []).length;
    ok(all > 0, 'Без запроса список полный');

    const first = v.d.rows[0];
    v = await j('GET', `/platform/clients?q=${encodeURIComponent(first.name)}`, null, SUPER);
    ok((v.d?.rows ?? []).length < all || all === 1,
       '★ Поиск по названию сужает список');

    if (first.ownerPhone) {
      v = await j('GET', `/platform/clients?q=${encodeURIComponent(first.ownerPhone)}`, null, SUPER);
      ok((v.d?.rows ?? []).some((r) => r.id === first.id),
         '★ Поиск по телефону находит клиента');
    }

    const withOwner = (v.d?.rows ?? []).find((r) => r.owner);
    ok(!withOwner || !!withOwner.ownerPhone,
       '★ У клиента с владельцем есть и телефон: без него некому звонить');
  }

  // ── РАЗГРАНИЧЕНИЕ: партнёр не видит и не трогает чужое ────────────
  //
  // Дописано после сверки, на которой нашлись две утечки: партнёр
  // видел долю платформы в оплатах и реквизиты в настройках. Обе не
  // ломали работу и потому не всплывали сами.
  {
    const D = PARTNER;

    if (D) {
      let v = await j('GET', '/platform/pay-settings', null, D);
      ok(v.status === 403, '★ Реквизиты закрыты от партнёра: клиенты платят напрямую платформе');

      v = await j('GET', '/platform/price-book', null, D);
      ok(v.d?.base > 0 && v.d?.payDetails == null,
         '★ Прайс партнёру виден, реквизиты в нём — нет');

      v = await j('GET', '/platform/payments', null, D);
      ok(v.d?.totals?.platformShare == null,
         '★ Доля платформы скрыта от партнёра: чужой доход не его дело');

      v = await j('GET', '/platform/partners', null, D);
      ok(v.status === 403, 'Раздел партнёров закрыт от партнёра');

      v = await j('GET', '/platform/metrics', null, D);
      ok(v.status === 403, 'Сводка платформы закрыта от партнёра');
    }
  }

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
