/*
 * «Сегодня» — стартовый экран обеих ролей.
 *
 * Раньше день начинался со списка клиентов, хотя начинается он с
 * решений: кто просрочен, что пришло сегодня, что висит со вчера.
 * Одна лента в порядке срочности, решение принимается прямо в ней.
 *
 * Партнёр видит только своих и только то, что может сделать сам:
 * денежные решения принимает платформа, и рисовать ему кнопки,
 * которые ответят «нельзя», нечестно.
 */
import { useState } from 'react';
import { humanError } from './ui/errors';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PartnerRow, PaymentRow, TenantList, TenantRequestRow, TenantRow } from '@dastarhan/contracts';
import { call, describeRequest, money } from './main';
import { useAsk } from './ui/ConfirmSheet';
import { payApproveEffects, payLine } from './ui/money';
import { deviceOfPayload, usePriceBook } from './ui/prices';
import { Failed, PageHead, SkeletonCards } from './ui/States';
import { useToast } from './ui/Toast';

export type QueueGroup = 'overdue' | 'today' | 'waiting' | 'soon';

export type QueueItem = {
  id: string;
  group: QueueGroup;
  kind: 'payment' | 'request' | 'signup' | 'tenant';
  tenantId: string;
  tenantName: string;
  what: string;
  why: string | null;
  meta: string;
  amount: number | null;
  sortKey: number;
  payment?: PaymentRow;
  request?: TenantRequestRow;
  tenant?: TenantRow;
};

const GROUPS: { key: QueueGroup; title: string; hint: string }[] = [
  { key: 'overdue', title: 'Просрочены', hint: 'деньги уже потеряны, каждый день считается' },
  { key: 'today', title: 'Пришло сегодня', hint: 'свежее — пока помнят разговор' },
  { key: 'waiting', title: 'Ждёт решения', hint: 'висит со вчера и раньше' },
  { key: 'soon', title: 'Скоро платить', hint: 'семь дней и меньше' },
];

const sameDay = (iso: string, now = new Date()): boolean => {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
};

