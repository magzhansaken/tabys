/*
 * Прайс-лист платформы.
 *
 * Партнёр не должен выдумывать цену на каждой сделке: цены по
 * умолчанию задаёт владелец платформы, партнёр берёт готовое.
 * Отступление возможно, но оно видно и требует решения.
 *
 * Один запрос на всю панель — ключ общий, поэтому форма создания
 * клиента, заявка на устройство и раздел «Цены» берут одно и то же
 * из кэша.
 */
import { useQuery } from '@tanstack/react-query';
import { call } from '../main';

export type PriceBook = {
  base: number; basePro: number;
  pos: number; kds: number; waiter: number; courier: number;
  /** Скидка за длинную оплату, проценты (сервер не примет выше 50). */
  discount3: number; discount6: number; discount12: number;
};

export const EMPTY_PRICES: PriceBook = {
  base: 0, basePro: 0, pos: 0, kds: 0, waiter: 0, courier: 0,
  discount3: 0, discount6: 0, discount12: 0,
};

/** Скидки за срок: процент и число месяцев для примера в тенге. */
export const DISCOUNT_FIELDS: { key: keyof PriceBook; title: string; months: number }[] = [
  { key: 'discount3', title: '3 месяца', months: 3 },
  { key: 'discount6', title: '6 месяцев', months: 6 },
  { key: 'discount12', title: '12 месяцев', months: 12 },
];

/** Поля прайса словами — один порядок в настройках и в подсказках. */
export const PRICE_FIELDS: { key: keyof PriceBook; title: string; hint: string }[] = [
  { key: 'base', title: 'Основа · Базовый', hint: 'месячная плата за заведение' },
  { key: 'basePro', title: 'Основа · Про', hint: 'с калькуляцией и конструктором отчётов' },
  { key: 'pos', title: 'Касса', hint: 'за каждую сверх первой' },
  { key: 'kds', title: 'Экран кухни', hint: 'за экран в месяц' },
  { key: 'waiter', title: 'Телефон официанта', hint: 'за устройство в месяц' },
  { key: 'courier', title: 'Курьер', hint: 'за устройство в месяц' },
];

/** Цена устройства по виду заявки — то же соответствие, что в счёте. */
export const DEVICE_PRICE: Record<string, keyof PriceBook> = {
  POS: 'pos', KDS: 'kds', WAITER: 'waiter', COURIER: 'courier',
};

/** Виды устройств для заявки: ключ лимита и слово для человека. */
export const DEVICES: { kind: string; limitKey: string; title: string }[] = [
  { kind: 'POS', limitKey: 'maxPos', title: 'Касса' },
  { kind: 'KDS', limitKey: 'maxKds', title: 'Экран кухни' },
  { kind: 'WAITER', limitKey: 'maxWaiter', title: 'Телефон официанта' },
  { kind: 'COURIER', limitKey: 'maxCouriers', title: 'Курьер' },
];

/** Какое устройство просят в этой заявке — чтобы подставить цену по прайсу. */
export function deviceOfPayload(payload: Record<string, unknown>): keyof PriceBook | null {
  const hit = DEVICES.find((d) => typeof payload[d.limitKey] === 'number');
  return hit ? DEVICE_PRICE[hit.kind] ?? null : null;
}

export function usePriceBook(token: string) {
  return useQuery({
    queryKey: ['price-book'],
    queryFn: () => call<PriceBook>('/price-book', { token }),
    staleTime: 5 * 60_000,
  });
}
