'use client';
/**
 * Зарплата (часть 24). Ведомость «к выплате» = оклад/смены + комиссия
 * консультанта в одном месте — то, чего нет у конкурентов (UMAG считает
 * консультантов в Excel). Выплата ложится на движение денег статьёй «Зарплата».
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, Field, money, dt, C, ErrLine, Badge } from '../../../lib/ui';

export default function PayrollPage() {
  const now = new Date();
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const today = now.toISOString().slice(0, 10);
  const [tab, setTab] = useState('draft');
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [draft, setDraft] = useState<any>(null);
  const [hist, setHist] = useState<any[]>([]);
  const [edit, setEdit] = useState<Record<string, any>>({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setErr('');
    try {
      if (tab === 'draft') setDraft(await api(`/people/payroll/draft?from=${from}&to=${to}`));
      if (tab === 'history') setHist(await api('/people/payroll'));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [tab, from, to]);

  const accrue = async (row: any) => {
    setErr(''); setMsg('');
    const e = edit[row.employeeId] ?? {};
    try {
      const res = await api('/people/payroll/accrue', { method: 'POST', body: JSON.stringify({
        employeeId: row.employeeId, from, to, base: row.base, shiftsCount: row.shiftsCount,
        commission: row.commission, bonus: e.bonus ? +e.bonus : 0, deduction: e.deduction ? +e.deduction : 0,
        comment: e.comment }) });
      setMsg(`Начислено ${money(res.totalAccrued)} для ${row.name}`);
      setTab('history');
    } catch (e: any) { setErr(e.message); }
  };

  const pay = async (id: string) => {
    setErr(''); setMsg('');
    try { const res = await api(`/people/payroll/${id}/pay`, { method: 'POST', body: '{}' });
      setMsg(`Выплачено ${money(res.paid)}`); load(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Зарплата</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            style={{ padding: '6px 8px', borderRadius: 8, border: `1px solid ${C.line}` }} />
          <span style={{ color: C.dim }}>—</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            style={{ padding: '6px 8px', borderRadius: 8, border: `1px solid ${C.line}` }} />
        </div>
      </div>
      <ErrLine err={err} />
      {msg && <p style={{ color: C.accentDark, fontSize: 13 }}>{msg}</p>}

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'draft', label: 'К выплате' },
          { key: 'history', label: 'История начислений' },
        ]} />

        {tab === 'draft' && draft && (
          <Card title="Ведомость к выплате">
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Оклад или смены × ставку + комиссия консультанта. Впишите премию
              или удержание и нажмите «Начислить». Задать оклад можно в карточке
              сотрудника.
            </p>
            <DataTable storageKey="payroll" exportName="payroll" empty="Нет сотрудников с зарплатой" cols={[
              { h: 'Сотрудник', r: (r: any) => <><b>{r.name}</b>{r.position && <span style={{ color: C.dim, fontSize: 12 }}> · {r.position}</span>}</> },
              { h: 'Отдел', r: (r: any) => r.department ?? '—' },
              { h: 'База', right: true, r: (r: any) => r.salaryMonthly != null ? money(r.base) + ' (оклад)'
                  : r.salaryPerShift != null ? `${money(r.base)} (${r.shiftsCount}×${money(r.salaryPerShift)})` : '—' },
              { h: 'Комиссия', right: true, r: (r: any) => money(r.commission) },
              { h: 'Премия', r: (r: any) => <input type="number" placeholder="0" style={inp}
                  value={edit[r.employeeId]?.bonus ?? ''} onChange={(e) => setEdit({ ...edit, [r.employeeId]: { ...edit[r.employeeId], bonus: e.target.value } })} /> },
              { h: 'Удержание', r: (r: any) => <input type="number" placeholder="0" style={inp}
                  value={edit[r.employeeId]?.deduction ?? ''} onChange={(e) => setEdit({ ...edit, [r.employeeId]: { ...edit[r.employeeId], deduction: e.target.value } })} /> },
              { h: 'К выплате', right: true, r: (r: any) => {
                  const e = edit[r.employeeId] ?? {};
                  return <b>{money(r.accrued + (+e.bonus || 0) - (+e.deduction || 0))}</b>;
                } },
              { h: '', r: (r: any) => <Btn onClick={() => accrue(r)}>Начислить</Btn> },
            ]} rows={draft.rows} />
          </Card>
        )}

        {tab === 'history' && (
          <Card title="История начислений">
            <DataTable storageKey="payroll-2" exportName="payroll-2" empty="Пока нет начислений" cols={[
              { h: 'Сотрудник', k: 'employeeName' },
              { h: 'Период', r: (r: any) => `${r.periodFrom} — ${r.periodTo}` },
              { h: 'Начислено', right: true, r: (r: any) => money(r.totalAccrued) },
              { h: 'Выплачено', right: true, r: (r: any) => money(r.paidAmount) },
              { h: 'Статус', r: (r: any) => r.status === 'paid'
                  ? <Badge tone="ok">выплачено</Badge>
                  : <Badge tone="warn">начислено</Badge> },
              { h: '', r: (r: any) => r.status !== 'paid'
                  ? <Btn onClick={() => pay(r.id)}>Выплатить</Btn> : null },
            ]} rows={hist} />
          </Card>
        )}
      </div>
    </>
  );
}

const inp: any = { width: 80, padding: '6px 8px', border: '1px solid #e2e4e9', borderRadius: 6 };
