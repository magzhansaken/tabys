/*
 * Один словарь статусов на все экраны панели.
 *
 * Раньше словарь жил в main.tsx и не знал про PENDING_APPROVAL —
 * а именно у таких строк рисуются «Одобрить / Отклонить». Теперь
 * незнакомый статус показывается как есть и ничего не роняет:
 * функция всегда возвращает вид, а не undefined.
 */

export type StatusView = {
  /** Слово, которое видит человек. */
  text: string;
  /** Класс плашки: цвет несёт смысл. */
  cls: string;
  /** Пояснение под плашкой там, где есть место. */
  hint: string;
};

const STATUS: Record<string, StatusView> = {
  PENDING_APPROVAL: {
    text: 'Ждёт одобрения',
    cls: 'st-approval',
    hint: 'владелец зарегистрировался сам',
  },
  SETUP: {
    text: 'Настройка',
    cls: 'st-setup',
    hint: 'доступы выданы, работа ещё не началась',
  },
  PENDING_PAYMENT: {
    text: 'Ждёт подтверждения',
    cls: 'st-pending',
    hint: 'оплата отмечена, деньги не подтверждены',
  },
  ACTIVE: {
    text: 'Работает',
    cls: 'st-active',
    hint: 'срок оплачен',
  },
  EXPIRED: {
    text: 'Срок вышел',
    cls: 'st-expired',
    hint: 'доступ закрыт до оплаты',
  },
  SUSPENDED: {
    text: 'Отключён',
    cls: 'st-suspended',
    hint: 'отключён вручную',
  },
};

/** Вид статуса. Неизвестный ключ показывается словом ключа, а не падает. */
export function statusView(key: string): StatusView {
  return STATUS[key] ?? { text: key, cls: 'st-unknown', hint: '' };
}

/** Фильтры списка клиентов: порядок — от входящего потока к архиву. */
export const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'PENDING_APPROVAL', label: 'Ждут одобрения' },
  { value: 'ACTIVE', label: 'Работают' },
  { value: 'PENDING_PAYMENT', label: 'Ждут подтверждения' },
  { value: 'SETUP', label: 'Настройка' },
  { value: 'EXPIRED', label: 'Просрочены' },
  { value: 'SUSPENDED', label: 'Отключены' },
];

/** Партнёр не одобряет регистрации и не отключает клиентов. */
export const STATUS_FILTERS_PARTNER: { value: string; label: string }[] =
  STATUS_FILTERS.filter((f) => f.value !== 'PENDING_APPROVAL' && f.value !== 'SUSPENDED');
