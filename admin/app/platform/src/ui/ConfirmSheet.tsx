/*
 * Лист подтверждения — замена системных окошек браузера.
 *
 * Опасное действие показывает последствие до нажатия: кого затронет,
 * до какого числа продлит, сколько уйдёт партнёру. Причина отказа —
 * поле в этом же листе, а не серое окошко браузера: её видно, её
 * можно переписать, и Esc возвращает как ни в чём не бывало.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type AskSpec = {
  title: string;
  /** Одна строка о том, что произойдёт и обратимо ли это. */
  sub?: string;
  /**
   * Последствия парами «что» → «сколько»: их читают глазами перед решением.
   * Если последствие зависит от выбора в самом листе — передайте функцию:
   * она пересчитается на каждый выбор.
   */
  effects?: [string, string][]
    | ((r: AskResult) => [string, string][])
    /* Последствие может считать сервер: пока считает, лист показывает
       прежние строки, а не мигает пустотой. */
    | ((r: AskResult) => Promise<[string, string][]>);
  /** Поимённо, кого затронет: примеры «было → станет» от сервера. */
  list?: { title: string; rows: string[]; more?: string };
  /** Выбор из готового списка: кому передать, на что заменить. */
  choice?: { label: string; options: { value: string; label: string }[]; initial?: string; hint?: string };
  /** Поле причины. required — кнопка не сработает, пока не написано. */
  reason?: { label: string; placeholder?: string; required?: boolean };
  /** Поле числа: дни, проценты, цена. Заменяет prompt(). */
  value?: {
    label: string; initial?: string; hint?: string; numeric?: boolean;
    /** Кнопка молчит, пока не введено ровно это: подтверждение набором. */
    mustEqual?: string;
  };
  confirmLabel?: string;
  cancelLabel?: string;
  /** Красная кнопка: необратимо или про чужие деньги. */
  danger?: boolean;
};

export type AskResult = { reason: string; value: string; choice: string };

type Pending = { spec: AskSpec; resolve: (r: AskResult | null) => void };

const AskCtx = createContext<(spec: AskSpec) => Promise<AskResult | null>>(
  async () => null,
);

/**
 * `const ask = useAsk();`
 * `const r = await ask({ title: '…', effects: [['Сумма', '45 000 ₸']] });`
 * `if (!r) return;` — человек отменил.
 */
export function useAsk(): (spec: AskSpec) => Promise<AskResult | null> {
  return useContext(AskCtx);
}

export function AskHost({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback(
    (spec: AskSpec) =>
      new Promise<AskResult | null>((resolve) => {
        setPending({ spec, resolve });
      }),
    [],
  );

  const close = useCallback(
    (r: AskResult | null) => {
      pending?.resolve(r);
      setPending(null);
    },
    [pending],
  );

  const api = useMemo(() => ask, [ask]);

  return (
    <AskCtx.Provider value={api}>
      {children}
      {pending && <Sheet spec={pending.spec} onClose={close} />}
    </AskCtx.Provider>
  );
}

function Sheet({ spec, onClose }: { spec: AskSpec; onClose: (r: AskResult | null) => void }) {
  const [reason, setReason] = useState('');
  const [value, setValue] = useState(spec.value?.initial ?? '');
  const [choice, setChoice] = useState(spec.choice?.initial ?? spec.choice?.options[0]?.value ?? '');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const needReason = spec.reason?.required === true;
  const mustEqual = spec.value?.mustEqual;
  const typedOk = !mustEqual || value.trim() === mustEqual;
  const ready = (!needReason || reason.trim().length > 0) && typedOk;

  const submit = () => {
    setTouched(true);
    if (!ready) return;
    onClose({ reason: reason.trim(), value: value.trim(), choice });
  };

  /* Последствие может зависеть от выбора прямо в листе — и считаться
     на сервере. Синхронное показываем сразу, серверное запрашиваем с
     небольшой задержкой, чтобы не дёргать его на каждую цифру. */
  const draft = { reason: reason.trim(), value: value.trim(), choice };
  const sync = typeof spec.effects === 'function' ? spec.effects(draft) : spec.effects;
  const isPromise = !!sync && typeof (sync as Promise<unknown>).then === 'function';
  const [remote, setRemote] = useState<[string, string][] | null>(null);
  const [counting, setCounting] = useState(false);
  const key = `${draft.value}|${draft.choice}`;

  useEffect(() => {
    if (typeof spec.effects !== 'function') return undefined;
    const probe = spec.effects(draft);
    if (!probe || typeof (probe as Promise<unknown>).then !== 'function') return undefined;
    let alive = true;
    setCounting(true);
    const timer = window.setTimeout(() => {
      void (probe as Promise<[string, string][]>).then((rows) => {
        if (!alive) return;
        setRemote(rows);
        setCounting(false);
      }).catch(() => alive && setCounting(false));
    }, 280);
    return () => { alive = false; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const effects = isPromise ? remote : (sync as [string, string][] | undefined);

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose(null)}>
      <div className="modal-card sheet" role="dialog" aria-modal="true" aria-label={spec.title}>
        <div className="sheet-head">
          <h2>{spec.title}</h2>
          <button className="btn small ghost sheet-x" aria-label="Закрыть" onClick={() => onClose(null)}>
            ×
          </button>
        </div>
        {spec.sub && <p className="hint">{spec.sub}</p>}

        {counting && !effects && <p className="hint">Считаем последствия…</p>}

        {effects && effects.length > 0 && (
          <dl className="effects">
            {effects.map(([label, val]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{val}</dd>
              </div>
            ))}
          </dl>
        )}

        {spec.choice && (
          <label>
            {spec.choice.label}
            <select autoFocus value={choice} onChange={(e) => setChoice(e.target.value)}>
              {spec.choice.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {spec.choice.hint && <i className="split">{spec.choice.hint}</i>}
          </label>
        )}

        {spec.list && spec.list.rows.length > 0 && (
          <div className="ask-list">
            <b>{spec.list.title}</b>
            <ul>
              {spec.list.rows.map((r) => <li key={r}>{r}</li>)}
            </ul>
            {spec.list.more && <i className="split">{spec.list.more}</i>}
          </div>
        )}

        {spec.value && (
          <label>
            {spec.value.label}
            <input
              autoFocus={!spec.choice}
              inputMode={spec.value.numeric === false ? 'text' : 'numeric'}
              value={value}
              onChange={(e) =>
                setValue(spec.value?.numeric === false ? e.target.value : e.target.value.replace(/[^\d-]/g, ''))
              }
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            {spec.value.hint && <i className="split">{spec.value.hint}</i>}
            {mustEqual && !typedOk && value.trim().length > 0 && (
              <i className="split">Пока не совпадает — нужно слово в слово: <b>{mustEqual}</b></i>
            )}
          </label>
        )}

        {spec.reason && (
          <label>
            {spec.reason.label}
            <textarea
              rows={3}
              autoFocus={!spec.value && !spec.choice}
              placeholder={spec.reason.placeholder}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {touched && !ready && <i className="err">Без причины отправить нельзя — её увидит партнёр</i>}
          </label>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={() => onClose(null)}>
            {spec.cancelLabel ?? 'Отмена'}
          </button>
          <button
            className={`btn ${spec.danger ? 'danger-solid' : 'primary'}`}
            disabled={!!mustEqual && !typedOk}
            onClick={submit}
          >
            {spec.confirmLabel ?? 'Подтвердить'}
          </button>
        </div>
      </div>
    </div>
  );
}
