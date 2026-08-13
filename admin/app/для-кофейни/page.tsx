'use client';
/**
 * Посадочная страница под тип магазина: кофейня при магазине — техкарты,
 * себестоимость чашки, списание молока (в том числе офлайн).
 *
 * Каркас и тексты — в lib/site.tsx (StoreLanding).
 */
import { StoreLanding } from '../../lib/site';

export default function Page() {
  return <StoreLanding type="кофейня" />;
}
