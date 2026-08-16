/*
 * Состав счёта заведения — с правкой на месте.
 *
 * Тариф перестал быть одним числом: у одного клиента обычная основа,
 * у другого своя цена, у третьего скидка и три доплаты за кассы. Всё
 * это строки, и каждую назначает владелец платформы.
 *
 * Цена и количество правятся прямо в ячейке: клик — поле, Enter —
 * сохранить, Esc — вернуть как было. Раньше это были три системных
 * окошка браузера, где «восемь тысяч» молча превращалось в ноль.
 * Удаление строки и смена уровня — через лист с последствием: обе
 * операции меняют ежемесячный счёт.
 */
import { useState } from 'react';
import { humanError } from './errors';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, money } from '../main';
import { useAsk } from './ConfirmSheet';
import { Failed, SkeletonTable } from './States';
import { useToast } from './Toast';
import { usePriceBook } from './prices';

export type PlanLineRow = {
  id: string; kind: string; title: string; qty: number;
  unitPrice: number; sum: number; startsAt: string;
  endsAt: string | null; note: string | null; active: boolean;
};

type PlanData = {
  rows: PlanLineRow[]; monthly: number; fallback: number | null;
  nextPayment: string | null; prorate: number; prorateDays: number;
  partnerBp: number; partnerEarn: number;
};

/** Виды строк — словами, какими их читает человек. */
const KIND_TITLE: Record<string, string> = {
  BASE: 'Основа',
  POS: 'Касса',
  KDS: 'Экран кухни',
  WAITER: 'Телефон официанта',
  COURIER: 'Курьер',
  MODULE: 'Модуль',
  DISCOUNT: 'Скидка',
};

type Edit = { id: string; field: 'qty' | 'unitPrice'; value: string };

/*
 * Что можно завести руками.
 *
 * Видов устройств здесь нет намеренно: строка «Касса» в счёте — это
 * только плата, без самой кассы, без поднятого лимита и без кода
 * активации. Человек выбирал её, думая, что подключает устройство, —
 * и клиент платил за то, чего у него нет. Устройства подключаются во
 * вкладке «Устройства», одним действием.
 */
const ADDABLE: { kind: string; title: string; hint: string }[] = [
  { kind: 'BASE', title: 'Основа', hint: 'месячная плата за заведение' },
  { kind: 'MODULE', title: 'Модуль', hint: 'отдельная возможность сверх тарифа' },
  { kind: 'DISCOUNT', title: 'Скидка', hint: 'цена со знаком минус, например −5000' },
];

/*
 * Счёт читается сверху вниз: сначала за что платят всегда, потом за
 * что сверх, потом что вычли. Раньше «Тариф „Базовый“» и «Касса»
 * стояли одной строкой и выглядели одинаково — человек не понимал,
 * где база, а где доплата.
 */
const DEVICE_KINDS = ['POS', 'KDS', 'WAITER', 'COURIER'];

function group(rows: PlanLineRow[]) {
  const discount = rows.filter((r) => r.kind === 'DISCOUNT' || r.sum < 0);
  const base = rows.filter((r) => r.kind === 'BASE' && !discount.includes(r));
  const extra = rows.filter((r) => !discount.includes(r)
    && (DEVICE_KINDS.includes(r.kind) || r.kind === 'MODULE'));
  const seen = new Set([...discount, ...base, ...extra]);
  return { base, extra, discount, other: rows.filter((r) => !seen.has(r)) };
}

const sumOf = (rows: PlanLineRow[]) => rows.reduce((a, r) => a + r.sum, 0);

