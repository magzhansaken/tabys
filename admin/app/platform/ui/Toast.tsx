'use client';
/**
 * ТОСТЫ — перенесено из их ui/Toast.tsx.
 *
 * Их довод, взятый как есть: до этого ошибка не показывалась нигде —
 * сервер отвечал 403, а в панели не менялось ничего, и человек жал
 * «Подтвердить» второй раз. Теперь у каждого действия есть ответ.
 *
 * У обратимых действий — кнопка «Отменить», и такой тост живёт дольше:
 * девять секунд против пяти. Столько нужно, чтобы прочитать и успеть
 * передумать.
 */
import { createContext, useCallback, useContext, useEffect, useMemo,
         useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'ok' | 'err';
export type ToastSpec = { text: string; kind?: ToastKind; undo?: () => void };
type Toast = ToastSpec & { id: number };

const ToastCtx = createContext<(t: ToastSpec) => void>(() => undefined);

/** const toast = useToast(); toast({ text: 'Готово' }) */
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((t: ToastSpec) => {
    const id = seq.current++;
    setItems((prev) => [...prev, { ...t, id }]);
  }, []);

  const drop = useCallback((id: number) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const api = useMemo(() => push, [push]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => drop(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  useEffect(() => {
    // С отменой держим дольше: столько нужно, чтобы прочитать и успеть
    // передумать.
    const ms = toast.undo ? 9000 : 5000;
    const t = window.setTimeout(onClose, ms);
    return () => window.clearTimeout(t);
  }, [toast, onClose]);

  return (
    <div className={`toast ${toast.kind === 'err' ? 'bad' : 'ok'}`}>
      <span className="dot" aria-hidden="true" />
      <span className="toast-text">{toast.text}</span>
      {toast.undo && (
        <button className="btn small" onClick={() => { toast.undo?.(); onClose(); }}>
          Отменить
        </button>
      )}
      {/* Крестик: тост живёт пять секунд, но если он закрыл нужное —
          человек должен уметь убрать его сразу. Их приём. */}
      <button className="btn small ghost toast-x" aria-label="Закрыть" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
