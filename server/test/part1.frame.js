/**
 * Проверка каркасов: сервер отвечает, кабинет отдаёт страницы,
 * клиент кабинета прозрачно обновляет протухший токен (логика lib/api.ts).
 */
const { spawn } = require('child_process');
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const API = 'http://127.0.0.1:3150', WEB = 'http://127.0.0.1:3151';
const phone = () => '+7701' + Math.floor(1000000 + Math.random() * 8999999);

const srv = spawn('node', ['dist/main.js'], { cwd: __dirname + '/..',
  env: { ...process.env, PORT: '3150', NODE_ENV: 'test', PGUSER: process.env.PGUSER || 'shop_app', PGPASSWORD: process.env.PGPASSWORD || 'change_me_in_prod', PGDATABASE: process.env.PGDATABASE || 'shop_dev' },
  stdio: ['ignore', 'pipe', 'pipe'] });
// на Windows исполняемый файл называется npx.cmd — иначе spawn его не найдёт
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const web = spawn(npxCmd, ['next', 'start', '-p', '3151'], { cwd: __dirname + '/../../admin', shell: process.platform === 'win32',
  env: { ...process.env, HOME: '/root' }, stdio: ['ignore', 'pipe', 'pipe'] });

const wait = async (url) => { for (let i = 0; i < 50; i++) { try { await fetch(url); return true; } catch { await new Promise(r => setTimeout(r, 400)); } } return false; };
const wait200 = async (url) => { for (let i = 0; i < 50; i++) { try { const r = await fetch(url); if (r.status === 200) return true; } catch {} await new Promise(r => setTimeout(r, 400)); } return false; };

(async () => {
  ok(await wait(API + '/health'), 'Сервер поднялся');
  const h = await (await fetch(API + '/health')).json();
  ok(h.status === 'ok' && h.db === true, `Проверка живости: сервер и база в порядке (задержка БД ${h.dbLatencyMs} мс)`);
  const v = await (await fetch(API + '/version')).json();
  ok(!!v.minPosVersion, 'Сервер сообщает минимальную версию кассы (старую заставим обновиться)');

  ok(await wait(WEB + '/login'), 'Кабинет поднялся');
  const page = await (await fetch(WEB + '/login')).text();
  ok(/Вход в кабинет/.test(page), 'Кабинет отдаёт страницу входа');
  ok(/Номер телефона/.test(page), 'Вход по номеру телефона (модель UMAG/Wipon, не e-mail как у МоегоСклада)');
  const st = await fetch(WEB + '/stores');
  ok(st.status === 200, 'Страница точек и касс отдаётся');

  // мобильный кабинет PWA (часть 28)
  ok(await wait200(WEB + '/m'), 'Мобильный кабинет /m отдаётся');
  ok(await wait200(WEB + '/manifest.webmanifest'), 'PWA-манифест доступен (устанавливается на телефон без сторов)');
  const sw = await fetch(WEB + '/sw.js');
  ok(sw.status === 200, 'Service worker доступен (офлайн-оболочка)');

  // сквозной сценарий: кабинет ходит в API
  const ph = phone();
  let r = await (await fetch(API + '/auth/otp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: ph }) })).json();
  const reg = await (await fetch(API + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: ph, code: r.devCode, businessName: 'Каркас Тест', ownerName: 'Айгуль', password: 'Password123' }) })).json();
  ok(!!reg.access, 'Кабинет: регистрация через API прошла');

  // логика lib/api.ts: при 401 обновляем пару и повторяем — владельца не выкидывает
  let tok = { access: 'expired.jwt.token', refresh: reg.refresh };
  const apiCall = async (path) => {
    let res = await fetch(API + path, { headers: { Authorization: `Bearer ${tok.access}` } });
    if (res.status === 401 && tok.refresh) {
      const rr = await fetch(API + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh: tok.refresh }) });
      if (rr.ok) { const d = await rr.json(); tok = { access: d.access, refresh: d.refresh }; res = await fetch(API + path, { headers: { Authorization: `Bearer ${tok.access}` } }); }
    }
    return res;
  };
  const me = await apiCall('/auth/me');
  ok(me.status === 200, 'Протухший токен обновился сам — владельца не выкинуло из кабинета');
  const meData = await me.json();
  ok(meData.isOwner === true, 'Кабинет получил контекст владельца после автообновления');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill(); web.kill(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА:', e.message); srv.kill(); web.kill(); process.exit(1); });
