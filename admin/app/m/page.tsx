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
 *
 * ЭКРАН СОБРАН ПОД ДВАДЦАТЬ СЕКУНД. Владелец открывает телефон между делами:
 * сколько наторговали, что закончилось, что горит. Всё остальное — на
 * компьютере. Поэтому порядок блоков не «по важности разделов», а по тому,
 * на что смотрят первым.
 *
 * Один запрос /reports/mobile вместо трёх: в областях связь медленная, и
 * два ожидания вместо одного заметны на телефоне.
 */
import { useEffect, useState, useCallback } from 'react';
import { api, tokens, login as apiLogin } from '../../lib/api';
import { C, money, num } from '../../lib/ui';

export default function MobileDashboard() {
  const [snap, setSnap] = useState<any>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [needLogin, setNeedLogin] = useState(false);
  const [creds, setCreds] = useState({ phone: '', password: '' });
  const [at, setAt] = useState<string>('');

  const load = useCallback(async () => {
    setErr('');
    try {
      setSnap(await api('/reports/mobile'));
      setAt(new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
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
        <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-.015em', margin: '4px 0 0' }}>Вход в кабинет</h1>
        <p style={{ color: C.dim, fontSize: 14.5, lineHeight: 1.55, margin: '8px 0 24px' }}>
          Номер телефона и пароль владельца или администратора.
        </p>
        <label style={lbl}>Номер телефона
          <input value={creds.phone} onChange={(e) => setCreds({ ...creds, phone: e.target.value })}
            placeholder="+7 700 000 00 00" inputMode="tel" autoComplete="tel" style={{ ...inp, fontFamily: 'var(--font-mono), monospace', letterSpacing: '.02em' }} />
        </label>
        <label style={{ ...lbl, marginTop: 16 }}>Пароль
          <input value={creds.password} onChange={(e) => setCreds({ ...creds, password: e.target.value })}
            placeholder="" type="password" autoComplete="current-password"
            onKeyDown={(e) => e.key === 'Enter' && login()} style={inp} />
        </label>
        {err && <p style={{ color: C.red, fontSize: 13.5, lineHeight: 1.5, margin: '12px 0 0' }}>{err}</p>}
        <button onClick={login} style={btn}>Войти</button>
      </Shell>
    );
  }

  const t = snap?.today;
  const delta = snap?.vsYesterday?.deltaPercent;
  const low = snap?.lowStock;

  return (
    <Shell subtitle={at ? `Сегодня · обновлено ${at}` : 'Сегодня'} onRefresh={load}>
      {loading && !snap ? <p style={{ color: C.dim, fontSize: 14.5 }}>Загрузка…</p> : null}
      {err && <p style={{ color: C.red, fontSize: 13.5, lineHeight: 1.5 }}>{err}</p>}

      {snap && (
        <>
          {/* Выручка крупно и сразу со сравнением: «84 300 ₸» само по себе
              ничего не говорит, а «↑ 9,2% ко вчера» — уже ответ. */}
          <div style={card}>
            <div style={{ fontSize: 12.5, color: C.dim }}>Выручка</div>
            <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: '-.02em', lineHeight: 1.1,
              marginTop: 4, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {money(t.revenue)}
            </div>
            <div style={{ fontSize: 13.5, marginTop: 6, lineHeight: 1.5 }}>
              {delta == null
                ? <span style={{ color: C.dim }}>вчера продаж не было — сравнивать не с чем</span>
                : <>
                    <span style={{ color: delta >= 0 ? C.accentDark : C.red, fontWeight: 500 }}>
                      {delta >= 0 ? '↑' : '↓'} {Math.abs(delta)}%
                    </span>
                    <span style={{ color: C.dim }}> ко вчера · было {money(snap.vsYesterday.revenue)}</span>
                  </>}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
            <Stat label="Прибыль" value={money(t.grossProfit)}
              sub={t.marginPercent != null ? `наценка ${num(t.marginPercent)}%` : undefined} />
            <Stat label="Чеков" value={String(t.receipts)} />
            <Stat label="Средний чек" value={money(t.avgReceipt)} />
            <Stat label="Деньги на счетах" value={money(snap.money?.total)}
              tone={Number(snap.money?.total) < 0 ? 'bad' : undefined} />
          </div>

          {/* Что закончилось — второе, ради чего открывают телефон:
              по этим позициям продажи уже потеряны, а не под угрозой. */}
          {low && low.total > 0 && (
            <div style={{ ...card, marginTop: 10,
              borderColor: low.outCount > 0 ? '#E6C7C0' : '#E8DCC3',
              background: low.outCount > 0 ? '#FFFBFA' : '#FFFCF6' }}>
              <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase',
                color: low.outCount > 0 ? C.red : C.amber }}>
                {low.outCount > 0 ? `Закончились совсем · ${low.outCount}` : 'Заканчиваются'}
              </div>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {low.items.map((i: any) => (
                  <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 14.5, lineHeight: 1.4 }}>{i.name}</span>
                    <span style={{ fontSize: 13.5, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
                      color: i.out ? C.red : C.amber, fontWeight: 600 }}>
                      {i.out ? 'нет' : `${num(i.qty)} из ${num(i.minStock)}`}
                    </span>
                  </div>
                ))}
              </div>
              {low.total > low.items.length && (
                <div style={{ fontSize: 13, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>
                  Показаны 5 самых острых из {low.total}. Полный список — на компьютере.
                </div>
              )}
            </div>
          )}

          {/* Проблемы: пусто — значит всё спокойно, и блока просто нет. */}
          {snap.problems?.length > 0 && (
            <div style={{ ...card, marginTop: 10, borderColor: '#E6C7C0', background: '#FFFBFA' }}>
              <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase', color: C.red }}>
                Требует внимания
              </div>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {snap.problems.map((p: string, i: number) => (
                  <div key={i} style={{ fontSize: 14, lineHeight: 1.5, color: C.prose }}>{p}</div>
                ))}
              </div>
            </div>
          )}

          <SectionTitle>Топ товаров сегодня</SectionTitle>
          {(snap.topProducts ?? []).length === 0 ? (
            <div style={{ ...card, color: C.dim, fontSize: 14, lineHeight: 1.5 }}>
              Сегодня ещё ничего не продали.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {snap.topProducts.map((p: any, i: number) => (
                <div key={i} style={card}>
                  <div style={{ fontSize: 14.5, lineHeight: 1.4, textWrap: 'pretty' } as any}>{p.name}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 13, color: C.dim, gap: 12 }}>
                    <span>{num(p.qty)}</span>
                    <span style={{ fontWeight: 600, color: C.text, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                      {money(p.revenue)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <p style={{ textAlign: 'center', color: C.faint, fontSize: 12.5, margin: '20px 0 8px' }}>
            Обновляется автоматически каждые 30 секунд
          </p>
        </>
      )}
    </Shell>
  );
}

function Shell({ children, subtitle, onRefresh }: { children: React.ReactNode; subtitle?: string; onRefresh?: () => void }) {
  return (
    <div style={{ maxWidth: 480, margin: '0 auto', minHeight: '100vh', background: C.bg }}>
      <div style={{ background: C.accent, color: '#fff', padding: '14px 16px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 12, letterSpacing: '.14em', opacity: .8 }}>ТАБЫС</div>
          {onRefresh && (
            <button onClick={onRefresh} aria-label="Обновить"
              style={{ minWidth: 44, minHeight: 44, background: 'transparent', border: 0, color: '#fff',
                fontSize: 18, opacity: .85, cursor: 'pointer' }}>↻</button>
          )}
        </div>
        <div style={{ fontSize: 17, fontWeight: 600, marginTop: 2 }}>Мой магазин</div>
        {subtitle && <div style={{ fontSize: 13, opacity: .8, marginTop: 2 }}>{subtitle}</div>}
      </div>
      <div style={{ padding: 14 }}>{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase',
      color: C.faint, margin: '20px 0 8px' }}>{children}</div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 12.5, color: C.dim }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 600, marginTop: 3, whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums', color: tone === 'bad' ? C.red : C.text }}>{value}</div>
      {sub && <div style={{ fontSize: 12.5, color: C.dim, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

const card: any = { padding: '16px 18px', background: C.card, border: `1px solid ${C.line}`, borderRadius: 12 };
const lbl: any = { display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, color: C.dim };
// 16 px и 52 px — не украшение: меньший шрифт заставляет iOS увеличивать
// страницу при касании, а поле ниже 44 px не попадает под палец.
const inp: any = { width: '100%', height: 52, padding: '0 14px', border: `1px solid #D8D8CF`,
  borderRadius: 10, fontSize: 16, color: C.text, background: C.card, boxSizing: 'border-box', outline: 'none' };
const btn: any = { width: '100%', minHeight: 54, marginTop: 18, background: C.accent, color: '#fff',
  border: 0, borderRadius: 10, fontSize: 16.5, fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer' };
