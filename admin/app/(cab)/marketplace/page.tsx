'use client';
/**
 * Kaspi магазин (часть 32) — интеграция с маркетплейсом. Подключение, маппинг
 * товаров, выгрузка цен/остатков, заказы с приёмом и отгрузкой.
 *
 * Новый заказ не должен теряться среди обработанных: он ждёт действия, и
 * пока его не приняли, покупатель ждёт вместе с ним. Поэтому новые идут
 * первыми и подсвечены, а перевод состояний переехал в Status (kind="mp") —
 * таблица STATE_LABEL здесь была третьим переводом статусов в системе.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Status, Btn, Input, Field, Badge,
  money, num, dt, C, ErrLine } from '../../../lib/ui';

export default function MarketplacePage() {
  const [tab, setTab] = useState('orders');
  const [conn, setConn] = useState<any>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [listings, setListings] = useState<any[]>([]);
  const [log, setLog] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setErr('');
    try {
      setConn(await api('/marketplace/connection?provider=mock'));
      if (tab === 'orders') setOrders(await api('/marketplace/orders?provider=mock'));
      if (tab === 'listings') setListings(await api('/marketplace/listings?provider=mock'));
      if (tab === 'log') setLog(await api('/marketplace/sync-log?provider=mock'));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [tab]);

  const act = async (fn: () => Promise<any>, okMsg: string) => {
    setErr(''); setMsg('');
    try { const r = await fn(); setMsg(okMsg); load(); return r; }
    catch (e: any) { setErr(e.message); }
  };

  // Заказ, требующий действия, — наверх. Обработанные не должны прятать его.
  const needsAction = (r: any) => !r.accepted_at || (r.state !== 'archive');
  const sorted = [...orders].sort((a, b) => Number(needsAction(b)) - Number(needsAction(a)));
  const fresh = orders.filter((r: any) => !r.accepted_at).length;
  const inWork = orders.filter((r: any) => r.accepted_at && r.state !== 'archive').length;

  return (
    <>
      <PageHeader
        title="Kaspi магазин"
        fact={conn
          ? `${fresh} новых заказов · ${inWork} в работе${conn.last_sync_at ? ` · обмен ${dt(conn.last_sync_at)}` : ''}`
          : 'Магазин не подключён'}
        note="Заказы с маркетплейса приходят в кабинет, цены и остатки уходят обратно. Остаток единый: продажа на Kaspi списывает тот же склад, что и касса, — двойной продажи последней пачки не будет."
      />
      <ErrLine err={err} />
      {msg && <p style={{ color: C.accentDark, fontSize: 13 }}>{msg}</p>}

      {!conn && (
        <Card title="Подключение" style={{ marginTop: 12 }}>
          <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55 }}>
            Подключите магазин: введите ID продавца и токен из кабинета Kaspi.
          </p>
          <Btn onClick={() => act(() => api('/marketplace/connect', { method: 'POST', body: JSON.stringify({ provider: 'mock', merchantId: 'DEMO', authToken: 'demo-token' }) }), 'Подключено (демо)')}>
            Подключить (демо)
          </Btn>
        </Card>
      )}

      {conn && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
            <Badge tone="ok">Подключено: {conn.provider}</Badge>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn kind="ghost" onClick={() => act(() => api('/marketplace/push-prices', { method: 'POST', body: JSON.stringify({ provider: 'mock' }) }), 'Цены и остатки выгружены')}>Выгрузить цены и остатки</Btn>
              <Btn onClick={() => act(() => api('/marketplace/pull-orders', { method: 'POST', body: JSON.stringify({ provider: 'mock' }) }), 'Заказы обновлены')}>Забрать заказы</Btn>
            </div>
          </div>

          <Tabs active={tab} onChange={setTab} tabs={[
            { key: 'orders', label: 'Заказы' },
            { key: 'listings', label: 'Товары на Kaspi' },
            { key: 'log', label: 'Журнал' },
          ]} />

          {tab === 'orders' && (
            <Card title="Заказы с маркетплейса">
              <DataTable storageKey="marketplace" exportName="marketplace"
                hint={fresh > 0
                  ? `${fresh} заказов ждут приёма — они подняты наверх. Пока заказ не принят, покупатель ждёт ответа.`
                  : 'Заказы, требующие действия, всегда сверху. Принятый заказ ждёт выдачи, выданный списывает товар со склада.'}
                empty="Заказов пока нет — нажмите «Забрать заказы»" cols={[
                { h: 'Код', r: (r: any) => (
                    <span style={{ fontWeight: !r.accepted_at ? 600 : 400 }}>{r.code}</span>
                  ) },
                { h: 'Клиент', k: 'customer_name' },
                { h: 'Сумма', right: true, r: (r: any) => money(r.total_price) },
                { h: 'Доставка', r: (r: any) => r.delivery_mode ?? '—' },
                { h: 'Статус', r: (r: any) => <Status value={r.state} kind="mp" /> },
                { h: 'Действие', r: (r: any) => !r.accepted_at
                    ? <Btn onClick={() => act(() => api(`/marketplace/orders/${r.id}/accept`, { method: 'POST', body: JSON.stringify({ provider: 'mock' }) }), 'Заказ принят')}>Принять</Btn>
                    : r.state !== 'archive'
                      ? <Btn kind="ghost" onClick={() => act(() => api(`/marketplace/orders/${r.id}/complete`, { method: 'POST', body: JSON.stringify({ provider: 'mock' }) }), 'Заказ выдан, товар списан')}>Выдать</Btn>
                      : <span style={{ color: C.faint, fontSize: 13 }}>готово</span> },
              ]} rows={sorted} />
            </Card>
          )}

          {tab === 'listings' && (
            <Card title="Товары на маркетплейсе">
              <DataTable storageKey="marketplace-2" exportName="marketplace-2"
                hint="Сопоставление наших товаров с кодами (SKU) на Kaspi. Без сопоставления заказ приходит нераспознанным, и склад по нему не спишется."
                empty="Товары ещё не сопоставлены — начните с ходовых позиций" cols={[
                { h: 'Товар', k: 'product' },
                { h: 'SKU на Kaspi', k: 'sku' },
                { h: 'Выгружено', r: (r: any) => r.published ? <Badge tone="ok">да</Badge> : <Badge tone="dim">нет</Badge> },
                { h: 'Цена', right: true, r: (r: any) => r.last_price != null ? money(r.last_price) : '—' },
                { h: 'Остаток', right: true, r: (r: any) => r.last_qty != null ? num(r.last_qty) : '—' },
              ]} rows={listings} />
            </Card>
          )}

          {tab === 'log' && (
            <Card title="Журнал синхронизации">
              <DataTable storageKey="marketplace-3" exportName="marketplace-3" search={false}
                hint="Сюда смотрят, когда на Kaspi «не та цена»: видно, дошла ли последняя выгрузка и когда именно."
                empty="Обменов ещё не было" cols={[
                { h: 'Операция', r: (r: any) => ({ price_push: 'Выгрузка цен', orders_pull: 'Забор заказов', order_accept: 'Приём заказа' } as any)[r.kind] ?? r.kind },
                { h: 'Результат', r: (r: any) => r.ok ? <Badge tone="ok">ок</Badge> : <Badge tone="bad">ошибка</Badge> },
                { h: 'Детали', k: 'detail' },
                { h: 'Когда', r: (r: any) => dt(r.created_at) },
              ]} rows={log} />
            </Card>
          )}
        </div>
      )}
    </>
  );
}
