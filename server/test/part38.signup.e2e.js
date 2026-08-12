/**
 * ★ ЧАСТЬ 38 — РЕГИСТРАЦИЯ С ПОДТВЕРЖДЕНИЕМ ОПЕРАТОРОМ.
 *
 * Вместо СМС-кода: клиент регистрируется по телефону и паролю, оператор
 * видит заявку, звонит и активирует. Для платного B2B надёжнее СМС —
 * владелец говорит с каждым клиентом лично.
 *
 * Проверяем:
 *  • регистрация БЕЗ кода проходит, аккаунт получает статус pending
 *  • вход разрешён (человек видит «ожидает активации»), но рабочие
 *    операции закрыты с понятным сообщением
 *  • оператор видит заявку в списке
 *  • после активации всё работает
 *  • оператор может сбросить пароль (замена восстановления по СМС)
 *  • режим СМС сохранён: при REQUIRE_OTP=1 код снова обязателен
 */
const { spawn } = require('child_process');

const PORT = '3381';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7702' + Math.floor(1000000 + Math.random() * 8999999);

let TOK = '';
const OPKEY = 'demo-operator';
const j = async (method, path, body, headers = {}) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json', ...(TOK ? { Authorization: `Bearer ${TOK}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test', OPERATOR_KEY: OPKEY, MODERATE_SIGNUP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

