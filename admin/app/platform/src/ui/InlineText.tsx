/*
 * Правка на месте: клик по значению — поле.
 *
 * Опечатки в названии и телефоне гонять через лист подтверждения
 * незачем: это не деньги. Enter сохраняет, Esc возвращает как было,
 * уход с поля тоже сохраняет — человек не должен помнить, какая
 * кнопка «настоящая».
 */
import { useState } from 'react';

export function InlineText({ value, label, placeholder, mono, disabled, onSave }: {
  value: string | null;
  /** Что это за поле — читает клавиатура и подсказка при наведении. */
  label: string;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  onSave: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (disabled) {
    return <span className={mono ? 'inline-mono' : undefined}>{value || placeholder || '—'}</span>;
  }

  if (!editing) {
    return (
      <button
        className={`cell-edit inline-edit ${mono ? 'inline-mono' : ''} ${value ? '' : 'empty'}`}
        title={`Изменить: ${label}`}
        aria-label={`Изменить: ${label}`}
        onClick={() => { setDraft(value ?? ''); setEditing(true); }}
      >
        {value || placeholder || 'не указано'}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next === (value ?? '').trim()) return;
    onSave(next);
  };

  return (
    <input
      className={`cell-input inline-input ${mono ? 'inline-mono' : ''}`}
      autoFocus
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
      }}
    />
  );
}
