'use client';
/**
 * Автоматизация и связь (часть 27). Автоотчёты, сценарии, вебхуки, чат
 * поддержки. Готовая польза одной галочкой, а не конструктор.
 *
 * Включённое и выключенное правило раньше различались только галочкой —
 * на бегу это не читается. Теперь Toggle: цвет, положение и подпись разом,
 * а выключенная строка гаснет целиком.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Tabs, Toggle, Btn, Input, Select, Field,
  confirmDanger, money, dt, C, ErrLine, Badge } from '../../../lib/ui';

const TRIGGER: Record<string, string> = {
  big_refund: 'Крупный возврат', low_stock: 'Мало товара', shift_long: 'Долгая смена',
};

export default function AutomationPage() {
  const [tab, setTab] = useState('reports');
  const [schedules, setSchedules] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [hooks, setHooks] = useState<any[]>([]);
  const [deliveries, setDeliveries] = useState<any[]>([]);
  const [chat, setChat] = useState<any[]>([]);
  const [chatText, setChatText] = useState('');
  const [f, setF] = useState<any>({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setErr('');
    try {
      if (tab === 'reports') { setSchedules(await api('/automation/schedules')); setSummary(await api('/automation/daily-summary')); }
      if (tab === 'scenarios') setScenarios(await api('/automation/scenarios'));
      if (tab === 'webhooks') { setHooks(await api('/automation/webhooks')); setDeliveries(await api('/automation/webhooks/deliveries')); }
      if (tab === 'chat') setChat(await api('/automation/chat'));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, [tab]);

  // Факт в шапке — по той вкладке, которая открыта: на других данных нет.
  const fact = tab === 'reports'
    ? `${schedules.filter((s: any) => s.enabled).length} расписаний работает из ${schedules.length}`
    : tab === 'scenarios'
      ? `${scenarios.filter((s: any) => s.enabled).length} правил включено из ${scenarios.length}`
      : tab === 'webhooks'
        ? `${hooks.length} вебхуков · ${deliveries.filter((d: any) => d.status !== 'ok').length} неудачных доставок`
        : `${chat.length} сообщений в переписке`;

  return (
    <>
      <PageHeader
        title="Автоматизация и связь"
        fact={fact}
        note="Система работает сама: вечерняя сводка приходит без просьбы, правило пишет вам при крупном возврате, вебхук сообщает сторонней программе о продаже."
      />
      <ErrLine err={err} />
      {msg && <p style={{ color: C.accentDark, fontSize: 13 }}>{msg}</p>}

      <div style={{ marginTop: 14 }}>
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'reports', label: 'Автоотчёты' },
          { key: 'scenarios', label: 'Сценарии' },
          { key: 'webhooks', label: 'Вебхуки' },
          { key: 'chat', label: 'Поддержка' },
        ]} />

        {tab === 'reports' && (
          <Card title="Вечерняя сводка">
            <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55 }}>
              Каждый вечер — выручка и прибыль за день на email или в Telegram.
              Одна настройка, а не конструктор отчётов.
            </p>
            {summary && (
              <div style={{ padding: '14px 16px', background: C.sunken, border: `1px solid ${C.lineIn}`,
                borderRadius: 10, fontSize: 14, marginBottom: 14, lineHeight: 1.6 }}>
                Сегодня: чеков <b>{summary.receipts}</b>, выручка <b style={{ whiteSpace: 'nowrap' }}>{money(summary.revenue)}</b>,
                прибыль <b style={{ whiteSpace: 'nowrap' }}>{money(summary.profit)}</b>
                <div style={{ fontSize: 13, color: C.dim, marginTop: 6 }}>Ровно это и придёт вечером — вид сводки можно проверить заранее.</div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'flex-end' }}>
              <Field label="Куда слать">
                <Select value={f.channel ?? 'email'} onChange={(e: any) => setF({ ...f, channel: e.target.value })}
                  options={[{ value: 'email', label: 'Email' }, { value: 'telegram', label: 'Telegram' }]} />
              </Field>
              <Field label={f.channel === 'telegram' ? 'chat_id' : 'Адрес почты'}>
                <Input placeholder={f.channel === 'telegram' ? 'chat_id' : 'email'} value={f.target ?? ''} onChange={(e: any) => setF({ ...f, target: e.target.value })} />
              </Field>
              <Field label="Час отправки">
                <Input type="number" placeholder="21" value={f.sendAtHour ?? ''} onChange={(e: any) => setF({ ...f, sendAtHour: e.target.value })} w={100} style={{ textAlign: 'right' }} />
              </Field>
              <Btn onClick={async () => { setErr(''); setMsg('');
                try { await api('/automation/schedules', { method: 'POST', body: JSON.stringify({ channel: f.channel ?? 'email', target: f.target, sendAtHour: f.sendAtHour ? +f.sendAtHour : 21 }) });
                  setF({}); setMsg('Расписание добавлено'); load(); } catch (e: any) { setErr(e.message); } }}>Добавить</Btn>
            </div>
            <DataTable storageKey="automation" exportName="automation" search={false}
              hint="Ставьте час после закрытия магазина: сводка за день считается на момент отправки, и в 18:00 она покажет неполную выручку."
              empty="Расписаний нет — добавьте адрес, и сводка начнёт приходить сегодня же" cols={[
              { h: 'Канал', k: 'channel' },
              { h: 'Куда', r: (r: any) => <span style={{ opacity: r.enabled ? 1 : .5 }}>{r.target}</span> },
              { h: 'Время', right: true, r: (r: any) => `${r.send_at_hour}:00` },
              { h: 'Состояние', r: (r: any) => (
                  <Toggle checked={!!r.enabled} on="Работает" off="Выключено"
                    onChange={async (v) => {
                      await api(`/automation/schedules/${r.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: v }) });
                      load();
                    }} />
                ) },
              { h: '', r: (r: any) => <Btn kind="danger" onClick={async () => {
                  if (!await confirmDanger('Удалить расписание?',
                    `Вечерние сводки на ${r.target} перестанут приходить. Отчёты и данные не затрагиваются — расписание можно завести заново.`)) return;
                  await api(`/automation/schedules/${r.id}`, { method: 'DELETE' }); load();
                }}>Удалить</Btn> },
            ]} rows={schedules} />
          </Card>
        )}

        {tab === 'scenarios' && (
          <Card title="Сценарии">
            <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55 }}>
              Правило «условие → уведомление владельцу». Например: «крупный
              возврат больше 10 000 ₸ → напиши мне».
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'flex-end' }}>
              <Field label="Название"><Input placeholder="Крупный возврат" value={f.name ?? ''} onChange={(e: any) => setF({ ...f, name: e.target.value })} w={200} /></Field>
              <Field label="Событие">
                <Select value={f.trigger ?? 'big_refund'} onChange={(e: any) => setF({ ...f, trigger: e.target.value })}
                  options={Object.entries(TRIGGER).map(([value, label]) => ({ value, label }))} />
              </Field>
              <Field label="Порог, ₸"><Input type="number" placeholder="10000" value={f.threshold ?? ''} onChange={(e: any) => setF({ ...f, threshold: e.target.value })} w={120} style={{ textAlign: 'right' }} /></Field>
              <Btn onClick={async () => { setErr(''); setMsg('');
                try { await api('/automation/scenarios', { method: 'POST', body: JSON.stringify({ name: f.name, trigger: f.trigger ?? 'big_refund', threshold: f.threshold ? +f.threshold : undefined }) });
                  setF({}); setMsg('Сценарий создан'); load(); } catch (e: any) { setErr(e.message); } }}>Создать</Btn>
            </div>
            <DataTable storageKey="automation-2" exportName="automation-2" search={false}
              hint="Выключенное правило молчит, но не удаляется: сезонные сценарии удобно гасить, а не заводить заново."
              empty="Сценариев нет — заведите первый, например «возврат больше 10 000 ₸»" cols={[
              { h: 'Название', r: (r: any) => <span style={{ opacity: r.enabled ? 1 : .5, fontWeight: r.enabled ? 400 : 400 }}>{r.name}</span> },
              { h: 'Событие', r: (r: any) => <span style={{ opacity: r.enabled ? 1 : .5 }}>{TRIGGER[r.trigger] ?? r.trigger}</span> },
              { h: 'Порог', right: true, r: (r: any) => r.threshold != null ? money(r.threshold) : '—' },
              { h: 'Состояние', r: (r: any) => (
                  <Toggle checked={!!r.enabled} on="Следит" off="Молчит"
                    onChange={async (v) => {
                      await api(`/automation/scenarios/${r.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: v }) });
                      load();
                    }} />
                ) },
            ]} rows={scenarios} />
          </Card>
        )}

        {tab === 'webhooks' && (
          <Card title="Вебхуки">
            <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55 }}>
              POST во внешнюю систему при событии (продажа, приёмка). С подписью
              HMAC и журналом доставки — видно, дошло ли.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'flex-end' }}>
              <Field label="Адрес"><Input placeholder="https://..." value={f.url ?? ''} onChange={(e: any) => setF({ ...f, url: e.target.value })} w={280} /></Field>
              <Field label="Секрет (необязательно)"><Input placeholder="для подписи HMAC" value={f.secret ?? ''} onChange={(e: any) => setF({ ...f, secret: e.target.value })} w={200} /></Field>
              <Btn onClick={async () => { setErr(''); setMsg('');
                try { await api('/automation/webhooks', { method: 'POST', body: JSON.stringify({ url: f.url, secret: f.secret || undefined }) });
                  setF({}); setMsg('Вебхук добавлен'); load(); } catch (e: any) { setErr(e.message); } }}>Добавить</Btn>
            </div>
            <DataTable storageKey="automation-3" exportName="automation-3" search={false}
              hint="Секрет нужен, чтобы принимающая сторона убедилась: событие пришло от вас, а не от постороннего. Без него подпись не считается."
              empty="Вебхуков нет. Они нужны, только если у вас есть своя программа, которой надо знать о продажах" cols={[
              { h: 'URL', k: 'url' },
              { h: 'События', r: (r: any) => (r.events ?? []).join(', ') },
              { h: '', r: (r: any) => <div style={{ display: 'flex', gap: 6 }}>
                  <Btn kind="ghost" onClick={async () => { await api('/automation/webhooks/test', { method: 'POST', body: '{}' }); setMsg('Тестовое событие отправлено'); load(); }}>Тест</Btn>
                  <Btn kind="danger" onClick={async () => {
                    if (!await confirmDanger('Удалить вебхук?',
                      `Программа на ${r.url} перестанет получать события сразу. Журнал доставки останется.`)) return;
                    await api(`/automation/webhooks/${r.id}`, { method: 'DELETE' }); load();
                  }}>Удалить</Btn>
                </div> },
            ]} rows={hooks} />
            {deliveries.length > 0 && (
              <>
                <h3 style={{ fontSize: 15, fontWeight: 600, marginTop: 22, marginBottom: 12 }}>Журнал доставки</h3>
                <DataTable storageKey="automation-4" exportName="automation-4" search={false}
                  hint="Сюда смотрят, когда сторонняя программа «не видит продаж»: видно, ушло событие или упало, и с каким ответом."
                  empty="Событий ещё не отправлялось" cols={[
                  { h: 'Событие', k: 'event' }, { h: 'URL', k: 'url' },
                  { h: 'Статус', r: (r: any) => r.status === 'ok' ? <Badge tone="ok">доставлено {r.response_code}</Badge> : <Badge tone="bad">ошибка</Badge> },
                  { h: 'Когда', r: (r: any) => dt(r.created_at) },
                ]} rows={deliveries} />
              </>
            )}
          </Card>
        )}

        {tab === 'chat' && (
          <Card title="Поддержка">
            <div style={{ minHeight: 200, maxHeight: 360, overflowY: 'auto', border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, marginBottom: 12, background: C.sunken }}>
              {chat.length === 0 ? <p style={{ color: C.dim, fontSize: 14, margin: 0 }}>Напишите нам — ответим здесь же. Говорим по-казахски и по-русски.</p>
                : chat.map((m: any) => (
                  <div key={m.id} style={{ textAlign: m.from_side === 'client' ? 'right' : 'left', margin: '8px 0' }}>
                    <span style={{ display: 'inline-block', padding: '9px 13px', borderRadius: 12, fontSize: 14, lineHeight: 1.5, maxWidth: '70%',
                      background: m.from_side === 'client' ? C.accent : C.card,
                      border: m.from_side === 'client' ? 0 : `1px solid ${C.line}`,
                      color: m.from_side === 'client' ? '#fff' : C.text }}>
                      {m.body}
                    </span>
                  </div>
                ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input placeholder="Сообщение…" value={chatText} onChange={(e: any) => setChatText(e.target.value)} style={{ flex: 1 }} w="auto"
                onKeyDown={async (e: any) => { if (e.key === 'Enter' && chatText.trim()) { await api('/automation/chat', { method: 'POST', body: JSON.stringify({ body: chatText }) }); setChatText(''); load(); } }} />
              <Btn onClick={async () => { if (!chatText.trim()) return; await api('/automation/chat', { method: 'POST', body: JSON.stringify({ body: chatText }) }); setChatText(''); load(); }}>Отправить</Btn>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
