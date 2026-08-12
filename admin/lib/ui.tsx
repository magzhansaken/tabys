'use client';
/**
 * Мини-набор элементов кабинета. Один файл вместо UI-библиотеки:
 * кабинет должен открываться на слабом ноутбуке магазина мгновенно,
 * а дизайн — быть единым без усилий на каждой странице.
 *
 * ЭТАП «ВНЕШНИЙ ВИД» (дизайн-система «Табыс»): изменены только значения
 * цветов, размеры, отступы и разметка внутри компонентов. Имена экспорта,
 * набор свойств и поведение — прежние: их читают 30 файлов.
 *
 * ЭТАП «ДОВОДКА РАЗДЕЛОВ»: добавлены PageHeader, confirmDanger, Toggle,
 * RevealOnce. Ничего не удалено, свойства прежних компонентов не тронуты.
 *
 * Три правила этого файла, каждое стоило нам поломки в бою:
 *   1. localStorage — только внутри useEffect (иначе падает подготовка страниц);
 *   2. Select принимает options=[{value,label}], а не вложенные <option>;
 *   3. перевод статусов один, в Status — вторых переводов на страницах нет.
 */
import React, { useState, useEffect } from 'react';

/** Палитра. Прежние ключи сохранены, добавлено пять новых (gold, faint,
 *  lineIn, sunken, prose) — старые значения только перекрашены. */
export const C = {
  bg: '#F5F5F1',          // тёплый почти-белый: бумага, а не экран банкомата
  card: '#FFFFFF',
  line: '#E4E4DD',        // рамка карточки
  text: '#17211D',        // суммы, названия, заголовки
  dim: '#6B7167',         // подписи, шапка таблицы
  accent: '#0B6B4F',      // изумруд: действие и «всё в порядке»
  accentDark: '#085340',  // наведение, ссылки, текст на светлом
  red: '#A32C1E',         // деньги, которых нет: недостача, долг, ноль в остатке
  amber: '#8A5F1B',       // текст предупреждения (контраст 5,6:1 на белом)
  // ── новые ключи ──────────────────────────────────────────────────────
  gold: '#B8863B',        // ТОЛЬКО заливки и рамки: AI, выходные на графике
  faint: '#9A9E95',       // прочерки «—», счётчики, служебные подписи
  lineIn: '#EFEFE9',      // линии внутри карточки: строки таблицы
  sunken: '#FAFAF6',      // наведение на строку, закрытая смена
  prose: '#3C443E',       // абзацы и пояснения (тише заголовка, читаемее dim)
};

/** Подложки бейджей. Внутренние, наружу не нужны. */
const TONE: Record<string, [string, string]> = {
  ok: ['#E8F1EC', C.accentDark],
  warn: ['#F7EFDF', C.amber],
  bad: ['#FBEAE6', C.red],
  dim: ['#F1F1EA', C.dim],
};

/**
 * Шрифты берутся из переменных, которые заводит next/font/local в layout.tsx
 * (--font-sans, --font-mono). Писать здесь «'IBM Plex Sans'» нельзя: локальный
 * шрифт регистрируется под сгенерированным именем, и по человеческому имени
 * он не найдётся — подставится системный, а мы этого не заметим.
 */
const FONT = "var(--font-sans), -apple-system, 'Segoe UI', system-ui, sans-serif";
/** Моноширинный — для кодов, номеров и сумм в чеке. Экспортируется, чтобы
 *  страницы не писали 'monospace' руками и не теряли загруженный IBM Plex Mono. */
export const MONO = "var(--font-mono), ui-monospace, 'Cascadia Mono', monospace";

export const money = (v: any) =>
  (Number(v) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₸';
export const num = (v: any) => (Number(v) || 0).toLocaleString('ru-RU', { maximumFractionDigits: 3 });
export const dt = (v: any) => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const today = () => new Date().toISOString().slice(0, 10);
export const monthAgo = () => { const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10); };

