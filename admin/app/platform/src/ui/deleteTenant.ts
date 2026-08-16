/*
 * Удаление заведения.
 *
 * Самое необратимое действие панели: исчезают чеки, смены, меню,
 * сотрудники, склад и история оплат. Поэтому две ступени и набор
 * названия руками — а не «вы уверены?».
 *
 * Сервер защищает тем же: не то название — NAME_MISMATCH с верным
 * написанием; есть чеки — HAS_ORDERS с их числом, и число нужно
 * подтвердить осознанно.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { call } from '../main';
import { useAsk } from './ConfirmSheet';
import { humanError } from './errors';
import { useToast } from './Toast';

type DeleteTarget = {
  id: string;
  name: string;
  monthly: number;
  paidUntil: string | null;
};

type Fail = { code?: string; name?: string; orders?: number };

function payloadOf(e: unknown): Fail {
  if (!(e instanceof Error)) return {};
  const raw = e.message;
  try {
    return JSON.parse(raw) as Fail;
  } catch {
    const code = raw.match(/"code"\s*:\s*"([A-Z_]+)"/)?.[1];
    const name = raw.match(/"name"\s*:\s*"([^"]+)"/)?.[1];
    const orders = raw.match(/"orders"\s*:\s*(\d+)/)?.[1];
    return { code, name, orders: orders ? Number(orders) : undefined };
  }
}

export function useDeleteTenant(token: string, onDeleted: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useAsk();

  const m = useMutation({
    mutationFn: (v: { tenantId: string; confirmName: string; knownOrders?: number }) =>
      call<{ name: string; orders: number }>('/tenant/delete', { method: 'POST', token, body: v }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['metrics'] });
      toast({
        text: r.orders > 0
          ? `«${r.name}» удалено вместе с ${r.orders} чеками`
          : `«${r.name}» удалено`,
      });
      onDeleted();
    },
  });

  /** Вторая ступень: чеки есть, их число нужно подтвердить. */
  const askOrders = async (t: DeleteTarget, orders: number) => {
    const answer = await ask({
      title: `У «${t.name}» есть чеки`,
      sub: 'Это работающее заведение: продажи в нём уже были. Удаление сотрёт и их — отчёты за прошлые месяцы восстановить будет нечем.',
      effects: [
        ['Заведение', t.name],
        ['Чеков в базе', String(orders)],
        ['Что исчезнет', 'чеки, смены, меню, сотрудники, склад, история оплат'],
        ['Как вернуть', 'только из ночного дампа — с потерей всего, что было после него'],
      ],
      value: {
        label: 'Введите число чеков, чтобы подтвердить',
        numeric: true,
        mustEqual: String(orders),
        hint: `в базе ${orders} — наберите это число`,
      },
      danger: true,
      confirmLabel: 'Удалить вместе с чеками',
    });
    if (!answer) return;
    m.mutate({ tenantId: t.id, confirmName: t.name, knownOrders: orders });
  };

  const remove = async (t: DeleteTarget) => {
    const answer = await ask({
      title: `Удалить «${t.name}»`,
      sub: 'Заведение исчезнет целиком и навсегда. Если клиент просто перестал платить — правильнее отключить его: данные могут понадобиться обеим сторонам.',
      effects: [
        ['Заведение', t.name],
        ['Счёт в месяц', `${Math.round(t.monthly / 100).toLocaleString('ru-RU')} ₸`],
        ['Что исчезнет', 'чеки, смены, меню, сотрудники, склад, история оплат'],
        ['Как вернуть', 'только из ночного дампа — с потерей всего, что было после него'],
      ],
      value: {
        label: 'Введите название заведения',
        numeric: false,
        mustEqual: t.name,
        hint: 'слово в слово, как в карточке',
      },
      danger: true,
      confirmLabel: 'Удалить заведение',
    });
    if (!answer) return;

    try {
      await m.mutateAsync({ tenantId: t.id, confirmName: answer.value });
    } catch (e) {
      const fail = payloadOf(e);
      if (fail.code === 'HAS_ORDERS' && typeof fail.orders === 'number') {
        await askOrders(t, fail.orders);
        return;
      }
      if (fail.code === 'NAME_MISMATCH') {
        toast({
          text: fail.name ? `Название не совпало — в базе «${fail.name}»` : 'Название не совпало',
          kind: 'err',
        });
        return;
      }
      toast({ text: humanError(e), kind: 'err' });
    }
  };

  return remove;
}
