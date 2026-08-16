'use client';
/**
 * Опт (часть 31) — CRM для оптовых клиентов. Воронка сделок, оптовые заказы,
 * юнит-экономика по клиенту. Воронка только для опта — у розницы её нет.
 *
 * Здесь было единственное подтверждение действия во всём кабинете. Оно и
 * стало образцом: теперь везде confirmDanger(что, последствие) — вопрос
 * «вы уверены?» бесполезен, человек уверен, он же нажал.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Btn, Stat,
  confirmDanger, money, num, dt, C, ErrLine, Badge } from '../../../lib/ui';

const STAGE_TONE: Record<string, any> = {
  new: 'dim', negotiation: 'warn', shipped: 'warn', paid: 'ok', closed: 'ok', lost: 'bad',
};

export default function WholesalePage() {
  const [tab, setTab] = useState('funnel');
  const [funnel, setFunnel] = useState<any>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [eco, setEco] = useState<any[]>([]);
  const [err, setErr] = useState('');

  const load = async () => {
    setErr('');
    try {
      if (tab === 'funnel') setFunnel(await api('/wholesale/funnel'));
      if (tab === 'orders') setOrders(await api('/wholesale/orders'));
      if (tab === 'economics') setEco(await api('/wholesale/customer-economics'));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [tab]);

  // Отгрузка: списывает товар. Ошибку показываем как есть — в ней написано,
  // чего и сколько не хватает, это готовый ответ кладовщику.
  const ship = async (r: any) => {
    if (!await confirmDanger(
      `Отгрузить сделку №${r.number} — ${r.customer}?`,
      `Товар на ${money(r.total)} спишется со склада сразу. Отменить отгрузку можно только обратным документом, поэтому проверьте, что машина действительно ушла.`,
    )) return;
    try { await api(`/wholesale/orders/${r.id}/ship`, { method: 'POST', body: '{}' }); load(); }
    catch (e: any) { setErr(e.message); }
  };

  const pay = async (r: any) => {
    const sum = prompt(`Оплата по сделке №${r.number}.\nК оплате осталось ${money(r.left)}.\nСколько внесли?`, String(r.left));
    if (!sum) return;
    try {
      await api(`/wholesale/orders/${r.id}/pay`, { method: 'POST',
        body: JSON.stringify({ amount: Number(sum) }) });
      load();
    } catch (e: any) { setErr(e.message); }
  };

  const move = async (id: string, stage: string) => {
    try { await api(`/wholesale/orders/${id}/stage`, { method: 'PATCH', body: JSON.stringify({ stage }) }); load(); }
    catch (e: any) { setErr(e.message); }
  };

  const maxFunnel = funnel ? Math.max(1, ...funnel.funnel.map((f: any) => f.orders)) : 1;

  const debt = orders.reduce((s: number, r: any) => s + Number(r.left ?? 0), 0);
  const fact = tab === 'funnel'
    ? (funnel ? `${funnel.totalOrders} сделок · конверсия ${funnel.conversion}% · потеряно ${funnel.lost.orders}` : 'Загрузка…')
    : tab === 'orders'
      ? `${orders.length} сделок${debt > 0 ? ` · не оплачено ${money(debt)}` : ' · все оплачены'}`
      : `${eco.length} клиентов с покупками за 90 дней`;

  return (
    <>
      <PageHeader
        title="Опт"
        fact={fact}
        note="CRM для оптовых клиентов: сделки по этапам, конверсия, вклад каждого клиента. Для розницы воронки нет — там пришёл, купил, ушёл."
      />
      <ErrLine err={err} />

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'funnel', label: 'Воронка' },
          { key: 'orders', label: 'Сделки' },
          { key: 'economics', label: 'Экономика клиентов' },
        ]} />

        {tab === 'funnel' && funnel && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
              <Stat label="Всего сделок" value={String(funnel.totalOrders)} />
              <Stat label="Конверсия" value={`${funnel.conversion}%`}
                sub={funnel.conversion >= 50 ? 'больше половины доходит до оплаты' : 'меньше половины доходит до оплаты'} />
              <Stat label="Потеряно" value={String(funnel.lost.orders)} tone="bad"
                sub={funnel.lost.total ? `на ${money(funnel.lost.total)}` : undefined} />
            </div>
            <Card title="Воронка продаж">
              <p style={{ fontSize: 13.5, color: C.dim, margin: '0 0 16px', lineHeight: 1.55, maxWidth: '80ch' }}>
                Смотрите, где полоса резко короче предыдущей: там сделки и застревают.
              </p>
              {funnel.funnel.map((f: any) => (
                <div key={f.stage} style={{ marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 5, gap: 12 }}>
                    <span>{f.label}</span>
                    <span style={{ color: C.dim, whiteSpace: 'nowrap' }}>{f.orders} сделок · {money(f.total)}</span>
                  </div>
                  <div style={{ height: 22, background: C.lineIn, borderRadius: 6, overflow: 'hidden' }}>
                    <div data-bar="" style={{ height: '100%', width: `${(f.orders / maxFunnel) * 100}%`, background: C.accent, borderRadius: 6, transition: 'width .3s' }} />
                  </div>
                </div>
              ))}
            </Card>
          </>
        )}

        {tab === 'orders' && (
          <Card title="Оптовые сделки">
            <DataTable storageKey="wholesale" exportName="wholesale"
              hint="Цвет суммы — состояние долга: зелёная оплачена, красная нет. Отгрузка списывает товар со склада, приём оплаты кладёт деньги в кассу — это настоящие операции, а не смена ярлыка."
              empty="Сделок пока нет — оптовая сделка заводится, когда клиент просит счёт" cols={[
              { h: 'Номер', k: 'number' },
              { h: 'Клиент', k: 'customer' },
              // Цвет суммы = состояние долга (приём UMAG): зелёный — погашен,
              // красный — нет. Владелец видит с одного взгляда, не открывая карточку.
              { h: 'Сумма', right: true, r: (r: any) => (
                <span style={{ color: r.payStatus === 'green' ? C.accentDark : C.red, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {money(r.total)}
                </span>
              ) },
              { h: 'Оплачено', right: true, r: (r: any) => r.paid > 0
                  ? <span style={{ whiteSpace: 'nowrap' }}>{money(r.paid)}{r.left > 0 ? <span style={{ color: C.red }}> · долг {money(r.left)}</span> : null}</span>
                  : <span style={{ color: C.faint }}>—</span> },
              { h: 'Прибыль', right: true, r: (r: any) => money(r.profit) },
              { h: 'Отгрузка', r: (r: any) => r.shipped
                  ? <Badge tone="ok">отгружено</Badge>
                  : <span style={{ color: C.faint }}>—</span> },
              { h: 'Этап', r: (r: any) => <Badge tone={STAGE_TONE[r.stage]}>{r.stageLabel}</Badge> },
              { h: 'Действие', r: (r: any) => {
                  // Отгрузка и оплата — настоящие операции: списывают товар и
                  // принимают деньги. Раньше здесь был только перевод этапа,
                  // и «оплачено» означало лишь ярлык на карточке.
                  if (!r.shipped) return <Btn kind="ghost" onClick={() => ship(r)}>Отгрузить</Btn>;
                  if (r.left > 0) return <Btn onClick={() => pay(r)}>Принять оплату</Btn>;
                  const next: Record<string, string> = { new: 'negotiation', negotiation: 'shipped', shipped: 'paid', paid: 'closed' };
                  return next[r.stage]
                    ? <Btn kind="ghost" onClick={() => move(r.id, next[r.stage])}>Дальше →</Btn>
                    : null;
                } },
            ]} rows={orders} />
          </Card>
        )}

        {tab === 'economics' && (
          <Card title="Экономика клиентов">
            <DataTable storageKey="wholesale-2" exportName="wholesale-2"
              hint="Кто приносит деньги: вклад каждого клиента в выручку и прибыль за 90 дней. Большая выручка при маленькой прибыли значит, что клиенту дают слишком хорошую цену."
              empty="Пока нет продаж с указанным клиентом. Клиент указывается на кассе или в оптовой сделке" cols={[
              { h: 'Клиент', k: 'name' },
              { h: 'Покупок', right: true, k: 'receipts' },
              { h: 'Выручка', right: true, r: (r: any) => money(r.revenue) },
              { h: 'Прибыль', right: true, r: (r: any) => money(r.profit) },
              { h: 'Средний чек', right: true, r: (r: any) => money(r.avgReceipt) },
            ]} rows={eco} />
          </Card>
        )}
      </div>
    </>
  );
}
