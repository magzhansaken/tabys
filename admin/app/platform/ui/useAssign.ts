'use client';
/**
 * ПЕРЕДАЧА КЛИЕНТА ПАРТНЁРУ — перенесено из их ui/useAssign.ts.
 *
 * Их довод: один и тот же путь из списка и из карточки — выбор в
 * листе, последствие пересчитывается ВМЕСТЕ С ВЫБОРОМ. Меняешь
 * партнёра в списке — тут же видно новую долю.
 *
 * Про деньги сказано прямо: доля считается в момент подтверждения
 * оплаты, и уже подтверждённые не пересчитываются задним числом.
 * Иначе отчёт за прошлый месяц менялся бы сам собой.
 */
import { api } from '../lib';
import { useAsk } from './Ask';
import { useToast } from './Toast';
import { humanError } from './errors';

const PLATFORM = '__platform__';

export function useAssign(onDone: () => void) {
  const ask = useAsk();
  const toast = useToast();

  return async (client: { id: string; name: string; partner?: string | null },
                partners: { id: string; name: string; commissionPercent: number }[]) => {
    const options = [
      { value: PLATFORM, label: 'Платформе · клиент станет ничьим' },
      ...partners.map((p) => ({
        value: p.id,
        label: `${p.name} · доля ${p.commissionPercent}%`,
      })),
    ];

    const answer = await ask({
      title: `Передать «${client.name}»`,
      choice: { label: 'Кому передать', options },
      // Пересчитывается на каждый выбор — их приём.
      effects: (r) => {
        const to = partners.find((p) => p.id === r.choice);
        return [
          ['Магазин', client.name],
          ['Сейчас ведёт', client.partner ?? 'платформа · клиент ничей'],
          ['Перейдёт к', to ? to.name : 'платформе · станет ничьим'],
          ['Доля с будущих оплат', to ? `${to.commissionPercent}%` : 'нет · всё платформе'],
          ['Уже подтверждённые оплаты', 'не пересчитываются'],
        ];
      },
      confirmLabel: 'Передать',
    });

    if (!answer) return;

    const to = partners.find((p) => p.id === answer.choice);
    try {
      await api(`/clients/${client.id}/partner`, { method: 'POST',
        body: { partnerId: answer.choice === PLATFORM ? null : answer.choice } });
      toast({ text: to
        ? `«${client.name}» ведёт ${to.name} · доля ${to.commissionPercent}%`
        : `«${client.name}» стал ничьим` });
      onDone();
    } catch (e: any) {
      toast({ text: humanError(e), kind: 'err' });
    }
  };
}
