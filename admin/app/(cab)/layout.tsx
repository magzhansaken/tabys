'use client';
/**
 * Каркас кабинета. МЕНЮ СЛЕВА, НО НЕ КАК БЫЛО.
 *
 * Было: постоянные 252 px под список из 21 пункта. На ноутбуке 1366 это
 * шестая часть экрана, отданная навигации, которой пользуются раз в пять
 * минут.
 *
 * Стало: рельс 68 px. В нём шесть групп, а не 22 раздела — двадцать две
 * иконки в столбик читать невозможно, и рисованные значки «Товар» и
 * «Клиенты» через месяц путаются, поэтому знак группы — две буквы
 * моноширинным. Нажатие на знак выкидывает панель с разделами группы:
 * любой из 22 в два касания. Рельс разворачивается до 240 px с
 * подписями, и выбор запоминается — владелец, который заходит редко,
 * держит его развёрнутым, тот, кто работает каждый день, свернёт.
 *
 * Содержимое — колонка 1180 px ПО ЦЕНТРУ остатка. Раньше оно липло к
 * левому краю, а справа висела пустота: на широком экране кабинет
 * выглядел съехавшим.
 *
 * Второй строки шапки больше нет: меню слева и так показывает, где вы.
 * Крошки уехали в шапку, недавние разделы — в окно поиска.
 *
 * ЧТО ЕЩЁ ЗДЕСЬ ЕСТЬ, ЧЕГО НЕ БЫЛО У НАС
 *   · глобальный поиск по Ctrl+K — по разделам и по товарам;
 *   · «Важное» с числом — один ответ /admin/alerts, шесть сигналов;
 *   · хлебные крошки: группа / раздел;
 *   · избранное: до пяти закреплённых разделов над группами;
 *   · недавние разделы в пустом поиске;
 *   · горячие клавиши: Ctrl+K, 1…6, [, ?, Esc — только те, что работают.
 *
 * ГРАНИЦЫ
 *   · обращения к серверу: /auth/me, /billing/access, /admin/sync/readiness
 *     и /admin/alerts — сводный, ровно один вместо шести;
 *     поиск товаров ходит в существующий /goods?q= (тот же, что «Склад»)
 *     от двух знаков и с задержкой; выключается строкой SEARCH_GOODS;
 *   · localStorage — только внутри useEffect;
 *   · <form> нет, обработчики на кнопках;
 *   · имена полей данных прежние; у /admin/alerts читаются те, что он
 *     отдаёт: kind, tone, title, sub, href;
 *   · адреса разделов латиницей и прежние.
 *
 * ТЕЛЕФОН. Меню — выезжающая панель теми же группами, «Важное» и
 * горячие клавиши — листы снизу, поиск — на весь экран. Цели 44 px,
 * поля 16 px, длинные названия рвутся по словам, суммы не рвутся никогда.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api, tokens } from '../../lib/api';
import { C, Badge, MONO } from '../../lib/ui';

/** Поиск по товарам через существующий /goods?q=. Если шапке ходить за
 *  товарами не нужно — false, останется поиск по разделам. */
const SEARCH_GOODS = true;

const RAIL_KEY = 'cab:rail';
const FAV_KEY = 'cab:favs';
const RECENT_KEY = 'cab:recent';

/** Шесть групп. short — знак в свёрнутом рельсе. */
const NAV: { key: string; label: string; short: string; note: string; items: [string, string][] }[] = [
  {
    key: 'dash', label: 'Показатели', short: 'Пк',
    note: 'Сводка дня: выручка, прибыль, чеки, что закончилось.',
    items: [['/dashboard', 'Показатели']],
  },
  {
    key: 'money', label: 'Деньги', short: 'Дн',
    note: 'Деньги, которые пришли и ушли. Подписка здесь: её смотрят каждый месяц.',
    items: [
      ['/reports', 'Отчёты'],
      ['/finance', 'Финансы'],
      ['/taxes', 'Налоги'],
      ['/payroll', 'Зарплата'],
      ['/billing', 'Подписка'],
    ],
  },
  {
    key: 'goods', label: 'Товар', short: 'Тв',
    note: 'Всё, что лежит на полке и на складе. Приёмка — самое частое действие.',
    items: [
      ['/goods', 'Товары'],
      ['/stock', 'Склад'],
      ['/techcards', 'Техкарты'],
      ['/marking', 'Маркировка'],
      ['/excise', 'Акциз (алкоголь)'],
    ],
  },
  {
    key: 'clients', label: 'Клиенты', short: 'Кл',
    note: 'Кому продаём и кто должен. Долги поставщикам — в контрагентах.',
    items: [
      ['/contragents', 'Контрагенты'],
      ['/loyalty', 'Лояльность'],
      ['/certificates', 'Сертификаты'],
      ['/rfm', 'RFM-анализ'],
      ['/wholesale', 'Опт'],
    ],
  },
  {
    key: 'channels', label: 'Каналы', short: 'Кн',
    note: 'Продажи вне кассы и помощники. AI-помощника нет у конкурентов.',
    items: [
      ['/marketplace', 'Kaspi магазин'],
      ['/ai', 'AI-помощник'],
      ['/automation', 'Автоматизация'],
    ],
  },
  {
    key: 'manage', label: 'Управление', short: 'Уп',
    note: 'Настраивают один раз при запуске и потом почти не заходят.',
    items: [
      ['/employees', 'Сотрудники'],
      ['/stores', 'Точки и кассы'],
      ['/settings', 'Настройки'],
    ],
  },
];

