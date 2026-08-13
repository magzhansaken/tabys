'use client';
/**
 * Каркас кабинета. РАСКЛАДКА ПЕРЕУСТРОЕНА: меню переехало наверх.
 *
 * ПОЧЕМУ. Боковое меню занимало 252 px всегда. На ноутбуке 1366 это
 * шестая часть экрана, отданная навигации, которой пользуются раз в пять
 * минут. Горизонтальная строка отдаёт содержимому всю ширину: было 1114,
 * стало 1366 минус отступы.
 *
 * 22 раздела в одну строку не помещаются, поэтому в строке шесть пунктов:
 * «Показатели» ссылкой и пять групп с раскрывающейся плашкой. Группы и
 * порядок разделов внутри прежние, ни один раздел не потерян и не
 * переименован. «Подписка» переехала из «Управления» в «Деньги»: её
 * смотрят каждый месяц, а настройки — один раз при запуске. Право у
 * раздела своё (billing), доступ этим не меняется.
 *
 * ЧТО ДОБАВЛЕНО, ЧЕГО НЕ БЫЛО
 *   · глобальный поиск по Ctrl+K — по разделам и по товарам;
 *   · «Важное» с числом — то, что мешает торговать прямо сейчас;
 *   · хлебные крошки: магазин / группа / раздел;
 *   · избранное: до пяти закреплённых разделов, запоминается;
 *   · недавние разделы;
 *   · горячие клавиши и окно справки по «?».
 *
 * ГРАНИЦЫ, КОТОРЫЕ СОБЛЮДЕНЫ
 *   · новых обращений к серверу нет: /auth/me, /billing/access и
 *     /admin/sync/readiness — те же три, что были. Поиск товаров ходит в
 *     СУЩЕСТВУЮЩИЙ /goods?q=, тот же, что уже вызывает раздел «Склад»,
 *     и только когда человек набрал два знака. Выключается одной
 *     строкой ниже: SEARCH_GOODS = false;
 *   · localStorage — только внутри useEffect;
 *   · <form> нет, обработчики на кнопках;
 *   · имена полей данных не тронуты: читаются только те, что читались
 *     раньше (me.businessName, me.isOwner, me.roleCode, access.canSell,
 *     access.status, access.reason, sync.ready);
 *   · адреса разделов латиницей и прежние.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api, tokens } from '../../lib/api';
import { C, Badge, MONO } from '../../lib/ui';

/** Поиск по товарам через существующий /goods?q=. Если владелец решит,
 *  что шапке ходить за товарами не нужно, — здесь false, и поиск
 *  останется по разделам. */
const SEARCH_GOODS = true;

/** Шесть верхних пунктов. Первый — раздел, остальные — группы.
 *  Порядок внутри групп прежний. */
const NAV: { label: string; note: string; items: [string, string][] }[] = [
  {
    label: 'Показатели', note: 'Сводка дня: выручка, прибыль, чеки, что закончилось.',
    items: [['/dashboard', 'Показатели']],
  },
  {
    label: 'Деньги', note: 'Деньги, которые пришли и ушли. Подписка здесь же — её смотрят каждый месяц.',
    items: [
      ['/reports', 'Отчёты'],
      ['/finance', 'Финансы'],
      ['/taxes', 'Налоги'],
      ['/payroll', 'Зарплата'],
      ['/billing', 'Подписка'],
    ],
  },
  {
    label: 'Товар', note: 'Всё, что лежит на полке и на складе. Приёмка — самое частое действие в кабинете.',
    items: [
      ['/goods', 'Товары'],
      ['/stock', 'Склад'],
      ['/techcards', 'Техкарты'],
      ['/marking', 'Маркировка'],
      ['/excise', 'Акциз (алкоголь)'],
    ],
  },
  {
    label: 'Клиенты', note: 'Кому продаём и кто должен. Долги поставщикам — в контрагентах.',
    items: [
      ['/contragents', 'Контрагенты'],
      ['/loyalty', 'Лояльность'],
      ['/certificates', 'Сертификаты'],
      ['/rfm', 'RFM-анализ'],
      ['/wholesale', 'Опт'],
    ],
  },
  {
    label: 'Каналы', note: 'Продажи вне кассы и помощники. AI-помощника нет ни у одного конкурента.',
    items: [
      ['/marketplace', 'Kaspi магазин'],
      ['/ai', 'AI-помощник'],
      ['/automation', 'Автоматизация'],
    ],
  },
  {
    label: 'Управление', note: 'Настраивают один раз при запуске и потом почти не заходят.',
    items: [
      ['/employees', 'Сотрудники'],
      ['/stores', 'Точки и кассы'],
      ['/settings', 'Настройки'],
    ],
  },
];

