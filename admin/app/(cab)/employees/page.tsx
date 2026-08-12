'use client';
/**
 * Сотрудники: приём на работу, роли, PIN для кассы, увольнение.
 * PIN — вход кассира на кассе (модель UMAG/Wipon), пароль — вход в кабинет.
 *
 * PIN показывается через RevealOnce: сервер возвращает его один раз, при
 * приёме на работу. Если человек закрыл экран и не записал — PIN придётся
 * задавать заново, и кассир до этого за кассу не встанет.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, RevealOnce, Btn, Input, Select, Field,
  confirmDanger, dt, C, ErrLine, Badge } from '../../../lib/ui';

/** Что роль означает словами. Матрица галочек этого не объясняет: 56 клеток
 *  читаются как шум, а «кассиру отчёты не нужны» — за секунду. */
const ROLE_NOTE: Record<string, string> = {
  owner: 'Может всё. Роль одна на магазин и не снимается — иначе некому будет вернуть доступ остальным.',
  admin: 'Всё то же, что владелец, кроме смены тарифа и удаления магазина. Ставьте тому, кто ведёт учёт вместо вас.',
  cashier: 'Касса, товары и покупатели — и всё. Ни отчётов, ни закупочных цен, ни денег: чтобы работать за прилавком, знать их не нужно.',
  accountant: 'Деньги, документы и отчёты. Товары и кассу не трогает.',
  storekeeper: 'Склад и приёмка. Выручку и зарплаты не видит.',
};

