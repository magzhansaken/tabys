'use client';
import { useEffect, useState } from 'react';
import { C, Status } from '../../lib/ui';

/**
 * ОПЕРАТОРСКАЯ СТРАНИЦА (часть 20). Не для магазинов — для нас: метрики
 * SaaS, аккаунты с ручным продлением (Kaspi-переводы — реальность рынка),
 * заявки с лендинга. Вход по ключу OPERATOR_KEY; ключ хранится только в
 * localStorage этой машины и уходит заголовком x-operator-key.
 *
 * ВНЕШНИЙ ВИД: ЗДЕСЬ ПЛОТНЕЕ И СУШЕ, ЧЕМ В КАБИНЕТЕ. Другой пользователь и
 * другая задача — сюда заходят работать, а не любоваться. Строка 11 px
 * вместо 15, текст 13,5 вместо 14,5, воздуха вдвое меньше: за один экран
 * нужно видеть весь список, а не пять красивых карточек.
 *
 * Первая вкладка — «Регистрации», а не «Обзор»: с них начинается день
 * оператора, по ним обзваниваются новые клиенты. Счётчик вынесен в шапку,
 * добавлена колонка «Ждёт» — сколько человек уже сидит без доступа.
 * Телефон кликабельный: нажал и звонишь.
 *
 * Статусы аккаунтов и заявок печатает <Status /> из общей библиотеки —
 * своего перевода здесь нет и быть не должно.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

async function op(path: string, key: string, init?: RequestInit) {
  const r = await fetch(API + path, { ...init,
    headers: { 'Content-Type': 'application/json', 'x-operator-key': key, ...(init?.headers ?? {}) } });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
  return d;
}
const dt = (v?: string) => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const money = (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ₸`;

/** Сколько человек уже ждёт доступа. Оператору важнее «5 часов», чем дата. */
const waiting = (v?: string) => {
  if (!v) return '—';
  const h = Math.floor((Date.now() - new Date(v).getTime()) / 36e5);
  if (h < 1) return 'меньше часа';
  if (h < 24) return `${h} ч`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 день' : `${d} дн`;
};

