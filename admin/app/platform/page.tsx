'use client';
/**
 * КАБИНЕТ ПЛАТФОРМЫ.
 *
 * Разметка и классы взяты из кабинета проекта автоматизации ресторанов
 * дословно: shell, side, side-brand, side-nav, side-sep, side-foot, me,
 * ava, me-text, side-row, side-mini, frame, topbar, tabbar.
 *
 * Оформление — их файл style/admin.css целиком, ни одна строка не
 * переписана. Включая переключение светлой и тёмной темы: у них оно
 * есть, значит есть и здесь.
 *
 * Отличается только то, что отличается по делу: «заведение» →
 * «магазин», разделы под магазины, а не под рестораны.
 */
import { useEffect, useState } from 'react';
import { api, readSession, saveSession, clearSession, type Me } from './lib';
import './style/admin.css';
import { AskHost } from './ui/Ask';
import { ToastHost } from './ui/Toast';

import Today from './sections/Today';
import Clients from './sections/Clients';
import Money from './sections/Money';
import Requests from './sections/Requests';
import Funnel from './sections/Funnel';
import Partners from './sections/Partners';
import Summary from './sections/Summary';
import Journal from './sections/Journal';
import Settings from './sections/Settings';

type TabKey = 'today' | 'clients' | 'money' | 'requests'
  | 'funnel' | 'partners' | 'summary' | 'journal' | 'settings';

const TABS: { key: TabKey; label: string; partnerLabel?: string; superOnly?: boolean }[] = [
  { key: 'today',    label: 'Сегодня' },
  { key: 'clients',  label: 'Клиенты',  partnerLabel: 'Мои клиенты' },
  { key: 'money',    label: 'Деньги',   partnerLabel: 'Оплаты' },
  { key: 'requests', label: 'Заявки',   partnerLabel: 'Мои заявки' },
  { key: 'funnel',   label: 'Воронка' },
  { key: 'partners', label: 'Партнёры', superOnly: true },
  { key: 'summary',  label: 'Сводка',   superOnly: true },
  { key: 'journal',  label: 'Журнал',   partnerLabel: 'Мои события' },
  // Настройки последними и только владельцу: цены и реквизиты — самое
  // опасное место платформы, и оно не должно стоять между разделами,
  // куда заходят каждый день.
  { key: 'settings', label: 'Настройки', superOnly: true },
];

const THEME_KEY = 'tabys.platform.theme';

