'use client';
/**
 * Контрагенты и долговая книга. Долговая книга — сильная сторона Wipon:
 * магазин у дома живёт «в тетрадку», мы переносим тетрадку в кабинет.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, Input, Select, Field, money, dt, C, ErrLine, Badge } from '../../../lib/ui';

export default function ContragentsPage() {
  const [contracts, setContracts] = useState<any[]>([]);
  const [cform, setCform] = useState<any>({ kind: 'sale' });
  const [mergeSel, setMergeSel] = useState<string[]>([]);
  const [primary, setPrimary] = useState('');
  const [pmsg, setPmsg] = useState('');
  const [tab, setTab] = useState('list');
  const [rows, setRows] = useState<any[]>([]);
  const [debts, setDebts] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [checkBin, setCheckBin] = useState('');
  const [checkRes, setCheckRes] = useState<any>(null);
  const [form, setForm] = useState<any>({ role: 'customer' });
  const [pay, setPay] = useState<any>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      if (tab === 'list') setRows(((await api(`/contragents?q=${encodeURIComponent(q)}`)) as any)?.items ?? []);
      else setDebts(((await api('/contragents/debts')) as any)?.items ?? []);
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { setErr(''); load(); if (tab === 'contracts') api('/people/contracts').then(setContracts).catch(() => {}); }, [tab]);

  const create = async () => {
    setErr(''); setMsg('');
    try {
      await api('/contragents', { method: 'POST', body: JSON.stringify({
        name: form.name, phone: form.phone || undefined, iinBin: form.iinBin || undefined,
        roles: [form.role],
        debtLimit: form.debtLimit ? +form.debtLimit : undefined,
      }) });
      setMsg(`«${form.name}» добавлен`); setForm({ role: 'customer' }); load();
    } catch (e: any) { setErr(e.message); }
  };

  const doPay = async () => {
    setErr(''); setMsg('');
    try {
      await api('/contragents/debts/pay', { method: 'POST',
        body: JSON.stringify({ counterpartyId: pay.counterpartyId ?? pay.counterparty_id ?? pay.id, amount: +pay.amount, method: 'cash' }) });
      setMsg('Оплата долга записана'); setPay(null); load();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>Контрагенты</h1>
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab}
              tabs={[{ key: 'list', label: 'Все' }, { key: 'debts', label: 'Долговая книга' }, { key: 'contracts', label: 'Договоры' }, { key: 'merge', label: 'Объединить дубли' }, { key: 'check', label: 'Проверка КГД' }]} />

        {tab === 'list' && (
          <>
            <Card title="Добавить контрагента">
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Field label="Имя или название"><Input value={form.name ?? ''} onChange={(e: any) => setForm({ ...form, name: e.target.value })} w={220} /></Field>
                <Field label="Кто это">
                  <Select value={form.role} onChange={(e: any) => setForm({ ...form, role: e.target.value })}
                    options={[{ value: 'customer', label: 'Покупатель' }, { value: 'supplier', label: 'Поставщик' }]} />
                </Field>
                <Field label="Телефон"><Input value={form.phone ?? ''} placeholder="+7701…" onChange={(e: any) => setForm({ ...form, phone: e.target.value })} w={150} /></Field>
                <Field label="ИИН/БИН"><Input value={form.iinBin ?? ''} onChange={(e: any) => setForm({ ...form, iinBin: e.target.value })} w={140} /></Field>
                {form.role === 'customer' && (
                  <Field label="Лимит долга, ₸"><Input type="number" placeholder="без лимита" value={form.debtLimit ?? ''} onChange={(e: any) => setForm({ ...form, debtLimit: e.target.value })} w={120} /></Field>
                )}
                <Btn onClick={create} disabled={!form.name}>Добавить</Btn>
              </div>
            </Card>
            <Card style={{ marginTop: 14 }} title="Список"
              right={<div style={{ display: 'flex', gap: 8 }}>
                <Input placeholder="Поиск" value={q} onChange={(e: any) => setQ(e.target.value)} onKeyDown={(e: any) => e.key === 'Enter' && load()} />
                <Btn kind="ghost" onClick={load}>Найти</Btn>
              </div>}>
              <DataTable storageKey="contragents" exportName="contragents" empty="Контрагентов пока нет"
                cols={[
                  { h: 'Имя', k: 'name' },
                  { h: 'Роли', r: (r) => (r.roles ?? []).map((x: string) => x === 'customer' ? 'покупатель' : 'поставщик').join(', ') },
                  { h: 'Телефон', k: 'phone' },
                  { h: 'Долг нам', right: true, r: (r) => Number(r.debt ?? 0) > 0 ? <span style={{ color: C.red }}>{money(r.debt)}</span> : '—' },
                  { h: 'Мы должны', right: true, r: (r) => Number(r.supplier_debt ?? 0) > 0 ? money(r.supplier_debt) : '—' },
                ]}
                rows={rows} />
            </Card>
          </>
        )}

        {tab === 'debts' && (
          <Card title="Кто и сколько должен">
            {pay && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 14, padding: 12, background: '#f8f9fb', borderRadius: 10 }}>
                <div style={{ fontSize: 14 }}>Оплата долга: <b>{pay.name}</b></div>
                <Field label="Сумма, ₸"><Input type="number" value={pay.amount ?? ''} w={120} onChange={(e: any) => setPay({ ...pay, amount: e.target.value })} /></Field>
                <Btn onClick={doPay} disabled={!pay.amount}>Принять оплату</Btn>
                <Btn kind="ghost" onClick={() => setPay(null)}>Отмена</Btn>
              </div>
            )}
            <DataTable storageKey="contragents-2" exportName="contragents-2" empty="Долгов нет — отличная новость"
              cols={[
                { h: 'Покупатель', k: 'name' },
                { h: 'Телефон', k: 'phone' },
                { h: 'Долг', right: true, r: (r) => <span style={{ color: C.red }}>{money(r.debt ?? r.amount)}</span> },
                { h: 'Просрочен', r: (r) => (r.daysOverdue > 0) ? <Badge tone="bad">{r.daysOverdue} дн.</Badge> : <Badge tone="dim">нет</Badge> },
                { h: 'Последняя оплата', r: (r) => dt(r.lastPaymentAt) },
                { h: '', r: (r) => <Btn kind="ghost" onClick={() => setPay(r)}>Оплатить</Btn> },
              ]}
              rows={debts} />
          </Card>
        )}

        {tab === 'contracts' && (
          <Card title="Договоры">
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Номер, тип и сроки договора — для ЭСФ/АВР и контроля сроков.
              Просроченные подсвечиваются.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 12 }}>
              <Select value={cform.counterpartyId ?? ''} onChange={(e: any) => setCform({ ...cform, counterpartyId: e.target.value })}
                options={[{ value: '', label: 'Контрагент…' }, ...rows.map((r: any) => ({ value: r.counterpartyId ?? r.id, label: r.name }))]} />
              <Input placeholder="Номер договора" value={cform.number ?? ''} onChange={(e: any) => setCform({ ...cform, number: e.target.value })} />
              <Select value={cform.kind} onChange={(e: any) => setCform({ ...cform, kind: e.target.value })}
                options={[{ value: 'sale', label: 'Купли-продажи' }, { value: 'commission', label: 'Комиссии' }, { value: 'supply', label: 'Поставки' }]} />
              <Input type="date" value={cform.validUntil ?? ''} onChange={(e: any) => setCform({ ...cform, validUntil: e.target.value })} />
              <Btn onClick={async () => {
                setErr(''); setPmsg('');
                try { await api('/people/contracts', { method: 'POST', body: JSON.stringify(cform) });
                  setPmsg('Договор добавлен'); setCform({ kind: 'sale' });
                  setContracts(await api('/people/contracts')); }
                catch (e: any) { setErr(e.message); }
              }}>Добавить</Btn>
            </div>
            {pmsg && <p style={{ color: C.accentDark, fontSize: 13 }}>{pmsg}</p>}
            <DataTable storageKey="contragents-3" exportName="contragents-3" empty="Договоров пока нет" cols={[
              { h: 'Номер', k: 'number' },
              { h: 'Контрагент', k: 'counterpartyName' },
              { h: 'Тип', r: (r: any) => ({ sale: 'Купли-продажи', commission: 'Комиссии', supply: 'Поставки' } as any)[r.kind] },
              { h: 'Действует до', r: (r: any) => r.validUntil ?? '—' },
              { h: 'Статус', r: (r: any) => r.expired ? <Badge tone="bad">просрочен</Badge> : <Badge tone="ok">действует</Badge> },
            ]} rows={contracts} />
          </Card>
        )}

        {tab === 'merge' && (
          <Card title="Объединить дубли">
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              После импорта часто появляются повторы одного клиента. Выберите
              основного и отметьте дублей — все продажи, долги и договоры
              перенесутся на основного, дубли уйдут в архив.
              <b> Отменить нельзя.</b>
            </p>
            <Field label="Основной контрагент (в него объединяем)">
              <Select value={primary} onChange={(e: any) => setPrimary(e.target.value)}
                options={[{ value: '', label: 'Выберите…' }, ...rows.map((r: any) => ({ value: r.counterpartyId ?? r.id, label: r.name }))]} />
            </Field>
            <div style={{ margin: '10px 0', maxHeight: 220, overflowY: 'auto', border: `1px solid ${C.line}`, borderRadius: 8, padding: 8 }}>
              {rows.filter((r: any) => (r.counterpartyId ?? r.id) !== primary).map((r: any) => {
                const id = r.counterpartyId ?? r.id;
                return (
                  <label key={id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 14 }}>
                    <input type="checkbox" checked={mergeSel.includes(id)}
                      onChange={(e) => setMergeSel(e.target.checked ? [...mergeSel, id] : mergeSel.filter((x) => x !== id))} />
                    {r.name}{r.phone && <span style={{ color: C.dim }}> · {r.phone}</span>}
                  </label>
                );
              })}
            </div>
            <Btn disabled={!primary || mergeSel.length === 0} onClick={async () => {
              setErr(''); setPmsg('');
              try { const res = await api('/people/counterparties/merge', { method: 'POST', body: JSON.stringify({ primaryId: primary, dupeIds: mergeSel }) });
                setPmsg(`Объединено дублей: ${res.merged}`); setMergeSel([]); setPrimary(''); load(); }
              catch (e: any) { setErr(e.message); }
            }}>Объединить</Btn>
            {pmsg && <p style={{ color: C.accentDark, fontSize: 13, marginTop: 8 }}>{pmsg}</p>}
          </Card>
        )}


        {tab === 'check' && (
          <Card title="Проверка контрагента по БИН/ИИН">
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Проверка поставщика в базе КГД перед сделкой: плательщик ли НДС,
              налоговый режим, реестр неблагонадёжных, задолженность. Если
              поставщик не плательщик НДС — КГД не примет НДС к зачёту.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <Input placeholder="БИН или ИИН (12 цифр)" value={checkBin} onChange={(e: any) => setCheckBin(e.target.value)} style={{ maxWidth: 220 }} />
              <Btn onClick={async () => { setErr(''); setCheckRes(null);
                try { setCheckRes(await api('/verification/check', { method: 'POST', body: JSON.stringify({ binOrIin: checkBin, provider: 'mock' }) })); }
                catch (e: any) { setErr(e.message); } }}>Проверить</Btn>
            </div>
            {checkRes && (
              <div style={{ padding: 14, borderRadius: 10, border: `1px solid ${C.line}`,
                background: checkRes.risk === 'danger' ? '#fdecea' : checkRes.risk === 'warning' ? '#fff7ed' : '#eefaf4' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                  <Badge tone={checkRes.risk === 'danger' ? 'bad' : checkRes.risk === 'warning' ? 'warn' : 'ok'}>
                    {checkRes.risk === 'danger' ? 'ОПАСНО' : checkRes.risk === 'warning' ? 'ВНИМАНИЕ' : 'НАДЁЖНЫЙ'}
                  </Badge>
                  {checkRes.name && <b>{checkRes.name}</b>}
                </div>
                {checkRes.found ? (
                  <div style={{ fontSize: 14, color: C.text }}>
                    <div>НДС: {checkRes.vatPayer ? `плательщик${checkRes.vatSince ? ` с ${checkRes.vatSince}` : ''}` : 'не плательщик'}</div>
                    {checkRes.taxRegime && <div>Режим: {checkRes.taxRegime}</div>}
                    <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                      {checkRes.reasons.map((rr: string, i: number) => <li key={i}>{rr}</li>)}
                    </ul>
                  </div>
                ) : <div style={{ fontSize: 14 }}>Не найден в базе КГД — проверьте БИН/ИИН.</div>}
              </div>
            )}
          </Card>
        )}

      </div>
    </>
  );
}