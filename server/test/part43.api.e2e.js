/**
 * ★ ЭТАП 11 — Публичный API и проверка кассы.
 *
 * Публичный API:
 *  • ключ показывается ОДИН раз и хранится только отпечатком;
 *  • без ключа доступа нет, с чужим ключом — тоже;
 *  • права ограничивают разделы: ключ «только отчёты» не читает товары;
 *  • ключ видит ТОЛЬКО свой магазин (изоляция важнее всего);
 *  • отзыв мгновенный, журнал использования сохраняется;
 *  • срок действия соблюдается.
 *
 * Проверка кассы (модель Wipon): активна, приостановлена, снята с учёта.
 */
const { spawn } = require('child_process');

const PORT = '3395';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const ph = () => '+7709' + Math.floor(1000000 + Math.random() * 8999999);

const j = async (method, path, body, headers = {}) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

(async () => {
  ok(await wait(), 'Сервер поднялся');

  // два разных магазина — проверим изоляцию
  const mk = async (name) => {
    const p = ph();
    let r = await j('POST', '/auth/otp', { phone: p });
    r = await j('POST', '/auth/register', { phone: p, code: r.d.devCode,
      businessName: name, ownerName: 'Владелец', password: 'Password123' });
    return { token: r.d.access, auth: { Authorization: `Bearer ${r.d.access}` } };
  };
  const A = await mk('Магазин А');
  const B = await mk('Магазин Б');

  await j('POST', '/goods', { name: 'Товар А', salePrice: 100, purchasePrice: 50, barcode: '4870110001' }, A.auth);
  await j('POST', '/goods', { name: 'Товар Б', salePrice: 200, purchasePrice: 90, barcode: '4870110002' }, B.auth);

  // ---------- СОЗДАНИЕ КЛЮЧА ----------
  let r = await j('POST', '/api-keys', { name: 'Для 1С', scopes: ['goods:read', 'sales:read'] }, A.auth);
  const keyA = r.d?.key;
  ok(!!keyA && keyA.startsWith('tby_'), `★ Ключ создан: ${r.d?.prefix}…`);
  ok(/Сохраните ключ сейчас/.test(r.d?.warning ?? ''), 'Предупреждение: увидеть снова нельзя');

  r = await j('GET', '/api-keys', null, A.auth);
  const listed = r.d[0];
  ok(!listed.key && !listed.key_hash, '★ В списке ключа НЕТ — хранится только отпечаток');
  ok(listed.prefix === keyA.slice(0, 12), 'Начало ключа видно — чтобы опознать нужный');
  ok(listed.status === 'ни разу не использован', `★ Видно состояние: ${listed.status}`);

  // ---------- ДОСТУП ПО КЛЮЧУ ----------
  r = await j('GET', '/v1/ping', null, { 'x-api-key': keyA });
  ok(r.d?.ok && r.d?.key === 'Для 1С', '★ Ключ работает, видно его название и права');

  r = await j('GET', '/v1/goods', null, { 'x-api-key': keyA });
  ok(Array.isArray(r.d) && r.d.length === 1 && r.d[0].name === 'Товар А',
     '★ Ключ видит ТОЛЬКО свой магазин — чужой товар не отдан');

  // ---------- БЕЗ КЛЮЧА И С ЧУЖИМ ----------
  r = await j('GET', '/v1/goods');
  ok(r.status === 401, 'Без ключа доступа нет');

  r = await j('GET', '/v1/goods', null, { 'x-api-key': 'tby_ZZZZfakeKEY123456' });
  ok(r.status === 401 && /не найден/.test(r.d?.message ?? ''), 'Поддельный ключ отбит');

  // Мусор вместо ключа: сервер обязан ответить отказом, а не упасть.
  // Внешний API видят все, и первое, что туда прилетит, — мусор.
  r = await j('GET', '/v1/goods', null, { 'x-api-key': '!!!" + String.raw`~/\\<>` + "!!!' });
  ok(r.status === 401, '★ Мусор вместо ключа: отказ, а не падение сервера');
  r = await j('GET', '/v1/goods', null, { 'x-api-key': 'x'.repeat(5000) });
  ok(r.status === 401, '★ Очень длинный ключ тоже отбивается');

  // ---------- ПРАВА ОГРАНИЧИВАЮТ ----------
  r = await j('GET', '/v1/stock', null, { 'x-api-key': keyA });
  ok(r.status === 403 && /stock:read/.test(r.d?.message ?? ''),
     '★ Права ограничивают: ключ «товары+продажи» не читает остатки');
  ok(/Права ключа/.test(r.d?.message ?? ''), 'Сообщение подсказывает, какие права есть');

  // ---------- ИЗОЛЯЦИЯ МАГАЗИНОВ ----------
  r = await j('POST', '/api-keys', { name: 'Ключ Б', scopes: ['goods:read'] }, B.auth);
  const keyB = r.d?.key;
  r = await j('GET', '/v1/goods', null, { 'x-api-key': keyB });
  ok(r.d.length === 1 && r.d[0].name === 'Товар Б', '★ Ключ второго магазина видит только своё');

  r = await j('GET', '/api-keys', null, B.auth);
  ok(r.d.length === 1, '★ Владелец Б не видит ключи владельца А');

  // ---------- УЧЁТ ИСПОЛЬЗОВАНИЯ ----------
  r = await j('GET', '/api-keys', null, A.auth);
  ok(r.d[0].calls_count >= 2 && !!r.d[0].last_used_at,
     `★ Учтено обращений: ${r.d[0].calls_count} — забытый ключ будет видно`);
  ok(r.d[0].status === 'работает', 'Состояние сменилось на «работает»');

  // ---------- ОТЗЫВ ----------
  r = await j('DELETE', `/api-keys/${listed.id}`, null, A.auth);
  ok(r.d?.ok, 'Ключ отозван');

  r = await j('GET', '/v1/goods', null, { 'x-api-key': keyA });
  ok(r.status === 401 && /отозван/.test(r.d?.message ?? ''), '★ Отозванный ключ перестал работать сразу');

  r = await j('GET', '/api-keys', null, A.auth);
  ok(r.d[0].status === 'отозван' && r.d[0].calls_count >= 2,
     '★ Журнал использования сохранён — видно, что успели сделать ключом');

  // ---------- СРОК ДЕЙСТВИЯ ----------
  r = await j('POST', '/api-keys', { name: 'Просроченный', scopes: ['goods:read'], expiresInDays: -1 }, A.auth);
  r = await j('GET', '/v1/goods', null, { 'x-api-key': r.d.key });
  ok(r.status === 401 && /истёк/.test(r.d?.message ?? ''), '★ Просроченный ключ не работает');

  // ---------- ПРОВЕРКА КАССЫ (модель Wipon) ----------
  r = await j('POST', '/verification/check-kkm', { number: '123451', provider: 'mock' }, A.auth);
  ok(r.d?.found && r.d?.status === 'active' && r.d?.risk === 'ok',
     `★ Касса зарегистрирована: ${r.d?.model}, оператор ${r.d?.ofd}`);

  r = await j('POST', '/verification/check-kkm', { number: '123459', provider: 'mock' }, A.auth);
  ok(r.d?.risk === 'danger' && /СНЯТА С УЧЁТА/.test(r.d?.reasons?.[0] ?? ''),
     '★ Снятая с учёта касса — ОПАСНО: чеки не доходят в налоговую');

  r = await j('POST', '/verification/check-kkm', { number: '123458', provider: 'mock' }, A.auth);
  ok(r.d?.risk === 'warning', 'Приостановленная регистрация — предупреждение');

  r = await j('POST', '/verification/check-kkm', { number: '123450', provider: 'mock' }, A.auth);
  ok(r.d?.found === false && r.d?.risk === 'danger', 'Ненайденная касса — проверьте номер');

  r = await j('GET', '/verification/history', null, A.auth);
  ok((r.d ?? []).some((x) => String(x.iin_bin).startsWith('12345')),
     '★ Проверки кассы попадают в общий журнал — один список вместо двух');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
