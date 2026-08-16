/*
 * Карточка заведения — страница, а не тупик.
 *
 * Раньше это было модальное окно, которое показывало всё и не давало
 * сделать ничего: единственная кнопка — «Закрыть». Изучил клиента —
 * закрывай и ищи его в таблице заново.
 *
 * Теперь у карточки есть адрес (#/client/<id>), деньги сверху,
 * действия рядом с данными, а состав счёта правится прямо здесь.
 * Супер-админ видит, чей это клиент и под какой процент; партнёр —
 * только свою долю.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { call, money } from './main';
import { statusView } from './ui/status';
import { PlanLines } from './ui/PlanLines';
import { Failed, SkeletonCards, SkeletonMetrics } from './ui/States';
import { useToast } from './ui/Toast';
import { humanError } from './ui/errors';
import { InlineText } from './ui/InlineText';
import { RowMenu } from './ui/RowMenu';
import { CopyValue, NewPassword, useActivationCodes, useResetPassword } from './ui/access';
import { useDeleteTenant } from './ui/deleteTenant';
import { ADD_KINDS, useAddDevice } from './ui/addDevice';
import { usePriceBook } from './ui/prices';
import type { DeviceKind } from './ui/addDevice';

type Card = {
  id: string; name: string; city: string | null;
  ownerName: string | null; ownerPhone: string | null;
  status: string; tier: string; planName: string;
  paidUntil: string | null; createdAt: string;
  stage: string; note: string | null;
  partner: { name: string; commissionPct: number } | null;
  monthly: number;
  /** Из чего складывается месяц: тариф, устройства, модули, скидки. */
  breakdown?: { base: number; devices: number; modules: number; discounts: number };
  lines: { id: string; kind: string; title: string; qty: number;
    unitPrice: number; sum: number; since: string; note: string | null }[];
  limits: { pos: number; kds: number; waiter: number };
  terminals: { name: string; kind: string; activated: boolean; lastSeen: string | null;
    /** Когда завели — по нему считаем, сколько устройство ждёт кода. */
    createdAt?: string | null;
    /** Доплачивается сверх тарифа или входит в него. */
    paid?: boolean;
    /** Сколько стоит в месяц; ноль — входит в тариф. */
    monthly?: number }[];
  payments: { id: string; amount: number; months: number; method: string;
    status: string; at: string; approvedAt: string | null;
    /** Оплаченный отрезок: считается по цепочке подтверждений. */
    from: string | null; to: string | null;
    partnerShare: number; comment: string | null }[];
  paidTotal: number;
  requests: { kind: string; status: string; at: string; comment: string | null }[];
  audit: { message: string; at: string }[];
};

