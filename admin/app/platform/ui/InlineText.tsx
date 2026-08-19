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

export function InlineText({ value, label, placeholder, mono, disabled, numeric, onSave }: {
  value: string;
  label?: string;
  placeholder?: string;
  /** Ровный шрифт: телефоны и коды. */
  mono?: boolean;
  disabled?: boolean;
  onSave: (v: string) => void | Promise<void>;
  /** Число: на телефоне откроется цифровая клавиатура, а не буквы. */
  numeric?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v !== value) void onSave(v);
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