(async () => {
  ok(await wait(), 'Сервер поднялся');

  // ---------- РЕГИСТРАЦИЯ БЕЗ КОДА ----------
  let r = await j('POST', '/auth/register', { phone,
    businessName: 'Магазин Береке', ownerName: 'Асель', password: 'Password123',
    note: 'Магазин у дома, 2 кассы' });
  ok(r.status === 201 || r.status === 200, `★ Регистрация без СМС-кода прошла (${r.status})`);
  ok(!!r.d?.access, 'Токен выдан — человек сразу в кабинете');
  TOK = r.d.access;

  // ---------- СТАТУС: ОЖИДАЕТ АКТИВАЦИИ ----------
  r = await j('GET', '/auth/me');
  ok(r.d?.accountStatus === 'pending', `★ Аккаунт в статусе ожидания (${r.d?.accountStatus})`);

  // Форма может прислать code пустой строкой (поле убрали, значение осталось).
  // Проверка длины не должна на это срабатывать — реальная ошибка с прода.
  const phoneEmpty = '+7704' + Math.floor(1000000 + Math.random() * 8999999);
  r = await j('POST', '/auth/register', { phone: phoneEmpty, code: '',
    businessName: 'Пустой код', ownerName: 'Тест', password: 'Password123' });
  ok(r.status === 201 || r.status === 200,
     `★ Регистрация с пустым кодом проходит (${r.status}) — не «code must be longer»`);

  // ---------- РАБОЧИЕ ОПЕРАЦИИ ЗАКРЫТЫ ----------
  r = await j('POST', '/goods', { name: 'Хлеб', salePrice: 200, purchasePrice: 120, barcode: '4870060001' });
  ok(r.status === 403 && /ожидает активации/.test(r.d?.message ?? ''),
     '★ Товар создать нельзя: «ожидает активации»');

  r = await j('GET', '/goods');
  ok(r.status === 403, 'Список товаров тоже закрыт');

  // ---------- ОПЕРАТОР ВИДИТ ЗАЯВКУ ----------
  r = await j('GET', '/operator/signups', null, { 'x-operator-key': OPKEY });
  const mine = (r.d?.items ?? []).find((x) => x.phone === phone);
  ok(!!mine, `★ Заявка видна оператору (всего заявок: ${r.d?.total})`);
  ok(mine?.name === 'Магазин Береке' && mine?.owner_name === 'Асель',
     `Видны название и владелец: ${mine?.name}, ${mine?.owner_name}`);
  ok(mine?.signup_note === 'Магазин у дома, 2 кассы', 'Виден комментарий клиента при регистрации');

  // без ключа оператора — нельзя
  r = await j('GET', '/operator/signups');
  ok(r.status === 401 || r.status === 403, 'Без ключа оператора заявки не показываются');

  // ---------- АКТИВАЦИЯ ----------
  r = await j('POST', `/operator/accounts/${mine.id}/activate`, { by: 'Магжан' }, { 'x-operator-key': OPKEY });
  ok(r.d?.ok && r.d?.status === 'trial', `★ Оператор активировал заявку (статус: ${r.d?.status})`);

  // повторная активация той же заявки
  r = await j('POST', `/operator/accounts/${mine.id}/activate`, {}, { 'x-operator-key': OPKEY });
  ok(r.status === 400, 'Повторная активация отбита');

  // ---------- ПОСЛЕ АКТИВАЦИИ ВСЁ РАБОТАЕТ ----------
  r = await j('POST', '/goods', { name: 'Хлеб', salePrice: 200, purchasePrice: 120, barcode: '4870060001' });
  ok(r.status === 201 || r.status === 200, '★ После активации товар создаётся');
  r = await j('GET', '/auth/me');
  ok(r.d?.accountStatus === 'trial', 'Статус сменился на пробный период');

  // ---------- СБРОС ПАРОЛЯ ОПЕРАТОРОМ ----------
  r = await j('POST', `/operator/accounts/${mine.id}/reset-password`, { password: 'NewPass456' }, { 'x-operator-key': OPKEY });
  ok(r.d?.ok, '★ Оператор сбросил пароль (замена восстановлению по СМС)');

  r = await j('POST', '/auth/login', { phone, password: 'NewPass456' });
  ok(!!r.d?.access, '★ Вход с новым паролем работает');

  r = await j('POST', '/auth/login', { phone, password: 'Password123' });
  ok(r.status === 401, 'Старый пароль больше не подходит');

  // короткий пароль не принимается
  r = await j('POST', `/operator/accounts/${mine.id}/reset-password`, { password: '123' }, { 'x-operator-key': OPKEY });
  ok(r.status === 400, 'Короткий пароль отбит');

  // ---------- РЕЖИМ СМС ДЕЙСТВИТЕЛЬНО РАБОТАЕТ ----------
  // Поднимаем ВТОРОЙ сервер с REQUIRE_OTP=1 и проверяем ветку по-настоящему,
  // а не «на словах»: когда подключим шлюз, она должна ожить без переделок.
  const PORT2 = '3382';
  const API2 = `http://127.0.0.1:${PORT2}`;
  const srv2 = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
    env: { ...process.env, PORT: PORT2, NODE_ENV: 'test', REQUIRE_OTP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const j2 = async (method, path, body) => {
    const rr = await fetch(API2 + path, { method, headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    return { status: rr.status, d: await rr.json().catch(() => null) };
  };
  let up2 = false;
  for (let i = 0; i < 40; i++) { try { await fetch(API2 + '/health'); up2 = true; break; } catch { await new Promise((z) => setTimeout(z, 400)); } }
  ok(up2, 'Второй сервер (режим СМС) поднялся');

  const phone2 = '+7703' + Math.floor(1000000 + Math.random() * 8999999);
  r = await j2('POST', '/auth/register', { phone: phone2,
    businessName: 'СМС Тест', ownerName: 'Ерлан', password: 'Password123' });
  ok(r.status === 400 && /код из СМС/i.test(r.d?.message ?? ''),
     '★ В режиме СМС регистрация без кода отклонена');

  r = await j2('POST', '/auth/otp', { phone: phone2 });
  const code2 = r.d?.devCode;
  ok(!!code2, 'Код запрошен');

  r = await j2('POST', '/auth/register', { phone: phone2, code: code2,
    businessName: 'СМС Тест', ownerName: 'Ерлан', password: 'Password123' });
  ok(!!r.d?.access, '★ В режиме СМС регистрация с кодом проходит — ветка жива');
  srv2.kill();

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