const d = (v: string | null) => (v ? new Date(v).toLocaleDateString('ru-RU') : '—');
const dt = (v: string | null) =>
  (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

const STAGE: Record<string, string> = {
  NEW: 'Новый', CONTACTED: 'Связались', TRIAL: 'Пробный',
  PAID: 'Оплатил', LOST: 'Отказ',
};

type Tab = 'plan' | 'payments' | 'devices' | 'requests' | 'audit';

export function TenantCard({ token, tenantId, isSuper, onBack, onPay, onRequest, onSuspend, onAssign }: {
  token: string;
  tenantId: string;
  isSuper: boolean;
  onBack: () => void;
  onPay: (t: { id: string; name: string; monthly: number; planName: string }) => void;
  onRequest: (t: { id: string; name: string; monthly: number; planName: string }) => void;
  onSuspend?: (t: { id: string; name: string; status: string; monthly: number; paidUntil: string | null }) => void;
  onAssign?: (t: { id: string; name: string; partnerName: string | null }) => void;
}) {
  const [tab, setTab] = useState<Tab>('plan');
  const qc = useQueryClient();
  const toast = useToast();
  const { reset, issued, clear } = useResetPassword(token);
  const remove = useDeleteTenant(token, onBack);

  /* Опечатки правятся на месте: это не деньги, лист тут лишний. */
  const patch = useMutation({
    mutationFn: (v: { name?: string; ownerName?: string; ownerPhone?: string; city?: string }) =>
      call('/tenant/update', { method: 'POST', token, body: { tenantId, ...v } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenant-card', tenantId] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
      toast({ text: 'Сохранено' });
    },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['tenant-card', tenantId],
    queryFn: () => call<Card>(`/tenant-card?tenantId=${tenantId}`, { token }),
  });

  if (isPending) {
    return (
      <section className="client">
        <button className="btn small ghost back" onClick={onBack}>← Все клиенты</button>
        <SkeletonMetrics count={4} />
        <SkeletonCards count={1} height={320} />
      </section>
    );
  }

  if (isError || !data) {
    return (
      <section className="client">
        <button className="btn small ghost back" onClick={onBack}>← Все клиенты</button>
        <Failed text={humanError(error)} onRetry={() => void refetch()} />
      </section>
    );
  }

  const s = statusView(data.status);
  const days = data.paidUntil
    ? Math.ceil((new Date(data.paidUntil).getTime() - Date.now()) / 86400_000)
    : null;
  const brief = { id: data.id, name: data.name, monthly: data.monthly, planName: data.planName };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'plan', label: 'Счёт' },
    { key: 'payments', label: 'Платежи', count: data.payments.length },
    { key: 'devices', label: 'Устройства', count: data.terminals.length },
    { key: 'requests', label: 'Заявки', count: data.requests.length },
    { key: 'audit', label: 'История' },
  ];

  return (
    <section className="client">
      <button className="btn small ghost back" onClick={onBack}>← Все клиенты</button>

      <div className="client-head">
        <div>
          <h1>
            <InlineText
              value={data.name}
              label="Название заведения"
              disabled={!isSuper}
              onSave={(name) => patch.mutate({ name })}
            />
          </h1>
          <p className="hint client-fields">
            <InlineText
              value={data.city}
              label="Город"
              placeholder="город не указан"
              disabled={!isSuper}
              onSave={(city) => patch.mutate({ city })}
            />
            <span>·</span>
            <InlineText
              value={data.ownerName}
              label="Имя владельца"
              placeholder="владелец не указан"
              disabled={!isSuper}
              onSave={(ownerName) => patch.mutate({ ownerName })}
            />
            <span>·</span>
            <InlineText
              value={data.ownerPhone}
              label="Телефон владельца"
              placeholder="телефон не указан"
              mono
              disabled={!isSuper}
              onSave={(ownerPhone) => patch.mutate({ ownerPhone })}
            />
            {data.ownerPhone && <a className="call-link" href={`tel:${data.ownerPhone}`}>позвонить</a>}
            <span>· с {d(data.createdAt)}</span>
          </p>
          <div className="client-badges">
            <span className={`badge ${s.cls}`}>{s.text}</span>
            <span className="badge">{data.tier === 'PRO' ? 'уровень «Про»' : 'уровень «Базовый»'}</span>
            <span className="badge">{STAGE[data.stage] ?? data.stage}</span>
          </div>
        </div>
        <div className="client-actions">
          <button className="btn primary" onClick={() => onPay(brief)}>Оплата</button>
          {!isSuper && <button className="btn" onClick={() => onRequest(brief)}>Запросить у платформы</button>}
          {isSuper && (onSuspend || onAssign) && (
            <RowMenu
              actions={[
                {
                  label: 'Сбросить пароль владельца…',
                  onClick: () => void reset({ id: data.id, name: data.name, ownerName: data.ownerName }),
                },
                ...(onAssign
                  ? [{
                    label: data.partner ? 'Передать другому партнёру…' : 'Назначить партнёра…',
                    onClick: () => onAssign({
                      id: data.id, name: data.name, partnerName: data.partner?.name ?? null,
                    }),
                  }]
                  : []),
                ...(onSuspend
                  ? [{
                    label: data.status === 'SUSPENDED' ? 'Включить заведение' : 'Отключить заведение',
                    danger: data.status !== 'SUSPENDED',
                    onClick: () => onSuspend({
                      id: data.id, name: data.name, status: data.status,
                      monthly: data.monthly, paidUntil: data.paidUntil,
                    }),
                  }]
                  : []),
                ...(isSuper
                  ? [{
                    label: 'Удалить заведение…',
                    danger: true,
                    onClick: () => void remove({
                      id: data.id, name: data.name,
                      monthly: data.monthly, paidUntil: data.paidUntil,
                    }),
                  }]
                  : []),
              ]}
            />
          )}
          {!isSuper && (
            <RowMenu
              actions={[{
                label: 'Сбросить пароль владельца…',
                onClick: () => void reset({ id: data.id, name: data.name, ownerName: data.ownerName }),
              }]}
            />
          )}
        </div>
      </div>

      <div className="cards">
        <div className="card money">
          <span>В месяц</span><b>{money(data.monthly)}</b>
          <div className="sub">{data.planName}</div>
        </div>
        <div className={`card ${days !== null && days < 0 ? 'bad' : ''}`}>
          <span>Оплачено до</span><b>{d(data.paidUntil)}</b>
          {days !== null && (
            <div className="sub">{days >= 0 ? `осталось ${days} дн.` : `просрочка ${-days} дн.`}</div>
          )}
        </div>
        <div className="card ok">
          <span>Принесло всего</span><b>{money(data.paidTotal)}</b>
          {data.breakdown && <div className="sub">разбивка месяца ниже</div>}
        </div>
        {data.partner && (
          <div className="card">
            <span>{isSuper ? 'Ведёт партнёр' : 'Ваша доля'}</span>
            <b>{isSuper ? data.partner.name : `${data.partner.commissionPct}%`}</b>
            <div className="sub">
              {isSuper
                ? `доля ${data.partner.commissionPct}% · вам ${100 - data.partner.commissionPct}%`
                : 'с каждой подтверждённой оплаты'}
            </div>
          </div>
        )}
        {!data.partner && isSuper && (
          <div className="card">
            <span>Кто ведёт</span>
            <b className="nobody">без партнёра</b>
            <div className="sub">клиент пришёл сам — ждёт распределения</div>
          </div>
        )}
      </div>

      {data.breakdown && (
        <div className="breakdown">
          <span className="breakdown-label">Из чего складывается месяц</span>
          <div className="breakdown-parts">
            <span><i>за тариф</i><b>{money(data.breakdown.base)}</b></span>
            {data.breakdown.devices > 0 && (
              <span><i>за устройства</i><b>{money(data.breakdown.devices)}</b></span>
            )}
            {data.breakdown.modules > 0 && (
              <span><i>за модули</i><b>{money(data.breakdown.modules)}</b></span>
            )}
            {data.breakdown.discounts > 0 && (
              <span className="minus"><i>скидка</i><b>−{money(data.breakdown.discounts)}</b></span>
            )}
            <span className="breakdown-total"><i>итого</i><b>{money(data.monthly)}</b></span>
          </div>
        </div>
      )}

      {data.note && <p className="client-note">Заметка: {data.note}</p>}

      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'on' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.count ? <i>{t.count}</i> : null}
          </button>
        ))}
      </div>

      {tab === 'plan' && (
        <PlanLines token={token} tenantId={data.id} tenantTier={data.tier} isSuper={isSuper}
          onDevices={() => setTab('devices')} />
      )}

      {tab === 'payments' && (
        data.payments.length === 0
          ? <p className="note">Платежей ещё не было</p>
          : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Оплаченный период</th><th className="num">Сумма</th>
                  <th>Статус</th><th className="num">Партнёру</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p) => (
                  <tr key={p.id}>
                    <td data-label="Оплаченный период">
                      {p.from && p.to
                        ? <b className="period">{d(p.from)} → {d(p.to)}</b>
                        : <b className="period pending">период ещё не занят</b>}
                      <div className="sub">
                        {p.months} мес. · {p.method}
                        {p.comment ? ` · ${p.comment}` : ''}
                      </div>
                    </td>
                    <td data-label="Сумма" className="num"><b>{money(p.amount)}</b></td>
                    <td data-label="Статус">
                      {p.status === 'APPROVED' && <span className="badge st-active"><i className="dot" />подтверждён {d(p.approvedAt)}</span>}
                      {p.status === 'PENDING' && <span className="badge st-pending"><i className="dot" />ждёт подтверждения</span>}
                      {p.status === 'REJECTED' && <span className="badge st-expired"><i className="dot" />отклонён</span>}
                      <div className="sub">отмечен {dt(p.at)}</div>
                    </td>
                    <td data-label="Партнёру" className="num">{p.partnerShare > 0 ? money(p.partnerShare) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}

      {tab === 'devices' && (
        <DevicesTab token={token} tenantId={data.id} data={data} isSuper={isSuper} />
      )}

      {tab === 'requests' && (
        data.requests.length === 0
          ? <p className="note">Заявок по этому клиенту не было</p>
          : (
            <table className="grid">
              <thead><tr><th>Когда</th><th>Что просили</th><th>Решение</th></tr></thead>
              <tbody>
                {data.requests.map((r, i) => (
                  <tr key={i}>
                    <td data-label="Когда">{dt(r.at)}</td>
                    <td data-label="Что просили">{r.kind}</td>
                    <td data-label="Решение">
                      {r.status === 'APPROVED' && <span className="badge st-active">одобрено</span>}
                      {r.status === 'REJECTED' && <span className="badge st-expired">отказано</span>}
                      {r.status === 'PENDING' && <span className="badge st-pending">ждёт решения</span>}
                      {r.comment && <div className="sub">{r.comment}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}

      {tab === 'audit' && (
        data.audit.length === 0
          ? <p className="note">Записей пока нет</p>
          : (
            <ul className="audit">
              {data.audit.map((a, i) => (
                <li key={i}><span className="sub">{dt(a.at)}</span> — {a.message}</li>
              ))}
            </ul>
          )
      )}
      {issued && <NewPassword email={issued.email} password={issued.password} onClose={clear} />}
    </section>
  );
}

/*
 * Устройства и коды активации.
 *
 * Код нужен ровно тому, кто ставит планшет: он диктует его по
 * телефону или пересылает. У активированных устройств кода нет —
 * там показываем последнюю связь, а не пустое место.
 */
function DevicesTab({ token, tenantId, data, isSuper }: {
  token: string;
  tenantId: string;
  data: Card;
  isSuper: boolean;
}) {
  const codes = useActivationCodes(token, tenantId);
  const prices = usePriceBook(token);
  const [freshCode, setFreshCode] = useState<{ name: string; code: string } | null>(null);
  const { addDevice, busy } = useAddDevice(token, setFreshCode);

  /* Имя по умолчанию — следующий номер того же вида: «Касса 3».
     Сервер умеет считать сам, но своё имя показываем в листе заранее. */
  const suggestName = (kind: DeviceKind): string => {
    const title = ADD_KINDS.find((k) => k.kind === kind)?.title ?? 'Устройство';
    const n = data.terminals.filter((x) => x.kind === kind).length + 1;
    return `${title} ${n}`;
  };

  const priceFor = (kind: DeviceKind): number | null => {
    const key = ADD_KINDS.find((k) => k.kind === kind)?.price;
    return key ? prices.data?.[key] ?? null : null;
  };
  const codeOf = (name: string): string | null =>
    (codes.data?.rows ?? []).find((r) => r.name === name && !r.activated)?.code ?? null;
  const waiting = (codes.data?.rows ?? []).filter((r) => !r.activated && r.code);

  /* Связь устройства с деньгами: первое каждого вида входит в основу,
     остальные стоят строкой в счёте. Раньше это были два списка рядом,
     и понять, что чему соответствует, было нельзя. */
  const lineFor = (kind: string) =>
    data.lines.find((l) => l.kind === kind && l.qty > 0) ?? null;

  /* paid и monthly приходят от сервера; пока их нет — падаем на прежнее
     правило «первое каждого вида в тарифе», чтобы старая сборка не пустела. */
  const isPaid = (x: Card['terminals'][number]): boolean => {
    if (typeof x.paid === 'boolean') return x.paid;
    const same = data.terminals.filter((y) => y.kind === x.kind);
    return same.findIndex((y) => y.name === x.name) > 0;
  };

  /* Сколько дней устройство ждёт кода — если сервер сказал, когда его завели. */
  const waitingDays = (x: Card['terminals'][number]): number | null => {
    if (x.activated || !x.createdAt) return null;
    return Math.floor((Date.now() - new Date(x.createdAt).getTime()) / 86_400_000);
  };

  const stale = data.terminals.filter((x) => (waitingDays(x) ?? 0) >= 7);
  const staleePaid = stale.filter(isPaid);

  return (
    <>
      {isSuper && (
        <div className="dev-add">
          <span>Подключить ещё устройство — одним действием: лимит, строка счёта и код активации</span>
          <div className="dev-add-buttons">
            {ADD_KINDS.map((k) => (
              <button
                key={k.kind}
                className="btn small"
                disabled={busy}
                onClick={() => void addDevice({
                  id: data.id,
                  name: data.name,
                  kind: k.kind,
                  listPrice: priceFor(k.kind),
                  suggest: suggestName(k.kind),
                })}
              >
                + {k.title.toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Соотношение «в тарифе / платные»: два числа рядом ничего не
          объясняли — человек не понимал, за что именно платит. */}
      <div className="dev-mix">
        {([
          ['Касса', 'POS', data.limits.pos],
          ['Экран кухни', 'KDS', data.limits.kds],
          ['Телефон официанта', 'WAITER', data.limits.waiter],
        ] as [string, string, number][])
          .filter(([, , limit]) => limit > 0)
          .map(([title, kind, limit]) => {
            const mine = data.terminals.filter((x) => x.kind === kind);
            const have = mine.length;
            const line = lineFor(kind);
            const paid = mine.filter(isPaid).length;
            return (
              <div className="dev-mix-cell" key={kind}>
                <span>{title}</span>
                <b>{have} из {limit}</b>
                <i>
                  {have === 0 ? 'ни одного не подключено'
                    : paid === 0 ? 'входит в тариф'
                      : `одна в тарифе, ${paid} платн${paid === 1 ? 'ая' : 'ых'}`}
                </i>
                {line && <span className="dev-mix-sum">{money(line.sum)}/мес</span>}
              </div>
            );
          })}
      </div>
      <p className="hint">
        По одному устройству каждого вида входит в тариф, остальные считаются отдельной
        строкой счёта.
        {waiting.length > 0 && ' Коды ниже вводят на самом устройстве при первом запуске.'}
      </p>

      {staleePaid.length > 0 && (
        <p className="dev-stale">
          {staleePaid.length === 1
            ? `«${staleePaid[0]?.name}»: платит, но не подключил ${waitingDays(staleePaid[0] as Card['terminals'][number])} дней`
            : `${staleePaid.length} платных устройства не подключены больше недели`} —
          деньги идут, работы нет. Стоит позвонить и довести до кассы.
        </p>
      )}
      {stale.length > staleePaid.length && (
        <p className="hint dev-stale-soft">
          Есть устройства из тарифа, которые ждут кода больше недели — на счёт это
          не влияет, но человек чего-то не докрутил.
        </p>
      )}

      {data.terminals.length === 0
        ? <p className="note">Устройства ещё не подключены</p>
        : (
          <table className="grid">
            <thead>
              <tr>
                <th>Устройство</th><th>Состояние</th><th>Код активации</th>
                <th>В счёте</th><th className="num">Последняя связь</th>
              </tr>
            </thead>
            <tbody>
              {data.terminals.map((x, i) => {
                const code = codeOf(x.name);
                const days = waitingDays(x);
                const paid = isPaid(x);
                const line = paid ? lineFor(x.kind) : null;
                const per = typeof x.monthly === 'number' ? x.monthly : line?.unitPrice ?? null;
                return (
                  <tr key={i}>
                    <td data-label="Устройство">{x.name}<div className="sub">{x.kind}</div></td>
                    <td data-label="Состояние">
                      {x.activated
                        ? <span className="badge st-active"><i className="dot" />активна</span>
                        : (
                          <span className={`badge ${(days ?? 0) >= 7 ? 'st-expired' : 'st-setup'}`}>
                            {(days ?? 0) >= 7 ? `ждёт кода ${days} дн.` : 'ждёт кода'}
                          </span>
                        )}
                    </td>
                    <td data-label="Код активации">
                      {x.activated
                        ? <span className="sub">не нужен — устройство активировано</span>
                        : code
                          ? <CopyValue label="Код" value={code} />
                          : <span className="sub">{codes.isPending ? 'загружаем…' : 'код не выдан'}</span>}
                    </td>
                    <td data-label="В счёте">
                      {paid && per !== null && per > 0
                        ? (
                          <>
                            <b className="dev-extra">доплата {money(per)}/мес</b>
                            {!x.activated && (days ?? 0) >= 7 && (
                              <div className="sub bad">платит, но не подключил {days} дней</div>
                            )}
                            {line && (
                              <div className="sub">строка «{line.title}» · {line.qty} шт. на {money(line.sum)}</div>
                            )}
                          </>
                        )
                        : <span className="sub dev-included">входит в тариф</span>}
                    </td>
                    <td data-label="Последняя связь" className="num">{x.lastSeen ? dt(x.lastSeen) : 'не выходила'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

      {freshCode && (
        <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && setFreshCode(null)}>
          <div className="modal-card wide" role="dialog" aria-modal="true" aria-label="Код активации">
            <div className="sheet-head">
              <h2>Код для «{freshCode.name}»</h2>
              <button className="btn small ghost sheet-x" aria-label="Закрыть"
                onClick={() => setFreshCode(null)}>×</button>
            </div>
            <p className="hint">
              Передайте код клиенту — его вводят на самом устройстве при первом запуске.
              Пока код не введён, устройство не работает, а плата уже идёт.
            </p>
            <CopyValue label="Код активации" value={freshCode.code} big />
            <div className="modal-actions">
              <button className="btn primary" onClick={() => setFreshCode(null)}>Готово</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
