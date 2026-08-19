'use client';
/**
 * МЕНЮ СТРОКИ — перенесено из их ui/RowMenu.tsx.
 *
 * Их довод, взятый как есть: шесть целей по 32 px в правой колонке —
 * это была панель управления, размноженная на каждого клиента. В
 * строке остаются два действия, которыми пользуются каждый день,
 * остальное уезжает сюда.
 *
 * Их приёмы, взятые целиком:
 *   меню рисуется ПОВЕРХ таблицы, а не внутри строки — иначе последняя
 *     строка обрезает его нижним краем;
 *   если снизу мало места, разворачивается ВВЕРХ;
 *   не вылезает за правый край экрана;
 *   Escape и клик мимо закрывают.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type RowAction = {
  label: string;
  onClick: () => void;
  /** Красным: необратимое или про чужие деньги. */
  danger?: boolean;
  /** Строка под названием: чем это кончится. */
  hint?: string;
};

export function RowMenu({ actions, label = 'Ещё', showLabel }: {
  actions: RowAction[];
  label?: string;
  /** Показать подпись вместо «···»: там, где меню — единственный путь. */
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      const inside = box.current?.contains(t) || list.current?.contains(t);
      if (!inside) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    // Прокрутка страницы уводит меню от кнопки — проще закрыть.
    window.addEventListener('scroll', () => setOpen(false), { once: true });
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    const btn = box.current?.querySelector('button');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = 240;
    // 44 — высота пункта под палец, та же, что в CSS.
    //
    // Предел был 320, и это ВРАЛО: восемь пунктов дают 364, разворот
    // считался по 320, и последний пункт уезжал за край экрана. В
    // клиентах последний — «Удалить магазин…».
    //
    // Теперь предел считается от экрана, а список умеет прокручиваться
    // (см. .rowmenu-list в стилях): меню не бывает выше того, что
    // видно, и ничего не теряется.
    const room = Math.max(200, window.innerHeight - 24);
    const height = Math.min(actions.length * 44 + 12, room);
    const below = window.innerHeight - r.bottom;
    // Снизу мало места — разворачиваем вверх.
    const top = below < height + 12 ? r.top - height - 6 : r.bottom + 6;
    const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
    setPos({ top: Math.max(8, top), left });
  }, [open, actions.length]);

  if (actions.length === 0) return null;

  return (
    <div className="rowmenu" ref={box}>
      {/* Подпись рядом с точками, если её просят.
          В воронке на телефоне это ЕДИНСТВЕННЫЙ способ переставить
          карточку: ручка перетаскивания там спрятана, потому что
          дальше соседнего столбца пальцем не дотянуть. «···» сам по
          себе не говорит, что за ним сдвиг. */}
      <button className={`btn small ghost rowmenu-x${showLabel ? ' with-label' : ''}`}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}>
        {showLabel ? label : '···'}
      </button>

      {/* Поверх таблицы, а не внутри строки: иначе последняя строка
          обрежет меню нижним краем. */}
      {open && pos && typeof document !== 'undefined' && createPortal((
        <div className="rowmenu-list" role="menu" ref={list}
          style={{ top: pos.top, left: pos.left }}>
          {actions.map((a) => (
            <button key={a.label} role="menuitem"
              className={a.danger ? 'danger' : ''}
              onClick={() => { setOpen(false); a.onClick(); }}>
              <span>{a.label}</span>
              {a.hint && <i>{a.hint}</i>}
            </button>
          ))}
        </div>
      ), document.body)}
    </div>
  );
}
