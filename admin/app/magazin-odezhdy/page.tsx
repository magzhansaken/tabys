'use client';
/**
 * Посадочная страница под тип магазина: одежда — маркировка ИС МПТ (приёмка со
 * сверкой, вывод из оборота при продаже, возврат в оборот).
 *
 * Каркас и тексты — в lib/site.tsx (StoreLanding).
 */
import { StoreLanding } from '../../lib/site';

export default function Page() {
  return <StoreLanding type="одежда" />;
}
