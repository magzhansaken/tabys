'use client';
/**
 * Акциз (алкоголь) (часть 36) — проверка акцизных марок УКМ (как Wipon Pro).
 * Проверка подлинности при приёмке и продаже алкоголя, учёт марок, защита от
 * контрафакта.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, Input, Field, Badge, num, dt, C, ErrLine } from '../../../lib/ui';

export default function ExcisePage() {
  const [tab, setTab] = useState('check');
  const [series, setSeries] = useState('');
  const [number, setNumber] = useState('');
  const [barcode, setBarcode] = useState('');
  const [checked, setChecked] = useState<any>(null);
  const [stock, setStock] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [err, setErr] = useState('');

  const load = async () => {
    setErr('');
    try {
      if (tab === 'stock') setStock(await api('/excise/stock'));
      if (tab === 'history') setHistory(await api('/excise/history'));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [tab]);

  const check = async () => {
    setErr(''); setChecked(null);
    try {
      const body = barcode.trim() ? { barcode: barcode.trim() } : { series: series.trim(), number: number.trim() };
      setChecked(await api('/excise/check', { method: 'POST', body: JSON.stringify(body) }));
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>Акциз (алкоголь)</h1>
      <p style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>
        Проверка акцизных марок УКМ на алкоголь — подлинность через базу КГД
        (как e-Sapa). Продажа контрафакта грозит штрафами и лишением лицензии.
      </p>
      <ErrLine err={err} />

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'check', label: 'Проверить марку' },
          { key: 'stock', label: 'Реестр марок' },
          { key: 'history', label: 'Журнал проверок' },
        ]} />

        {tab === 'check' && (
          <Card title="Проверить УКМ">
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Отсканируйте штрих-код марки или введите серию и номер вручную.
            </p>
            <div style={{ marginBottom: 12 }}>
              <Field label="Штрих-код УКМ (скан)">
                <Input value={barcode} onChange={(e: any) => setBarcode(e.target.value)} placeholder="напр. KZ000000001" />
              </Field>
            </div>
            <div style={{ fontSize: 13, color: C.dim, marginBottom: 8 }}>или вручную:</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <Input value={series} onChange={(e: any) => setSeries(e.target.value)} placeholder="Серия (KZ)" style={{ maxWidth: 120 }} />
              <Input value={number} onChange={(e: any) => setNumber(e.target.value)} placeholder="Номер" style={{ maxWidth: 180 }} />
              <Btn onClick={check}>Проверить</Btn>
            </div>
            {checked && (
              <div style={{ padding: 14, borderRadius: 10, border: `1px solid ${C.line}`,
                background: checked.ok ? '#eefaf4' : '#fdecea' }}>
                <div style={{ marginBottom: 8 }}>
                  <Badge tone={checked.ok ? 'ok' : 'bad'}>{checked.ok ? 'ПОДЛИННАЯ' : 'ВНИМАНИЕ'}</Badge>
                </div>
                {checked.found ? (
                  <div style={{ fontSize: 14 }}>
                    <div><b>{checked.productName}</b></div>
                    <div style={{ color: C.dim, marginTop: 2 }}>
                      {checked.kind} · {checked.volume} л · {checked.strength}% · {checked.producer}
                    </div>
                    {checked.warning && <div style={{ color: C.red, marginTop: 8 }}>{checked.warning}</div>}
                  </div>
                ) : <div style={{ fontSize: 14, color: C.red }}>{checked.warning}</div>}
              </div>
            )}
          </Card>
        )}

        {tab === 'stock' && (
          <Card title="Реестр акцизных марок">
            <DataTable hint="Проверка акцизных марок на алкоголь перед приёмкой и продажей. Продажа контрафакта грозит штрафом и лишением лицензии." storageKey="excise" exportName="excise" empty="Марок пока нет" cols={[
              { h: 'Товар', k: 'product' },
              { h: 'На складе', right: true, k: 'inStock' },
              { h: 'Продано', right: true, k: 'sold' },
              { h: 'Забраковано', right: true, k: 'rejected' },
            ]} rows={stock} />
          </Card>
        )}

        {tab === 'history' && (
          <Card title="Журнал проверок УКМ">
            <DataTable storageKey="excise-2" exportName="excise-2" empty="Проверок ещё не было" cols={[
              { h: 'Серия', k: 'series' },
              { h: 'Номер', k: 'number' },
              { h: 'Товар', r: (r: any) => r.product_name ?? '—' },
              { h: 'Результат', r: (r: any) => r.result === 'ok' ? <Badge tone="ok">подлинная</Badge>
                  : r.result === 'already_sold' ? <Badge tone="warn">уже продана</Badge> : <Badge tone="bad">не найдена</Badge> },
              { h: 'Когда', r: (r: any) => dt(r.created_at) },
            ]} rows={history} />
          </Card>
        )}
      </div>
    </>
  );
}
