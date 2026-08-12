'use client';
/**
 * Финансы: счета, движение денег, ДДС и прибыли-убытки.
 * Изъятие и внесение владельца отделены от расходов — иначе P&L врёт
 * (типичная ошибка магазинов, о которую спотыкается и UMAG-аудитория).
 *
 * Приход и расход различаются не только знаком: владелец смотрит по
 * диагонали, и «+128 400» от «−128 400» на скорости не отличить. Поэтому
 * расход красным, приход изумрудным — во всех трёх таблицах одинаково.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Btn, Input, Select, Field, Stat,
  money, dt, today, monthAgo, C, ErrLine } from '../../../lib/ui';

/** Сумма с направлением. Одно место — одинаково во всех таблицах раздела. */
function Money({ v, out }: { v: any; out: boolean }) {
  return (
    <span style={{ color: out ? C.red : C.accentDark, fontWeight: 500, whiteSpace: 'nowrap' }}>
      {out ? '−' : '+'}{money(Math.abs(Number(v) || 0))}
    </span>
  );
}

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

  const total = accounts.reduce((s: number, a: any) => s + Number(a.balance ?? 0), 0);
  const negative = accounts.filter((a: any) => Number(a.balance) < 0).length;
  const fact = accounts.length
    ? `${accounts.length} счетов · всего ${money(total)}${negative ? ` · ${negative} в минусе` : ''}`
    : 'Счета ещё не заведены';

  return (
    <>
      <PageHeader
        title="Финансы"
        fact={fact}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: C.dim }}>
            с <Input type="date" value={from} w={150} onChange={(e: any) => setFrom(e.target.value)} />
            по <Input type="date" value={to} w={150} onChange={(e: any) => setTo(e.target.value)} />
          </div>
        }
      />
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {accounts.map((a: any) => (
          <Stat key={a.id} label={a.name ?? a.kind} value={money(a.balance)}
            tone={Number(a.balance) < 0 ? 'bad' : undefined}
            sub={Number(a.balance) < 0 ? 'минус — проверьте, всё ли записано' : (a.kind === 'cash' ? 'наличные' : a.kind)} />
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
          <Field label="Сумма, ₸"><Input type="number" value={op.amount ?? ''} w={140} style={{ textAlign: 'right' }} onChange={(e: any) => setOp({ ...op, amount: e.target.value })} /></Field>
          <Field label="Комментарий"><Input value={op.comment ?? ''} w={280} onChange={(e: any) => setOp({ ...op, comment: e.target.value })} /></Field>
          <Btn onClick={doOp} disabled={!op.amount}>Записать</Btn>
        </div>
        <p style={{ fontSize: 13, color: C.dim, margin: '14px 0 0', lineHeight: 1.6, maxWidth: '84ch' }}>
          Деньги, взятые владельцем на себя, — это <b>изъятие</b>, а не расход магазина.
          Записав их расходом, вы занизите прибыль и потом не поймёте, почему магазин
          «не зарабатывает». Это самая частая ошибка в учёте у дома.
        </p>
      </Card>

      <div style={{ marginTop: 16 }}>
        <Tabs active={tab} onChange={setTab}
              tabs={[{ key: 'flow', label: 'Движение денег' }, { key: 'pnl', label: 'Прибыли и убытки' }, { key: 'history', label: 'История' }]} />

        {tab === 'flow' && flow && (
          <Card>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Stat label="Пришло" value={money(flow.totalIn ?? flow.in)} sub="за выбранный период" />
              <Stat label="Ушло" value={money(flow.totalOut ?? flow.out)} sub="за выбранный период" />
              <Stat label="Итог периода"
                value={money(flow.net ?? (Number(flow.totalIn ?? 0) - Number(flow.totalOut ?? 0)))}
                tone={Number(flow.net ?? (Number(flow.totalIn ?? 0) - Number(flow.totalOut ?? 0))) < 0 ? 'bad' : undefined}
                sub="сколько денег прибавилось или убыло" />
            </div>
            {(((flow.inflow ?? []).length + (flow.outflow ?? []).length) > 0) && (
              <div style={{ marginTop: 18 }}>
                <DataTable storageKey="finance" exportName="finance"
                  hint="Расходы красным, приходы изумрудным. Самая крупная строка расхода — первое, что стоит проверить: обычно там аренда или закуп."
                  empty="За период денег не приходило и не уходило. Если продажи были, проверьте, что кассы передали данные."
                  cols={[
                    { h: 'Статья', r: (r: any) => r.category ?? r.name ?? '—' },
                    { h: 'Направление', r: (r: any) => (
                        <span style={{ color: r._dir === 'in' ? C.accentDark : C.red }}>
                          {r._dir === 'in' ? 'приход' : 'расход'}
                        </span>
                      ) },
                    { h: 'Сумма', right: true, r: (r: any) => <Money v={r.sum ?? r.amount ?? r.total} out={r._dir !== 'in'} /> },
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
                    tone={Number(pnl.netProfit ?? 0) < 0 ? 'bad' : undefined}
                    sub="после всех расходов" />
              <Stat label="Маржа" value={`${pnl.marginPercent ?? 0}%`} />
            </div>
            {/* разбивка выручки по способам оплаты — как «Прибыли и убытки» UMAG */}
            <div style={{ marginTop: 18 }}>
              <DataTable storageKey="finance-2" exportName="finance-2" search={false}
                hint="«В долг» — это выручка, которой у вас пока нет на руках. Она уже в прибыли, но ещё не в кассе."
                empty="Продаж за период не было — разбивать по способам оплаты нечего"
                cols={[
                  { h: 'Показатель', k: 'n' },
                  { h: 'Сумма', right: true, r: (r: any) => r.minus
                      ? <Money v={r.v} out />
                      : <span style={{ whiteSpace: 'nowrap' }}>{money(r.v)}</span> },
                ]} rows={[
                  { n: 'Наличными', v: pnl.revenue?.cash },
                  { n: 'Картой', v: pnl.revenue?.card },
                  { n: 'QR', v: pnl.revenue?.qr },
                  { n: 'В долг', v: pnl.revenue?.credit },
                  { n: 'Возвраты', v: pnl.revenue?.refunds, minus: true },
                ].filter((r) => Number(r.v) > 0)} />
            </div>
            {pnl.note && <p style={{ fontSize: 12.5, color: C.dim, marginBottom: 0, lineHeight: 1.55 }}>{pnl.note}</p>}
          </Card>
        )}

        {tab === 'history' && (
          <Card>
            <DataTable storageKey="finance-3" exportName="finance-3"
              hint="Каждая строка — деньги, которые пришли или ушли. Если итог не сходится с кассой, ищите здесь: обычно забыли записать расход."
              empty="Движений не было — запишите первую операцию выше"
              cols={[
                { h: 'Когда', r: (r) => dt(r.ts ?? r.created_at) },
                { h: 'Что', r: (r) => r.kind ?? r.type },
                { h: 'Комментарий', r: (r) => r.comment ?? <span style={{ color: C.faint }}>—</span> },
                { h: 'Сумма', right: true, r: (r) => {
                  const v = Number(r.amount);
                  const isOut = (r.direction ?? (v < 0 ? 'out' : 'in')) === 'out';
                  return <Money v={v} out={isOut} />;
                } },
              ]}
              rows={history} />
          </Card>
        )}
      </div>
    </>
  );
}
