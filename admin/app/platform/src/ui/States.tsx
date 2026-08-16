/*
 * Состояния экрана: пока грузим и когда пусто.
 *
 * «Загружаем…» текстом посреди белого поля не говорит, чего ждать.
 * Скелетон показывает форму будущего содержимого, пустое состояние —
 * почему пусто и что нажать.
 */
import type { ReactNode } from 'react';

/** Строки-заглушки под таблицу. */
export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="skeleton-table" aria-hidden="true">
      <div className="sk-head">
        {Array.from({ length: cols }).map((_, i) => (
          <span key={i} className="sk sk-line" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div className="sk-row" key={r}>
          {Array.from({ length: cols }).map((_, c) => (
            <span key={c} className="sk sk-line" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Заглушки под сетку карточек: очередь оплат, партнёры, воронка. */
export function SkeletonCards({ count = 4, height = 132 }: { count?: number; height?: number }) {
  return (
    <div className="skeleton-cards" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} className="sk" style={{ height }} />
      ))}
    </div>
  );
}

/** Заглушка под ряд числовых карточек сводки. */
export function SkeletonMetrics({ count = 5 }: { count?: number }) {
  return (
    <div className="skeleton-metrics" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} className="sk" />
      ))}
    </div>
  );
}

/** Пусто — с причиной и действием. */
export function Empty({
  title,
  text,
  actionLabel,
  onAction,
}: {
  title: string;
  text?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <b>{title}</b>
      {text && <p>{text}</p>}
      {actionLabel && onAction && (
        <button className="btn" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/** Запрос не прошёл: показываем, что случилось, и даём повторить. */
export function Failed({ text, onRetry }: { text?: string; onRetry?: () => void }) {
  return (
    <div className="empty-state bad">
      <b>Не удалось загрузить</b>
      <p>{text ?? 'Сервер не ответил. Данные не потеряны — попробуйте ещё раз.'}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}

/** Обёртка раздела: заголовок, подпись, кнопки справа. */
export function PageHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="hint">{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