export function PlanLines({ token, tenantId, tenantTier, isSuper, onDevices }: {
  token: string;
  tenantId: string;
  /** Нужен, чтобы показать текущий уровень; смену делает этот же экран. */
  tenantTier?: string;
  isSuper: boolean;
  /** Переход во вкладку «Устройства» — там подключение одним действием. */
  onDevices?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useAsk();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [kind, setKind] = useState('BASE');
  const [title, setTitle] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['plan-lines', tenantId],
    queryFn: () => call<PlanData>(`/plan-lines?tenantId=${tenantId}`, { token }),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['plan-lines', tenantId] });
    void qc.invalidateQueries({ queryKey: ['tenant-card', tenantId] });
    void qc.invalidateQueries({ queryKey: ['tenants'] });
  };

  const add = useMutation({
    mutationFn: () => call('/plan-lines', {
      method: 'POST', token,
      body: {
        tenantId, kind, qty: Number(qty) || 1,
        unitPrice: Math.round(Number(price) * 100),
        title: title.trim() || KIND_TITLE[kind] || 'Строка',
      },
    }),
    onSuccess: () => { setTitle(''); setPrice(''); setQty('1'); refresh(); toast({ text: 'Строка добавлена в счёт' }); },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const editLine = useMutation({
    mutationFn: (v: { id: string; qty?: number; unitPrice?: number; remove?: boolean }) =>
      call('/plan-lines/edit', { method: 'POST', token, body: v }),
    onSuccess: refresh,
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const rows = data?.rows ?? [];

  const commit = (r: PlanLineRow) => {
    if (!edit || edit.id !== r.id) return;
    const raw = edit.value.trim();
    setEdit(null);
    if (raw === '') return;
    const n = Number(raw);
    if (Number.isNaN(n)) { toast({ text: 'Нужно число', kind: 'err' }); return; }
    if (edit.field === 'qty') {
      if (n <= 0) { toast({ text: 'Количество должно быть больше нуля', kind: 'err' }); return; }
      if (n === r.qty) return;
      editLine.mutate({ id: r.id, qty: n },
        { onSuccess: () => toast({ text: `«${r.title}»: количество ${n}` }) });
      return;
    }
    const tiyn = Math.round(n * 100);
    if (tiyn === r.unitPrice) return;
    editLine.mutate({ id: r.id, unitPrice: tiyn },
      { onSuccess: () => toast({ text: `«${r.title}»: ${money(tiyn)} за штуку` }) });
  };

  const cell = (r: PlanLineRow, field: 'qty' | 'unitPrice') => {
    const editing = edit && edit.id === r.id && edit.field === field;
    const shown = field === 'qty' ? String(r.qty) : money(r.unitPrice);
    if (!isSuper) return <span>{shown}</span>;
    if (editing) {
      return (
        <input
          className="cell-input"
          autoFocus
          inputMode="numeric"
          value={edit.value}
          aria-label={field === 'qty' ? 'Количество' : 'Цена за штуку в месяц, ₸'}
          onChange={(e) => setEdit({ ...edit, value: e.target.value.replace(/[^\d-]/g, '') })}
          onBlur={() => commit(r)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(r);
            if (e.key === 'Escape') setEdit(null);
          }}
        />
      );
    }
    return (
      <button
        className="cell-edit"
        title="Изменить"
        onClick={() => setEdit({
          id: r.id, field,
          value: field === 'qty' ? String(r.qty) : String(Math.round(r.unitPrice / 100)),
        })}
      >
        {shown}
      </button>
    );
  };

  const removeLine = async (r: PlanLineRow) => {
    const answer = await ask({
      title: `Убрать «${r.title}» из счёта`,
      sub: 'Строка перестанет считаться в ежемесячном счёте клиента.',
      effects: [
        ['Строка', `${r.title} · ${r.qty} × ${money(r.unitPrice)}`],
        ['Счёт сейчас', `${money(data?.monthly ?? 0)}/мес`],
        ['Станет', `${money((data?.monthly ?? 0) - r.sum)}/мес`],
      ],
      danger: true,
      confirmLabel: 'Убрать строку',
    });
    if (!answer) return;
    editLine.mutate({ id: r.id, remove: true }, { onSuccess: () => toast({ text: 'Строка убрана из счёта' }) });
  };

  const setTier = async (tier: 'BASIC' | 'PRO') => {
    const answer = await ask({
      title: tier === 'PRO' ? 'Открыть уровень «Про»' : 'Вернуть уровень «Базовый»',
      sub: 'Уровень решает, открыты ли калькуляция себестоимости и конструктор отчётов. На цену он не влияет — цену задают строки счёта.',
      effects: [
        ['Сейчас', tenantTier === 'PRO' ? 'Про' : 'Базовый'],
        ['Станет', tier === 'PRO' ? 'Про' : 'Базовый'],
        ['Счёт в месяц', `${money(data?.monthly ?? 0)} · не меняется`],
      ],
      danger: tier === 'BASIC',
      confirmLabel: tier === 'PRO' ? 'Открыть «Про»' : 'Вернуть «Базовый»',
    });
    if (!answer) return;
    try {
      await call('/tier', { method: 'POST', token, body: { tenantId, tier } });
      refresh();
      toast({ text: tier === 'PRO' ? 'Уровень «Про» открыт' : 'Уровень «Базовый»' });
    } catch (e) {
      toast({ text: humanError(e), kind: 'err' });
    }
  };

  const parts = group(rows);

  /* Основа по цене прайса: подставляем «Про» или «Базовый» — уровень
     решает, какая цена по умолчанию, а не какая строка появится. */
  const prices = usePriceBook(token);
  const basePrice = tenantTier === 'PRO' ? prices.data?.basePro ?? null : prices.data?.base ?? null;

  const addBase = useMutation({
    mutationFn: (unitPrice: number) => call('/plan-lines', {
      method: 'POST', token,
      body: { tenantId, kind: 'BASE', qty: 1, unitPrice, title: `Тариф «${tenantTier === 'PRO' ? 'Про' : 'Базовый'}»` },
    }),
    onSuccess: () => { refresh(); toast({ text: 'Основа добавлена в счёт' }); },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const addBaseLine = async () => {
    if (basePrice === null) return;
    const answer = await ask({
      title: 'Добавить основу в счёт',
      sub: 'Плата за само заведение. По одному устройству каждого вида входит в неё.',
      effects: [
        ['Уровень', tenantTier === 'PRO' ? 'Про' : 'Базовый'],
        ['Цена по прайсу', `${money(basePrice)}/мес`],
        ['Счёт сейчас', `${money(data?.monthly ?? 0)}/мес`],
        ['Станет', `${money((data?.monthly ?? 0) + basePrice)}/мес`],
      ],
      value: {
        label: 'Цена в месяц, ₸',
        initial: String(Math.round(basePrice / 100)),
        numeric: true,
        hint: 'по прайсу подставлена цена платформы — можно изменить',
      },
      confirmLabel: 'Добавить основу',
    });
    if (!answer) return;
    const tiyn = Math.round(Number(answer.value.replace(',', '.')) * 100);
    if (!Number.isFinite(tiyn) || tiyn <= 0) {
      toast({ text: 'Цена должна быть больше нуля', kind: 'err' });
      return;
    }
    addBase.mutate(tiyn);
  };

  /* Одна разметка на все блоки: строки везде читаются одинаково,
     разное — только заголовок блока и его смысл. */
  const lineTable = (list: PlanLineRow[]) => (
    <table className="grid plan-lines">
      <thead>
        <tr>
          <th>Что</th>
          <th className="num">Кол-во</th>
          <th className="num">Цена/мес</th>
          <th className="num">Сумма</th>
          {isSuper && <th />}
        </tr>
      </thead>
      <tbody>
        {list.map((r) => (
          <tr key={r.id}>
            <td data-label="Что">
              <b>{r.title}</b>
              <div className="sub">
                {KIND_TITLE[r.kind] ?? r.kind}
                {r.note ? ` · ${r.note}` : ''}
                {!r.active ? ' · не действует' : ''}
              </div>
            </td>
            <td data-label="Кол-во" className="num">{cell(r, 'qty')}</td>
            <td data-label="Цена/мес" className="num">{cell(r, 'unitPrice')}</td>
            <td data-label="Сумма" className="num"><b>{money(r.sum)}</b></td>
            {isSuper && (
              <td className="actions">
                <button className="btn small ghost danger" onClick={() => void removeLine(r)}>Убрать</button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );

  if (isPending) return <SkeletonTable rows={4} cols={4} />;
  if (isError) return <Failed text={humanError(error)} onRetry={() => void refetch()} />;

  return (
    <div className="plan">
      <div className="cards">
        <div className="card money"><span>В месяц</span><b>{money(data?.monthly ?? 0)}</b></div>
        <div className="card">
          <span>Следующая оплата</span>
          <b>{data?.nextPayment ? new Date(data.nextPayment).toLocaleDateString('ru-RU') : '—'}</b>
        </div>
        {(data?.prorate ?? 0) > 0 && (
          <div className="card warn">
            <span>Доплата за новые устройства</span><b>{money(data!.prorate)}</b>
          </div>
        )}
        {(data?.partnerBp ?? 0) > 0 && (
          <div className="card ok">
            <span>{isSuper ? `Партнёру (${(data!.partnerBp / 100).toFixed(0)}%)` : `Ваша доля (${(data!.partnerBp / 100).toFixed(0)}%)`}</span>
            <b>{money(data!.partnerEarn)}</b>
            <div className="sub">в месяц</div>
          </div>
        )}
      </div>

      {(data?.prorate ?? 0) > 0 && (
        <p className="hint">
          Устройства подключены в середине оплаченного периода. Клиент платит один раз
          и в одну дату: доплата {money(data!.prorate)} за оставшиеся {data!.prorateDays} дн.,
          дальше всё считается общим месячным счётом.
        </p>
      )}

      {rows.length === 0 && (
        <p className="note">
          Строк ещё нет — счёт идёт по прежней цене тарифа
          {data?.fallback ? `: ${money(data.fallback)}/мес` : ''}.
          {isSuper ? ' Добавьте «Основу», чтобы перейти на новый расчёт.' : ''}
        </p>
      )}

      {isSuper && rows.length > 0 && parts.base.length === 0 && (
        <div className="bill-nobase">
          <div>
            <b>Тариф не выставлен</b>
            <p>
              В счёте нет строки «Основа» — клиент платит только за устройства и модули.
              Скорее всего, это недосмотр: за само заведение деньги не берутся.
            </p>
          </div>
          <button className="btn" disabled={addBase.isPending || !basePrice}
            onClick={() => void addBaseLine()}>
            {basePrice ? `Добавить основу — ${money(basePrice)}/мес` : 'Прайс не загружен'}
          </button>
        </div>
      )}

      {rows.length > 0 && (
        <div className="bill">
          {parts.base.length > 0 && (
            <section className="bill-part base">
              <header>
                <div>
                  <b>Основа</b>
                  <p className="hint">
                    Тариф заведения. По одному устройству каждого вида уже входит сюда:
                    касса, экран кухни, телефон официанта.
                  </p>
                </div>
                <span className="bill-sum">{money(sumOf(parts.base))}<i>/мес</i></span>
              </header>
              {lineTable(parts.base)}
            </section>
          )}

          {parts.extra.length > 0 && (
            <section className="bill-part extra">
              <header>
                <div>
                  <b>Сверх тарифа</b>
                  <p className="hint">
                    Вторые и последующие устройства и отдельные модули — каждое считается
                    со дня подключения.
                  </p>
                </div>
                <span className="bill-sum">{money(sumOf(parts.extra))}<i>/мес</i></span>
              </header>
              {lineTable(parts.extra)}
            </section>
          )}

          {parts.discount.length > 0 && (
            <section className="bill-part discount">
              <header>
                <div>
                  <b>Скидки</b>
                  <p className="hint">Вычитаются из итога каждый месяц, пока строка действует.</p>
                </div>
                <span className="bill-sum">{money(sumOf(parts.discount))}<i>/мес</i></span>
              </header>
              {lineTable(parts.discount)}
            </section>
          )}

          {parts.other.length > 0 && (
            <section className="bill-part">
              <header>
                <div><b>Прочее</b></div>
                <span className="bill-sum">{money(sumOf(parts.other))}<i>/мес</i></span>
              </header>
              {lineTable(parts.other)}
            </section>
          )}

          <div className="bill-total">
            <b>Итого в месяц</b>
            <span>{money(data?.monthly ?? 0)}</span>
          </div>
        </div>
      )}

      {isSuper && (
        <>
          <h3>Добавить строку</h3>
          <div className="row">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {ADDABLE.map((a) => (
                <option key={a.kind} value={a.kind}>{a.title} — {a.hint}</option>
              ))}
            </select>
            <input placeholder={KIND_TITLE[kind]} value={title} onChange={(e) => setTitle(e.target.value)} />
            <input inputMode="numeric" placeholder="кол-во" value={qty} style={{ width: 90 }}
              onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
            <input inputMode="numeric" placeholder="₸ в месяц" value={price} style={{ width: 140 }}
              onChange={(e) => setPrice(e.target.value.replace(/[^\d-]/g, ''))} />
            <button className="btn" disabled={!price || add.isPending} onClick={() => add.mutate()}>
              {add.isPending ? 'Добавляем…' : 'Добавить'}
            </button>
          </div>
          <p className="hint">
            {kind === 'DISCOUNT'
              ? 'Скидка — та же строка с ценой со знаком минус, например −5000.'
              : kind === 'BASE'
                ? 'Основа — то, за что клиент платит всегда. По одному устройству каждого вида уже входит в неё.'
                : 'Модуль — отдельная возможность сверх тарифа.'}
          </p>
          {onDevices && (
            <p className="hint plan-to-devices">
              Устройства подключаются во вкладке{' '}
              <button className="link-inline" onClick={onDevices}>«Устройства»</button>
              {' '}— там сразу поднимется лимит и появится код активации. Строка в счёте,
              заведённая здесь, только берёт деньги: самого устройства у клиента не будет.
            </p>
          )}

          <div className="tier">
            <div>
              <b>Уровень тарифа</b>
              <p className="hint">
                Решает, открыты ли калькуляция и конструктор отчётов. Пробный период
                открывает их всем — пусть клиент увидит максимум.
              </p>
            </div>
            <div className="tier-switch">
              <button
                className={`chip ${tenantTier !== 'PRO' ? 'on' : ''}`}
                onClick={() => tenantTier === 'PRO' && void setTier('BASIC')}
              >Базовый</button>
              <button
                className={`chip ${tenantTier === 'PRO' ? 'on' : ''}`}
                onClick={() => tenantTier !== 'PRO' && void setTier('PRO')}
              >Про</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
