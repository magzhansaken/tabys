'use client';
/**
 * САЙТ (не кабинет). Общие части публичных страниц: палитра, шапка, футер,
 * язык, аккордеон и страницы «под тип магазина».
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ lib/ui.tsx
 *   ui.tsx — дизайн-система кабинета. Сайт открывает человек, который ещё не
 *   наш клиент: тянуть код кабинета на публичную страницу не нужно. Значения
 *   цветов те же, что в ui.tsx, — намеренное дублирование.
 *
 * ЛОВУШКИ ЭТОГО КОДА (закреплены сторожами)
 *   • localStorage — только внутри useEffect. Обращение при отрисовке роняет сборку.
 *   • <form> не используется вовсе: отправка — обработчик на кнопке.
 *   • Tailwind не подключён, стили инлайновые. Шрифт локальный: var(--font-sans).
 *
 * ТЕЛЕФОН
 *   Половина посетителей. Поля ввода 16 px (иначе iOS увеличивает страницу),
 *   кнопки от 44 px, сетки на auto-fit/minmax — при 390 px ничего не вылезает.
 *   Казахский текст на 15–20% длиннее русского: кнопки nowrap, заголовки
 *   свёрстаны на длинном варианте.
 */
import { useEffect, useState } from 'react';

export type Lang = 'ru' | 'kk';

export const C = {
  ink: '#17211D', prose: '#3C443E', dim: '#6B7167', faint: '#9A9E95',
  brand: '#0B6B4F', brandDark: '#085340', brandTint: '#E8F1EC',
  gold: '#B8863B', goldInk: '#8A5F1B', goldTint: '#F7EFDF', goldPaper: '#FFFCF6', goldLine: '#E8DCC3',
  bad: '#A32C1E', bg: '#F5F5F1', card: '#FFFFFF', line: '#E4E4DD', lineIn: '#EFEFE9', sunken: '#FAFAF6',
  formBg: '#212C27', formLine: '#3A423C',
};

export const mono = 'var(--font-mono), monospace';

