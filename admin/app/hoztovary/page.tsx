'use client';
/**
 * Посадочная страница под тип магазина: хозтовары — тысячи позиций, импорт из
 * Excel, накладные из фото, опт и долги.
 *
 * Каркас и тексты — в lib/site.tsx (StoreLanding).
 */
import { StoreLanding } from '../../lib/site';

export default function Page() {
  return <StoreLanding type="хозтовары" />;
}