/* ═══════════════════════════════════════════════════════════════════
   БАЗОВЫЕ СТИЛИ

   Инлайновые стили не умеют трёх вещей: сброса страницы, печати и
   превращения таблицы в карточки на телефоне. Поэтому один <style> на
   всё приложение — подключите один раз в app/layout.tsx: <BaseStyles />.
   ═══════════════════════════════════════════════════════════════════ */
export function BaseStyles() {
  return (
    <style dangerouslySetInnerHTML={{ __html: `
      *{box-sizing:border-box}
      html,body{margin:0}
      body{background:${C.bg};color:${C.text};font-family:${FONT};-webkit-font-smoothing:antialiased}
      a{color:${C.accent};text-decoration:none}
      a:hover{color:${C.accentDark};text-decoration:underline;text-underline-offset:2px}
      ::selection{background:#E8F1EC}
      input,select,button,textarea{font-family:inherit}
      /* Телефон: строка таблицы становится карточкой с подписями полей.
         Горизонтальная прокрутка таблицы на телефоне — это провал. */
      @media (max-width:640px){
        table[data-cards] thead{display:none}
        table[data-cards],table[data-cards] tbody,table[data-cards] tr,table[data-cards] td{display:block;width:100%}
        table[data-cards] tr{background:${C.card};border:1px solid ${C.line};border-radius:12px;margin-bottom:10px;overflow:hidden}
        table[data-cards] td{display:flex;justify-content:space-between;align-items:baseline;gap:14px;
          border:0!important;border-bottom:1px solid ${C.lineIn}!important;padding:9px 14px!important;text-align:right!important;white-space:normal!important}
        table[data-cards] td:last-child{border-bottom:0!important}
        table[data-cards] td::before{content:attr(data-label);color:${C.dim};font-size:13px;font-weight:400;text-align:left;flex:0 0 auto}
        table[data-cards] td[data-label=""]::before{content:none}
        table[data-cards] td:first-child{font-weight:600;font-size:15px}
        /* Тап-цели. На компьютере кнопка 38 px выглядит собранной, но палец
           требует 44: промах по кнопке «Провести» или «Оплата» на кассовом
           планшете стоит дороже, чем лишние 6 пикселей. Поднимаем только
           на телефоне — вид на компьютере не меняется. */
        button,[role="button"],a[data-btn]{min-height:44px}
        input,select{min-height:44px}
        /* Список столбцов на телефоне — не выпадашка у правого края (уезжает
           за границу вместе с галочками), а лист снизу во всю ширину. */
        [data-cols-popover]{position:fixed!important;left:16px!important;right:16px!important;
          top:auto!important;bottom:16px!important;width:auto!important;max-width:none!important;
          max-height:70vh!important}
      }
      /* Печать: белый фон, ничего лишнего, шапка таблицы на каждой странице.
         Тёплый фон на принтере стал бы серым и съел тонер. */
      @media print{
        @page{margin:14mm}
        body{background:#fff!important;color:#000!important}
        aside,[data-no-print]{display:none!important}
        main{padding:0!important;max-width:none!important}
        section,[data-card]{border-color:#CCC!important;background:#fff!important;break-inside:avoid}
        thead{display:table-header-group}
        tr{break-inside:avoid}
        [data-badge]{background:transparent!important;color:#000!important;border:1px solid #999!important}
        [data-bar]{background:#000!important}
        a{color:#000!important;text-decoration:none!important}
      }
    ` }} />
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ЕДИНАЯ ШАПКА РАЗДЕЛА (этап «доводка»)

   Замер показал 0 из 21: шапку каждый раздел рисовал по-своему. Один
   компонент вместо двадцати одной вёрстки — и заодно правило становится
   физически исполнимым: `fact` обязателен, пустую строку туда незаметно
   не напишешь.

   fact — ФАКТ из уже загруженных данных: «348 позиций · 3 закончились».
   Не описание раздела: «Управление товарами вашего магазина» — вода.
   Новых обращений к серверу ради факта не добавлять: если числа нет на
   экране, значит и в факте ему взяться неоткуда.
   ═══════════════════════════════════════════════════════════════════ */
export function PageHeader({ title, fact, actions, note }: {
  title: string;
  /** факт из уже загруженных данных, не описание раздела */
  fact: string;
  /** главное действие справа; их не больше трёх */
  actions?: any;
  /** абзац под шапкой, когда раздел требует объяснения смысла */
  note?: string;
}) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        gap: 20, flexWrap: 'wrap', marginBottom: note ? 6 : 20 }}>
        <div>
          <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-.015em', margin: 0 }}>{title}</h1>
          <div style={{ fontSize: 13.5, color: C.dim, marginTop: 5, lineHeight: 1.5 }}>{fact}</div>
        </div>
        {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
      </div>
      {note && (
        <p style={{ fontSize: 14.5, color: C.prose, lineHeight: 1.55, margin: '12px 0 22px',
          maxWidth: '82ch' }}>{note}</p>
      )}
    </>
  );
}

