'use client';
/**
 * Каркас кабинета: слева навигация по разделам, внизу — «живой» статус:
 * подписка и синхронизация касс. Это сигнатура продукта: кабинет всегда
 * честно показывает, всё ли в порядке с деньгами и данными.
 *
 * ЧТО ИЗМЕНИЛОСЬ ВО ВНЕШНЕМ ВИДЕ
 *
 * 1. Разделы собраны в пять смысловых групп вместо списка из 21 пункта.
 *    Порядок внутри групп прежний, ни один раздел не потерян и не
 *    переименован. Заголовки групп — подписи, а не кнопки: нажимать нечего,
 *    сворачивать нечего. Владелец ищет «где посмотреть долги» — и идёт в
 *    «Клиенты», а не читает 21 строку подряд.
 *
 * 2. AI-помощник помечен золотой точкой. Это единственный раздел с другим
 *    акцентным цветом: единственное, чего нет ни у UMAG, ни у Wipon, ни у
 *    МоегоСклада. Точка — не украшение, а указатель на отличие продукта.
 *
 * 3. НА ТЕЛЕФОНЕ — ВЫЕЗЖАЮЩЕЕ МЕНЮ ПО КНОПКЕ. Выбор объясняю, потому что
 *    переносить разделы вам:
 *      • нижняя панель вмещает 4–5 разделов, а их 21: шестнадцать пришлось
 *        бы спрятать в «Ещё» — то есть всё равно сделать меню, только с
 *        лишним шагом и потерей места внизу экрана;
 *      • выезжающее меню показывает ВСЕ разделы теми же пятью группами и в
 *        том же порядке, что на компьютере. Человек учится один раз;
 *      • для быстрого взгляда с телефона у нас есть отдельный /m — там
 *        выручка, что закончилось и открытые точки. Полный кабинет с
 *        телефона открывают редко и по делу: удобство «в один палец» здесь
 *        не главное, полнота — главное.
 *    Ширина 288 px, пункты 44 px, меню закрывается по выбору, по фону и по
 *    Esc. Пока меню открыто, страница под ним не прокручивается.
 */
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api, tokens } from '../../lib/api';
import { C, Badge } from '../../lib/ui';

/** Пять смысловых групп. Плоский список остаётся внутри — порядок разделов
 *  не менялся, изменилась только его подача. */
const NAV: [string, [string, string][]][] = [
  ['Деньги и торговля', [
    ['/dashboard', 'Показатели'],
    ['/reports', 'Отчёты'],
    ['/finance', 'Финансы'],
    ['/taxes', 'Налоги'],
    ['/payroll', 'Зарплата'],
  ]],
  ['Товар и склад', [
    ['/goods', 'Товары'],
    ['/stock', 'Склад'],
    ['/techcards', 'Техкарты'],
    ['/marking', 'Маркировка'],
    ['/excise', 'Акциз (алкоголь)'],
  ]],
  ['Клиенты', [
    ['/contragents', 'Контрагенты'],
    ['/loyalty', 'Лояльность'],
    ['/certificates', 'Сертификаты'],
    ['/rfm', 'RFM-анализ'],
    ['/wholesale', 'Опт'],
  ]],
  ['Каналы и помощники', [
    ['/marketplace', 'Kaspi магазин'],
    ['/ai', 'AI-помощник'],
    ['/automation', 'Автоматизация'],
  ]],
  ['Управление', [
    ['/employees', 'Сотрудники'],
    ['/stores', 'Точки и кассы'],
    // Подписка вынесена из «Настроек» отдельным разделом: пять вкладок там
    // настраивают один раз при запуске, а деньги смотрят каждый месяц —
    // владелец искал её не там. Право у раздела своё: billing, не settings.
    ['/billing', 'Подписка'],
    ['/settings', 'Настройки'],
  ]],
];

const FLAT = NAV.reduce<[string, string][]>((a, g) => a.concat(g[1]), []);

