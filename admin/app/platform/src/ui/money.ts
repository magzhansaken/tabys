/*
 * Деньги словами: последствия решения до нажатия.
 *
 * Обе очереди — «Деньги» и «Сегодня» — показывают одно и то же одним
 * и тем же текстом, потому что строят его здесь. Если формула съедет,
 * съедет в одном месте, а не в двух.
 *
 * Арифметика повторяет сервер буквально:
 *   срок  — база это большая из дат «сегодня» и paidUntil, дальше +months;
 *   доля  — Math.round(amount × commissionBp / 10000).
 */
import type { PartnerRow, PaymentRow, TenantRow } from '../contracts';
import { money } from '../main';

/** Новый срок после подтверждения. Досрочная оплата не съедает остаток. */
export function extendDate(paidUntil: string | null, months: number, now = new Date()): Date {
  const end = paidUntil ? new Date(paidUntil) : null;
  const base = end && end > now ? end : now;
  const until = new Date(base);
  until.setMonth(until.getMonth() + months);
  return until;
}

export const asDate = (d: Date): string => d.toLocaleDateString('ru-RU');

export type Share = { name: string; share: number | null; pct: number | null };

/** Кому и сколько уйдёт с этой оплаты. null — у клиента нет партнёра. */
export function shareOf(
  payment: PaymentRow,
  tenants: TenantRow[],
  partners: PartnerRow[],
): Share | null {
  const tenant = tenants.find((t) => t.id === payment.tenantId);
  const name = tenant?.partnerName ?? null;
  if (!name) return null;
  const bp = partners.find((p) => p.fullName === name)?.commissionBp;
  if (bp === undefined) return { name, share: null, pct: null };
  return { name, share: Math.round((payment.amount * bp) / 10000), pct: bp / 100 };
}

/** Последствия подтверждения: дата продления и деньги по долям. */
export function payApproveEffects(
  payment: PaymentRow,
  tenants: TenantRow[],
  partners: PartnerRow[],
): { effects: [string, string][]; until: string } {
  const tenant = tenants.find((t) => t.id === payment.tenantId);
  const until = asDate(extendDate(tenant?.paidUntil ?? null, payment.months));
  const s = shareOf(payment, tenants, partners);

  const effects: [string, string][] = [
    ['Заведение', payment.tenantName],
    ['Сумма', money(payment.amount)],
    ['Период', `${payment.months} мес.`],
    ['Продлит доступ до', until],
  ];
  if (s && s.share !== null) {
    effects.push([`Партнёру · ${s.name} (${s.pct}%)`, money(s.share)]);
    effects.push(['Платформе', money(payment.amount - s.share)]);
  } else if (s) {
    effects.push([`Партнёр · ${s.name}`, 'доля по его ставке']);
  } else {
    effects.push(['Партнёра нет', `всё платформе · ${money(payment.amount)}`]);
  }
  effects.push(['Отметил', payment.createdByName]);
  return { effects, until };
}

/** Короткая строка под карточкой очереди: то же, но одной фразой. */
export function payLine(
  payment: PaymentRow,
  tenants: TenantRow[],
  partners: PartnerRow[],
): string {
  const tenant = tenants.find((t) => t.id === payment.tenantId);
  const until = asDate(extendDate(tenant?.paidUntil ?? null, payment.months));
  const s = shareOf(payment, tenants, partners);
  return s && s.share !== null
    ? `продлит до ${until} · партнёру ${money(s.share)}`
    : `продлит до ${until}`;
}