export default function EmployeesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [cons, setCons] = useState<any[]>([]);
  const [cform, setCform] = useState<any>({});
  const [form, setForm] = useState<any>({ roleCode: 'cashier', canLoginPos: true });
  const [hired, setHired] = useState<any>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      setRows(await api('/auth/employees'));
      setRoles(await api('/auth/roles'));
      setCons(await api('/admin/consultants'));
    } catch (e: any) { setErr(e.message); }
  };

  const hireConsultant = async () => {
    setErr(''); setMsg('');
    try {
      await api('/admin/consultants', { method: 'POST', body: JSON.stringify({
        name: cform.name, phone: cform.phone || undefined,
        commissionPercent: cform.pct ? +cform.pct : 0 }) });
      setMsg(`Продавец «${cform.name}» добавлен`); setCform({}); load();
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const hire = async () => {
    setErr(''); setMsg(''); setHired(null);
    try {
      const r = await api('/auth/employees', { method: 'POST', body: JSON.stringify({
        firstName: form.firstName, lastName: form.lastName || undefined, phone: form.phone,
        roleCode: form.roleCode, position: form.position || undefined,
        pin: form.pin || undefined, password: form.password || undefined,
        canLoginAdmin: !!form.password, canLoginPos: true,
      }) });
      if (r.pin) setHired({ name: r.first_name, pin: r.pin });
      else setMsg(`${r.first_name} принят(а) на работу`);
      setForm({ roleCode: 'cashier', canLoginPos: true }); load();
    } catch (e: any) { setErr(e.message); }
  };

  const dismiss = async (id: string, active: boolean, name: string) => {
    setErr(''); setMsg('');
    // Подтверждение называет последствие, а не спрашивает «вы уверены?».
    // Главное здесь — что чеки и смены остаются: без этой строки увольнение
    // выглядит как удаление истории продаж, и его боятся нажимать.
    if (active && !confirmDanger(
      `Уволить ${name}?`,
      'Вход на кассу и в кабинет закроется сразу. Чеки, смены и начисления останутся на месте — вернуть сотрудника можно одной кнопкой.',
    )) return;
    try { await api(`/auth/employees/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !active }) }); load(); }
    catch (e: any) { setErr(e.message); }
  };

  const working = rows.filter((r: any) => r.is_active).length;
  const noPin = rows.filter((r: any) => r.is_active && r.can_login_pos && !r.has_pin).length;
  const roleNote = ROLE_NOTE[form.roleCode];

  return (
    <>
      <PageHeader
        title="Сотрудники"
        fact={`${working} в команде · ${cons.length} продавцов-консультантов${noPin ? ` · ${noPin} без PIN` : ''}`}
      />
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      {hired && (
        <div style={{ marginTop: 14 }}>
          <RevealOnce
            title={`${hired.name} принят(а) на работу. PIN для кассы`}
            value={hired.pin}
            note="Продиктуйте PIN сотруднику сейчас: мы храним его отпечаток, а не сам код, и показать повторно не сможем. Потеряется — задайте новый в карточке, до этого за кассу человек не встанет."
          />
          <div style={{ marginTop: 10 }}>
            <Btn kind="ghost" onClick={() => setHired(null)}>Записал, закрыть</Btn>
          </div>
        </div>
      )}

      <Card title="Принять на работу" style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Имя"><Input value={form.firstName ?? ''} w={140} onChange={(e: any) => setForm({ ...form, firstName: e.target.value })} /></Field>
          <Field label="Телефон"><Input value={form.phone ?? ''} w={168} placeholder="+7 701…" onChange={(e: any) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Роль">
            <Select value={form.roleCode} onChange={(e: any) => setForm({ ...form, roleCode: e.target.value })}
              options={roles.filter((r: any) => r.code !== 'owner').map((r: any) => ({ value: r.code, label: r.name }))} />
          </Field>
          <Field label="PIN кассы (4 цифры)"><Input value={form.pin ?? ''} w={110} maxLength={4} style={{ textAlign: 'right' }} onChange={(e: any) => setForm({ ...form, pin: e.target.value })} /></Field>
          <Field label="Пароль кабинета (если нужен)"><Input type="password" value={form.password ?? ''} w={180} onChange={(e: any) => setForm({ ...form, password: e.target.value })} /></Field>
          <Btn onClick={hire} disabled={!form.firstName || !form.phone}>Принять</Btn>
        </div>
        {roleNote && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.lineIn}`,
            display: 'flex', gap: 11, alignItems: 'flex-start' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.accent, flex: '0 0 7px', marginTop: 7 }} />
            <div style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.6, maxWidth: '80ch' }}>{roleNote}</div>
          </div>
        )}
      </Card>

      <Card title="Команда" style={{ marginTop: 14 }}>
        <DataTable storageKey="employees" exportName="employees"
          hint="PIN из четырёх цифр — чтобы встать за кассу. Пароль — чтобы зайти в кабинет с деньгами и отчётами. Кассиру пароль не нужен."
          empty="В команде пока только вы — примите первого сотрудника"
          cols={[
            { h: 'Имя', r: (r) => <span>{r.first_name} {r.last_name ?? ''} {r.is_owner && <Badge tone="ok">владелец</Badge>}</span> },
            { h: 'Роль', r: (r) => r.role_name ?? r.role_code },
            { h: 'Телефон', k: 'phone' },
            { h: 'Касса', r: (r) => r.can_login_pos ? (r.has_pin ? <Badge tone="ok">PIN задан</Badge> : <Badge tone="warn">Без PIN</Badge>) : '—' },
            { h: 'Кабинет', r: (r) => r.can_login_admin ? 'да' : <span style={{ color: C.faint }}>—</span> },
            { h: 'Последний вход', r: (r) => r.last_login_at ? dt(r.last_login_at) : <span style={{ color: C.faint }}>ни разу</span> },
            { h: '', r: (r) => r.is_owner ? null : (
              <Btn kind={r.is_active ? 'danger' : 'ghost'}
                onClick={() => dismiss(r.id, r.is_active, `${r.first_name} ${r.last_name ?? ''}`.trim())}>
                {r.is_active ? 'Уволить' : 'Вернуть'}
              </Btn>
            ) },
          ]}
          rows={rows} />
      </Card>

      <Card title="Продавцы-консультанты" style={{ marginTop: 14 }}>
        <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55 }}>
          Указываются в чеке «кто обслужил». Процент считается автоматически в
          Отчёты → Консультанты (в UMAG это пришлось бы считать вручную).
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <Field label="Имя"><Input value={cform.name ?? ''} w={160} onChange={(e: any) => setCform({ ...cform, name: e.target.value })} /></Field>
          <Field label="Телефон"><Input value={cform.phone ?? ''} w={168} onChange={(e: any) => setCform({ ...cform, phone: e.target.value })} /></Field>
          <Field label="Процент с продаж"><Input type="number" value={cform.pct ?? ''} w={110} placeholder="0" style={{ textAlign: 'right' }} onChange={(e: any) => setCform({ ...cform, pct: e.target.value })} /></Field>
          <Btn onClick={hireConsultant} disabled={!cform.name}>Добавить</Btn>
        </div>
        <DataTable storageKey="employees-2" exportName="employees-2" search={false}
          empty="Продавцов пока нет — добавьте, если платите процент с продаж"
          cols={[
            { h: 'Имя', k: 'name' },
            { h: 'Телефон', k: 'phone' },
            { h: 'Процент', right: true, r: (r) => `${r.commission_percent}%` },
            { h: 'Статус', r: (r) => r.is_active ? <Badge tone="ok">работает</Badge> : <Badge tone="dim">выключен</Badge> },
          ]}
          rows={cons} />
      </Card>
    </>
  );
}
