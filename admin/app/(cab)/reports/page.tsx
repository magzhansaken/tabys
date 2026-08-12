'use client';
/**
 * Отчёты — по номенклатуре UMAG: статистика продаж, ABC-анализ,
 * отчёты по кассирам и сменам, рентабельность.
 *
 * У каждой вкладки свой факт в шапке и своя подсказка: семь вкладок — это
 * семь разных вопросов, и общая строка «отчёты за период» не отвечает ни
 * на один. Факты считаются из уже полученного ответа.
 */
import { useEffect, useState } from 'react';
import { api, downloadXlsx } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Btn, PeriodPicker, MONO,
  money, num, dt, C, ErrLine, Badge } from '../../../lib/ui';

const HINT: Record<string, string> = {
  products: 'Что вытягивает выручку. Смотрите не только на верх списка: товар с большой выручкой и нулевой прибылью — это работа впустую.',
  abc: 'A — первые 80% выручки, B — следующие 15%, C — остальные. Товары класса C держат деньги в полке: их много, а выручки с них почти нет.',
  cashiers: 'Одинаковая смена, разные кассиры. На отмены смотрите вместе с выручкой: много отмен при обычной выручке — повод спросить.',
  shifts: 'Расхождение — разница между тем, сколько денег должно быть в кассе по чекам, и сколько насчитали при закрытии. Прямой признак недостачи.',
  profit: 'Наценка важнее выручки: молоко продаётся много, а зарабатывает магазин на другом. Сортируйте мысленно по последнему столбцу.',
  consultants: 'Проценты считаются от продаж за период за вычетом возвратов по чекам продавца. «К выплате» — то, что уйдёт в зарплату.',
  discounts: '200 ₸ с кофе — это 20%, а 200 ₸ с телевизора — 0,1%. В деньгах одинаково, по смыслу нет. Поэтому доля от 15% подсвечена красным.',
};

