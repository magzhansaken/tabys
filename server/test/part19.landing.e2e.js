/**
 * ★ ЧАСТЬ 19 — ЛЕНДИНГ И ЗАЯВКИ НА ПИЛОТ.
 *
 * Проверяем как есть в проде: (1) публичная форма создаёт лид, мусорный
 * телефон отбивается, honeypot молча съедает ботов, лимит по IP держит
 * спам, оператор читает заявки только по ключу; (2) лендинг реально
 * рендерится Next-сервером и содержит всё, ради чего сделан: оба CTA,
 * цену 6 900, честное сравнение с UMAG/Wipon и казахский переключатель.
 */
const { spawn } = require('child_process');

const PORT = '3199';
const WEB = '3152';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };

const OPERATOR_KEY = 'test-operator-secret';
const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT, NODE_ENV: 'test', OPERATOR_KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const web = spawn(npxCmd, ['next', 'start', '-p', WEB], { cwd: __dirname + '/../../admin',
  shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });

const j = async (method, path, body, headers = {}) => {
  const r = await fetch(API + path, { method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, d: await r.json().catch(() => null) };
};
const waitHttp = async (url) => { for (let i = 0; i < 60; i++) { try { const r = await fetch(url); if (r.status < 500) return true; } catch {} await new Promise(r => setTimeout(r, 500)); } return false; };

(async () => {
  ok(await waitHttp(API + '/health'), 'API поднялся');

  // ---------- создание лида ----------
  let r = await j('POST', '/public/leads', {
    name: 'Салтанат', phone: '+7 701 555 44 33', city: 'Шымкент',
    comment: 'Магазин у дома, переезжаем с UMAG', locale: 'kk',
  });
  ok(r.status === 201 && r.d.ok && r.d.id, '★ Заявка с лендинга создана (телефон с пробелами нормализован)');
  const leadId = r.d.id;

  r = await j('POST', '/public/leads', { name: 'Бот', phone: 'абырвалг' });
  ok(r.status === 400, 'Мусорный телефон отбит с понятной ошибкой');

  r = await j('POST', '/public/leads', { name: 'Бот', phone: '+77015554433', website: 'http://spam.example' });
  ok(r.status === 201 && r.d.ok && !r.d.id, '★ Honeypot: боту ответили «ок», но заявку молча выбросили');

  // ---------- лимит по IP: 5 в час ----------
  let got429 = false;
  for (let i = 0; i < 6; i++) {
    r = await j('POST', '/public/leads', { name: `Спамер ${i}`, phone: '+77010000001' },
      { 'x-forwarded-for': '10.9.9.9' });
    if (r.status === 429) { got429 = true; break; }
  }
  ok(got429, '★ Спам с одного IP упёрся в лимит 5/час → 429');

  // ---------- операторский доступ ----------
  r = await j('GET', '/public/leads');
  ok(r.status === 403, 'Список заявок без ключа оператора закрыт (403)');
  r = await j('GET', '/public/leads', null, { 'x-operator-key': 'wrong' });
  ok(r.status === 403, 'Неверный ключ — тоже 403');
  r = await j('GET', '/public/leads', null, { 'x-operator-key': OPERATOR_KEY });
  const mine = r.d.items.find((x) => x.id === leadId);
  ok(mine && mine.phone === '+77015554433' && mine.locale === 'kk' && mine.status === 'new',
     `★ Оператор видит заявку: ${mine?.name}, ${mine?.city}, язык звонка ${mine?.locale}`);
  ok(!r.d.items.some((x) => x.comment === 'http://spam.example'), 'Honeypot-заявки в списке нет');

  r = await j('PATCH', `/public/leads/${leadId}`, { status: 'called' }, { 'x-operator-key': OPERATOR_KEY });
  ok(r.d.ok, 'Оператор отметил «прозвонили»');
  r = await j('PATCH', `/public/leads/${leadId}`, { status: 'hacked' }, { 'x-operator-key': OPERATOR_KEY });
  ok(r.status === 400, 'Неизвестный статус отбит');

  // ---------- лендинг рендерится ----------
  ok(await waitHttp(`http://127.0.0.1:${WEB}/`), 'Next-сервер лендинга поднялся');
  const html = await (await fetch(`http://127.0.0.1:${WEB}/`)).text();
  ok(html.includes('Касса торгует даже без интернета'), '★ Лендинг: заголовок про офлайн-кассу (наш главный козырь)');
  ok(html.includes('Начать бесплатно') && html.includes('/register'),
     '★ CTA «Начать бесплатно» ведёт на саморегистрацию (у UMAG — «по звонку»)');
  ok(html.includes('6 900'), 'Цена «Старт 6 900 ₸» на витрине');
  ok(html.includes('UMAG') && html.includes('Wipon') && html.includes('МойСклад'),
     '★ Честная таблица сравнения с тремя конкурентами');
  ok(html.includes('lang-switch') && html.includes('ҚАЗ'), '★ Переключатель на казахский на месте');
  ok(html.includes('Хочу пилот') && html.includes('pilot'), 'Форма заявки на пилот присутствует');
  ok(html.includes('без звонков менеджеру'), 'Позиционирование против «пути по звонку» — в подзаголовке');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill(); web.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); web.kill(); process.exit(1); });
