'use client';
/**
 * RFM-анализ (часть 37) — сегментация клиентов по давности, частоте, сумме
 * покупок. Догоняем МойСклад, но встроенно и с готовыми рекомендациями. Из
 * сегмента можно сформировать рассылку.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Btn, Stat, Badge, money, num, C, ErrLine } from '../../../lib/ui';

export default function RfmPage() {
  const [data, setData] = useState<any>(null);
  const [active, setActive] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = async () => {
    setErr('');
    try { setData(await api('/rfm')); } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const shown = data && active
    ? data.customers.filter((c: any) => c.segment === active)
    : data?.customers ?? [];

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>RFM-анализ</h1>
      <p style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>
        Кто ценен, кто рискует уйти. R — давность покупки, F — частота, M — сумма.
        За последние 180 дней. Нажмите на сегмент, чтобы отфильтровать клиентов.
      </p>
      <ErrLine err={err} />

      {data && (
        <>
          <div style={{ marginTop: 14, marginBottom: 8 }}>
            <Stat label="Клиентов с покупками" value={String(data.totalCustomers)} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 18 }}>
            {data.segments.map((s: any) => (
              <Card key={s.segment} style={{ cursor: 'pointer',
                outline: active === s.segment ? `2px solid ${C.accent}` : 'none' }}>
                <div onClick={() => setActive(active === s.segment ? null : s.segment)}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Badge tone={s.tone}>{s.segment}</Badge>
                    <b style={{ fontSize: 18 }}>{s.count}</b>
                  </div>
                  <div style={{ fontSize: 13, color: C.dim, marginTop: 6 }}>{money(s.total)} суммарно</div>
                  <div style={{ fontSize: 13, color: C.text, marginTop: 8 }}>{s.action}</div>
                </div>
              </Card>
            ))}
          </div>

          <Card title={active ? `Клиенты: ${active}` : 'Все клиенты'}>
            {active && <div style={{ marginBottom: 10 }}><Btn kind="ghost" onClick={() => setActive(null)}>← показать всех</Btn></div>}
            <DataTable hint="Кто из клиентов ценен, а кто рискует уйти. R — давность покупки, F — частота, M — сумма. Нажмите на сегмент, чтобы увидеть его клиентов." storageKey="rfm" exportName="rfm" empty="Нет клиентов с покупками за период" cols={[
              { h: 'Клиент', k: 'name' },
              { h: 'Сегмент', r: (r: any) => <Badge tone={r.tone}>{r.segment}</Badge> },
              { h: 'RFM', r: (r: any) => <span style={{ fontFamily: 'monospace' }}>{r.rfm}</span> },
              { h: 'Последняя', right: true, r: (r: any) => r.lastDays != null ? `${r.lastDays} дн` : '—' },
              { h: 'Покупок', right: true, k: 'purchases' },
              { h: 'Сумма', right: true, r: (r: any) => money(r.total) },
              { h: 'Средний чек', right: true, r: (r: any) => money(r.avgCheck) },
            ]} rows={shown} />
          </Card>
        </>
      )}
    </>
  );
}
