/*
 * Добавить устройство клиенту — одно действие вместо трёх.
 *
 * Раньше это были три разных места: поднять лимит, завести строку в
 * счёте, создать устройство с кодом. Забыл одно — клиент платит за
 * то, чего нет, или пользуется тем, за что не платит.
 *
 * Последствия считает сервер: доплата за остаток периода и новый
 * месячный счёт приходят из предпросмотра. Своей арифметики здесь
 * нет — по той же причине, по которой панель не считает скидки:
 * прайс и правила меняются на сервере, и расхождение стоит денег.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { call, money } from '../main';
import { useAsk } from './ConfirmSheet';
import { humanError } from './errors';
import { useToast } from './Toast';
import type { PriceBook } from './prices';

export type DeviceKind = 'POS' | 'KDS' | 'WAITER';

export const ADD_KINDS: { kind: DeviceKind; title: string; price: keyof PriceBook; what: string }[] = [
  { kind: 'POS', title: 'Касса', price: 'pos', what: 'приём заказов и оплата' },
  { kind: 'KDS', title: 'Экран кухни', price: 'kds', what: 'заказы на кухне' },
  { kind: 'WAITER', title: 'Телефон официанта', price: 'waiter', what: 'заказ прямо у стола' },
];

type Preview = { limitAfter: number; monthlyAfter: number; proRata: number; proRataDays: number };
type Added = { code: string; name: string; monthlyAfter: number; proRata: number; proRataDays: number };

export function useAddDevice(token: string, onCode: (v: { name: string; code: string }) => void) {
  const qc = useQueryClient();
  const ask = useAsk();
  const toast = useToast();

  const add = useMutation({
    mutationFn: (v: { tenantId: string; kind: DeviceKind; name: string; unitPrice: number }) =>
      call<Added>('/tenant/device/add', { method: 'POST', token, body: v }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['tenant-card'] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      void qc.invalidateQueries({ queryKey: ['activation'] });
      onCode({ name: r.name, code: r.code });
      toast({
        text: r.proRata > 0
          ? `«${r.name}» добавлено · доплата ${money(r.proRata)} за ${r.proRataDays} дн.`
          : `«${r.name}» добавлено · счёт ${money(r.monthlyAfter)}/мес`,
      });
    },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  /** Предпросмотр: цифры в листе должны быть серверные, а не мои. */
  const peek = (tenantId: string, kind: DeviceKind, unitPrice: number) =>
    call<Preview>(
      `/tenant/device/add/preview?tenantId=${tenantId}&kind=${kind}&unitPrice=${unitPrice}`,
      { token },
    );

  /**
   * Спрашивает вид, название и цену, показывает последствия и добавляет.
   * `listPrice` — цена по прайсу для выбранного вида, `suggest` — имя по умолчанию.
   */
  const addDevice = async (t: {
    id: string; name: string; kind: DeviceKind; listPrice: number | null; suggest: string;
  }) => {
    const kindTitle = ADD_KINDS.find((k) => k.kind === t.kind)?.title ?? t.kind;

    const answer = await ask({
      title: `Добавить ${kindTitle.toLowerCase()} · ${t.name}`,
      sub: 'Одним действием: поднимем лимит, добавим строку в счёт и создадим устройство с кодом активации.',
      value: {
        label: 'Цена за штуку в месяц, ₸',
        initial: String(Math.round((t.listPrice ?? 0) / 100)),
        numeric: true,
        hint: t.listPrice !== null
          ? `по прайсу ${money(t.listPrice)} · ноль — бесплатно, строка в счёте не появится`
          : 'ноль — бесплатно, строка в счёте не появится',
      },
      /* Последствия пересчитываются на сервере, пока человек правит цену. */
      effects: async (draft: { value: string }) => {
        const price = Math.round(Number(draft.value.replace(',', '.')) * 100) || 0;
        const rows: [string, string][] = [
          ['Заведение', t.name],
          ['Устройство', `${kindTitle} · ${t.suggest}`],
        ];
        try {
          const p = await peek(t.id, t.kind, price);
          rows.push(['Лимит станет', `${p.limitAfter} шт.`]);
          rows.push([
            'Доплата за остаток периода',
            p.proRata > 0
              ? `${money(p.proRata)} за ${p.proRataDays} дн.`
              : p.proRataDays > 0
                ? `не берём — до конца ${p.proRataDays} дн.`
                : 'не берём',
          ]);
          rows.push(['Счёт станет', `${money(p.monthlyAfter)}/мес`]);
        } catch {
          rows.push(['Последствия', 'не удалось посчитать — сервер не ответил']);
        }
        if (price === 0) rows.push(['Строка в счёте', 'не появится — устройство бесплатное']);
        return rows;
      },
      confirmLabel: 'Добавить устройство',
    });
    if (!answer) return;

    const unitPrice = Math.round(Number(answer.value.replace(',', '.')) * 100) || 0;
    if (unitPrice < 0) {
      toast({ text: 'Цена не может быть отрицательной', kind: 'err' });
      return;
    }
    add.mutate({ tenantId: t.id, kind: t.kind, name: t.suggest, unitPrice });
  };

  return { addDevice, busy: add.isPending };
}
