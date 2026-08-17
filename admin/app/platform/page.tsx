'use client';
/**
 * КАБИНЕТ ПЛАТФОРМЫ — владелец сервиса и партнёры.
 *
 * Раскладка повторяет кабинет соседнего проекта, который владельцу
 * понравился: тёмное меню слева на 246 px, светлое поле справа, на
 * телефоне меню уезжает вниз полосой.
 *
 * Тёмное меню — не украшение: платформа это другое место с другими
 * людьми. Зашёл и сразу видно, что ты сверху над магазинами, а не
 * внутри своего.
 *
 * СЧЁТЧИКИ НА ПУНКТАХ — их приём и он верный: счётчик это единственная
 * причина открыть раздел прямо сейчас. Ноль не рисуем — счётчик с
 * нулём обучает себя игнорировать.
 */
import { useEffect, useState } from 'react';
import { BaseStyles } from '../../lib/ui';
import { P, api, readSession, saveSession, clearSession, type Me } from './lib';

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

type Counts = Partial<Record<TabKey, number>>;

const TABS: { key: TabKey; label: string; partnerLabel?: string; superOnly?: boolean; sepAfter?: boolean }[] = [
  { key: 'today',    label: 'Сегодня', sepAfter: true },
  { key: 'clients',  label: 'Клиенты',  partnerLabel: 'Мои клиенты' },
  { key: 'money',    label: 'Деньги',   partnerLabel: 'Оплаты' },
  { key: 'requests', label: 'Заявки',   partnerLabel: 'Мои заявки' },
  { key: 'funnel',   label: 'Воронка', sepAfter: true },
  { key: 'partners', label: 'Партнёры', superOnly: true },
  { key: 'summary',  label: 'Сводка',   superOnly: true },
  { key: 'journal',  label: 'Журнал',   partnerLabel: 'Мои события' },
];

export default function PlatformPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<TabKey>('today');
  const [ready, setReady] = useState(false);
  const [counts, setCounts] = useState<Counts>({});

  useEffect(() => {
    const s = readSession();
    if (s) setMe(s.user);
    setReady(true);
  }, []);

  // Счётчики: сколько дел ждёт в каждом разделе. Одним запросом при
  // входе и после действий — иначе восемь запросов ради восьми цифр.
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

  if (!ready) return <BaseStyles />;
  if (!me) return <Login onIn={setMe} />;

  const tabs = TABS.filter((t) => !(t.superOnly && me.role === 'partner'));
  const label = (t: typeof TABS[number]) =>
    me.role === 'partner' && t.partnerLabel ? t.partnerLabel : t.label;

  const initials = me.name.split(' ').filter(Boolean).slice(0, 2)
    .map((w) => w[0]).join('').toUpperCase();

  return (
    <>
      <BaseStyles />
      <style>{SHELL_CSS}</style>

      <div className="pl-shell">
        {/* ── МЕНЮ СЛЕВА ── */}
        <aside className="pl-side">
          <div className="pl-brand">
            <b>Табыс</b>
            <span>платформа</span>
          </div>

          <nav className="pl-nav">
            {tabs.map((t) => (
              <div key={t.key}>
                <button className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
                  <span>{label(t)}</span>
                  {/* Счётчик — единственная причина открыть раздел
                      прямо сейчас. Ноль не рисуем. */}
                  {counts[t.key] ? <span className="pl-count">{counts[t.key]}</span> : null}
                </button>
                {t.sepAfter && <div className="pl-sep" />}
              </div>
            ))}
          </nav>

          <div className="pl-foot">
            <div className="pl-me">
              <span className="pl-ava">{initials}</span>
              <span className="pl-me-text">
                <b>{me.name}</b>
                <span>{me.role === 'super' ? 'владелец платформы' : 'партнёр'}</span>
              </span>
            </div>
            <button className="pl-out" onClick={() => { clearSession(); setMe(null); }}>
              Выйти
            </button>
          </div>
        </aside>

        {/* ── ПОЛЕ СПРАВА ── */}
        <main className="pl-main">
          <h1 className="pl-h1">{label(tabs.find((t) => t.key === tab)!)}</h1>
          {tab === 'today'    && <Today me={me} goTo={setTab} />}
          {tab === 'clients'  && <Clients me={me} />}
          {tab === 'money'    && <Money me={me} />}
          {tab === 'requests' && <Requests me={me} />}
          {tab === 'funnel'   && <Funnel me={me} />}
          {tab === 'partners' && <Partners me={me} />}
          {tab === 'summary'  && <Summary me={me} />}
          {tab === 'journal'  && <Journal me={me} />}
        </main>

        {/* ── ПОЛОСА СНИЗУ НА ТЕЛЕФОНЕ ── */}
        <nav className="pl-tabbar">
          {tabs.slice(0, 5).map((t) => (
            <button key={t.key} className={tab === t.key ? 'on' : ''}
              onClick={() => setTab(t.key)}>
              <span>{label(t)}</span>
              {counts[t.key] ? <span className="pl-count">{counts[t.key]}</span> : null}
            </button>
          ))}
        </nav>
      </div>
    </>
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
    <>
      <BaseStyles />
      <style>{SHELL_CSS}</style>
      <div className="pl-login">
        <div className="pl-login-card">
          <div className="pl-login-brand">Табыс <span>платформа</span></div>
          <p>Вход для владельца сервиса и партнёров. Кабинет магазина — по другому адресу.</p>
          <label>Почта</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)}
            type="email" autoComplete="username" placeholder="you@tabys.kz" />
          <label>Пароль</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)}
            type="password" autoComplete="current-password"
            onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
          {err && <div className="pl-err">{err}</div>}
          <button className="pl-primary" onClick={go} disabled={busy}>
            {busy ? 'Проверяем…' : 'Войти'}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Стили оболочки. Списаны с кабинета соседнего проекта до мелочей:
 * ширина меню 246, отступы, скругления, размеры шрифта.
 */
