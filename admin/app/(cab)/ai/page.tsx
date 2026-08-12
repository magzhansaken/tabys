'use client';
/**
 * AI-помощник (часть 33) — приёмка на максимум. Распознавание накладной из
 * фото, сверка с заказом и ценами, голосовая инвентаризация. Наше УТП:
 * ни у Wipon, ни у UMAG, ни у МоегоСклада этого нет.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, Input, Field, Badge, money, num, dt, C, ErrLine , Status} from '../../../lib/ui';

const CHECK_TONE: Record<string, any> = {
  shortfall: 'bad', surplus: 'warn', price_up: 'warn', price_down: 'ok', new_product: 'dim',
};
const CHECK_LABEL: Record<string, string> = {
  shortfall: 'Недовоз', surplus: 'Перевоз', price_up: 'Подорожание',
  price_down: 'Подешевело', new_product: 'Новый товар',
};

export default function AiPage() {
  const [tab, setTab] = useState('invoice');
  const [tasks, setTasks] = useState<any[]>([]);
  const [checks, setChecks] = useState<any>(null);
  const [voiceText, setVoiceText] = useState('');
  const [voiceResult, setVoiceResult] = useState<any>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setErr('');
    try { if (tab === 'invoice') setTasks(await api('/ai/tasks?kind=invoice_photo')); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [tab]);

  const recognizeDemo = async () => {
    setErr(''); setMsg('');
    try {
      await api('/ai/invoice-from-photo', { method: 'POST', body: JSON.stringify({ imageRef: 'demo-nakladnaya.jpg' }) });
      await api('/ai/process-queue', { method: 'POST', body: '{}' });
      setMsg('Накладная распознана (демо)'); load();
    } catch (e: any) { setErr(e.message); }
  };

  const checkInvoice = async (taskId: string) => {
    setErr(''); setChecks(null);
    try { setChecks(await api('/ai/check-invoice', { method: 'POST', body: JSON.stringify({ taskId }) })); }
    catch (e: any) { setErr(e.message); }
  };

  const parseVoice = async () => {
    setErr(''); setVoiceResult(null);
    try { setVoiceResult(await api('/ai/voice-inventory', { method: 'POST', body: JSON.stringify({ text: voiceText }) })); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>AI-помощник</h1>
      <p style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>
        Сфотографируйте накладную — система распознает позиции, сверит с заказом
        и ценами. Голосом наговорите остатки при инвентаризации.
      </p>
      <ErrLine err={err} />
      {msg && <p style={{ color: C.accentDark, fontSize: 13 }}>{msg}</p>}

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'invoice', label: 'Накладная из фото' },
          { key: 'voice', label: 'Голосовая инвентаризация' },
        ]} />

        {tab === 'invoice' && (
          <>
            <Card title="Распознавание накладной">
              <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
                Загрузите фото накладной от поставщика — распознаем поставщика,
                товары, количества и цены. Всегда проверяйте перед проведением.
              </p>
              <Btn onClick={recognizeDemo}>Распознать (демо)</Btn>
            </Card>

            <Card title="Распознанные накладные" style={{ marginTop: 14 }}>
              <DataTable hint="Сфотографируйте накладную — она станет приёмкой. Голосом наговорите остатки при инвентаризации." storageKey="ai" exportName="ai" empty="Пока нет распознанных накладных" cols={[
                { h: 'Статус', r: (r: any) => <Status value={r.status} /> },
                { h: 'Уверенность', r: (r: any) => r.confidence != null ? `${Math.round(r.confidence * 100)}%` : '—' },
                { h: 'Когда', r: (r: any) => dt(r.created_at) },
                { h: 'Действие', r: (r: any) => r.status === 'done'
                    ? <Btn kind="ghost" onClick={() => checkInvoice(r.id)}>Сверить</Btn> : null },
              ]} rows={tasks} />
            </Card>

            {checks && (
              <Card title="Расхождения (сверка с заказом и ценами)" style={{ marginTop: 14 }}>
                {checks.clean ? (
                  <p style={{ color: C.accentDark }}>Расхождений нет — накладная совпадает с заказом и ценами.</p>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                      {checks.summary.shortfall > 0 && <Badge tone="bad">Недовоз: {checks.summary.shortfall}</Badge>}
                      {checks.summary.priceUp > 0 && <Badge tone="warn">Подорожание: {checks.summary.priceUp}</Badge>}
                      {checks.summary.newProducts > 0 && <Badge tone="dim">Новых: {checks.summary.newProducts}</Badge>}
                    </div>
                    <DataTable storageKey="ai-2" exportName="ai-2" cols={[
                      { h: 'Товар', k: 'product_name' },
                      { h: 'Тип', r: (r: any) => <Badge tone={CHECK_TONE[r.kind]}>{CHECK_LABEL[r.kind] ?? r.kind}</Badge> },
                      { h: 'Детали', k: 'note' },
                    ]} rows={checks.checks} />
                  </>
                )}
              </Card>
            )}
          </>
        )}

        {tab === 'voice' && (
          <Card title="Голосовая инвентаризация">
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Наговорите остатки — «молоко двадцать, хлеб пятнадцать». Руки заняты
              товаром, считать удобнее голосом. Распознанное проверьте и создайте
              инвентаризацию.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input value={voiceText} onChange={(e: any) => setVoiceText(e.target.value)}
                placeholder="молоко двадцать, хлеб пятнадцать" style={{ flex: 1 }} />
              <Btn onClick={parseVoice}>Распознать</Btn>
            </div>
            {voiceResult && (
              <div style={{ marginTop: 14 }}>
                {voiceResult.recognized.length > 0 && (
                  <DataTable storageKey="ai-3" exportName="ai-3" cols={[
                    { h: 'Товар', k: 'product' },
                    { h: 'Количество', right: true, r: (r: any) => num(r.qty) },
                    { h: 'Сказано', r: (r: any) => <span style={{ color: C.dim, fontSize: 13 }}>«{r.said}»</span> },
                  ]} rows={voiceResult.recognized} />
                )}
                {voiceResult.notFound.length > 0 && (
                  <p style={{ color: C.amber ?? '#a86500', fontSize: 13, marginTop: 10 }}>
                    Не нашли в каталоге: {voiceResult.notFound.map((x: any) => x.name).join(', ')}
                  </p>
                )}
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
