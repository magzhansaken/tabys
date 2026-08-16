'use client';
/**
 * Кабинет платформы: свой доступ к серверу и общие мелочи раздела.
 *
 * ПОЧЕМУ НЕ lib/api. Вход у платформы отдельный от кабинета магазина —
 * это другие люди и другой ключ. Общий клиент при 401 пошёл бы обновлять
 * пару токенов магазина по /auth/refresh и выбросил бы человека на вход
 * магазина. Ключ платформы живёт 12 часов и не обновляется: истёк —
 * входим заново, и сказать об этом надо прямо.
 *
 * ХРАНИЛИЩЕ ТОЛЬКО ИЗ ОБРАБОТЧИКОВ И useEffect. Обращение к localStorage
 * во время сборки страницы роняет кабинет — на этом проекте так уже было.
 * Поэтому здесь только функции: ни одного чтения на уровне модуля.
 */
import { C } from '../../lib/ui';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export type Role = 'super' | 'partner';
export type PlatformUser = { id: string; name: string; email: string; role: Role };

const T_KEY = 'platform_token';
const U_KEY = 'platform_user';

export const session = {
  token(): string | null {
    try { return window.localStorage.getItem(T_KEY); } catch { return null; }
  },
  user(): PlatformUser | null {
    try {
      const raw = window.localStorage.getItem(U_KEY);
      return raw ? (JSON.parse(raw) as PlatformUser) : null;
    } catch { return null; }
  },
  save(token: string, user: PlatformUser) {
    try {
      window.localStorage.setItem(T_KEY, token);
      window.localStorage.setItem(U_KEY, JSON.stringify(user));
    } catch { /* хранилище закрыто — сессия проживёт до перезагрузки */ }
  },
  clear() {
    try { window.localStorage.removeItem(T_KEY); window.localStorage.removeItem(U_KEY); } catch {}
  },
};

/** Запрос к платформе. Ключ в заголовке, как обычно. */
export async function papi(path: string, opts: RequestInit = {}) {
  const token = session.token();
  const r = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const data = await r.json().catch(() => null);
  if (r.status === 401) {
    session.clear();
    window.location.href = '/platform/login';
    throw new Error(data?.message ?? 'Сессия платформы истекла — войдите заново');
  }
  if (!r.ok) throw new Error(data?.message ?? 'Ошибка запроса');
  return data;
}

export async function platformLogin(email: string, password: string) {
  const r = await fetch(API + '/platform/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.message ?? 'Не удалось войти');
  session.save(d.token, d.user);
  return d.user as PlatformUser;
}

/** Этапы воронки: значения ровно те, что проверяет база (deal_stage). */
export const STAGES: { value: string; label: string }[] = [
  { value: 'new', label: 'Новый' },
  { value: 'contacted', label: 'Связались' },
  { value: 'demo', label: 'Показали' },
  { value: 'proposal', label: 'Предложение' },
  { value: 'won', label: 'Продан' },
  { value: 'lost', label: 'Отказ' },
];
export const stageLabel = (v?: string | null) =>
  STAGES.find((s) => s.value === v)?.label ?? 'Новый';

/** Способы оплаты: значение уходит на сервер как есть (method). */
export const METHODS: { value: string; label: string }[] = [
  { value: 'kaspi', label: 'Kaspi перевод' },
  { value: 'cash', label: 'Наличные партнёру' },
  { value: 'invoice', label: 'Счёт на компанию' },
];
export const methodLabel = (v?: string | null) =>
  METHODS.find((m) => m.value === v)?.label ?? (v || '—');

export const MONTH_OPTS = [1, 3, 6, 12].map((m) => ({
  value: String(m), label: `${m} ${plural(m, ['месяц', 'месяца', 'месяцев'])}`,
}));

/**
 * Действия журнала. Перевод один на весь раздел — по той же причине, по
 * которой статусы переводит Status: второй перевод рано или поздно
 * разъедется с первым, и журнал начнёт показывать служебные слова.
 */
export const ACTIONS: Record<string, string> = {
  payment_recorded: 'отметил полученную оплату',
  payment_approved: 'подтвердил оплату',
  payment_rejected: 'отклонил оплату',
  partner_created: 'завёл партнёра',
  partner_enabled: 'открыл вход партнёру',
  partner_disabled: 'закрыл вход партнёру',
  partner_assigned: 'назначил партнёра клиенту',
  subscription_expiring: 'предупредил об окончании срока',
};

export function plural(n: number, f: [string, string, string]) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return f[2];
  if (b > 1 && b < 5) return f[1];
  if (b === 1) return f[0];
  return f[2];
}

