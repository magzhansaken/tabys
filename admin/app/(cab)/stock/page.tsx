'use client';
/**
 * Склад: остатки и документы. Модель UMAG — черновик не трогает учёт,
 * на остатки влияет только проведение.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, Input, Select, Field, money, num, dt, C, ErrLine, Badge , Status} from '../../../lib/ui';

const KINDS: any = { supply: 'Приёмка', writeoff: 'Списание', transfer: 'Перемещение', inventory: 'Инвентаризация', capitalization: 'Оприходование' };

export default function StockPage() {
  const [tab, setTab] = useState('balance');
  const [wh, setWh] = useState<any[]>([]);
  const [whId, setWhId] = useState('');
  const [cells, setCells] = useState<any[]>([]);
  const [cellForm, setCellForm] = useState<any>({});
  const [zoneName, setZoneName] = useState('');
  const [picks, setPicks] = useState<any[]>([]);
  const [pmsg, setPmsg] = useState('');
  const [balance, setBalance] = useState<any[]>([]);
  const [docs, setDocs] = useState<any[]>([]);
  const [showDeleted, setShowDeleted] = useState(false);   // удалённые скрыты по умолчанию
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // Черновик, открытый в редакторе
  const [doc, setDoc] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [line, setLine] = useState<any>({});
  const [found, setFound] = useState<any[]>([]);

  const load = async () => {
    try {
      if (tab === 'balance') setBalance(await api('/stock/balance?onlyNonZero=false'));
      if (tab === 'cells' || tab === 'picking') {
        const list = await api('/warehouse/list');
        setWh(list); const id = whId || list.find((w: any) => w.is_primary)?.id || list[0]?.id;
        setWhId(id);
        if (tab === 'cells' && id) setCells(await api(`/warehouse/${id}/cells`));
        if (tab === 'picking') setPicks(await api('/warehouse/picking'));
      }
      else setDocs(await api('/stock/docs' + (showDeleted ? '?deleted=true' : '')));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { setErr(''); load(); }, [tab]);

  const createDoc = async (kind: string) => {
    setErr(''); setMsg('');
    try { const d = await api('/stock/docs', { method: 'POST', body: JSON.stringify({ kind }) }); setDoc(d); setItems([]); }
    catch (e: any) { setErr(e.message); }
  };

  const searchProducts = async (q: string) => {
    setLine({ ...line, q });
    if (q.length < 2) return setFound([]);
    try { setFound(await api(`/goods?q=${encodeURIComponent(q)}&limit=8`)); } catch {}
  };

  const addLine = async () => {
    setErr('');
    try {
      await api(`/stock/docs/${doc.id}/items`, { method: 'POST',
        body: JSON.stringify({ productId: line.productId, qty: +line.qty, price: line.price ? +line.price : undefined }) });
      setItems([...items, { name: line.q, qty: +line.qty, price: line.price }]);
      setLine({}); setFound([]);
    } catch (e: any) { setErr(e.message); }
  };

  const process = async () => {
    setErr('');
    try {
      await api(`/stock/docs/${doc.id}/process`, { method: 'POST', body: JSON.stringify({}) });
      setMsg(`${KINDS[doc.kind]} №${doc.number} проведена — остатки обновлены`);
      setDoc(null); setTab('docs'); load();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Склад</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {Object.entries(KINDS).slice(0, 4).map(([k, label]: any) => (
            <Btn key={k} kind={k === 'supply' ? 'primary' : 'ghost'} onClick={() => createDoc(k)}>{label}</Btn>
          ))}
        </div>
      </div>
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      {doc && (
        <Card title={`${KINDS[doc.kind]} №${doc.number} — черновик`} style={{ marginTop: 14 }}
              right={<Btn kind="ghost" onClick={() => setDoc(null)}>Закрыть</Btn>}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', position: 'relative' }}>
            <Field label="Товар">
              <div style={{ position: 'relative' }}>
                <Input value={line.q ?? ''} w={260} placeholder="Начните вводить название"
                       onChange={(e: any) => searchProducts(e.target.value)} />
                {found.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: `1px solid ${C.line}`, borderRadius: 8, zIndex: 5, maxHeight: 200, overflowY: 'auto' }}>
                    {found.map((f: any) => (
                      <div key={f.id} onClick={() => { setLine({ ...line, productId: f.id, q: f.name }); setFound([]); }}
                           style={{ padding: 8, cursor: 'pointer', fontSize: 14 }}>{f.name}</div>
                    ))}
                  </div>
                )}
              </div>
            </Field>
            <Field label="Кол-во"><Input type="number" value={line.qty ?? ''} w={90} onChange={(e: any) => setLine({ ...line, qty: e.target.value })} /></Field>
            {doc.kind === 'supply' && <Field label="Цена закупа"><Input type="number" value={line.price ?? ''} w={110} onChange={(e: any) => setLine({ ...line, price: e.target.value })} /></Field>}
            <Btn onClick={addLine} disabled={!line.productId || !line.qty}>Добавить строку</Btn>
            <Btn onClick={process} disabled={items.length === 0} style={{ marginLeft: 'auto' }}>Провести</Btn>
          </div>
          {items.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <DataTable storageKey="stock" exportName="stock" cols={[{ h: 'Товар', k: 'name' }, { h: 'Кол-во', right: true, r: (r) => num(r.qty) },
                            { h: 'Цена', right: true, r: (r) => r.price ? money(r.price) : '—' }]} rows={items} />
            </div>
          )}
        </Card>
      )}

      <div style={{ marginTop: 16 }}>
        <Tabs active={tab} onChange={setTab} tabs={[{ key: 'balance', label: 'Остатки' }, { key: 'docs', label: 'Документы' }, { key: 'cells', label: 'Ячейки' }, { key: 'picking', label: 'Листы отбора' }]} />
        {tab === 'balance' ? (
          <Card>
            <DataTable storageKey="stock-2" exportName="stock-2" empty="Остатков нет — проведите первую приёмку"
              cols={[
                { h: 'Товар', r: (r) => r.product_name ?? r.name },
                { h: 'Склад', r: (r) => r.warehouse_name ?? '—' },
                { h: 'Остаток', right: true, r: (r) => num(r.qty) },
                { h: 'Себестоимость', right: true, r: (r) => r.avg_cost != null ? money(r.avg_cost) : '—' },
                { h: 'Сумма', right: true, r: (r) => r.avg_cost != null ? money(Number(r.qty) * Number(r.avg_cost)) : '—' },
              ]}
              rows={balance} />
          </Card>
        ) : (
          <Card>
            <DataTable storageKey="stock-3" exportName="stock-3" empty="Документов пока нет"
              extra={
                // Удалённые скрыты, но не потеряны: у UMAG удаление обратимо,
                // и это важнее аккуратного списка — удалить по ошибке приёмку
                // на полмиллиона и потерять её насовсем недопустимо.
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, cursor: 'pointer', color: C.dim }}>
                  <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
                  Показать удалённые
                </label>
              }
              cols={[
                { h: '№', k: 'number' },
                { h: 'Тип', r: (r) => KINDS[r.kind] ?? r.kind },
                { h: 'Статус', r: (r: any) => <Status value={r.status} /> },
                { h: '', r: (r: any) => r.deleted_at ? (
                    <Btn kind="ghost" onClick={async () => {
                      // Возвращаем документ. Он придёт ЧЕРНОВИКОМ: движения
                      // по складу сами собой не появятся, человек посмотрит
                      // и проведёт заново осознанно.
                      try { await api(`/stock/docs/${r.id}/restore`, { method: 'POST', body: '{}' }); load(); }
                      catch (e: any) { setErr(e.message); }
                    }}>Восстановить</Btn>
                  ) : null },
                { h: 'Создан', r: (r) => dt(r.created_at) },
                { h: 'Сумма', right: true, r: (r) => r.total != null ? money(r.total) : '—' },
              ]}
              rows={docs} />
          </Card>
        )}

        {tab === 'cells' && (
          <Card title="Адресное хранение">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
              <Select value={whId} onChange={async (e: any) => { setWhId(e.target.value); setCells(await api(`/warehouse/${e.target.value}/cells`)); }}
                options={wh.map((w: any) => ({ value: w.id, label: w.name + (w.bin_enabled ? ' (ячейки вкл)' : '') }))} />
              {wh.find((w: any) => w.id === whId && !w.bin_enabled) && (
                <Btn kind="ghost" onClick={async () => { await api(`/warehouse/${whId}/bin-enabled`, { method: 'POST', body: '{"enabled":true}' });
                  setWh(await api('/warehouse/list')); }}>Включить ячейки</Btn>)}
            </div>
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Ячейки нужны большим складам. Магазину у дома можно не включать —
              всё работает по складу целиком. До 10 зон на склад.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <Input placeholder="Новая зона (стеллаж)" value={zoneName} onChange={(e: any) => setZoneName(e.target.value)} style={{ maxWidth: 180 }} />
              <Btn kind="ghost" onClick={async () => { setErr(''); setPmsg('');
                try { await api(`/warehouse/${whId}/zones`, { method: 'POST', body: JSON.stringify({ name: zoneName }) }); setZoneName(''); setPmsg('Зона создана'); }
                catch (e: any) { setErr(e.message); } }}>+ Зона</Btn>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <Input placeholder="Адрес (А-01-03)" value={cellForm.address ?? ''} onChange={(e: any) => setCellForm({ ...cellForm, address: e.target.value })} style={{ maxWidth: 150 }} />
              <Input placeholder="Штрихкод ячейки" value={cellForm.barcode ?? ''} onChange={(e: any) => setCellForm({ ...cellForm, barcode: e.target.value })} style={{ maxWidth: 150 }} />
              <Btn onClick={async () => { setErr(''); setPmsg('');
                try { await api('/warehouse/cells', { method: 'POST', body: JSON.stringify({ warehouseId: whId, address: cellForm.address, barcode: cellForm.barcode }) });
                  setCellForm({}); setCells(await api(`/warehouse/${whId}/cells`)); setPmsg('Ячейка создана'); }
                catch (e: any) { setErr(e.message); } }}>+ Ячейка</Btn>
            </div>
            {pmsg && <p style={{ color: C.accentDark, fontSize: 13 }}>{pmsg}</p>}
            <DataTable storageKey="stock-4" exportName="stock-4" empty="Ячеек пока нет" cols={[
              { h: 'Адрес', k: 'address' },
              { h: 'Зона', r: (r: any) => r.zone ?? '—' },
              { h: 'Штрихкод', r: (r: any) => r.barcode ?? '—' },
              { h: 'Товаров', right: true, k: 'products' },
              { h: 'Всего единиц', right: true, r: (r: any) => num(r.total_qty) },
            ]} rows={cells} />
          </Card>
        )}

        {tab === 'picking' && (
          <Card title="Листы отбора">
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Маршрут сбора товара по ячейкам — печатается, кладовщик идёт по
              адресам. Создаётся из документов склада.
            </p>
            <DataTable storageKey="stock-5" exportName="stock-5" empty="Листов отбора пока нет" cols={[
              { h: 'Номер', k: 'number' },
              { h: 'Позиций', right: true, k: 'items' },
              { h: 'Собрано', right: true, r: (r: any) => `${r.picked}/${r.items}` },
              { h: 'Статус', r: (r: any) => <Status value={r.status} /> },
              { h: 'Создан', r: (r: any) => dt(r.created_at) },
            ]} rows={picks} />
          </Card>
        )}

      </div>
    </>
  );
}