'use client';
/**
 * КАБИНЕТ ПЛАТФОРМЫ — владелец сервиса и партнёры.
 *
 * Восемь разделов, порядок не случайный: «Сегодня» первым, потому что
 * день начинается с решений, а не со списка клиентов. Дальше по
 * убыванию частоты обращения.
 *
 * Партнёру показываются не все разделы: партнёры, сводка и настройки —
 * не его дело. Кнопка, которая ответит «нельзя», не рисуется вовсе.
 */
import { useEffect, useState } from 'react';
import { C, Card, Btn, Input, Field, BaseStyles, ErrLine } from '../../lib/ui';
import { api, readSession, saveSession, clearSession, type Me } from './lib';

import Today from './sections/Today';
import Clients from './sections/Clients';
import Money from './sections/Money';
import Requests from './sections/Requests';
import Funnel from './sections/Funnel';
import Partners from './sections/Partners';
import Summary from './sections/Summary';
import Journal from './sections/Journal';

type TabKey = 'today' | 'clients' | 'money' | 'requests'
  | 'funnel' | 'partners' | 'summary' | 'journal';

const TABS: { key: TabKey; label: string; partnerLabel?: string; superOnly?: boolean }[] = [
  { key: 'today',    label: 'Сегодня' },
  { key: 'clients',  label: 'Клиенты',  partnerLabel: 'Мои клиенты' },
  { key: 'money',    label: 'Деньги',   partnerLabel: 'Оплаты' },
  { key: 'requests', label: 'Заявки',   partnerLabel: 'Мои заявки' },
  { key: 'funnel',   label: 'Воронка' },
  { key: 'partners', label: 'Партнёры', superOnly: true },
  { key: 'summary',  label: 'Сводка',   superOnly: true },
  { key: 'journal',  label: 'Журнал',   partnerLabel: 'Мои события' },
];

export default function PlatformPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<TabKey>('today');
  const [ready, setReady] = useState(false);

  // Хранилище браузера читаем только после отрисовки: на сервере его
  // нет, и обращение при отрисовке роняет сборку.
  useEffect(() => {
    const s = readSession();
    if (s) setMe(s.user);
    setReady(true);
  }, []);

  if (!ready) return <BaseStyles />;
  if (!me) return <Login onIn={setMe} />;

  const tabs = TABS.filter((t) => !(t.superOnly && me.role === 'partner'));
  const label = (t: typeof TABS[number]) =>
    me.role === 'partner' && t.partnerLabel ? t.partnerLabel : t.label;

  return (
    <>
      <BaseStyles />
      <div style={{ minHeight: '100vh', background: C.bg }}>
        {/* Шапка: кто вошёл и под какой ролью. Роль важна — от неё
            зависит, что человек может, и путаница здесь дорога. */}
        <header style={{
          background: C.card, borderBottom: `1px solid ${C.line}`,
          padding: '12px 20px', display: 'flex', alignItems: 'center',
          gap: 16, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 10,
        }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: C.accent, whiteSpace: 'nowrap' }}>
            Табыс · Платформа
          </div>

          <nav style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
            {tabs.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{
                  minHeight: 40, padding: '0 14px', borderRadius: 10, fontSize: 15,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                  border: `1px solid ${tab === t.key ? C.accent : 'transparent'}`,
                  background: tab === t.key ? C.accent : 'transparent',
                  color: tab === t.key ? '#fff' : C.text,
                  fontWeight: tab === t.key ? 600 : 400,
                }}>
                {label(t)}
              </button>
            ))}
          </nav>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap' }}>
            <div style={{ textAlign: 'right', lineHeight: 1.2 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{me.name}</div>
              <div style={{ fontSize: 12, color: C.dim }}>
                {me.role === 'super' ? 'владелец платформы' : 'партнёр'}
              </div>
            </div>
            <Btn onClick={() => { clearSession(); setMe(null); }}>Выйти</Btn>
          </div>
        </header>

        <main style={{ maxWidth: 1180, margin: '0 auto', padding: '20px 16px 60px' }}>
          {tab === 'today'    && <Today me={me} goTo={setTab} />}
          {tab === 'clients'  && <Clients me={me} />}
          {tab === 'money'    && <Money me={me} />}
          {tab === 'requests' && <Requests me={me} />}
          {tab === 'funnel'   && <Funnel me={me} />}
          {tab === 'partners' && <Partners me={me} />}
          {tab === 'summary'  && <Summary me={me} />}
          {tab === 'journal'  && <Journal me={me} />}
        </main>
      </div>
    </>
  );
}

/** Вход. Отдельный от кабинета магазина: другие люди, другой ключ. */
function Login({ onIn }: { onIn: (m: Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (!email.trim() || !password) { setErr('Введите почту и пароль'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api<{ token: string; user: Me }>('/login',
        { method: 'POST', body: { email: email.trim(), password } });
      saveSession(r.token, r.user);
      onIn(r.user);
    } catch (e: any) {
      setErr(e.message || 'Не удалось войти');
    } finally { setBusy(false); }
  };

  return (
    <>
      <BaseStyles />
      <div style={{
        minHeight: '100vh', background: C.bg,
        display: 'grid', placeItems: 'center', padding: 16,
      }}>
        <Card title="Платформа Табыс" style={{ maxWidth: 400, width: '100%' }}>
          <p style={{ fontSize: 14, color: C.dim, marginTop: 0 }}>
            Вход для владельца сервиса и партнёров. Кабинет магазина — по другому адресу.
          </p>
          <div style={{ display: 'grid', gap: 12 }}>
            <Field label="Почта">
              <Input value={email} onChange={(e: any) => setEmail(e.target.value)}
                type="email" autoComplete="username" placeholder="you@tabys.kz" />
            </Field>
            <Field label="Пароль">
              <Input value={password} onChange={(e: any) => setPassword(e.target.value)}
                type="password" autoComplete="current-password"
                onKeyDown={(e: any) => { if (e.key === 'Enter') go(); }} />
            </Field>
            {err && <ErrLine err={err} />}
            <Btn primary onClick={go} disabled={busy}>
              {busy ? 'Проверяем…' : 'Войти'}
            </Btn>
          </div>
        </Card>
      </div>
    </>
  );
}
