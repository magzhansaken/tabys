'use client';
/**
 * RFM-анализ (часть 37) — сегментация клиентов по давности, частоте, сумме
 * покупок. Догоняем МойСклад, но встроенно и с готовыми рекомендациями. Из
 * сегмента можно сформировать рассылку.
 *
 * Сегменты — карточками, а не строками таблицы: у каждого есть РЕКОМЕНДАЦИЯ
 * действия, и это не ярлык, а подсказка, что делать. В строке таблицы она
 * не читается.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Btn, Stat, Badge, money, num, MONO, C, ErrLine } from '../../../lib/ui';

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
      <PageHeader
        title="RFM-анализ"
        fact={data
          ? `${data.totalCustomers} клиентов с покупками · ${data.segments.length} сегментов · за 180 дней`
          : 'Загрузка…'}
        note="R — давность покупки, F — частота, M — сумма. Первая цифра важнее двух других: если клиент перестал приходить, остальное уже неважно. Нажмите на сегмент, чтобы увидеть его клиентов."
      />
      <ErrLine err={err} />

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 18 }}>
            {data.segments.map((s: any) => {
              const on = active === s.segment;
              return (
                <Card key={s.segment} style={{ cursor: 'pointer',
                  borderColor: on ? C.accent : C.line,
                  boxShadow: on ? `inset 0 0 0 1px ${C.accent}` : 'none',
                  background: on ? '#F4F9F6' : C.card }}>
                  <div onClick={() => setActive(on ? null : s.segment)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <Badge tone={s.tone}>{s.segment}</Badge>
                      <b style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>{s.count}</b>
                    </div>
                    <div style={{ fontSize: 13, color: C.dim, marginTop: 8, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {money(s.total)} суммарно
                    </div>
                    {/* Рекомендация — главное в карточке, поэтому обычным
                        цветом текста, а не подписью. */}
                    <div style={{ fontSize: 13.5, color: C.prose, marginTop: 10, lineHeight: 1.5 }}>{s.action}</div>
                  </div>
                </Card>
              );
            })}
          </div>

          <Card title={active ? `Клиенты: ${active}` : 'Все клиенты'}>
            {active && <div style={{ marginBottom: 10 }}><Btn kind="ghost" onClick={() => setActive(null)}>← показать всех</Btn></div>}
            <DataTable
              hint="«Последняя» краснеет после 60 дней: клиент уходит, каким бы хорошим он ни был раньше. Это первое, на что смотрят в этой таблице."
              storageKey="rfm" exportName="rfm" empty="Нет клиентов с покупками за период" cols={[
              { h: 'Клиент', k: 'name' },
              { h: 'Сегмент', r: (r: any) => <Badge tone={r.tone}>{r.segment}</Badge> },
              { h: 'RFM', r: (r: any) => <span style={{ fontFamily: MONO, fontSize: 13 }}>{r.rfm}</span> },
              { h: 'Последняя', right: true, r: (r: any) => {
                  if (r.lastDays == null) return <span style={{ color: C.faint }}>—</span>;
                  const late = Number(r.lastDays) > 60;
                  return <span style={{ color: late ? C.red : C.text, fontWeight: late ? 600 : 400 }}>{r.lastDays} дн</span>;
                } },
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
