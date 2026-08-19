/*
 * Клавиатура в окне: Escape закрывает, Tab не выпускает.
 *
 * НАЙДЕНО СВЕРКОЙ. Лист подтверждения это умел, а четыре других окна —
 * заведение клиента, отметка оплаты, форма заявки и показ доступов —
 * нет. В них:
 *
 *   Escape не закрывал, и уйти можно было только мышью по крестику;
 *   Tab после последней кнопки уходил В СТРАНИЦУ ПОД ОКНОМ. Человек
 *     ходил по кнопкам, которых не видит — окно их закрывает, — и
 *     Enter срабатывал вслепую. А под окном «Удалить магазин».
 *
 * Владелец платформы работает в панели весь день и мышь берёт реже,
 * чем кажется: заводит клиента, отмечает оплату, снова заводит.
 */
import { useEffect, useRef } from 'react';

export function useSheet(onClose: () => void) {
  const card = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;

      const box = card.current;
      if (!box) return;
      const stops = box.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const live = Array.from(stops).filter((el) => !el.hasAttribute('disabled'));
      if (live.length === 0) return;

      const first = live[0];
      const last = live[live.length - 1];
      const here = document.activeElement;

      // По кругу: с последней кнопки — на первую, и наоборот.
      if (!e.shiftKey && here === last) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && here === first) { e.preventDefault(); last.focus(); }
      else if (!box.contains(here)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return card;
}
