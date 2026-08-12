'use client';
/**
 * Маркировка (часть 30) — ИС МПТ Казахстан. Приёмка со сверкой, проверка
 * кода, журнал вывода из оборота, реестр остатков. Для табака, обуви,
 * лекарств, алкоголя и других подлежащих маркировке товаров.
 *
 * Поле кода — главное на экране и держит фокус: сканер вводит 25 знаков и
 * жмёт Enter, руками DataMatrix никто не набирает. Курсор возвращается в
 * поле после каждой проверки, чтобы следующая пачка сканировалась сразу.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Btn, Field, Input,
  MONO, dt, C, ErrLine, Badge } from '../../../lib/ui';

const MARK_LABEL: Record<string, string> = {
  none: 'нет', tobacco: 'табак', shoes: 'обувь', pharma: 'лекарства',
  alcohol: 'алкоголь', beer: 'пиво', other: 'другое',
};

export default function MarkingPage() {
  const [tab, setTab] = useState('check');
  const [code, setCode] = useState('');
  const [checked, setChecked] = useState<any>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [stock, setStock] = useState<any[]>([]);
  const [queue, setQueue] = useState<any>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const scan = useRef<any>(null);

  const load = async () => {
    setErr('');
    try {
      if (tab === 'reports') { setReports(await api('/marking/reports')); setQueue(await api('/marking/process-queue', { method: 'POST', body: '{}' })); }
      if (tab === 'stock') setStock(await api('/marking/stock'));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [tab]);

  useEffect(() => { if (tab === 'check') scan.current?.focus(); }, [tab, checked]);

  const check = async () => {
    setErr(''); setChecked(null);
    try { setChecked(await api(`/marking/check?code=${encodeURIComponent(code.trim())}`)); setCode(''); }
    catch (e: any) { setErr(e.message); }
  };

  const inStock = stock.reduce((s: number, r: any) => s + Number(r.inStock ?? 0), 0);
  const pending = reports.filter((r: any) => r.status !== 'ok' && r.status !== 'failed').length;
  const fact = tab === 'stock'
    ? `${inStock} кодов на складе · ${stock.length} товаров с маркировкой`
    : tab === 'reports'
      ? `${reports.length} операций${pending ? ` · ${pending} в очереди в ИС МПТ` : ' · очередь пуста'}`
      : 'Сканируйте код — ответ появится сразу';

  return (
    <>
      <PageHeader
        title="Маркировка"
        fact={fact}
        note="Учёт маркированных товаров (ИС МПТ): табак, обувь, лекарства, алкоголь, пиво. Приёмка через скан кода, вывод из оборота при продаже — без этого товар продавать нельзя."
      />
      <ErrLine err={err} />
      {msg && <p style={{ color: C.accentDark, fontSize: 13 }}>{msg}</p>}

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'check', label: 'Проверить код' },
          { key: 'stock', label: 'Реестр остатков' },
          { key: 'reports', label: 'Журнал ИС МПТ' },
        ]} />

        {tab === 'check' && (
          <Card title="Проверить код маркировки">
            <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55 }}>
              Отсканируйте DataMatrix — курсор уже стоит в поле, сканер сам нажмёт Enter.
              Увидите, на складе ли код и можно ли продать.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Код DataMatrix">
                <Input ref={scan} autoFocus value={code} w={420}
                  onChange={(e: any) => setCode(e.target.value)}
                  onKeyDown={(e: any) => e.key === 'Enter' && check()}
                  placeholder="01…21…"
                  style={{ height: 48, fontSize: 17, fontFamily: MONO, letterSpacing: '.02em' }} />
              </Field>
              <Btn onClick={check} style={{ height: 48, minHeight: 48 }}>Проверить</Btn>
            </div>
            {checked && (
              <div style={{ marginTop: 20, padding: '20px 22px', borderRadius: 12,
                border: `1.5px solid ${checked.sellable ? C.accent : '#E6C7C0'}`,
                background: checked.sellable ? '#F4F9F6' : '#FFFBFA' }}>
                <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.015em',
                  color: checked.sellable ? C.accentDark : C.red }}>
                  {checked.sellable ? 'Можно продать' : (checked.found ? 'Продавать нельзя' : 'Код неизвестен')}
                </div>
                <div style={{ fontSize: 14.5, color: C.prose, marginTop: 8, lineHeight: 1.55, maxWidth: '70ch' }}>
                  {checked.sellable ? 'Код на складе и в обороте — товар пробивается на кассе как обычно.' : checked.reason}
                </div>
                {checked.found && (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.lineIn}` }}>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{checked.product}</div>
                    <div style={{ color: C.dim, marginTop: 3, fontSize: 13, fontFamily: MONO }}>
                      GTIN {checked.gtin} · серийный {checked.serial}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        )}

        {tab === 'stock' && (
          <Card title="Реестр остатков по кодам">
            <DataTable storageKey="marking" exportName="marking"
              hint="Каждая пачка учитывается отдельным кодом: «10 пачек» здесь — это десять разных кодов, а не число в остатке."
              empty="Маркированных товаров пока нет — коды появятся после первой приёмки со сканированием" cols={[
              { h: 'Товар', k: 'product' },
              { h: 'Тип', r: (r: any) => MARK_LABEL[r.marking] ?? r.marking },
              { h: 'На складе', right: true, k: 'inStock' },
              { h: 'Продано', right: true, k: 'sold' },
              { h: 'Возвращено', right: true, r: (r: any) => Number(r.returned) > 0
                  ? r.returned : <span style={{ color: C.faint }}>—</span> },
            ]} rows={stock} />
          </Card>
        )}

        {tab === 'reports' && (
          <Card title="Журнал обмена с ИС МПТ">
            {queue && queue.pending > 0 && (
              // Очередь — не ошибка: продажи прошли, коды не потеряны, делать
              // ничего не нужно. Поэтому золотом, а не красным.
              <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', marginBottom: 16,
                background: '#FFFCF6', border: `1px solid #E8DCC3`, borderRadius: 10, padding: '13px 15px' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.gold, flex: '0 0 7px', marginTop: 7 }} />
                <div style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.55, maxWidth: '76ch' }}>
                  {queue.note} Продажи при этом прошли, коды не потеряны — система дошлёт их сама, когда ИС МПТ ответит.
                </div>
              </div>
            )}
            <DataTable storageKey="marking-2" exportName="marking-2"
              hint="Сюда смотрят, если ИС МПТ говорит, что кода нет в обороте: видно, когда именно уходило сообщение и чем закончилось."
              empty="Операций с маркировкой пока не было" cols={[
              { h: 'Операция', r: (r: any) => r.kind === 'withdrawal' ? 'Вывод из оборота' : 'Возврат в оборот' },
              { h: 'Код', r: (r: any) => <span style={{ fontFamily: MONO, fontSize: 12.5, whiteSpace: 'nowrap' }}>{r.code.slice(0, 18)}…</span> },
              { h: 'Статус', r: (r: any) => r.status === 'ok' ? <Badge tone="ok">отправлено</Badge>
                  : r.status === 'failed' ? <Badge tone="bad">ошибка</Badge> : <Badge tone="warn">в очереди</Badge> },
              { h: 'Когда', r: (r: any) => dt(r.created_at) },
            ]} rows={reports} />
          </Card>
        )}
      </div>
    </>
  );
}
