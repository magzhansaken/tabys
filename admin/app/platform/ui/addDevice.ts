'use client';
/**
 * ДОБАВИТЬ УСТРОЙСТВО — перенесено из их ui/addDevice.ts.
 *
 * Их довод, взятый как есть: раньше это были три разных места —
 * поднять предел, завести строку в счёте, создать устройство с кодом.
 * Забыл одно — клиент платит за то, чего нет, или пользуется тем, за
 * что не платит. Теперь одно действие.
 *
 * Последствия считает СЕРВЕР: доплата за остаток периода и новая
 * месячная сумма. Кабинет их только показывает.
 *
 * ОТЛИЧИЕ ПО ДЕЛУ: у них виды ресторанные — экран кухни, телефон
 * официанта, курьер. У магазина их два: касса и точка.
 */
import { api, money } from '../lib';
import { useAsk } from './Ask';
import { useToast } from './Toast';
import { humanError } from './errors';

export const ADD_KINDS = [
  { kind: 'pos',   title: 'Касса', what: 'продажи и приём оплаты' },
  { kind: 'store', title: 'Точка', what: 'второй магазин со своим складом' },
];

export function useAddDevice(onDone: () => void) {
  const ask = useAsk();
  const toast = useToast();

  return async (client: { id: string; name: string }) => {
    const answer = await ask({
      title: `Добавить устройство · ${client.name}`,
      sub: 'Одним действием: появится строка в счёте и код для привязки. '
         + 'Доплату за остаток периода считает сервер.',
      choice: {
        label: 'Что добавляем',
        options: ADD_KINDS.map((k) => ({ value: k.kind, label: `${k.title} — ${k.what}` })),
      },
      confirmLabel: 'Добавить',
    });

    if (!answer) return;

    // Сперва спрашиваем, во что это обойдётся: у них так же — сумма
    // видна до нажатия, а не после.
    let p: any;
    try {
      p = await api(`/clients/${client.id}/device-preview?kind=${answer.choice}`);
    } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); return; }

    const kind = ADD_KINDS.find((k) => k.kind === answer.choice);

    const sure = await ask({
      title: `${kind?.title} для «${client.name}»`,
      effects: [
        ['В месяц', `${money(p.monthly)} за каждую`],
        ['Доплата сейчас', p.proRata > 0 ? money(p.proRata) : 'нет'],
        ['До конца периода', `${p.daysLeft} дн.`],
      ],
      // Правило десяти дней объясняется словами — иначе непонятно,
      // почему доплаты нет.
      sub: p.note,
      confirmLabel: 'Да, добавить',
    });

    if (!sure) return;

    try {
      const r = await api('/device/add', { method: 'POST',
        body: { tenantId: client.id, kind: answer.choice } });
      toast({ text: r.proRata > 0
        ? `${kind?.title} добавлена · доплата ${money(r.proRata)} за ${r.daysLeft} дн.`
        : `${kind?.title} добавлена · доплаты нет` });
      onDone();
    } catch (e: any) {
      toast({ text: humanError(e), kind: 'err' });
    }
  };
}
