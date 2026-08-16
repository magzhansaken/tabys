/*
 * Передача клиента партнёру.
 *
 * Один и тот же путь из списка и из карточки: выбор в листе,
 * последствие пересчитывается вместе с выбором.
 *
 * Про деньги сказано прямо: доля считается в момент подтверждения
 * платежа, поэтому уже подтверждённые выплаты не пересчитываются.
 * Человек должен понимать это до нажатия, а не узнать в споре.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PartnerRow } from '../contracts';
import { call } from '../main';
import { useAsk } from './ConfirmSheet';
import { useToast } from './Toast';
import { humanError } from './errors';

export type AssignTarget = {
  id: string;
  name: string;
  /** Кто ведёт сейчас; null — клиент ничей, пришёл с сайта. */
  partnerName: string | null;
};

const PLATFORM = '';

export function useAssign(token: string, enabled = true): {
  assign: (t: AssignTarget) => Promise<void>;
  partners: PartnerRow[];
  busy: boolean;
} {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useAsk();

  const list = useQuery({
    queryKey: ['partners'],
    queryFn: () => call<PartnerRow[]>('/partners', { token }),
    enabled,
  });

  const m = useMutation({
    mutationFn: (v: { tenantId: string; partnerId: string | null }) =>
      call<{ ok: true; partnerName: string | null }>('/assign', { method: 'POST', token, body: v }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      void qc.invalidateQueries({ queryKey: ['partners'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const partners = (list.data ?? []).filter((p) => p.role !== 'SUPER' && p.isActive);

  const assign = async (t: AssignTarget) => {
    if (partners.length === 0) {
      toast({ text: 'Партнёров пока нет — заведите их во вкладке «Партнёры»', kind: 'err' });
      return;
    }

    const options = [
      ...partners
        .filter((p) => p.fullName !== t.partnerName)
        .map((p) => ({ value: p.id, label: `${p.fullName} · доля ${(p.commissionBp / 100).toFixed(0)}%` })),
      ...(t.partnerName ? [{ value: PLATFORM, label: 'Забрать платформе — клиент станет ничьим' }] : []),
    ];

    const answer = await ask({
      title: `Передать «${t.name}»`,
      sub: 'Новый партнёр начнёт вести клиента и получать долю с будущих подтверждённых оплат.',
      choice: { label: 'Кому передать', options },
      effects: (r) => {
        const to = partners.find((p) => p.id === r.choice);
        return [
          ['Заведение', t.name],
          ['Сейчас ведёт', t.partnerName ?? 'платформа · клиент ничей'],
          ['Перейдёт к', to ? to.fullName : 'платформе · станет ничьим'],
          ['Доля с будущих оплат', to ? `${(to.commissionBp / 100).toFixed(0)}%` : 'нет · всё платформе'],
          ['Уже подтверждённые оплаты', 'не пересчитываются'],
        ];
      },
      confirmLabel: 'Передать',
    });
    if (!answer) return;

    const to = partners.find((p) => p.id === answer.choice);
    m.mutate(
      { tenantId: t.id, partnerId: answer.choice === PLATFORM ? null : answer.choice },
      {
        onSuccess: (res) => toast({
          text: res.partnerName
            ? `«${t.name}» ведёт ${res.partnerName}`
            : `«${t.name}» забран платформе`,
        }),
      },
    );
  };

  return { assign, partners, busy: m.isPending };
}