/**
 * Подтверждение необратимого действия.
 *
 * Спрашивать «Вы уверены?» бесполезно: человек уверен, он же нажал.
 * Полезно назвать ПОСЛЕДСТВИЕ — что произойдёт с данными и деньгами.
 * Поэтому здесь два обязательных довода, а не один вопрос.
 *
 *   if (!confirmDanger('Удалить приёмку №148?',
 *                      'Движения по складу будут отменены, остатки уменьшатся на 42 позиции.')) return;
 */
export function confirmDanger(what: string, consequence: string) {
  return window.confirm(`${what}\n\n${consequence}`);
}

/** Включено/выключено. Разными должны быть и цвет, и положение, и подпись:
 *  одну лишь галочку владелец на бегу не читает. */
export function Toggle({ checked, onChange, on = 'Включено', off = 'Выключено' }: {
  checked: boolean; onChange: (v: boolean) => void; on?: string; off?: string;
}) {
  return (
    <button onClick={() => onChange(!checked)} role="switch" aria-checked={checked}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 9, minHeight: 34, padding: '0 12px 0 6px',
        border: `1px solid ${checked ? C.accent : C.line}`, borderRadius: 999, cursor: 'pointer',
        background: checked ? '#E8F1EC' : C.card, color: checked ? C.accentDark : C.dim,
        fontSize: 13.5, fontWeight: checked ? 500 : 400, fontFamily: 'inherit' }}>
      <span style={{ width: 30, height: 18, borderRadius: 999, position: 'relative', flex: '0 0 30px',
        background: checked ? C.accent : '#D3D3C9', transition: 'background .12s' }}>
        <span style={{ position: 'absolute', top: 2, left: checked ? 14 : 2, width: 14, height: 14,
          borderRadius: '50%', background: '#fff', transition: 'left .12s' }} />
      </span>
      {checked ? on : off}
    </button>
  );
}

/**
 * Секрет, который показывают один раз: ключ API, PIN кассира, код привязки.
 *
 * Мы храним отпечаток, а не сам ключ, — подсмотреть его потом не может
 * никто, включая нас. Значит человеку надо сказать это ДО того, как он
 * закроет окно, а не после. Отсюда: крупный моноширинный текст, кнопка
 * «Скопировать» и объяснение рядом, а не мелким шрифтом внизу.
 *
 * ttl — сколько секунд живёт код (у кода привязки это 10 минут). Обратный
 * отсчёт нужен, чтобы человек не диктовал на планшет уже мёртвый код.
 */
