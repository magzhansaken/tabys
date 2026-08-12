'use client';
/**
 * Сотрудники: приём на работу, роли, PIN для кассы, увольнение.
 * PIN — вход кассира на кассе (модель UMAG/Wipon), пароль — вход в кабинет.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Btn, Input, Select, Field, dt, C, ErrLine, Badge } from '../../../lib/ui';

export default function EmployeesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [cons, setCons] = useState<any[]>([]);
  const [cform, setCform] = useState<any>({});
  const [form, setForm] = useState<any>({ roleCode: 'cashier', canLoginPos: true });
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
    setErr(''); setMsg('');
    try {
      const r = await api('/auth/employees', { method: 'POST', body: JSON.stringify({
        firstName: form.firstName, lastName: form.lastName || undefined, phone: form.phone,
        roleCode: form.roleCode, position: form.position || undefined,
        pin: form.pin || undefined, password: form.password || undefined,
        canLoginAdmin: !!form.password, canLoginPos: true,
      }) });
      setMsg(`${r.first_name} принят(а) на работу${r.pin ? `, PIN для кассы: ${r.pin}` : ''}`);
      setForm({ roleCode: 'cashier', canLoginPos: true }); load();
    } catch (e: any) { setErr(e.message); }
  };

  const dismiss = async (id: string, active: boolean) => {
    setErr(''); setMsg('');
    try { await api(`/auth/employees/${id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !active }) }); load(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>Сотрудники</h1>
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      <Card title="Принять на работу" style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Имя"><Input value={form.firstName ?? ''} w={140} onChange={(e: any) => setForm({ ...form, firstName: e.target.value })} /></Field>
          <Field label="Телефон"><Input value={form.phone ?? ''} w={150} placeholder="+7701…" onChange={(e: any) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Роль">
            <Select value={form.roleCode} onChange={(e: any) => setForm({ ...form, roleCode: e.target.value })}
              options={roles.filter((r: any) => r.code !== 'owner').map((r: any) => ({ value: r.code, label: r.name }))} />
          </Field>
          <Field label="PIN кассы (4 цифры)"><Input value={form.pin ?? ''} w={90} maxLength={4} onChange={(e: any) => setForm({ ...form, pin: e.target.value })} /></Field>
          <Field label="Пароль кабинета (если нужен)"><Input type="password" value={form.password ?? ''} w={160} onChange={(e: any) => setForm({ ...form, password: e.target.value })} /></Field>
          <Btn onClick={hire} disabled={!form.firstName || !form.phone}>Принять</Btn>
        </div>
      </Card>

      <Card title="Команда" style={{ marginTop: 14 }}>
        <DataTable storageKey="employees" exportName="employees"           cols={[
            { h: 'Имя', r: (r) => <span>{r.first_name} {r.last_name ?? ''} {r.is_owner && <Badge tone="ok">владелец</Badge>}</span> },
            { h: 'Роль', r: (r) => r.role_name ?? r.role_code },
            { h: 'Телефон', k: 'phone' },
            { h: 'Касса', r: (r) => r.can_login_pos ? (r.has_pin ? <Badge tone="ok">PIN задан</Badge> : <Badge tone="warn">без PIN</Badge>) : '—' },
            { h: 'Кабинет', r: (r) => r.can_login_admin ? 'да' : '—' },
            { h: 'Последний вход', r: (r) => dt(r.last_login_at) },
            { h: '', r: (r) => r.is_owner ? null : (
              <Btn kind={r.is_active ? 'danger' : 'ghost'} onClick={() => dismiss(r.id, r.is_active)}>
                {r.is_active ? 'Уволить' : 'Вернуть'}
              </Btn>
            ) },
          ]}
          rows={rows} />
      </Card>

      <Card title="Продавцы-консультанты" style={{ marginTop: 14 }}>
        <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0 }}>
          Указываются в чеке «кто обслужил». Процент считается автоматически в
          Отчёты → Консультанты (в UMAG это пришлось бы считать вручную).
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <Field label="Имя"><Input value={cform.name ?? ''} w={160} onChange={(e: any) => setCform({ ...cform, name: e.target.value })} /></Field>
          <Field label="Телефон"><Input value={cform.phone ?? ''} w={140} onChange={(e: any) => setCform({ ...cform, phone: e.target.value })} /></Field>
          <Field label="Процент с продаж"><Input type="number" value={cform.pct ?? ''} w={90} placeholder="0" onChange={(e: any) => setCform({ ...cform, pct: e.target.value })} /></Field>
          <Btn onClick={hireConsultant} disabled={!cform.name}>Добавить</Btn>
        </div>
        <DataTable storageKey="employees-2" exportName="employees-2" empty="Продавцов пока нет"
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