export const S = {
  wrap: { maxWidth: 1080, margin: '0 auto', padding: '0 clamp(16px,4vw,24px)' } as any,
  sec: { maxWidth: 1080, margin: '0 auto', padding: 'clamp(44px,6vw,64px) clamp(16px,4vw,24px) 0' } as any,
  h1: { fontSize: 'clamp(29px,4.8vw,40px)', fontWeight: 600, letterSpacing: '-.022em', lineHeight: 1.16, margin: '12px 0 0', textWrap: 'pretty' } as any,
  h2: { fontSize: 'clamp(24px,4vw,30px)', fontWeight: 600, letterSpacing: '-.018em', lineHeight: 1.22, margin: '10px 0 22px', textWrap: 'pretty' } as any,
  kicker: { fontFamily: mono, fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: C.dim } as any,
  card: { background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: '20px 22px' } as any,
  btn: { background: C.brand, color: '#fff', border: 0, borderRadius: 10, minHeight: 52, padding: '0 26px', fontSize: 16.5, fontWeight: 500,
    cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap', fontFamily: 'inherit' } as any,
  ghost: { background: C.card, color: C.ink, border: '1px solid #D8D8CF', borderRadius: 10, minHeight: 52, padding: '0 24px', fontSize: 16.5, fontWeight: 500,
    cursor: 'pointer', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap', fontFamily: 'inherit' } as any,
  input: { padding: '0 14px', height: 52, border: `1px solid ${C.formLine}`, borderRadius: 10, fontSize: 16, width: '100%', boxSizing: 'border-box',
    background: C.formBg, color: '#fff', outline: 'none', fontFamily: 'inherit' } as any,
  tag: { fontFamily: mono, fontSize: 11.5, letterSpacing: '.08em', color: C.brand, background: C.brandTint, display: 'inline-block', padding: '4px 9px', borderRadius: 6 } as any,
};

/** Язык. Читается из localStorage ТОЛЬКО в useEffect — иначе сборка падает. */
export function useLang(): [Lang, () => void] {
  const [lang, setLang] = useState<Lang>('ru');
  useEffect(() => {
    try {
      const v = localStorage.getItem('tabys_site_lang');
      if (v === 'ru' || v === 'kk') setLang(v);
    } catch (e) { /* приватный режим — остаёмся на русском */ }
  }, []);
  const toggle = () => {
    const next: Lang = lang === 'ru' ? 'kk' : 'ru';
    setLang(next);
    try { localStorage.setItem('tabys_site_lang', next); } catch (e) { /* не критично */ }
  };
  return [lang, toggle];
}

/** Телефон/десктоп. matchMedia — тоже только после отрисовки. */
export function useMobile(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

const NAV = {
  ru: { home: 'Главная', features: 'Возможности', kassa: 'Касса', prices: 'Цены', stores: 'Магазинам', faq: 'Вопросы', login: 'Войти', cabinet: 'Кабинет', start: 'Начать бесплатно', register: 'Регистрация' },
  kk: { home: 'Басты бет', features: 'Мүмкіндіктер', kassa: 'Касса', prices: 'Бағалар', stores: 'Дүкендерге', faq: 'Сұрақтар', login: 'Кіру', cabinet: 'Кабинет', start: 'Тегін бастау', register: 'Тіркелу' },
};

export const STORE_LINKS = [
  { href: '/produktovyj-magazin', ru: 'Продуктовый магазин', kk: 'Азық-түлік дүкені' },
  { href: '/magazin-napitkov', ru: 'Разливные напитки', kk: 'Құйма сусындар' },
  { href: '/magazin-odezhdy', ru: 'Магазин одежды', kk: 'Киім дүкені' },
  { href: '/kofejnya', ru: 'Кофейня при магазине', kk: 'Дүкен жанындағы кофейня' },
  { href: '/hoztovary', ru: 'Хозтовары и стройка', kk: 'Шаруашылық тауарлары' },
];

/** Шапка. Переключатель языка и переходы на вход/регистрацию — логика не тронута. */
export function SiteHeader({ lang, onLang, active }: { lang: Lang; onLang: () => void; active?: string }) {
  const n = NAV[lang];
  const mobile = useMobile();
  const [open, setOpen] = useState(false);
  const [authed, setAuthed] = useState(false);
  useEffect(() => { try { setAuthed(!!localStorage.getItem('access')); } catch (e) { /* ничего */ } }, []);

  const items = [
    { href: '/features', label: n.features, key: 'features' },
    { href: '/kassa', label: n.kassa, key: 'kassa' },
    { href: '/prices', label: n.prices, key: 'prices' },
    { href: '/produktovyj-magazin', label: n.stores, key: 'stores' },
    { href: '/faq', label: n.faq, key: 'faq' },
  ];

  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 60, background: 'rgba(255,255,255,.95)', backdropFilter: 'blur(10px)', borderBottom: `1px solid ${C.line}` }}>
      <div style={{ ...S.wrap, display: 'flex', alignItems: 'center', gap: 10, height: 64 }}>
        <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 9, textDecoration: 'none', color: C.ink }}>
          <div style={{ width: 27, height: 27, borderRadius: 7, background: C.brand, color: '#fff', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>Т</div>
          <b style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-.01em' }}>Табыс</b>
        </a>
        {!mobile && (
          <nav style={{ display: 'flex', alignItems: 'center', gap: 'clamp(10px,2vw,22px)', marginLeft: 'clamp(8px,3vw,28px)' }}>
            {items.map((i) => (
              <a key={i.key} href={i.href} style={{ color: active === i.key ? C.brand : C.prose, textDecoration: 'none', fontSize: 14.5, fontWeight: active === i.key ? 600 : 500 }}>{i.label}</a>
            ))}
          </nav>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={onLang} data-testid="lang-switch"
          style={{ ...S.ghost, minHeight: 44, minWidth: 56, padding: '0 12px', fontSize: 13.5, color: C.prose }}>
          {lang === 'ru' ? 'ҚАЗ' : 'РУС'}
        </button>
        {!mobile && (
          <>
            <a href={authed ? '/dashboard' : '/login'} style={{ ...S.ghost, minHeight: 44, padding: '0 16px', fontSize: 14.5 }}>{authed ? n.cabinet : n.login}</a>
            <a href="/register" style={{ ...S.btn, minHeight: 44, padding: '0 17px', fontSize: 14.5 }}>{n.start}</a>
          </>
        )}
        {mobile && (
          <button onClick={() => setOpen(!open)} aria-label="Меню"
            style={{ width: 44, height: 44, background: C.card, border: '1px solid #D8D8CF', borderRadius: 10, cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <span style={{ display: 'block', width: 17, height: 2, background: C.ink, borderRadius: 2 }} />
            <span style={{ display: 'block', width: 17, height: 2, background: C.ink, borderRadius: 2 }} />
            <span style={{ display: 'block', width: 17, height: 2, background: C.ink, borderRadius: 2 }} />
          </button>
        )}
      </div>
      {mobile && open && (
        <div style={{ position: 'absolute', top: 64, left: 0, right: 0, background: C.card, borderBottom: `1px solid ${C.line}`, boxShadow: '0 16px 32px rgba(23,33,29,.08)', display: 'flex', flexDirection: 'column', padding: '8px 0 16px' }}>
          <a href="/" style={{ color: C.ink, textDecoration: 'none', fontSize: 16, fontWeight: 500, minHeight: 48, display: 'flex', alignItems: 'center', padding: '0 24px' }}>{n.home}</a>
          {items.map((i) => (
            <a key={i.key} href={i.href} style={{ color: active === i.key ? C.brand : C.ink, textDecoration: 'none', fontSize: 16, fontWeight: active === i.key ? 600 : 500, minHeight: 48, display: 'flex', alignItems: 'center', padding: '0 24px' }}>{i.label}</a>
          ))}
          <div style={{ display: 'flex', gap: 10, padding: '10px 24px 0' }}>
            <a href={authed ? '/dashboard' : '/login'} style={{ ...S.ghost, flex: 1, minHeight: 48, fontSize: 15 }}>{authed ? n.cabinet : n.login}</a>
            <a href="/register" style={{ ...S.btn, flex: 1, minHeight: 48, fontSize: 15, padding: 0 }}>{n.start}</a>
          </div>
        </div>
      )}
    </header>
  );
}

export function SiteFooter({ lang, full }: { lang: Lang; full?: boolean }) {
  const n = NAV[lang];
  const t = lang === 'ru'
    ? { slogan: 'Тәртіп — табыстың басы. Сделано для магазинов Казахстана.', data: 'Данные хранятся в Казахстане', product: 'Продукт', stores: 'Магазинам', account: 'Аккаунт' }
    : { slogan: 'Тәртіп — табыстың басы. Қазақстан дүкендері үшін жасалған.', data: 'Деректер Қазақстанда сақталады', product: 'Өнім', stores: 'Дүкендерге', account: 'Аккаунт' };

  return (
    <footer style={{ borderTop: `1px solid ${C.line}`, background: C.sunken }}>
      {full && (
        <div style={{ ...S.wrap, padding: 'clamp(36px,6vw,52px) clamp(16px,4vw,24px) 20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 32 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{ width: 27, height: 27, borderRadius: 7, background: C.brand, color: '#fff', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>Т</div>
              <b style={{ fontSize: 17, fontWeight: 600 }}>Табыс</b>
            </div>
            <p style={{ fontSize: 13.5, color: C.dim, lineHeight: 1.6, margin: '12px 0 0', maxWidth: '30ch' }}>{t.slogan}</p>
            <p style={{ fontSize: 13, color: C.faint, margin: '10px 0 0' }}>{t.data}</p>
          </div>
          <div>
            <div style={{ fontFamily: mono, fontSize: 11.5, letterSpacing: '.12em', textTransform: 'uppercase', color: C.faint, marginBottom: 12 }}>{t.product}</div>
            <div style={{ display: 'grid', gap: 9 }}>
              <a href="/features" style={{ color: C.prose, textDecoration: 'none', fontSize: 14 }}>{n.features}</a>
              <a href="/kassa" style={{ color: C.prose, textDecoration: 'none', fontSize: 14 }}>{n.kassa}</a>
              <a href="/prices" style={{ color: C.prose, textDecoration: 'none', fontSize: 14 }}>{n.prices}</a>
              <a href="/faq" style={{ color: C.prose, textDecoration: 'none', fontSize: 14 }}>{n.faq}</a>
            </div>
          </div>
          <div>
            <div style={{ fontFamily: mono, fontSize: 11.5, letterSpacing: '.12em', textTransform: 'uppercase', color: C.faint, marginBottom: 12 }}>{t.stores}</div>
            <div style={{ display: 'grid', gap: 9 }}>
              {STORE_LINKS.map((s) => (
                <a key={s.href} href={s.href} style={{ color: C.prose, textDecoration: 'none', fontSize: 14 }}>{lang === 'ru' ? s.ru : s.kk}</a>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontFamily: mono, fontSize: 11.5, letterSpacing: '.12em', textTransform: 'uppercase', color: C.faint, marginBottom: 12 }}>{t.account}</div>
            <div style={{ display: 'grid', gap: 9 }}>
              <a href="/login" style={{ color: C.prose, textDecoration: 'none', fontSize: 14 }}>{n.login}</a>
              <a href="/register" style={{ color: C.prose, textDecoration: 'none', fontSize: 14 }}>{n.register}</a>
            </div>
          </div>
        </div>
      )}
      <div style={{ ...S.wrap, padding: full ? '16px clamp(16px,4vw,24px) 28px' : '24px clamp(16px,4vw,24px) 28px', borderTop: full ? `1px solid ${C.lineIn}` : 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ color: C.faint, fontSize: 13 }}>© {new Date().getFullYear()} Табыс · Тәртіп — табыстың басы</span>
        {!full && (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            <a href="/" style={{ color: C.dim, textDecoration: 'none', fontSize: 13.5 }}>{n.home}</a>
            <a href="/features" style={{ color: C.dim, textDecoration: 'none', fontSize: 13.5 }}>{n.features}</a>
            <a href="/prices" style={{ color: C.dim, textDecoration: 'none', fontSize: 13.5 }}>{n.prices}</a>
            <a href="/login" style={{ color: C.dim, textDecoration: 'none', fontSize: 13.5 }}>{n.login}</a>
          </div>
        )}
      </div>
    </footer>
  );
}

/** Аккордеон вопросов. Открыт один — на телефоне это короче и понятнее. */
export function Faq({ items, startOpen = -1 }: { items: { q: string; a: string }[]; startOpen?: number }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div style={{ borderTop: `1px solid ${C.line}` }}>
      {items.map((it, i) => (
        <div key={it.q} style={{ borderBottom: `1px solid ${C.line}` }}>
          <button onClick={() => setOpen(open === i ? -1 : i)}
            style={{ width: '100%', minHeight: 56, padding: '15px 0', background: 'transparent', border: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, cursor: 'pointer', textAlign: 'left', color: C.ink, fontFamily: 'inherit' }}>
            <span style={{ fontSize: 16, fontWeight: 500, lineHeight: 1.4 }}>{it.q}</span>
            <span style={{ fontSize: 22, color: C.faint, lineHeight: 1, flexShrink: 0 }}>{open === i ? '−' : '+'}</span>
          </button>
          {open === i && (
            <p style={{ color: C.prose, fontSize: 14.5, lineHeight: 1.65, margin: '0 0 20px', maxWidth: '68ch' }}>{it.a}</p>
          )}
        </div>
      ))}
    </div>
  );
}

/** Тёмный блок «попробуйте» — повторяется на всех страницах, кроме главной. */
export function CtaBand({ lang, title, sub }: { lang: Lang; title: string; sub: string }) {
  const n = NAV[lang];
  const lead = lang === 'ru' ? 'Оставить заявку' : 'Өтінім қалдыру';
  return (
    <section style={{ ...S.sec, paddingBottom: 'clamp(56px,8vw,84px)' }}>
      <div style={{ background: C.ink, borderRadius: 16, padding: 'clamp(28px,5vw,44px)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: 'clamp(22px,3.6vw,28px)', fontWeight: 600, letterSpacing: '-.018em', lineHeight: 1.25, margin: 0, color: '#fff', textWrap: 'pretty' } as any}>{title}</h2>
          <p style={{ fontSize: 14.5, color: '#C6CCC4', margin: '10px 0 0', lineHeight: 1.6, maxWidth: '52ch' }}>{sub}</p>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <a href="/register" style={{ ...S.btn, fontSize: 16 }}>{n.start}</a>
          <a href="/#lead" style={{ ...S.ghost, background: 'transparent', color: '#fff', borderColor: C.formLine, fontSize: 16 }}>{lead}</a>
        </div>
      </div>
    </section>
  );
}

/* ─────────────── страницы «под тип магазина» ───────────────
   Приём взят с рынка: владелец аптеки ищет «программа для аптеки» и должен
   попасть на страницу про аптеку. У каждого типа СВОЙ текст, а не копия
   главной: у продуктового — накладные и весовой товар, у напитков — акциз,
   у одежды — маркировка, у кофейни — техкарты, у хозтоваров — объём каталога. */

export type StoreType = 'продуктовый' | 'напитки' | 'одежда' | 'кофейня' | 'хозтовары';

const ST: any = {
  ru: {
    kicker: 'Под ваш тип магазина', painT: 'Знакомые проблемы', featT: 'Как решает Табыс', hlBadge: 'Сильная сторона',
    ctaTitle: 'Попробуйте на своих товарах', ctaSub: '14 дней бесплатно, потом «Старт» 6 900 ₸ или «Стандарт» 14 900 ₸ в месяц. С переездом поможем.',
    ctaStart: 'Начать бесплатно', ctaLead: 'Оставить заявку',
    types: {
      'продуктовый': {
        h1: 'Учёт для продуктового магазина',
        sub: 'Ежедневные накладные, весовой товар, очередь вечером и долги соседей — Табыс сделан ровно про это.',
        pains: [
          { t: 'Накладные — каждый день', d: 'Несколько поставщиков в неделю — это часы ручного ввода позиций.' },
          { t: 'Весовой товар', d: 'Сыр, колбасу и конфеты на глаз не пробьёшь.' },
          { t: 'Полрайона — в долг', d: 'Тетрадка теряется, лимиты никто не помнит, «я же отдавал» не проверить.' },
        ],
        feats: [
          { k: 'Фото', t: 'Накладная из фото', d: 'Сфотографировали — позиции, количества и цены разобрались сами. Недовоз и подорожание видны до проведения.' },
          { k: 'Весы', t: 'Весы Rongta', d: 'Весовой товар пробивается сам. Подключение — в пару кликов.' },
          { k: 'Долги', t: 'Долговая тетрадь в кассе', d: 'Лимит на покупателя проверяется при продаже, долг печатается на чеке. Работает офлайн.' },
          { k: 'Полка', t: 'Подсказки дозаказа', d: 'Система видит, что заканчивается, и подсказывает, что заказать поставщику.' },
        ],
        hlT: 'Приёмка за минуты, а не часы',
        hlD: 'Для магазина с ежедневными поставками накладная из фото — освобождённый час каждый день: сверка с заказом, контроль цен, новые товары черновиком. Такого больше нет ни в одной программе учёта для магазинов Казахстана.',
      },
      'напитки': {
        h1: 'Учёт для магазина разливных напитков',
        sub: 'Акциз, проверка марок и вечерняя торговля без интернета — сильные стороны Табыс.',
        pains: [
          { t: 'Марка — это риск', d: 'Продажа алкоголя с поддельной или непроверенной маркой — штраф, конфискация, лицензия.' },
          { t: 'Клоны марок', d: 'Контрафакт клонирует номера настоящих марок — глазами не отличить.' },
          { t: 'Пик — вечером', d: 'Торговля идёт вечером и в выходные — когда интернет подводит чаще всего.' },
        ],
        feats: [
          { k: 'УКМ', t: 'Проверка марки', d: 'По серии и номеру или скану штрих-кода. Ответ: подлинная или не найдена.' },
          { k: 'Клон', t: 'Защита от повторной продажи', d: 'Одна марка — один экземпляр. Вторая продажа той же марки отбивается.' },
          { k: 'Реестр', t: 'Учёт марок и журнал', d: 'Сколько на складе, продано, забраковано. Журнал всех проверок — для проверяющих.' },
          { k: 'Пиво', t: 'Пиво — в ИС МПТ', d: 'С февраля 2026 пиво маркируется. Приёмка со сверкой и вывод из оборота уже готовы.' },
        ],
        hlT: 'Акциз — наша сильная сторона',
        hlD: 'Проверка марок обычно живёт в отдельном приложении или в тарифе подороже. У нас акциз входит в тариф «Стандарт» — вместе со складом и кассой, в одном окне с продажей.',
      },
      'одежда': {
        h1: 'Учёт для магазина одежды',
        sub: 'Маркировка ИС МПТ без штрафов: принял, продал, вернул — всё с кодами и журналом.',
        pains: [
          { t: 'Маркировка обязательна', d: 'Товары лёгкой промышленности — в ИС МПТ. За непроведённый вывод из оборота — штраф.' },
          { t: 'Серый товар', d: 'Код, который уже продан или не был принят, — чужой или поддельный товар.' },
          { t: 'Возвраты', d: 'Покупатель вернул куртку — код должен вернуться в оборот, иначе её не продать снова.' },
        ],
        feats: [
          { k: 'Скан', t: 'Приёмка со сверкой', d: 'Скан DataMatrix против списка поставщика: что привезли, чего не хватает, что лишнее.' },
          { k: 'Касса', t: 'Вывод из оборота — сам', d: 'При продаже касса выводит код из оборота. Это ровно требование закона.' },
          { k: 'Возврат', t: 'Возврат — код в оборот', d: 'Вернули вещь — код вернулся в оборот, вещь можно продать снова.' },
          { k: 'Журнал', t: 'Журнал обмена с ИС МПТ', d: 'Каждая операция со статусом: видно, что ушло в систему, а что ещё в очереди.' },
        ],
        hlT: 'Двойная продажа кода — исключена',
        hlD: 'Один код — один физический экземпляр: повторная продажа того же кода отбивается автоматически. Так серый товар не смешается с вашим, а остатки сходятся поштучно.',
      },
      'кофейня': {
        h1: 'Учёт для кофейни при магазине',
        sub: 'Техкарты, себестоимость чашки и списание молока — даже без интернета.',
        pains: [
          { t: 'Кофе не лежит на складе', d: 'Латте готовится из зёрен, молока и стакана — обычный товарный учёт его не видит.' },
          { t: 'Себестоимость на глаз', d: 'Сколько на самом деле стоит чашка — никто не считал.' },
          { t: 'Молоко утекает', d: 'Без списаний недостача всплывает только в конце месяца.' },
        ],
        feats: [
          { k: 'Рецепт', t: 'Техкарты', d: 'Продали латте — списались зёрна, молоко и стакан. Сам латте остатка не ведёт: он готовится.' },
          { k: '₸', t: 'Себестоимость — сама', d: 'Считается из последних закупочных цен: зёрна 90 + молоко 60 + стакан 15 = 165 ₸ за чашку.' },
          { k: 'Выход', t: 'Выход рецепта', d: 'Тесто на 10 булочек: продажа одной булочки списывает 1/10 партии.' },
          { k: 'Офлайн', t: 'Работает без сети', d: 'Списание ингредиентов встроено в офлайн-продажу — интернет кофейне не критичен.' },
        ],
        hlT: 'Наборы — у многих, техкарты — у нас',
        hlD: '«Комплект из товаров» умеют многие — но комплект лежит на складе, а кофе готовится. Табыс даёт ровно то, что нужно кофейне при магазине: рецепт, списание ингредиентов и себестоимость чашки — без тяжёлого производственного учёта.',
      },
      'хозтовары': {
        h1: 'Учёт для магазина хозтоваров',
        sub: 'Тысячи позиций, десятки поставщиков, опт и розница — под контролем.',
        pains: [
          { t: 'Тысячи позиций', d: 'Саморезы, краска, перчатки — номенклатура на тысячи строк. Вручную не завести.' },
          { t: 'Деньги — в неликвиде', d: 'Что лежит годами, а что уходит за неделю — на глаз не видно.' },
          { t: 'Опт вперемешку с розницей', d: 'Прорабу — с отсрочкой, соседу — поштучно. Долги учитывать негде.' },
        ],
        feats: [
          { k: 'Excel', t: 'Импорт за час', d: 'Выгрузили прайс в Excel — загрузили: колонки распознаются сами, ошибки видны до импорта, есть откат.' },
          { k: 'Фото', t: 'Накладная из фото', d: 'Приёмка на десятки строк — без ручного ввода. Новые позиции создаются черновиком.' },
          { k: 'ABC', t: 'Что продаётся, что лежит', d: 'ABC-анализ и отчёты по товарам показывают ходовое и мёртвый груз.' },
          { k: 'Опт', t: 'Опт и долги', d: 'Оптовым клиентам — долги и лимиты, CRM для оптовых продаж.' },
        ],
        hlT: '10 000 позиций — не проблема',
        hlD: 'Лимита на число товаров нет вообще — ни в «Старте», ни в «Стандарте». Импорт из Excel и накладные из фото заводят номенклатуру за вас.',
      },
    },
  },
  kk: {
    kicker: 'Дүкеніңіздің түріне қарай', painT: 'Таныс мәселелер', featT: 'Табыс қалай шешеді', hlBadge: 'Мықты жағымыз',
    ctaTitle: 'Өз тауарларыңызда байқап көріңіз', ctaSub: '14 күн тегін, кейін айына «Старт» 6 900 ₸ немесе «Стандарт» 14 900 ₸. Көшуге көмектесеміз.',
    ctaStart: 'Тегін бастау', ctaLead: 'Өтінім қалдыру',
    types: {
      'продуктовый': {
        h1: 'Азық-түлік дүкеніне арналған есеп',
        sub: 'Күнделікті жүкқұжат, салмақ тауары, кешкі кезек және көршілердің қарызы — Табыс дәл осы туралы.',
        pains: [
          { t: 'Жүкқұжат — күн сайын', d: 'Аптасына бірнеше жеткізуші — сағаттап қолмен енгізу.' },
          { t: 'Салмақ тауары', d: 'Ірімшік, шұжық пен кәмпитті көзбен соға алмайсыз.' },
          { t: 'Жарты аудан — қарызға', d: 'Дәптер жоғалады, лимитті ешкім есінде сақтамайды, «мен қайтарғанмын» тексерілмейді.' },
        ],
        feats: [
          { k: 'Фото', t: 'Фотодан жүкқұжат', d: 'Суретке түсірдіңіз — позициялар, саны мен бағасы өзі танылды. Кем әкелу мен қымбаттау өткізуге дейін көрінеді.' },
          { k: 'Таразы', t: 'Rongta таразылары', d: 'Салмақ тауары өзі соғылады. Қосу — бірнеше клик.' },
          { k: 'Қарыз', t: 'Кассадағы қарыз дәптері', d: 'Лимит сату кезінде тексеріледі, қарыз чекте басылады. Офлайн да жұмыс істейді.' },
          { k: 'Сөре', t: 'Қосымша тапсырыс кеңесі', d: 'Жүйе не таусылып бара жатқанын көріп, жеткізушіге не тапсырыс беру керегін айтады.' },
        ],
        hlT: 'Қабылдау — сағат емес, минут',
        hlD: 'Күн сайын жеткізілім алатын дүкенге фотодан жүкқұжат — күн сайын босаған бір сағат: тапсырыспен салыстыру, баға бақылауы, жаңа тауарлар жоба болып. Мұндай мүмкіндік Қазақстандағы басқа бірде-бір есеп бағдарламасында жоқ.',
      },
      'напитки': {
        h1: 'Құйма сусындар дүкеніне арналған есеп',
        sub: 'Акциз, марка тексеру және интернетсіз кешкі сауда — Табыстың мықты жақтары.',
        pains: [
          { t: 'Марка — тәуекел', d: 'Жалған не тексерілмеген маркамен алкоголь сату — айыппұл, тәркілеу, лицензия.' },
          { t: 'Марка клондары', d: 'Контрафакт шын марканың нөмірін клондайды — көзбен айыра алмайсыз.' },
          { t: 'Шың — кешке', d: 'Сауда кешке және демалыста қызады — интернет дәл сол кезде жиі істен шығады.' },
        ],
        feats: [
          { k: 'УКМ', t: 'Марканы тексеру', d: 'Серия мен нөмір немесе штрих-код сканы бойынша. Жауап: түпнұсқа немесе табылмады.' },
          { k: 'Клон', t: 'Қайта сатудан қорғау', d: 'Бір марка — бір дана. Сол марканы екінші рет сату тыйылады.' },
          { k: 'Тізілім', t: 'Марка есебі және журнал', d: 'Қоймада қанша, сатылды, жарамсыз. Барлық тексеру журналы — тексерушілерге.' },
          { k: 'Сыра', t: 'Сыра — ИС МПТ-да', d: '2026 жылғы ақпаннан сыра таңбаланады. Салыстырумен қабылдау мен айналымнан шығару дайын.' },
        ],
        hlT: 'Акциз — біздің мықты жағымыз',
        hlD: 'Марка тексеру әдетте бөлек қолданбада не қымбат тарифте болады. Бізде акциз «Стандарт» тарифіне кіреді — қойма және кассамен бірге, сатумен бір терезеде.',
      },
      'одежда': {
        h1: 'Киім дүкеніне арналған есеп',
        sub: 'ИС МПТ таңбалауы айыппұлсыз: қабылдадыңыз, саттыңыз, қайтардыңыз — бәрі кодпен және журналмен.',
        pains: [
          { t: 'Таңбалау міндетті', d: 'Жеңіл өнеркәсіп тауарлары — ИС МПТ-да. Айналымнан шығаруды өткізбегенге — айыппұл.' },
          { t: 'Сұр тауар', d: 'Сатылған немесе қабылданбаған код — бөтен не жалған тауар.' },
          { t: 'Қайтарымдар', d: 'Куртка қайтарылды — код айналымға оралуы керек, әйтпесе оны қайта сату мүмкін емес.' },
        ],
        feats: [
          { k: 'Скан', t: 'Салыстырумен қабылдау', d: 'DataMatrix сканы жеткізуші тізіміне қарсы: не келді, не жетпейді, не артық.' },
          { k: 'Касса', t: 'Айналымнан шығару — өзі', d: 'Сату кезінде касса кодты айналымнан шығарады. Заң талабы дәл осы.' },
          { k: 'Қайтарым', t: 'Қайтарым — код айналымға', d: 'Затты қайтарды — код айналымға оралды, затты қайта сатуға болады.' },
          { k: 'Журнал', t: 'ИС МПТ алмасу журналы', d: 'Әр операция мәртебесімен: не жүйеге кетті, не әлі кезекте — көрініп тұр.' },
        ],
        hlT: 'Кодты қос сату — мүмкін емес',
        hlD: 'Бір код — бір дана: сол кодты қайта сату автоматты тыйылады. Осылай сұр тауар сіздікімен араласпайды, қалдық даналап дәл шығады.',
      },
      'кофейня': {
        h1: 'Дүкен жанындағы кофейняға арналған есеп',
        sub: 'Техкарталар, шыныаяқтың өзіндік құны және сүт шегеру — интернетсіз де.',
        pains: [
          { t: 'Кофе қоймада жатпайды', d: 'Латте дән, сүт пен стаканнан жасалады — кәдімгі тауар есебі оны көрмейді.' },
          { t: 'Өзіндік құн — көзбен', d: 'Шыныаяқ шынында қанша тұрады — ешкім есептемеген.' },
          { t: 'Сүт ағып кетеді', d: 'Шегерусіз жетіспеушілік тек ай соңында шығады.' },
        ],
        feats: [
          { k: 'Рецепт', t: 'Техкарталар', d: 'Латте саттыңыз — дән, сүт және стакан шегерілді. Латтенің өзі қалдық жүргізбейді: ол дайындалады.' },
          { k: '₸', t: 'Өзіндік құн — өзі', d: 'Соңғы сатып алу бағасынан есептеледі: дән 90 + сүт 60 + стакан 15 = шыныаяғы 165 ₸.' },
          { k: 'Шығыс', t: 'Рецепт шығысы', d: 'Қамыр 10 тоқашқа: бір тоқаш сатылса — партияның 1/10 бөлігі шегеріледі.' },
          { k: 'Офлайн', t: 'Желісіз жұмыс істейді', d: 'Ингредиент шегеру офлайн-сатуға кірістірілген — кофейняға интернет міндетті емес.' },
        ],
        hlT: 'Жиынтық — көпте, техкарта — бізде',
        hlD: '«Тауар жиынтығын» көбі біледі — бірақ жиынтық қоймада жатады, кофе дайындалады. Табыс дүкен жанындағы кофейняға керегін дәл береді: рецепт, ингредиент шегеру және шыныаяқтың өзіндік құны — ауыр өндірістік есепсіз.',
      },
      'хозтовары': {
        h1: 'Шаруашылық тауарлары дүкеніне есеп',
        sub: 'Мыңдаған позиция, ондаған жеткізуші, көтерме мен бөлшек — бақылауда.',
        pains: [
          { t: 'Мыңдаған позиция', d: 'Бұранда, бояу, қолғап — мыңдаған жол. Қолмен енгізу мүмкін емес.' },
          { t: 'Ақша — өтпейтін тауарда', d: 'Не жылдап жатыр, не аптасына кетеді — көзбен көрінбейді.' },
          { t: 'Көтерме мен бөлшек аралас', d: 'Прорабқа — мерзімін ұзартып, көршіге — даналап. Қарызды жазатын жер жоқ.' },
        ],
        feats: [
          { k: 'Excel', t: 'Бір сағатта импорт', d: 'Прайсты Excel-ге түсіріп, жүктедіңіз: бағандар өзі танылады, қателер импортқа дейін көрінеді, кері қайтару бар.' },
          { k: 'Фото', t: 'Фотодан жүкқұжат', d: 'Ондаған жолдық қабылдау — қолмен енгізусіз. Жаңа позициялар жоба болып жасалады.' },
          { k: 'ABC', t: 'Не сатылады, не жатыр', d: 'ABC-талдау мен тауар есептері жүрдекті және өлі жүкті көрсетеді.' },
          { k: 'Көтерме', t: 'Көтерме және қарыз', d: 'Көтерме клиенттерге — қарыз бен лимит, көтерме сатуға арналған CRM.' },
        ],
        hlT: '10 000 позиция — мәселе емес',
        hlD: 'Тауар санына лимит мүлдем жоқ — «Стартта» да, «Стандартта» да. Excel импорты мен фотодан жүкқұжат номенклатураны сіз үшін енгізеді.',
      },
    },
  },
};

/** Страница «под тип магазина». Один каркас, пять разных текстов. */
export function StoreLanding({ type }: { type: StoreType }) {
  const [lang, toggle] = useLang();
  const t = ST[lang];
  const ty = t.types[type];

  return (
    <div style={{ color: C.ink, background: C.card }}>
      <SiteHeader lang={lang} onLang={toggle} active="stores" />

      <section style={{ ...S.sec, paddingTop: 'clamp(40px,7vw,68px)' }}>
        <div style={S.kicker}>{t.kicker}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
          {STORE_LINKS.map((s, i) => {
            const on = i === ['продуктовый', 'напитки', 'одежда', 'кофейня', 'хозтовары'].indexOf(type);
            return (
              <a key={s.href} href={s.href}
                style={{ background: on ? C.brand : C.card, color: on ? '#fff' : C.prose, border: `1px solid ${on ? C.brand : '#D8D8CF'}`,
                  borderRadius: 999, minHeight: 44, padding: '0 18px', fontSize: 14.5, fontWeight: 500, textDecoration: 'none',
                  display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
                {lang === 'ru' ? s.ru : s.kk}
              </a>
            );
          })}
        </div>
        <h1 style={{ ...S.h1, margin: '26px 0 0', maxWidth: '24ch' }}>{ty.h1}</h1>
        <p style={{ fontSize: 'clamp(15.5px,2vw,17px)', lineHeight: 1.55, color: C.prose, margin: '14px 0 0', maxWidth: '58ch' }}>{ty.sub}</p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 26 }}>
          <a href="/register" style={S.btn}>{t.ctaStart}</a>
          <a href="/#lead" style={S.ghost}>{t.ctaLead}</a>
        </div>
      </section>

      <section style={{ background: C.sunken, borderTop: `1px solid ${C.lineIn}`, borderBottom: `1px solid ${C.lineIn}`, marginTop: 'clamp(44px,6vw,64px)' }}>
        <div style={{ ...S.wrap, padding: 'clamp(40px,6vw,60px) clamp(16px,4vw,24px)' }}>
          <h2 style={{ ...S.h2, fontSize: 'clamp(22px,3.6vw,27px)', margin: '0 0 22px' }}>{t.painT}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: 14 }}>
            {ty.pains.map((p: any) => (
              <div key={p.t} style={S.card}>
                <b style={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.35 }}>{p.t}</b>
                <p style={{ color: C.prose, fontSize: 13.5, margin: '8px 0 0', lineHeight: 1.6 }}>{p.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={S.sec}>
        <h2 style={{ ...S.h2, fontSize: 'clamp(22px,3.6vw,27px)', margin: '0 0 22px' }}>{t.featT}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(245px,1fr))', gap: 14 }}>
          {ty.feats.map((f: any) => (
            <div key={f.t} style={S.card}>
              <div style={S.tag}>{f.k}</div>
              <b style={{ display: 'block', fontSize: 15.5, fontWeight: 600, marginTop: 12 }}>{f.t}</b>
              <p style={{ color: C.prose, fontSize: 13.5, margin: '8px 0 0', lineHeight: 1.6 }}>{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section style={{ background: C.goldPaper, borderTop: `1px solid ${C.goldLine}`, borderBottom: `1px solid ${C.goldLine}`, marginTop: 'clamp(44px,6vw,64px)' }}>
        <div style={{ ...S.wrap, padding: 'clamp(40px,6vw,56px) clamp(16px,4vw,24px)' }}>
          <div style={{ display: 'inline-block', background: C.goldTint, color: C.goldInk, padding: '5px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 500, letterSpacing: '.04em' }}>{t.hlBadge}</div>
          <h2 style={{ ...S.h2, fontSize: 'clamp(23px,3.8vw,29px)', margin: '14px 0 0', maxWidth: '30ch' }}>{ty.hlT}</h2>
          <p style={{ fontSize: 15, lineHeight: 1.65, color: C.prose, margin: '12px 0 0', maxWidth: '72ch' }}>{ty.hlD}</p>
        </div>
      </section>

      <CtaBand lang={lang} title={t.ctaTitle} sub={t.ctaSub} />
      <SiteFooter lang={lang} />
    </div>
  );
}
