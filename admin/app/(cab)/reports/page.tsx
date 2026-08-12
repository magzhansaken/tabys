'use client';
/**
 * Отчёты — по номенклатуре UMAG: статистика продаж, ABC-анализ,
 * отчёты по кассирам и сменам, рентабельность.
 */
import { useEffect, useState } from 'react';
import { api, downloadXlsx } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, PeriodPicker, money, num, dt, C, ErrLine, Badge } from '../../../lib/ui';

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
      { h: 'Отмен', right: true, r: (r: any) => r.cancellations ?? r.cancels ?? 0 },
    ],
    shifts: [
      { h: 'Смена', r: (r: any) => `№${r.number ?? r.shift_number ?? '—'}` },
      { h: 'Открыта', r: (r: any) => dt(r.opened_at) },
      { h: 'Закрыта', r: (r: any) => dt(r.closed_at) },
      { h: 'Выручка', right: true, r: (r: any) => money(r.revenue ?? r.total) },
      // Прибыль за смену — главный вопрос владельца: наторговали, а
      // заработали ли. Выручка минус себестоимость проданного.
      { h: 'Прибыль', right: true, r: (r: any) => money(r.profit ?? 0) },
      { h: 'Скидок отдано', right: true, r: (r: any) => {
        const v = Number(r.discounts_given ?? 0);
        return v === 0 ? '—' : money(v);
      } },
      { h: 'Расхождение', right: true, r: (r: any) => {
        const v = Number(r.discrepancy ?? r.diff ?? 0);
        return v === 0 ? '—' : <span style={{ color: C.red }}>{money(v)}</span>;
      } },
    ],
    discounts: [
      { h: 'Товар', k: 'product' },
      { h: 'Штрихкод', k: 'barcode' },
      { h: 'Кол-во', right: true, r: (r: any) => `${num(r.qty)} ${r.unit ?? ''}` },
      { h: 'Начальная цена', right: true, r: (r: any) => money(r.basePrice) },
      { h: 'Скидка', right: true, r: (r: any) => money(r.discount) },
      // Доля от цены: 200 ₸ с кофе и 200 ₸ с телевизора выглядят одинаково
      // в деньгах, но это совершенно разные вещи. Красным — от 15%.
      { h: 'Доля', right: true, r: (r: any) => (
        <span style={{ color: r.discountShare >= 15 ? C.red : C.text }}>{r.discountShare}%</span>
      ) },
      { h: 'Цена со скидкой', right: true, r: (r: any) => money(r.paid) },
      { h: 'Кассир', k: 'cashier' },
      { h: 'Когда', r: (r: any) => dt(r.at) },
    ],
    consultants: [
      { h: 'Продавец', k: 'name' },
      { h: 'Чеков', right: true, k: 'receipts' },
      { h: 'Выручка', right: true, r: (r: any) => money(r.revenue) },
      { h: 'Возвраты', right: true, r: (r: any) => r.refunds > 0 ? money(r.refunds) : '—' },
      { h: '%', right: true, r: (r: any) => `${r.commissionPercent}%` },
      { h: 'К выплате', right: true, r: (r: any) => <b>{money(r.commission)}</b> },
    ],
    profit: [
      { h: 'Товар', r: (r: any) => r.name ?? r.product_name },
      { h: 'Выручка', right: true, r: (r: any) => money(r.revenue ?? r.sum) },
      { h: 'Себестоимость', right: true, r: (r: any) => money(r.cost ?? r.cogs) },
      { h: 'Прибыль', right: true, r: (r: any) => money(r.profit) },
      { h: 'Наценка', right: true, r: (r: any) => r.margin != null ? `${num(r.margin)}%` : '—' },
    ],
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Отчёты</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
        </div>
      </div>
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
          <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
            Всего отдано {money(summary.total)} за {summary.count} продаж.
            Скидка «своим» — самый частый способ увести деньги из кассы,
            поэтому смотреть стоит не на сумму, а на того, кто её даёт.
          </p>
          <Table cols={[
            { h: 'Кассир', k: 'cashier' },
            { h: 'Раз', right: true, k: 'count' },
            { h: 'Отдано', right: true, r: (r: any) => money(r.sum) },
          ]} rows={summary.byCashier} />
        </Card>
      )}

        <Card>
          <DataTable storageKey="reports" exportName="reports" empty="Данных за период нет" cols={COLS[tab]} rows={rows} />
        </Card>
      </div>
    </>
  );
}
