'use client';
/**
 * Контрагенты и долговая книга. Долговая книга — сильная сторона Wipon:
 * магазин у дома живёт «в тетрадку», мы переносим тетрадку в кабинет.
 *
 * Просроченный долг — самое важное на экране: это ваши деньги в чужом
 * кармане, и чем дольше, тем меньше шансов их увидеть. Поэтому такие
 * строки идут первыми и красным.
 *
 * Проверка КГД — защита от доначислений НДС. Опасный уровень нельзя
 * показывать полутоном: если поставщик в реестре неблагонадёжных, вычет
 * по его счетам снимут, и платить будете вы.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Btn, Input, Select, Field,
  confirmDanger, money, dt, C, ErrLine, Badge } from '../../../lib/ui';

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

  // Просроченные — наверх: это и есть повод открыть раздел.
  const debtsSorted = [...debts].sort((a, b) => Number(b.daysOverdue ?? 0) - Number(a.daysOverdue ?? 0));
  const owed = debts.reduce((s: number, r: any) => s + Number(r.debt ?? r.amount ?? 0), 0);
  const late = debts.filter((r: any) => Number(r.daysOverdue) > 0);
  const lateSum = late.reduce((s: number, r: any) => s + Number(r.debt ?? r.amount ?? 0), 0);

  const fact = tab === 'debts'
    ? (debts.length
        ? `${debts.length} должников на ${money(owed)}${late.length ? ` · просрочено ${money(lateSum)} у ${late.length}` : ' · просрочки нет'}`
        : 'Долгов нет')
    : tab === 'contracts'
      ? `${contracts.length} договоров${contracts.filter((c: any) => c.expired).length ? ` · ${contracts.filter((c: any) => c.expired).length} просрочено` : ''}`
      : tab === 'check'
        ? 'Проверка поставщика перед сделкой'
        : tab === 'merge'
          ? `${rows.length} контрагентов в списке`
          : `${rows.length} контрагентов · покупателей ${rows.filter((r: any) => (r.roles ?? []).includes('customer')).length}`;

  return (
    <>
      <PageHeader title="Контрагенты" fact={fact} />
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab}
              tabs={[{ key: 'list', label: 'Все' }, { key: 'debts', label: 'Долговая книга' }, { key: 'contracts', label: 'Договоры' }, { key: 'merge', label: 'Объединить дубли' }, { key: 'check', label: 'Проверка КГД' }]} />

        {tab === 'list' && (
          <>
            <Card title="Добавить контрагента">
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Field label="Имя или название"><Input value={form.name ?? ''} onChange={(e: any) => setForm({ ...form, name: e.target.value })} w={240} /></Field>
                <Field label="Кто это">
                  <Select value={form.role} onChange={(e: any) => setForm({ ...form, role: e.target.value })}
                    options={[{ value: 'customer', label: 'Покупатель' }, { value: 'supplier', label: 'Поставщик' }]} />
                </Field>
                <Field label="Телефон"><Input value={form.phone ?? ''} placeholder="+7 701…" onChange={(e: any) => setForm({ ...form, phone: e.target.value })} w={168} /></Field>
                <Field label="ИИН/БИН"><Input value={form.iinBin ?? ''} onChange={(e: any) => setForm({ ...form, iinBin: e.target.value })} w={160} /></Field>
                {form.role === 'customer' && (
                  <Field label="Лимит долга, ₸"><Input type="number" placeholder="без лимита" value={form.debtLimit ?? ''} style={{ textAlign: 'right' }} onChange={(e: any) => setForm({ ...form, debtLimit: e.target.value })} w={140} /></Field>
                )}
                <Btn onClick={create} disabled={!form.name}>Добавить</Btn>
              </div>
              <p style={{ fontSize: 13, color: C.dim, margin: '14px 0 0', lineHeight: 1.6, maxWidth: '84ch' }}>
                Лимит долга проверяется прямо на кассе, даже без интернета: «Азамату
                больше 5 000 не давать» перестаёт быть устной договорённостью с кассиром.
              </p>
            </Card>
            <Card style={{ marginTop: 14 }} title="Список"
              right={<div style={{ display: 'flex', gap: 8 }}>
                <Input placeholder="Поиск" value={q} onChange={(e: any) => setQ(e.target.value)} onKeyDown={(e: any) => e.key === 'Enter' && load()} />
                <Btn kind="ghost" onClick={load}>Найти</Btn>
              </div>}>
              <DataTable storageKey="contragents" exportName="contragents"
                hint="«Долг нам» — деньги покупателей, которых у вас пока нет. «Мы должны» — неоплаченные поставки: их лучше видеть до того, как поставщик позвонит сам."
                empty="Контрагентов пока нет — добавьте первого покупателя или поставщика"
                cols={[
                  { h: 'Имя', k: 'name' },
                  { h: 'Роли', r: (r) => (r.roles ?? []).map((x: string) => x === 'customer' ? 'покупатель' : 'поставщик').join(', ') },
                  { h: 'Телефон', k: 'phone' },
                  { h: 'Долг нам', right: true, r: (r) => Number(r.debt ?? 0) > 0
                      ? <span style={{ color: C.red, fontWeight: 600, whiteSpace: 'nowrap' }}>{money(r.debt)}</span>
                      : <span style={{ color: C.faint }}>—</span> },
                  { h: 'Мы должны', right: true, r: (r) => Number(r.supplier_debt ?? 0) > 0
                      ? <span style={{ whiteSpace: 'nowrap' }}>{money(r.supplier_debt)}</span>
                      : <span style={{ color: C.faint }}>—</span> },
                ]}
                rows={rows} />
            </Card>
          </>
        )}

        {tab === 'debts' && (
          <Card title="Кто и сколько должен">
            {pay && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap',
                padding: '14px 16px', background: '#F4F9F6', border: `1.5px solid ${C.accent}`, borderRadius: 10 }}>
                <div style={{ fontSize: 14.5 }}>Оплата долга: <b>{pay.name}</b>
                  <div style={{ fontSize: 13, color: C.dim, marginTop: 3 }}>всего числится {money(pay.debt ?? pay.amount)}</div>
                </div>
                <Field label="Сумма, ₸"><Input type="number" value={pay.amount ?? ''} w={140} style={{ textAlign: 'right' }} onChange={(e: any) => setPay({ ...pay, amount: e.target.value })} /></Field>
                <Btn onClick={doPay} disabled={!pay.amount}>Принять оплату</Btn>
                <Btn kind="ghost" onClick={() => setPay(null)}>Отмена</Btn>
              </div>
            )}
            <DataTable storageKey="contragents-2" exportName="contragents-2"
              hint={late.length
                ? `${late.length} должников просрочили — они подняты наверх. Долг старше месяца возвращается заметно хуже, чем свежий.`
                : 'Просроченных нет. Долг покупателя — ваши деньги в чужом кармане, поэтому список стоит открывать раз в неделю.'}
              empty="Долгов нет — отличная новость"
              cols={[
                { h: 'Покупатель', k: 'name' },
                { h: 'Телефон', k: 'phone' },
                { h: 'Долг', right: true, r: (r) => (
                    <span style={{ color: C.red, fontWeight: 600, whiteSpace: 'nowrap',
                      fontSize: Number(r.daysOverdue) > 0 ? 15 : 14 }}>
                      {money(r.debt ?? r.amount)}
                    </span>
                  ) },
                { h: 'Просрочен', r: (r) => (r.daysOverdue > 0)
                    ? <Badge tone="bad">{r.daysOverdue} дн.</Badge>
                    : <span style={{ color: C.faint }}>нет</span> },
                { h: 'Последняя оплата', r: (r) => r.lastPaymentAt
                    ? dt(r.lastPaymentAt)
                    : <span style={{ color: C.faint }}>не платил ни разу</span> },
                { h: '', r: (r) => <Btn onClick={() => setPay(r)}>Оплатить</Btn> },
              ]}
              rows={debtsSorted} />
          </Card>
        )}

        {tab === 'contracts' && (
          <Card title="Договоры">
            <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55, maxWidth: '82ch' }}>
              Номер, тип и сроки договора — для ЭСФ/АВР и контроля сроков.
              Просроченный договор не даёт выписать счёт-фактуру, а узнаётся это
              обычно в тот момент, когда клиент её просит.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginBottom: 12 }}>
              <Select value={cform.counterpartyId ?? ''} onChange={(e: any) => setCform({ ...cform, counterpartyId: e.target.value })}
                options={[{ value: '', label: 'Контрагент…' }, ...rows.map((r: any) => ({ value: r.counterpartyId ?? r.id, label: r.name }))]} />
              <Input placeholder="Номер договора" value={cform.number ?? ''} onChange={(e: any) => setCform({ ...cform, number: e.target.value })} w="100%" />
              <Select value={cform.kind} onChange={(e: any) => setCform({ ...cform, kind: e.target.value })}
                options={[{ value: 'sale', label: 'Купли-продажи' }, { value: 'commission', label: 'Комиссии' }, { value: 'supply', label: 'Поставки' }]} />
              <Input type="date" value={cform.validUntil ?? ''} onChange={(e: any) => setCform({ ...cform, validUntil: e.target.value })} w="100%" />
              <Btn onClick={async () => {
                setErr(''); setPmsg('');
                try { await api('/people/contracts', { method: 'POST', body: JSON.stringify(cform) });
                  setPmsg('Договор добавлен'); setCform({ kind: 'sale' });
                  setContracts(await api('/people/contracts')); }
                catch (e: any) { setErr(e.message); }
              }}>Добавить</Btn>
            </div>
            {pmsg && <p style={{ color: C.accentDark, fontSize: 13 }}>{pmsg}</p>}
            <DataTable storageKey="contragents-3" exportName="contragents-3"
              hint="Проверяйте столбец «Действует до» перед выпиской ЭСФ: продлевают договор обычно задним числом и в спешке."
              empty="Договоров пока нет. Они нужны для ЭСФ и АВР — розничной торговле обычно не требуются" cols={[
              { h: 'Номер', k: 'number' },
              { h: 'Контрагент', k: 'counterpartyName' },
              { h: 'Тип', r: (r: any) => ({ sale: 'Купли-продажи', commission: 'Комиссии', supply: 'Поставки' } as any)[r.kind] },
              { h: 'Действует до', r: (r: any) => r.validUntil ?? <span style={{ color: C.faint }}>—</span> },
              { h: 'Статус', r: (r: any) => r.expired ? <Badge tone="bad">просрочен</Badge> : <Badge tone="ok">действует</Badge> },
            ]} rows={contracts} />
          </Card>
        )}

        {tab === 'merge' && (
          <Card title="Объединить дубли">
            <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', marginBottom: 18,
              background: '#FFFBFA', border: `1px solid #E6C7C0`, borderRadius: 10, padding: '13px 15px' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.red, flex: '0 0 7px', marginTop: 7 }} />
              <div style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.6, maxWidth: '80ch' }}>
                После импорта часто появляются повторы одного клиента. Все продажи, долги
                и договоры перенесутся на основного, дубли уйдут в архив.
                <b> Отменить объединение нельзя</b> — разделить слитые долги обратно уже
                не получится.
              </div>
            </div>
            <Field label="Основной контрагент (в него объединяем)">
              <Select value={primary} onChange={(e: any) => setPrimary(e.target.value)}
                options={[{ value: '', label: 'Выберите…' }, ...rows.map((r: any) => ({ value: r.counterpartyId ?? r.id, label: r.name }))]} />
            </Field>
            <div style={{ margin: '12px 0', maxHeight: 240, overflowY: 'auto', border: `1px solid ${C.line}`, borderRadius: 10, padding: 10 }}>
              {rows.filter((r: any) => (r.counterpartyId ?? r.id) !== primary).map((r: any) => {
                const id = r.counterpartyId ?? r.id;
                return (
                  <label key={id} style={{ display: 'flex', gap: 9, alignItems: 'center', minHeight: 32, fontSize: 14, cursor: 'pointer' }}>
                    <input type="checkbox" checked={mergeSel.includes(id)}
                      style={{ width: 16, height: 16, accentColor: C.accent }}
                      onChange={(e) => setMergeSel(e.target.checked ? [...mergeSel, id] : mergeSel.filter((x) => x !== id))} />
                    {r.name}{r.phone && <span style={{ color: C.dim }}> · {r.phone}</span>}
                  </label>
                );
              })}
            </div>
            <Btn kind="danger" disabled={!primary || mergeSel.length === 0} onClick={async () => {
              setErr(''); setPmsg('');
              const main = rows.find((r: any) => (r.counterpartyId ?? r.id) === primary);
              if (!confirmDanger(
                `Объединить ${mergeSel.length} дублей в «${main?.name ?? 'основного'}»?`,
                'Продажи, долги и договоры дублей перенесутся на основного, сами дубли уйдут в архив. Разделить их обратно будет нельзя.',
              )) return;
              try { const res = await api('/people/counterparties/merge', { method: 'POST', body: JSON.stringify({ primaryId: primary, dupeIds: mergeSel }) });
                setPmsg(`Объединено дублей: ${res.merged}`); setMergeSel([]); setPrimary(''); load(); }
              catch (e: any) { setErr(e.message); }
            }}>Объединить</Btn>
            {pmsg && <p style={{ color: C.accentDark, fontSize: 13, marginTop: 10 }}>{pmsg}</p>}
          </Card>
        )}

        {tab === 'check' && (
          <Card title="Проверка контрагента по БИН/ИИН">
            <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55, maxWidth: '82ch' }}>
              Проверка поставщика в базе КГД перед сделкой: плательщик ли НДС, налоговый
              режим, реестр неблагонадёжных, задолженность. Если поставщик не плательщик
              НДС, вычет по его счетам не примут — и доплачивать будете вы.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, alignItems: 'flex-end' }}>
              <Field label="БИН или ИИН (12 цифр)">
                <Input placeholder="123456789012" value={checkBin} onChange={(e: any) => setCheckBin(e.target.value)}
                  onKeyDown={(e: any) => e.key === 'Enter' && (async () => {
                    setErr(''); setCheckRes(null);
                    try { setCheckRes(await api('/verification/check', { method: 'POST', body: JSON.stringify({ binOrIin: checkBin, provider: 'mock' }) })); }
                    catch (er: any) { setErr(er.message); }
                  })()} w={240} />
              </Field>
              <Btn onClick={async () => { setErr(''); setCheckRes(null);
                try { setCheckRes(await api('/verification/check', { method: 'POST', body: JSON.stringify({ binOrIin: checkBin, provider: 'mock' }) })); }
                catch (e: any) { setErr(e.message); } }}>Проверить</Btn>
            </div>
            {checkRes && (
              // Три уровня риска: опасный не полутоном, а красной рамкой и
              // крупным словом. Это защита от доначислений, а не справка.
              <div style={{ padding: '20px 22px', borderRadius: 12,
                border: `1.5px solid ${checkRes.risk === 'danger' ? '#E6C7C0' : checkRes.risk === 'warning' ? '#E8DCC3' : C.accent}`,
                background: checkRes.risk === 'danger' ? '#FFFBFA' : checkRes.risk === 'warning' ? '#FFFCF6' : '#F4F9F6' }}>
                <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.015em',
                  color: checkRes.risk === 'danger' ? C.red : checkRes.risk === 'warning' ? C.amber : C.accentDark }}>
                  {checkRes.risk === 'danger' ? 'Опасный' : checkRes.risk === 'warning' ? 'Есть вопросы' : 'Надёжный'}
                </div>
                {checkRes.name && <div style={{ fontSize: 15, fontWeight: 600, marginTop: 8 }}>{checkRes.name}</div>}
                {checkRes.found ? (
                  <div style={{ fontSize: 14, color: C.prose, marginTop: 12, lineHeight: 1.6 }}>
                    <div>НДС: {checkRes.vatPayer ? `плательщик${checkRes.vatSince ? ` с ${checkRes.vatSince}` : ''}` : 'не плательщик — вычет по его счетам не примут'}</div>
                    {checkRes.taxRegime && <div>Режим: {checkRes.taxRegime}</div>}
                    <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
                      {checkRes.reasons.map((rr: string, i: number) => <li key={i} style={{ marginTop: i ? 4 : 0 }}>{rr}</li>)}
                    </ul>
                  </div>
                ) : <div style={{ fontSize: 14, color: C.prose, marginTop: 12, lineHeight: 1.6 }}>
                      Не найден в базе КГД — проверьте БИН или ИИН ещё раз. Если номер верен,
                      работать с таким поставщиком рискованно.
                    </div>}
              </div>
            )}
          </Card>
        )}

      </div>
    </>
  );
}
