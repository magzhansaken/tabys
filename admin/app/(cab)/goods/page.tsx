'use client';
/**
 * Товары: поиск, карточка-создание, цены. Импорт из Excel — по шаблону КЗ
 * (как у МоегоСклада, но с НКТ и весовыми товарами сразу).
 *
 * Форма создания — одной строкой с переносом, а не в две колонки: на 390 px
 * второй столбец всё равно уезжает вниз, и порядок полей становится
 * непонятным. Одна строка переносится предсказуемо.
 */
import { useEffect, useState } from 'react';
import { api, downloadXlsx } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Btn, Input, Select, Field, money, C, ErrLine, Badge } from '../../../lib/ui';

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

  // Факт из уже загруженного: список приходит порциями по 50, поэтому
  // «показано», а не «всего» — иначе цифра врала бы на большом каталоге.
  const weight = rows.filter((r: any) => r.kind === 'weight').length;
  const fact = `${cats.length} категорий · показано ${rows.length}${weight ? ` · весовых ${weight}` : ''}`;

  return (
    <>
      <PageHeader
        title="Товары"
        fact={fact}
        actions={<>
          <Btn kind="ghost" onClick={exportGoods}>Скачать Excel</Btn>
          <Btn kind="ghost" onClick={downloadTemplate}>Шаблон импорта</Btn>
          <Btn onClick={() => setShowForm(!showForm)}>{showForm ? 'Скрыть форму' : 'Новый товар'}</Btn>
        </>}
      />
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      {showForm && (
        <Card title="Новый товар" style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Название"><Input value={form.name ?? ''} onChange={(e: any) => setForm({ ...form, name: e.target.value })} w={268} /></Field>
            <Field label="Тип">
              <Select value={form.kind} onChange={(e: any) => setForm({ ...form, kind: e.target.value })}
                options={[{ value: 'simple', label: 'Штучный' }, { value: 'weight', label: 'Весовой' }, { value: 'service', label: 'Услуга' }]} />
            </Field>
            <Field label="Категория">
              <Select value={form.categoryId ?? ''} onChange={(e: any) => setForm({ ...form, categoryId: e.target.value || undefined })}
                options={[{ value: '', label: '—' }, ...cats.map((c: any) => ({ value: c.id, label: c.name }))]} />
            </Field>
            <Field label="Штрихкод"><Input value={form.barcode ?? ''} onChange={(e: any) => setForm({ ...form, barcode: e.target.value })} w={176} /></Field>
            <Field label="Закуп, ₸"><Input type="number" value={form.purchasePrice ?? ''} onChange={(e: any) => setForm({ ...form, purchasePrice: e.target.value })} w={110} style={{ textAlign: 'right' }} /></Field>
            <Field label="Продажа, ₸"><Input type="number" value={form.salePrice ?? ''} onChange={(e: any) => setForm({ ...form, salePrice: e.target.value })} w={110} style={{ textAlign: 'right' }} /></Field>
            <Btn onClick={create} disabled={!form.name}>Создать</Btn>
          </div>
          <p style={{ fontSize: 13, color: C.dim, margin: '14px 0 0', lineHeight: 1.55 }}>
            Весовой товар продаётся долями: 0,84 кг — обычная строка в чеке.
            Цены можно оставить пустыми и заполнить при первой приёмке.
          </p>
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
        <DataTable storageKey="goods" exportName="goods"
          hint="Самый частый рабочий экран. Наценка считается из закупа и продажи — если она пустая, цена закупа ещё не заведена."
          empty="Товаров не найдено — создайте первый или загрузите из Excel"
          cols={[
            { h: 'Название', r: (r) => <span>{r.name} {r.kind === 'weight' && <Badge tone="dim">весовой</Badge>}</span> },
            { h: 'Штрихкод', k: 'barcode' },
            { h: 'Категория', k: 'category_name' },
            { h: 'Закуп', right: true, r: (r) => r.purchase_price != null ? money(r.purchase_price) : '—' },
            { h: 'Продажа', right: true, r: (r) => r.sale_price != null ? money(r.sale_price) : '—' },
            { h: 'Наценка', right: true, r: (r) => {
                const p = Number(r.purchase_price), s = Number(r.sale_price);
                if (!(p > 0) || !(s > 0)) return <span style={{ color: C.faint }}>—</span>;
                return `${(((s - p) / p) * 100).toFixed(1).replace('.', ',')}%`;
              } },
          ]}
          rows={rows} />
      </Card>
    </>
  );
}
