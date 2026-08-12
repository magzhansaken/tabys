'use client';
/**
 * Маркировка (часть 30) — ИС МПТ Казахстан. Приёмка со сверкой, проверка
 * кода, журнал вывода из оборота, реестр остатков. Для табака, обуви,
 * лекарств, алкоголя и других подлежащих маркировке товаров.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, Field, Input, dt, C, ErrLine, Badge } from '../../../lib/ui';

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

  const load = async () => {
    setErr('');
    try {
      if (tab === 'reports') { setReports(await api('/marking/reports')); setQueue(await api('/marking/process-queue', { method: 'POST', body: '{}' })); }
      if (tab === 'stock') setStock(await api('/marking/stock'));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [tab]);

  const check = async () => {
    setErr(''); setChecked(null);
    try { setChecked(await api(`/marking/check?code=${encodeURIComponent(code.trim())}`)); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>Маркировка</h1>
      <p style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>
        Учёт маркированных товаров (ИС МПТ): табак, обувь, лекарства, алкоголь,
        пиво. Приёмка через скан кода, вывод из оборота при продаже.
      </p>
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
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Отсканируйте или введите код DataMatrix — увидите, на складе ли он
              и можно ли продать.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input value={code} onChange={(e: any) => setCode(e.target.value)} placeholder="01…21…" style={{ flex: 1 }} />
              <Btn onClick={check}>Проверить</Btn>
            </div>
            {checked && (
              <div style={{ marginTop: 14, fontSize: 14 }}>
                {checked.found ? (
                  <>
                    <div>Товар: <b>{checked.product}</b></div>
                    <div style={{ color: C.dim, marginTop: 2 }}>GTIN {checked.gtin} · серийный {checked.serial}</div>
                    <div style={{ marginTop: 6 }}>
                      {checked.sellable
                        ? <Badge tone="ok">на складе — можно продать</Badge>
                        : <Badge tone="bad">{checked.reason}</Badge>}
                    </div>
                  </>
                ) : <Badge tone="bad">{checked.reason}</Badge>}
              </div>
            )}
          </Card>
        )}

        {tab === 'stock' && (
          <Card title="Реестр остатков по кодам">
            <DataTable hint="Обязательная маркировка: приёмка кодов, вывод из оборота при продаже. Начните с проверки кода со сканера." storageKey="marking" exportName="marking" empty="Маркированных товаров пока нет" cols={[
              { h: 'Товар', k: 'product' },
              { h: 'Тип', r: (r: any) => MARK_LABEL[r.marking] ?? r.marking },
              { h: 'На складе', right: true, k: 'inStock' },
              { h: 'Продано', right: true, k: 'sold' },
              { h: 'Возвращено', right: true, k: 'returned' },
            ]} rows={stock} />
          </Card>
        )}

        {tab === 'reports' && (
          <Card title="Журнал обмена с ИС МПТ">
            {queue && queue.pending > 0 && (
              <div style={{ padding: 10, background: '#fff7ed', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
                {queue.note}
              </div>
            )}
            <DataTable storageKey="marking-2" exportName="marking-2" empty="Операций с маркировкой пока не было" cols={[
              { h: 'Операция', r: (r: any) => r.kind === 'withdrawal' ? 'Вывод из оборота' : 'Возврат в оборот' },
              { h: 'Код', r: (r: any) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.code.slice(0, 18)}…</span> },
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
