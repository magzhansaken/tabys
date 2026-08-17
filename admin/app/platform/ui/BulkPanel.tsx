'use client';
/**
 * МАССОВЫЕ ДЕЙСТВИЯ — перенесено из их ui/BulkPanel.tsx.
 *
 * Их довод, взятый как есть: правка денег у десятков магазинов
 * необратима, поэтому шага всегда два. Сперва сервер отвечает, кого
 * затронет и что станет, и только потом применение — ТЕМ ЖЕ листом
 * подтверждения, что и одиночное решение по оплате. Одинаковые
 * действия должны выглядеть одинаково.
 *
 * Их приёмы:
 *   поимённый список, кого затронет, прямо в листе — «применилось к 47
 *     клиентам» постфактум узнавать нельзя;
 *   «…и ещё N», если список длинный;
 *   работа либо по отмеченным строкам, либо по группе целиком.
 */
import { useState } from 'react';
import { api, money } from '../lib';
import { useAsk } from './Ask';
import { useToast } from './Toast';
import { humanError } from './errors';

const COHORTS = [
  { value: 'all',      label: 'всем' },
  { value: 'active',   label: 'действующим' },
  { value: 'expired',  label: 'просроченным' },
  { value: 'trial',    label: 'на пробном' },
];

export function BulkPanel({ rows, selected, onClear, onDone }: {
  rows: any[];
  selected: string[];
  onClear: () => void;
  onDone: () => void;
}) {
  const [action, setAction] = useState<'grace' | 'disable' | 'enable'>('grace');
  const [days, setDays] = useState('7');
  const [cohort, setCohort] = useState('all');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const ask = useAsk();
  const toast = useToast();

  const picked = selected.length > 0;

  // Кого затронет: либо отмеченные, либо группа целиком.
  const targets = picked
    ? rows.filter((r) => selected.includes(r.id))
    : rows.filter((r) =>
        cohort === 'all' ? true
        : cohort === 'active' ? r.state === 'active'
        : cohort === 'expired' ? r.state === 'expired'
        : r.state === 'setup' || r.state === 'approval');

  const run = async () => {
    setErr('');
    const ids = targets.map((r) => r.id);
    if (ids.length === 0) { setErr('Некого затрагивать — измените отбор'); return; }

    setBusy(true);
    let p: any;
    try {
      // Шаг первый: спрашиваем сервер, кого затронет. Считает он, а не
      // кабинет — иначе правило о деньгах живёт в двух местах.
      p = await api('/bulk/preview', { method: 'POST',
        body: { action, days: Number(days) || 7, accountIds: ids } });
    } catch (e: any) { setErr(humanError(e)); setBusy(false); return; }
    setBusy(false);

    // Поимённый список: первые несколько с тем, как изменится.
    const named = (p.clients ?? []).slice(0, 8).map((c: any) =>
      c.after
        ? `${c.name}: ${fmt(c.paidUntil)} → ${fmt(c.after)}`
        : c.name);

    const effects: [string, string][] = [
      ['Затронет', `${p.willAffect} магазинов`],
      ...(p.skippedDemo ? [['Учебных пропущено', String(p.skippedDemo)] as [string, string]] : []),
      ...(action === 'grace' ? [['Продление', `${days} дн.`] as [string, string]] : []),
    ];

    const answer = await ask({
      title: action === 'grace' ? 'Продлить срок' : action === 'disable' ? 'Отключить' : 'Включить',
      sub: action === 'grace'
        ? 'Деньги не поступят — это уступка, а не оплата.'
        : 'Продажи закроются, кабинет останется открытым.',
      effects,
      list: named.length ? {
        title: picked ? `Отмечено ${selected.length} · первые в списке` : 'Как изменится',
        rows: named,
        more: p.willAffect > named.length ? `…и ещё ${p.willAffect - named.length}` : undefined,
      } : undefined,
      danger: action === 'disable',
      confirmLabel: 'Применить',
    });

    if (!answer) return;

    setBusy(true);
    try {
      const r = await api('/bulk/apply', { method: 'POST',
        body: { action, days: Number(days) || 7, accountIds: ids } });
      toast({ text: `Применено к ${r.affected} магазинам`
        + (r.skippedDemo ? ` · учебных пропущено: ${r.skippedDemo}` : '') });
      onClear(); onDone();
    } catch (e: any) {
      toast({ text: humanError(e), kind: 'err' });
    } finally { setBusy(false); }
  };

  return (
    <div className="bulk">
      <div className="bulk-top">
        <b>Массовое действие</b>
        {picked && (
          <span className="hint">
            отмечено {selected.length}
            <button className="btn small ghost" onClick={onClear}>снять</button>
          </span>
        )}
      </div>

      <div className="bulk-strip">
        <select value={action} onChange={(e) => setAction(e.target.value as any)}>
          <option value="grace">Продлить срок</option>
          <option value="disable">Отключить</option>
          <option value="enable">Включить</option>
        </select>

        {action === 'grace' && (
          <input value={days} inputMode="numeric" style={{ width: 70 }}
            onChange={(e) => setDays(e.target.value)} />
        )}

        {!picked && (
          <select value={cohort} onChange={(e) => setCohort(e.target.value)}>
            {COHORTS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        )}

        <button className="btn" disabled={busy} onClick={run}>
          {busy ? 'Считаем…' : `Показать, кого затронет (${targets.length})`}
        </button>
      </div>

      {err && <div className="err">{err}</div>}
      <p className="hint">
        Сначала сервер покажет поимённо, кого затронет и что станет.
        Применение — вторым шагом.
      </p>
    </div>
  );
}

const fmt = (v: string | null) =>
  v ? new Date(v).toLocaleDateString('ru-RU') : '—';
