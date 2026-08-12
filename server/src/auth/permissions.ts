/**
 * ПРАВА ДОСТУПА.
 *
 * Модель собрана из трёх источников:
 *  - матрица «раздел × действие» — так у всех троих (UMAG: просмотр/создание/
 *    редактирование/удаление по вкладкам; Wipon: то же по разделам; МойСклад:
 *    раздел → документ → действие);
 *  - точечные флаги — из конкретных болей: прятать закупочные цены (UMAG),
 *    прятать выручку от кассира (Wipon);
 *  - ограничение по торговым точкам (UMAG) — сотрудник видит только свои.
 *
 * Проверка живёт в одном месте (PermissionsGuard) и дублируется на кассе
 * для офлайна. Сервер — истина, касса — быстрый ответ.
 */

/** Разделы = части плана. Один список на сервер, кабинет и кассу. */
export const SECTIONS = [
  'dashboard',    // главная, показатели
  'goods',        // товары
  'stock',        // склад: приёмки, списания, инвентаризация
  'pos',          // касса
  'sales',        // продажи
  'purchases',    // закупки
  'contragents',  // покупатели, поставщики, долги
  'finance',      // счета, платежи
  'reports',      // отчёты
  'documents',    // ЭСФ, СНТ, АВР
  'loyalty',      // акции, бонусы
  'employees',    // сотрудники и роли
  'devices',      // кассы и устройства
  'billing',      // подписка и платежи — отдельно от настроек: бухгалтеру
                  // можно дать оплату счетов, не открывая фискализацию
  'settings',     // настройки, организации
] as const;

export type Section = typeof SECTIONS[number];
export const ACTIONS = ['view', 'create', 'edit', 'delete'] as const;
export type Action = typeof ACTIONS[number];

export type PermissionMatrix = {
  [K in Section | '*']?: Partial<Record<Action, boolean>>;
};

export interface EmployeeContext {
  employeeId: string;
  accountId: string;
  /** pending — заявка ждёт активации оператором, рабочие операции закрыты */
  accountStatus?: string;
  roleCode?: string | null;
  permissions: PermissionMatrix;
  storeIds: string[];          // пустой массив = все точки (владелец/админ)
  canSeePurchasePrice: boolean;
  canSeeRevenue: boolean;
  isOwner: boolean;
  isShiftAdmin: boolean;
}

/**
 * Единственная точка проверки. Правило простое:
 * '*' в матрице (владелец, администратор) → можно всё; иначе — точное совпадение.
 */
export function can(ctx: EmployeeContext, section: Section, action: Action): boolean {
  if (ctx.permissions['*']?.[action]) return true;
  return ctx.permissions[section]?.[action] === true;
}

/** Доступ к конкретной точке: пустой список = все точки (модель UMAG). */
export function canAccessStore(ctx: EmployeeContext, storeId: string): boolean {
  if (ctx.storeIds.length === 0) return true;
  return ctx.storeIds.includes(storeId);
}

/** Готовые пресеты системных ролей (совпадают с данными миграции 001). */
export const SYSTEM_ROLE_PRESETS: Record<string, PermissionMatrix> = {
  owner: { '*': { view: true, create: true, edit: true, delete: true } },
  admin: { '*': { view: true, create: true, edit: true, delete: true } },
  cashier: {
    pos: { view: true, create: true },
    goods: { view: true },
    contragents: { view: true, create: true },
  },
};
