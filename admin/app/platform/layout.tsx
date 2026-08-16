'use client';
/**
 * Каркас кабинета платформы.
 *
 * Здесь другой человек, чем в кабинете магазина: он смотрит не на свои
 * продажи, а на чужие — как на признак, живёт ли клиент. Поэтому и
 * разделов пять, а не двадцать один, и меню плоское: искать по группам
 * тут нечего.
 *
 * ЧТО ВИДИТ ПАРТНЁР. Разделы владельца ему не рисуются вовсе — не
 * прячутся серым и не отвечают «нельзя». Кнопка, которая ответит
 * «нельзя», не нужна: она только заставляет объяснять.
 *
 * СЧЁТЧИК ЖДУЩИХ ОПЛАТ рисуется только когда он больше нуля. Кружок с
 * нулём обучает себя игнорировать, и однажды его перестанут замечать с
 * тройкой внутри.
 */
import React, { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { C, Btn } from '../../lib/ui';
import { papi, session, PlatformUser } from './lib';

const NAV: { href: string; label: string; superOnly?: boolean }[] = [
  { href: '/platform', label: 'Клиенты' },
  { href: '/platform/payments', label: 'Оплаты' },
  { href: '/platform/partners', label: 'Партнёры', superOnly: true },
  { href: '/platform/funnel', label: 'Воронка' },
  { href: '/platform/audit', label: 'Журнал решений', superOnly: true },
];

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === '/platform/login';

  const [user, setUser] = useState<PlatformUser | null>(null);
  const [pending, setPending] = useState(0);
  const [wide, setWide] = useState(true);
  const [drawer, setDrawer] = useState(false);

  // Ключ читаем ПОСЛЕ появления страницы: обращение к хранилищу во время
  // сборки роняет кабинет.
  useEffect(() => {
    if (isLogin) return;
    const u = session.user();
    if (!session.token() || !u) { router.replace('/platform/login'); return; }
    setUser(u);
  }, [isLogin, pathname, router]);

  useEffect(() => {
    const m = window.matchMedia('(min-width: 900px)');
    const on = () => setWide(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);

  // Сводка нужна каркасу ровно за одним числом — сколько оплат ждут
  // решения. Ошибку здесь не показываем: у страницы есть своя.
  useEffect(() => {
    if (isLogin || !user) return;
    let alive = true;
    papi('/platform/summary')
      .then((s) => { if (alive) setPending(Number(s?.pendingPayments ?? 0)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isLogin, user, pathname]);

  useEffect(() => { setDrawer(false); }, [pathname]);

  if (isLogin) return <>{children}</>;

  const items = NAV.filter((n) => !n.superOnly || user?.role === 'super');
  const active = (href: string) =>
    href === '/platform' ? pathname === '/platform' : pathname.startsWith(href);

  const go = (href: string) => { setDrawer(false); router.push(href); };
  const out = () => { session.clear(); router.replace('/platform/login'); };

  const navBtn = (n: { href: string; label: string }, big?: boolean) => {
    const on = active(n.href);
    return (
      <button key={n.href} onClick={() => go(n.href)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          minHeight: big ? 48 : 40, padding: big ? '0 12px' : '0 10px', border: 0,
          borderRadius: big ? 10 : 8, cursor: 'pointer', fontSize: big ? 15 : 14,
          background: on ? '#E8F1EC' : 'transparent',
          color: on ? C.accentDark : C.prose, fontWeight: on ? 500 : 400,
        }}>
        <span style={{ flex: 1 }}>{n.label}</span>
        {n.href === '/platform/payments' && pending > 0 && (
          <span style={{
            background: '#F7EFDF', color: C.amber, borderRadius: 999, fontSize: 12.5,
            fontWeight: 500, padding: '2px 8px', fontVariantNumeric: 'tabular-nums',
          }}>{pending}</span>
        )}
      </button>
    );
  };

  const who = (
    <div>
      <div style={{ fontSize: 13.5, fontWeight: 500 }}>{user?.name ?? '—'}</div>
      <div style={{ fontSize: 12.5, color: C.dim, marginTop: 2 }}>{user?.email ?? ''}</div>
      <div style={{ fontSize: 12.5, color: C.faint, marginTop: 3 }}>
        {user?.role === 'super' ? 'владелец сервиса' : 'партнёр'}
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', minHeight: '100vh', background: C.bg }}>
      {wide && (
        <aside data-no-print="" style={{
          flex: '0 0 240px', width: 240, position: 'sticky', top: 0, height: '100vh',
          background: C.card, borderRight: `1px solid ${C.line}`, display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '17px 16px 15px', borderBottom: `1px solid ${C.lineIn}` }}>
            <div style={{
              width: 30, height: 30, borderRadius: 8, background: C.accent, color: '#fff',
              fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
            }}>Т</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.2 }}>Табыс</div>
              <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.35 }}>платформа</div>
            </div>
          </div>
          <nav style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {items.map((n) => navBtn(n))}
          </nav>
          <div style={{ borderTop: `1px solid ${C.lineIn}`, padding: '13px 14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {who}
            <Btn kind="ghost" onClick={out} style={{ color: C.dim }}>Выйти</Btn>
          </div>
        </aside>
      )}

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {!wide && (
          <header data-no-print="" style={{
            position: 'sticky', top: 0, zIndex: 30, background: C.card,
            borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px',
          }}>
            <div style={{
              width: 28, height: 28, flex: '0 0 28px', borderRadius: 8, background: C.accent, color: '#fff',
              fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
            }}>Т</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {items.find((n) => active(n.href))?.label ?? 'Платформа'}
              </div>
              <div style={{ fontSize: 12, color: C.dim, lineHeight: 1.3 }}>
                {user?.role === 'super' ? 'владелец сервиса' : 'партнёр'}
              </div>
            </div>
            <Btn kind="ghost" onClick={() => setDrawer(true)}>
              Разделы{pending > 0 ? ` · ${pending}` : ''}
            </Btn>
          </header>
        )}

        <main style={{ padding: wide ? '26px 30px 70px' : '16px 14px 70px', width: '100%', maxWidth: 1320, margin: '0 auto' }}>
          {user ? children : (
            <div style={{ color: C.dim, fontSize: 14, padding: '40px 0' }}>Проверяем вход…</div>
          )}
        </main>
      </div>

      {/* Меню на телефоне — лист снизу во всю ширину: выпадашка у края
          уезжает за границу экрана вместе с половиной разделов. */}
      {!wide && drawer && (
        <>
          <div onClick={() => setDrawer(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(23,33,29,.42)', zIndex: 40 }} />
          <div style={{
            position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 41, background: C.card,
            borderRadius: '16px 16px 0 0', padding: '14px 14px 20px', maxHeight: '82vh', overflowY: 'auto',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {items.map((n) => navBtn(n, true))}
            </div>
            <div style={{ borderTop: `1px solid ${C.lineIn}`, marginTop: 12, paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {who}
              <Btn kind="ghost" onClick={out} style={{ color: C.dim }}>Выйти</Btn>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