export function RevealOnce({ value, title, note, ttl, onExpire }: {
  value: string; title: string; note: string; ttl?: number; onExpire?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState(ttl ?? 0);

  useEffect(() => {
    if (!ttl) return;
    setLeft(ttl);
    const id = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) { clearInterval(id); onExpire?.(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
    // value в зависимостях: новый код — новый отсчёт
  }, [ttl, value]);

  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const dead = !!ttl && left === 0;

  return (
    <div data-card="" style={{ border: `1.5px solid ${dead ? C.line : C.accent}`,
      background: dead ? C.sunken : '#F4F9F6', borderRadius: 12, padding: '18px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, color: dead ? C.dim : C.accentDark }}>{title}</div>
        {!!ttl && (
          <div style={{ fontSize: 13.5, color: dead ? C.red : C.dim, fontVariantNumeric: 'tabular-nums' }}>
            {dead ? 'срок истёк — выпишите новый' : `действует ещё ${mmss}`}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
        <code style={{ flex: 1, minWidth: 240, fontFamily: MONO, fontSize: 26, letterSpacing: '.16em',
          fontWeight: 500, background: C.card, border: `1px solid ${C.line}`, borderRadius: 8,
          padding: '12px 14px', wordBreak: 'break-all', lineHeight: 1.4,
          color: dead ? C.faint : C.text, textDecoration: dead ? 'line-through' : 'none' }}>{value}</code>
        <Btn kind="ghost" disabled={dead}
          onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); }}>
          {copied ? 'Скопировано' : 'Скопировать'}
        </Btn>
      </div>
      <div style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.6 }}>{note}</div>
    </div>
  );
}

export function Card({ title, right, children, style }: any) {
  return (
    <section data-card="" style={{ background: C.card, borderRadius: 12, padding: '20px 22px', border: `1px solid ${C.line}`, ...style }}>
      {(title || right) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{title}</h2>
          <div>{right}</div>
        </div>
      )}
      {children}
    </section>
  );
}

export function Btn({ children, kind = 'primary', ...p }: any) {
  const base: any = {
    minHeight: 38, padding: '0 15px', borderRadius: 8, fontSize: 14, cursor: 'pointer',
    border: `1px solid ${C.line}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    gap: 7, lineHeight: 1, whiteSpace: 'nowrap',
  };
  const kinds: any = {
    primary: { background: C.accent, color: '#fff', border: 0, padding: '0 17px', fontWeight: 500 },
    ghost: { background: C.card, color: C.text, borderColor: '#D8D8CF' },
    danger: { background: C.card, color: C.red, borderColor: '#E6C7C0' },
    // Золотая кнопка — только AI-помощник. Единственный раздел, которого
    // нет ни у UMAG, ни у Wipon, ни у МоегоСклада.
    gold: { background: C.gold, color: '#fff', border: 0, padding: '0 17px', fontWeight: 500 },
  };
  return (
    <button {...p} style={{ ...base, ...(kinds[kind] ?? kinds.ghost), opacity: p.disabled ? 0.4 : 1, cursor: p.disabled ? 'not-allowed' : 'pointer', ...p.style }}>
      {children}
    </button>
  );
}

/** Поле ввода. Шрифт 16 px везде, включая компьютер: меньше — и iOS сам
 *  увеличивает страницу при касании, вёрстка разъезжается.
 *
 *  forwardRef нужен разделам со сканером (маркировка, акциз): туда возвращают
 *  курсор после каждой проверки, иначе следующий код придётся ловить мышью.
 *  Без forwardRef ref на функциональный компонент молча не работает. */
export const Input = React.forwardRef(function Input(p: any, ref: any) {
  const { w, ...rest } = p;
  return (
    <input ref={ref} {...rest} style={{
      height: 38, padding: '0 12px', border: `1px solid #D8D8CF`, borderRadius: 8, fontSize: 16,
      background: C.card, color: C.text, width: w ?? 180, outline: 'none', ...p.style,
    }} />
  );
});

/** ВАЖНО: options=[{value,label}]. Передача вложенных <option> детьми
 *  роняет сборку — так уже было на этом проекте. */