const SHELL_CSS = `
.pl-shell { min-height: 100vh; display: flex; background: ${P.bg}; }

.pl-side {
  width: ${P.sideW}px; flex: 0 0 ${P.sideW}px;
  background: ${P.navBg}; color: ${P.navInk};
  display: flex; flex-direction: column;
  position: sticky; top: 0; height: 100vh;
}
.pl-brand { padding: 20px 18px 14px; display: flex; flex-direction: column; gap: 2px; }
.pl-brand b { font-size: 16px; font-weight: 600; letter-spacing: -.01em;
  font-family: ${P.display}; }
.pl-brand span { font-size: 12px; color: ${P.navDim}; }

.pl-nav { display: flex; flex-direction: column; gap: 2px; padding: 6px 10px;
  flex: 1; overflow: auto; }
.pl-nav button {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  background: none; border: 0; color: ${P.navDim}; cursor: pointer;
  min-height: 38px; padding: 0 12px; border-radius: 8px; font-size: 14px;
  transition: background .12s ease, color .12s ease;
}
.pl-nav button span:first-child { flex: 1; }
.pl-nav button:hover { background: ${P.navHover}; color: ${P.navInk}; }
.pl-nav button.on { background: ${P.navOn}; color: ${P.navOnInk}; font-weight: 500; }
.pl-sep { height: 1px; background: ${P.navLine}; margin: 10px 12px; }

.pl-count {
  background: ${P.accent}; color: #1d1405;
  border-radius: 999px; min-width: 20px; height: 20px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0 6px; font-size: 12px; font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.pl-foot { border-top: 1px solid ${P.navLine}; padding: 14px;
  display: flex; flex-direction: column; gap: 12px; }
.pl-me { display: flex; align-items: center; gap: 10px; }
.pl-ava {
  width: 32px; height: 32px; border-radius: 999px; flex: 0 0 32px;
  background: ${P.navOn}; color: ${P.navOnInk};
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700;
}
.pl-me-text { min-width: 0; display: flex; flex-direction: column; }
.pl-me-text b { font-size: 13px; font-weight: 500; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.pl-me-text span { font-size: 12px; color: ${P.navDim}; }
.pl-out {
  background: none; border: 1px solid ${P.navLine}; color: ${P.navDim};
  min-height: 36px; border-radius: 8px; font-size: 13px; cursor: pointer;
}
.pl-out:hover { background: ${P.navHover}; color: ${P.navInk}; }

.pl-main { flex: 1; min-width: 0; padding: 22px 24px 60px; max-width: 1100px; }
.pl-h1 { font-family: ${P.display}; font-weight: 400; font-size: 26px;
  color: ${P.ink}; margin: 0 0 16px; letter-spacing: -.01em; }

.pl-tabbar { display: none; }

/* ── Телефон: меню уезжает вниз полосой ── */
@media (max-width: 860px) {
  .pl-side { display: none; }
  .pl-main { padding: 16px 14px 84px; }
  .pl-tabbar {
    display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
    background: ${P.navBg}; border-top: 1px solid ${P.navLine};
    padding: 6px 4px calc(6px + env(safe-area-inset-bottom));
  }
  .pl-tabbar button {
    flex: 1; min-height: 48px; background: none; border: 0; cursor: pointer;
    color: ${P.navDim}; font-size: 12px; border-radius: 8px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  }
  .pl-tabbar button.on { color: ${P.navOnInk}; background: ${P.navOn}; }
}

/* ── Вход ── */
.pl-login { min-height: 100vh; background: ${P.navBg};
  display: grid; place-items: center; padding: 16px; }
.pl-login-card { background: ${P.card}; border-radius: 16px; padding: 26px;
  width: 100%; max-width: 380px; box-shadow: 0 20px 60px rgba(0,0,0,.3); }
.pl-login-brand { font-family: ${P.display}; font-size: 24px; color: ${P.ink};
  margin-bottom: 4px; }
.pl-login-brand span { color: ${P.accentSoft}; }
.pl-login-card p { font-size: 13.5px; color: ${P.dim}; margin: 0 0 18px; line-height: 1.45; }
.pl-login-card label { display: block; font-size: 13px; color: ${P.dim};
  margin: 12px 0 4px; }
.pl-login-card input {
  width: 100%; min-height: 44px; padding: 0 12px; font-size: 16px;
  border: 1px solid ${P.line}; border-radius: 10px; background: ${P.card};
  color: ${P.ink}; box-sizing: border-box;
}
.pl-login-card input:focus { outline: 2px solid ${P.accent}; outline-offset: -1px; }
.pl-err { color: ${P.danger}; font-size: 13.5px; margin-top: 10px; }
.pl-primary {
  width: 100%; min-height: 46px; margin-top: 18px; border: 0; border-radius: 10px;
  background: ${P.accent}; color: ${P.accentInk}; font-size: 16px; font-weight: 600;
  cursor: pointer;
}
.pl-primary:hover { background: ${P.accentDark}; }
.pl-primary:disabled { opacity: .6; cursor: default; }
`;