export default function CabLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [me, setMe] = useState<any>(null);
  const [access, setAccess] = useState<any>(null);
  const [sync, setSync] = useState<any>(null);
  const [err, setErr] = useState('');
  const [narrow, setNarrow] = useState(false);
  const [menu, setMenu] = useState(false);

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

  useEffect(() => { setMenu(false); }, [path]);   // перешли в раздел — меню закрылось

  useEffect(() => {
    if (!menu) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('keydown', esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';   // страница под меню не едет
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = prev; };
  }, [menu]);

  if (err) {
    return (
      <main style={{ maxWidth: 420, margin: '80px auto', textAlign: 'center', padding: '0 20px' }}>
        <p style={{ color: C.dim, fontSize: 15 }}>Сессия не активна.</p>
        <a href="/login" style={{ color: C.accentDark, fontSize: 15 }}>Войти в кабинет</a>
      </main>
    );
  }

  const current = FLAT.find(([href]) => path?.startsWith(href));

  const nav = (
    <nav style={{ flex: 1, padding: '12px 10px 8px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {NAV.map(([group, items]) => (
        <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase',
            color: '#A5A99E', padding: '4px 10px 6px' }}>{group}</div>
          {items.map(([href, label]) => {
            const on = path?.startsWith(href);
            return (
              <a key={href} href={href}
                style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: narrow ? 44 : 34,
                  padding: narrow ? '10px 10px' : '7px 10px', borderRadius: 8, fontSize: 14, textDecoration: 'none',
                  color: on ? C.accentDark : C.prose, background: on ? '#E8F1EC' : 'transparent',
                  fontWeight: on ? 500 : 400 }}>
                <span style={{ flex: 1 }}>{label}</span>
                {/* золотая точка — единственный раздел, которого нет у конкурентов */}
                {href === '/ai' && <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.gold }} />}
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );

  /** Живой статус: одного взгляда хватает понять, всё ли хорошо. */
  const status = (
    <div style={{ padding: '14px 16px 16px', borderTop: `1px solid ${C.lineIn}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>{access
        ? access.canSell
          ? <Badge tone="ok">Подписка: {access.status === 'trial' ? 'пробный период' : 'активна'}</Badge>
          : <Badge tone="bad">{access.reason ?? 'Продажи закрыты'}</Badge>
        : <Badge tone="dim">Подписка…</Badge>}
      </div>
      <div>{sync
        ? sync.ready ? <Badge tone="ok">Кассы синхронизированы</Badge> : <Badge tone="warn">Есть неотданные данные</Badge>
        : <Badge tone="dim">Синхронизация…</Badge>}
      </div>
      {/* Подписка теперь свой раздел: статус показывает проблему —
          ссылка говорит, куда идти её решать. */}
      {access && !access.canSell && (
        <a href="/billing" style={{ color: C.accentDark, fontSize: 13, minHeight: 34, display: 'flex', alignItems: 'center' }}>
          Продлить подписку →
        </a>
      )}
      <a href="/login" onClick={() => tokens.clear()}
        style={{ color: C.dim, fontSize: 13, minHeight: 34, display: 'flex', alignItems: 'center' }}>Выйти</a>
    </div>
  );

  const head = (
    <div style={{ padding: '20px 18px 16px', borderBottom: `1px solid ${C.lineIn}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <div style={{ width: 26, height: 26, borderRadius: 7, background: C.accent, color: '#fff', fontSize: 14,
          fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>Т</div>
        <div style={{ fontSize: 13, fontWeight: 500, letterSpacing: '.16em', color: C.dim }}>ТАБЫС</div>
      </div>
      <div style={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.25 }}>{me?.businessName ?? 'Магазин'}</div>
      <div style={{ fontSize: 13, color: C.dim, marginTop: 3 }}>
        {me ? (me.isOwner ? 'Владелец' : me.roleCode) : '…'}
      </div>
    </div>
  );

  // ── Телефон: шапка с кнопкой и выезжающее меню ──────────────────────
  if (narrow) {
    return (
      <div style={{ minHeight: '100vh' }}>
        <header data-no-print="" style={{ position: 'sticky', top: 0, zIndex: 30, background: C.card,
          borderBottom: `1px solid ${C.line}`, height: 56, display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px' }}>
          <button onClick={() => setMenu(true)} aria-label="Разделы"
            style={{ width: 44, height: 44, border: 0, background: 'transparent', cursor: 'pointer',
              display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5, padding: '0 11px' }}>
            <span style={{ height: 1.5, background: C.text, borderRadius: 1 }} />
            <span style={{ height: 1.5, background: C.text, borderRadius: 1 }} />
            <span style={{ height: 1.5, background: C.text, borderRadius: 1 }} />
          </button>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {current?.[1] ?? 'Кабинет'}
            </div>
            <div style={{ fontSize: 12, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {me?.businessName ?? 'Магазин'}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {access && !access.canSell && <Badge tone="bad">Продажи закрыты</Badge>}
        </header>

        {menu && (
          <>
            <div onClick={() => setMenu(false)}
              style={{ position: 'fixed', inset: 0, background: 'rgba(23,33,29,.42)', zIndex: 40 }} />
            <aside style={{ position: 'fixed', top: 0, left: 0, bottom: 0, width: 288, maxWidth: '86vw', zIndex: 41,
              background: C.card, borderRight: `1px solid ${C.line}`, display: 'flex', flexDirection: 'column',
              boxShadow: '0 0 40px rgba(23,33,29,.18)' }}>
              {head}
              {nav}
              {status}
            </aside>
          </>
        )}

        <main style={{ padding: '18px 16px 56px' }}>{children}</main>
      </div>
    );
  }

  // ── Компьютер: постоянное меню слева ────────────────────────────────
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside data-no-print="" style={{ width: 252, flex: '0 0 252px', background: C.card,
        borderRight: `1px solid ${C.line}`, display: 'flex', flexDirection: 'column',
        position: 'sticky', top: 0, height: '100vh' }}>
        {head}
        {nav}
        {status}
      </aside>
      <main style={{ flex: 1, minWidth: 0, padding: '28px 32px 64px', maxWidth: 1360 }}>{children}</main>
    </div>
  );
}