const when = (iso: string): string => new Date(iso).toLocaleString('ru-RU', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

/**
 * Очередь дня. Порядок жёсткий: просрочка, потом сегодняшнее,
 * потом всё, что ждёт со вчера, и в конце — кому платить на неделе.
 */
export function buildQueue({ tenants, payments, requests, isSuper }: {
  tenants: TenantRow[];
  payments: PaymentRow[];
  requests: TenantRequestRow[];
  isSuper: boolean;
}): QueueItem[] {
  const items: QueueItem[] = [];

  tenants.forEach((t) => {
    if (t.daysLeft !== null && t.daysLeft < 0) {
      items.push({
        id: `overdue-${t.id}`, group: 'overdue', kind: 'tenant',
        tenantId: t.id, tenantName: t.name,
        what: `Срок вышел ${-t.daysLeft} дн. назад · ${money(t.planPrice)}/мес`,
        why: null,
        meta: [t.city, t.ownerName, t.ownerPhone].filter(Boolean).join(' · '),
        amount: t.planPrice, sortKey: -t.daysLeft, tenant: t,
      });
    } else if (t.daysLeft !== null && t.daysLeft <= 7) {
      items.push({
        id: `soon-${t.id}`, group: 'soon', kind: 'tenant',
        tenantId: t.id, tenantName: t.name,
        what: `Платить через ${t.daysLeft} дн. · ${money(t.planPrice)}/мес`,
        why: null,
        meta: [t.city, t.ownerName, t.ownerPhone].filter(Boolean).join(' · '),
        amount: t.planPrice, sortKey: -t.daysLeft, tenant: t,
      });
    }

    if (isSuper && t.status === 'PENDING_APPROVAL') {
      items.push({
        id: `signup-${t.id}`,
        group: sameDay(t.createdAt) ? 'today' : 'waiting',
        kind: 'signup', tenantId: t.id, tenantName: t.name,
        what: 'Регистрация: владелец завёл заведение сам',
        why: null,
        meta: [t.city, t.ownerName, t.ownerPhone].filter(Boolean).join(' · '),
        amount: t.planPrice, sortKey: 0, tenant: t,
      });
    }
  });

  payments.filter((p) => p.status === 'PENDING').forEach((p) => {
    items.push({
      id: `pay-${p.id}`,
      group: sameDay(p.createdAt) ? 'today' : 'waiting',
      kind: 'payment', tenantId: p.tenantId, tenantName: p.tenantName,
      what: `Оплата ${money(p.amount)} · ${p.months} мес. · ${p.method}`,
      why: p.comment,
      meta: `отметил ${p.createdByName} · ${when(p.createdAt)}`,
      amount: p.amount, sortKey: p.amount, payment: p,
    });
  });

  requests.filter((r) => r.status === 'PENDING').forEach((r) => {
    items.push({
      id: `req-${r.id}`,
      group: sameDay(r.createdAt) ? 'today' : 'waiting',
      kind: 'request', tenantId: r.tenantId, tenantName: r.tenantName,
      what: describeRequest(r.kind, r.payload),
      why: r.reason,
      meta: `просит ${r.createdByName} · ${when(r.createdAt)}`,
      amount: null, sortKey: 0, request: r,
    });
  });

  const rank: Record<QueueGroup, number> = { overdue: 0, today: 1, waiting: 2, soon: 3 };
  return items.sort((a, b) => (rank[a.group] - rank[b.group]) || (b.sortKey - a.sortKey));
}

export function Today({ token, isSuper, onOpenClient }: {
  token: string;
  isSuper: boolean;
  onOpenClient: (tenantId: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useAsk();
  const [leaving, setLeaving] = useState<Record<string, boolean>>({});
  const [gone, setGone] = useState<string[]>([]);

  const tenants = useQuery({
    queryKey: ['tenants'],
    queryFn: () => call<TenantList>('/tenants', { token }),
    refetchInterval: 30_000,
  });
  const payments = useQuery({
    queryKey: ['payments', true],
    queryFn: () => call<PaymentRow[]>('/payments?pending=1', { token }),
    refetchInterval: 20_000,
  });
  const requests = useQuery({
    queryKey: ['requests', true],
    queryFn: () => call<TenantRequestRow[]>('/requests?pending=1', { token }),
    refetchInterval: 20_000,
  });
  const partners = useQuery({
    queryKey: ['partners'],
    queryFn: () => call<PartnerRow[]>('/partners', { token }),
    enabled: isSuper,
  });
  const prices = usePriceBook(token);

  const busy = tenants.isPending || payments.isPending || requests.isPending;
  const failed = tenants.isError || payments.isError || requests.isError;

  const rows = tenants.data?.rows ?? [];
  const queue = buildQueue({
    tenants: rows,
    payments: payments.data ?? [],
    requests: requests.data ?? [],
    isSuper,
  }).filter((i) => !gone.includes(i.id));

  const dismiss = (id: string, keys: string[]) => {
    setLeaving((s) => ({ ...s, [id]: true }));
    window.setTimeout(() => {
      setGone((g) => [...g, id]);
      setLeaving((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
      keys.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
    }, 280);
  };

  const payAct = useMutation({
    mutationFn: (v: { paymentId: string; reject?: string }) =>
      call('/payments/approve', { method: 'POST', token, body: v }),
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });
  const reqAct = useMutation({
    mutationFn: (v: { id: string; approve: boolean; comment?: string; unitPrice?: number }) =>
      call('/requests/decide', { method: 'POST', token, body: v }),
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const approvePayment = async (item: QueueItem) => {
    const p = item.payment;
    if (!p) return;
    const { effects, until } = payApproveEffects(p, rows, partners.data ?? []);
    const answer = await ask({
      title: 'Подтвердить оплату',
      sub: 'Действие продлевает доступ клиента и начисляет долю партнёру. Отменить одним движением нельзя.',
      effects,
      confirmLabel: 'Подтвердить и продлить',
    });
    if (!answer) return;
    payAct.mutate({ paymentId: p.id }, {
      onSuccess: () => {
        toast({ text: `${money(p.amount)} подтверждены · доступ до ${until}` });
        dismiss(item.id, ['payments', 'tenants']);
      },
    });
  };

  const rejectPayment = async (item: QueueItem) => {
    const p = item.payment;
    if (!p) return;
    const answer = await ask({
      title: 'Отклонить оплату',
      sub: 'Партнёр увидит причину и сможет отметить платёж заново.',
      effects: [['Заведение', p.tenantName], ['Сумма', money(p.amount)], ['Отметил', p.createdByName]],
      reason: { label: 'Причина отказа — её увидит партнёр', placeholder: 'Деньги не дошли, сумма чека не совпала…', required: true },
      danger: true,
      confirmLabel: 'Отклонить',
    });
    if (!answer) return;
    payAct.mutate({ paymentId: p.id, reject: answer.reason }, {
      onSuccess: () => {
        toast({ text: 'Оплата отклонена, партнёр уведомлён' });
        dismiss(item.id, ['payments', 'tenants']);
      },
    });
  };

  const approveRequest = async (item: QueueItem) => {
    const r = item.request;
    if (!r) return;
    const isDevice = r.kind === 'DEVICE_LIMIT';
    /* По умолчанию — цена партнёра, если он её предложил, иначе прайс. */
    const asked = typeof r.payload.unitPrice === 'number' ? r.payload.unitPrice : null;
    const key = deviceOfPayload(r.payload);
    const listed = key ? prices.data?.[key] ?? null : null;
    const answer = await ask({
      title: 'Одобрить заявку',
      sub: isDevice
        ? 'Лимит вырастет, и цена уйдёт в ежемесячный счёт клиента.'
        : 'Решение вступит в силу сразу после подтверждения.',
      effects: [['Заведение', r.tenantName], ['Просят', item.what], ['Просил', r.createdByName]],
      value: isDevice
        ? {
          label: 'Цена за штуку в месяц, ₸',
          initial: String(Math.round((asked ?? listed ?? 800000) / 100)),
          hint: asked !== null && listed !== null && asked !== listed
            ? `партнёр предложил ${money(asked)}, по прайсу ${money(listed)}`
            : 'ноль — бесплатно, строка всё равно появится в счёте',
        }
        : undefined,
      confirmLabel: isDevice ? 'Одобрить и добавить в счёт' : 'Одобрить',
    });
    if (!answer) return;
    const body = isDevice
      ? { id: r.id, approve: true, unitPrice: Math.round(Number(answer.value) * 100) || 0 }
      : { id: r.id, approve: true };
    reqAct.mutate(body, {
      onSuccess: () => {
        toast({ text: 'Заявка одобрена' });
        dismiss(item.id, ['requests', 'tenants']);
      },
    });
  };

  const rejectRequest = async (item: QueueItem) => {
    const r = item.request;
    if (!r) return;
    const answer = await ask({
      title: 'Отказать по заявке',
      sub: 'Партнёр увидит причину в своей вкладке «Мои заявки».',
      effects: [['Заведение', r.tenantName], ['Просят', item.what], ['Просил', r.createdByName]],
      reason: { label: 'Почему отказ — это увидит партнёр', placeholder: 'Сначала пусть закроют долг за август…', required: true },
      danger: true,
      confirmLabel: 'Отказать',
    });
    if (!answer) return;
    reqAct.mutate({ id: r.id, approve: false, comment: answer.reason }, {
      onSuccess: () => {
        toast({ text: 'Отказ отправлен партнёру' });
        dismiss(item.id, ['requests', 'tenants']);
      },
    });
  };

  const approveSignup = async (item: QueueItem) => {
    const t = item.tenant;
    if (!t) return;
    const answer = await ask({
      title: `Одобрить регистрацию · ${t.name}`,
      sub: 'Заведение получит доступ и пробный период. Деньги пока не считаются.',
      effects: [
        ['Заведение', t.name],
        ['Владелец', t.ownerName ?? '—'],
        ['Тариф после пробного', `${money(t.planPrice)}/мес`],
      ],
      value: { label: 'Пробный период, дней', initial: '7' },
      confirmLabel: 'Одобрить и открыть доступ',
    });
    if (!answer) return;
    try {
      await call('/signups/approve', {
        method: 'POST', token,
        body: { tenantId: t.id, trialDays: Number(answer.value) || 7 },
      });
      toast({ text: `«${t.name}» одобрен, пробный период открыт` });
      dismiss(item.id, ['tenants']);
    } catch (e) {
      toast({ text: humanError(e), kind: 'err' });
    }
  };

  const rejectSignup = async (item: QueueItem) => {
    const t = item.tenant;
    if (!t) return;
    const answer = await ask({
      title: `Отклонить регистрацию · ${t.name}`,
      sub: 'Заявка закроется. Причину увидит владелец заведения.',
      effects: [['Заведение', t.name], ['Владелец', t.ownerName ?? '—']],
      reason: { label: 'Причина отказа', placeholder: 'Нет связи третий день…', required: false },
      danger: true,
      confirmLabel: 'Отклонить',
    });
    if (!answer) return;
    try {
      await call('/signups/reject', { method: 'POST', token, body: { tenantId: t.id, reason: answer.reason } });
      toast({ text: 'Регистрация отклонена' });
      dismiss(item.id, ['tenants']);
    } catch (e) {
      toast({ text: humanError(e), kind: 'err' });
    }
  };

  const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const decisions = queue.filter((i) => i.group !== 'soon').length;
  const active = rows.filter((r) => r.status === 'ACTIVE').length;
  const nextDue = rows
    .filter((r) => r.daysLeft !== null && r.daysLeft >= 0)
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))[0];

  const sub = isSuper
    ? decisions > 0
      ? `${decisions} решений ждут вас`
      : 'Решений нет — всё разобрано'
    : decisions > 0
      ? `${decisions} дел по вашим клиентам`
      : 'По вашим клиентам всё спокойно';

  return (
    <>
      <PageHead title={`Сегодня, ${today}`} sub={sub} />

      {busy && <SkeletonCards count={3} height={140} />}
      {failed && !busy && (
        <Failed
          text={humanError(tenants.error ?? payments.error ?? requests.error)}
          onRetry={() => { void tenants.refetch(); void payments.refetch(); void requests.refetch(); }}
        />
      )}

      {!busy && !failed && queue.length === 0 && (
        <div className="all-clear">
          <b>Разобрано. Ни одного решения не ждёт</b>
          <p>
            {active > 0
              ? `${active} заведений работают${nextDue ? `, ближайшая оплата через ${nextDue.daysLeft} дн. — «${nextDue.name}»` : ''}.`
              : 'Как только появится клиент, он придёт сюда.'}
          </p>
          <p className="hint">
            {isSuper
              ? 'Новые оплаты, заявки и регистрации попадут на этот экран, а на пункте «Сегодня» загорится счётчик.'
              : 'Здесь появятся ваши клиенты, которым пора платить, и ответы платформы по заявкам.'}
          </p>
        </div>
      )}

      {!busy && !failed && GROUPS.map((g) => {
        const items = queue.filter((i) => i.group === g.key);
        if (items.length === 0) return null;
        return (
          <section className="queue-group" key={g.key}>
            <div className="queue-head">
              <h2>{g.title}</h2>
              <span className="count">{items.length}</span>
              <i>{g.hint}</i>
            </div>

            <div className="queue-list">
              {items.map((item) => (
                <article key={item.id} className={`queue-item ${g.key} ${leaving[item.id] ? 'leaving' : ''}`}>
                  <div className="queue-main">
                    <button className="link-name" onClick={() => onOpenClient(item.tenantId)}>{item.tenantName}</button>
                    <div className="queue-what">{item.what}</div>
                    <div className="sub">{item.meta}</div>
                    {item.why && <div className="queue-why">{item.why}</div>}
                    {item.kind === 'payment' && item.payment && (
                      <div className="pay-note">{payLine(item.payment, rows, partners.data ?? [])}</div>
                    )}
                  </div>

                  <div className="queue-actions">
                    {isSuper && item.kind === 'payment' && (
                      <>
                        <button className="btn small" disabled={payAct.isPending} onClick={() => void rejectPayment(item)}>Отклонить…</button>
                        <button className="btn small primary" disabled={payAct.isPending} onClick={() => void approvePayment(item)}>Подтвердить…</button>
                      </>
                    )}
                    {isSuper && item.kind === 'request' && (
                      <>
                        <button className="btn small" disabled={reqAct.isPending} onClick={() => void rejectRequest(item)}>Отказать…</button>
                        <button className="btn small primary" disabled={reqAct.isPending} onClick={() => void approveRequest(item)}>Одобрить…</button>
                      </>
                    )}
                    {isSuper && item.kind === 'signup' && (
                      <>
                        <button className="btn small" onClick={() => void rejectSignup(item)}>Отклонить…</button>
                        <button className="btn small primary" onClick={() => void approveSignup(item)}>Одобрить…</button>
                      </>
                    )}
                    {!isSuper && (item.kind === 'payment' || item.kind === 'request') && (
                      <span className="sub waiting-note">Ждёт решения платформы</span>
                    )}
                    {item.tenant?.ownerPhone && (
                      <a className="btn small" href={`tel:${item.tenant.ownerPhone}`}>Позвонить</a>
                    )}
                    <button className="btn small ghost" onClick={() => onOpenClient(item.tenantId)}>Карточка</button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
