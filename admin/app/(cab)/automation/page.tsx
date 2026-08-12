'use client';
/**
 * Автоматизация и связь (часть 27). Автоотчёты, сценарии, вебхуки, чат
 * поддержки. Готовая польза одной галочкой, а не конструктор.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, Tabs, Btn, Input, Select, Field, money, dt, C, ErrLine, Badge } from '../../../lib/ui';

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

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>Автоматизация и связь</h1>
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
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Каждый вечер — выручка и прибыль за день на email или в Telegram.
              Одна настройка, а не конструктор отчётов.
            </p>
            {summary && (
              <div style={{ padding: 12, background: '#f6f8fa', borderRadius: 8, fontSize: 14, marginBottom: 14 }}>
                Сегодня: чеков <b>{summary.receipts}</b>, выручка <b>{money(summary.revenue)}</b>, прибыль <b>{money(summary.profit)}</b>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <Select value={f.channel ?? 'email'} onChange={(e: any) => setF({ ...f, channel: e.target.value })}
                options={[{ value: 'email', label: 'Email' }, { value: 'telegram', label: 'Telegram' }]} />
              <Input placeholder={f.channel === 'telegram' ? 'chat_id' : 'email'} value={f.target ?? ''} onChange={(e: any) => setF({ ...f, target: e.target.value })} />
              <Input type="number" placeholder="Час (21)" value={f.sendAtHour ?? ''} onChange={(e: any) => setF({ ...f, sendAtHour: e.target.value })} style={{ maxWidth: 100 }} />
              <Btn onClick={async () => { setErr(''); setMsg('');
                try { await api('/automation/schedules', { method: 'POST', body: JSON.stringify({ channel: f.channel ?? 'email', target: f.target, sendAtHour: f.sendAtHour ? +f.sendAtHour : 21 }) });
                  setF({}); setMsg('Расписание добавлено'); load(); } catch (e: any) { setErr(e.message); } }}>Добавить</Btn>
            </div>
            <DataTable hint="Система работает сама: вечерние сводки, уведомления по условию, оповещения для сторонних программ." storageKey="automation" exportName="automation" empty="Расписаний нет" cols={[
              { h: 'Канал', k: 'channel' }, { h: 'Куда', k: 'target' },
              { h: 'Время', r: (r: any) => `${r.send_at_hour}:00` },
              { h: 'Статус', r: (r: any) => r.enabled ? <Badge tone="ok">включено</Badge> : <Badge tone="dim">выкл</Badge> },
              { h: '', r: (r: any) => <Btn kind="ghost" onClick={async () => { await api(`/automation/schedules/${r.id}`, { method: 'DELETE' }); load(); }}>Удалить</Btn> },
            ]} rows={schedules} />
          </Card>
        )}

        {tab === 'scenarios' && (
          <Card title="Сценарии">
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              Правило «условие → уведомление владельцу». Например, «крупный
              возврат больше 10 000 ₸ → напиши мне».
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <Input placeholder="Название" value={f.name ?? ''} onChange={(e: any) => setF({ ...f, name: e.target.value })} style={{ maxWidth: 160 }} />
              <Select value={f.trigger ?? 'big_refund'} onChange={(e: any) => setF({ ...f, trigger: e.target.value })}
                options={[{ value: 'big_refund', label: 'Крупный возврат' }, { value: 'low_stock', label: 'Мало товара' }, { value: 'shift_long', label: 'Долгая смена' }]} />
              <Input type="number" placeholder="Порог" value={f.threshold ?? ''} onChange={(e: any) => setF({ ...f, threshold: e.target.value })} style={{ maxWidth: 110 }} />
              <Btn onClick={async () => { setErr(''); setMsg('');
                try { await api('/automation/scenarios', { method: 'POST', body: JSON.stringify({ name: f.name, trigger: f.trigger ?? 'big_refund', threshold: f.threshold ? +f.threshold : undefined }) });
                  setF({}); setMsg('Сценарий создан'); load(); } catch (e: any) { setErr(e.message); } }}>Создать</Btn>
            </div>
            <DataTable storageKey="automation-2" exportName="automation-2" empty="Сценариев нет" cols={[
              { h: 'Название', k: 'name' },
              { h: 'Событие', r: (r: any) => ({ big_refund: 'Крупный возврат', low_stock: 'Мало товара', shift_long: 'Долгая смена' } as any)[r.trigger] },
              { h: 'Порог', right: true, r: (r: any) => r.threshold != null ? money(r.threshold) : '—' },
              { h: 'Статус', r: (r: any) => <label style={{ cursor: 'pointer' }}><input type="checkbox" checked={r.enabled}
                  onChange={async (e) => { await api(`/automation/scenarios/${r.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) }); load(); }} /> вкл</label> },
            ]} rows={scenarios} />
          </Card>
        )}

        {tab === 'webhooks' && (
          <Card title="Вебхуки">
            <p style={{ fontSize: 13, color: C.dim, marginTop: 0 }}>
              POST во внешнюю систему при событии (продажа, приёмка). С подписью
              HMAC и журналом доставки — видно, дошло ли.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <Input placeholder="https://..." value={f.url ?? ''} onChange={(e: any) => setF({ ...f, url: e.target.value })} style={{ minWidth: 240 }} />
              <Input placeholder="секрет (необязательно)" value={f.secret ?? ''} onChange={(e: any) => setF({ ...f, secret: e.target.value })} style={{ maxWidth: 160 }} />
              <Btn onClick={async () => { setErr(''); setMsg('');
                try { await api('/automation/webhooks', { method: 'POST', body: JSON.stringify({ url: f.url, secret: f.secret || undefined }) });
                  setF({}); setMsg('Вебхук добавлен'); load(); } catch (e: any) { setErr(e.message); } }}>Добавить</Btn>
            </div>
            <DataTable storageKey="automation-3" exportName="automation-3" empty="Вебхуков нет" cols={[
              { h: 'URL', k: 'url' },
              { h: 'События', r: (r: any) => (r.events ?? []).join(', ') },
              { h: '', r: (r: any) => <div style={{ display: 'flex', gap: 6 }}>
                  <Btn kind="ghost" onClick={async () => { await api('/automation/webhooks/test', { method: 'POST', body: '{}' }); setMsg('Тестовое событие отправлено'); load(); }}>Тест</Btn>
                  <Btn kind="ghost" onClick={async () => { await api(`/automation/webhooks/${r.id}`, { method: 'DELETE' }); load(); }}>Удалить</Btn>
                </div> },
            ]} rows={hooks} />
            {deliveries.length > 0 && (
              <>
                <h3 style={{ fontSize: 15, marginTop: 18 }}>Журнал доставки</h3>
                <DataTable storageKey="automation-4" exportName="automation-4" cols={[
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
            <div style={{ minHeight: 200, maxHeight: 360, overflowY: 'auto', border: `1px solid ${C.line}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
              {chat.length === 0 ? <p style={{ color: C.dim, fontSize: 14 }}>Напишите нам — ответим здесь же.</p>
                : chat.map((m: any) => (
                  <div key={m.id} style={{ textAlign: m.from_side === 'client' ? 'right' : 'left', margin: '6px 0' }}>
                    <span style={{ display: 'inline-block', padding: '8px 12px', borderRadius: 10, fontSize: 14,
                      background: m.from_side === 'client' ? C.accent : '#eef0f3', color: m.from_side === 'client' ? '#fff' : C.text }}>
                      {m.body}
                    </span>
                  </div>
                ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input placeholder="Сообщение…" value={chatText} onChange={(e: any) => setChatText(e.target.value)} style={{ flex: 1 }}
                onKeyDown={async (e: any) => { if (e.key === 'Enter' && chatText.trim()) { await api('/automation/chat', { method: 'POST', body: JSON.stringify({ body: chatText }) }); setChatText(''); load(); } }} />
              <Btn onClick={async () => { if (!chatText.trim()) return; await api('/automation/chat', { method: 'POST', body: JSON.stringify({ body: chatText }) }); setChatText(''); load(); }}>Отправить</Btn>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
