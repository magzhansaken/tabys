'use client';
/**
 * Финансы: счета, движение денег, ДДС и прибыли-убытки.
 * Изъятие и внесение владельца отделены от расходов — иначе P&L врёт
 * (типичная ошибка магазинов, о которую спотыкается и UMAG-аудитория).
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, Input, Select, Field, Stat, money, dt, today, monthAgo, C, ErrLine } from '../../../lib/ui';

export default function FinancePage() {
  const [tab, setTab] = useState('flow');
  const [accounts, setAccounts] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [flow, setFlow] = useState<any>(null);
  const [pnl, setPnl] = useState<any>(null);
  const [from, setFrom] = useState(monthAgo());
  const [to, setTo] = useState(today());
  const [op, setOp] = useState<any>({ kind: 'expense' });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      setAccounts(((await api('/finance/accounts')) as any)?.items ?? []);
      if (tab === 'flow') setFlow(await api(`/finance/cash-flow?from=${from}&to=${to}`));
      if (tab === 'pnl') setPnl(await api(`/finance/pnl?from=${from}&to=${to}`));
      if (tab === 'history') setHistory(await api(`/finance/history?from=${from}&to=${to}&limit=100`));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { setErr(''); load(); }, [tab, from, to]);

  const doOp = async () => {
    setErr(''); setMsg('');
    const path: any = { expense: '/finance/expense', income: '/finance/income',
      draw: '/finance/owner-draw', deposit: '/finance/owner-deposit' };
    try {
      await api(path[op.kind], { method: 'POST',
        body: JSON.stringify({ amount: +op.amount, comment: op.comment || undefined }) });
      setMsg('Операция записана'); setOp({ kind: op.kind }); load();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>Финансы</h1>
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
        {accounts.map((a: any) => (
          <Stat key={a.id} label={a.name ?? a.kind} value={money(a.balance)} sub={a.kind === 'cash' ? 'наличные' : a.kind} />
        ))}
      </div>

      <Card title="Записать операцию" style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Что произошло">
            <Select value={op.kind} onChange={(e: any) => setOp({ ...op, kind: e.target.value })}
              options={[
                { value: 'expense', label: 'Расход (аренда, зарплата…)' },
                { value: 'income', label: 'Прочий приход' },
                { value: 'draw', label: 'Изъятие владельца' },
                { value: 'deposit', label: 'Внесение владельца' },
              ]} />
          </Field>
          <Field label="Сумма, ₸"><Input type="number" value={op.amount ?? ''} w={130} onChange={(e: any) => setOp({ ...op, amount: e.target.value })} /></Field>
          <Field label="Комментарий"><Input value={op.comment ?? ''} w={240} onChange={(e: any) => setOp({ ...op, comment: e.target.value })} /></Field>
          <Btn onClick={doOp} disabled={!op.amount}>Записать</Btn>
        </div>
      </Card>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <Tabs active={tab} onChange={setTab}
                tabs={[{ key: 'flow', label: 'Движение денег' }, { key: 'pnl', label: 'Прибыли и убытки' }, { key: 'history', label: 'История' }]} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: C.dim }}>
            с <Input type="date" value={from} w={140} onChange={(e: any) => setFrom(e.target.value)} />
            по <Input type="date" value={to} w={140} onChange={(e: any) => setTo(e.target.value)} />
          </div>
        </div>

        {tab === 'flow' && flow && (
          <Card>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Stat label="Пришло" value={money(flow.totalIn ?? flow.in)} />
              <Stat label="Ушло" value={money(flow.totalOut ?? flow.out)} />
              <Stat label="Итог периода" value={money(flow.net ?? (Number(flow.totalIn ?? 0) - Number(flow.totalOut ?? 0)))} />
            </div>
            {(((flow.inflow ?? []).length + (flow.outflow ?? []).length) > 0) && (
              <div style={{ marginTop: 14 }}>
                <DataTable storageKey="finance" exportName="finance" cols={[
                  { h: 'Статья', r: (r: any) => r.category ?? r.name ?? '—' },
                  { h: 'Направление', r: (r: any) => r._dir === 'in' ? 'приход' : 'расход' },
                  { h: 'Сумма', right: true, r: (r: any) => money(r.sum ?? r.amount ?? r.total) },
                ]} rows={[
                  ...(flow.inflow ?? []).map((r: any) => ({ ...r, _dir: 'in' })),
                  ...(flow.outflow ?? []).map((r: any) => ({ ...r, _dir: 'out' })),
                ]} />
              </div>
            )}
          </Card>
        )}

        {tab === 'pnl' && pnl && (
          <Card>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Stat label="Выручка" value={money(pnl.revenue?.total)} />
              <Stat label="Себестоимость" value={money(pnl.cost?.total)} />
              <Stat label="Валовая прибыль" value={money(pnl.grossProfit)} />
              <Stat label="Операционные расходы" value={money(pnl.operatingExpenses?.total)} />
              <Stat label="Чистая прибыль" value={money(pnl.netProfit)}
                    tone={Number(pnl.netProfit ?? 0) < 0 ? 'bad' : undefined} />
              <Stat label="Маржа" value={`${pnl.marginPercent ?? 0}%`} />
            </div>
            {/* разбивка выручки по способам оплаты — как «Прибыли и убытки» UMAG */}
            <div style={{ marginTop: 14 }}>
              <DataTable storageKey="finance-2" exportName="finance-2" cols={[
                { h: 'Показатель', k: 'n' },
                { h: 'Сумма', right: true, r: (r: any) => money(r.v) },
              ]} rows={[
                { n: 'Наличными', v: pnl.revenue?.cash },
                { n: 'Картой', v: pnl.revenue?.card },
                { n: 'QR', v: pnl.revenue?.qr },
                { n: 'В долг', v: pnl.revenue?.credit },
                { n: 'Возвраты (минус)', v: pnl.revenue?.refunds },
              ].filter((r) => Number(r.v) > 0)} />
            </div>
            {pnl.note && <p style={{ fontSize: 12, color: C.dim, marginBottom: 0 }}>{pnl.note}</p>}
          </Card>
        )}

        {tab === 'history' && (
          <Card>
            <DataTable storageKey="finance-3" exportName="finance-3" empty="Движений не было"
              cols={[
                { h: 'Когда', r: (r) => dt(r.ts ?? r.created_at) },
                { h: 'Что', r: (r) => r.kind ?? r.type },
                { h: 'Комментарий', r: (r) => r.comment ?? '—' },
                { h: 'Сумма', right: true, r: (r) => {
                  const v = Number(r.amount);
                  const isOut = (r.direction ?? (v < 0 ? 'out' : 'in')) === 'out';
                  return <span style={{ color: isOut ? C.red : C.accentDark }}>{isOut ? '−' : '+'}{money(Math.abs(v))}</span>;
                } },
              ]}
              rows={history} />
          </Card>
        )}
      </div>
    </>
  );
}
