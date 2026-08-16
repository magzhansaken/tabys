import { z } from 'zod';
import { Money } from './money';

/** Роль в платформе. SUPER видит всё и подтверждает деньги, PARTNER — своих клиентов. */
export const PlatformRole = z.enum(['SUPER', 'PARTNER']);
export type PlatformRole = z.infer<typeof PlatformRole>;

export const TenantStatus = z.enum([
  'SETUP',
  'PENDING_APPROVAL',
  'PENDING_PAYMENT',
  'ACTIVE',
  'EXPIRED',
  'SUSPENDED',
]);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const PlatformLoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});
export type PlatformLoginRequest = z.infer<typeof PlatformLoginRequest>;

export const PlatformSession = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    fullName: z.string(),
    email: z.string(),
    role: PlatformRole,
  }),
});
export type PlatformSession = z.infer<typeof PlatformSession>;

/** Строка списка клиентов: всё, что нужно видеть в таблице без лишних запросов. */
export const TenantRow = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  status: TenantStatus,
  planName: z.string(),
  planPrice: Money,
  paidUntil: z.string().nullable(),
  /** сколько дней осталось; отрицательное — просрочка */
  daysLeft: z.number().nullable(),
  ownerName: z.string().nullable(),
  ownerPhone: z.string().nullable(),
  city: z.string().nullable(),
  partnerName: z.string().nullable(),
  locations: z.number(),
  /** выручка заведения за 30 дней — партнёр видит, живёт ли клиент */
  revenue30: Money,
  createdAt: z.string(),
  pendingPayments: z.number(),
});
export type TenantRow = z.infer<typeof TenantRow>;

export const TenantList = z.object({
  rows: z.array(TenantRow),
  totals: z.object({
    all: z.number(),
    active: z.number(),
    pending: z.number(),
    expired: z.number(),
    /** ожидаемый доход платформы в месяц по активным */
    mrr: Money,
  }),
});
export type TenantList = z.infer<typeof TenantList>;

export const CreateTenantRequest = z.object({
  /** название заведения */
  name: z.string().min(2).max(80),
  vertical: z.enum(['CAFE', 'FASTFOOD', 'SHOP', 'SALON', 'BILLIARD']).default('CAFE'),
  ownerName: z.string().min(2).max(80),
  ownerPhone: z.string().min(10).max(20),
  ownerEmail: z.string().email(),
  city: z.string().max(40).optional(),
  planName: z.string().default('Базовый'),
  planPrice: Money.default(0),
  locationName: z.string().min(2).max(60).default('Главная'),
  /** наполнить учебными данными: партнёру нужно что-то показывать клиенту */
  withDemo: z.boolean().default(false),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

/** Ответ при создании: пароль владельца и код кассы показываются ОДИН раз. */
export const CreateTenantResponse = z.object({
  tenantId: z.string(),
  accountId: z.string(),
  ownerEmail: z.string(),
  ownerPassword: z.string(),
  activationCode: z.string(),
  menuUrl: z.string(),
});
export type CreateTenantResponse = z.infer<typeof CreateTenantResponse>;

export const PaymentRow = z.object({
  id: z.string(),
  tenantId: z.string(),
  tenantName: z.string(),
  amount: Money,
  months: z.number(),
  method: z.string(),
  comment: z.string().nullable(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  createdAt: z.string(),
  createdByName: z.string(),
  approvedByName: z.string().nullable(),
  approvedAt: z.string().nullable(),
  rejectReason: z.string().nullable(),
});
export type PaymentRow = z.infer<typeof PaymentRow>;

export const SubmitPaymentRequest = z.object({
  tenantId: z.string(),
  amount: Money,
  months: z.number().int().min(1).max(24),
  method: z.string().min(2).max(30),
  comment: z.string().max(200).optional(),
});
export type SubmitPaymentRequest = z.infer<typeof SubmitPaymentRequest>;

export const ApprovePaymentRequest = z.object({
  paymentId: z.string(),
  /** отклонение требует причины: партнёр должен понять, что не так */
  reject: z.string().max(200).optional(),
});
export type ApprovePaymentRequest = z.infer<typeof ApprovePaymentRequest>;

export const PartnerRow = z.object({
  id: z.string(),
  fullName: z.string(),
  email: z.string(),
  role: PlatformRole,
  isActive: z.boolean(),
  commissionBp: z.number(),
  clients: z.number(),
  activeClients: z.number(),
  /** заработок партнёра за 30 дней по подтверждённым оплатам */
  earned30: Money,
  lastLoginAt: z.string().nullable(),
});
export type PartnerRow = z.infer<typeof PartnerRow>;

export const CreatePartnerRequest = z.object({
  fullName: z.string().min(2).max(80),
  email: z.string().email(),
  password: z.string().min(8).max(64),
  commissionBp: z.number().int().min(0).max(5000).default(1500),
});
export type CreatePartnerRequest = z.infer<typeof CreatePartnerRequest>;

export const OkResponse = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof OkResponse>;

/** Виды заявок партнёра. Всё, что меняет деньги, решает владелец платформы. */
export const TenantRequestKind = z.enum(['DEVICE_LIMIT', 'PLAN', 'GRACE', 'OTHER']);
export type TenantRequestKind = z.infer<typeof TenantRequestKind>;

export const TenantRequestRow = z.object({
  id: z.string(),
  tenantId: z.string(),
  tenantName: z.string(),
  kind: TenantRequestKind,
  /** что именно просят: { maxPos: 3 } | { planName, planPrice } | { days } */
  payload: z.record(z.unknown()),
  /** зачем — партнёр объясняет своими словами */
  reason: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  createdByName: z.string(),
  createdAt: z.string(),
  decision: z.string().nullable(),
  decidedAt: z.string().nullable(),
  /**
   * Деньги клиента рядом с заявкой.
   *
   * Решение об устройстве — это решение о деньгах: владелец должен
   * видеть, платит ли человек, не просрочен ли и не висит ли у него
   * неподтверждённая оплата. Необязательно: старые сборки панели
   * поля не ждут.
   */
  client: z.object({
    paidUntil: z.string().nullable(),
    daysLeft: z.number().int().nullable(),
    status: TenantStatus,
    monthly: Money,
    pendingPayment: z.object({
      amount: Money,
      months: z.number().int(),
      at: z.string(),
    }).nullable(),
  }).optional(),
});
export type TenantRequestRow = z.infer<typeof TenantRequestRow>;

export const CreateRequestRequest = z.object({
  tenantId: z.string(),
  kind: TenantRequestKind,
  payload: z.record(z.unknown()),
  /** причина обязательна: просьба без объяснения не проходит */
  reason: z.string().min(5).max(300),
});
export type CreateRequestRequest = z.infer<typeof CreateRequestRequest>;
