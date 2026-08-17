'use client';
/**
 * УДАЛЕНИЕ МАГАЗИНА — перенесено из их ui/deleteTenant.ts.
 *
 * Их довод: самое необратимое действие панели. Исчезают чеки, смены,
 * товары, сотрудники, склад и история оплат. Поэтому ДВЕ СТУПЕНИ и
 * набор руками, а не «вы уверены?».
 *
 * Первая ступень — только у работающего магазина: надо набрать ЧИСЛО
 * ЧЕКОВ. Это заставляет посмотреть, сколько там продаж, прежде чем
 * стирать. Вторая — набрать название слово в слово.
 *
 * Сервер защищает тем же: не то название — отказ.
 */
import { api } from '../lib';
import { useAsk } from './Ask';
import { useToast } from './Toast';
import { humanError } from './errors';

export function useDeleteTenant(onDone: () => void) {
  const ask = useAsk();
  const toast = useToast();

  return async (client: {
    id: string; name: string; revenue30d?: number;
    stores?: number; registers?: number;
  }) => {
    // Ступень первая: у работающего магазина сперва подтверждение
    // числом. Смотришь на цифру продаж — и часто передумываешь.
    if ((client.revenue30d ?? 0) > 0) {
      const sure = await ask({
        title: `У «${client.name}» есть продажи`,
        sub: 'Это работающий магазин: продажи в нём уже были. Удаление сотрёт и их — '
           + 'отчёты за прошлые месяцы восстановить будет нечем.',
        effects: [
          ['Выручка за 30 дней', `${Math.round(client.revenue30d ?? 0).toLocaleString('ru-RU')} ₸`],
          ['Точек', String(client.stores ?? 0)],
          ['Касс', String(client.registers ?? 0)],
        ],
        value: {
          label: 'Наберите выручку за 30 дней, чтобы продолжить',
          numeric: true,
          mustEqual: String(Math.round(client.revenue30d ?? 0)),
          hint: 'Это чтобы вы посмотрели на цифру, а не нажали не глядя',
        },
        danger: true,
        confirmLabel: 'Понимаю, дальше',
      });
      if (!sure) return;
    }

    // Ступень вторая: название слово в слово.
    const answer = await ask({
      title: `Удалить «${client.name}»`,
      sub: 'Магазин исчезнет из работы. Если клиент просто перестал платить — '
         + 'правильнее отключить его: данные могут понадобиться обеим сторонам.',
      effects: [
        ['Что исчезнет', 'чеки, смены, товары, сотрудники, склад'],
        ['История оплат', 'останется в журнале платформы'],
        ['Обратимо', 'нет'],
      ],
      value: {
        label: 'Наберите название магазина слово в слово',
        mustEqual: client.name,
      },
      danger: true,
      confirmLabel: 'Удалить навсегда',
    });

    if (!answer) return;

    try {
      await api('/tenant/delete', { method: 'POST',
        body: { tenantId: client.id, confirmName: answer.value } });
      toast({ text: `«${client.name}» удалён` });
      onDone();
    } catch (e: any) {
      toast({ text: humanError(e), kind: 'err' });
    }
  };
}
