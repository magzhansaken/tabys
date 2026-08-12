'use client';
/**
 * Показатели дня — модель «Главной» UMAG: выручка, прибыль, чеки, средний
 * чек, долги, критические остатки. Плюс график выручки по дням.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Stat, Table, DataTable, PeriodPicker, money, num, C, ErrLine } from '../../../lib/ui';

export default function Dashboard() {
  const [period, setPeriod] = useState('today');
  const [d, setD] = useState<any>(null);
  const [chart, setChart] = useState<any[]>([]);
  const [low, setLow] = useState<any[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        setErr('');
        setD(await api(`/reports/dashboard?period=${period}`));
        const ch = await api(`/reports/revenue-chart?period=${period === 'today' || period === 'yesterday' ? 'week' : period}`);
        setChart(Array.isArray(ch) ? ch : ch.days ?? []);
        setLow(await api('/stock/low'));
      } catch (e: any) { setErr(e.message); }
    })();
  }, [period]);

  const max = Math.max(1, ...chart.map((x: any) => Number(x.revenue ?? x.sum ?? 0)));

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Показатели</h1>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>
      <ErrLine err={err} />
      <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
        <Stat label="Выручка" value={money(d?.revenue)} sub={`Чеков: ${d?.receipts ?? '—'}`} />
        <Stat label="Прибыль" value={money(d?.profit)} sub={d?.margin != null ? `Наценка ${num(d.margin)}%` : undefined} />
        <Stat label="Средний чек" value={money(d?.avgReceipt)} />
        <Stat label="Возвраты" value={money(d?.refunds)} tone={Number(d?.refunds) > 0 ? 'bad' : undefined} />
        <Stat label="Продано в долг" value={money(d?.debtSales)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
        <Card title="Выручка по дням">
          {chart.length === 0 ? <div style={{ color: C.dim, fontSize: 14 }}>Продаж за период не было</div> : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 140 }}>
              {chart.map((x: any, i: number) => {
                const v = Number(x.revenue ?? x.sum ?? 0);
                return (
                  <div key={i} title={`${x.day ?? x.date ?? ''}: ${money(v)}`}
                       style={{ flex: 1, background: '#bfe9da', borderRadius: '4px 4px 0 0',
                         height: `${Math.max(3, (v / max) * 100)}%` }} />
                );
              })}
            </div>
          )}
        </Card>
        <Card title="Критические остатки" right={<a href="/stock" style={{ fontSize: 13, color: C.accentDark }}>Пополнить</a>}>
          <DataTable storageKey="dashboard" exportName="dashboard" empty="Все товары в достатке"
            cols={[
              { h: 'Товар', k: 'name' },
              { h: 'Остаток', right: true, r: (r) => num(r.qty) },
              { h: 'Минимум', right: true, r: (r) => num(r.min_stock) },
            ]}
            rows={low.slice(0, 8)} />
        </Card>
      </div>
    </>
  );
}