export default function OperatorPage() {
  const [key, setKey] = useState('');
  const [entered, setEntered] = useState(false);
  const [tab, setTab] = useState<'overview' | 'signups' | 'accounts' | 'leads'>('signups');
  const [ov, setOv] = useState<any>(null);
  const [accs, setAccs] = useState<any[]>([]);
  const [leads, setLeads] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [signups, setSignups] = useState<any[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem('operator_key');
    if (saved) { setKey(saved); setEntered(true); }
  }, []);

  const load = async (k = key) => {
    setErr('');
    try {
      setOv(await op('/operator/overview', k));
      setAccs((await op(`/operator/accounts?q=${encodeURIComponent(q)}`, k)).items);
      setLeads((await op('/public/leads', k)).items);
      setSignups((await op('/operator/signups', k)).items);
    } catch (e: any) { setErr(e.message); setEntered(false); }
  };
  useEffect(() => { if (entered) load(); }, [entered]);

  const extend = async (a: any) => {
    const days = prompt(`Продлить «${a.name}» на сколько дней?`, '30');
    if (!days) return;
    const amount = prompt('Сумма платежа, ₸ (что пришло на Kaspi):', '6900');
    try {
      await op(`/operator/accounts/${a.id}/extend`, key, { method: 'POST',
        body: JSON.stringify({ days: +days, amount: amount ? +amount : 0, comment: 'Kaspi-перевод, вручную' }) });
      load();
    } catch (e: any) { setErr(e.message); }
  };
  const setStatus = async (a: any, status: string) => {
    try {
      await op(`/operator/accounts/${a.id}/status`, key, { method: 'POST', body: JSON.stringify({ status }) });
      load();
    } catch (e: any) { setErr(e.message); }
  };
  // Активация заявки: доступ открывается, начинается пробный период
  const activate = async (a: any) => {
    if (!confirm(`Открыть доступ магазину «${a.name}» (${a.phone})?\n\nНачнётся пробный период 14 дней.`)) return;
    try {
      await op(`/operator/accounts/${a.id}/activate`, key, { method: 'POST',
        body: JSON.stringify({ by: 'оператор' }) });
      load();
    } catch (e: any) { setErr(e.message); }
  };

  // Сброс пароля: пока нет СМС, это единственный способ вернуть клиенту доступ
  const resetPassword = async (a: any) => {
    const pw = prompt(`Новый пароль для «${a.name}» (не короче 8 знаков).\nПередайте его клиенту лично:`, '');
    if (!pw) return;
    try {
      await op(`/operator/accounts/${a.id}/reset-password`, key, { method: 'POST',
        body: JSON.stringify({ password: pw }) });
      alert('Пароль изменён. Передайте его клиенту.');
    } catch (e: any) { setErr(e.message); }
  };

  const leadStatus = async (l: any, status: string) => {
    try {
      await op(`/public/leads/${l.id}`, key, { method: 'PATCH', body: JSON.stringify({ status }) });
      load();
    } catch (e: any) { setErr(e.message); }
  };

  const card: any = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, overflow: 'hidden' };
  const th: any = { textAlign: 'left', padding: '9px 14px', color: C.dim, fontWeight: 500, fontSize: 12,
    borderBottom: `1px solid ${C.line}`, background: C.sunken, whiteSpace: 'nowrap' };
  const thR: any = { ...th, textAlign: 'right' };
  const td: any = { padding: '11px 14px', borderBottom: `1px solid ${C.lineIn}`, fontSize: 13.5, lineHeight: 1.45 };
  const tdR: any = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
  const btn: any = { border: `1px solid #D8D8CF`, background: C.card, borderRadius: 7, minHeight: 30,
    padding: '0 11px', cursor: 'pointer', fontSize: 13, color: C.text, fontFamily: 'inherit' };
  const table: any = { width: '100%', borderCollapse: 'collapse' };
  const h1: any = { fontSize: 21, fontWeight: 600, margin: 0 };
  const mono: any = { fontFamily: 'var(--font-mono), monospace', fontSize: 13 };

  // ── Вход по ключу ───────────────────────────────────────────────────
  if (!entered) {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: C.bg, padding: 20 }}>
        <div style={{ width: '100%', maxWidth: 380 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 22 }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: C.accent, color: '#fff', fontSize: 14,
              fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>Т</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Оператор</div>
          </div>
          <div style={{ ...card, borderRadius: 12, padding: '24px 26px' }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 6px' }}>Операторский доступ</h1>
            <p style={{ fontSize: 13.5, color: C.dim, lineHeight: 1.55, margin: '0 0 18px' }}>
              Вход не по паролю, а по ключу. Ключ остаётся на этой машине.
            </p>
            <input type="password" placeholder="OPERATOR_KEY" value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && key) { localStorage.setItem('operator_key', key); setEntered(true); } }}
              style={{ width: '100%', height: 44, padding: '0 12px', boxSizing: 'border-box', fontSize: 16,
                border: `1px solid #D8D8CF`, borderRadius: 8, fontFamily: 'var(--font-mono), monospace', outline: 'none' }} />
            {err && <p style={{ color: C.red, fontSize: 13.5, lineHeight: 1.5, margin: '10px 0 0' }}>{err}</p>}
            <button style={{ ...btn, minHeight: 44, width: '100%', marginTop: 12, background: C.accent,
              color: '#fff', border: 0, fontSize: 15, fontWeight: 500 }}
              onClick={() => { localStorage.setItem('operator_key', key); setEntered(true); }}>
              Войти
            </button>
          </div>
        </div>
      </main>
    );
  }

  const tabs: [typeof tab, string, number][] = [
    ['signups', 'Регистрации', signups.length],
    ['overview', 'Обзор', 0],
    ['accounts', 'Аккаунты', 0],
    ['leads', 'Заявки с сайта', ov?.leadsNew ?? 0],
  ];

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text }}>
      {/* Тёмная шапка: рабочий инструмент, а не витрина */}
      <div style={{ background: C.text, color: '#fff' }}>
        <div style={{ maxWidth: 1240, margin: '0 auto', padding: '0 24px', height: 56,
          display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div style={{ width: 22, height: 22, borderRadius: 6, background: C.accent, fontSize: 12, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>Т</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Оператор</div>
          </div>
          <div style={{ display: 'flex', gap: 2, marginLeft: 12 }}>
            {tabs.map(([k, label, count]) => (
              <button key={k} onClick={() => setTab(k)}
                style={{ height: 56, padding: '0 14px', display: 'flex', alignItems: 'center', gap: 7, fontSize: 14,
                  background: 'transparent', border: 0, cursor: 'pointer', fontFamily: 'inherit',
                  color: tab === k ? '#fff' : '#A8B0A8',
                  boxShadow: tab === k ? `inset 0 -2px 0 ${C.accent}` : 'none' }}>
                <span>{label}</span>
                {count > 0 && (
                  <span style={{ background: tab === k ? C.accent : '#3A423C', color: '#fff', borderRadius: 999,
                    padding: '1px 7px', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
                )}
              </button>
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ ...mono, fontSize: 12.5, color: '#8E958C' }}>ключ ····{key.slice(-4)}</div>
          <button style={{ background: 'transparent', border: 0, color: '#A8B0A8', fontSize: 13.5,
            cursor: 'pointer', fontFamily: 'inherit' }}
            onClick={() => { localStorage.removeItem('operator_key'); setEntered(false); }}>Выйти</button>
        </div>
      </div>

      <main style={{ maxWidth: 1240, margin: '0 auto', padding: '22px 24px 64px' }}>
        {err && <p style={{ color: C.red, fontSize: 14 }}>{err}</p>}

        {tab === 'signups' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16,
              flexWrap: 'wrap', marginBottom: 4 }}>
              <h1 style={h1}>Новые регистрации</h1>
              <div style={{ fontSize: 13, color: C.dim }}>всего в очереди: {signups.length}</div>
            </div>
            <p style={{ fontSize: 13.5, color: C.dim, margin: '6px 0 16px', maxWidth: '84ch', lineHeight: 1.55 }}>
              Магазины зарегистрировались на сайте и ждут доступа. Позвоните,
              познакомьтесь и нажмите «Открыть доступ» — начнётся пробный период 14 дней.
            </p>
            {signups.length === 0 ? (
              <div style={{ ...card, padding: '44px 20px', display: 'flex', flexDirection: 'column',
                alignItems: 'center', gap: 10, textAlign: 'center' }}>
                <div style={{ width: 34, height: 34, border: `1.5px dashed #C9C9BE`, borderRadius: 9 }} />
                <div style={{ fontSize: 14.5, color: C.dim }}>Новых регистраций нет — все обзвонены</div>
              </div>
            ) : (
              <div style={card}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={table}>
                    <thead><tr>
                      <th style={th}>Магазин</th><th style={th}>Владелец</th><th style={th}>Телефон</th>
                      <th style={th}>Комментарий</th><th style={th}>Ждёт</th><th style={th}></th>
                    </tr></thead>
                    <tbody>
                      {signups.map((a) => (
                        <tr key={a.id}>
                          <td style={{ ...td, fontWeight: 600 }}>{a.name}</td>
                          <td style={td}>{a.owner_name ?? '—'}</td>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>
                            <a href={`tel:${a.phone}`} style={mono}>{a.phone}</a>
                          </td>
                          <td style={{ ...td, color: C.dim }}>{a.signup_note ?? '—'}</td>
                          <td style={{ ...td, color: C.dim, whiteSpace: 'nowrap' }} title={dt(a.created_at)}>
                            {waiting(a.created_at)}
                          </td>
                          <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button style={{ ...btn, minHeight: 32, background: C.accent, color: '#fff',
                              border: 0, fontWeight: 500, fontSize: 13.5 }}
                              onClick={() => activate(a)}>Открыть доступ</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'overview' && ov && (
          <>
            <h1 style={{ ...h1, marginBottom: 16 }}>Обзор</h1>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(158px, 1fr))', gap: 10 }}>
              {[
                ['MRR', money(ov.mrr), ''],
                ['Поступления 30 дн', money(ov.payments30d), ''],
                ['Аккаунтов', String(ov.accounts.total), `+${ov.accounts.new7d} за 7 дней`],
                ['Живых за 7 дней', String(ov.accounts.alive7d), ''],
                ['Триалов', String(ov.subscriptions.trials), ''],
                ['Платящих', String(ov.subscriptions.paying), ''],
                ['Новых заявок', String(ov.leadsNew), ''],
              ].map(([l, v, s]) => (
                <div key={l} style={{ ...card, padding: '13px 15px' }}>
                  <div style={{ fontSize: 12, color: C.dim }}>{l}</div>
                  <div style={{ fontSize: 20, fontWeight: 600, marginTop: 5, whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums' }}>{v}</div>
                  {s && <div style={{ fontSize: 12, color: C.faint, marginTop: 3 }}>{s}</div>}
                </div>
              ))}
            </div>
            <div style={{ ...card, marginTop: 14 }}>
              <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.lineIn}`, fontSize: 15, fontWeight: 600 }}>
                Последние платежи
              </div>
              <table style={table}>
                <thead><tr>
                  <th style={th}>Когда</th><th style={th}>Аккаунт</th><th style={thR}>Сумма</th><th style={th}>Комментарий</th>
                </tr></thead>
                <tbody>{ov.recentPayments.map((p: any, i: number) => (
                  <tr key={i}>
                    <td style={{ ...td, color: C.dim, whiteSpace: 'nowrap' }}>{dt(p.created_at)}</td>
                    <td style={td}>{p.account_name}</td>
                    <td style={{ ...tdR, fontWeight: 500 }}>{money(p.amount)}</td>
                    <td style={{ ...td, color: C.dim }}>{p.comment}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'accounts' && (
          <>
            <h1 style={{ ...h1, marginBottom: 14 }}>Аккаунты</h1>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              <input placeholder="Имя или телефон" value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && load()}
                style={{ height: 36, padding: '0 12px', border: `1px solid #D8D8CF`, borderRadius: 8,
                  minWidth: 260, fontSize: 16, background: C.card, outline: 'none' }} />
              <button style={{ ...btn, minHeight: 36 }} onClick={() => load()}>Найти</button>
            </div>
            <div style={card}>
              <div style={{ overflowX: 'auto' }}>
                <table style={table}>
                  <thead><tr>
                    <th style={th}>Бизнес</th><th style={th}>Телефон</th><th style={th}>Тариф</th>
                    <th style={th}>Статус</th><th style={th}>Оплачено до</th><th style={thR}>Чеков 7д</th>
                    <th style={thR}>Касс</th><th style={th}></th>
                  </tr></thead>
                  <tbody>{accs.map((a) => (
                    <tr key={a.id}>
                      <td style={{ ...td, fontWeight: 600 }}>
                        {a.name} <span style={{ color: C.faint, fontSize: 12, fontWeight: 400 }}>{a.lang}</span>
                      </td>
                      <td style={{ ...td, ...mono, whiteSpace: 'nowrap' }}>{a.phone}</td>
                      <td style={td}>{a.tariff ?? '—'}</td>
                      <td style={td}><Status value={a.sub_status} /></td>
                      <td style={{ ...td, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{a.paid_until ?? '—'}</td>
                      <td style={tdR}>{a.receipts_7d}</td>
                      <td style={tdR}>{a.devices}</td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <button style={btn} onClick={() => extend(a)}>Продлить</button>
                          <button style={btn} onClick={() => resetPassword(a)} title="Клиент забыл пароль">Пароль</button>
                          {a.sub_status === 'frozen'
                            ? <button style={btn} onClick={() => setStatus(a, 'active')}>Разморозить</button>
                            : <button style={{ ...btn, color: C.red, borderColor: '#E6C7C0' }}
                                onClick={() => setStatus(a, 'frozen')}>Заморозить</button>}
                        </span>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {tab === 'leads' && (
          <>
            <h1 style={{ ...h1, marginBottom: 4 }}>Заявки с сайта</h1>
            <p style={{ fontSize: 13.5, color: C.dim, margin: '6px 0 16px' }}>
              Формы «хочу пилот с переездом». Спам гасится, но не удаляется.
            </p>
            <div style={card}>
              <div style={{ overflowX: 'auto' }}>
                <table style={table}>
                  <thead><tr>
                    <th style={th}>Когда</th><th style={th}>Имя</th><th style={th}>Телефон</th>
                    <th style={th}>Город</th><th style={th}>Язык</th><th style={th}>Комментарий</th>
                    <th style={th}>Статус</th><th style={th}></th>
                  </tr></thead>
                  <tbody>{leads.map((l) => (
                    <tr key={l.id} style={{ opacity: l.status === 'spam' ? 0.45 : 1 }}>
                      <td style={{ ...td, color: C.dim, whiteSpace: 'nowrap' }}>{dt(l.created_at)}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{l.name}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}><a href={`tel:${l.phone}`} style={mono}>{l.phone}</a></td>
                      <td style={td}>{l.city ?? '—'}</td>
                      <td style={{ ...td, color: C.dim }}>{l.locale === 'kk' ? 'қаз' : 'рус'}</td>
                      <td style={{ ...td, color: C.dim, maxWidth: 260 }}>{l.comment}</td>
                      <td style={td}><Status value={l.status} /></td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          {l.status === 'new' && <button style={btn} onClick={() => leadStatus(l, 'called')}>Прозвонили</button>}
                          {l.status !== 'converted' && (
                            <button style={{ ...btn, color: C.accent, borderColor: C.accent }}
                              onClick={() => leadStatus(l, 'converted')}>Клиент</button>
                          )}
                          {l.status !== 'spam' && (
                            <button style={{ ...btn, color: C.dim }} onClick={() => leadStatus(l, 'spam')}>Спам</button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
