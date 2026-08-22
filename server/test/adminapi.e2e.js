/**
 * ЧАСТЬ 15 — HTTP-API КАБИНЕТА.
 * Проверяем не логику (она покрыта частями 3–14), а то, что каждый модуль
 * реально доступен по сети с правами и токеном: регистрация → товар →
 * приёмка → остатки → долг → финансы → отчёты → лояльность → биллинг.
 */
const { spawn } = require('child_process');
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const API = 'http://127.0.0.1:3155';
const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT: '3155', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });

let TOK = '';
const j = async (method, path, body) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json', ...(TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => null);
  return { status: r.status, d };
};
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };
const today = new Date().toISOString().slice(0, 10);

(async () => {
  ok(await wait(), 'Сервер поднялся');

  // Регистрация владельца
  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode, businessName: 'API Тест', ownerName: 'Данияр', password: 'Password123' });
  ok(!!r.d.access, 'Владелец зарегистрирован'); TOK = r.d.access;

  // Без токена — отказ
  const noTok = await fetch(API + '/reports/dashboard');
  ok(noTok.status === 401, 'Дашборд без токена закрыт (401)');

  // Товар
  r = await j('POST', '/goods', { name: 'Хлеб Столичный', salePrice: 250, purchasePrice: 180, barcode: '4870001112223' });
  ok(r.status === 201 && r.d.id, 'Товар создан через HTTP');
  const productId = r.d.id;

  // Приёмка: черновик → строка → проведение → остаток
  r = await j('POST', '/stock/docs', { kind: 'supply' });
  ok(r.status === 201 && r.d.id, 'Черновик приёмки создан');
  const docId = r.d.id;
  r = await j('POST', `/stock/docs/${docId}/items`, { productId, qty: 40, price: 180 });
  ok(r.status === 201, 'Строка приёмки добавлена');
  r = await j('POST', `/stock/docs/${docId}/process`, {});
  ok(r.status === 201, 'Приёмка проведена');
  r = await j('GET', '/stock/balance?onlyNonZero=true');
  const bal = Array.isArray(r.d) ? r.d.find((x) => x.product_id === productId) : null;
  ok(bal && Number(bal.qty) === 40, `Остаток по HTTP = 40 (${bal?.qty})`);

  // Контрагент + долговая книга
  r = await j('POST', '/contragents', { name: 'Айдана', phone: '+77015556677', roles: ['customer'] });
  ok(r.status === 201 && r.d.id, 'Покупатель создан');
  r = await j('GET', '/contragents/debts');
  ok(r.status === 200, 'Долговая книга отдаётся');

  // Финансы: расход и ДДС
  r = await j('POST', '/finance/income', { amount: 100000, comment: 'Начальный капитал' });
  ok(r.status === 201, 'Приход денег записан');
  r = await j('POST', '/finance/expense', { amount: 5000, comment: 'Аренда' });
  ok(r.status === 201, 'Расход записан');
  r = await j('GET', `/finance/cash-flow?from=${today}&to=${today}`);
  ok(r.status === 200, 'ДДС отдаётся');
  r = await j('GET', `/finance/pnl?from=${today}&to=${today}`);
  ok(r.status === 200, 'Прибыли и убытки отдаются');

  // Отчёты
  r = await j('GET', '/reports/dashboard?period=today');
  ok(r.status === 200 && r.d.revenue !== undefined, 'Дашборд отдаёт выручку');
  r = await j('GET', '/reports/abc?period=month');
  ok(r.status === 200, 'ABC-анализ отдаётся');
  r = await j('GET', '/reports/shifts?period=week');
  ok(r.status === 200, 'Отчёт по сменам отдаётся');

  // Лояльность, оборудование, биллинг, онбординг, ЭДО-ключи
  r = await j('GET', '/loyalty/programs');
  ok(r.status === 200, 'Программы лояльности отдаются');
  r = await j('GET', '/equipment');
  ok(r.status === 200, 'Список оборудования отдаётся');
  r = await j('GET', '/billing/access');
  ok(r.status === 200 && r.d.canSell === true, 'Биллинг: триал активен, продавать можно');
  r = await j('GET', '/billing/tariffs');
  ok(r.status === 200 && Array.isArray(r.d) && r.d.length > 0, 'Тарифы отдаются');
  r = await j('GET', '/onboarding');
  ok(r.status === 200, 'Онбординг отдаёт состояние');
  r = await j('GET', '/documents/keys/health');
  ok(r.status === 200, 'Здоровье ЭЦП-ключей отдаётся');
  r = await j('GET', '/labels/templates');
  ok(r.status === 200, 'Шаблоны этикеток отдаются');
  r = await j('GET', '/import/template?kind=kz');
  ok(r.status === 200 && r.d.base64, 'Шаблон импорта скачивается');
  r = await j('GET', '/ai/tasks');
  ok(r.status === 200, 'Задачи ИИ отдаются');
  r = await j('GET', '/fiscal/health');
  ok(r.status === 200, 'Здоровье фискализации отдаётся');

  // Сотрудники: приём кассира с PIN и паролем, права кассира ограничены
  const cashPhone = '+7705' + Math.floor(1000000 + Math.random() * 8999999);
  r = await j('POST', '/auth/employees', { firstName: 'Салтанат', phone: cashPhone,
    roleCode: 'cashier', pin: '4321', password: 'Cashier123', canLoginAdmin: true });
  ok(r.status === 201 && r.d.id, 'Кассир принят на работу через HTTP');
  r = await j('GET', '/auth/employees');
  ok(r.status === 200 && r.d.length === 2, `Список сотрудников: владелец + кассир (${r.d?.length})`);
  r = await j('GET', '/auth/roles');
  ok(r.status === 200 && r.d.some((x) => x.code === 'cashier'), 'Роли отдаются');

  // Входим кассиром — финансы должны быть закрыты
  const ownerTok = TOK;
  r = await j('POST', '/auth/login', { phone: cashPhone, password: 'Cashier123' });
  ok(!!r.d.access, 'Кассир вошёл в кабинет'); TOK = r.d.access;
  r = await j('GET', '/finance/accounts');
  ok(r.status === 403, 'Кассиру финансы закрыты (403)');
  /* ИЩЕМ СВОЙ ТОВАР, а не считаем все. Проверка ждала ровно один
     «Хлеб», а учебные товары добавили «Хлеб «Тандыр» (учебный)» — счёт
     сбился, хотя право просмотра работает.
     Проверять надо ПРАВО, а не число товаров в магазине. */
  r = await j('GET', '/goods?q=Хлеб');
  const строки = Array.isArray(r.d) ? r.d : (r.d?.rows ?? []);
  ok(r.status === 200 && строки.some((x) => x.name === 'Хлеб Столичный'),
     'Кассир видит товары (право view есть)');
  TOK = ownerTok;

  // Увольнение защищает владельца
  /* СПИСОК МОЖЕТ ПРИЙТИ ОБЁРТКОЙ ИЛИ ОТКАЗОМ. Проверка звала find
     напрямую и падала целиком — а падение скрывает всё, что дальше. */
  r = await j('GET', '/auth/employees');
  const люди = Array.isArray(r.d) ? r.d : (r.d?.rows ?? []);
  ok(люди.length > 0, `Список сотрудников получен: ${люди.length}`);
  const хозяин = люди.find((x) => x.is_owner || x.isOwner);
  ok(!!хозяин, 'Владелец в списке есть');
  const ownerId = хозяин ? хозяин.id : null;
  if (ownerId) {
    r = await j('PATCH', `/auth/employees/${ownerId}`, { isActive: false });
    ok(r.status === 400, 'Владельца уволить нельзя (400)');
  }

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e.message); srv.kill(); process.exit(1); });
