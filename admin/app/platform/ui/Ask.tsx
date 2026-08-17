'use client';
/**
 * ЛИСТ ПОДТВЕРЖДЕНИЯ — перенесён из их ui/ConfirmSheet.tsx.
 *
 * Их довод, взятый как есть: опасное действие показывает последствие
 * ДО нажатия — кого затронет, до какого числа продлит, сколько уйдёт
 * партнёру. Причина отказа — поле в этом же листе, а не серое окошко
 * браузера: её видно, её можно переписать, и Escape возвращает как ни
 * в чём не бывало.
 *
 * Шесть возможностей, все их:
 *   effects — последствия парами «что → сколько»;
 *   list    — поимённо, кого затронет;
 *   choice  — выбор из списка прямо в листе;
 *   reason  — поле причины, можно потребовать обязательно;
 *   value   — поле числа вместо prompt();
 *   mustEqual — подтверждение НАБОРОМ: кнопка молчит, пока не наберёшь
 *               название слово в слово.
 *
 * Разметка их классами: modal, modal-card sheet, sheet-head, sheet-x,
 * effects, ask-list, split, hint, err, modal-actions.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type AskDraft = { reason: string; value: string; choice: string };

export type AskSpec = {
  title: string;
  /** Одна строка о том, что произойдёт и обратимо ли это. */
  sub?: string;
  /**
   * Последствия парами «что» → «сколько»: их читают глазами перед
   * решением. Если последствие зависит от выбора в самом листе —
   * передайте функцию: она пересчитается на каждый выбор.
   */
  effects?: [string, string][] | ((d: AskDraft) => [string, string][]);
  /** Поимённо, кого затронет. */
  list?: { title: string; rows: string[]; more?: string };
  /** Выбор из готового списка: кому передать, на что заменить. */
  choice?: { label: string; options: { value: string; label: string }[];
             initial?: string; hint?: string };
  /** Поле причины. required — кнопка не сработает, пока не написано. */
  reason?: { label: string; placeholder?: string; required?: boolean };
  /** Поле числа: дни, проценты, цена. Заменяет prompt(). */
  value?: { label: string; initial?: string; hint?: string; numeric?: boolean;
            /** Кнопка молчит, пока не введено ровно это. */
            mustEqual?: string };
  confirmLabel?: string;
  cancelLabel?: string;
  /** Красная кнопка: необратимо или про чужие деньги. */
  danger?: boolean;
};

export type AskResult = { reason: string; value: string; choice: string };

type Pending = { spec: AskSpec; resolve: (r: AskResult | null) => void };

const AskCtx = createContext<(s: AskSpec) => Promise<AskResult | null>>(
  async () => null,
);

/** const ask = useAsk(); const r = await ask({…}); if (!r) return; */
export const useAsk = () => useContext(AskCtx);

export function AskHost({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback(
    (spec: AskSpec) => new Promise<AskResult | null>((resolve) => {
      setPending({ spec, resolve });
    }), []);

  const close = useCallback((r: AskResult | null) => {
    pending?.resolve(r);
    setPending(null);
  }, [pending]);

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
  const [choice, setChoice] = useState(
    spec.choice?.initial ?? spec.choice?.options[0]?.value ?? '');
  const [touched, setTouched] = useState(false);

  // Escape возвращает как ни в чём не бывало — их правило.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(null); };
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

  // Последствие может зависеть от выбора прямо в листе.
  const draft: AskDraft = { reason: reason.trim(), value: value.trim(), choice };
  const effects = typeof spec.effects === 'function' ? spec.effects(draft) : spec.effects;

  return (
    <div className="modal"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(null); }}>
      <div className="modal-card sheet" role="dialog" aria-modal="true" aria-label={spec.title}>
        <div className="sheet-head">
          <b>{spec.title}</b>
          <button className="btn small ghost sheet-x" onClick={() => onClose(null)}
            aria-label="Закрыть">×</button>
        </div>

        {spec.sub && <p className="hint">{spec.sub}</p>}

        {/* Последствия парами: их читают глазами перед решением. */}
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

        {/* Поимённо, кого затронет: «применилось к 47 клиентам» узнавать
            постфактум нельзя. */}
        {spec.list && spec.list.rows.length > 0 && (
          <div className="ask-list">
            <b>{spec.list.title}</b>
            <ul>{spec.list.rows.map((r) => <li key={r}>{r}</li>)}</ul>
            {spec.list.more && <i className="split">{spec.list.more}</i>}
          </div>
        )}

        {spec.choice && (
          <label>
            {spec.choice.label}
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              {spec.choice.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {spec.choice.hint && <i className="split">{spec.choice.hint}</i>}
          </label>
        )}

        {spec.value && (
          <label>
            {spec.value.label}
            <input value={value} autoFocus
              inputMode={spec.value.numeric ? 'numeric' : undefined}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready) submit(); }} />
            {spec.value.hint && <i className="split">{spec.value.hint}</i>}
            {/* Подтверждение набором: пока человек набирает название,
                он успевает подумать. */}
            {mustEqual && !typedOk && (
              <i className="split">
                Пока не совпадает — нужно слово в слово: <b>{mustEqual}</b>
              </i>
            )}
          </label>
        )}

        {spec.reason && (
          <label>
            {spec.reason.label}
            <input value={reason} autoFocus={!spec.value}
              placeholder={spec.reason.placeholder}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready) submit(); }} />
            {touched && needReason && !reason.trim() && (
              <div className="err">Без причины нельзя — тот, кого это касается, должен понять, что не так</div>
            )}
          </label>
        )}

        <div className="modal-actions">
          <button className="btn ghost" onClick={() => onClose(null)}>
            {spec.cancelLabel ?? 'Отмена'}
          </button>
          <button className={`btn ${spec.danger ? 'danger-solid' : 'primary'}`}
            onClick={submit} disabled={!ready}>
            {spec.confirmLabel ?? 'Подтвердить'}
          </button>
        </div>
      </div>
    </div>
  );
}