export function Select({ options, ...p }: any) {
  return (
    <select {...p} style={{
      height: 38, padding: '0 12px', border: `1px solid #D8D8CF`, borderRadius: 8, fontSize: 16,
      background: C.card, color: C.text, ...p.style,
    }}>
      {options.map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Field({ label, children }: any) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, color: C.dim }}>
      {label}{children}
    </label>
  );
}

/** Таблица данных: цифры выравниваются вправо и набраны табличными цифрами.
 *  data-label на ячейке — подпись поля, когда строка станет карточкой. */
export function Table({ cols, rows, empty = 'Пока пусто' }: { cols: { h: string; k?: string; r?: (row: any) => any; right?: boolean }[]; rows: any[]; empty?: string }) {
  if (!rows?.length) return <div style={{ color: C.dim, fontSize: 14, padding: '10px 0' }}>{empty}</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table data-cards="" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} style={{ textAlign: c.right ? 'right' : 'left', color: C.dim, fontWeight: 500, fontSize: 12,
                padding: '0 12px 9px', borderBottom: `1px solid #D3D3C9`, whiteSpace: 'nowrap' }}>{c.h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row.id ?? ri}>
              {cols.map((c, ci) => (
                <td key={ci} data-label={c.h} style={{
                  padding: '11px 12px', borderBottom: `1px solid ${C.lineIn}`, verticalAlign: 'top',
                  textAlign: c.right ? 'right' : 'left', whiteSpace: c.right ? 'nowrap' : 'normal', lineHeight: 1.45,
                }}>
                  {c.r ? c.r(row) : row[c.k!]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { key: string; label: string }[]; active: string; onChange: (k: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 18, flexWrap: 'wrap', borderBottom: `1px solid ${C.line}` }}>
      {tabs.map((t) => (
        <button key={t.key} onClick={() => onChange(t.key)}
          style={{ minHeight: 40, padding: '0 14px', fontSize: 14, cursor: 'pointer', background: 'transparent',
            border: 0, borderBottom: `2px solid ${active === t.key ? C.accent : 'transparent'}`, marginBottom: -1,
            color: active === t.key ? C.accentDark : C.dim, fontWeight: active === t.key ? 500 : 400 }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, tone = 'ok' }: any) {
  const [bg, fg] = TONE[tone] ?? TONE.dim;
  return (
    <span data-badge="" style={{ display: 'inline-block', background: bg, color: fg, padding: '3px 9px',
      borderRadius: 999, fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap' }}>{children}</span>
  );
}

/** Быстрые периоды — как кнопки над отчётами в UMAG. Высота 34 px:
 *  на телефоне это уже нажимаемо, вместе с отступами строки — 44. */
export function PeriodPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const opts = [
    ['today', 'Сегодня'], ['yesterday', 'Вчера'], ['week', 'Неделя'],
    ['month', 'Месяц'], ['prev_month', 'Прошлый месяц'], ['quarter', 'Квартал'],
  ];
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {opts.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)}
          style={{ minHeight: 34, padding: '0 13px', fontSize: 13.5, borderRadius: 999, cursor: 'pointer',
            border: `1px solid ${value === k ? C.accent : C.line}`,
            background: value === k ? '#E8F1EC' : C.card,
            color: value === k ? C.accentDark : C.dim,
            fontWeight: value === k ? 500 : 400 }}>
          {l}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: any) {
  return (
    <div data-card="" style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: '16px 18px', minWidth: 150, flex: 1 }}>
      <div style={{ fontSize: 12.5, color: C.dim }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.1, marginTop: 6, whiteSpace: 'nowrap',
        color: tone === 'bad' ? C.red : C.text, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 12.5, color: C.dim, marginTop: 7 }}>{sub}</div>}
    </div>
  );
}

export function ErrLine({ err }: { err: string }) {
  return err ? <div style={{ color: C.red, fontSize: 13.5, margin: '10px 0' }}>{err}</div> : null;
}

/* ═══════════════════════════════════════════════════════════════════
   ЕДИНАЯ ТАБЛИЦА (этап 4)

   Зачем: разбор UMAG показал, что их сила не в количестве функций, а в
   ОДНООБРАЗИИ. В каждом их разделе одинаково: фильтр, экспорт, настройка
   столбцов. Пользователь учится один раз и дальше знает всю систему.
   У нас фильтр был на 5 страницах из 21, настройки столбцов — нигде.

   Совместима с обычной Table: те же cols и rows, поэтому замена
   безопасна и не требует переписывать страницы.

   ВАЖНАЯ ТОНКОСТЬ: выбор столбцов хранится в браузере, но читается
   ТОЛЬКО после появления страницы (useEffect). Обращение к хранилищу
   во время сборки роняет страницу — на этом проекте такое уже случалось
   с выпадающим списком, и кабинет не поднимался.
   ═══════════════════════════════════════════════════════════════════ */

/** Значение строки для поиска и выгрузки: и по ключу, и по своей отрисовке. */
function cellText(c: any, row: any): string {
  if (c.k) return String(row[c.k] ?? '');
  if (c.r) {
    const v = c.r(row);
    if (v == null || typeof v === 'boolean') return '';
    if (typeof v === 'object') {
      // отрисовка вернула разметку — вытаскиваем текст из содержимого
      const kids = (v as any)?.props?.children;
      return Array.isArray(kids) ? kids.filter((x: any) => typeof x !== 'object').join(' ') : String(kids ?? '');
    }
    return String(v);
  }
  return '';
}

export function DataTable({
  cols, rows, empty = 'Пока пусто', storageKey, search = true, exportName, hint, extra,
}: {
  cols: { h: string; k?: string; r?: (row: any) => any; right?: boolean }[];
  rows: any[];
  empty?: string;
  /** ключ для запоминания выбранных столбцов; без него настройка скрыта */
  storageKey?: string;
  search?: boolean;
  /** имя файла выгрузки; без него кнопка скрыта */
  exportName?: string;
  /** подсказка под шапкой: зачем раздел и с чего начать (приём UMAG) */
  hint?: string;
  /** свои кнопки в строке инструментов */
  extra?: any;
}) {
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState<string[]>([]);
  const [gear, setGear] = useState(false);

  // Читаем сохранённый выбор ПОСЛЕ появления страницы, а не во время сборки.
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = window.localStorage.getItem('cols:' + storageKey);
      if (raw) setHidden(JSON.parse(raw));
    } catch { /* хранилище недоступно — работаем со всеми столбцами */ }
  }, [storageKey]);

  const toggle = (h: string) => {
    const next = hidden.includes(h) ? hidden.filter((x) => x !== h) : [...hidden, h];
    setHidden(next);
    try { if (storageKey) window.localStorage.setItem('cols:' + storageKey, JSON.stringify(next)); } catch {}
  };

  const shown = cols.filter((c) => !hidden.includes(c.h));
  const list = q.trim()
    ? (rows ?? []).filter((row) => cols.some((c) => cellText(c, row).toLowerCase().includes(q.trim().toLowerCase())))
    : (rows ?? []);

  const doExport = () => {
    // Выгрузка того, что видно на экране: с учётом фильтра и скрытых столбцов.
    // Иначе человек выгружает одно, а видел другое — и не сходится.
    const head = shown.map((c) => c.h).join(';');
    const body = list.map((row) => shown.map((c) => cellText(c, row).replace(/;/g, ',')).join(';')).join('\n');
    const blob = new Blob(['\ufeff' + head + '\n' + body], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${exportName}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      {hint && <p style={{ fontSize: 13.5, lineHeight: 1.5, color: C.dim, margin: '0 0 14px', maxWidth: '68ch' }}>{hint}</p>}

      <div data-no-print="" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        {search && (
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ position: 'absolute', left: 11, pointerEvents: 'none' }} aria-hidden="true">
              <circle cx="6" cy="6" r="4.4" stroke={C.faint} strokeWidth="1.4" />
              <path d="M9.4 9.4 L12.4 12.4" stroke={C.faint} strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск в таблице"
              style={{ height: 38, padding: '0 12px 0 32px', border: `1px solid #D8D8CF`, borderRadius: 8,
                fontSize: 16, minWidth: 248, background: C.card, color: C.text, outline: 'none' }} />
          </div>
        )}
        {extra}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {q && <span style={{ fontSize: 13, color: C.faint, whiteSpace: 'nowrap' }}>найдено: {list.length} из {rows?.length ?? 0}</span>}
          {exportName && rows?.length > 0 && (
            <Btn kind="ghost" onClick={doExport} title="Выгрузить то, что видно на экране">Выгрузить</Btn>
          )}
          {storageKey && (
            <div style={{ position: 'relative' }}>
              <Btn kind="ghost" onClick={() => setGear(!gear)} title="Какие столбцы показывать"
                style={{ color: gear ? C.accentDark : C.dim }}>Столбцы</Btn>
              {gear && (
                <div data-cols-popover="" style={{ position: 'absolute', right: 0, top: 44, zIndex: 20, background: C.card,
                  border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, minWidth: 232,
                  maxWidth: 'calc(100vw - 32px)', maxHeight: 'min(60vh, 420px)', overflowY: 'auto',
                  boxShadow: '0 12px 32px rgba(23,33,29,.14)' }}>
                  <div style={{ fontSize: 12.5, color: C.dim, marginBottom: 10 }}>Показывать столбцы:</div>
                  {cols.map((c) => (
                    <label key={c.h} style={{ display: 'flex', gap: 9, alignItems: 'center', minHeight: 32, fontSize: 14, cursor: 'pointer' }}>
                      <input type="checkbox" checked={!hidden.includes(c.h)} onChange={() => toggle(c.h)}
                        style={{ width: 16, height: 16, accentColor: C.accent }} />
                      {c.h}
                    </label>
                  ))}
                  {hidden.length > 0 && (
                    <Btn kind="ghost" onClick={() => { setHidden([]); try { if (storageKey) window.localStorage.removeItem('cols:' + storageKey); } catch {} }}
                      style={{ marginTop: 10, width: '100%' }}>Показать все</Btn>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {!rows?.length ? (
        <EmptyState text={empty} />
      ) : !list.length ? (
        <EmptyState text={`По запросу «${q}» ничего не нашлось`} />
      ) : (
        <Table cols={shown} rows={list} empty={empty} />
      )}
    </div>
  );
}

/** Пустое состояние говорит, что сделать, а не «нет данных». */
export function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '44px 20px', textAlign: 'center' }}>
      <div style={{ width: 34, height: 34, border: `1.5px dashed #C9C9BE`, borderRadius: 9 }} />
      <div style={{ fontSize: 14.5, color: C.dim, maxWidth: '44ch', lineHeight: 1.5 }}>{text}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ЕДИНЫЙ ПОКАЗ СТАТУСА (этап 5)

   Зачем: каждая страница переводила статусы по-своему, и один и тот же
   документ выглядел в разных разделах по-разному. Хуже: на складе
   проверялся статус «processed», которого в базе нет — там «done».
   Из-за опечатки проведённые документы показывались серым служебным
   словом вместо зелёного «Проведён», и никто не замечал.

   Теперь перевод один на всю систему: опечатка невозможна, а новый
   статус достаточно добавить в одном месте.
   ═══════════════════════════════════════════════════════════════════ */
const STATUS: Record<string, { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' }> = {
  // документы склада
  draft:       { text: 'Черновик',    tone: 'warn' },
  counting:    { text: 'Подсчёт',     tone: 'warn' },
  processing:  { text: 'Проведение',  tone: 'warn' },
  done:        { text: 'Проведён',    tone: 'ok'   },
  deleted:     { text: 'Удалён',      tone: 'dim'  },
  // задачи AI-помощника: распознанная накладная становится приёмкой.
  // До этого перевод жил ternary-ем в app/(cab)/ai/page.tsx — второй
  // перевод статусов, ровно та ошибка, от которой защищает Status.
  confirmed:   { text: 'Проведено',   tone: 'ok'   },
  // смены
  open:        { text: 'Открыта',     tone: 'warn' },
  closed:      { text: 'Закрыта',     tone: 'ok'   },
  // аккаунты и подписка
  pending:     { text: 'Ждёт доступа',tone: 'warn' },
  trial:       { text: 'Пробный',     tone: 'warn' },
  active:      { text: 'Работает',    tone: 'ok'   },
  suspended:   { text: 'Приостановлен', tone: 'bad' },
  frozen:      { text: 'Заморожен',   tone: 'bad'  },
  // оплаты и заказы
  paid:        { text: 'Оплачен',     tone: 'ok'   },
  unpaid:      { text: 'Не оплачен',  tone: 'bad'  },
  new:         { text: 'Новый',       tone: 'warn' },
  accepted:    { text: 'Принят',      tone: 'ok'   },
  // заявки с лендинга (операторка). Без них страница завела бы свой
  // перевод тернаркой — ровно то, от чего защищает Status.
  called:      { text: 'Прозвонили',  tone: 'dim'  },
  converted:   { text: 'Клиент',      tone: 'ok'   },
  spam:        { text: 'Спам',        tone: 'dim'  },
  completed:   { text: 'Завершён',    tone: 'ok'   },
  cancelled:   { text: 'Отменён',     tone: 'dim'  },
  archive:     { text: 'В архиве',    tone: 'dim'  },
  // декларации: выгруженная в КНП против оставшейся черновиком.
  // Перевод жил тернаркой в taxes/page.tsx — пятый второй перевод.
  exported:    { text: 'Выгружена',   tone: 'ok'   },
};

/**
 * Уточнения по видам сущностей: одно и то же слово в базе местами значит
 * разное. У аккаунта active — «Работает», у подарочного сертификата так
 * сказать нельзя, он «Активен». Раньше из-за этого сертификаты завели свой
 * перевод прямо на странице — второй перевод, ровно то, от чего защищает
 * Status. Поэтому уточнения живут ЗДЕСЬ, а не в разделах.
 */
const STATUS_BY_KIND: Record<string, Record<string, { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' }>> = {
  cert: {
    active:  { text: 'Активен',      tone: 'ok'  },
    used:    { text: 'Использован',  tone: 'dim' },
    expired: { text: 'Просрочен',    tone: 'bad' },
    void:    { text: 'Аннулирован',  tone: 'bad' },
  },
  // Состояния заказа Kaspi. Раньше жили таблицей STATE_LABEL прямо в
  // marketplace/page.tsx — третий перевод статусов. Тут же видно, что
  // archive у заказа значит «Завершён», а не «В архиве».
  mp: {
    new:           { text: 'Новый',         tone: 'warn' },
    sign_required: { text: 'Ждёт подписи',  tone: 'warn' },
    pickup:        { text: 'Самовывоз',     tone: 'warn' },
    delivery:      { text: 'Доставка',      tone: 'warn' },
    archive:       { text: 'Завершён',      tone: 'ok'   },
  },
};

/** Статус одинаково во всех разделах. Неизвестный показывается как есть —
 *  лучше увидеть незнакомое слово, чем спрятать состояние документа.
 *  kind — необязательное уточнение вида сущности (например, 'cert'). */
export function Status({ value, kind }: { value?: string | null; kind?: string }) {
  if (!value) return null;
  const s = (kind && STATUS_BY_KIND[kind]?.[value]) ?? STATUS[value];
  return <Badge tone={s?.tone ?? 'dim'}>{s?.text ?? value}</Badge>;
}