const FLAT: [string, string][] = NAV.reduce<[string, string][]>((a, g) => a.concat(g.items), []);
const GROUP_OF: Record<string, string> = {};
NAV.forEach((g) => g.items.forEach(([href]) => { GROUP_OF[href] = g.label; }));

const FAV_KEY = 'cab:favs';
const RECENT_KEY = 'cab:recent';

export default function CabLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [me, setMe] = useState<any>(null);
  const [access, setAccess] = useState<any>(null);
  const [sync, setSync] = useState<any>(null);
  const [err, setErr] = useState('');
  const [narrow, setNarrow] = useState(false);

  const [menu, setMenu] = useState('');        // раскрытая группа
  const [drawer, setDrawer] = useState(false); // меню телефона
  const [alerts, setAlerts] = useState(false); // «Важное»
  const [help, setHelp] = useState(false);     // горячие клавиши
  const [find, setFind] = useState(false);     // поиск
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

  // Хранилище — только здесь, после появления страницы.
  useEffect(() => {
    try {
      const f = window.localStorage.getItem(FAV_KEY);
      if (f) setFavs(JSON.parse(f));
      const r = window.localStorage.getItem(RECENT_KEY);
      if (r) setRecent(JSON.parse(r));
    } catch { /* хранилище недоступно — работаем без избранного */ }
  }, []);

  const current = FLAT.find(([href]) => path?.startsWith(href));

  // Недавние разделы: пять последних, текущий первым.
  useEffect(() => {
    if (!current) return;
    setRecent((prev) => {
      const next = [current[0], ...prev.filter((h) => h !== current[0])].slice(0, 5);
      try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [current?.[0]]);

  useEffect(() => { setMenu(''); setDrawer(false); setFind(false); setAlerts(false); }, [path]);

  // Горячие клавиши. Цифры и «?» не срабатывают, пока человек печатает.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault(); setFind(true); setMenu(''); setAlerts(false);
        return;
      }
      if (e.key === 'Escape') { setFind(false); setMenu(''); setAlerts(false); setHelp(false); setDrawer(false); return; }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?') { setHelp(true); return; }
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length) {
        const g = NAV[n - 1];
        if (g.items.length === 1) window.location.href = g.items[0][0];
        else setMenu((cur) => (cur === g.label ? '' : g.label));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Пока открыт поиск или меню телефона — страница под ними не едет.
  useEffect(() => {
    if (!find && !drawer) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [find, drawer]);

  useEffect(() => { if (find) qRef.current?.focus(); }, [find]);

  // Поиск товаров: существующий /goods?q=, от двух знаков, с задержкой,
  // чтобы на каждое нажатие не уходил запрос.
  useEffect(() => {
    if (!SEARCH_GOODS || !find) return;
    const s = q.trim();
    if (s.length < 2) { setGoods([]); return; }
    const id = setTimeout(() => {
      api(`/goods?q=${encodeURIComponent(s)}&limit=8`)
        .then((r: any) => setGoods(Array.isArray(r) ? r : []))
        .catch(() => setGoods([]));   // нет права на товары — поиск остаётся по разделам
    }, 250);
    return () => clearTimeout(id);
  }, [q, find]);

  /** Разделы, подходящие под запрос. Ищем и по названию, и по группе:
   *  «деньги» приводит к отчётам, «настройки» — в настройки. */
  const sections = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [] as [string, string][];
    return FLAT.filter(([href, label]) =>
      (label + ' ' + (GROUP_OF[href] ?? '')).toLowerCase().includes(s));
  }, [q]);

  /** «Важное» — только то, что видно из уже загруженных ответов.
   *  Остальные сигналы (закончившийся товар, незакрытая смена,
   *  расхождение, заявка с сайта, заказы Kaspi) требуют данных, которых
   *  в оболочке нет; новых обращений к серверу для них не добавлено —
   *  об этом написано в отчёте. */
  const important = useMemo(() => {
    const list: { tone: 'bad' | 'warn'; title: string; sub: string; href: string }[] = [];
    if (access && !access.canSell) {
      list.push({
        tone: 'bad',
        title: access.reason ?? 'Продажи закрыты',
        sub: 'Касса не сможет принимать оплату, пока подписка не продлена',
        href: '/billing',
      });
    }
    if (sync && !sync.ready) {
      list.push({
        tone: 'warn',
        title: 'Есть неотданные данные с касс',
        sub: 'Часть продаж ещё не доехала в кабинет — цифры в отчётах неполные',
        href: '/stores',
      });
    }
    return list;
  }, [access, sync]);

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

  /* ── Кусочки, общие для компьютера и телефона ───────────────────── */

  const logo = (
    <div title="Табыс — кабинет" style={{ width: 28, height: 28, flex: '0 0 28px', borderRadius: 8,
      background: C.accent, color: '#fff', fontSize: 15, fontWeight: 600, display: 'flex',
      alignItems: 'center', justifyContent: 'center' }}>Т</div>
  );

  const searchButton = (
    <button onClick={() => setFind(true)} title="Поиск по кабинету (Ctrl + K)"
      style={{ display: 'flex', alignItems: 'center', gap: 9, height: 38, padding: '0 10px 0 12px',
        flex: '1 1 240px', minWidth: 200, maxWidth: 320, border: `1px solid #D8D8CF`, borderRadius: 8,
        background: C.sunken, color: C.faint, fontSize: 14, cursor: 'pointer', textAlign: 'left',
        fontFamily: 'inherit' }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ flex: '0 0 14px' }}>
        <circle cx="6" cy="6" r="4.4" stroke={C.dim} strokeWidth="1.4" />
        <path d="M9.4 9.4 L12.4 12.4" stroke={C.dim} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        Товар, документ, клиент…
      </span>
      <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.faint, border: `1px solid ${C.line}`,
        borderRadius: 5, padding: '2px 5px', background: C.card, whiteSpace: 'nowrap', flex: '0 0 auto' }}>Ctrl K</span>
    </button>
  );

  const bell = (
    <button onClick={() => { setAlerts(!alerts); setMenu(''); }} title="Важное"
      style={{ display: 'flex', alignItems: 'center', gap: 8, height: 38, padding: '0 11px', flex: '0 0 auto',
        border: `1px solid ${C.line}`, borderRadius: 8, background: alerts ? '#F1F1EA' : C.card,
        cursor: 'pointer', fontSize: 13.5, color: C.prose, whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
      Важное
      <span style={{ minWidth: 20, height: 20, padding: '0 5px', borderRadius: 999,
        background: important.length ? C.red : '#D3D3C9', color: '#fff', fontSize: 12, fontWeight: 600,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontVariantNumeric: 'tabular-nums' }}>
        {important.length}
      </span>
    </button>
  );

  const alertsPanel = alerts && (
    <div style={{ position: 'absolute', right: 18, top: '100%', zIndex: 31, width: 420, maxWidth: 'calc(100vw - 24px)',
      background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden',
      boxShadow: '0 18px 40px rgba(23,33,29,.16)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 16px', borderBottom: `1px solid ${C.lineIn}` }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Требует внимания</div>
        <button onClick={() => setAlerts(false)} style={{ minHeight: 30, padding: '0 10px', border: 0,
          borderRadius: 8, background: 'transparent', color: C.dim, fontSize: 13, cursor: 'pointer',
          fontFamily: 'inherit' }}>Закрыть</button>
      </div>
      {important.length === 0 ? (
        <div style={{ padding: '26px 16px', fontSize: 14, color: C.dim, lineHeight: 1.55 }}>
          Подписка в порядке, кассы отдали данные. Ничего не мешает торговать.
        </div>
      ) : important.map((a, i) => (
        <a key={i} href={a.href} style={{ display: 'flex', gap: 12, padding: '13px 16px',
          borderBottom: `1px solid ${C.lineIn}`, textDecoration: 'none' }}>
          <span style={{ flex: '0 0 auto', marginTop: 2 }}><Badge tone={a.tone}>{a.tone === 'bad' ? 'Срочно' : 'Проверить'}</Badge></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14, color: C.text, lineHeight: 1.4 }}>{a.title}</span>
            <span style={{ display: 'block', fontSize: 12.5, color: C.dim, marginTop: 3 }}>{a.sub}</span>
          </span>
        </a>
      ))}
    </div>
  );

  const user = (
    <div title={`${me?.businessName ?? 'Магазин'} · ${me ? (me.isOwner ? 'владелец' : me.roleCode) : ''}`}
      style={{ display: 'flex', alignItems: 'center', gap: 9, flex: '0 0 auto', paddingLeft: 14,
        borderLeft: `1px solid ${C.lineIn}` }}>
      <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap' }}>
        {me ? (me.isOwner ? 'Владелец' : me.roleCode) : '…'}
      </div>
      <a href="/login" onClick={() => tokens.clear()} title="Выйти"
        style={{ width: 32, height: 32, flex: '0 0 32px', borderRadius: '50%', background: '#E8F1EC',
          color: C.accentDark, fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center',
          justifyContent: 'center', textDecoration: 'none' }}>вых</a>
    </div>
  );

  /* ── Телефон ──────────────────────────────────────────────────────── */

  if (narrow) {
    return (
      <div style={{ minHeight: '100vh' }}>
        <header data-no-print="" style={{ position: 'sticky', top: 0, zIndex: 30, background: C.card,
          borderBottom: `1px solid ${C.line}`, height: 56, display: 'flex', alignItems: 'center',
          gap: 8, padding: '0 8px' }}>
          <button onClick={() => setDrawer(true)} aria-label="Разделы"
            style={{ width: 44, height: 44, border: 0, background: 'transparent', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5, padding: '0 11px' }}>
            <span style={{ height: 1.5, background: C.text, borderRadius: 1 }} />
            <span style={{ height: 1.5, background: C.text, borderRadius: 1 }} />
            <span style={{ height: 1.5, background: C.text, borderRadius: 1 }} />
          </button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {current?.[1] ?? 'Кабинет'}
            </div>
            <div style={{ fontSize: 12, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {me?.businessName ?? 'Магазин'}
            </div>
          </div>
          <button onClick={() => setFind(true)} aria-label="Поиск"
            style={{ width: 44, height: 44, border: 0, background: 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="17" height="17" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <circle cx="6" cy="6" r="4.4" stroke={C.prose} strokeWidth="1.4" />
              <path d="M9.4 9.4 L12.4 12.4" stroke={C.prose} strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
          <button onClick={() => setAlerts(!alerts)} aria-label="Важное"
            style={{ width: 44, height: 44, border: 0, background: 'transparent', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ minWidth: 24, height: 24, padding: '0 6px', borderRadius: 999,
              background: important.length ? C.red : '#D3D3C9', color: '#fff', fontSize: 13, fontWeight: 600,
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{important.length}</span>
          </button>
        </header>

        {alerts && (
          <>
            <div onClick={() => setAlerts(false)} style={{ position: 'fixed', inset: 0, zIndex: 42, background: 'rgba(23,33,29,.42)' }} />
            <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 43, maxHeight: '78vh',
              background: C.card, borderRadius: '18px 18px 0 0', overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 16px', borderBottom: `1px solid ${C.lineIn}` }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Требует внимания</div>
                <button onClick={() => setAlerts(false)} style={{ width: 44, height: 44, border: 0,
                  background: 'transparent', color: C.dim, fontSize: 15, cursor: 'pointer', fontFamily: 'inherit' }}>✕</button>
              </div>
              {important.length === 0 ? (
                <div style={{ padding: '24px 16px', fontSize: 14.5, color: C.dim, lineHeight: 1.55 }}>
                  Подписка в порядке, кассы отдали данные.
                </div>
              ) : important.map((a, i) => (
                <a key={i} href={a.href} style={{ display: 'block', padding: '14px 16px', minHeight: 56,
                  borderBottom: `1px solid ${C.lineIn}`, textDecoration: 'none' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <Badge tone={a.tone}>{a.tone === 'bad' ? 'Срочно' : 'Проверить'}</Badge>
                    <span style={{ fontSize: 14.5, color: C.text, lineHeight: 1.35 }}>{a.title}</span>
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
            <aside style={{ position: 'fixed', top: 0, left: 0, bottom: 0, width: 300, maxWidth: '86vw', zIndex: 41,
              background: C.card, borderRight: `1px solid ${C.line}`, display: 'flex', flexDirection: 'column',
              boxShadow: '0 0 40px rgba(23,33,29,.18)' }}>
              <div style={{ padding: '16px 16px 14px', borderBottom: `1px solid ${C.lineIn}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
                  {logo}
                  <div style={{ fontSize: 12.5, fontWeight: 500, letterSpacing: '.16em', color: C.dim }}>ТАБЫС</div>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => setDrawer(false)} aria-label="Закрыть"
                    style={{ width: 44, height: 44, border: 0, borderRadius: 8, background: 'transparent',
                      color: C.dim, fontSize: 15, cursor: 'pointer', fontFamily: 'inherit' }}>✕</button>
                </div>
                <div style={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.25 }}>{me?.businessName ?? 'Магазин'}</div>
                <div style={{ fontSize: 13, color: C.dim, marginTop: 3 }}>
                  {me ? (me.isOwner ? 'Владелец' : me.roleCode) : '…'}
                </div>
              </div>
              <nav style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 14px' }}>
                {favs.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase',
                      color: '#A5A99E', padding: '4px 10px 6px' }}>Закреплённое</div>
                    {favs.map((href) => (
                      <a key={href} href={href} style={{ display: 'flex', alignItems: 'center', gap: 8,
                        minHeight: 44, padding: '0 10px', borderRadius: 8, fontSize: 15, textDecoration: 'none',
                        color: path?.startsWith(href) ? C.accentDark : C.prose,
                        background: path?.startsWith(href) ? '#E8F1EC' : 'transparent' }}>★ {label(href)}</a>
                    ))}
                  </>
                )}
                {NAV.map((g) => (
                  <div key={g.label}>
                    <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase',
                      color: '#A5A99E', padding: '14px 10px 6px' }}>{g.label}</div>
                    {g.items.map(([href, text]) => {
                      const on = path?.startsWith(href);
                      return (
                        <a key={href} href={href} style={{ display: 'flex', alignItems: 'center', gap: 8,
                          minHeight: 44, padding: '0 10px', borderRadius: 8, fontSize: 15, textDecoration: 'none',
                          color: on ? C.accentDark : C.prose, background: on ? '#E8F1EC' : 'transparent',
                          fontWeight: on ? 500 : 400 }}>
                          <span style={{ flex: 1 }}>{text}</span>
                          {href === '/ai' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.gold }} />}
                        </a>
                      );
                    })}
                  </div>
                ))}
              </nav>
              <div style={{ padding: '12px 16px 16px', borderTop: `1px solid ${C.lineIn}`,
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

        {find && <FindWindow
          narrow value={q} onChange={setQ} inputRef={qRef}
          sections={sections} goods={goods} recent={recent} label={label}
          onClose={() => { setFind(false); setQ(''); }} />}

        <main style={{ padding: '18px 16px 56px' }}>{children}</main>
      </div>
    );
  }

  /* ── Компьютер: меню наверху ───────────────────────────────────────── */

  const group = NAV.find((g) => g.label === menu);

  return (
    <div style={{ minHeight: '100vh' }}>
      <header data-no-print="" style={{ position: 'sticky', top: 0, zIndex: 30, background: C.card,
        borderBottom: `1px solid ${C.line}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 56, padding: '0 18px' }}>
          {logo}
          <nav style={{ display: 'flex', alignItems: 'center', gap: 1, flex: '0 0 auto', marginRight: 18 }}>
            {NAV.map((g) => {
              const on = g.items.some(([href]) => path?.startsWith(href));
              const open = menu === g.label;
              const single = g.items.length === 1;
              const style: any = {
                display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 36, padding: '0 10px',
                border: 0, borderRadius: 8, cursor: 'pointer', fontSize: 14, whiteSpace: 'nowrap',
                flex: '0 0 auto', fontFamily: 'inherit', textDecoration: 'none',
                background: open ? '#E8F1EC' : on ? '#F1F1EA' : 'transparent',
                color: open || on ? C.accentDark : C.prose, fontWeight: on ? 500 : 400,
              };
              return single ? (
                <a key={g.label} href={g.items[0][0]} style={style}>{g.label}</a>
              ) : (
                <button key={g.label} onClick={() => { setMenu(open ? '' : g.label); setAlerts(false); }} style={style}>
                  {g.label}
                  {g.items.some(([href]) => href === '/ai') && (
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.gold }} />
                  )}
                </button>
              );
            })}
          </nav>
          {searchButton}
          <div style={{ flex: 1, minWidth: 12 }} />
          {bell}
          <button onClick={() => setHelp(true)} title="Справка и горячие клавиши"
            style={{ width: 38, height: 38, flex: '0 0 38px', border: `1px solid ${C.line}`, borderRadius: 8,
              background: C.card, cursor: 'pointer', fontSize: 15, color: C.dim, fontFamily: 'inherit' }}>?</button>
          {user}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, height: 44, padding: '0 18px',
          background: C.sunken, borderTop: `1px solid ${C.lineIn}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: C.dim, whiteSpace: 'nowrap' }}>
            <span style={{ fontWeight: 500, color: C.prose }}>{me?.businessName ?? 'Магазин'}</span>
            <span style={{ color: '#C9C9BE' }}>/</span>
            <span>{current ? GROUP_OF[current[0]] : 'Кабинет'}</span>
            <span style={{ color: '#C9C9BE' }}>/</span>
            <span style={{ color: C.text, fontWeight: 500 }}>{current?.[1] ?? 'Показатели'}</span>
          </div>
          {current && (
            <button onClick={() => toggleFav(current[0])} title="Закрепить раздел наверху"
              style={{ minHeight: 28, padding: '0 8px', border: 0, borderRadius: 8, background: 'transparent',
                cursor: 'pointer', fontSize: 12.5, whiteSpace: 'nowrap', fontFamily: 'inherit',
                color: favs.includes(current[0]) ? C.amber : C.dim }}>
              {favs.includes(current[0]) ? '★ Закреплено' : '☆ Закрепить'}
            </button>
          )}
          {favs.length > 0 && (
            <>
              <div style={{ width: 1, height: 18, background: C.line, flex: '0 0 1px' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                {favs.map((href) => (
                  <a key={href} href={href} style={{ minHeight: 28, display: 'inline-flex', alignItems: 'center',
                    padding: '0 11px', border: `1px solid ${C.line}`, borderRadius: 999, background: C.card,
                    fontSize: 12.5, color: C.prose, whiteSpace: 'nowrap', textDecoration: 'none' }}>★ {label(href)}</a>
                ))}
              </div>
            </>
          )}
          <div style={{ flex: 1, minWidth: 24 }} />
          {recent.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: C.faint, whiteSpace: 'nowrap', marginRight: 6 }}>Недавнее</span>
              {recent.filter((h) => h !== current?.[0]).slice(0, 3).map((href) => (
                <a key={href} href={href} style={{ minHeight: 28, display: 'inline-flex', alignItems: 'center',
                  padding: '0 10px', borderRadius: 999, fontSize: 12.5, color: C.dim, whiteSpace: 'nowrap',
                  textDecoration: 'none' }}>{label(href)}</a>
              ))}
            </div>
          )}
        </div>

        {group && (
          <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 29, background: C.card,
            borderBottom: `1px solid ${C.line}`, boxShadow: '0 18px 34px rgba(23,33,29,.12)',
            padding: '18px 18px 20px', display: 'flex', gap: 26 }}>
            <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(3, 232px)',
              justifyContent: 'start', gap: '2px 10px', alignContent: 'start' }}>
              {group.items.map(([href, text]) => {
                const on = path?.startsWith(href);
                return (
                  <a key={href} href={href} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 40,
                    padding: '0 11px', borderRadius: 8, fontSize: 14.5, textDecoration: 'none',
                    background: on ? '#E8F1EC' : 'transparent', color: on ? C.accentDark : C.text,
                    fontWeight: on ? 500 : 400 }}>
                    <span style={{ flex: 1 }}>{text}</span>
                    {href === '/ai' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.gold }} />}
                  </a>
                );
              })}
            </div>
            <div style={{ flex: '0 0 236px', borderLeft: `1px solid ${C.lineIn}`, paddingLeft: 22 }}>
              <div style={{ fontSize: 11.5, letterSpacing: '.1em', textTransform: 'uppercase', color: C.faint,
                marginBottom: 10 }}>О группе</div>
              <div style={{ fontSize: 13, color: C.prose, lineHeight: 1.55 }}>{group.note}</div>
            </div>
          </div>
        )}

        {alertsPanel}
      </header>

      {find && <FindWindow
        value={q} onChange={setQ} inputRef={qRef}
        sections={sections} goods={goods} recent={recent} label={label}
        onClose={() => { setFind(false); setQ(''); }} />}

      {help && <HelpWindow onClose={() => setHelp(false)} />}

      <main style={{ padding: '24px 26px 48px', maxWidth: 1240 }}>{children}</main>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ОКНО ПОИСКА

   Разделы ищутся на месте — это мгновенно и без запросов. Товары ищет
   существующий /goods?q=. Товар открывается своим разделом: отдельного
   адреса у карточки товара в кабинете пока нет.
   ═══════════════════════════════════════════════════════════════════ */
function FindWindow({ value, onChange, inputRef, sections, goods, recent, label, onClose, narrow }: {
  value: string; onChange: (v: string) => void; inputRef: any;
  sections: [string, string][]; goods: any[]; recent: string[];
  label: (href: string) => string; onClose: () => void; narrow?: boolean;
}) {
  const empty = value.trim().length > 0 && sections.length === 0 && goods.length === 0;
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(23,33,29,.44)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: narrow ? 0 : '9vh 20px 20px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: narrow ? '100%' : 660, maxWidth: '100%',
        maxHeight: narrow ? '100%' : '78vh', background: C.card, border: `1px solid ${C.line}`,
        borderRadius: narrow ? 0 : 14, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        boxShadow: '0 30px 70px rgba(23,33,29,.28)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
          borderBottom: `1px solid ${C.lineIn}` }}>
          <svg width="17" height="17" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="6" cy="6" r="4.4" stroke={C.dim} strokeWidth="1.4" />
            <path d="M9.4 9.4 L12.4 12.4" stroke={C.dim} strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input ref={inputRef} value={value} onChange={(e) => onChange(e.target.value)}
            placeholder="Товар или раздел"
            style={{ flex: 1, height: 44, border: 0, outline: 'none', fontSize: 18, color: C.text,
              background: 'transparent' }} />
          <button onClick={onClose} style={{ minHeight: 38, padding: '0 10px', border: `1px solid ${C.line}`,
            borderRadius: 8, background: C.sunken, color: C.dim, fontSize: 12.5, cursor: 'pointer',
            fontFamily: MONO }}>Esc</button>
        </div>

        <div style={{ overflowY: 'auto' }}>
          {!value.trim() && recent.length > 0 && (
            <>
              <Head text="Недавние разделы" />
              {recent.map((href) => <Row key={href} href={href} title={label(href)} sub="раздел кабинета" />)}
            </>
          )}
          {goods.length > 0 && (
            <>
              <Head text={`Товары · ${goods.length}`} />
              {goods.map((g: any) => (
                <Row key={g.id} href="/goods" title={g.name} sub="открыть раздел «Товары»" />
              ))}
            </>
          )}
          {sections.length > 0 && (
            <>
              <Head text={`Разделы · ${sections.length}`} />
              {sections.map(([href, text]) => <Row key={href} href={href} title={text} sub={href} />)}
            </>
          )}
          {empty && (
            <div style={{ padding: '40px 18px', textAlign: 'center', fontSize: 14.5, color: C.dim, lineHeight: 1.55 }}>
              По запросу «{value}» ничего не нашлось. Поиск смотрит товары и разделы кабинета.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 18, padding: '11px 16px', background: C.sunken,
          borderTop: `1px solid ${C.lineIn}`, fontSize: 12.5, color: C.dim, whiteSpace: 'nowrap' }}>
          <span>Ctrl K — из любого раздела</span><span>Esc — закрыть</span>
        </div>
      </div>
    </div>
  );
}

function Head({ text }: { text: string }) {
  return (
    <div style={{ padding: '12px 16px 6px', background: C.sunken, borderBottom: `1px solid ${C.lineIn}`,
      fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase', color: C.faint }}>{text}</div>
  );
}

function Row({ href, title, sub }: { href: string; title: string; sub: string }) {
  return (
    <a href={href} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', minHeight: 44,
      borderBottom: `1px solid ${C.lineIn}`, textDecoration: 'none' }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, color: C.text, lineHeight: 1.35 }}>{title}</span>
        <span style={{ display: 'block', fontSize: 12.5, color: C.dim, marginTop: 3, fontFamily: MONO }}>{sub}</span>
      </span>
      <span style={{ fontSize: 12.5, color: C.faint, whiteSpace: 'nowrap' }}>Открыть →</span>
    </a>
  );
}

/** Горячие клавиши. Здесь перечислено только то, что действительно
 *  работает: обещанная и не работающая клавиша хуже отсутствующей. */
function HelpWindow({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ['Ctrl + K', 'Поиск по товарам и разделам из любого места'],
    ['1 … 6', 'Открыть верхний пункт меню: Показатели, Деньги, Товар, Клиенты, Каналы, Управление'],
    ['?', 'Это окно'],
    ['Esc', 'Закрыть поиск, меню, окно'],
  ];
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
        <div style={{ padding: '8px 20px 18px' }}>
          {keys.map(([k, d]) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '11px 0',
              borderBottom: `1px solid ${C.lineIn}` }}>
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.text, border: `1px solid ${C.line}`,
                borderRadius: 6, padding: '4px 8px', background: C.sunken, whiteSpace: 'nowrap' }}>{k}</span>
              <span style={{ fontSize: 14.5, color: C.prose }}>{d}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
