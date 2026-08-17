'use client';
/**
 * Кабинет платформы: обращения к серверу и хранение ключа.
 *
 * Отдельно от кабинета магазина — это другие люди с другим входом.
 * Ключ живёт в браузере под своим именем, чтобы вход в платформу не
 * путался со входом владельца магазина: один человек может держать и
 * то и другое открытым.
 */
const KEY = 'tabys.platform.token';
const USER = 'tabys.platform.user';

export type Me = { id: string; name: string; email: string; role: 'super' | 'partner' };

/** Чтение из браузера — только из обработчиков, не при отрисовке. */
export const readSession = (): { token: string; user: Me } | null => {
  try {
    const t = localStorage.getItem(KEY);
    const u = localStorage.getItem(USER);
    return t && u ? { token: t, user: JSON.parse(u) } : null;
  } catch { return null; }
};

export const saveSession = (token: string, user: Me) => {
  localStorage.setItem(KEY, token);
  localStorage.setItem(USER, JSON.stringify(user));
};

export const clearSession = () => {
  localStorage.removeItem(KEY);
  localStorage.removeItem(USER);
};

/**
 * Один вход к серверу на весь кабинет.
 *
 * Сообщения об ошибке достаём из ответа: сервер отвечает по-человечески
 * («Подтверждает только владелец платформы»), и показать это лучше, чем
 * «Ошибка 403».
 */
export async function api<T = any>(path: string, opts: {
  method?: string; body?: unknown; token?: string;
} = {}): Promise<T> {
  const token = opts.token ?? readSession()?.token;
  const r = await fetch('/api/platform' + path, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* не JSON */ }

  if (!r.ok) {
    // Сессия истекла — чистим ключ, иначе кабинет будет биться в стену
    // на каждом запросе и человек не поймёт, почему ничего не грузится.
    if (r.status === 401) clearSession();
    throw new Error(data?.message || `Ошибка ${r.status}`);
  }
  return data as T;
}

/** Деньги: пробел между тысячами, без копеек — суммы тут крупные. */
export const money = (v: number | null | undefined) =>
  v == null ? '—' : Math.round(v).toLocaleString('ru-RU') + ' ₸';

export const shortDate = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—';

export const fullDate = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleDateString('ru-RU') : '—';

export const dateTime = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

/** «через 5 дн.» / «5 дн. назад» — человеку понятнее, чем дата. */
export const daysWord = (n: number | null | undefined) => {
  if (n == null) return '—';
  const a = Math.abs(n);
  const tail = a % 10 === 1 && a % 100 !== 11 ? 'день'
    : [2, 3, 4].includes(a % 10) && ![12, 13, 14].includes(a % 100) ? 'дня' : 'дней';
  return n < 0 ? `${a} ${tail} назад` : n === 0 ? 'сегодня' : `через ${a} ${tail}`;
};
