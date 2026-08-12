'use client';
/**
 * Акциз (алкоголь) (часть 36) — проверка акцизных марок УКМ (как Wipon Pro).
 * Проверка подлинности при приёмке и продаже алкоголя, учёт марок, защита от
 * контрафакта.
 *
 * Три исхода различаются не бейджем, а крупным словом: приёмщик стоит с
 * ящиком и читает с метра, а от ответа зависит, принимать товар или нет.
 * Поле кода держит фокус: сканер вводит символы и жмёт Enter, руками эти
 * номера никто не набирает.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Btn, Input, Field, Badge,
  MONO, num, dt, C, ErrLine } from '../../../lib/ui';

export default function ExcisePage() {
  const [tab, setTab] = useState('check');
  const [series, setSeries] = useState('');
  const [number, setNumber] = useState('');
  const [barcode, setBarcode] = useState('');
  const [checked, setChecked] = useState<any>(null);
  const [stock, setStock] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const scan = useRef<any>(null);

  const load = async () => {
    setErr('');
    try {
      if (tab === 'stock') setStock(await api('/excise/stock'));
      if (tab === 'history') setHistory(await api('/excise/history'));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [tab]);

  // Курсор возвращается в поле после каждой проверки: следующая бутылка
  // сканируется сразу, без клика мышью.
  useEffect(() => { if (tab === 'check') scan.current?.focus(); }, [tab, checked]);

  const check = async () => {
    setErr(''); setChecked(null);
    try {
      const body = barcode.trim() ? { barcode: barcode.trim() } : { series: series.trim(), number: number.trim() };
      setChecked(await api('/excise/check', { method: 'POST', body: JSON.stringify(body) }));
      setBarcode('');
    } catch (e: any) { setErr(e.message); }
  };

  // Ответ сервера: ok — подлинная; found без ok — марка есть, но уже продана;
  // не found — в базе КГД её нет. Четвёртого исхода сервер не отдаёт.
  const verdict = !checked ? null
    : checked.ok ? { word: 'Подлинная', color: C.accentDark, bg: '#F4F9F6', line: C.accent,
        what: 'Марку можно принимать и продавать.' }
    : checked.found ? { word: 'Уже продана', color: C.red, bg: '#FFFBFA', line: '#E6C7C0',
        what: 'Такая марка уже выбыла из оборота. Скорее всего, это клон — товар не принимайте.' }
    : { word: 'Не найдена', color: C.red, bg: '#FFFBFA', line: '#E6C7C0',
        what: 'Марки нет в базе КГД. Возможен контрафакт — товар не принимайте.' };

  const rejected = stock.reduce((s: number, r: any) => s + Number(r.rejected ?? 0), 0);
  const inStock = stock.reduce((s: number, r: any) => s + Number(r.inStock ?? 0), 0);
  const fact = tab === 'stock'
    ? `${inStock} марок на складе${rejected ? ` · ${rejected} забраковано` : ''}`
    : tab === 'history'
      ? `${history.length} проверок · ${history.filter((r: any) => r.result !== 'ok').length} с вопросами`
      : 'Сканируйте марку — ответ появится сразу';

  return (
    <>
      <PageHeader
        title="Акциз (алкоголь)"
        fact={fact}
        note="Проверка акцизных марок УКМ по базе КГД. Продажа контрафакта грозит штрафом и лишением лицензии, поэтому проверяют при приёмке, а не когда бутылка уже на полке."
      />
      <ErrLine err={err} />

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'check', label: 'Проверить марку' },
          { key: 'stock', label: 'Реестр марок' },
          { key: 'history', label: 'Журнал проверок' },
        ]} />

        {tab === 'check' && (
          <Card title="Проверить УКМ">
            <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55 }}>
              Отсканируйте штрих-код марки — курсор уже стоит в поле. Серию и
              номер вводят руками, только если марка повреждена.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
              <Field label="Штрих-код УКМ (скан)">
                <Input ref={scan} autoFocus value={barcode} w={340}
                  onChange={(e: any) => setBarcode(e.target.value)}
                  onKeyDown={(e: any) => e.key === 'Enter' && check()}
                  placeholder="напр. KZ000000001"
                  style={{ height: 48, fontSize: 18, fontFamily: MONO, letterSpacing: '.04em' }} />
              </Field>
              <Btn onClick={check} style={{ height: 48, minHeight: 48 }}>Проверить</Btn>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap',
              paddingTop: 16, borderTop: `1px solid ${C.lineIn}` }}>
              <span style={{ fontSize: 13, color: C.dim, paddingBottom: 10 }}>Марка повреждена — введите вручную:</span>
              <Input value={series} onChange={(e: any) => setSeries(e.target.value)} placeholder="Серия (KZ)" w={120} />
              <Input value={number} onChange={(e: any) => setNumber(e.target.value)} placeholder="Номер" w={180} />
              <Btn kind="ghost" onClick={check}>Проверить</Btn>
            </div>

            {verdict && (
              <div style={{ marginTop: 20, padding: '20px 22px', borderRadius: 12,
                border: `1.5px solid ${verdict.line}`, background: verdict.bg }}>
                <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.015em', color: verdict.color }}>
                  {verdict.word}
                </div>
                <div style={{ fontSize: 14.5, color: C.prose, marginTop: 8, lineHeight: 1.55, maxWidth: '70ch' }}>
                  {checked.warning || verdict.what}
                </div>
                {checked.found && (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.lineIn}` }}>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{checked.productName}</div>
                    <div style={{ color: C.dim, marginTop: 3, fontSize: 13.5 }}>
                      {checked.kind} · {checked.volume} л · {checked.strength}% · {checked.producer}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        )}

        {tab === 'stock' && (
          <Card title="Реестр акцизных марок">
            <DataTable storageKey="excise" exportName="excise"
              hint="Забракованные марки не удаляются: если придёт проверка, журнал показывает, что контрафакт вы отсекли сами, а не продали."
              empty="Марок пока нет — они появляются после первой приёмки алкоголя" cols={[
              { h: 'Товар', k: 'product' },
              { h: 'На складе', right: true, k: 'inStock' },
              { h: 'Продано', right: true, k: 'sold' },
              { h: 'Забраковано', right: true, r: (r: any) => Number(r.rejected) > 0
                  ? <span style={{ color: C.red, fontWeight: 600 }}>{r.rejected}</span>
                  : <span style={{ color: C.faint }}>—</span> },
            ]} rows={stock} />
          </Card>
        )}

        {tab === 'history' && (
          <Card title="Журнал проверок УКМ">
            <DataTable storageKey="excise-2" exportName="excise-2"
              hint="Журнал — ваше доказательство добросовестности. Он же показывает, кто из поставщиков приносит марки с вопросами."
              empty="Проверок ещё не было" cols={[
              { h: 'Серия', r: (r: any) => <span style={{ fontFamily: MONO, fontSize: 13, whiteSpace: 'nowrap' }}>{r.series}</span> },
              { h: 'Номер', r: (r: any) => <span style={{ fontFamily: MONO, fontSize: 13, whiteSpace: 'nowrap' }}>{r.number}</span> },
              { h: 'Товар', r: (r: any) => r.product_name ?? <span style={{ color: C.faint }}>—</span> },
              { h: 'Результат', r: (r: any) => r.result === 'ok' ? <Badge tone="ok">подлинная</Badge>
                  : r.result === 'already_sold' ? <Badge tone="bad">уже продана</Badge> : <Badge tone="bad">не найдена</Badge> },
              { h: 'Когда', r: (r: any) => dt(r.created_at) },
            ]} rows={history} />
          </Card>
        )}
      </div>
    </>
  );
}
