'use client';
/**
 * Части документа: свёртываемый блок, позиции карточками, закреплённый итог.
 *
 * ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ДОБАВКА В ui.tsx — намеренно: ui.tsx читают
 * тридцать файлов, и любая правка там требует их проверки. Здесь только
 * новое, поэтому сломать нечего. Палитра и моноширинный шрифт берутся из
 * ui.tsx, чтобы вид остался единым.
 *
 * ЗАЧЕМ ЭТО НУЖНО. В документе на телефоне таблица позиций не читается:
 * пять значений в строке уезжают за экран. У UMAG позиция — карточка в
 * три строки: название и количество, штрихкод и цена, итог. Здесь то же,
 * а на компьютере остаётся таблица — там ширины хватает.
 *
 * Имена полей данных сюда не попадают: страница сама раскладывает свои
 * поля в name/barcode/qty/price/sum. Так расчёты и названия полей
 * остаются на странице, а вид — здесь.
 */
import React, { useEffect, useState } from 'react';
import { C, MONO, money, num } from './ui';

/* ═══════════════════════════════════════════════════════════════════
   СВЁРТЫВАЕМЫЙ БЛОК

   Владелец открыл приёмку — ему нужны товары, а не «Основная информация»
   и «Комментарий». Поэтому блоки сворачиваются, а выбор запоминается:
   человек не сворачивает одно и то же каждый день.
   ═══════════════════════════════════════════════════════════════════ */
