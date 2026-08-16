import { z } from 'zod';

/**
 * Деньги — всегда целые тиыны (1 ₸ = 100 тиын). Ни одного float
 * в денежных расчётах: урок каждой кассовой системы.
 */
export const Money = z.number().int();
export type Money = z.infer<typeof Money>;
