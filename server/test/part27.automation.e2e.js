/**
 * ★ ЧАСТЬ 27 — АВТОМАТИЗАЦИЯ И СВЯЗЬ.
 *
 * Проверяем реально работающую механику:
 *  • вебхук РЕАЛЬНО доставляется на локальный сервер-приёмник (не «создался»)
 *  • подпись HMAC присутствует
 *  • журнал доставки видит успех
 *  • сценарий «крупный возврат» создаёт уведомление владельцу
 *  • автоотчёт собирает дневную сводку
 *  • чат поддержки сохраняет переписку
 */
const { spawn } = require('child_process');
const http = require('http');

const PORT = '3271';
const HOOK_PORT = 3279;
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7701' + Math.floor(1000000 + Math.random() * 8999999);

// локальный приёмник вебхуков — ловим реальную доставку
let received = null, receivedSig = null;
const hookSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (ch) => body += ch);
  req.on('end', () => { received = body; receivedSig = req.headers['x-shop-signature']; res.writeHead(200); res.end('ok'); });
});

let TOK = '';
const j = async (method, path, body) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json', ...(TOK ? { Authorization: `Bearer ${TOK}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
const wait = async () => { for (let i = 0; i < 50; i++) { try { await fetch(API + '/health'); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };

(async () => {
  await new Promise((res) => hookSrv.listen(HOOK_PORT, res));
  ok(await wait(), 'Сервер поднялся');

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Автоматизация Тест', ownerName: 'Санжар', password: 'Password123' });
  TOK = r.d.access;

  // ---------- ВЕБХУКИ ----------
  r = await j('POST', '/automation/webhooks', {
    url: `http://127.0.0.1:${HOOK_PORT}/hook`, events: ['sale.created', 'test.ping'], secret: 'mysecret' });
  const hookId = r.d.id;
  ok(!!hookId && r.d.events.includes('sale.created'), 'Вебхук создан с подпиской на события');

  r = await j('POST', '/automation/webhooks', { url: 'не-url' });
  ok(r.status === 400, 'Вебхук с кривым URL отбит');

  // реальная доставка
  received = null;
  r = await j('POST', '/automation/webhooks/test', { event: 'test.ping' });
  ok(r.d.fired === 1, 'Событие разослано 1 подписчику');
  await new Promise((res) => setTimeout(res, 400)); // ждём доставку
  ok(received !== null, '★ Вебхук РЕАЛЬНО доставлен на сервер-приёмник');
  const parsed = received ? JSON.parse(received) : {};
  ok(parsed.event === 'test.ping' && parsed.type === 'test', `★ Тело вебхука корректно: event=${parsed.event}`);
  ok(!!receivedSig && receivedSig.length === 64, `★ Подпись HMAC присутствует (${receivedSig?.slice(0, 12)}…)`);

  // журнал доставки
  r = await j('GET', '/automation/webhooks/deliveries');
  ok(r.d.length === 1 && r.d[0].status === 'ok' && r.d[0].response_code === 200,
     '★ Журнал доставки: статус ok, код 200 (у МоегоСклада журнала нет)');

  // ---------- СЦЕНАРИИ ----------
  r = await j('POST', '/automation/scenarios', {
    name: 'Крупный возврат', trigger: 'big_refund', threshold: 10000, action: 'notify_owner' });
  ok(!!r.d.id && r.d.trigger === 'big_refund', 'Сценарий «крупный возврат» создан');

  r = await j('POST', '/automation/scenarios', { name: 'Х', trigger: 'выдумка' });
  ok(r.status === 400, 'Неизвестный триггер отбит');

  // возврат ниже порога — не срабатывает
  r = await j('POST', '/automation/scenarios/check', { trigger: 'big_refund', value: 5000, context: { name: 'чек №5' } });
  ok(r.d.fired.length === 0, 'Возврат 5 000 < порога 10 000 — сценарий молчит');

  // возврат выше порога — срабатывает
  r = await j('POST', '/automation/scenarios/check', { trigger: 'big_refund', value: 15000, context: { name: 'чек №7' } });
  ok(r.d.fired.length === 1, '★ Возврат 15 000 > порога — сценарий сработал');

  // уведомление владельцу создано
  r = await j('GET', '/stock/notifications');
  const notes = Array.isArray(r.d) ? r.d : r.d.items ?? [];
  ok(notes.some((x) => /Крупный возврат/.test(x.title)), '★ Сценарий создал уведомление владельцу');

  // выключение сценария
  r = await j('GET', '/automation/scenarios');
  const scId = r.d[0].id;
  await j('PATCH', `/automation/scenarios/${scId}`, { enabled: false });
  r = await j('POST', '/automation/scenarios/check', { trigger: 'big_refund', value: 20000, context: {} });
  ok(r.d.fired.length === 0, 'Выключенный сценарий не срабатывает');

  // ---------- АВТООТЧЁТЫ ----------
  r = await j('POST', '/automation/schedules', { channel: 'email', target: 'owner@shop.kz', sendAtHour: 21 });
  ok(!!r.d.id && r.d.send_at_hour === 21, 'Расписание вечерней сводки создано');
  r = await j('POST', '/automation/schedules', { channel: 'email', target: 'x', sendAtHour: 30 });
  ok(r.status === 400, 'Час вне 0–23 отбит');

  r = await j('GET', '/automation/daily-summary');
  ok(typeof r.d.revenue === 'number' && r.d.text.includes('Сводка за'),
     `★ Дневная сводка собрана: «${r.d.text}»`);

  // ---------- НОВОСТИ ----------
  // публикуем новость напрямую (оператор), затем клиент видит
  await j('POST', '/automation/webhooks/test', {}).catch(() => {});
  const { Client } = require('pg');
  const pg = new Client({ host: '127.0.0.1', user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE });
  await pg.connect();
  await pg.query(`INSERT INTO news_post (title, body, is_important) VALUES ('Новый закон КЗ', 'С 2026 соцналог отменён', true)`);
  await pg.end();

  r = await j('GET', '/automation/news');
  ok(r.d.length >= 1 && r.d[0].title.includes('закон') && r.d[0].is_read === false,
     '★ Новость от оператора видна клиенту как непрочитанная');
  const newsId = r.d[0].id;
  await j('POST', `/automation/news/${newsId}/read`, {});
  r = await j('GET', '/automation/news');
  ok(r.d.find((x) => x.id === newsId).is_read === true, 'Новость помечена прочитанной');

  // ---------- ЧАТ ПОДДЕРЖКИ ----------
  r = await j('POST', '/automation/chat', { body: 'Как настроить фискализацию?' });
  ok(r.d.from_side === 'client' && r.d.body.includes('фискализацию'), 'Клиент написал в поддержку');
  r = await j('GET', '/automation/chat');
  ok(r.d.length === 1, 'История чата содержит сообщение');
  r = await j('POST', '/automation/chat', { body: '' });
  ok(r.status === 400, 'Пустое сообщение отбито');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill(); hookSrv.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); hookSrv.close(); process.exit(1); });
