'use client';
/**
 * Kaspi магазин (часть 32) — интеграция с маркетплейсом. Подключение, маппинг
 * товаров, выгрузка цен/остатков, заказы с приёмом и отгрузкой.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, Input, Field, Badge, money, num, dt, C, ErrLine } from '../../../lib/ui';

const STATE_LABEL: Record<string, string> = {
  new: 'Новый', sign_required: 'Ждёт подписи', pickup: 'Самовывоз',
  delivery: 'Доставка', archive: 'Завершён',
};

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

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>Kaspi магазин</h1>
      <p style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>
        Интеграция с маркетплейсом: заказы, выгрузка цен и остатков. Единый
        остаток — продажа на Kaspi списывает тот же склад, что и касса.
      </p>
      <ErrLine err={err} />
      {msg && <p style={{ color: C.accentDark, fontSize: 13 }}>{msg}</p>}

      {!conn && (
        <Card title="Подключение" style={{ marginTop: 12 }}>
          <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
            Подключите магазин: введите ID продавца и токен из кабинета Kaspi.
          </p>
          <Btn onClick={() => act(() => api('/marketplace/connect', { method: 'POST', body: JSON.stringify({ provider: 'mock', merchantId: 'DEMO', authToken: 'demo-token' }) }), 'Подключено (демо)')}>
            Подключить (демо)
          </Btn>
        </Card>
      )}

      {conn && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
            <Badge tone="ok">Подключено: {conn.provider}</Badge>
            {conn.last_sync_at && <span style={{ fontSize: 13, color: C.dim }}>Синхр.: {dt(conn.last_sync_at)}</span>}
            <Btn kind="ghost" onClick={() => act(() => api('/marketplace/push-prices', { method: 'POST', body: JSON.stringify({ provider: 'mock' }) }), 'Цены и остатки выгружены')}>Выгрузить цены/остатки</Btn>
            <Btn kind="ghost" onClick={() => act(() => api('/marketplace/pull-orders', { method: 'POST', body: JSON.stringify({ provider: 'mock' }) }), 'Заказы обновлены')}>Забрать заказы</Btn>
          </div>

          <Tabs active={tab} onChange={setTab} tabs={[
            { key: 'orders', label: 'Заказы' },
            { key: 'listings', label: 'Товары на Kaspi' },
            { key: 'log', label: 'Журнал' },
          ]} />

          {tab === 'orders' && (
            <Card title="Заказы с маркетплейса">
              <DataTable hint="Заказы с Kaspi Магазина и выгрузка цен с остатками. Остаток единый: продажа на Kaspi списывает тот же склад, что и касса." storageKey="marketplace" exportName="marketplace" empty="Заказов пока нет — нажмите «Забрать заказы»" cols={[
                { h: 'Код', k: 'code' },
                { h: 'Клиент', k: 'customer_name' },
                { h: 'Сумма', right: true, r: (r: any) => money(r.total_price) },
                { h: 'Доставка', r: (r: any) => r.delivery_mode ?? '—' },
                { h: 'Статус', r: (r: any) => <Badge tone={r.state === 'archive' ? 'ok' : 'warn'}>{STATE_LABEL[r.state] ?? r.state}</Badge> },
                { h: 'Действие', r: (r: any) => !r.accepted_at
                    ? <Btn kind="ghost" onClick={() => act(() => api(`/marketplace/orders/${r.id}/accept`, { method: 'POST', body: JSON.stringify({ provider: 'mock' }) }), 'Заказ принят')}>Принять</Btn>
                    : r.state !== 'archive'
                      ? <Btn kind="ghost" onClick={() => act(() => api(`/marketplace/orders/${r.id}/complete`, { method: 'POST', body: JSON.stringify({ provider: 'mock' }) }), 'Заказ выдан, товар списан')}>Выдать</Btn>
                      : <span style={{ color: C.dim, fontSize: 13 }}>готово</span> },
              ]} rows={orders} />
            </Card>
          )}

          {tab === 'listings' && (
            <Card title="Товары на маркетплейсе">
              <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
                Сопоставление наших товаров с кодами (SKU) на Kaspi. Без маппинга
                заказы приходят «нераспознанными».
              </p>
              <DataTable storageKey="marketplace-2" exportName="marketplace-2" empty="Товары ещё не сопоставлены" cols={[
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
              <DataTable storageKey="marketplace-3" exportName="marketplace-3" empty="Обменов ещё не было" cols={[
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
