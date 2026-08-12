/**
 * Клиент API кабинета.
 * Access-токен живёт 15 минут, refresh — 30 дней с ротацией (см. 1.2):
 * при 401 молча обновляем пару и повторяем запрос, чтобы владелец
 * не видел выкидываний из кабинета посреди работы.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export const tokens = {
  get access() { return typeof window === 'undefined' ? null : localStorage.getItem('access'); },
  get refresh() { return typeof window === 'undefined' ? null : localStorage.getItem('refresh'); },
  set(access: string, refresh: string) { localStorage.setItem('access', access); localStorage.setItem('refresh', refresh); },
  clear() { localStorage.removeItem('access'); localStorage.removeItem('refresh'); },
};

async function raw(path: string, opts: RequestInit = {}) {
  return fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

export async function api(path: string, opts: RequestInit = {}) {
  let r = await raw(path, opts);

  if (r.status === 401 && tokens.refresh) {
    const rr = await fetch(API + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: tokens.refresh }),
    });
    if (rr.ok) {
      const d = await rr.json();
      tokens.set(d.access, d.refresh);
      r = await raw(path, opts);
    } else {
      // сюда попадаем при детекте кражи токена — тогда только заново
      tokens.clear();
      if (typeof window !== 'undefined') window.location.href = '/login';
    }
  }

  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.message ?? 'Ошибка запроса');
  return data;
}

export const login = async (phone: string, password: string) => {
  const r = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.message ?? 'Не удалось войти');
  tokens.set(d.access, d.refresh);
  return d;
};


/**
 * Выгрузка Excel (часть 21). Сервер отдаёт {fileName, base64} — тот же
 * контракт, что у шаблона импорта, поэтому один помощник на все кнопки.
 */
export async function downloadXlsx(path: string) {
  const t = await api(path);
  const a = document.createElement('a');
  a.href = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + t.base64;
  a.download = t.fileName;
  a.click();
  return t.rows as number;
}
