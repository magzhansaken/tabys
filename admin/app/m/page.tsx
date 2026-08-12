'use client';
/**
 * Мобильный кабинет владельца (часть 28) — PWA, без установки из сторов.
 *
 * Модель: у всех троих есть приложение, у нас был только десктоп. Владелец
 * хочет с телефона видеть «как идут дела и какие точки открыты» (МойСклад:
 * «следите, какие точки открылись»; Wipon: аналитика в реальном времени).
 *
 * Делаем PWA, а не нативное приложение: устанавливается «на экран» одним
 * тапом, обновляется мгновенно (без ревью в сторах), работает и на iOS, и на
 * Android из одного кода. Для дашборда владельца этого более чем достаточно.
 */
import { useEffect, useState, useCallback } from 'react';
import { api, tokens, login as apiLogin } from '../../lib/api';

const money = (v: number) => (v ?? 0).toLocaleString('ru-RU') + ' ₸';
const GREEN = '#0a7b5f';

export default function MobileDashboard() {
  const [snap, setSnap] = useState<any>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [needLogin, setNeedLogin] = useState(false);
  const [creds, setCreds] = useState({ phone: '', password: '' });

  const load = useCallback(async () => {
    setErr('');
    try {
      setSnap(await api('/reports/mobile/snapshot'));
      setNeedLogin(false);
    } catch (e: any) {
      if (/401|Unauthorized|токен|Нужен/i.test(e.message)) setNeedLogin(true);
      else setErr(e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    // регистрируем service worker (офлайн-оболочка)
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (!tokens.access) { setNeedLogin(true); setLoading(false); return; }
    load();
    const t = setInterval(load, 30000); // обновление в реальном времени (модель Wipon)
    return () => clearInterval(t);
  }, [load]);

  const login = async () => {
    setErr('');
    try {
      await apiLogin(creds.phone, creds.password);
      setNeedLogin(false); setLoading(true); load();
    } catch (e: any) { setErr(e.message); }
  };

  if (needLogin) {
    return (
      <Shell>
        <h1 style={{ fontSize: 20, marginTop: 8 }}>Вход в кабинет</h1>
        <p style={{ color: '#6b7280', fontSize: 14 }}>Телефон и пароль владельца или администратора.</p>
        <input value={creds.phone} onChange={(e) => setCreds({ ...creds, phone: e.target.value })}
          placeholder="+7 700 000 00 00" inputMode="tel" style={inp} />
        <input value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })}
          placeholder="Пароль" type="password" style={inp} />
        {err && <p style={{ color: '#c0392b', fontSize: 14 }}>{err}</p>}
        <button onClick={login} style={btn}>Войти</button>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20, margin: '8px 0' }}>Сегодня</h1>
        <button onClick={load} style={{ ...ghost, padding: '6px 10px' }} aria-label="Обновить">↻</button>
      </div>
      {loading && !snap ? <p style={{ color: '#6b7280' }}>Загрузка…</p> : null}
      {err && <p style={{ color: '#c0392b', fontSize: 14 }}>{err}</p>}

      {snap && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 6 }}>
            <Stat label="Выручка" value={money(snap.today.revenue)} big />
            <Stat label="Прибыль" value={money(snap.today.profit)} />
            <Stat label="Чеков" value={String(snap.today.receipts)} />
            <Stat label="Средний чек" value={money(snap.today.avgReceipt)} />
          </div>

          {snap.today.refunds?.count > 0 && (
            <div style={{ marginTop: 10, padding: 12, background: '#fdecea', borderRadius: 12, fontSize: 14, color: '#8a2a1e' }}>
              Возвраты сегодня: {money(snap.today.refunds.sum)} ({snap.today.refunds.count})
            </div>
          )}

          <h2 style={{ fontSize: 16, margin: '20px 0 8px' }}>
            Открытые точки {snap.openStoresCount > 0 && <span style={{ color: GREEN }}>· {snap.openStoresCount}</span>}
          </h2>
          {snap.openShifts.length === 0
            ? <p style={{ color: '#6b7280', fontSize: 14 }}>Сейчас нет открытых смен — все кассы закрыты.</p>
            : snap.openShifts.map((s: any) => (
              <div key={s.id} style={{ padding: 12, background: '#fff', borderRadius: 12, marginBottom: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <b style={{ fontSize: 15 }}>{s.store ?? 'Точка'}</b>
                  <span style={{ color: GREEN, fontWeight: 600 }}>{money(s.revenue)}</span>
                </div>
                <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
                  {s.register} · {s.cashier} · {s.receipts} чек(ов) · с {new Date(s.openedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            ))}
          <p style={{ textAlign: 'center', color: '#9ca3af', fontSize: 12, marginTop: 20 }}>
            Обновляется автоматически каждые 30 секунд
          </p>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 480, margin: '0 auto', minHeight: '100vh', background: '#f5f6f8' }}>
      <div style={{ background: GREEN, color: '#fff', padding: '14px 16px', fontWeight: 700, fontSize: 17 }}>
        Мой магазин
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div style={{ padding: 14, background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
      gridColumn: big ? 'span 2' : undefined }}>
      <div style={{ fontSize: 12, color: '#6b7280' }}>{label}</div>
      <div style={{ fontSize: big ? 26 : 19, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );
}

const inp: any = { width: '100%', padding: 12, marginTop: 10, border: '1px solid #e7e9ee', borderRadius: 10, fontSize: 16, boxSizing: 'border-box' };
const btn: any = { width: '100%', padding: 13, marginTop: 14, background: GREEN, color: '#fff', border: 0, borderRadius: 10, fontSize: 16, fontWeight: 600 };
const ghost: any = { background: '#fff', border: '1px solid #e7e9ee', borderRadius: 10, fontSize: 18 };
