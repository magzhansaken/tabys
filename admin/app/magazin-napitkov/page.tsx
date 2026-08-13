'use client';
/**
 * Посадочная страница под тип магазина: разливные напитки — акциз (УКМ),
 * проверка марок, защита от клонов. Наша сильная сторона.
 *
 * Каркас и тексты — в lib/site.tsx (StoreLanding).
 */
import { StoreLanding } from '../../lib/site';

export default function Page() {
  return <StoreLanding type="напитки" />;
}
