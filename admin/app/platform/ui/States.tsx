'use client';
/**
 * СОСТОЯНИЯ ЭКРАНА — перенесено из их ui/States.tsx.
 *
 * Их довод, взятый как есть: «Загружаем…» текстом посреди белого поля
 * не говорит, чего ждать. Скелетон показывает форму будущего
 * содержимого, пустое состояние — почему пусто и что нажать.
 *
 * Разметка их классами: sk, sk-line, sk-row, sk-head, skeleton-table,
 * skeleton-cards, skeleton-metrics, empty-state, page-head,
 * page-actions, hint.
 */
import type { ReactNode } from 'react';

/** Строки-заглушки под таблицу. */
export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="skeleton-table" aria-hidden="true">
      <div className="sk-head">
        {Array.from({ length: cols }, (_, c) => <span key={c} className="sk sk-line" />)}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div className="sk-row" key={r}>
          {Array.from({ length: cols }, (_, c) => <span key={c} className="sk sk-line" />)}
        </div>
      ))}
    </div>
  );
}

/** Заглушки под сетку карточек. */
export function SkeletonCards({ count = 4, height = 132 }: { count?: number; height?: number }) {
  return (
    <div className="skeleton-cards" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="sk" style={{ height }} />
      ))}
    </div>
  );
}

/** Заглушки под ряд чисел сверху. */
export function SkeletonMetrics({ count = 5 }: { count?: number }) {
  return (
    <div className="skeleton-metrics" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <span key={i} className="sk" />)}
    </div>
  );
}

/** Пусто — с объяснением почему и что нажать. */
export function Empty({ title, text, actionLabel, onAction }: {
  title: string; text?: string; actionLabel?: string; onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <b>{title}</b>
      {text && <p>{text}</p>}
      {actionLabel && onAction && (
        <button className="btn" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

/** Не загрузилось. Главное здесь — сказать, что данные целы. */
export function Failed({ text, onRetry }: { text?: string; onRetry?: () => void }) {
  return (
    <div className="empty-state bad">
      <b>Не удалось загрузить</b>
      <p>{text ?? 'Сервер не ответил. Данные не потеряны — попробуйте ещё раз.'}</p>
      {onRetry && <button className="btn" onClick={onRetry}>Попробовать снова</button>}
    </div>
  );
}

/** Шапка раздела: название, объяснение, действия справа. */
export function PageHead({ title, hint, children }: {
  title?: string; hint?: string; children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        {title && <h1>{title}</h1>}
        {hint && <p className="hint">{hint}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}
