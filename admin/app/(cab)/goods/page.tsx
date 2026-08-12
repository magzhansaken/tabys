'use client';
/**
 * Товары: поиск, карточка-создание, цены. Импорт из Excel — по шаблону КЗ
 * (как у МоегоСклада, но с НКТ и весовыми товарами сразу).
 */
import { useEffect, useState } from 'react';
import { api, downloadXlsx } from '../../../lib/api';
import { Card, Table, DataTable, Btn, Input, Select, Field, money, C, ErrLine, Badge } from '../../../lib/ui';

export default function GoodsPage() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ kind: 'simple' });
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try { setRows(await api(`/goods?q=${encodeURIComponent(q)}&limit=50`)); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); api('/goods/categories').then(setCats).catch(() => {}); }, []);

  const create = async () => {
    setErr(''); setMsg('');
    try {
      await api('/goods', { method: 'POST', body: JSON.stringify({
        ...form,
        purchasePrice: form.purchasePrice ? +form.purchasePrice : undefined,
        salePrice: form.salePrice ? +form.salePrice : undefined,
      }) });
      setMsg(`Товар «${form.name}» создан`); setForm({ kind: 'simple' }); setShowForm(false); load();
    } catch (e: any) { setErr(e.message); }
  };

  const exportGoods = async () => {
    setErr('');
    try { await downloadXlsx(`/export/goods${q ? '?q=' + encodeURIComponent(q) : ''}`); }
    catch (e: any) { setErr(e.message); }
  };

  const downloadTemplate = async () => {
    const t = await api('/import/template?kind=kz');
    const a = document.createElement('a');
    a.href = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + t.base64;
    a.download = t.fileName; a.click();
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>Товары</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn kind="ghost" onClick={exportGoods}>Скачать Excel</Btn>
          <Btn kind="ghost" onClick={downloadTemplate}>Шаблон импорта (Excel)</Btn>
          <Btn onClick={() => setShowForm(!showForm)}>{showForm ? 'Скрыть форму' : 'Новый товар'}</Btn>
        </div>
      </div>
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      {showForm && (
        <Card title="Новый товар" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Название"><Input value={form.name ?? ''} onChange={(e: any) => setForm({ ...form, name: e.target.value })} w={220} /></Field>
            <Field label="Тип">
              <Select value={form.kind} onChange={(e: any) => setForm({ ...form, kind: e.target.value })}
                options={[{ value: 'simple', label: 'Штучный' }, { value: 'weight', label: 'Весовой' }, { value: 'service', label: 'Услуга' }]} />
            </Field>
            <Field label="Категория">
              <Select value={form.categoryId ?? ''} onChange={(e: any) => setForm({ ...form, categoryId: e.target.value || undefined })}
                options={[{ value: '', label: '—' }, ...cats.map((c: any) => ({ value: c.id, label: c.name }))]} />
            </Field>
            <Field label="Штрихкод"><Input value={form.barcode ?? ''} onChange={(e: any) => setForm({ ...form, barcode: e.target.value })} w={140} /></Field>
            <Field label="Закуп, ₸"><Input type="number" value={form.purchasePrice ?? ''} onChange={(e: any) => setForm({ ...form, purchasePrice: e.target.value })} w={100} /></Field>
            <Field label="Продажа, ₸"><Input type="number" value={form.salePrice ?? ''} onChange={(e: any) => setForm({ ...form, salePrice: e.target.value })} w={100} /></Field>
            <Btn onClick={create} disabled={!form.name}>Создать</Btn>
          </div>
        </Card>
      )}

      <Card style={{ marginTop: 14 }}
        title={<span>Каталог</span>}
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            <Input placeholder="Поиск по названию или штрихкоду" value={q} w={260}
                   onChange={(e: any) => setQ(e.target.value)} onKeyDown={(e: any) => e.key === 'Enter' && load()} />
            <Btn kind="ghost" onClick={load}>Найти</Btn>
          </div>
        }>
        <DataTable storageKey="goods" exportName="goods" empty="Товаров не найдено — создайте первый или загрузите из Excel"
          cols={[
            { h: 'Название', r: (r) => <span>{r.name} {r.kind === 'weight' && <Badge tone="dim">весовой</Badge>}</span> },
            { h: 'Штрихкод', k: 'barcode' },
            { h: 'Категория', k: 'category_name' },
            { h: 'Закуп', right: true, r: (r) => r.purchase_price != null ? money(r.purchase_price) : '—' },
            { h: 'Продажа', right: true, r: (r) => r.sale_price != null ? money(r.sale_price) : '—' },
          ]}
          rows={rows} />
      </Card>
    </>
  );
}