export default function ReportsPage() {
  const [tab, setTab] = useState('products');
  const [period, setPeriod] = useState('month');
  const [rows, setRows] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      setErr('');
      const path: any = {
        products: `/reports/sales/products?period=${period}&limit=50`,
        abc: `/reports/abc?period=${period}`,
        cashiers: `/reports/cashiers?period=${period}`,
        shifts: `/reports/shifts?period=${period}`,
        profit: `/reports/profitability?period=${period}`,
        consultants: `/reports/consultants?period=${period}`,
        discounts: `/reports/discounts?period=${period}`,
      };
      try {
        const d = await api(path[tab]);
        setRows(Array.isArray(d) ? d : d.rows ?? d.items ?? []);
        // Сводка по кассирам из отчёта о скидках: главный вопрос владельца
        // не «сколько скидок», а «почему у одного их втрое больше».
        setSummary(!Array.isArray(d) && d.byCashier ? d : null);
      } catch (e: any) { setErr(e.message); setRows([]); }
    })();
  }, [tab, period]);

  const sum = (k: string) => rows.reduce((s, r: any) => s + Number(r[k] ?? 0), 0);

  /** Факт для шапки — по открытой вкладке: на других данных сейчас нет. */
  const fact = () => {
    if (!rows.length) return 'За период данных нет';
    switch (tab) {
      case 'products': return `${rows.length} товаров продавалось · выручка ${money(sum('revenue') || sum('sum'))}`;
      case 'abc': {
        const by = (g: string) => rows.filter((r: any) => (r.grade ?? r.abc) === g).length;
        return `A — ${by('A')} товаров, B — ${by('B')}, C — ${by('C')}`;
      }
      case 'cashiers': return `${rows.length} кассиров · ${rows.reduce((s, r: any) => s + Number(r.receipts ?? r.sales_count ?? 0), 0)} чеков`;
      case 'shifts': {
        const bad = rows.filter((r: any) => Number(r.discrepancy ?? r.diff ?? 0) !== 0).length;
        return `${rows.length} смен${bad ? ` · ${bad} с расхождением` : ' · расхождений нет'}`;
      }
      case 'profit': {
        const m = rows.map((r: any) => Number(r.margin)).filter((x) => !isNaN(x));
        return m.length ? `наценка от ${num(Math.min(...m))}% до ${num(Math.max(...m))}%` : `${rows.length} товаров`;
      }
      case 'consultants': return `${rows.length} продавцов · к выплате ${money(sum('commission'))}`;
      case 'discounts': return summary
        ? `${summary.count} продаж со скидкой · отдано ${money(summary.total)}`
        : `${rows.length} продаж со скидкой`;
      default: return `${rows.length} строк`;
    }
  };

  const COLS: any = {
    products: [
      { h: 'Товар', r: (r: any) => r.name ?? r.product_name },
      { h: 'Продано', right: true, r: (r: any) => num(r.qty) },
      { h: 'Выручка', right: true, r: (r: any) => money(r.revenue ?? r.sum) },
      { h: 'Прибыль', right: true, r: (r: any) => r.profit != null ? money(r.profit) : '—' },
    ],
    abc: [
      { h: 'Товар', r: (r: any) => r.name ?? r.product_name },
      { h: 'Класс', r: (r: any) => <Badge tone={r.grade === 'A' ? 'ok' : r.grade === 'B' ? 'warn' : 'dim'}>{r.grade ?? r.abc}</Badge> },
      { h: 'Выручка', right: true, r: (r: any) => money(r.revenue ?? r.sum) },
      { h: 'Доля', right: true, r: (r: any) => r.share != null ? `${num(r.share)}%` : '—' },
    ],
    cashiers: [
      { h: 'Кассир', r: (r: any) => r.name ?? r.cashier_name },
      { h: 'Чеков', right: true, r: (r: any) => r.receipts ?? r.sales_count },
      { h: 'Выручка', right: true, r: (r: any) => money(r.revenue ?? r.sum) },
      { h: 'Средний чек', right: true, r: (r: any) => money(r.avgReceipt ?? r.avg_receipt) },
      { h: 'Отмен', right: true, r: (r: any) => {
        const v = Number(r.cancellations ?? r.cancels ?? 0);
        return v === 0 ? <span style={{ color: C.faint }}>—</span>
          : <span style={{ color: C.red, fontWeight: 600 }}>{v}</span>;
      } },
    ],
    shifts: [
      { h: 'Смена', r: (r: any) => `№${r.number ?? r.shift_number ?? '—'}` },
      { h: 'Открыта', r: (r: any) => dt(r.opened_at) },
      { h: 'Закрыта', r: (r: any) => r.closed_at ? dt(r.closed_at) : <Badge tone="warn">Открыта</Badge> },
      { h: 'Выручка', right: true, r: (r: any) => money(r.revenue ?? r.total) },
      // Прибыль за смену — главный вопрос владельца: наторговали, а
      // заработали ли. Выручка минус себестоимость проданного.
      { h: 'Прибыль', right: true, r: (r: any) => money(r.profit ?? 0) },
      { h: 'Скидок отдано', right: true, r: (r: any) => {
        const v = Number(r.discounts_given ?? 0);
        return v === 0 ? <span style={{ color: C.faint }}>—</span> : money(v);
      } },
      // Читаться должно с двух метров: это единственная колонка, ради
      // которой отчёт открывают. Минус — настоящий знак «−», а не дефис.
      { h: 'Расхождение', right: true, r: (r: any) => {
        const v = Number(r.discrepancy ?? r.diff ?? 0);
        if (v === 0) return <span style={{ color: C.faint }}>—</span>;
        return (
          <span style={{ color: C.red, fontWeight: 600, fontSize: 15, whiteSpace: 'nowrap' }}>
            {v < 0 ? '−' : '+'}{money(Math.abs(v))}
          </span>
        );
      } },
    ],
    discounts: [
      { h: 'Товар', k: 'product' },
      { h: 'Штрихкод', r: (r: any) => <span style={{ fontFamily: MONO, fontSize: 13, whiteSpace: 'nowrap' }}>{r.barcode}</span> },
      { h: 'Кол-во', right: true, r: (r: any) => `${num(r.qty)} ${r.unit ?? ''}` },
      { h: 'Начальная цена', right: true, r: (r: any) => money(r.basePrice) },
      { h: 'Скидка', right: true, r: (r: any) => money(r.discount) },
      // Доля от цены: 200 ₸ с кофе и 200 ₸ с телевизора выглядят одинаково
      // в деньгах, но это совершенно разные вещи. Красным — от 15%.
      { h: 'Доля', right: true, r: (r: any) => (
        <span style={{ color: r.discountShare >= 15 ? C.red : C.text,
          fontWeight: r.discountShare >= 15 ? 600 : 400 }}>{r.discountShare}%</span>
      ) },
      { h: 'Цена со скидкой', right: true, r: (r: any) => money(r.paid) },
      { h: 'Кассир', k: 'cashier' },
      { h: 'Когда', r: (r: any) => dt(r.at) },
    ],
    consultants: [
      { h: 'Продавец', k: 'name' },
      { h: 'Чеков', right: true, k: 'receipts' },
      { h: 'Выручка', right: true, r: (r: any) => money(r.revenue) },
      { h: 'Возвраты', right: true, r: (r: any) => r.refunds > 0
          ? <span style={{ color: C.red }}>{money(r.refunds)}</span>
          : <span style={{ color: C.faint }}>—</span> },
      { h: '%', right: true, r: (r: any) => `${r.commissionPercent}%` },
      { h: 'К выплате', right: true, r: (r: any) => <b style={{ whiteSpace: 'nowrap' }}>{money(r.commission)}</b> },
    ],
    profit: [
      { h: 'Товар', r: (r: any) => r.name ?? r.product_name },
      { h: 'Выручка', right: true, r: (r: any) => money(r.revenue ?? r.sum) },
      { h: 'Себестоимость', right: true, r: (r: any) => money(r.cost ?? r.cogs) },
      { h: 'Прибыль', right: true, r: (r: any) => money(r.profit) },
      { h: 'Наценка', right: true, r: (r: any) => r.margin != null
          ? <b style={{ whiteSpace: 'nowrap' }}>{num(r.margin)}%</b> : '—' },
    ],
  };

  return (
    <>
      <PageHeader
        title="Отчёты"
        fact={fact()}
        actions={<>
          <PeriodPicker value={period} onChange={setPeriod} />
          {/* Выгрузка текущей вкладки — как «Скачать» у UMAG/Wipon */}
          <Btn kind="ghost" onClick={async () => {
            setErr('');
            try {
              const map: any = { products: 'sales', profit: 'profitability' };
              const d = new Date().toISOString().slice(0, 10);
              await downloadXlsx(`/export/report/${map[tab] ?? tab}?from=${d}&to=${d}`);
            } catch (e: any) { setErr(e.message); }
          }}>Скачать Excel</Btn>
        </>}
      />
      <ErrLine err={err} />
      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'products', label: 'Продажи по товарам' },
          { key: 'abc', label: 'ABC-анализ' },
          { key: 'cashiers', label: 'Кассиры' },
          { key: 'shifts', label: 'Смены' },
          { key: 'profit', label: 'Рентабельность' },
          { key: 'consultants', label: 'Консультанты' },
          { key: 'discounts', label: 'Скидки' },
        ]} />

      {summary && summary.byCashier?.length > 0 && (
        <Card title="Кто раздаёт скидки" style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55, maxWidth: '80ch' }}>
            Всего отдано {money(summary.total)} за {summary.count} продаж.
            Скидка «своим» — самый частый способ увести деньги из кассы,
            поэтому смотреть стоит не на сумму, а на того, кто её даёт.
          </p>
          {/* Карточками, а не строками: сравнивают здесь людей между собой,
              и доля от общего важнее самой суммы. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
            {summary.byCashier.map((r: any, i: number) => {
              const share = Number(summary.total) > 0
                ? Math.round((Number(r.sum) / Number(summary.total)) * 100) : 0;
              // Первый в списке отдаёт больше всех — это и есть ответ на вопрос.
              const top = i === 0 && summary.byCashier.length > 1;
              return (
                <div key={r.cashier} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '14px 16px' }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{r.cashier}</div>
                  <div style={{ fontSize: 21, fontWeight: 600, marginTop: 6, whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums', color: top ? C.red : C.text }}>
                    {money(r.sum)}
                  </div>
                  <div style={{ fontSize: 12.5, color: C.dim, marginTop: 5 }}>
                    {r.count} раз · {share}% всех скидок
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

        <Card>
          <DataTable storageKey={`reports-${tab}`} exportName={`reports-${tab}`}
            hint={HINT[tab]}
            empty="Данных за период нет — выберите другой период или проверьте, что смены закрывались"
            cols={COLS[tab]} rows={rows} />
        </Card>
      </div>
    </>
  );
}
