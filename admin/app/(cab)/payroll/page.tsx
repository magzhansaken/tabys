'use client';
/**
 * Зарплата (часть 24). Ведомость «к выплате» = оклад/смены + комиссия
 * консультанта в одном месте — то, чего нет у конкурентов (UMAG считает
 * консультантов в Excel). Выплата ложится на движение денег статьёй «Зарплата».
 *
 * Невыплаченное отличается от выплаченного не только словом: сумма долга
 * идёт цветом предупреждения, потому что это деньги, которые магазин ещё
 * должен людям.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Btn, Field,
  confirmDanger, money, dt, C, ErrLine, Badge } from '../../../lib/ui';

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

  const pay = async (row: any) => {
    setErr(''); setMsg('');
    // Выплата необратима и уходит в движение денег — называем последствие.
    if (!confirmDanger(
      `Выплатить ${money(row.totalAccrued)} — ${row.employeeName}?`,
      'Сумма ляжет в расходы статьёй «Зарплата», ведомость закроется. Изменить начисление после выплаты нельзя.',
    )) return;
    try { const res = await api(`/people/payroll/${row.id}/pay`, { method: 'POST', body: '{}' });
      setMsg(`Выплачено ${money(res.paid)}`); load(); }
    catch (e: any) { setErr(e.message); }
  };

  const owed = hist
    .filter((r: any) => r.status !== 'paid')
    .reduce((s: number, r: any) => s + Number(r.totalAccrued ?? 0), 0);
  const toPay = (draft?.rows ?? []).reduce((s: number, r: any) => s + Number(r.accrued ?? 0), 0);

  const fact = tab === 'draft'
    ? `${draft?.rows?.length ?? 0} сотрудников · к начислению ${money(toPay)} за ${from} — ${to}`
    : `${hist.filter((r: any) => r.status !== 'paid').length} ведомостей не выплачено на ${money(owed)}`;

  return (
    <>
      <PageHeader
        title="Зарплата"
        fact={fact}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              style={{ height: 38, padding: '0 10px', borderRadius: 8, border: `1px solid #D8D8CF`, fontSize: 16, fontFamily: 'inherit', color: C.text, background: C.card }} />
            <span style={{ color: C.dim }}>—</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              style={{ height: 38, padding: '0 10px', borderRadius: 8, border: `1px solid #D8D8CF`, fontSize: 16, fontFamily: 'inherit', color: C.text, background: C.card }} />
          </div>
        }
      />
      <ErrLine err={err} />
      {msg && <p style={{ color: C.accentDark, fontSize: 13 }}>{msg}</p>}

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'draft', label: 'К выплате' },
          { key: 'history', label: 'История начислений' },
        ]} />

        {tab === 'draft' && draft && (
          <Card title="Ведомость к выплате">
            <DataTable storageKey="payroll" exportName="payroll" search={false}
              hint="Оклад или смены × ставку плюс комиссия консультанта. Впишите премию или удержание и нажмите «Начислить» — начисление ещё не выплата, деньги уйдут отдельным действием."
              empty="Нет сотрудников с зарплатой. Оклад или ставку за смену задают в карточке сотрудника" cols={[
              { h: 'Сотрудник', r: (r: any) => <><b>{r.name}</b>{r.position && <span style={{ color: C.dim, fontSize: 12.5 }}> · {r.position}</span>}</> },
              { h: 'Отдел', r: (r: any) => r.department ?? <span style={{ color: C.faint }}>—</span> },
              { h: 'База', right: true, r: (r: any) => r.salaryMonthly != null ? money(r.base) + ' (оклад)'
                  : r.salaryPerShift != null ? `${money(r.base)} (${r.shiftsCount}×${money(r.salaryPerShift)})` : '—' },
              { h: 'Комиссия', right: true, r: (r: any) => money(r.commission) },
              { h: 'Премия', r: (r: any) => <input type="number" placeholder="0" style={inp}
                  value={edit[r.employeeId]?.bonus ?? ''} onChange={(e) => setEdit({ ...edit, [r.employeeId]: { ...edit[r.employeeId], bonus: e.target.value } })} /> },
              { h: 'Удержание', r: (r: any) => <input type="number" placeholder="0" style={inp}
                  value={edit[r.employeeId]?.deduction ?? ''} onChange={(e) => setEdit({ ...edit, [r.employeeId]: { ...edit[r.employeeId], deduction: e.target.value } })} /> },
              { h: 'К выплате', right: true, r: (r: any) => {
                  const e = edit[r.employeeId] ?? {};
                  return <b style={{ whiteSpace: 'nowrap' }}>{money(r.accrued + (+e.bonus || 0) - (+e.deduction || 0))}</b>;
                } },
              { h: '', r: (r: any) => <Btn onClick={() => accrue(r)}>Начислить</Btn> },
            ]} rows={draft.rows} />
          </Card>
        )}

        {tab === 'history' && (
          <Card title="История начислений">
            <DataTable storageKey="payroll-2" exportName="payroll-2"
              hint="«Начислено» — это долг магазина перед человеком. Пока ведомость не выплачена, деньги ещё у вас, и в расходах их нет."
              empty="Пока нет начислений" cols={[
              { h: 'Сотрудник', k: 'employeeName' },
              { h: 'Период', r: (r: any) => `${r.periodFrom} — ${r.periodTo}` },
              { h: 'Начислено', right: true, r: (r: any) => (
                  <span style={{ color: r.status === 'paid' ? C.text : C.amber, fontWeight: r.status === 'paid' ? 400 : 600 }}>
                    {money(r.totalAccrued)}
                  </span>
                ) },
              { h: 'Выплачено', right: true, r: (r: any) => Number(r.paidAmount) > 0
                  ? money(r.paidAmount)
                  : <span style={{ color: C.faint }}>—</span> },
              { h: 'Статус', r: (r: any) => r.status === 'paid'
                  ? <Badge tone="ok">выплачено</Badge>
                  : <Badge tone="warn">ждёт выплаты</Badge> },
              { h: '', r: (r: any) => r.status !== 'paid'
                  ? <Btn onClick={() => pay(r)}>Выплатить</Btn> : null },
            ]} rows={hist} />
          </Card>
        )}
      </div>
    </>
  );
}

const inp: any = { width: 90, height: 34, padding: '0 10px', border: `1px solid #D8D8CF`,
  borderRadius: 8, fontSize: 16, fontFamily: 'inherit', textAlign: 'right', color: '#17211D', background: '#fff' };
