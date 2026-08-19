'use client';
/**
 * СОСТАВ СЧЁТА КЛИЕНТА — перенесено из их ui/PlanLines.tsx.
 *
 * Их довод, взятый как есть: тариф перестал быть одним числом. У
 * одного клиента обычная основа, у другого своя цена, у третьего
 * скидка и три доплаты за кассы. Всё это строки, и каждую назначает
 * владелец платформы.
 *
 * Цена и количество правятся прямо в ячейке: клик — поле, Enter —
 * сохранить, Esc — вернуть как было. У них раньше это были три
 * системных окошка браузера, где «восемь тысяч» молча превращалось
 * в ноль.
 *
 * Удаление строки — через лист с последствием: операция меняет
 * ежемесячный счёт.
 *
 * СЧЁТ РАЗБИТ НА ТРИ ЧАСТИ — основа, доплаты, скидки. Одним списком
 * непонятно, откуда взялась сумма.
 *
 * ВИДОВ УСТРОЙСТВ ЗДЕСЬ НЕТ НАМЕРЕННО. Их урок: строка «Касса» в
 * счёте — это только плата, без самой кассы, без поднятого предела и
 * без кода привязки. Человек выбирал её, думая, что подключает
 * устройство, — и клиент платил за то, чего у него нет. Устройства
 * подключаются отдельным действием.
 */
import { useState } from 'react';
import { api, money } from '../lib';
import { InlineText } from './InlineText';
import { useAsk } from './Ask';
import { useToast } from './Toast';
import { humanError } from './errors';

/** Что можно завести руками. Устройств здесь нет — см. выше. */
const ADDABLE = [
  { kind: 'base',     title: 'Основа',  hint: 'месячная плата за магазин' },
  { kind: 'module',   title: 'Модуль',  hint: 'отдельная возможность сверх тарифа' },
  { kind: 'discount', title: 'Скидка',  hint: 'минусом: постоянная уступка клиенту' },
];

const TITLE: Record<string, string> = {
  base: 'Основа', pos: 'Касса', store: 'Точка',
  module: 'Модуль', discount: 'Скидка',
};