export function Collapse({ title, right, children, open: openDefault = false, storageKey }: {
  title: string;
  /** короткая сводка справа: она и есть смысл свёрнутого блока */
  right?: any;
  children: any;
  open?: boolean;
  /** ключ, чтобы запомнить выбор; без него блок каждый раз как задан */
  storageKey?: string;
}) {
  const [open, setOpen] = useState(openDefault);

  // Хранилище — только после появления страницы: обращение во время
  // сборки роняет подготовку страниц, это уже случалось на проекте.
  useEffect(() => {
    if (!storageKey) return;
    try {
      const raw = window.localStorage.getItem('block:' + storageKey);
      if (raw != null) setOpen(raw === '1');
    } catch { /* хранилище недоступно — оставляем как задано */ }
  }, [storageKey]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { if (storageKey) window.localStorage.setItem('block:' + storageKey, next ? '1' : '0'); } catch {}
  };

  return (
    <section data-card="" style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden' }}>
      <button onClick={toggle} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 52,
          padding: '13px 18px', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left',
          fontFamily: 'inherit' }}>
        <span style={{ fontSize: 15.5, fontWeight: 600, flex: 1, color: C.text }}>{title}</span>
        {right != null && <span style={{ fontSize: 13, color: C.dim }}>{right}</span>}
        <span style={{ color: C.faint, fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && <div style={{ borderTop: `1px solid ${C.lineIn}`, padding: '16px 18px 18px' }}>{children}</div>}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ПОЗИЦИИ ДОКУМЕНТА

   На компьютере таблица, на телефоне карточки. Ширину узнаём после
   появления страницы: на сервере её нет, а расхождение разметки ломает
   разбор.
   ═══════════════════════════════════════════════════════════════════ */
export type DocLine = {
  name: string;
  barcode?: string | null;
  qty: number;
  unit?: string;
  price?: number | null;
  /** сумму считает страница: расчёты остаются там, где они уже были */
  sum?: number | null;
};

export function DocLines({ lines, onRemove, empty = 'В документе пока нет строк — найдите товар и добавьте первую' }: {
  lines: DocLine[];
  onRemove?: (index: number) => void;
  empty?: string;
}) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  if (!lines.length) {
    return <div style={{ color: C.dim, fontSize: 14, padding: '18px 0', lineHeight: 1.5 }}>{empty}</div>;
  }

  const dash = <span style={{ color: C.faint }}>—</span>;

  if (narrow) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {lines.map((l, i) => (
          <div key={i} data-card="" style={{ background: C.card, border: `1px solid ${C.line}`,
            borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '11px 14px',
              borderBottom: `1px solid ${C.lineIn}` }}>
              <span style={{ flex: 1, fontSize: 15.5, fontWeight: 600, lineHeight: 1.3 }}>{l.name}</span>
              <span style={{ fontFamily: MONO, fontSize: 14, whiteSpace: 'nowrap' }}>
                {num(l.qty)} {l.unit ?? 'шт.'}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, padding: '9px 14px',
              borderBottom: `1px solid ${C.lineIn}` }}>
              <span style={{ flex: 1, fontFamily: MONO, fontSize: 13, color: C.dim }}>{l.barcode || dash}</span>
              <span style={{ fontFamily: MONO, fontSize: 14, color: C.prose, whiteSpace: 'nowrap' }}>
                {l.price != null ? money(l.price) : dash}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 14px', background: C.sunken }}>
              {onRemove && (
                <button onClick={() => onRemove(i)}
                  style={{ minHeight: 44, padding: '0 12px', border: 0, borderRadius: 8, background: 'transparent',
                    color: C.faint, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Убрать</button>
              )}
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 13, color: C.dim }}>Итого:</span>
              <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>
                {l.sum != null ? money(l.sum) : dash}
              </span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, fontVariantNumeric: 'tabular-nums' }}>
      <thead>
        <tr>
          {['Товар', 'Штрихкод', 'Кол-во', 'Цена', 'Сумма', ''].map((h, i) => (
            <th key={i} style={{ textAlign: i >= 2 && i <= 4 ? 'right' : 'left', color: C.dim, fontWeight: 500,
              fontSize: 12, padding: '0 12px 9px', borderBottom: `1px solid #D3D3C9`, whiteSpace: 'nowrap' }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <td style={{ padding: '11px 12px', borderBottom: `1px solid ${C.lineIn}`, fontWeight: 500 }}>{l.name}</td>
            <td style={{ padding: '11px 12px', borderBottom: `1px solid ${C.lineIn}`, fontFamily: MONO,
              fontSize: 13, color: C.dim, whiteSpace: 'nowrap' }}>{l.barcode || dash}</td>
            <td style={{ padding: '11px 12px', borderBottom: `1px solid ${C.lineIn}`, textAlign: 'right',
              fontFamily: MONO, whiteSpace: 'nowrap' }}>{num(l.qty)}</td>
            <td style={{ padding: '11px 12px', borderBottom: `1px solid ${C.lineIn}`, textAlign: 'right',
              fontFamily: MONO, whiteSpace: 'nowrap' }}>{l.price != null ? money(l.price) : dash}</td>
            <td style={{ padding: '11px 12px', borderBottom: `1px solid ${C.lineIn}`, textAlign: 'right',
              fontFamily: MONO, fontWeight: 500, whiteSpace: 'nowrap' }}>{l.sum != null ? money(l.sum) : dash}</td>
            <td style={{ padding: '11px 12px', borderBottom: `1px solid ${C.lineIn}`, textAlign: 'right' }}>
              {onRemove && (
                <button onClick={() => onRemove(i)} title="Убрать строку"
                  style={{ width: 32, height: 32, border: 0, borderRadius: 8, background: 'transparent',
                    color: C.faint, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>✕</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ЗАКРЕПЛЁННЫЙ ИТОГ

   При длинном документе итог уезжает вверх, и человек проводит приёмку,
   не видя суммы. На телефоне итог прижат к низу экрана, на компьютере
   едет рядом с содержимым. Главное действие — здесь же, у цифры: его
   нажимают, глядя на сумму, а не на шапку раздела.
   ═══════════════════════════════════════════════════════════════════ */
export function StickyTotal({ label = 'Итого по документу', value, note, action, actionLabel, disabled, extra }: {
  label?: string;
  value: number;
  /** что произойдёт после действия — последствие, а не «вы уверены?» */
  note?: string;
  action?: () => void;
  actionLabel?: string;
  disabled?: boolean;
  /** строка под суммой: позиции, единицы */
  extra?: string;
}) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  if (narrow) {
    return (
      <div data-no-print="" style={{ position: 'sticky', bottom: 0, zIndex: 5, background: C.card,
        borderTop: `1px solid ${C.line}`, margin: '14px -16px 0', padding: '10px 16px 14px',
        boxShadow: '0 -8px 24px rgba(23,33,29,.08)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: 13, color: C.dim }}>{label}</span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: MONO, fontSize: 22, fontWeight: 600, whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums' }}>{money(value)}</span>
        </div>
        {action && (
          <button onClick={action} disabled={disabled}
            style={{ width: '100%', minHeight: 50, border: 0, borderRadius: 12, background: C.accent,
              color: '#fff', fontSize: 16, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.4 : 1, fontFamily: 'inherit' }}>{actionLabel ?? 'Провести'}</button>
        )}
      </div>
    );
  }

  return (
    <section data-card="" style={{ position: 'sticky', top: 112, background: C.card,
      border: `1.5px solid ${C.accent}`, borderRadius: 12, padding: '18px 20px' }}>
      <div style={{ fontSize: 12.5, color: C.dim }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 29, fontWeight: 600, lineHeight: 1.1, marginTop: 6,
        whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{money(value)}</div>
      {extra && <div style={{ fontSize: 13, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>{extra}</div>}
      {action && (
        <button onClick={action} disabled={disabled}
          style={{ width: '100%', minHeight: 44, marginTop: 14, border: 0, borderRadius: 8, background: C.accent,
            color: '#fff', fontSize: 15, fontWeight: 500, cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.4 : 1, fontFamily: 'inherit' }}>{actionLabel ?? 'Провести'}</button>
      )}
      {note && <div style={{ fontSize: 12.5, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>{note}</div>}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   СТРОКА ПОИСКА ТОВАРА СО СКАНЕРОМ

   Владелец принимает товар, сканируя телефоном. Поле 16 px, кнопки 44 px:
   иначе iOS увеличивает страницу, а палец промахивается.

   Сканер камерой подключается снаружи: onScan вызывается по кнопке, и
   страница сама решает, чем сканировать. Если onScan не передан, кнопки
   нет — обещанной и не работающей кнопки быть не должно.
   ═══════════════════════════════════════════════════════════════════ */
export function ScanRow({ value, onChange, onAdd, onScan, disabled, placeholder = 'Поиск товара / штрихкод' }: {
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  onScan?: () => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        onKeyDown={(e) => { if (e.key === 'Enter' && !disabled) onAdd(); }}
        style={{ flex: 1, minWidth: 220, height: 44, padding: '0 12px', border: `1px solid #D8D8CF`,
          borderRadius: 8, fontSize: 16, background: C.card, color: C.text, outline: 'none' }} />
      {onScan && (
        <button onClick={onScan} title="Сканировать камерой"
          style={{ minWidth: 56, height: 44, border: `1px solid #D8D8CF`, borderRadius: 8, background: C.card,
            fontSize: 13, cursor: 'pointer', color: C.prose, fontFamily: MONO }}>скан</button>
      )}
      <button onClick={onAdd} disabled={disabled}
        style={{ minHeight: 44, padding: '0 17px', border: 0, borderRadius: 8, background: C.accent, color: '#fff',
          fontSize: 14, fontWeight: 500, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
          fontFamily: 'inherit' }}>Добавить</button>
    </div>
  );
}