const FLAT: [string, string][] = NAV.reduce<[string, string][]>((a, g) => a.concat(g.items), []);
const GROUP_OF: Record<string, string> = {};
const GROUP_KEY: Record<string, string> = {};
NAV.forEach((g) => g.items.forEach(([href]) => { GROUP_OF[href] = g.label; GROUP_KEY[href] = g.key; }));

export default function CabLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [me, setMe] = useState<any>(null);
  const [access, setAccess] = useState<any>(null);
  const [sync, setSync] = useState<any>(null);
  const [important, setImportant] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [narrow, setNarrow] = useState(false);

  const [wide, setWide] = useState(false);   // рельс с подписями
  const [fly, setFly] = useState('');        // всплывающая панель группы (свёрнутый рельс)
  const [acc, setAcc] = useState('');        // раскрытая группа (развёрнутый рельс)
  const [drawer, setDrawer] = useState(false);
  const [alerts, setAlerts] = useState(false);
  const [help, setHelp] = useState(false);
  const [find, setFind] = useState(false);
  const [q, setQ] = useState('');
  const [goods, setGoods] = useState<any[]>([]);
  const [favs, setFavs] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const qRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setMe(await api('/auth/me'));
        api('/billing/access').then(setAccess).catch(() => {});
        api('/admin/sync/readiness').then(setSync).catch(() => {});
        // Один сводный ответ вместо шести запросов из шапки.
        api('/admin/alerts').then((r: any) => setImportant(Array.isArray(r) ? r : [])).catch(() => {});
      } catch (e: any) { setErr(e.message); }
    })();
  }, []);

  // Ширину экрана узнаём после появления страницы: на сервере её нет,
  // а расхождение разметки ломает разбор.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Хранилище — только здесь.
  useEffect(() => {
    try {
      setWide(window.localStorage.getItem(RAIL_KEY) === 'full');
      const f = window.localStorage.getItem(FAV_KEY);
      if (f) setFavs(JSON.parse(f));
      const r = window.localStorage.getItem(RECENT_KEY);
      if (r) setRecent(JSON.parse(r));
    } catch { /* хранилище недоступно — рельс свёрнут, избранного нет */ }
  }, []);

  const current = FLAT.find(([href]) => path?.startsWith(href));

  useEffect(() => {
    if (!current) return;
    setRecent((prev) => {
      const next = [current[0], ...prev.filter((h) => h !== current[0])].slice(0, 5);
      try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [current?.[0]]);

  useEffect(() => { setFly(''); setDrawer(false); setFind(false); setAlerts(false); }, [path]);

  const toggleRail = () => {
    const next = !wide;
    setWide(next); setFly('');
    try { window.localStorage.setItem(RAIL_KEY, next ? 'full' : 'icons'); } catch {}
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); setFind(true); setFly(''); setAlerts(false);
        return;
      }
      if (e.key === 'Escape') { setFind(false); setFly(''); setAlerts(false); setHelp(false); setDrawer(false); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?') { setHelp(true); return; }
      if (e.key === '[') { toggleRail(); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length) {
        const g = NAV[n - 1];
        if (g.items.length === 1) window.location.href = g.items[0][0];
        else if (wide) setAcc((cur) => (cur === g.key ? '' : g.key));
        else setFly((cur) => (cur === g.key ? '' : g.key));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [wide]);

  useEffect(() => {
    if (!find && !drawer) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [find, drawer]);

  useEffect(() => { if (find) qRef.current?.focus(); }, [find]);

  // Поиск товаров: существующий /goods?q=, от двух знаков, с задержкой.
  useEffect(() => {
    if (!SEARCH_GOODS || !find) return;
    const s = q.trim();
    if (s.length < 2) { setGoods([]); return; }
    const id = setTimeout(() => {
      api(`/goods?q=${encodeURIComponent(s)}&limit=8`)
        .then((r: any) => setGoods(Array.isArray(r) ? r : []))
        .catch(() => setGoods([]));   // нет права на товары — поиск по разделам
    }, 250);
    return () => clearTimeout(id);
  }, [q, find]);

  const sections = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [] as [string, string][];
    return FLAT.filter(([href, label]) =>
      (label + ' ' + (GROUP_OF[href] ?? '')).toLowerCase().includes(s));
  }, [q]);

  const toggleFav = (href: string) => {
    const next = favs.includes(href) ? favs.filter((h) => h !== href) : [...favs, href].slice(-5);
    setFavs(next);
    try { window.localStorage.setItem(FAV_KEY, JSON.stringify(next)); } catch {}
  };

  if (err) {
    return (
      <main style={{ maxWidth: 420, margin: '80px auto', textAlign: 'center', padding: '0 20px' }}>
        <p style={{ color: C.dim, fontSize: 15 }}>Сессия не активна.</p>
        <a href="/login" style={{ color: C.accentDark, fontSize: 15 }}>Войти в кабинет</a>
      </main>
    );
  }

  const label = (href: string) => FLAT.find(([h]) => h === href)?.[1] ?? href;
  const activeGroup = current ? GROUP_KEY[current[0]] : '';
  const bad = important.filter((a) => a.tone === 'bad').length;

  const searchIcon = (size: number, color: string) => (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ flex: `0 0 ${size}px` }}>
      <circle cx="6" cy="6" r="4.4" stroke={color} strokeWidth="1.4" />
      <path d="M9.4 9.4 L12.4 12.4" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );

  /* ── Телефон ──────────────────────────────────────────────────────── */

  if (narrow) {
    return (
      <div style={{ minHeight: '100dvh' }}>
        <header data-no-print="" style={{ position: 'sticky', top: 0, zIndex: 30, background: C.card,
          borderBottom: `1px solid ${C.line}`, height: 56, display: 'flex', alignItems: 'center',
          gap: 4, padding: '0 6px' }}>
          <button onClick={() => setDrawer(true)} aria-label="Разделы"
            style={{ flex: '0 0 44px', width: 44, height: 44, border: 0, background: 'transparent',
              cursor: 'pointer', display: 'flex', flexDirection: 'column', justifyContent: 'center',
              gap: 5, padding: '0 11px' }}>
            <span style={{ height: 1.5, background: C.text, borderRadius: 1 }} />
            <span style={{ height: 1.5, background: C.text, borderRadius: 1 }} />
            <span style={{ height: 1.5, background: C.text, borderRadius: 1 }} />
          </button>
          <div style={{ flex: 1, minWidth: 0, padding: '0 2px' }}>
            <div style={{ fontSize: 15.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {current?.[1] ?? 'Кабинет'}
            </div>
            <div style={{ fontSize: 12, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {me?.businessName ?? 'Магазин'}
            </div>
          </div>
          <button onClick={() => setFind(true)} aria-label="Поиск"
            style={{ flex: '0 0 44px', width: 44, height: 44, border: 0, background: 'transparent',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {searchIcon(17, C.prose)}
          </button>
          <button onClick={() => setAlerts(!alerts)} aria-label="Важное"
            style={{ flex: '0 0 44px', width: 44, height: 44, border: 0, background: 'transparent',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ minWidth: 24, height: 24, padding: '0 6px', borderRadius: 999,
              background: bad ? C.red : important.length ? C.amber : '#D3D3C9', color: '#fff',
              fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {important.length}
            </span>
          </button>
        </header>

        {alerts && (
          <>
            <div onClick={() => setAlerts(false)} style={{ position: 'fixed', inset: 0, zIndex: 42, background: 'rgba(23,33,29,.42)' }} />
            <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 43, maxHeight: '80vh',
              background: C.card, borderRadius: '18px 18px 0 0', overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 14px', borderBottom: `1px solid ${C.lineIn}` }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Требует внимания</div>
                <button onClick={() => setAlerts(false)} aria-label="Закрыть"
                  style={{ flex: '0 0 44px', width: 44, height: 44, border: 0, background: 'transparent',
                    color: C.dim, fontSize: 15, cursor: 'pointer', fontFamily: 'inherit' }}>✕</button>
              </div>
              {important.length === 0 ? (
                <div style={{ padding: '24px 16px', fontSize: 14.5, color: C.dim, lineHeight: 1.55 }}>
                  Ничего не мешает торговать: смены закрыты, полки не пустые, подписка в порядке.
                </div>
              ) : important.map((a, i) => (
                <a key={a.kind ?? i} href={a.href} style={{ display: 'block', padding: '13px 14px', minHeight: 56,
                  borderBottom: `1px solid ${C.lineIn}`, textDecoration: 'none' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                    <Badge tone={a.tone === 'bad' ? 'bad' : 'warn'}>{a.tone === 'bad' ? 'Срочно' : 'Проверить'}</Badge>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, color: C.text, lineHeight: 1.35, wordBreak: 'break-word' }}>{a.title}</span>
                  </span>
                  <span style={{ display: 'block', fontSize: 12.5, color: C.dim, marginTop: 5 }}>{a.sub}</span>
                </a>
              ))}
            </div>
          </>
        )}

        {drawer && (
          <>
            <div onClick={() => setDrawer(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(23,33,29,.42)', zIndex: 40 }} />
            <aside style={{ position: 'fixed', top: 0, left: 0, bottom: 0, width: 296, maxWidth: '88%', zIndex: 41,
              background: C.card, borderRight: `1px solid ${C.line}`, display: 'flex', flexDirection: 'column',
              boxShadow: '0 0 40px rgba(23,33,29,.18)' }}>
              <div style={{ padding: '14px 14px 12px', borderBottom: `1px solid ${C.lineIn}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
                  <div style={{ flex: '0 0 28px', width: 28, height: 28, borderRadius: 8, background: C.accent,
                    color: '#fff', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center',
                    justifyContent: 'center' }}>Т</div>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 500, letterSpacing: '.14em', color: C.dim }}>ТАБЫС</div>
                  <button onClick={() => setDrawer(false)} aria-label="Закрыть"
                    style={{ flex: '0 0 44px', width: 44, height: 44, border: 0, borderRadius: 8,
                      background: 'transparent', color: C.dim, fontSize: 15, cursor: 'pointer', fontFamily: 'inherit' }}>✕</button>
                </div>
                <div style={{ fontSize: 15.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {me?.businessName ?? 'Магазин'}
                </div>
                <div style={{ fontSize: 13, color: C.dim, marginTop: 3 }}>
                  {me ? (me.isOwner ? 'Владелец' : me.roleCode) : '…'}
                </div>
              </div>
              <nav style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '8px 8px 14px' }}>
                {favs.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase',
                      color: '#A5A99E', padding: '10px 10px 5px' }}>Закреплённое</div>
                    {favs.map((href) => (
                      <a key={href} href={href} style={{ display: 'flex', alignItems: 'center', gap: 8,
                        minHeight: 44, padding: '0 10px', borderRadius: 8, fontSize: 15, textDecoration: 'none',
                        color: path?.startsWith(href) ? C.accentDark : C.prose,
                        background: path?.startsWith(href) ? '#E8F1EC' : 'transparent' }}>
                        <span style={{ flex: '0 0 auto', color: C.gold }}>★</span>
                        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label(href)}</span>
                      </a>
                    ))}
                  </>
                )}
                {NAV.map((g) => (
                  <div key={g.key}>
                    {g.items.length > 1 && (
                      <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase',
                        color: '#A5A99E', padding: '13px 10px 5px' }}>{g.label}</div>
                    )}
                    {g.items.map(([href, text]) => {
                      const on = path?.startsWith(href);
                      return (
                        <a key={href} href={href} style={{ display: 'flex', alignItems: 'center', gap: 8,
                          minHeight: 44, padding: '0 10px', borderRadius: 8, fontSize: 15, textDecoration: 'none',
                          color: on ? C.accentDark : C.prose, background: on ? '#E8F1EC' : 'transparent',
                          fontWeight: on ? 500 : 400 }}>
                          <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
                          {href === '/ai' && <span style={{ flex: '0 0 6px', width: 6, height: 6, borderRadius: '50%', background: C.gold }} />}
                        </a>
                      );
                    })}
                  </div>
                ))}
              </nav>
              <div style={{ padding: '10px 14px 14px', borderTop: `1px solid ${C.lineIn}`,
                display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
                {access
                  ? access.canSell
                    ? <Badge tone="ok">Подписка: {access.status === 'trial' ? 'пробный период' : 'активна'}</Badge>
                    : <Badge tone="bad">{access.reason ?? 'Продажи закрыты'}</Badge>
                  : <Badge tone="dim">Подписка…</Badge>}
                {sync
                  ? sync.ready ? <Badge tone="ok">Кассы синхронизированы</Badge> : <Badge tone="warn">Есть неотданные данные</Badge>
                  : <Badge tone="dim">Синхронизация…</Badge>}
                <a href="/login" onClick={() => tokens.clear()}
                  style={{ color: C.dim, fontSize: 14, minHeight: 44, display: 'flex', alignItems: 'center' }}>Выйти</a>
              </div>
            </aside>
          </>
        )}

        {find && <FindWindow narrow value={q} onChange={setQ} inputRef={qRef}
          sections={sections} goods={goods} recent={recent} label={label}
          onClose={() => { setFind(false); setQ(''); }} icon={searchIcon} />}

        {help && <HelpWindow narrow onClose={() => setHelp(false)} />}

        <main style={{ padding: '18px 14px 56px' }}>{children}</main>
      </div>
    );
  }

  /* ── Компьютер: рельс слева ───────────────────────────────────────── */

  const flyGroup = !wide ? NAV.find((g) => g.key === fly && g.items.length > 1) : null;
  /** Панель открывается напротив своего знака, а не сверху: иначе не
   *  читается связь «нажал здесь — открылось это». */
  const flyTop = 67 + 10 + favs.length * 40 + Math.max(0, NAV.findIndex((g) => g.key === fly)) * 42;

  const chip = (text: string, on: boolean, gold?: boolean) => (
    <span style={{ flex: '0 0 30px', width: 30, height: 30, borderRadius: 8, display: 'flex',
      alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 12,
      background: gold ? '#F7EFDF' : on ? '#E8F1EC' : '#F1F1EA',
      color: gold ? C.amber : on ? C.accentDark : C.dim }}>{text}</span>
  );

  return (
    <div style={{ display: 'flex', minHeight: '100dvh' }}>
      <aside data-no-print="" style={{ flex: '0 0 auto', width: wide ? 240 : 68, position: 'sticky', top: 0,
        height: '100dvh', background: C.card, borderRight: `1px solid ${C.line}`,
        display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 12px 12px',
          borderBottom: `1px solid ${C.lineIn}`, minWidth: 0 }}>
          <div title="Табыс" style={{ flex: '0 0 30px', width: 30, height: 30, borderRadius: 8, background: C.accent,
            color: '#fff', fontSize: 15, fontWeight: 600, display: 'flex', alignItems: 'center',
            justifyContent: 'center' }}>Т</div>
          {wide && (
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <div style={{ fontSize: 14.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {me?.businessName ?? 'Магазин'}
              </div>
              <div style={{ fontSize: 12, color: C.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {me ? (me.isOwner ? 'Владелец' : me.roleCode) : '…'}
              </div>
            </div>
          )}
        </div>

        <nav style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '10px 8px', position: 'relative' }}>
          {favs.length > 0 && wide && (
            <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase',
              color: '#A5A99E', padding: '6px 8px 5px', whiteSpace: 'nowrap', overflow: 'hidden' }}>Закреплённое</div>
          )}
          {favs.map((href) => {
            const on = path?.startsWith(href);
            return (
              <a key={href} href={href} title={label(href)}
                style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40, padding: '0 8px',
                  borderRadius: 9, textDecoration: 'none', minWidth: 0,
                  background: on ? '#E8F1EC' : 'transparent', color: on ? C.accentDark : C.prose }}>
                {chip(label(href).slice(0, 2), !!on, true)}
                {wide && (
                  <span style={{ flex: 1, minWidth: 0, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    ★ {label(href)}
                  </span>
                )}
              </a>
            );
          })}
          {favs.length > 0 && wide && (
            <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase',
              color: '#A5A99E', padding: '12px 8px 5px', whiteSpace: 'nowrap', overflow: 'hidden' }}>Разделы</div>
          )}

          {NAV.map((g) => {
            const on = g.items.some(([href]) => path?.startsWith(href));
            const single = g.items.length === 1;
            const opened = wide && !single && (acc ? acc === g.key : activeGroup === g.key);
            const row: any = {
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 42, padding: '0 8px',
              border: 0, borderRadius: 9, cursor: 'pointer', textAlign: 'left', minWidth: 0,
              textDecoration: 'none', fontFamily: 'inherit',
              background: on && !opened ? '#F1F1EA' : 'transparent', color: on ? C.accentDark : C.prose,
            };
            const inner = (
              <>
                {chip(g.short, on)}
                {wide && (
                  <>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: on ? 500 : 400 }}>{g.label}</span>
                    {!single && <span style={{ flex: '0 0 auto', fontSize: 10, color: C.faint }}>{opened ? '▲' : '▼'}</span>}
                  </>
                )}
              </>
            );
            return (
              <div key={g.key}>
                {single ? (
                  <a href={g.items[0][0]} title={g.label} style={row}>{inner}</a>
                ) : (
                  <button title={g.label} style={row}
                    onClick={() => (wide ? setAcc(acc === g.key ? ' ' : g.key) : setFly(fly === g.key ? '' : g.key))}>
                    {inner}
                  </button>
                )}
                {opened && g.items.map(([href, text]) => {
                  const iOn = path?.startsWith(href);
                  return (
                    <a key={href} href={href} style={{ display: 'flex', alignItems: 'center', gap: 8,
                      minHeight: 38, padding: '0 8px 0 48px', borderRadius: 9, textDecoration: 'none', minWidth: 0,
                      background: iOn ? '#E8F1EC' : 'transparent', color: iOn ? C.accentDark : C.prose,
                      fontWeight: iOn ? 500 : 400 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
                      {href === '/ai' && <span style={{ flex: '0 0 6px', width: 6, height: 6, borderRadius: '50%', background: C.gold }} />}
                    </a>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div style={{ flex: '0 0 auto', borderTop: `1px solid ${C.lineIn}`, padding: 8,
          display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div title={access ? (access.canSell ? 'Подписка в порядке' : (access.reason ?? 'Продажи закрыты')) : 'Подписка…'}
            style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, minHeight: 26 }}>
            {chip(access ? (access.canSell ? 'ok' : '!') : '…', !!access?.canSell, !access?.canSell && !!access)}
            {wide && (
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {access ? (access.canSell ? (access.status === 'trial' ? 'Пробный период' : 'Подписка активна') : (access.reason ?? 'Продажи закрыты')) : 'Подписка…'}
              </span>
            )}
          </div>
          <div title={sync ? (sync.ready ? 'Кассы синхронизированы' : 'Есть неотданные данные с касс') : 'Синхронизация…'}
            style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, minHeight: 26 }}>
            {chip(sync ? (sync.ready ? 'ok' : '!') : '…', !!sync?.ready, !!sync && !sync.ready)}
            {wide && (
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {sync ? (sync.ready ? 'Кассы отдали данные' : 'Кассы не отдали данные') : 'Синхронизация…'}
              </span>
            )}
          </div>
          <button onClick={toggleRail} title={wide ? 'Свернуть меню до знаков (клавиша «[»)' : 'Развернуть меню с подписями (клавиша «[»)'}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 40, padding: '0 8px',
              border: 0, borderRadius: 9, cursor: 'pointer', background: 'transparent', color: C.dim, minWidth: 0,
              fontFamily: 'inherit' }}>
            <span style={{ flex: '0 0 30px', textAlign: 'center', fontFamily: MONO, fontSize: 14 }}>{wide ? '«' : '»'}</span>
            {wide && <span style={{ flex: 1, minWidth: 0, fontSize: 13, textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden' }}>Свернуть меню</span>}
          </button>
        </div>

        {flyGroup && (
          <div style={{ position: 'absolute', left: '100%', top: flyTop, zIndex: 35, width: 268,
            background: C.card, border: `1px solid ${C.line}`, borderRadius: '0 12px 12px 0',
            boxShadow: '12px 12px 34px rgba(23,33,29,.14)', padding: '12px 10px 14px' }}>
            <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase',
              color: '#A5A99E', padding: '0 8px 8px' }}>{flyGroup.label}</div>
            {flyGroup.items.map(([href, text]) => {
              const on = path?.startsWith(href);
              return (
                <a key={href} href={href} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40,
                  padding: '0 10px', borderRadius: 9, textDecoration: 'none', minWidth: 0, fontSize: 14.5,
                  background: on ? '#E8F1EC' : 'transparent', color: on ? C.accentDark : C.text,
                  fontWeight: on ? 500 : 400 }}>
                  <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
                  {href === '/ai' && <span style={{ flex: '0 0 6px', width: 6, height: 6, borderRadius: '50%', background: C.gold }} />}
                </a>
              );
            })}
            <div style={{ fontSize: 12.5, color: C.dim, lineHeight: 1.5, padding: '10px 10px 0',
              borderTop: `1px solid ${C.lineIn}`, marginTop: 8 }}>{flyGroup.note}</div>
          </div>
        )}
      </aside>

      <div style={{ flex: 1, minWidth: 0 }}>
        <header data-no-print="" style={{ position: 'sticky', top: 0, zIndex: 30, background: C.card,
          borderBottom: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', gap: 12,
          height: 58, padding: '0 20px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: C.dim,
            minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden' }}>
            <span>{current ? GROUP_OF[current[0]] : 'Кабинет'}</span>
            <span style={{ color: '#C9C9BE' }}>/</span>
            <span style={{ color: C.text, fontWeight: 500 }}>{current?.[1] ?? 'Показатели'}</span>
          </div>
          {current && (
            <button onClick={() => toggleFav(current[0])} title="Закрепить раздел в меню"
              style={{ flex: '0 0 auto', minHeight: 28, padding: '0 8px', border: 0, borderRadius: 8,
                background: 'transparent', cursor: 'pointer', fontSize: 12.5, whiteSpace: 'nowrap',
                fontFamily: 'inherit', color: favs.includes(current[0]) ? C.amber : C.dim }}>
              {favs.includes(current[0]) ? '★ Закреплено' : '☆ Закрепить'}
            </button>
          )}
          <div style={{ flex: 1, minWidth: 12 }} />
          <button onClick={() => setFind(true)} title="Поиск по кабинету (Ctrl + K)"
            style={{ display: 'flex', alignItems: 'center', gap: 9, height: 38, padding: '0 10px 0 12px',
              flex: '0 1 300px', minWidth: 180, border: `1px solid #D8D8CF`, borderRadius: 8,
              background: C.sunken, color: C.faint, fontSize: 14, cursor: 'pointer', textAlign: 'left',
              fontFamily: 'inherit' }}>
            {searchIcon(14, C.dim)}
            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              Товар, документ, клиент…
            </span>
            <span style={{ flex: '0 0 auto', fontFamily: MONO, fontSize: 11.5, color: C.faint,
              border: `1px solid ${C.line}`, borderRadius: 5, padding: '2px 5px', background: C.card,
              whiteSpace: 'nowrap' }}>Ctrl K</span>
          </button>
          <div style={{ position: 'relative', flex: '0 0 auto' }}>
            <button onClick={() => { setAlerts(!alerts); setFly(''); }} title="Важное"
              style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 11px',
                border: `1px solid ${C.line}`, borderRadius: 8, background: alerts ? '#F1F1EA' : C.card,
                cursor: 'pointer', fontSize: 13.5, color: C.prose, whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
              Важное
              <span style={{ minWidth: 20, height: 20, padding: '0 5px', borderRadius: 999,
                background: bad ? C.red : important.length ? C.amber : '#D3D3C9', color: '#fff',
                fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontVariantNumeric: 'tabular-nums' }}>{important.length}</span>
            </button>
            {alerts && (
              <div style={{ position: 'absolute', right: 0, top: 46, zIndex: 31, width: 420,
                background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden',
                boxShadow: '0 18px 40px rgba(23,33,29,.16)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '14px 16px', borderBottom: `1px solid ${C.lineIn}` }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>Требует внимания</div>
                  <button onClick={() => setAlerts(false)} style={{ minHeight: 30, padding: '0 10px', border: 0,
                    borderRadius: 8, background: 'transparent', color: C.dim, fontSize: 13, cursor: 'pointer',
                    fontFamily: 'inherit' }}>Закрыть</button>
                </div>
                <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                  {important.length === 0 ? (
                    <div style={{ padding: '26px 16px', fontSize: 14, color: C.dim, lineHeight: 1.55 }}>
                      Ничего не мешает торговать: смены закрыты, полки не пустые, подписка в порядке.
                    </div>
                  ) : important.map((a, i) => (
                    <a key={a.kind ?? i} href={a.href} style={{ display: 'flex', gap: 12, padding: '13px 16px',
                      borderBottom: `1px solid ${C.lineIn}`, textDecoration: 'none', minWidth: 0 }}>
                      <span style={{ flex: '0 0 auto', marginTop: 2 }}>
                        <Badge tone={a.tone === 'bad' ? 'bad' : 'warn'}>{a.tone === 'bad' ? 'Срочно' : 'Проверить'}</Badge>
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, color: C.text, lineHeight: 1.4 }}>{a.title}</span>
                        <span style={{ display: 'block', fontSize: 12.5, color: C.dim, marginTop: 3 }}>{a.sub}</span>
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button onClick={() => setHelp(true)} title="Справка и горячие клавиши"
            style={{ flex: '0 0 38px', width: 38, height: 38, border: `1px solid ${C.line}`, borderRadius: 8,
              background: C.card, cursor: 'pointer', fontSize: 15, color: C.dim, fontFamily: 'inherit' }}>?</button>
          <div title={`${me?.businessName ?? ''} · ${me ? (me.isOwner ? 'владелец' : me.roleCode) : ''}`}
            style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 9, paddingLeft: 14,
              borderLeft: `1px solid ${C.lineIn}` }}>
            <span style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap' }}>
              {me ? (me.isOwner ? 'Владелец' : me.roleCode) : '…'}
            </span>
            <a href="/login" onClick={() => tokens.clear()} title="Выйти"
              style={{ width: 32, height: 32, flex: '0 0 32px', borderRadius: '50%', background: '#E8F1EC',
                color: C.accentDark, fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center',
                justifyContent: 'center', textDecoration: 'none' }}>вых</a>
          </div>
        </header>

        {find && <FindWindow value={q} onChange={setQ} inputRef={qRef}
          sections={sections} goods={goods} recent={recent} label={label}
          onClose={() => { setFind(false); setQ(''); }} icon={searchIcon} />}

        {help && <HelpWindow onClose={() => setHelp(false)} />}

        <main style={{ padding: '24px 20px 44px', minWidth: 0 }}>
          <div style={{ maxWidth: 1180, margin: '0 auto', minWidth: 0 }}>{children}</div>
        </main>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ОКНО ПОИСКА

   Разделы ищутся на месте — мгновенно и без запросов. Товары ищет
   существующий /goods?q=. Товар открывается своим разделом: отдельного
   адреса у карточки товара в кабинете пока нет.

   На телефоне окно занимает весь экран: 660 px в 390 не живут, а
   «Отмена» вместо Esc — клавиши там нет.
   ═══════════════════════════════════════════════════════════════════ */
function FindWindow({ value, onChange, inputRef, sections, goods, recent, label, onClose, narrow, icon }: {
  value: string; onChange: (v: string) => void; inputRef: any;
  sections: [string, string][]; goods: any[]; recent: string[];
  label: (href: string) => string; onClose: () => void; narrow?: boolean;
  icon: (size: number, color: string) => any;
}) {
  const empty = value.trim().length > 0 && sections.length === 0 && goods.length === 0;

  const list = (
    <>
      {!value.trim() && recent.length > 0 && (
        <>
          <Head text="Недавние разделы" />
          {recent.map((href) => <Row key={href} href={href} title={label(href)} sub="раздел кабинета" narrow={narrow} />)}
        </>
      )}
      {goods.length > 0 && (
        <>
          <Head text={`Товары · ${goods.length}`} />
          {goods.map((g: any) => (
            <Row key={g.id} href="/goods" title={g.name} sub="открыть раздел «Товары»" narrow={narrow} />
          ))}
        </>
      )}
      {sections.length > 0 && (
        <>
          <Head text={`Разделы · ${sections.length}`} />
          {sections.map(([href, text]) => <Row key={href} href={href} title={text} sub={href} narrow={narrow} />)}
        </>
      )}
      {empty && (
        <div style={{ padding: '36px 18px', textAlign: 'center', fontSize: 14.5, color: C.dim, lineHeight: 1.55 }}>
          По запросу «{value}» ничего не нашлось. Поиск смотрит товары и разделы кабинета.
        </div>
      )}
    </>
  );

  if (narrow) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: C.card, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8,
          borderBottom: `1px solid ${C.lineIn}`, minWidth: 0 }}>
          <span style={{ flex: '0 0 auto', paddingLeft: 6, display: 'flex' }}>{icon(17, C.dim)}</span>
          <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)}
            placeholder="Товар, документ, клиент"
            style={{ flex: 1, minWidth: 0, height: 48, border: 0, outline: 'none', fontSize: 17,
              color: C.text, background: 'transparent' }} />
          <button onClick={onClose} style={{ flex: '0 0 auto', minHeight: 44, padding: '0 12px', border: 0,
            borderRadius: 8, background: 'transparent', color: C.dim, fontSize: 14, cursor: 'pointer',
            fontFamily: 'inherit' }}>Отмена</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>{list}</div>
      </div>
    );
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(23,33,29,.44)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '9vh 20px 20px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 660, maxWidth: '100%', maxHeight: '78vh',
        background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden',
        display: 'flex', flexDirection: 'column', boxShadow: '0 30px 70px rgba(23,33,29,.28)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
          borderBottom: `1px solid ${C.lineIn}`, minWidth: 0 }}>
          {icon(17, C.dim)}
          <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)}
            placeholder="Товар, документ, клиент или раздел"
            style={{ flex: 1, minWidth: 0, height: 44, border: 0, outline: 'none', fontSize: 17,
              color: C.text, background: 'transparent' }} />
          <span style={{ flex: '0 0 auto', fontFamily: MONO, fontSize: 11.5, color: C.faint,
            border: `1px solid ${C.line}`, borderRadius: 5, padding: '3px 6px' }}>Esc</span>
        </div>
        <div style={{ overflowY: 'auto', overflowX: 'hidden' }}>{list}</div>
        <div style={{ display: 'flex', gap: 18, padding: '11px 16px', background: C.sunken,
          borderTop: `1px solid ${C.lineIn}`, fontSize: 12.5, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <span>Ctrl K — из любого раздела</span><span>Esc — закрыть</span>
        </div>
      </div>
    </div>
  );
}

function Head({ text }: { text: string }) {
  return (
    <div style={{ padding: '11px 16px 5px', background: C.sunken, borderBottom: `1px solid ${C.lineIn}`,
      fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase', color: C.faint,
      whiteSpace: 'nowrap', overflow: 'hidden' }}>{text}</div>
  );
}

function Row({ href, title, sub, narrow }: { href: string; title: string; sub: string; narrow?: boolean }) {
  return (
    <a href={href} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px',
      minHeight: narrow ? 56 : 44, borderBottom: `1px solid ${C.lineIn}`, textDecoration: 'none', minWidth: 0 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, color: C.text, lineHeight: 1.35, wordBreak: 'break-word' }}>{title}</span>
        <span style={{ display: 'block', fontSize: 12.5, color: C.dim, marginTop: 3, fontFamily: MONO,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</span>
      </span>
      {!narrow && <span style={{ flex: '0 0 auto', fontSize: 12.5, color: C.faint, whiteSpace: 'nowrap' }}>Открыть →</span>}
    </a>
  );
}

/** Горячие клавиши. Перечислено только то, что действительно работает:
 *  обещанная и не работающая клавиша хуже отсутствующей. */
function HelpWindow({ onClose, narrow }: { onClose: () => void; narrow?: boolean }) {
  const keys: [string, string][] = [
    ['Ctrl + K', 'Поиск по товарам и разделам из любого места'],
    ['1 … 6', 'Открыть пункт меню: Показатели, Деньги, Товар, Клиенты, Каналы, Управление'],
    ['[', 'Свернуть или развернуть меню'],
    ['?', 'Это окно'],
    ['Esc', 'Закрыть поиск, меню, окно'],
  ];
  const body = (
    <div style={{ padding: narrow ? '4px 14px 16px' : '8px 20px 18px' }}>
      {keys.map(([k, d]) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0',
          borderBottom: `1px solid ${C.lineIn}`, minWidth: 0 }}>
          <span style={{ flex: '0 0 auto', fontFamily: MONO, fontSize: 12.5, color: C.text,
            border: `1px solid ${C.line}`, borderRadius: 6, padding: '4px 8px', background: C.sunken,
            whiteSpace: 'nowrap' }}>{k}</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 14.5, color: C.prose, wordBreak: 'break-word' }}>{d}</span>
        </div>
      ))}
      <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.55, marginTop: 12 }}>
        {narrow
          ? 'С телефона клавиш нет — здесь они как памятка для работы за компьютером.'
          : 'Знак вопроса рядом с заголовком раздела открывает это окно и инструкцию по разделу.'}
      </div>
    </div>
  );

  if (narrow) {
    return (
      <>
        <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 61, background: 'rgba(23,33,29,.42)' }} />
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 62, maxHeight: '80vh',
          background: C.card, borderRadius: '18px 18px 0 0', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 14px', borderBottom: `1px solid ${C.lineIn}` }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Горячие клавиши</div>
            <button onClick={onClose} aria-label="Закрыть" style={{ flex: '0 0 44px', width: 44, height: 44,
              border: 0, background: 'transparent', color: C.dim, fontSize: 15, cursor: 'pointer',
              fontFamily: 'inherit' }}>✕</button>
          </div>
          {body}
        </div>
      </>
    );
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 61, background: 'rgba(23,33,29,.44)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '100%', background: C.card,
        borderRadius: 14, overflow: 'hidden', boxShadow: '0 30px 70px rgba(23,33,29,.28)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: `1px solid ${C.lineIn}` }}>
          <div style={{ fontSize: 17, fontWeight: 600 }}>Горячие клавиши</div>
          <button onClick={onClose} style={{ width: 38, height: 38, border: 0, borderRadius: 8,
            background: 'transparent', color: C.dim, fontSize: 15, cursor: 'pointer', fontFamily: 'inherit' }}>✕</button>
        </div>
        {body}
      </div>
    </div>
  );
}
