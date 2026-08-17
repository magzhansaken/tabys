/**
 * СЛОВАРЬ СОСТОЯНИЙ — перенесено из их ui/status.ts.
 *
 * Их довод: раньше словарь жил в главном файле и не знал про
 * «ждёт одобрения» — а именно у таких строк рисуются кнопки решения.
 * Теперь незнакомое состояние показывается как есть и ничего не
 * роняет: функция всегда возвращает вид, а не пустоту.
 *
 * ПОЯСНЕНИЕ ПОД ПЛАШКОЙ — их приём, которого у меня не было: цвет
 * несёт смысл, но словами всё равно надо сказать. «Ждёт
 * подтверждения» само по себе не объясняет, что деньги уже отмечены,
 * а доступ ещё не открыт.
 */
export type StatusView = {
  text: string;
  /** Класс плашки: цвет несёт смысл. */
  cls: string;
  /** Пояснение под плашкой там, где есть место. */
  hint: string;
};

const STATUS: Record<string, StatusView> = {
  approval: {
    text: 'Ждёт одобрения',
    cls: 'st-approval',
    hint: 'владелец зарегистрировался сам',
  },
  setup: {
    text: 'Настройка',
    cls: 'st-setup',
    hint: 'доступы выданы, работа ещё не началась',
  },
  pending_pay: {
    text: 'Ждёт подтверждения',
    cls: 'st-pending',
    hint: 'оплата отмечена, деньги не подтверждены',
  },
  active: {
    text: 'Работает',
    cls: 'st-active',
    hint: 'подписка оплачена, продажи идут',
  },
  expired: {
    text: 'Срок вышел',
    cls: 'st-expired',
    hint: 'продажи закрыты, кабинет открыт',
  },
  suspended: {
    text: 'Отключён',
    cls: 'st-suspended',
    hint: 'выключен вручную владельцем платформы',
  },
};

/** Вид состояния. Неизвестный ключ показывается словом ключа, а не падает. */
export function statusView(key: string): StatusView {
  return STATUS[key] ?? { text: key, cls: 'st-unknown', hint: '' };
}

/** Вкладки списка клиентов: порядок от входящего потока к архиву. */
export const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: 'all',         label: 'Все' },
  { value: 'approval',    label: 'Ждут одобрения' },
  { value: 'active',      label: 'Работают' },
  { value: 'pending_pay', label: 'Ждут подтверждения' },
  { value: 'setup',       label: 'Настройка' },
  { value: 'expired',     label: 'Просрочены' },
  { value: 'suspended',   label: 'Отключены' },
];

/** Партнёр не одобряет регистрации и не отключает клиентов. */
export const STATUS_FILTERS_PARTNER = STATUS_FILTERS.filter(
  (f) => f.value !== 'approval' && f.value !== 'suspended');
