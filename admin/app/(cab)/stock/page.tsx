'use client';
/**
 * Склад: остатки и документы. Модель UMAG — черновик не трогает учёт,
 * на остатки влияет только проведение.
 *
 * Пять таблиц раздела — это пять разных сущностей, поэтому они разведены
 * по вкладкам, а открытый черновик живёт отдельной карточкой НАД вкладками:
 * пока документ не проведён, он и есть то, чем человек занят.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Btn, Input, Select, Field,
  confirmDanger, money, num, dt, C, ErrLine, Badge, Status } from '../../../lib/ui';

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
      else if (tab === 'cells' || tab === 'picking') {
        const list = await api('/warehouse/list');
        setWh(list); const id = whId || list.find((w: any) => w.is_primary)?.id || list[0]?.id;
        setWhId(id);
        if (tab === 'cells' && id) setCells(await api(`/warehouse/${id}/cells`));
        if (tab === 'picking') setPicks(await api('/warehouse/picking'));
      }
      else setDocs(await api('/stock/docs' + (showDeleted ? '?deleted=true' : '')));
    } catch (e: any) { setErr(e.message); }
  };
  // showDeleted в зависимостях: без него галочка «показать удалённые»
  // меняла состояние, но список не перезапрашивался — удалённые появлялись
  // только после переключения вкладки туда-обратно.
  useEffect(() => { setErr(''); load(); }, [tab, showDeleted]);

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
    const total = items.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.price) || 0), 0);
    // Проведение меняет остатки и себестоимость — называем последствие.
    if (!await confirmDanger(
      `Провести ${KINDS[doc.kind].toLowerCase()} №${doc.number}?`,
      doc.kind === 'supply'
        ? `Остатки вырастут на ${items.length} позиций, себестоимость пересчитается${total > 0 ? ` на сумму ${money(total)}` : ''}. Отменить проведение можно только обратным документом.`
        : `Остатки изменятся по ${items.length} позициям. Отменить проведение можно только обратным документом.`,
    )) return;
    try {
      await api(`/stock/docs/${doc.id}/process`, { method: 'POST', body: JSON.stringify({}) });
      setMsg(`${KINDS[doc.kind]} №${doc.number} проведена — остатки обновлены`);
      setDoc(null); setTab('docs'); load();
    } catch (e: any) { setErr(e.message); }
  };

  const zero = balance.filter((r: any) => Number(r.qty) <= 0).length;
  const stockSum = balance.reduce((s: number, r: any) =>
    s + (r.avg_cost != null ? Number(r.qty) * Number(r.avg_cost) : 0), 0);
  const drafts = docs.filter((d: any) => d.status === 'draft').length;

  const fact = tab === 'balance'
    ? (balance.length ? `${balance.length} позиций на ${money(stockSum)}${zero ? ` · ${zero} с нулём или минусом` : ''}` : 'Остатков нет')
    : tab === 'cells'
      ? `${cells.length} ячеек на складе`
      : tab === 'picking'
        ? `${picks.length} листов отбора`
        : `${docs.length} документов${drafts ? ` · ${drafts} черновиков` : ''}`;

  return (
    <>
      <PageHeader
        title="Склад"
        fact={fact}
        actions={Object.entries(KINDS).slice(0, 4).map(([k, label]: any) => (
          <Btn key={k} kind={k === 'supply' ? 'primary' : 'ghost'} onClick={() => createDoc(k)}>{label}</Btn>
        ))}
        note="Черновик не трогает учёт: на остатки и себестоимость влияет только проведение. Поэтому документ можно спокойно набирать частями и вернуться к нему завтра."
      />
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      {doc && (
        // Открытый черновик — над вкладками и с рамкой цвета «черновик»:
        // это то, чем человек занят прямо сейчас, а не ещё одна таблица.
        <Card style={{ marginTop: 14, borderColor: '#E8DCC3', background: '#FFFCF6' }}
              title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                {KINDS[doc.kind]} №{doc.number} <Status value="draft" />
              </span>}
              right={<Btn kind="ghost" onClick={() => setDoc(null)}>Закрыть</Btn>}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', position: 'relative' }}>
            <Field label="Товар">
              <div style={{ position: 'relative' }}>
                <Input value={line.q ?? ''} w={280} placeholder="Начните вводить название"
                       onChange={(e: any) => searchProducts(e.target.value)} />
                {found.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: C.card,
                    border: `1px solid ${C.line}`, borderRadius: 10, zIndex: 5, maxHeight: 220, overflowY: 'auto',
                    boxShadow: '0 12px 32px rgba(23,33,29,.14)', marginTop: 4 }}>
                    {found.map((f: any) => (
                      <div key={f.id} onClick={() => { setLine({ ...line, productId: f.id, q: f.name }); setFound([]); }}
                           style={{ padding: '10px 12px', cursor: 'pointer', fontSize: 14, lineHeight: 1.4 }}>{f.name}</div>
                    ))}
                  </div>
                )}
              </div>
            </Field>
            <Field label="Кол-во"><Input type="number" value={line.qty ?? ''} w={100} style={{ textAlign: 'right' }} onChange={(e: any) => setLine({ ...line, qty: e.target.value })} /></Field>
            {doc.kind === 'supply' && <Field label="Цена закупа, ₸"><Input type="number" value={line.price ?? ''} w={120} style={{ textAlign: 'right' }} onChange={(e: any) => setLine({ ...line, price: e.target.value })} /></Field>}
            <Btn kind="ghost" onClick={addLine} disabled={!line.productId || !line.qty}>Добавить строку</Btn>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'flex-end' }}>
              {items.length > 0 && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 12, color: C.dim }}>Итого по документу</div>
                  <div style={{ fontSize: 19, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {money(items.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.price) || 0), 0))}
                  </div>
                </div>
              )}
              <Btn onClick={process} disabled={items.length === 0}>Провести</Btn>
            </div>
          </div>
          {items.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <DataTable storageKey="stock" exportName="stock" search={false}
                hint="Строки уже сохранены в черновике: можно закрыть окно и вернуться завтра. На остатки они начнут влиять только после проведения."
                empty="В документе пока нет строк — найдите товар и добавьте первую"
                cols={[
                { h: 'Товар', k: 'name' },
                { h: 'Кол-во', right: true, r: (r) => num(r.qty) },
                { h: 'Цена', right: true, r: (r) => r.price ? money(r.price) : <span style={{ color: C.faint }}>—</span> },
                { h: 'Сумма', right: true, r: (r) => r.price
                    ? money(Number(r.qty) * Number(r.price))
                    : <span style={{ color: C.faint }}>—</span> },
              ]} rows={items} />
            </div>
          )}
        </Card>
      )}

      <div style={{ marginTop: 16 }}>
        <Tabs active={tab} onChange={setTab} tabs={[{ key: 'balance', label: 'Остатки' }, { key: 'docs', label: 'Документы' }, { key: 'cells', label: 'Ячейки' }, { key: 'picking', label: 'Листы отбора' }]} />

        {tab === 'balance' && (
          <Card>
            <DataTable storageKey="stock-2" exportName="stock-2"
              hint="Минус в остатке значит, что продавали то, чего по учёту нет: обычно забыли провести приёмку. Инвентаризация это исправит, но сначала стоит понять причину."
              empty="Остатков нет — проведите первую приёмку"
              cols={[
                { h: 'Товар', r: (r) => r.product_name ?? r.name },
                { h: 'Склад', r: (r) => r.warehouse_name ?? <span style={{ color: C.faint }}>—</span> },
                { h: 'Остаток', right: true, r: (r) => {
                    const q = Number(r.qty);
                    return <span style={{ color: q <= 0 ? C.red : C.text, fontWeight: q <= 0 ? 600 : 400 }}>{num(q)}</span>;
                  } },
                { h: 'Себестоимость', right: true, r: (r) => r.avg_cost != null ? money(r.avg_cost) : <span style={{ color: C.faint }}>—</span> },
                { h: 'Сумма', right: true, r: (r) => r.avg_cost != null ? money(Number(r.qty) * Number(r.avg_cost)) : <span style={{ color: C.faint }}>—</span> },
              ]}
              rows={balance} />
          </Card>
        )}

        {tab === 'docs' && (
          <Card>
            <DataTable storageKey="stock-3" exportName="stock-3"
              hint="Удаление документа обратимо: удалённые скрыты, но не потеряны. Восстановленный документ придёт черновиком — движения по складу сами не появятся."
              empty="Документов пока нет — начните с приёмки"
              extra={
                // Удалённые скрыты, но не потеряны: у UMAG удаление обратимо,
                // и это важнее аккуратного списка — удалить по ошибке приёмку
                // на полмиллиона и потерять её насовсем недопустимо.
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, cursor: 'pointer',
                  color: showDeleted ? C.text : C.dim, minHeight: 38, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)}
                    style={{ width: 16, height: 16, accentColor: C.accent }} />
                  Показать удалённые
                </label>
              }
              cols={[
                { h: '№', k: 'number' },
                { h: 'Тип', r: (r) => KINDS[r.kind] ?? r.kind },
                { h: 'Статус', r: (r: any) => <Status value={r.status} /> },
                { h: 'Создан', r: (r) => dt(r.created_at) },
                { h: 'Сумма', right: true, r: (r) => r.total != null ? money(r.total) : <span style={{ color: C.faint }}>—</span> },
                { h: '', r: (r: any) => r.deleted_at ? (
                    // Восстановление — исключение, а не рядовое действие:
                    // тихая кнопка, а не primary.
                    <Btn kind="ghost" style={{ color: C.dim }} onClick={async () => {
                      // Возвращаем документ. Он придёт ЧЕРНОВИКОМ: движения
                      // по складу сами собой не появятся, человек посмотрит
                      // и проведёт заново осознанно.
                      try { await api(`/stock/docs/${r.id}/restore`, { method: 'POST', body: '{}' }); load(); }
                      catch (e: any) { setErr(e.message); }
                    }}>Восстановить</Btn>
                  ) : null },
              ]}
              rows={docs} />
          </Card>
        )}

        {tab === 'cells' && (
          <Card title="Адресное хранение">
            <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55, maxWidth: '82ch' }}>
              Ячейки нужны большим складам. Магазину у дома можно не включать —
              всё работает по складу целиком. До 10 зон на склад.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
              <Select value={whId} onChange={async (e: any) => { setWhId(e.target.value); setCells(await api(`/warehouse/${e.target.value}/cells`)); }}
                options={wh.map((w: any) => ({ value: w.id, label: w.name + (w.bin_enabled ? ' (ячейки вкл)' : '') }))} />
              {wh.find((w: any) => w.id === whId && !w.bin_enabled) && (
                <Btn kind="ghost" onClick={async () => { await api(`/warehouse/${whId}/bin-enabled`, { method: 'POST', body: '{"enabled":true}' });
                  setWh(await api('/warehouse/list')); }}>Включить ячейки</Btn>)}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, alignItems: 'flex-end' }}>
              <Field label="Новая зона (стеллаж)">
                <Input placeholder="Стеллаж А" value={zoneName} onChange={(e: any) => setZoneName(e.target.value)} w={200} />
              </Field>
              <Btn kind="ghost" onClick={async () => { setErr(''); setPmsg('');
                try { await api(`/warehouse/${whId}/zones`, { method: 'POST', body: JSON.stringify({ name: zoneName }) }); setZoneName(''); setPmsg('Зона создана'); }
                catch (e: any) { setErr(e.message); } }}>Добавить зону</Btn>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'flex-end' }}>
              <Field label="Адрес ячейки">
                <Input placeholder="А-01-03" value={cellForm.address ?? ''} onChange={(e: any) => setCellForm({ ...cellForm, address: e.target.value })} w={160} />
              </Field>
              <Field label="Штрихкод ячейки">
                <Input placeholder="WH0100103" value={cellForm.barcode ?? ''} onChange={(e: any) => setCellForm({ ...cellForm, barcode: e.target.value })} w={180} />
              </Field>
              <Btn onClick={async () => { setErr(''); setPmsg('');
                try { await api('/warehouse/cells', { method: 'POST', body: JSON.stringify({ warehouseId: whId, address: cellForm.address, barcode: cellForm.barcode }) });
                  setCellForm({}); setCells(await api(`/warehouse/${whId}/cells`)); setPmsg('Ячейка создана'); }
                catch (e: any) { setErr(e.message); } }}>Добавить ячейку</Btn>
            </div>
            {pmsg && <p style={{ color: C.accentDark, fontSize: 13 }}>{pmsg}</p>}
            <DataTable storageKey="stock-4" exportName="stock-4"
              hint="Штрихкод ячейки клеится на стеллаж: кладовщик сканирует его вместо набора адреса руками."
              empty="Ячеек пока нет. Если склад один и небольшой, они вам не нужны" cols={[
              { h: 'Адрес', k: 'address' },
              { h: 'Зона', r: (r: any) => r.zone ?? <span style={{ color: C.faint }}>—</span> },
              { h: 'Штрихкод', r: (r: any) => r.barcode ?? <span style={{ color: C.faint }}>—</span> },
              { h: 'Товаров', right: true, k: 'products' },
              { h: 'Всего единиц', right: true, r: (r: any) => num(r.total_qty) },
            ]} rows={cells} />
          </Card>
        )}

        {tab === 'picking' && (
          <Card title="Листы отбора">
            <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55, maxWidth: '82ch' }}>
              Маршрут сбора товара по ячейкам — печатается, кладовщик идёт по
              адресам. Создаётся из документов склада.
            </p>
            <DataTable storageKey="stock-5" exportName="stock-5"
              hint="«Собрано» показывает, сколько позиций уже сняли с полок. Незакрытый лист — товар, который наполовину лежит на полу склада."
              empty="Листов отбора пока нет. Они нужны складам с ячейками" cols={[
              { h: 'Номер', k: 'number' },
              { h: 'Позиций', right: true, k: 'items' },
              { h: 'Собрано', right: true, r: (r: any) => (
                  <span style={{ whiteSpace: 'nowrap', fontWeight: Number(r.picked) < Number(r.items) ? 600 : 400,
                    color: Number(r.picked) < Number(r.items) ? C.amber : C.text }}>
                    {r.picked} / {r.items}
                  </span>
                ) },
              { h: 'Статус', r: (r: any) => <Status value={r.status} /> },
              { h: 'Создан', r: (r: any) => dt(r.created_at) },
            ]} rows={picks} />
          </Card>
        )}

      </div>
    </>
  );
}
