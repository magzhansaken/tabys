/*
 * Массовые действия по клиентам.
 *
 * Правка денег у десятков заведений необратима, поэтому шага всегда
 * два: сперва сервер отвечает, кого затронет и что станет, и только
 * потом применение — тем же листом подтверждения, что и одиночное
 * решение по оплате. Одинаковые действия должны выглядеть одинаково.
 *
 * Группа берётся из тех же четырёх значений, что понимает сервер.
 * Если строки отмечены галочками, в тело уходит tenantIds — сервер
 * считает список сильнее фильтра и берёт ровно отмеченных, до 500 строк,
 * всегда без демо-заведений.
 */
import { useState } from 'react';
import { humanError } from './errors';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TenantRow } from '@dastarhan/contracts';
import { call } from '../main';
import { useAsk } from './ConfirmSheet';
import { useToast } from './Toast';

type Preview = {
  count: number;
  note: string;
  examples: { name: string; before: string | null; after: string | null }[];
};

const ACTIONS = [
  { value: 'GRACE', label: 'Продлить срок, дней' },
  { value: 'PRICE_PCT', label: 'Изменить основную цену, %' },
] as const;

const COHORTS = [
  { value: 'all', label: 'всем' },
  { value: 'active', label: 'действующим' },
  { value: 'expired', label: 'просроченным' },
  { value: 'trial', label: 'на пробном' },
] as const;

const money = (v: number) => `${Math.round(v / 100).toLocaleString('ru-RU')} ₸`;

/** Сервер берёт не больше пятисот строк за раз. */
const MAX_PICKED = 500;

/** Кого затронет по загруженному списку — для оценки денег до ответа сервера. */
function cohortRows(rows: TenantRow[], cohort: string): TenantRow[] | null {
  if (cohort === 'all') return rows;
  if (cohort === 'active') return rows.filter((r) => r.status === 'ACTIVE');
  if (cohort === 'expired') return rows.filter((r) => r.status === 'EXPIRED');
  return null; /* «на пробном» знает только сервер */
}

export function BulkPanel({ token, rows, selected, onClear, onShowSelected }: {
  token: string;
  rows: TenantRow[];
  /** Отмеченные строки: если есть — действие идёт ровно по ним. */
  selected: TenantRow[];
  onClear: () => void;
  onShowSelected: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useAsk();
  const [action, setAction] = useState<'GRACE' | 'PRICE_PCT'>('GRACE');
  const [cohort, setCohort] = useState<string>('expired');
  const [value, setValue] = useState('3');
  const [open, setOpen] = useState(false);

  const picked = selected.length > 0;
  const overCap = selected.length > MAX_PICKED;

  /* Список сильнее фильтра — это правило сервера, повторяем его в теле. */
  const body = () => (picked
    ? { action, filter: cohort, value: Number(value) || 0, tenantIds: selected.map((r) => r.id) }
    : { action, filter: cohort, value: Number(value) || 0 });

  const apply = useMutation({
    mutationFn: () => call<{ done: number }>('/bulk/apply', { method: 'POST', token, body: body() }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
      onClear();
      toast({ text: `Готово: изменено ${r.done} заведений` });
    },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const preview = useMutation({
    mutationFn: () => call<Preview>('/bulk/preview', { method: 'POST', token, body: body() }),
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
    onSuccess: async (p) => {
      const v = Number(value) || 0;
      const mine = picked ? selected : cohortRows(rows, cohort);
      const sum = mine ? mine.reduce((a, r) => a + r.planPrice, 0) : null;

      const effects: [string, string][] = [
        ['Кого затронет', `${p.count} заведений`],
        ['Откуда список', picked ? 'отмеченные строки' : COHORTS.find((c) => c.value === cohort)?.label ?? cohort],
        ['Действие', action === 'GRACE' ? `продлить срок на ${v} дн.` : `изменить основную цену на ${v}%`],
      ];
      if (action === 'PRICE_PCT' && sum !== null) {
        effects.push(['Доход этой группы сейчас', money(sum)]);
        effects.push(['Станет', `${money(Math.round(sum * (1 + v / 100)))} · ориентир`]);
      }

      /* Поимённо: если строки отмечены вручную — показываем именно их,
         даже если сервер вернул примеры в другом порядке. */
      const named = p.examples.length
        ? p.examples.slice(0, 6).map((e) => `${e.name}: ${e.before ?? '—'} → ${e.after ?? '—'}`)
        : selected.slice(0, 6).map((r) => r.name);

      const answer = await ask({
        title: action === 'GRACE' ? 'Продлить срок' : 'Изменить цену',
        sub: p.note || 'Отменить одним движением будет нельзя.',
        effects,
        list: named.length
          ? {
            title: picked ? `Отмечено ${selected.length} · первые в списке` : 'Как изменится',
            rows: named,
            more: p.count > named.length ? `…и ещё ${p.count - named.length}` : undefined,
          }
          : undefined,
        danger: true,
        confirmLabel: `Применить к ${p.count}`,
      });
      if (!answer || p.count === 0) return;
      apply.mutate();
    },
  });

  const controls = (
    <>
      <select value={action} onChange={(e) => setAction(e.target.value as 'GRACE')}>
        {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
      </select>
      {!picked && (
        <select value={cohort} onChange={(e) => setCohort(e.target.value)}>
          {COHORTS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )}
      <input inputMode="numeric" style={{ width: 96 }} value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^\d-]/g, ''))} />
      <button className="btn" disabled={preview.isPending || apply.isPending || overCap}
        onClick={() => preview.mutate()}>
        {preview.isPending ? 'Считаем…' : 'Посмотреть, кого затронет'}
      </button>
    </>
  );

  /* Счётчик отмеченных висит постоянно: о тринадцати строках, отмеченных
     три экрана назад, человек должен помнить без усилий. */
  if (picked) {
    return (
      <div className="picked-bar" role="region" aria-label="Отмеченные клиенты">
        <b>Выбрано {selected.length}</b>
        <button className="btn small ghost" onClick={onShowSelected}>Показать только их</button>
        {overCap && <span className="err">За раз можно не больше {MAX_PICKED}</span>}
        <div className="picked-controls">{controls}</div>
        <button className="btn small ghost" onClick={onClear}>Снять выбор</button>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="bulk-strip">
        <span>Массовые действия — по отмеченным строкам или по группе, всегда с предпросмотром</span>
        <button className="btn small" onClick={() => setOpen(true)}>Открыть</button>
      </div>
    );
  }

  return (
    <section className="bulk">
      <div className="bulk-top">
        <h3>Массовые действия</h3>
        <button className="btn small ghost" onClick={() => setOpen(false)}>Свернуть</button>
      </div>
      <div className="row">{controls}</div>
      <p className="hint">
        Отметьте строки галочками — действие применится ровно к ним. Без отметок
        работает группа слева. В обоих случаях сначала покажем поимённо, кого затронет.
      </p>
    </section>
  );
}