/**
 * «осталось 5 дней» / «просрочен 7 дней» — с цветом.
 * За неделю до конца звонок ещё уместен, после срока — уже разговор о
 * долге, и выглядеть это должно по-разному.
 */
export function leftText(daysLeft: number | null | undefined) {
  if (daysLeft == null) return { text: 'оплаты ещё не было', color: C.faint };
  const n = Math.abs(daysLeft);
  const word = plural(n, ['день', 'дня', 'дней']);
  if (daysLeft < 0) return { text: `просрочен ${n} ${word}`, color: C.red };
  if (daysLeft === 0) return { text: 'последний день', color: C.red };
  return { text: `осталось ${n} ${word}`, color: daysLeft <= 7 ? C.amber : C.dim };
}

/** Подсветка строки: за неделю — тёплым, после срока — красным. */
export function rowTone(c: any) {
  if (c?.expired) return { background: '#FCF2EF' };
  if (c?.expiringSoon) return { background: '#FBF6EC' };
  return undefined;
}

export const digits = (s: any) => String(s ?? '').replace(/\D/g, '');
export const phoneHref = (p: any) => 'tel:+' + digits(p);
/** +7 701 234 56 78: телефон читают глазами и набирают пальцем. */
export function phoneNice(p: any) {
  const d = digits(p);
  if (d.length < 11) return String(p ?? '');
  return `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9, 11)}`;
}

export const dateOnly = (v: any) =>
  v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
export const dateLong = (v: any) =>
  v ? new Date(v).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

/**
 * ПРЕДПРОСМОТР последствия подтверждения — до какой даты продлится доступ.
 *
 * Правило принадлежит серверу (platform_extend_subscription: от БОЛЬШЕЙ
 * из дат — сегодня или нынешний конец периода), и считает его сервер. Но
 * человек должен знать результат ДО нажатия, а отдельного запроса
 * «посчитай, но не делай» в договоре нет. Поэтому здесь предпросмотр по
 * тому же правилу, помеченный как предпросмотр, а окончательные дату и
 * долю партнёра показываем из ОТВЕТА на подтверждение.
 */
export function extendPreview(paidUntil: any, months: number) {
  const now = new Date();
  const from = paidUntil && new Date(paidUntil) > now ? new Date(paidUntil) : now;
  const d = new Date(from.getTime());
  d.setMonth(d.getMonth() + Math.max(1, Math.floor(months || 1)));
  return d;
}

/**
 * Пароль партнёру придумывает кабинет, а не человек: человек придумает
 * «12345678» и пришлёт в переписке. Три группы по четыре знака —
 * диктуется по телефону без «это латинская или русская».
 * Алфавит без похожих знаков (0/O, 1/l/I): пароль диктуют вслух.
 */
export function newPassword() {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  const n = 12;
  const out: string[] = [];
  const rnd = new Uint32Array(n);
  try { window.crypto.getRandomValues(rnd); }
  catch { for (let i = 0; i < n; i++) rnd[i] = Math.floor(Math.random() * 0xffffffff); }
  for (let i = 0; i < n; i++) out.push(a[rnd[i] % a.length]);
  return `${out.slice(0, 4).join('')}-${out.slice(4, 8).join('')}-${out.slice(8).join('')}`;
}
