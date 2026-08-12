'use client';
/**
 * Техкарты (часть 35) — для кофейни/выпечки при магазине. Готовое блюдо
 * (латте, булочка) списывает ИНГРЕДИЕНТЫ при продаже. Себестоимость считается
 * из сырья. Не полное производство МоегоСклада — ровно под магазин у дома.
 *
 * Единственный раздел, у которого не было пустого состояния вовсе. А он же
 * самый неочевидный: человек, зашедший впервые, должен понять, зачем он тут.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, EmptyState, Btn, Input, Select, Field, Badge, money, num, C, ErrLine } from '../../../lib/ui';

export default function TechcardsPage() {
  const [products, setProducts] = useState<any[]>([]);
  const [dish, setDish] = useState('');
  const [yield_, setYield] = useState('1');
  const [rows, setRows] = useState<any[]>([{ productId: '', qty: '', unit: '' }]);
  const [cost, setCost] = useState<any>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try { const r = await api('/goods?limit=500'); setProducts(Array.isArray(r) ? r : r.items ?? []); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const setRow = (i: number, k: string, v: string) => {
    const next = [...rows]; next[i] = { ...next[i], [k]: v };
    if (i === rows.length - 1 && v) next.push({ productId: '', qty: '', unit: '' });
    setRows(next);
  };

  const save = async () => {
    setErr(''); setMsg(''); setCost(null);
    const items = rows.filter((r) => r.productId && r.qty)
      .map((r) => ({ productId: r.productId, qty: Number(r.qty), unit: r.unit || undefined }));
    if (!dish) { setErr('Выберите готовое блюдо'); return; }
    if (!items.length) { setErr('Добавьте хотя бы один ингредиент'); return; }
    try {
      const r = await api(`/goods/${dish}/bundle`, { method: 'POST',
        body: JSON.stringify({ mode: 'recipe', yield: Number(yield_) || 1, items }) });
      setMsg(`Техкарта сохранена. Себестоимость: ${money(r.cost)}`);
      const rc = await api(`/goods/${dish}/recipe-cost`);
      setCost(rc);
    } catch (e: any) { setErr(e.message); }
  };

  const filled = rows.filter((r) => r.productId && r.qty).length;

  return (
    <>
      <PageHeader
        title="Техкарты"
        fact={`${products.length} товаров доступны как ингредиенты${filled ? ` · в рецепте ${filled}` : ''}`}
        note="Для кофейни или выпечки при магазине. Готовое блюдо списывает ингредиенты при продаже, а себестоимость считается из сырья. Например: латте — это зёрна, молоко и стакан."
      />
      <ErrLine err={err} />
      {msg && <p style={{ color: C.accentDark, fontSize: 13 }}>{msg}</p>}

      <Card title="Создать техкарту" style={{ marginTop: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 14 }}>
          <Field label="Готовое блюдо">
            <Select value={dish} onChange={(e: any) => setDish(e.target.value)}
              options={[{ value: '', label: '— выберите товар —' }, ...products.map((p: any) => ({ value: p.id, label: p.name }))]} />
          </Field>
          <Field label="Выход (порций из рецепта)">
            <Input type="number" value={yield_} onChange={(e: any) => setYield(e.target.value)} />
          </Field>
        </div>

        <div style={{ fontSize: 13, color: C.dim, marginBottom: 8 }}>Ингредиенты:</div>
        {rows.map((row, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
            <Select value={row.productId} onChange={(e: any) => setRow(i, 'productId', e.target.value)}
              options={[{ value: '', label: '— ингредиент —' }, ...products.filter((p: any) => p.id !== dish).map((p: any) => ({ value: p.id, label: p.name }))]} />
            <Input type="number" placeholder="Кол-во" value={row.qty} onChange={(e: any) => setRow(i, 'qty', e.target.value)} style={{ textAlign: 'right' }} />
            <Input placeholder="ед. (г/мл/шт)" value={row.unit} onChange={(e: any) => setRow(i, 'unit', e.target.value)} />
          </div>
        ))}
        <Btn onClick={save} style={{ marginTop: 6 }}>Сохранить техкарту</Btn>
      </Card>

      <Card title="Себестоимость блюда" style={{ marginTop: 14 }}>
        {cost ? (
          <>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
              <Badge tone="ok">{money(cost.cost)} за порцию</Badge>
              <span style={{ fontSize: 13, color: C.dim }}>выход: {num(cost.yield)}</span>
            </div>
            <DataTable
              hint="Смотрите на столбец «Закупка»: в латте дорогое обычно не молоко, а зерно — и цену держать нужно там."
              storageKey="techcards" exportName="techcards" search={false}
              empty="В рецепте нет ингредиентов"
              cols={[
                { h: 'Ингредиент', k: 'name' },
                { h: 'На рецепт', right: true, r: (r: any) => `${num(r.qty)} ${r.unit ?? ''}` },
                { h: 'Закупка', right: true, r: (r: any) => r.purchasePrice != null ? money(r.purchasePrice) : '—' },
              ]} rows={cost.components} />
          </>
        ) : (
          // Пустого состояния тут не было вовсе — а раздел самый неочевидный
          // в кабинете. Говорим, что нажать, а не «нет данных».
          <EmptyState text="Себестоимость появится после сохранения первой техкарты. Выберите готовое блюдо, добавьте ингредиенты и нажмите «Сохранить техкарту»." />
        )}
      </Card>
    </>
  );
}
