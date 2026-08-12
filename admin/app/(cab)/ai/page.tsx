'use client';
/**
 * AI-помощник (часть 33) — приёмка на максимум. Распознавание накладной из
 * фото, сверка с заказом и ценами, голосовая инвентаризация. Наше УТП:
 * ни у Wipon, ни у UMAG, ни у МоегоСклада этого нет.
 *
 * Единственный раздел с золотым акцентом. В меню он уже помечен золотом —
 * здесь обещание должно подтвердиться, поэтому путь показан слева направо:
 * фото → что распознали → что не сошлось с заказом.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Btn, Input, Field, Badge,
  money, num, dt, C, ErrLine, Status } from '../../../lib/ui';

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

  // Средняя уверенность — из уже полученного списка задач.
  const withConf = tasks.filter((t: any) => t.confidence != null);
  const avg = withConf.length
    ? Math.round(withConf.reduce((s: number, t: any) => s + Number(t.confidence), 0) / withConf.length * 100)
    : null;
  const fact = tab === 'invoice'
    ? (tasks.length
        ? `${tasks.length} накладных распознано${avg != null ? ` · точность ${avg}%` : ''}`
        : 'Накладных пока не распознавали')
    : 'Наговорите остатки — руки заняты товаром';

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
        <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-.015em', margin: 0 }}>AI-помощник</h1>
        {/* Единственная золотая метка в кабинете: это то, чего нет ни у
            UMAG, ни у Wipon, ни у МоегоСклада. */}
        <Badge tone="warn">только у Табыс</Badge>
      </div>
      <div style={{ fontSize: 13.5, color: C.dim, marginTop: 5, lineHeight: 1.5 }}>{fact}</div>
      <p style={{ fontSize: 14.5, color: C.prose, lineHeight: 1.55, margin: '12px 0 22px', maxWidth: '82ch' }}>
        Сфотографируйте накладную — система распознает поставщика, позиции,
        количества и цены, сверит с заказом и вашими закупочными ценами.
        Остатки при инвентаризации можно наговорить голосом.
      </p>
      <ErrLine err={err} />
      {msg && <p style={{ color: C.accentDark, fontSize: 13 }}>{msg}</p>}

      <div style={{ marginTop: 4 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'invoice', label: 'Накладная из фото' },
          { key: 'voice', label: 'Голосовая инвентаризация' },
        ]} />

        {tab === 'invoice' && (
          <>
            <Card title="Распознавание накладной"
              style={{ background: '#FFFCF6', borderColor: '#E8DCC3' }}>
              <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55, maxWidth: '78ch' }}>
                Фото с телефона или скан. Распознаются поставщик, товары, количества
                и цены. Всегда проверяйте перед проведением: приёмка меняет остатки
                и себестоимость.
              </p>
              <Btn kind="gold" onClick={recognizeDemo}>Распознать накладную (демо)</Btn>
            </Card>

            <Card title="Распознанные накладные" style={{ marginTop: 14 }}>
              <DataTable storageKey="ai" exportName="ai" search={false}
                hint="Распознанная накладная ещё не приёмка: нажмите «Сверить», посмотрите расхождения и только потом проводите."
                empty="Пока нет распознанных накладных — сфотографируйте первую" cols={[
                { h: 'Статус', r: (r: any) => <Status value={r.status} /> },
                { h: 'Уверенность', right: true, r: (r: any) => {
                    if (r.confidence == null) return <span style={{ color: C.faint }}>—</span>;
                    const p = Math.round(r.confidence * 100);
                    // Ниже 90% — читать глазами построчно, а не доверять.
                    return <span style={{ color: p < 90 ? C.amber : C.text, fontWeight: p < 90 ? 600 : 400 }}>{p}%</span>;
                  } },
                { h: 'Когда', r: (r: any) => dt(r.created_at) },
                { h: 'Действие', r: (r: any) => r.status === 'done'
                    ? <Btn kind="ghost" onClick={() => checkInvoice(r.id)}>Сверить</Btn> : null },
              ]} rows={tasks} />
            </Card>

            {checks && (
              <Card title="Расхождения с заказом и ценами" style={{ marginTop: 14 }}>
                {checks.clean ? (
                  <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start',
                    background: '#F4F9F6', border: `1px solid ${C.accent}`, borderRadius: 10, padding: '14px 16px' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.accent, flex: '0 0 7px', marginTop: 7 }} />
                    <div style={{ fontSize: 14, color: C.prose, lineHeight: 1.55 }}>
                      Расхождений нет: накладная совпадает с заказом и вашими закупочными ценами. Можно проводить.
                    </div>
                  </div>
                ) : (
                  <>
                    <p style={{ fontSize: 13.5, color: C.dim, margin: '0 0 14px', lineHeight: 1.55, maxWidth: '78ch' }}>
                      Каждое расхождение — это либо недоданный товар, либо цена, по которой
                      вы завтра будете продавать. Решите по каждому, потом проводите.
                    </p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                      {checks.summary.shortfall > 0 && <Badge tone="bad">Недовоз: {checks.summary.shortfall}</Badge>}
                      {checks.summary.priceUp > 0 && <Badge tone="warn">Подорожание: {checks.summary.priceUp}</Badge>}
                      {checks.summary.newProducts > 0 && <Badge tone="dim">Новый товар: {checks.summary.newProducts}</Badge>}
                    </div>
                    <DataTable storageKey="ai-2" exportName="ai-2" search={false}
                      empty="Расхождений по этой накладной нет" cols={[
                      { h: 'Товар', k: 'product_name' },
                      { h: 'Тип', r: (r: any) => <Badge tone={CHECK_TONE[r.kind]}>{CHECK_LABEL[r.kind] ?? r.kind}</Badge> },
                      { h: 'Что делать', k: 'note' },
                    ]} rows={checks.checks} />
                  </>
                )}
              </Card>
            )}
          </>
        )}

        {tab === 'voice' && (
          <Card title="Голосовая инвентаризация">
            <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55, maxWidth: '78ch' }}>
              Наговорите остатки — «молоко двадцать, хлеб пятнадцать». Руки заняты
              товаром, считать удобнее голосом. Распознанное проверьте и создайте
              инвентаризацию.
            </p>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="Что услышали">
                <Input value={voiceText} onChange={(e: any) => setVoiceText(e.target.value)}
                  onKeyDown={(e: any) => e.key === 'Enter' && parseVoice()}
                  placeholder="молоко двадцать, хлеб пятнадцать" w={420} style={{ height: 46, fontSize: 17 }} />
              </Field>
              <Btn kind="gold" onClick={parseVoice} style={{ height: 46, minHeight: 46 }}>Распознать</Btn>
            </div>
            {voiceResult && (
              <div style={{ marginTop: 18 }}>
                {voiceResult.recognized.length > 0 && (
                  <DataTable storageKey="ai-3" exportName="ai-3" search={false}
                    hint="Проверьте количества глазами: «пятнадцать» и «пятьдесят» на слух похожи, а разница в остатке — тридцать пять единиц."
                    empty="Ни одного товара не распознали. Называйте так, как товар записан в каталоге: «молоко», а не «молочко»."
                    cols={[
                      { h: 'Товар', k: 'product' },
                      { h: 'Количество', right: true, r: (r: any) => num(r.qty) },
                      { h: 'Сказано', r: (r: any) => <span style={{ color: C.dim, fontSize: 13 }}>«{r.said}»</span> },
                    ]} rows={voiceResult.recognized} />
                )}
                {voiceResult.notFound.length > 0 && (
                  <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', marginTop: 14,
                    background: '#FFFCF6', border: `1px solid #E8DCC3`, borderRadius: 10, padding: '13px 15px' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.gold, flex: '0 0 7px', marginTop: 7 }} />
                    <div style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.55 }}>
                      Не нашли в каталоге: {voiceResult.notFound.map((x: any) => x.name).join(', ')}.
                      Проверьте, как товар называется в карточке — искать система будет по этому названию.
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
