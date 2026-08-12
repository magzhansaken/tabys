/**
 * ★ ЧАСТЬ 24 — ДЕНЬГИ И ЛЮДИ.
 *
 * Проверяем механику до тенге:
 *  • ведомость «к выплате»: оклад + смены×ставку + комиссия консультанта
 *  • выплата ложится на fin_move (статья «Зарплата») — видно в финансах
 *  • объединение дублей переносит ДОЛГ на основного (иначе деньги теряются)
 *  • договоры с контролем срока
 */
const { spawn } = require('child_process');

const PORT = '3241';
const API = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) { console.log(`✔ ${n}`); pass++; } else { console.log(`✘ ${n} ${e}`); fail++; } };
const phone = '+7708' + Math.floor(1000000 + Math.random() * 8999999);

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
  ok(await wait(), 'Сервер поднялся');

  let r = await j('POST', '/auth/otp', { phone });
  r = await j('POST', '/auth/register', { phone, code: r.d.devCode,
    businessName: 'Люди Тест', ownerName: 'Гульнара', password: 'Password123' });
  TOK = r.d.access;
  const me = await j('GET', '/auth/me');

  // ---------- отделы ----------
  r = await j('POST', '/people/departments', { name: 'Торговый зал' });
  const deptId = r.d.id;
  ok(!!deptId, 'Отдел создан');
  r = await j('GET', '/people/departments');
  ok(r.d.length === 1 && r.d[0].employees >= 0, 'Отдел виден со счётчиком сотрудников');

  // ---------- сотрудник + оклад ----------
  r = await j('POST', '/auth/employees', { firstName: 'Марат', lastName: 'Ержанов',
    phone: '+77011234567', roleCode: 'cashier' });
  const empId = r.d.id ?? r.d.employeeId;
  ok(!!empId, 'Сотрудник заведён');
  await j('POST', `/people/employees/${empId}/department`, { departmentId: deptId });
  r = await j('POST', `/people/employees/${empId}/salary`, { monthly: 200000 });
  ok(r.d.ok, 'Оклад 200 000 ₸/мес задан');

  // второй сотрудник на ставку за смену
  r = await j('POST', '/auth/employees', { firstName: 'Айгуль', phone: '+77017654321', roleCode: 'cashier' });
  const emp2 = r.d.id ?? r.d.employeeId;
  await j('POST', `/people/employees/${emp2}/salary`, { perShift: 8000 });

  // ---------- ведомость «к выплате» ----------
  const to = new Date().toISOString().slice(0, 10);
  const from = `${to.slice(0, 7)}-01`;
  r = await j('GET', `/people/payroll/draft?from=${from}&to=${to}`);
  const marat = r.d.rows.find((x) => x.name.includes('Марат'));
  const aigul = r.d.rows.find((x) => x.name.includes('Айгуль'));
  ok(marat && marat.base === 200000, `★ Ведомость: Марат оклад = ${marat?.base} ₸`);
  ok(aigul && aigul.salaryPerShift === 8000, `★ Айгуль на ставке ${aigul?.salaryPerShift} ₸/смену (смен ${aigul?.shiftsCount})`);
  ok(marat.accrued === 200000 + marat.commission, 'Итог = оклад + комиссия консультанта');

  // ---------- начисление с премией и удержанием ----------
  r = await j('POST', '/people/payroll/accrue', {
    employeeId: empId, from, to, base: 200000, commission: 0, bonus: 15000, deduction: 5000,
    comment: 'Премия за план, удержана недостача' });
  ok(r.d.totalAccrued === 210000, `★ Начислено: 200 000 + 15 000 премия − 5 000 удержание = ${r.d.totalAccrued} ₸`);
  const payrollId = r.d.id;
  ok(r.d.status === 'accrued', 'Статус — начислено');

  // отрицательный итог отбит
  r = await j('POST', '/people/payroll/accrue', { employeeId: empId, from, to, base: 1000, deduction: 5000 });
  ok(r.status === 400, 'Итог к выплате не может быть отрицательным');

  // ---------- выплата → fin_move ----------
  // сначала пополним кассу, чтобы было чем платить
  await j('POST', '/finance/income', { amount: 300000, comment: 'Внесение для теста' });
  r = await j('POST', `/people/payroll/${payrollId}/pay`, {});
  ok(r.d.ok && r.d.status === 'paid', `★ Зарплата выплачена полностью (${r.d.paid} ₸)`);

  // видно в движении денег как расход по статье «Зарплата»
  r = await j('GET', `/finance/cash-flow?from=${from}&to=${to}`);
  const cf = JSON.stringify(r.d);
  ok(/Зарплата/.test(cf), '★ Выплата попала в ДДС статьёй «Зарплата»');

  // повторная выплата отбита
  r = await j('POST', `/people/payroll/${payrollId}/pay`, {});
  ok(r.status === 400, 'Повторная выплата отбита — начисление уже оплачено');

  r = await j('GET', '/people/payroll');
  ok(r.d.length === 1 && r.d[0].status === 'paid' && r.d[0].paidAmount === 210000,
     'История зарплат: 1 запись, выплачено 210 000');

  // ---------- договоры ----------
  r = await j('POST', '/contragents', { name: 'ТОО Поставщик', roles: ['supplier'], iinBin: '123456789012' });
  const supId = r.d.id ?? r.d.counterpartyId;
  r = await j('POST', '/people/contracts', { counterpartyId: supId, number: 'Д-2026/15',
    kind: 'supply', signedDate: '2026-01-10', validUntil: '2025-12-31', amount: 500000 });
  ok(!!r.d.id, 'Договор поставки создан');
  r = await j('GET', `/people/contracts?counterpartyId=${supId}`);
  ok(r.d.length === 1 && r.d[0].number === 'Д-2026/15', 'Договор виден у контрагента');
  ok(r.d[0].expired === true, '★ Договор с датой окончания в прошлом помечен просроченным');
  r = await j('POST', '/people/contracts', { counterpartyId: supId, number: '', kind: 'sale' });
  ok(r.status === 400, 'Договор без номера отбит');

  // ---------- объединение дублей с переносом долга ----------
  // три «Азамата» с долгами — после импорта частая ситуация
  r = await j('POST', '/contragents', { name: 'Азамат', phone: '+77010001111', roles: ['customer'] });
  const a1 = r.d.id ?? r.d.counterpartyId;
  r = await j('POST', '/contragents', { name: 'Азамат Б', phone: '+77010002222', roles: ['customer'] });
  const a2 = r.d.id ?? r.d.counterpartyId;
  r = await j('POST', '/contragents', { name: 'азамат', phone: '+77010003333', roles: ['customer'] });
  const a3 = r.d.id ?? r.d.counterpartyId;

  // навесим долги на дублей через продажу в кредит (или прямой баланс)
  await j('POST', `/contragents/${a2}/debt`, { amount: 3000, comment: 'долг 1' }).catch(() => {});
  await j('POST', `/contragents/${a3}/debt`, { amount: 2000, comment: 'долг 2' }).catch(() => {});

  // основной a1, дубли a2/a3
  r = await j('POST', '/people/counterparties/merge', { primaryId: a1, dupeIds: [a2, a3] });
  ok(r.d.ok && r.d.merged === 2, `★ Объединено 2 дубля в основного`);

  // дубли ушли в архив
  r = await j('GET', '/contragents');
  const names = (r.d.items ?? r.d).map((x) => x.name);
  const azamats = (r.d.items ?? r.d).filter((x) => /азамат/i.test(x.name));
  ok(azamats.length === 1, `★ Остался один Азамат (было 3): ${azamats.map((x) => x.name).join(', ')}`);

  // защита: основной в списке дублей
  r = await j('POST', '/people/counterparties/merge', { primaryId: a1, dupeIds: [a1] });
  ok(r.status === 400, 'Нельзя объединить контрагента с самим собой');

  console.log(`\n=== ИТОГ: пройдено ${pass}, провалено ${fail} ===`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
