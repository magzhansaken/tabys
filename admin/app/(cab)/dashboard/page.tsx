'use client';
/**
 * Показатели дня — модель «Главной» UMAG: выручка, прибыль, чеки, средний
 * чек, долги, критические остатки. Плюс график выручки по дням.
 *
 * Шапки-заголовка здесь намеренно нет: показатели И ЕСТЬ шапка раздела.
 * Зато у каждой цифры есть расшифровка — «выручка 1 240 000 ₸» сама по
 * себе не говорит ничего. Все расшифровки считаются из уже загруженного
 * ответа, новых обращений к серверу раздел не делает.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Stat, Table, DataTable, PeriodPicker, Badge, money, num, C, ErrLine } from '../../../lib/ui';

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

  // Доля возвратов в выручке — из тех же двух чисел, что уже на экране.
  const refundShare = Number(d?.revenue) > 0
    ? `${((Number(d.refunds) / Number(d.revenue)) * 100).toFixed(2).replace('.', ',')}% от выручки`
    : undefined;

  // Товары, которых нет совсем, — отдельно от «мало осталось»: во втором
  // случае продажи ещё идут, в первом они уже потеряны.
  const out = low.filter((r: any) => Number(r.qty) <= 0).length;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-.015em', margin: 0 }}>Показатели</h1>
          <div style={{ fontSize: 13.5, color: C.dim, marginTop: 5, lineHeight: 1.5 }}>
            {d ? `${num(d.receipts)} чеков · средний ${money(d.avgReceipt)}` : 'Загрузка…'}
          </div>
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>
      <ErrLine err={err} />
      <div style={{ display: 'flex', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
        <Stat label="Выручка" value={money(d?.revenue)} sub={`Чеков: ${d?.receipts ?? '—'}`} />
        <Stat label="Прибыль" value={money(d?.profit)}
          sub={[
            d?.margin != null ? `Наценка ${num(d.margin)}%` : null,
            d?.cost != null ? `себестоимость ${money(d.cost)}` : null,
          ].filter(Boolean).join(' · ') || undefined} />
        <Stat label="Средний чек" value={money(d?.avgReceipt)}
          sub={d?.avgItemsPerReceipt != null ? `${num(d.avgItemsPerReceipt)} товара в чеке` : undefined} />
        <Stat label="Возвраты" value={money(d?.refunds)} tone={Number(d?.refunds) > 0 ? 'bad' : undefined}
          sub={Number(d?.refunds) > 0 ? refundShare : 'возвратов не было'} />
        <Stat label="Продано в долг" value={money(d?.debtSales)}
          sub={Number(d?.debtSales) > 0 ? 'деньги ещё не получены' : 'в долг не продавали'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
        <Card title="Выручка по дням"
          right={chart.length > 0 ? <span style={{ fontSize: 12.5, color: C.faint, fontVariantNumeric: 'tabular-nums' }}>максимум {money(max)}</span> : null}>
          {chart.length === 0 ? <div style={{ color: C.dim, fontSize: 14 }}>Продаж за период не было</div> : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 140 }}>
                {chart.map((x: any, i: number) => {
                  const v = Number(x.revenue ?? x.sum ?? 0);
                  // Выходные золотом: в магазине у дома суббота с воскресеньем
                  // дают другую выручку, и смешивать их с буднями — врать себе.
                  const raw = x.day ?? x.date;
                  const wd = raw ? new Date(raw).getDay() : -1;
                  const weekend = wd === 0 || wd === 6;
                  return (
                    <div key={i} title={`${raw ?? ''}: ${money(v)}`} data-bar=""
                         style={{ flex: 1, background: weekend ? C.gold : C.accent, borderRadius: '3px 3px 0 0',
                           height: `${Math.max(3, (v / max) * 100)}%` }} />
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 12.5, color: C.dim }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: C.accent }} />будни</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: C.gold }} />выходные</span>
              </div>
            </>
          )}
        </Card>
        <Card title="Критические остатки"
          right={<a href="/stock" style={{ fontSize: 13, color: C.accentDark }}>Пополнить</a>}>
          <DataTable storageKey="dashboard" exportName="dashboard" search={false}
            empty="Все товары в достатке"
            hint={out > 0
              ? `${out} товаров закончились совсем — продажи по ним уже потеряны, а не под угрозой.`
              : 'Товары, которых осталось меньше минимума. Красным — те, что закончились совсем.'}
            cols={[
              { h: 'Товар', k: 'name' },
              { h: 'Остаток', right: true, r: (r) => (
                  <span style={{ color: Number(r.qty) <= 0 ? C.red : C.text, fontWeight: Number(r.qty) <= 0 ? 600 : 400 }}>
                    {num(r.qty)}
                  </span>
                ) },
              { h: 'Минимум', right: true, r: (r) => num(r.min_stock) },
              { h: 'Состояние', r: (r) => Number(r.qty) <= 0
                  ? <Badge tone="bad">Закончился</Badge>
                  : <Badge tone="warn">Мало</Badge> },
            ]}
            rows={low.slice(0, 8)} />
        </Card>
      </div>
    </>
  );
}
