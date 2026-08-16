/*
 * Меню строки: одна кнопка вместо шести.
 *
 * В строке остаются два действия, которыми пользуются каждый день,
 * остальное уезжает сюда. Шесть целей по 32 px в правой колонке —
 * это была панель управления, размноженная на каждого клиента.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type RowAction = {
  label: string;
  onClick: () => void;
  /** Красный пункт: отключение, удаление, отказ. */
  danger?: boolean;
};

export function RowMenu({ actions, label = 'Ещё' }: { actions: RowAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  /*
   * Меню живёт в слое поверх страницы, а не внутри таблицы.
   *
   * У таблицы стоит overflow: clip — иначе её углы не скругляются, — и
   * меню у нижних строк обрезалось рамкой: пункт «Назначить партнёра»
   * просто не было видно. Портал выносит список из-под ножа, а
   * координаты считаются от кнопки. Заодно решается вторая беда: если
   * снизу мало места, меню раскрывается вверх
   */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  /*
   * Сам список тоже «свой».
   *
   * Он живёт в слое поверх страницы, поэтому сторож «клик мимо меню»
   * считал нажатие на пункт чужим: меню закрывалось раньше, чем
   * срабатывало действие, и человек видел пустоту вместо окна
   * (жалоба: «назначить партнёра нажал — ничего не вышло»)
   */
  const list = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      const inside = box.current?.contains(t) || list.current?.contains(t);
      if (!inside) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (actions.length === 0) return null;

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const btn = box.current?.querySelector('button');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const width = 240;
    const height = Math.min(actions.length * 40 + 12, 320);
    // снизу мало места — раскрываем вверх; справа мало — прижимаем к краю
    const below = window.innerHeight - r.bottom;
    const top = below < height + 12 ? r.top - height - 6 : r.bottom + 6;
    const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
    setPos({ top: Math.max(8, top), left });
  }, [open, actions.length]);

  return (
    <div className="rowmenu" ref={box}>
      <button
        className="btn small ghost rowmenu-x"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ···
      </button>
      {open && pos && createPortal((
        <div className="rowmenu-list" role="menu" ref={list}
          style={{ top: pos.top, left: pos.left }}>
          {actions.map((a) => (
            <button
              key={a.label}
              role="menuitem"
              className={a.danger ? 'danger' : ''}
              onClick={() => { setOpen(false); a.onClick(); }}
            >
              {a.label}
            </button>
          ))}
        </div>
      ), document.body)}
    </div>
  );
}