export default function PlatformPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<TabKey>('today');
  const [ready, setReady] = useState(false);
  const [counts, setCounts] = useState<Record<string, number | undefined>>({});
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const s = readSession();
    if (s) setMe(s.user);
    const t = (localStorage.getItem(THEME_KEY) as 'light' | 'dark') ?? 'light';
    setTheme(t);
    document.documentElement.dataset.theme = t;
    setReady(true);
  }, []);

  const toggleTheme = () => {
    const t = theme === 'light' ? 'dark' : 'light';
    setTheme(t);
    localStorage.setItem(THEME_KEY, t);
    document.documentElement.dataset.theme = t;
  };

  // Счётчики: сколько дел ждёт. Одним заходом, не восемью.
  useEffect(() => {
    if (!me) return;
    let alive = true;
    const load = async () => {
      try {
        const [today, pays, reqs] = await Promise.all([
          api('/today').catch(() => null),
          api('/payments?status=pending').catch(() => null),
          api('/requests?status=pending').catch(() => null),
        ]);
        if (!alive) return;
        setCounts({
          today: today?.total || undefined,
          money: pays?.rows?.length || undefined,
          requests: (Array.isArray(reqs) ? reqs.length : 0) || undefined,
        });
      } catch { /* счётчики не критичны */ }
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [me, tab]);

  if (!ready) return null;
  if (!me) return <Login onIn={setMe} />;

  const isSuper = me.role === 'super';
  const tabs = TABS.filter((t) => !(t.superOnly && !isSuper));
  const label = (t: typeof TABS[number]) =>
    !isSuper && t.partnerLabel ? t.partnerLabel : t.label;
  const roleWord = isSuper ? 'супер-админ' : 'партнёр';

  const initials = me.name.split(' ').filter(Boolean).slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase();

  return (
    /* Лист подтверждения и тосты — на всё приложение: любой раздел
       зовёт их через useAsk() и useToast(), не заводя своих. */
    <ToastHost><AskHost>
    <div className="shell">
      <aside className="side">
        <div className="side-brand">
          <b>Табыс</b>
          <span>панель платформы</span>
        </div>

        <nav className="side-nav">
          {tabs.slice(0, 5).map((t) => (
            <NavButton key={t.key} label={label(t)} count={counts[t.key]}
              on={tab === t.key} onClick={() => setTab(t.key)} />
          ))}
          {isSuper && (
            <>
              <div className="side-sep" />
              {tabs.slice(5).map((t) => (
                <NavButton key={t.key} label={label(t)} count={counts[t.key]}
                  on={tab === t.key} onClick={() => setTab(t.key)} />
              ))}
            </>
          )}
          {!isSuper && tabs.slice(5).map((t) => (
            <NavButton key={t.key} label={label(t)} count={counts[t.key]}
              on={tab === t.key} onClick={() => setTab(t.key)} />
          ))}
        </nav>

        <div className="side-foot">
          <div className="me">
            <span className="ava" aria-hidden="true">{initials}</span>
            <span className="me-text">
              <b>{me.name}</b>
              <i>{roleWord}</i>
            </span>
          </div>
          <div className="side-row">
            <button className="side-mini" onClick={toggleTheme}>
              {theme === 'light' ? 'Тёмная тема' : 'Светлая тема'}
            </button>
            <button className="side-mini" onClick={() => { clearSession(); setMe(null); }}>
              Выйти
            </button>
          </div>
        </div>
      </aside>

      <div className="frame">
        <header className="topbar">
          <b>Табыс · платформа</b>
          <span className="badge">{roleWord}</span>
          <button className="btn small ghost" onClick={toggleTheme}>
            {theme === 'light' ? 'Тёмная' : 'Светлая'}
          </button>
          <button className="btn small ghost"
            onClick={() => { clearSession(); setMe(null); }}>Выйти</button>
        </header>

        <main>
          <h1>{label(tabs.find((t) => t.key === tab)!)}</h1>
          {tab === 'today'    && <Today me={me} goTo={setTab} />}
          {tab === 'clients'  && <Clients me={me} />}
          {tab === 'money'    && <Money me={me} />}
          {tab === 'requests' && <Requests me={me} />}
          {tab === 'funnel'   && <Funnel me={me} />}
          {tab === 'partners' && <Partners me={me} />}
          {tab === 'summary'  && <Summary me={me} />}
          {tab === 'journal'  && <Journal me={me} />}
          {tab === 'settings' && <Settings me={me} />}
        </main>
      </div>

      <nav className="tabbar">
        {tabs.slice(0, 5).map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''}
            onClick={() => setTab(t.key)}>
            <span>{label(t)}</span>
            {counts[t.key] ? <span className="count">{counts[t.key]}</span> : null}
          </button>
        ))}
      </nav>
    </div>
    </AskHost></ToastHost>
  );
}

/** Пункт меню. Счётчик — единственная причина открыть раздел сейчас. */
function NavButton({ label, count, on, onClick }: {
  label: string; count?: number; on: boolean; onClick: () => void;
}) {
  return (
    <button className={on ? 'on' : ''} onClick={onClick}>
      <span>{label}</span>
      {count ? <span className="count">{count}</span> : null}
    </button>
  );
}

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
    } catch (e: any) { setErr(e.message || 'Не удалось войти'); }
    finally { setBusy(false); }
  };

  return (
    /* Вход их разметкой: gate, gate-card. Отдельная страница на весь
       экран — это другое место с другими людьми, и путать его с
       кабинетом магазина нельзя. */
    <div className="gate">
      <div className="gate-card">
        <h1>Панель платформы</h1>
        <p className="hint">Управление клиентами и оплатами</p>

        <input placeholder="Почта" value={email} autoComplete="username"
          type="email" onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="Пароль" type="password" value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />

        {err && <p className="err">{err}</p>}

        <button className="btn primary" onClick={go} disabled={busy}>
          {busy ? 'Проверяем…' : 'Войти'}
        </button>
      </div>
    </div>
  );
}
