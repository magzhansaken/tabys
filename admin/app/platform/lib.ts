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

/**
 * ПАМЯТЬ ОТВЕТОВ. Раздел, куда вы уже заходили, открывается мгновенно.
 *
 * Причина, ради которой это писалось: при переключении вкладки раздел
 * создавался заново и грузил данные с нуля. Сервер отвечает за 10-20
 * миллисекунд, но пустой экран и ожидание были при КАЖДОМ входе, даже
 * если вы были там минуту назад. Ощущалось как «всё тормозит».
 *
 * Теперь показываем то, что уже знаем, и обновляем в фоне: человек
 * видит цифры сразу, а свежие подъезжают через мгновение.
 *
 * СРОК ЖИЗНИ 30 СЕКУНД. Дольше опасно: платформа про деньги, и
 * показывать оплату как ждущую, когда её уже подтвердили, нельзя.
 */
const cache = new Map<string, { at: number; data: any }>();
const TTL = 30_000;

export const cached = (key: string) => {
  const hit = cache.get(key);
  if (!hit) return null;
  return { data: hit.data, fresh: Date.now() - hit.at < TTL };
};

export const putCache = (key: string, data: any) => cache.set(key, { at: Date.now(), data });

/** После действия, меняющего данные, память сбрасываем целиком.
 *  Подтвердили оплату — устарели и деньги, и клиенты, и сводка. */
export const dropCache = () => cache.clear();

/**
 * Загрузка с памятью: сначала показываем известное, потом обновляем.
 *
 * Возвращает то, что есть сейчас (или null), и обещание со свежим.
 */
export async function loadCached<T>(key: string, path: string): Promise<T> {
  const data = await api<T>(path);
  putCache(key, data);
  return data;
}

/**
 * ВИД КАБИНЕТА ПЛАТФОРМЫ — латунь по тёплому бежевому.
 *
 * Палитра взята из кабинета соседнего проекта: она владельцу
 * понравилась, и повторять её осмысленно — платформа это другое место
 * с другими людьми, и отличаться от кабинета магазина ей полезно.
 * Зашёл — и сразу видно, что ты не в своём магазине, а сверху над ним.
 *
 * Цвета их, код наш: копировать чужую разметку мы уже пробовали, вышло
 * плохо. Здесь берётся только то, что видно глазом.
 */
export const P = {
  bg:        '#f3f5f4',   // бумага
  card:      '#ffffff',
  sunk:      '#faf9f7',   // наведение, вложенные блоки
  line:      '#dfe4e2',
  lineSoft:  '#eceeec',
  lineStrong:'#c8cfcc',

  ink:       '#23282a',   // основной текст
  dim:       '#5f6866',   // подписи
  faint:     '#8b9391',   // прочерки, служебное

  accent:    '#b8761c',   // латунь: действие
  accentDark:'#9c6314',   // наведение
  accentInk: '#fdfbf7',   // текст на латуни
  accentSoft:'#7a4e10',   // латунный текст на светлом

  ok:        '#38624a',   // всё в порядке
  danger:    '#8f3a2c',   // деньги, которых нет

  r:  { sm: 6, md: 10, lg: 16, full: 999 },
  // Заголовки с засечками — их приём, и он делает платформу заметно
  // «другим местом», чем кабинет магазина.
  display: 'Georgia, "Times New Roman", serif',
};
