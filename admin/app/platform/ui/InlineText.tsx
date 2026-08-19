'use client';
/**
 * ПРАВКА НА МЕСТЕ — перенесено из их ui/InlineText.tsx.
 *
 * Их довод, взятый как есть: опечатки в названии и телефоне гонять
 * через лист подтверждения незачем — это не деньги. Клик по значению
 * превращает его в поле.
 *
 * Enter сохраняет, Escape возвращает как было, УХОД С ПОЛЯ ТОЖЕ
 * СОХРАНЯЕТ — человек не должен помнить, какая кнопка «настоящая».
 */
import { useEffect, useRef, useState } from 'react';

export function InlineText({ value, label, placeholder, mono, disabled, numeric, onSave , onSame }: {
  value: string;
  label?: string;
  placeholder?: string;
  /** Ровный шрифт: телефоны и коды. */
  mono?: boolean;
  disabled?: boolean;
  onSave: (v: string) => void | Promise<void>;
  /** Число: на телефоне откроется цифровая клавиатура, а не буквы. */
  numeric?: boolean;
  /** Ввели то же самое: сказать об этом, а не молчать. */
  onSame?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();

    // Сравниваем ЧИСЛА, а не строки, если поле числовое: «14 900» и
    // «14900» — одно значение, но строки разные, и без этого уходил
    // бессмысленный запрос.
    const same = numeric
      ? Number(v.replace(/[^\d-]/g, '')) === Number(String(value).replace(/[^\d-]/g, ''))
      : v === value;

    if (same) {
      // ТО ЖЕ ЗНАЧЕНИЕ — говорим об этом. Раньше тут была тишина:
      // человек правил цену, возвращал прежнюю и не получал НИЧЕГО.
      // Ни «сохранено», ни отказа — и решал, что правка не работает.
      onSame?.();
      return;
    }
    void onSave(v);
  };

  if (disabled) {
    return <span className={mono ? 'inline-mono' : undefined}>
      {value || placeholder || '—'}
    </span>;
  }

  if (!editing) {
    return (
      <button
        className={`cell-edit inline-edit ${mono ? 'inline-mono' : ''} ${value ? '' : 'empty'}`}
        onClick={() => setEditing(true)}
        title={label ? `Изменить: ${label}` : 'Изменить'}>
        {value || placeholder || '—'}
      </button>
    );
  }

  return (
    <input
      ref={ref}
      className={`cell-input inline-input ${mono ? 'inline-mono' : ''}`}
      /* Цену и количество правят В ЯЧЕЙКЕ. Без этого на телефоне
         открывалась буквенная клавиатура, и цифры приходилось искать
         через переключение — при правке цены это лишний шаг там, где
         человек и так осторожничает. */
      inputMode={numeric ? 'numeric' : undefined}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      /* Уход с поля сохраняет: человек не должен помнить, какая кнопка
         настоящая. */
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { setDraft(value); setEditing(false); }
      }}
    />
  );
}
