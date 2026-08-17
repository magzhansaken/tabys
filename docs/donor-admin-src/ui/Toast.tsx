/*
 * Тосты: короткий ответ системы на действие.
 *
 * До этого ошибка мутации не показывалась нигде — сервер отвечал 403,
 * а в панели не менялось ничего, и человек жал «Подтвердить» второй
 * раз. Теперь у каждого действия есть ответ, а у обратимых — «Отменить».
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastKind = 'ok' | 'err';

export type ToastSpec = {
  text: string;
  kind?: ToastKind;
  /** Показывает кнопку «Отменить». Тост живёт дольше обычного. */
  undo?: () => void;
};

type Toast = ToastSpec & { id: number };

const ToastCtx = createContext<(t: ToastSpec) => void>(() => undefined);

/** Показать тост: `const toast = useToast(); toast({ text: 'Готово' })`. */
export function useToast(): (t: ToastSpec) => void {
  return useContext(ToastCtx);
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((t: ToastSpec) => {
    seq.current += 1;
    const id = seq.current;
    setItems((prev) => [...prev, { ...t, id }]);
  }, []);

  const drop = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const api = useMemo(() => push, [push]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <ToastLine key={t.id} toast={t} onClose={() => drop(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastLine({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    const ms = toast.undo ? 9000 : 5000;
    const t = window.setTimeout(onClose, ms);
    return () => window.clearTimeout(t);
  }, [toast, onClose]);

  return (
    <div className={`toast ${toast.kind === 'err' ? 'bad' : 'ok'}`}>
      <span className="dot" aria-hidden="true" />
      <span className="toast-text">{toast.text}</span>
      {toast.undo && (
        <button
          className="btn small"
          onClick={() => {
            toast.undo?.();
            onClose();
          }}
        >
          Отменить
        </button>
      )}
      <button className="btn small ghost toast-x" aria-label="Закрыть" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

/** Текст ошибки сервера в человеческом виде. */
export function errText(e: unknown, fallback = 'Не получилось — попробуйте ещё раз'): string {
  if (e instanceof Error && e.message) return e.message.slice(0, 160);
  return fallback;
}