export function PlanLines({ accountId, lines, monthly, tier, onChanged }: {
  accountId: string;
  lines: any[];
  monthly: number;
  /** Текущий уровень: «Старт» или «Стандарт». */
  tier?: string;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');

  const ask = useAsk();
  const toast = useToast();

  const live = lines.filter((l) => l.active);

  // Три части: основа, доплаты, скидки. Одним списком непонятно,
  // откуда взялась сумма.
  const parts = {
    base:     live.filter((l) => l.kind === 'base'),
    extra:    live.filter((l) => ['pos', 'store', 'module'].includes(l.kind)),
    discount: live.filter((l) => l.kind === 'discount'),
  };
  const sumOf = (rows: any[]) => rows.reduce((a, r) => a + r.price * (r.qty ?? 1), 0);

  const save = async (id: string, body: any, ok: string) => {
    try {
      await api(`/lines/${id}`, { method: 'PATCH', body });
      toast({ text: ok });
      onChanged();
    } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
  };

  const remove = async (l: any) => {
    const r = await ask({
      title: `Убрать «${l.title}» из счёта`,
      sub: 'Строка закроется сегодняшним днём. Счета прошлых месяцев не изменятся — '
         + 'они должны сходиться.',
      effects: [
        ['Строка', `${l.title} · ${money(l.price)}${l.qty > 1 ? ` × ${l.qty}` : ''}`],
        ['Счёт сейчас', `${money(monthly)}/мес`],
        ['Станет', `${money(monthly - l.price * (l.qty ?? 1))}/мес`],
      ],
      danger: true,
      confirmLabel: 'Убрать из счёта',
    });
    if (!r) return;
    try {
      await api(`/lines/${l.id}`, { method: 'DELETE' });
      toast({ text: 'Строка убрана из счёта' });
      onChanged();
    } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
  };

  /**
   * Смена уровня. Меняет ТОЛЬКО основную строку счёта: доплаты за
   * устройства и персональные скидки — отдельные договорённости, их
   * трогать нельзя.
   */
  const setTier = async (next: 'base' | 'pro') => {
    const r = await ask({
      title: next === 'pro' ? 'Перевести на «Стандарт»' : 'Перевести на «Старт»',
      sub: 'Изменится только основная строка счёта. Доплаты за устройства и '
         + 'персональные скидки останутся как есть.',
      effects: [
        ['Сейчас', `${money(monthly)}/мес`],
        ['Уровень', next === 'pro' ? '«Стандарт»' : '«Старт»'],
        ['Когда применится', 'со следующего счёта — оплаченный период не меняется'],
      ],
      confirmLabel: 'Перевести',
    });
    if (!r) return;
    try {
      await api(`/clients/${accountId}/tier`, { method: 'POST', body: { tier: next } });
      toast({ text: `Уровень: ${next === 'pro' ? '«Стандарт»' : '«Старт»'}` });
      onChanged();
    } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
  };

  const add = async () => {
    const n = Number(price);
    if (!title.trim()) { toast({ text: 'Назовите строку', kind: 'err' }); return; }
    if (!Number.isFinite(n) || n <= 0) { toast({ text: 'Нужно число', kind: 'err' }); return; }
    try {
      await api(`/clients/${accountId}/lines`, { method: 'POST',
        body: { kind: adding, title: title.trim(), price: n } });
      toast({ text: 'Строка добавлена в счёт' });
      setAdding(null); setTitle(''); setPrice('');
      onChanged();
    } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
  };

  const Part = ({ rows, title: partTitle, cls }: {
    rows: any[]; title: string; cls: string;
  }) => rows.length === 0 ? null : (
    <section className={`bill-part ${cls}`}>
      <header>
        <b>{partTitle}</b>
        <span className="bill-sum">{money(sumOf(rows))}<i>/мес</i></span>
      </header>
      <table className="grid plan-lines">
        <tbody>
          {rows.map((l) => (
            <tr key={l.id}>
              <td>
                <InlineText value={l.title} label="Название строки"
                  onSave={(v) => save(l.id, { title: v }, 'Название изменено')} />
                <div className="sub">{TITLE[l.kind] ?? l.kind}</div>
              </td>
              <td className="num">
                {/* Цена правится в ячейке: у них раньше это было
                    системное окошко, где «восемь тысяч» молча
                    превращалось в ноль. */}
                <InlineText value={String(Math.abs(l.price))} label="Цена" numeric
                  onSave={(v) => {
                    const n = Number(v);
                    if (!Number.isFinite(n)) { toast({ text: 'Нужно число', kind: 'err' }); return; }
                    save(l.id, { price: n }, 'Цена изменена');
                  }} />
              </td>
              <td className="num">
                <InlineText value={String(l.qty ?? 1)} label="Количество" numeric
                  onSave={(v) => {
                    const n = Number(v);
                    if (!Number.isFinite(n) || n < 1) { toast({ text: 'Нужно число', kind: 'err' }); return; }
                    save(l.id, { qty: n }, 'Количество изменено');
                  }} />
              </td>
              <td className="num">{money(l.price * (l.qty ?? 1))}</td>
              <td className="actions">
                <button className="btn small ghost" onClick={() => remove(l)}>Убрать</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  return (
    <div className="bill">
      {live.length === 0 ? (
        <p className="note bill-nobase">
          Строк нет — клиент платит по тарифу. Добавьте основу, чтобы назначить свою цену.
        </p>
      ) : (
        <>
          <Part rows={parts.base} title="Основа" cls="base" />
          <Part rows={parts.extra} title="Доплаты" cls="extra" />
          <Part rows={parts.discount} title="Скидки" cls="discount" />

          <div className="bill-total">
            <b>Итого в месяц</b>
            <span className="bill-sum">{money(monthly)}<i>/мес</i></span>
          </div>
        </>
      )}

      {/* Переключатель уровня — их приём: две кнопки вместо списка.
          Уровней всего два, и список из двух пунктов требует лишнего
          нажатия, чтобы увидеть то, что и так помещается. */}
      {tier != null && (
        <div className="tier-switch">
          <button className={`chip ${tier !== 'pro' ? 'on' : ''}`}
            onClick={() => tier === 'pro' && setTier('base')}>Старт</button>
          <button className={`chip ${tier === 'pro' ? 'on' : ''}`}
            onClick={() => tier !== 'pro' && setTier('pro')}>Стандарт</button>
        </div>
      )}

      {adding ? (
        <div className="row">
          <input value={title} autoFocus placeholder="Название строки"
            onChange={(e) => setTitle(e.target.value)} />
          <input value={price} inputMode="numeric" placeholder="₸/мес"
            onChange={(e) => setPrice(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          <button className="btn primary" onClick={add}>Добавить</button>
          <button className="btn ghost" onClick={() => setAdding(null)}>Отмена</button>
        </div>
      ) : (
        <div className="row">
          {ADDABLE.map((a) => (
            <button key={a.kind} className="btn small"
              title={a.hint}
              onClick={() => { setAdding(a.kind); setTitle(a.title); setPrice(''); }}>
              + {a.title}
            </button>
          ))}
        </div>
      )}

      {/* Их урок словами: строка в счёте — это плата, а не устройство. */}
      <p className="hint plan-to-devices">
        Строка «Касса» здесь — только плата. Само устройство подключается
        отдельным действием: там же поднимется предел и появится код привязки.
      </p>
    </div>
  );
}
