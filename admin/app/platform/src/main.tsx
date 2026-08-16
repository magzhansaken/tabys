'use client';
/**
 * Панель платформы «Дастархан».
 *
 * Два человека, два взгляда на один экран:
 *   СУПЕР-АДМИН  — видит всех клиентов, подтверждает оплаты, заводит партнёров.
 *   ПАРТНЁР      — ведёт своих клиентов: заводит, настраивает, доводит до запуска,
 *                  отмечает оплату — но включает её не он.
 *
 * Срез 1 — каркас. Что изменилось и почему:
 *   · один словарь статусов (ui/status.ts) — PENDING_APPROVAL больше не роняет
 *     вкладку клиентов: раньше STATUS[r.status]! возвращал undefined ровно у той
 *     строки, где рисуются «Одобрить / Отклонить»;
 *   · ни одного системного окошка браузера — вместо них лист подтверждения
 *     с показанным последствием (ui/ConfirmSheet.tsx);
 *   · у каждой мутации есть ответ: тост «сделано» или «не вышло» (ui/Toast.tsx);
 *   · скелетоны и пустые состояния вместо «Загружаем…» (ui/States.tsx);
 *   · оболочка со счётчиками и мобильной панелью (ui/Shell.tsx).
 *
 * Адреса запросов, их тела, условия isSuper и денежная арифметика
 * (тиыны /100, commissionBp /100) не тронуты.
 */
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateTenantResponse, PartnerRow, PaymentRow, PlatformSession,
  TenantList, TenantRequestRow, TenantRow,
} from './contracts';
import './admin.css';

import { Funnel } from './Funnel';
import { Summary } from './Summary';
import { PlanDialog } from './PlanDialog';
import { TenantCard } from './TenantCard';
import { Today, buildQueue } from './Today';
import { Journal } from './Journal';

import { Shell } from './ui/Shell';
import type { Counts, TabKey } from './ui/Shell';
import { statusView, STATUS_FILTERS, STATUS_FILTERS_PARTNER } from './ui/status';
import { ToastHost, useToast } from './ui/Toast';
import { AskHost, useAsk } from './ui/ConfirmSheet';
import { Empty, Failed, PageHead, SkeletonCards, SkeletonMetrics, SkeletonTable } from './ui/States';
import { payApproveEffects, payLine } from './ui/money';
import { RowMenu } from './ui/RowMenu';
import { BulkPanel } from './ui/BulkPanel';
import { useAssign } from './ui/useAssign';
import { InlineText } from './ui/InlineText';
import { humanError } from './ui/errors';
import { PriceChoice } from './ui/PriceChoice';
import { DEVICE_PRICE, DEVICES, DISCOUNT_FIELDS, PRICE_FIELDS, deviceOfPayload, usePriceBook } from './ui/prices';
import type { PriceBook } from './ui/prices';

const API = '/api';   // наш сервер живёт здесь
const LS_TOKEN = 'tabys.platform.token';
const LS_USER = 'tabys.platform.user';

export const money = (v: number) => `${Math.round(v / 100).toLocaleString('ru-RU')} ₸`;
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString('ru-RU') : '—');

/**
 * ПЕРЕХОДНИК К НАШЕМУ СЕРВЕРУ.
 *
 * Кабинет перенесён из проекта автоматизации ресторанов целиком — вид,
 * разметка и поведение остались их. Отличается только это место: их
 * пути переводятся в наши.
 *
 * Всё в одной таблице, а не размазано по экранам: когда сервер
 * изменится, править надо здесь и только здесь. Иначе через месяц
 * никто не вспомнит, где ещё живёт старый адрес.
 */
const ROUTE: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^\/login$/,                 () => '/platform/login'],
  [/^\/tenants$/,               () => '/platform/clients'],
  [/^\/tenants\?(.*)$/,         (m) => `/platform/clients?${m[1]}`],
  [/^\/partners$/,              () => '/platform/partners'],
  [/^\/payments\?pending=1$/,   () => '/platform/payments?status=pending'],
  [/^\/payments$/,              () => '/platform/payments'],
  [/^\/requests\?pending=1$/,   () => '/platform/requests?status=pending'],
  [/^\/requests$/,              () => '/platform/requests'],
  [/^\/price-book$/,            () => '/platform/price-book'],
  [/^\/pay-settings$/,          () => '/platform/price-book'],
  [/^\/leads$/,                 () => '/platform/clients'],
  [/^\/assign$/,                () => '/platform/assign'],
  [/^\/bulk\/preview$/,         () => '/platform/bulk/preview'],
  [/^\/bulk\/apply$/,           () => '/platform/bulk/apply'],
  [/^\/tenant\/device\/add$/,   () => '/platform/device/add'],
  [/^\/tenant\/reset-password$/,() => '/platform/reset-owner-password'],
  [/^\/tenant\/delete$/,        () => '/platform/tenant/delete'],
];

const toOurs = (path: string) => {
  for (const [re, fn] of ROUTE) {
    const m = path.match(re);
    if (m) return fn(m);
  }
  // Неизвестный путь не глотаем молча: пусть видно будет сразу, а не
  // когда кто-то нажмёт кнопку у клиента.
  console.warn('[платформа] неизвестный путь:', path);
  return '/platform' + path;
};

/**
 * Приведение ответа к тому виду, которого ждёт перенесённый кабинет.
 *
 * Он писался под свой сервер и называет поля по-своему: fullName вместо
 * name, роли заглавными (SUPER/PARTNER) вместо строчных. Меняем здесь,
 * а не в кабинете: тогда его 5562 строки остаются нетронутыми, и
 * следующее обновление от них ляжет без правок.
 *
 * Поймано на живом входе: кабинет падал на попытке взять инициалы из
 * имени, потому что имени в ответе не было под тем названием.
 */
const toTheirs = (path: string, data: any): any => {
  if (!data || typeof data !== 'object') return data;

  // Вход: имя и роль.
  if (path === '/login' && data.user) {
    return { ...data, user: {
      ...data.user,
      fullName: data.user.fullName ?? data.user.name ?? data.user.email ?? 'Пользователь',
      role: String(data.user.role ?? 'partner').toUpperCase(),
    } };
  }

  // Списки: имя партнёра и роль встречаются и там.
  const fix = (x: any) => (x && typeof x === 'object')
    ? { ...x,
        fullName: x.fullName ?? x.name ?? undefined,
        role: x.role ? String(x.role).toUpperCase() : undefined,
        status: x.status ? String(x.status).toUpperCase() : undefined }
    : x;

  if (Array.isArray(data)) return data.map(fix);
  if (Array.isArray(data.items)) return { ...data, items: data.items.map(fix) };
  return data;
};

export async function call<T>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(`${API}${toOurs(path)}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    // Наш сервер отвечает разбором в JSON — достаём из него человеческое
    // сообщение, иначе кассиру покажется кусок разметки.
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).message ?? msg; } catch { /* оставляем как есть */ }
    throw new Error(msg || `Ошибка ${res.status}`);
  }
  return toTheirs(path, await res.json()) as T;
}

// ─────────────────────────────────────────── вход

function Login({ onIn }: { onIn: (s: PlatformSession) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      onIn(await call<PlatformSession>('/login', { method: 'POST', body: { email, password } }));
    } catch {
      setErr('Не подошли почта или пароль');
    } finally { setBusy(false); }
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Панель платформы</h1>
        <p className="hint">Управление клиентами и оплатами</p>
        <input placeholder="Почта" value={email} autoComplete="username"
          onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="Пароль" type="password" value={password} autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {err && <p className="err">{err}</p>}
        <button className="btn primary" disabled={busy || !email || !password} onClick={submit}>
          {busy ? 'Проверяем…' : 'Войти'}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────── создание клиента

function NewTenant({ token, isSuper, onDone }: { token: string; isSuper: boolean; onDone: () => void }) {
  const toast = useToast();
  const prices = usePriceBook(token);
  const [f, setF] = useState({
    name: '', ownerName: '', ownerPhone: '', ownerEmail: '', city: '',
    planName: 'Базовый', planPrice: 25000, locationName: 'Главная',
    withDemo: true,
    vertical: 'CAFE' as const,
  });
  const [res, setRes] = useState<CreateTenantResponse | null>(null);
  const [err, setErr] = useState('');

  const m = useMutation({
    mutationFn: () => call<CreateTenantResponse>('/tenants', {
      method: 'POST', token,
      body: { ...f, planPrice: Math.round(f.planPrice * 100) },
    }),
    onSuccess: (r) => { setRes(r); toast({ text: 'Клиент создан, доступы выданы' }); },
    onError: (e: Error) => { setErr(e.message); toast({ text: humanError(e), kind: 'err' }); },
  });

  if (res) {
    return (
      <div className="modal">
        <div className="modal-card wide">
          <div className="sheet-head">
            <h2>Клиент создан</h2>
            <button className="btn small ghost sheet-x" aria-label="Закрыть" onClick={onDone}>×</button>
          </div>
          <p className="hint">
            Эти данные показываются один раз — сохраните и передайте владельцу.
          </p>
          <div className="creds">
            <CredLine label="Вход в офис" value={res.ownerEmail} />
            <CredLine label="Пароль" value={res.ownerPassword} />
            <CredLine label="Код активации кассы" value={res.activationCode} />
            <CredLine label="PIN кассира" value="1234" />
            <CredLine label="Ссылка витрины" value={res.menuUrl} />
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={() => {
              void navigator.clipboard?.writeText(
                `Офис: ${res.ownerEmail} / ${res.ownerPassword}\n`
                + `Касса: код ${res.activationCode}, PIN 1234\nВитрина: ${res.menuUrl}`,
              );
              toast({ text: 'Доступы скопированы' });
            }}>Скопировать всё</button>
            <button className="btn primary" onClick={onDone}>Готово</button>
          </div>
        </div>
      </div>
    );
  }

  const ready = f.name.length > 1 && f.ownerName.length > 1
    && f.ownerPhone.length > 9 && /.+@.+\..+/.test(f.ownerEmail);

  const listPrice = f.planName === 'Про'
    ? prices.data?.basePro ?? null
    : prices.data?.base ?? null;

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <div className="modal-card">
        <div className="sheet-head">
          <h2>Новый клиент</h2>
          <button className="btn small ghost sheet-x" aria-label="Закрыть" onClick={onDone}>×</button>
        </div>
        <label>Название заведения
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label>Тип
          <select value={f.vertical} onChange={(e) => setF({ ...f, vertical: e.target.value as 'CAFE' })}>
            <option value="CAFE">Кафе / ресторан</option>
            <option value="FASTFOOD">Фастфуд</option>
            <option value="SHOP">Магазин</option>
            <option value="SALON">Салон</option>
            <option value="BILLIARD">Бильярд</option>
          </select>
        </label>
        <label>Имя владельца
          <input value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} />
        </label>
        <label>Телефон владельца
          <input value={f.ownerPhone} placeholder="+7 701 123-45-67"
            onChange={(e) => setF({ ...f, ownerPhone: e.target.value })} />
        </label>
        <label>Почта владельца (это будет логин)
          <input value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} />
        </label>
        <label>Город
          <input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        </label>
        <div className="row2">
          <label>Тариф
            <select value={f.planName} onChange={(e) => {
              const planName = e.target.value;
              const list = planName === 'Про' ? prices.data?.basePro : prices.data?.base;
              setF({ ...f, planName, ...(list ? { planPrice: Math.round(list / 100) } : {}) });
            }}>
              <option value="Базовый">Базовый</option>
              <option value="Про">Про</option>
            </select>
          </label>
          <div />
        </div>

        <PriceChoice
          label="Цена в месяц"
          listPrice={listPrice}
          value={f.planPrice * 100}
          onChange={(tiyn) => setF({ ...f, planPrice: Math.round(tiyn / 100) })}
          note={isSuper
            ? 'Вы ставите цену сами — она применится сразу.'
            : 'Цена отличается от прайса — владелец платформы увидит это в карточке клиента.'}
        />
        <label className="check">
          <input type="checkbox" checked={f.withDemo}
            onChange={(e) => setF({ ...f, withDemo: e.target.checked })} />
          Наполнить учебными данными
        </label>
        <p className="hint">
          Меню из двенадцати блюд, сырьё с ценами, столы на схеме зала.
          Показывать клиенту есть что сразу, а владелец удалит их
          за минуту, когда заведёт своё.
        </p>

        {err && <p className="err">{err}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onDone}>Отмена</button>
          <button className="btn primary" disabled={!ready || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? 'Создаём…' : 'Создать и выдать доступы'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────── отметка оплаты

type PayTarget = { id?: string; name?: string; planPrice?: number };
type AskTarget = { id?: string; name?: string; planName?: string; planPrice?: number };

function PayForm({ token, tenant, onDone }: { token: string; tenant: PayTarget; onDone: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(Math.round(tenant.planPrice / 100));
  const [months, setMonths] = useState(1);
  const [method, setMethod] = useState('Kaspi');
  const [comment, setComment] = useState('');

  const m = useMutation({
    mutationFn: () => call('/payments', {
      method: 'POST', token,
      body: { tenantId: tenant.id, amount: amount * 100, months, method, comment },
    }),
    onSuccess: () => { toast({ text: 'Оплата отмечена, ждёт подтверждения платформы' }); onDone(); },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <div className="modal-card">
        <div className="sheet-head">
          <h2>Оплата · {tenant.name}</h2>
          <button className="btn small ghost sheet-x" aria-label="Закрыть" onClick={onDone}>×</button>
        </div>
        <p className="hint">
          Отметьте полученные деньги. Доступ продлит супер-админ после проверки.
        </p>
        <div className="row2">
          <label>Сумма, ₸
            <input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
          </label>
          <label>Месяцев
            <input type="number" min={1} max={24} value={months}
              onChange={(e) => setMonths(Number(e.target.value))} />
          </label>
        </div>
        <label>Как получены
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option>Kaspi</option><option>Наличные</option>
            <option>Перевод на счёт</option><option>Halyk</option>
          </select>
        </label>
        <label>Комментарий
          <input value={comment} placeholder="номер платежа, кто передал…"
            onChange={(e) => setComment(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={onDone}>Отмена</button>
          <button className="btn primary" disabled={m.isPending || amount <= 0} onClick={() => m.mutate()}>
            Отправить на подтверждение
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────── клиенты

/** Адрес страницы клиента: карточку можно оставить открытой и вернуться к ней. */
const goClient = (id: string) => { window.location.hash = `#/client/${id}`; };
const goList = () => { window.location.hash = ''; };
const clientFromHash = (): string | null => {
  const m = window.location.hash.match(/^#\/client\/(.+)$/);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
};

type SortKey = 'due' | 'price' | 'name' | 'revenue';

/*
 * Свежее решение по заявке — меткой там, где партнёр ведёт клиента.
 *
 * Раньше решение было видно только во вкладке «Заявки»: человек подавал
 * просьбу и не знал, чем кончилось. Метка живёт неделю — этого хватает,
 * чтобы заметить, и список не превращается в архив.
 */
export function requestMark(r: { kind?: string; payload?: Record<string | number | symbol, unknown>;
  status?: string; decision?: string | null; decidedAt?: string | null }): {
  text: string; tone: 'wait' | 'ok' | 'bad';
} | null {
  const what = describeRequest(r.kind, r.payload).toLowerCase();
  if (r.status === 'PENDING') return { text: `${what} — ждёт решения`, tone: 'wait' };
  if (!r.decidedAt) return null;
  if (Date.now() - new Date(r.decidedAt).getTime() > 7 * 86_400_000) return null;
  if (r.status === 'APPROVED') return { text: `${what} — одобрено`, tone: 'ok' };
  return { text: r.decision ? `отказано: ${r.decision}` : `${what} — отказано`, tone: 'bad' };
}

function Tenants({ token, isSuper }: { token: string; isSuper: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useAsk();
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<TenantRow | null>(null);
  const [asking, setAsking] = useState<TenantRow | null>(null);
  const [planFor, setPlanFor] = useState<TenantRow | null>(null);
  const [demo, setDemo] = useState<{ ownerEmail?: string; password?: string; activationCode?: string } | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [partner, setPartner] = useState('all');
  const [sort, setSort] = useState<SortKey>('due');
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [onlySel, setOnlySel] = useState(false);
  const { assign } = useAssign(token, isSuper);

  /* Свежие заявки клиента — тот же ключ, что у вкладки «Заявки»,
     поэтому лишнего обращения нет. */
  const reqs = useQuery({
    queryKey: ['requests', false],
    queryFn: () => call<TenantRequestRow[]>('/requests', { token }),
  });
  const markFor = (tenantId: string) => {
    const mine = (reqs.data ?? []).filter((x) => x.tenantId === tenantId);
    for (const r of mine) {
      const m = requestMark(r);
      if (m) return m;
    }
    return null;
  };

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => call<TenantList>('/tenants', { token }),
    refetchInterval: 30_000,
  });

  const status = useMutation({
    mutationFn: (v: { tenantId: string; status: 'ACTIVE' | 'SUSPENDED' }) =>
      call('/tenants/status', { method: 'POST', token, body: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenants'] }),
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const byFilter = filter === 'all' ? all : all.filter((r) => r.status === filter);
    const byPartner = partner === 'all'
      ? byFilter
      : byFilter.filter((r) => (r.partnerName ?? '—') === partner);
    const byPick = onlySel ? byPartner.filter((r) => sel[r.id]) : byPartner;
    const needle = q.trim().toLowerCase();
    const found = needle
      ? byPick.filter((r) =>
        r.name.toLowerCase().includes(needle)
        || (r.ownerName ?? '').toLowerCase().includes(needle)
        || (r.ownerPhone ?? '').includes(needle)
        || (r.city ?? '').toLowerCase().includes(needle)
        || (r.partnerName ?? '').toLowerCase().includes(needle))
      : byPick;
    const sorted = [...found];
    sorted.sort((a, b) => {
      if (sort === 'price') return b.planPrice - a.planPrice;
      if (sort === 'revenue') return b.revenue30 - a.revenue30;
      if (sort === 'name') return a.name.localeCompare(b.name, 'ru');
      /* По сроку: сначала просроченные (дни в минусе), потом кому платить
         раньше, а те, у кого срок не начат, — в конце списка. */
      const ka = a.daysLeft ?? Number.POSITIVE_INFINITY;
      const kb = b.daysLeft ?? Number.POSITIVE_INFINITY;
      if (ka !== kb) return ka - kb;
      return a.name.localeCompare(b.name, 'ru');
    });
    return sorted;
  }, [data, filter, partner, q, sort, sel, onlySel]);

  /* Отмеченные живут поверх фильтров: смена вкладки или поиска
     не сбрасывает выбор, и счётчик всё время на экране. */
  const selectedRows = useMemo(
    () => (data?.rows ?? []).filter((r) => sel[r.id]),
    [data, sel],
  );
  const allPicked = rows.length > 0 && rows.every((r) => sel[r.id]);
  const pickAll = () => setSel((s) => {
    const next = { ...s };
    rows.forEach((r) => { next[r.id] = !allPicked; });
    return next;
  });
  const clearSel = () => { setSel({}); setOnlySel(false); };

  /* Партнёры берём из самого списка: отдельный запрос не нужен,
     а имена совпадают с тем, что видно в колонке. */
  const partnerNames = useMemo(() => {
    const set = new Set<string>();
    (data?.rows ?? []).forEach((r) => set.add(r.partnerName ?? '—'));
    return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
  }, [data]);

  /* Сколько приносит выбранный партнёр — по всем его клиентам,
     независимо от статуса-фильтра и поиска. */
  const partnerSum = useMemo(() => {
    if (partner === 'all') return null;
    const mine = (data?.rows ?? []).filter((r) => (r.partnerName ?? '—') === partner);
    const paying = mine.filter((r) => r.status === 'ACTIVE' || r.status === 'PENDING_PAYMENT');
    return {
      clients: mine.length,
      paying: paying.length,
      expired: mine.filter((r) => r.status === 'EXPIRED').length,
      mrr: paying.reduce((a, r) => a + r.planPrice, 0),
    };
  }, [data, partner]);

  /* Регистрация: пробный период спрашиваем полем в листе, а не prompt(). */
  const approveSignup = async (r: TenantRow) => {
    const answer = await ask({
      title: `Одобрить регистрацию · ${r.name}`,
      sub: 'Заведение получит доступ и пробный период. Деньги пока не считаются.',
      effects: [
        ['Заведение', r.name],
        ['Владелец', r.ownerName ?? '—'],
        ['Тариф после пробного', `${money(r.planPrice)}/мес`],
      ],
      value: { label: 'Пробный период, дней', initial: '7' },
      confirmLabel: 'Одобрить и открыть доступ',
    });
    if (!answer) return;
    try {
      await call('/signups/approve', {
        method: 'POST', token,
        body: { tenantId: r.id, trialDays: Number(answer.value) || 7 },
      });
      await qc.invalidateQueries({ queryKey: ['tenants'] });
      toast({ text: `«${r.name}» одобрен, пробный период открыт` });
    } catch (e) {
      toast({ text: humanError(e), kind: 'err' });
    }
  };

  const rejectSignup = async (r: TenantRow) => {
    const answer = await ask({
      title: `Отклонить регистрацию · ${r.name}`,
      sub: 'Заявка закроется. Причину увидит владелец заведения.',
      effects: [['Заведение', r.name], ['Владелец', r.ownerName ?? '—']],
      reason: { label: 'Причина отказа', placeholder: 'Нет связи третий день…', required: false },
      danger: true,
      confirmLabel: 'Отклонить',
    });
    if (!answer) return;
    try {
      await call('/signups/reject', { method: 'POST', token, body: { tenantId: r.id, reason: answer.reason } });
      await qc.invalidateQueries({ queryKey: ['tenants'] });
      toast({ text: 'Регистрация отклонена' });
    } catch (e) {
      toast({ text: humanError(e), kind: 'err' });
    }
  };

  /* Учебное заведение: доступы показываем как у настоящего клиента —
     моно и с копированием по одному, а не в системном alert. */
  const createDemo = async () => {
    const answer = await ask({
      title: 'Создать учебное заведение',
      sub: 'Показывать систему на боевом клиенте неловко и небезопасно — пусть у каждого будет своё.',
      effects: [['В деньгах платформы', 'не участвует'], ['Срок жизни', 'месяц']],
      confirmLabel: 'Создать демо',
    });
    if (!answer) return;
    try {
      const r = await call<{ ownerEmail?: string; password?: string; activationCode?: string }>(
        '/demo', { method: 'POST', token });
      setDemo(r);
      await qc.invalidateQueries({ queryKey: ['tenants'] });
      toast({ text: 'Демо готово' });
    } catch (e) {
      toast({ text: humanError(e), kind: 'err' });
    }
  };

  const filters = isSuper ? STATUS_FILTERS : STATUS_FILTERS_PARTNER;
  const dirty = q.trim() !== '' || filter !== 'all' || partner !== 'all' || onlySel;
  /* Клиенты с сайта приходят ничьими — это входящий поток, а не пустое поле. */
  const nobodyCount = (data?.rows ?? []).filter((r) => !r.partnerName).length;

  /* Отключение — остановка работы заведения, а не галочка в таблице. */
  const toggleActive = async (r: TenantRow) => {
    const off = r.status !== 'SUSPENDED';
    const answer = await ask({
      title: off ? `Отключить «${r.name}»` : `Включить «${r.name}»`,
      sub: off
        ? 'Кассы и экраны кухни перестанут работать сразу после подтверждения.'
        : 'Заведение снова начнёт работать на прежних условиях.',
      effects: [
        ['Заведение', r.name],
        ['Счёт в месяц', `${money(r.planPrice)}`],
        ['Оплачено до', date(r.paidUntil)],
      ],
      danger: off,
      confirmLabel: off ? 'Отключить' : 'Включить',
    });
    if (!answer) return;
    status.mutate(
      { tenantId: r.id, status: off ? 'SUSPENDED' : 'ACTIVE' },
      { onSuccess: () => toast({ text: off ? `«${r.name}» отключён` : `«${r.name}» включён` }) },
    );
  };

  return (
    <>
      <PageHead
        title={isSuper ? 'Клиенты' : 'Мои клиенты'}
        sub={isSuper
          ? 'Все заведения платформы: статус, срок оплаты и кто ведёт.'
          : 'Заведения, которые ведёте вы. Деньги подтверждает платформа.'}
        actions={
          <>
            <button className="btn" onClick={createDemo}>Учебное заведение</button>
            <button className="btn primary" onClick={() => setCreating(true)}>+ Новый клиент</button>
          </>
        }
      />

      {isPending && (
        <>
          <SkeletonMetrics count={5} />
          <SkeletonTable rows={6} cols={6} />
        </>
      )}

      {isError && <Failed text={humanError(error)} onRetry={() => void refetch()} />}

      {data && (
        <>
          <div className="cards">
            <div className="card"><span>Всего</span><b>{data.totals.all}</b></div>
            <div className="card ok"><span>Работают</span><b>{data.totals.active}</b></div>
            <div className="card warn"><span>Ждут подтверждения</span><b>{data.totals.pending}</b></div>
            <div className="card bad"><span>Срок вышел</span><b>{data.totals.expired}</b></div>
            <div className="card money"><span>Доход в месяц</span><b>{money(data.totals.mrr)}</b></div>
          </div>

          <div className="toolbar">
            <input className="search" placeholder="Поиск: заведение, владелец, телефон, город, партнёр"
              value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="sorter" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="due">Сначала просроченные</option>
              <option value="price">Сначала дорогие</option>
              <option value="revenue">По выручке заведения</option>
              <option value="name">По названию</option>
            </select>
            {isSuper && partnerNames.length > 1 && (
              <select className="sorter" value={partner} onChange={(e) => setPartner(e.target.value)}>
                <option value="all">Все партнёры</option>
                {partnerNames.map((p) => (
                  <option key={p} value={p}>{p === '—' ? 'Без партнёра' : p}</option>
                ))}
              </select>
            )}
          </div>

          {partnerSum && (
            <div className="partner-strip">
              <b>{partner === '—' ? 'Без партнёра' : partner}</b>
              <span>клиентов <i>{partnerSum.clients}</i></span>
              <span>платят <i>{partnerSum.paying}</i></span>
              <span>просрочены <i>{partnerSum.expired}</i></span>
              <span className="strip-money">приносит в месяц <i>{money(partnerSum.mrr)}</i></span>
              <button className="btn small ghost" onClick={() => setPartner('all')}>Сбросить</button>
            </div>
          )}

          <div className="chips">
            {filters.map((f) => (
              <button key={f.value} className={`chip ${filter === f.value ? 'on' : ''}`}
                onClick={() => setFilter(f.value)}>{f.label}</button>
            ))}
            {isSuper && nobodyCount > 0 && (
              <button
                className={`chip ${partner === '—' ? 'on' : ''}`}
                onClick={() => setPartner(partner === '—' ? 'all' : '—')}
              >
                Ничьи · {nobodyCount}
              </button>
            )}
          </div>

          {isSuper && selectedRows.length > 0 && (
            <BulkPanel
              token={token}
              rows={data.rows}
              selected={selectedRows}
              onClear={clearSel}
              onShowSelected={() => setOnlySel(true)}
            />
          )}

          <table className="grid tenants">
            <thead>
              <tr>
                {isSuper && (
                  <th className="pick">
                    <input type="checkbox" aria-label="Отметить все видимые"
                      checked={allPicked} onChange={pickAll} />
                  </th>
                )}
                <th>Заведение</th><th>Владелец</th><th>Статус</th>
                <th>Оплачено до</th><th>Тариф</th><th className="num">Выручка 30 дн.</th>
                {isSuper && <th>Партнёр</th>}<th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = statusView(r.status);
                const soon = r.daysLeft !== null && r.daysLeft <= 7 && r.daysLeft >= 0;
                return (
                  <tr key={r.id} className={sel[r.id] ? 'picked' : ''}>
                    {isSuper && (
                      <td className="pick">
                        <input type="checkbox" aria-label={`Отметить ${r.name}`}
                          checked={!!sel[r.id]}
                          onChange={() => setSel((s) => ({ ...s, [r.id]: !s[r.id] }))} />
                      </td>
                    )}
                    <td data-label="Заведение">
                      <button className="link-name" onClick={() => goClient(r.id)}>{r.name}</button>
                      <div className="sub">{r.city ?? ''} {r.locations > 1 ? `· точек ${r.locations}` : ''}</div>
                      {(() => {
                        const m = markFor(r.id);
                        return m ? <div className={`req-mark ${m.tone}`}>{m.text}</div> : null;
                      })()}
                    </td>
                    <td data-label="Владелец">
                      {r.ownerName ?? '—'}
                      <div className="sub">{r.ownerPhone ?? ''}</div>
                    </td>
                    <td data-label="Статус">
                      <span className={`badge ${s.cls}`}>{s.text}</span>
                      {r.pendingPayments > 0 && <span className="badge st-pending">оплат: {r.pendingPayments}</span>}
                    </td>
                    <td data-label="Оплачено до" className={soon ? 'soon' : ''}>
                      {date(r.paidUntil)}
                      {r.daysLeft !== null && (
                        <div className="sub">{r.daysLeft >= 0 ? `осталось ${r.daysLeft} дн.` : `просрочка ${-r.daysLeft} дн.`}</div>
                      )}
                    </td>
                    <td data-label="Тариф">{r.planName}<div className="sub">{money(r.planPrice)}/мес</div></td>
                    <td data-label="Выручка 30 дн.">{money(r.revenue30)}</td>
                    {isSuper && (
                      <td data-label="Партнёр">
                        {r.partnerName ?? <span className="nobody">без партнёра</span>}
                      </td>
                    )}
                    <td className="actions">
                      {r.status === 'PENDING_APPROVAL' ? (
                        <>
                          <button className="btn small accent" onClick={() => void approveSignup(r)}>Одобрить</button>
                          <button className="btn small danger" onClick={() => void rejectSignup(r)}>Отклонить</button>
                          <button className="btn small ghost" onClick={() => goClient(r.id)}>Карточка</button>
                        </>
                      ) : (
                        <>
                          <button className="btn small" onClick={() => setPaying(r)}>Оплата</button>
                          <button className="btn small" onClick={() => goClient(r.id)}>Карточка</button>
                          <RowMenu
                            actions={[
                              { label: 'Состав тарифа', onClick: () => setPlanFor(r) },
                              ...(!isSuper
                                ? [{ label: 'Запросить у платформы', onClick: () => setAsking(r) }]
                                : []),
                              ...(isSuper
                                ? [{
                                  label: r.partnerName ? 'Передать другому партнёру…' : 'Назначить партнёра…',
                                  onClick: () => void assign({ id: r.id, name: r.name, partnerName: r.partnerName }),
                                }]
                                : []),
                              ...(isSuper
                                ? [{
                                  label: r.status === 'SUSPENDED' ? 'Включить заведение' : 'Отключить заведение',
                                  danger: r.status !== 'SUSPENDED',
                                  onClick: () => void toggleActive(r),
                                }]
                                : []),
                            ]}
                          />
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {rows.length === 0 && (
            dirty
              ? <Empty
                title="Никого не нашли"
                text="По этому запросу и фильтру пусто. Снимите фильтр или измените поиск."
                actionLabel="Сбросить фильтры"
                onAction={() => { setQ(''); setFilter('all'); setPartner('all'); setOnlySel(false); }}
              />
              : <Empty
                title="Клиентов пока нет"
                text="Заведите первого — доступы к кассе и офису выдадутся сразу."
                actionLabel="Новый клиент"
                onAction={() => setCreating(true)}
              />
          )}

          {rows.length > 0 && (
            <p className="table-foot">Показано {rows.length} из {data.rows.length}</p>
          )}
        </>
      )}

      {creating && <NewTenant token={token} isSuper={isSuper} onDone={() => {
        setCreating(false); void qc.invalidateQueries({ queryKey: ['tenants'] });
      }} />}
      {planFor && (
        <PlanDialog token={token} tenantId={planFor.id} tenantName={planFor.name}
          isSuper={isSuper} onClose={() => setPlanFor(null)}
          onOpenCard={() => { const id = planFor.id; setPlanFor(null); goClient(id); }} />
      )}
      {paying && <PayForm token={token} tenant={paying} onDone={() => {
        setPaying(null); void qc.invalidateQueries({ queryKey: ['tenants'] });
      }} />}
      {asking && <AskForm token={token} tenant={asking} onDone={() => {
        setAsking(null); void qc.invalidateQueries({ queryKey: ['requests'] });
      }} />}
      {demo && (
        <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && setDemo(null)}>
          <div className="modal-card wide">
            <div className="sheet-head">
              <h2>Учебное заведение готово</h2>
              <button className="btn small ghost sheet-x" aria-label="Закрыть" onClick={() => setDemo(null)}>×</button>
            </div>
            <p className="hint">Данные показываются один раз — скопируйте нужное поле.</p>
            <div className="creds">
              <CredLine label="Почта" value={demo.ownerEmail ?? '—'} />
              <CredLine label="Пароль" value={demo.password ?? '—'} />
              <CredLine label="Код кассы" value={demo.activationCode ?? '—'} />
            </div>
            <div className="modal-actions">
              <button className="btn primary" onClick={() => setDemo(null)}>Готово</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────── оплаты

function Payments({ token, isSuper }: { token: string; isSuper: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useAsk();
  const [onlyPending, setOnlyPending] = useState(true);
  const [leaving, setLeaving] = useState<Record<string, boolean>>({});
  const [gone, setGone] = useState<string[]>([]);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['payments', onlyPending],
    queryFn: () => call<PaymentRow[]>(`/payments${onlyPending ? '?pending=1' : ''}`, { token }),
    refetchInterval: 20_000,
  });

  /* Срок клиента и ставка партнёра нужны, чтобы показать последствие
     до нажатия. Ключи и адреса те же, что у вкладок «Клиенты» и
     «Партнёры», — кэш общий, лишних обращений нет. */
  const tenants = useQuery({
    queryKey: ['tenants'],
    queryFn: () => call<TenantList>('/tenants', { token }),
  });
  const partners = useQuery({
    queryKey: ['partners'],
    queryFn: () => call<PartnerRow[]>('/partners', { token }),
    enabled: isSuper,
  });

  const act = useMutation({
    mutationFn: (v: { paymentId: string; reject?: string }) =>
      call('/payments/approve', { method: 'POST', token, body: v }),
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  /* Решённая строка уходит из очереди сама: сначала свернулась, потом
     список перечитался. Иначе она висит до перезагрузки и её решают дважды. */
  const dismiss = (id: string) => {
    setLeaving((s) => ({ ...s, [id]: true }));
    window.setTimeout(() => {
      setGone((g) => [...g, id]);
      setLeaving((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
      void qc.invalidateQueries({ queryKey: ['payments'] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
    }, 280);
  };

  const approve = async (p: PaymentRow) => {
    const { effects, until } = payApproveEffects(p, tenants.data?.rows ?? [], partners.data ?? []);
    const answer = await ask({
      title: 'Подтвердить оплату',
      sub: 'Действие продлевает доступ клиента и начисляет долю партнёру. Отменить одним движением нельзя.',
      effects,
      confirmLabel: 'Подтвердить и продлить',
    });
    if (!answer) return;
    act.mutate({ paymentId: p.id }, {
      onSuccess: () => {
        toast({ text: `${money(p.amount)} подтверждены · доступ до ${until}` });
        dismiss(p.id);
      },
    });
  };

  const reject = async (p: PaymentRow) => {
    const answer = await ask({
      title: 'Отклонить оплату',
      sub: 'Партнёр увидит причину и сможет отметить платёж заново.',
      effects: [['Заведение', p.tenantName], ['Сумма', money(p.amount)], ['Отметил', p.createdByName]],
      reason: {
        label: 'Причина отказа — её увидит партнёр',
        placeholder: 'Деньги не дошли, сумма чека не совпала…',
        required: true,
      },
      danger: true,
      confirmLabel: 'Отклонить',
    });
    if (!answer) return;
    act.mutate({ paymentId: p.id, reject: answer.reason }, {
      onSuccess: () => {
        toast({ text: 'Оплата отклонена, партнёр уведомлён' });
        dismiss(p.id);
      },
    });
  };

  const rows = (data ?? []).filter((p) => !gone.includes(p.id));

  return (
    <>
      <PageHead
        title={isSuper ? 'Деньги' : 'Оплаты моих клиентов'}
        sub={isSuper
          ? 'Очередь платежей. Подтверждение продлевает доступ и начисляет долю партнёру.'
          : 'То, что вы отметили. Подтверждает платформа — статус придёт сюда.'}
      />

      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={onlyPending}
            onChange={(e) => setOnlyPending(e.target.checked)} />
          Только ждущие подтверждения
        </label>
      </div>

      {isPending && <SkeletonCards count={4} />}
      {isError && <Failed text={humanError(error)} onRetry={() => void refetch()} />}

      {data && rows.length > 0 && (
        <div className="pay-grid">
          {rows.map((p) => {
            return (
              <article key={p.id} className={`pay ${p.status === 'PENDING' ? 'waiting' : ''} ${leaving[p.id] ? 'leaving' : ''}`}>
                <div className="pay-top">
                  <div className="pay-who">
                    <b>{p.tenantName}</b>
                    <div className="sub">{p.method} · отметил {p.createdByName} · {new Date(p.createdAt).toLocaleString('ru-RU')}</div>
                  </div>
                  <div className="pay-amount">
                    <b>{money(p.amount)}</b>
                    <div className="sub">{p.months} мес.</div>
                  </div>
                </div>

                <div className="pay-state">
                  {p.status === 'PENDING' && <span className="badge st-pending"><i className="dot" />ждёт подтверждения</span>}
                  {p.status === 'APPROVED' && <span className="badge st-active"><i className="dot" />подтверждена</span>}
                  {p.status === 'REJECTED' && <span className="badge st-expired"><i className="dot" />отклонена</span>}
                  {p.status === 'PENDING' && (
                    <span className="pay-note">{payLine(p, tenants.data?.rows ?? [], partners.data ?? [])}</span>
                  )}
                  {p.status === 'APPROVED' && (
                    <span className="pay-note">{p.approvedByName} · {date(p.approvedAt)}</span>
                  )}
                  {p.status === 'REJECTED' && p.rejectReason && (
                    <span className="pay-note">{p.rejectReason}</span>
                  )}
                </div>

                {p.comment && <div className="pay-comment">{p.comment}</div>}

                {isSuper && p.status === 'PENDING' && (
                  <div className="pay-actions">
                    <button className="btn" disabled={act.isPending} onClick={() => void reject(p)}>Отклонить…</button>
                    <button className="btn primary" disabled={act.isPending} onClick={() => void approve(p)}>Подтвердить…</button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {data && rows.length === 0 && (
        <Empty
          title={onlyPending ? 'Все оплаты обработаны' : 'Оплат пока нет'}
          text={onlyPending
            ? 'Новые платежи появятся здесь, а на пункте «Деньги» загорится счётчик.'
            : 'Как только партнёр отметит платёж, он придёт сюда.'}
          actionLabel={onlyPending ? 'Показать все' : undefined}
          onAction={onlyPending ? () => setOnlyPending(false) : undefined}
        />
      )}
    </>
  );
}

/** Одно выданное поле: моно-значение и своя кнопка копирования.
    Доступы показываются один раз — копировать по одному надёжнее,
    чем выделять мышью в общем блоке. */
function CredLine({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div>
      <span>{label}</span>
      <b>{value}</b>
      <button className="btn small ghost" onClick={() => {
        void navigator.clipboard?.writeText(value);
        setDone(true);
        window.setTimeout(() => setDone(false), 1600);
      }}>{done ? 'Скопировано' : 'Копировать'}</button>
    </div>
  );
}

// ─────────────────────────────────────────── партнёры

function Partners({ token }: { token: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useAsk();
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ fullName: '', email: '', password: '', commissionBp: 1500 });
  const [err, setErr] = useState('');

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['partners'],
    queryFn: () => call<PartnerRow[]>('/partners', { token }),
  });

  const create = useMutation({
    mutationFn: () => call('/partners', { method: 'POST', token, body: f }),
    onSuccess: () => {
      setAdd(false); setF({ fullName: '', email: '', password: '', commissionBp: 1500 });
      void qc.invalidateQueries({ queryKey: ['partners'] });
      toast({ text: 'Партнёр заведён' });
    },
    onError: (e: Error) => { setErr(e.message); toast({ text: humanError(e), kind: 'err' }); },
  });

  /* Имя и почта — правкой на месте: опечатки не стоят листа.
     Ставка и пароль — через лист: первое деньги, второе доступ. */
  const patch = useMutation({
    mutationFn: (v: { partnerId: string; fullName?: string; email?: string; commissionBp?: number; password?: string }) =>
      call('/partners/update', { method: 'POST', token, body: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partners'] }),
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const askCommission = async (p: PartnerRow) => {
    const now = p.commissionBp / 100;
    const answer = await ask({
      title: `Доля партнёра · ${p.fullName}`,
      sub: 'Доля считается в момент подтверждения платежа, поэтому новая ставка действует только на будущие оплаты.',
      value: { label: 'Доля партнёра, %', initial: String(now) },
      effects: (r) => {
        const next = Number(r.value);
        const ok = Number.isFinite(next) && next >= 0 && next <= 100;
        return [
          ['Партнёр', p.fullName],
          ['Сейчас', `${now.toFixed(0)}% · вам ${(100 - now).toFixed(0)}%`],
          ['Станет', ok ? `${next}% · вам ${100 - next}%` : '— · допустимо от 0 до 100'],
          ['Уже подтверждённые оплаты', 'хранят свою долю'],
          ['Заработал за 30 дн.', money(p.earned30)],
        ];
      },
      confirmLabel: 'Изменить долю',
      danger: true,
    });
    if (!answer) return;
    const next = Number(answer.value);
    if (!Number.isFinite(next) || next < 0 || next > 100) {
      toast({ text: 'Доля партнёра — от 0 до 100%', kind: 'err' });
      return;
    }
    patch.mutate(
      { partnerId: p.id, commissionBp: Math.round(next * 100) },
      { onSuccess: () => toast({ text: `Доля «${p.fullName}» — ${next}%` }) },
    );
  };

  const askPassword = async (p: PartnerRow) => {
    const answer = await ask({
      title: `Новый пароль · ${p.fullName}`,
      sub: 'Старый пароль перестанет работать сразу. Передайте новый лично — показан он будет один раз.',
      effects: [['Партнёр', p.fullName], ['Вход', p.email]],
      value: { label: 'Новый пароль', numeric: false, hint: 'не короче восьми знаков' },
      confirmLabel: 'Сменить пароль',
      danger: true,
    });
    if (!answer) return;
    if (answer.value.length < 8) {
      toast({ text: 'Пароль короче восьми знаков — не сохранил', kind: 'err' });
      return;
    }
    patch.mutate(
      { partnerId: p.id, password: answer.value },
      { onSuccess: () => toast({ text: `Пароль «${p.fullName}» сменён — передайте его лично` }) },
    );
  };

  const toggle = useMutation({
    mutationFn: (id: string) => call('/partners/toggle', { method: 'POST', token, body: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partners'] }),
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  /* Отключение партнёра — это доступ к чужим клиентам и чужим деньгам:
     показываем, сколько заведений останется без присмотра. */
  const askToggle = async (p: PartnerRow) => {
    const off = p.isActive;
    const answer = await ask({
      title: off ? `Отключить «${p.fullName}»` : `Включить «${p.fullName}»`,
      sub: off
        ? 'Партнёр перестанет входить в панель. Его клиенты продолжат работать и платить — вести их будете вы.'
        : 'Партнёр снова сможет вести своих клиентов и отмечать оплаты.',
      effects: [
        ['Партнёр', p.fullName],
        ['Клиентов', `${p.activeClients} из ${p.clients}`],
        ['Заработал за 30 дн.', money(p.earned30)],
        ['Доля', `${(p.commissionBp / 100).toFixed(0)}%`],
      ],
      danger: off,
      confirmLabel: off ? 'Отключить' : 'Включить',
    });
    if (!answer) return;
    toggle.mutate(p.id, {
      onSuccess: () => toast({ text: off ? `«${p.fullName}» отключён` : `«${p.fullName}» включён` }),
    });
  };

  return (
    <>
      <PageHead
        title="Партнёры"
        sub="Партнёр заводит и настраивает своих клиентов, отмечает оплаты. Подтверждаете деньги только вы."
        actions={<button className="btn primary" onClick={() => setAdd(true)}>+ Партнёр</button>}
      />

      {isPending && <SkeletonTable rows={4} cols={6} />}
      {isError && <Failed text={humanError(error)} onRetry={() => void refetch()} />}

      {data && data.length === 0 && (
        <Empty
          title="Партнёров пока нет"
          text="Партнёр ведёт своих клиентов и получает долю с их оплат. Деньги всё равно подтверждаете вы."
          actionLabel="Завести партнёра"
          onAction={() => setAdd(true)}
        />
      )}

      {data && data.length > 0 && (
        <table className="grid partners">
          <thead>
            <tr><th>Имя</th><th>Почта</th><th>Клиентов</th><th>Доля партнёра</th>
              <th>Заработал 30 дн.</th><th>Был в системе</th><th /></tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id} className={p.isActive ? '' : 'off'}>
                <td data-label="Имя">
                  <InlineText
                    value={p.fullName}
                    label="Имя партнёра"
                    disabled={p.role === 'SUPER'}
                    onSave={(fullName) => fullName && patch.mutate(
                      { partnerId: p.id, fullName },
                      { onSuccess: () => toast({ text: 'Имя сохранено' }) },
                    )}
                  />
                  {p.role === 'SUPER' && <span className="badge st-active">супер</span>}
                </td>
                <td data-label="Почта">
                  <InlineText
                    value={p.email}
                    label="Почта для входа"
                    mono
                    disabled={p.role === 'SUPER'}
                    onSave={(email) => email && patch.mutate(
                      { partnerId: p.id, email },
                      { onSuccess: () => toast({ text: 'Почта сохранена' }) },
                    )}
                  />
                </td>
                <td data-label="Клиентов">{p.activeClients} из {p.clients}</td>
                <td data-label="Доля партнёра">
                  {(p.commissionBp / 100).toFixed(0)}%
                  <div className="sub">вам {(100 - p.commissionBp / 100).toFixed(0)}%</div>
                </td>
                <td data-label="Заработал 30 дн.">{money(p.earned30)}</td>
                <td data-label="Был в системе">{p.lastLoginAt ? new Date(p.lastLoginAt).toLocaleString('ru-RU') : 'ни разу'}</td>
                <td className="actions">
                  {p.role !== 'SUPER' && (
                    <RowMenu
                      actions={[
                        { label: 'Изменить долю…', onClick: () => void askCommission(p) },
                        { label: 'Сменить пароль…', onClick: () => void askPassword(p) },
                        {
                          label: p.isActive ? 'Отключить партнёра' : 'Включить партнёра',
                          danger: p.isActive,
                          onClick: () => void askToggle(p),
                        },
                      ]}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {add && (
        <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && setAdd(false)}>
          <div className="modal-card">
            <div className="sheet-head">
              <h2>Новый партнёр</h2>
              <button className="btn small ghost sheet-x" aria-label="Закрыть" onClick={() => setAdd(false)}>×</button>
            </div>
            <label>Имя<input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></label>
            <label>Почта<input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
            <label>Пароль (передайте лично)
              <input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
            </label>
            <label>Доля партнёра, %
              <input type="number" min={0} max={100} value={f.commissionBp / 100}
                onChange={(e) => setF({ ...f, commissionBp: Number(e.target.value) * 100 })} />
              <i className="split">
                Партнёру {f.commissionBp / 100}% · вам {100 - f.commissionBp / 100}%
                {' '}с каждой оплаты его клиентов
              </i>
            </label>
            {err && <p className="err">{err}</p>}
            <div className="modal-actions">
              <button className="btn" onClick={() => setAdd(false)}>Отмена</button>
              <button className="btn primary"
                disabled={f.fullName.length < 2 || f.password.length < 8 || !/.+@.+\..+/.test(f.email)}
                onClick={() => create.mutate()}>Создать</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────── заявки

/** Человеческое описание того, что просят — вместо сырого JSON. */
export function describeRequest(kind: string, payload: Record<string, unknown>): string {
  const price = typeof payload.unitPrice === 'number' && payload.unitPrice > 0
    ? ` · предложено ${money(payload.unitPrice)}/мес за штуку`
    : '';
  if (kind === 'DEVICE_LIMIT') {
    const parts: string[] = [];
    if (typeof payload.maxPos === 'number') parts.push(`касс до ${payload.maxPos}`);
    if (typeof payload.maxKds === 'number') parts.push(`экранов кухни до ${payload.maxKds}`);
    if (typeof payload.maxWaiter === 'number') parts.push(`телефонов официантов до ${payload.maxWaiter}`);
    if (typeof payload.maxCouriers === 'number') parts.push(`курьеров до ${payload.maxCouriers}`);
    return (parts.length ? `Поднять ${parts.join(', ')}` : 'Поднять лимит устройств') + price;
  }
  if (kind === 'PLAN') {
    const name = typeof payload.planName === 'string' ? payload.planName : '';
    const price = typeof payload.planPrice === 'number' ? money(payload.planPrice) : '';
    return `Сменить тариф${name ? ` на «${name}»` : ''}${price ? ` · ${price}/мес` : ''}`;
  }
  if (kind === 'GRACE') {
    const d = typeof payload.days === 'number' ? payload.days : 0;
    return `Продлить срок на ${d} дн. без оплаты`;
  }
  return 'Прочее';
}

/** Деньги клиента рядом с заявкой — сервер кладёт их в поле client. */
type RequestClient = {
  paidUntil: string | null; daysLeft: number | null; status: string; monthly: number;
  pendingPayment: { amount: number; months: number; at: string } | null;
};

/*
 * Строка «как у клиента с деньгами»: решение об устройстве — это
 * решение о деньгах, и принимать его надо, видя, платит ли человек.
 */
function ClientMoney({ c, onPayments }: { c: RequestClient; onPayments?: () => void }) {
  const late = c.status === 'EXPIRED' || (c.daysLeft !== null && c.daysLeft < 0);
  const soon = !late && c.daysLeft !== null && c.daysLeft <= 7;
  return (
    <div className={`req-money ${late ? 'late' : soon ? 'soon' : ''}`}>
      <span className="req-money-main">
        <b>{money(c.monthly)}</b>/мес
      </span>
      <span>
        {late
          ? `просрочка ${Math.abs(c.daysLeft ?? 0)} дн.`
          : c.daysLeft === null
            ? 'срок не начат'
            : `оплачено ещё ${c.daysLeft} дн.`}
      </span>
      {c.pendingPayment && (
        <button
          className="req-money-pay"
          onClick={onPayments}
          title="Перейти к очереди оплат"
        >
          ждёт подтверждения {money(c.pendingPayment.amount)} от {date(c.pendingPayment.at)}
        </button>
      )}
    </div>
  );
}

function Requests({ token, isSuper, onPayments }: {
  token: string; isSuper: boolean; onPayments?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useAsk();
  const prices = usePriceBook(token);
  const [onlyPending, setOnlyPending] = useState(true);
  const [leaving, setLeaving] = useState<Record<string, boolean>>({});
  const [gone, setGone] = useState<string[]>([]);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['requests', false],
    queryFn: () => call<(TenantRequestRow & { client?: RequestClient })[]>('/requests', { token }),
    refetchInterval: 20_000,
  });

  const decide = useMutation({
    mutationFn: (v: { id: string; approve: boolean; comment?: string; unitPrice?: number }) =>
      call('/requests/decide', { method: 'POST', token, body: v }),
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const dismiss = (id: string) => {
    setLeaving((s) => ({ ...s, [id]: true }));
    window.setTimeout(() => {
      setGone((g) => [...g, id]);
      setLeaving((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
      void qc.invalidateQueries({ queryKey: ['requests'] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
    }, 280);
  };

  /*
   * Устройство — деньги. Цену спрашиваем полем в листе: иначе лимит
   * вырастет, а счёт останется прежним, и платформа подарит кассу.
   */
  const approve = async (r: TenantRequestRow) => {
    const isDevice = r.kind === 'DEVICE_LIMIT';
    /* По умолчанию — то, что предложил партнёр; если не предложил — прайс. */
    const asked = typeof r.payload.unitPrice === 'number' ? r.payload.unitPrice : null;
    const key = deviceOfPayload(r.payload);
    const listed = key ? prices.data?.[key] ?? null : null;
    const initial = Math.round((asked ?? listed ?? 800000) / 100);
    const answer = await ask({
      title: 'Одобрить заявку',
      sub: isDevice
        ? 'Лимит вырастет, и цена уйдёт в ежемесячный счёт клиента.'
        : 'Решение вступит в силу сразу после подтверждения.',
      effects: [
        ['Заведение', r.tenantName],
        ['Просят', describeRequest(r.kind, r.payload)],
        ['Просил', r.createdByName],
      ],
      value: isDevice
        ? {
          label: 'Цена за штуку в месяц, ₸',
          initial: String(initial),
          hint: asked !== null && listed !== null && asked !== listed
            ? `партнёр предложил ${money(asked)}, по прайсу ${money(listed)}`
            : 'ноль — бесплатно, строка всё равно появится в счёте',
        }
        : undefined,
      confirmLabel: isDevice ? 'Одобрить и добавить в счёт' : 'Одобрить',
    });
    if (!answer) return;
    const body = isDevice
      ? { id: r.id, approve: true, unitPrice: Math.round(Number(answer.value) * 100) || 0 }
      : { id: r.id, approve: true };
    decide.mutate(body, {
      onSuccess: () => {
        toast({ text: isDevice ? 'Заявка одобрена, строка добавлена в счёт' : 'Заявка одобрена' });
        dismiss(r.id);
      },
    });
  };

  const reject = async (r: TenantRequestRow) => {
    const answer = await ask({
      title: 'Отказать по заявке',
      sub: 'Партнёр увидит причину в своей вкладке «Мои заявки».',
      effects: [
        ['Заведение', r.tenantName],
        ['Просят', describeRequest(r.kind, r.payload)],
        ['Просил', r.createdByName],
      ],
      reason: {
        label: 'Почему отказ — это увидит партнёр',
        placeholder: 'Сначала пусть закроют долг за август…',
        required: true,
      },
      danger: true,
      confirmLabel: 'Отказать',
    });
    if (!answer) return;
    decide.mutate({ id: r.id, approve: false, comment: answer.reason }, {
      onSuccess: () => {
        toast({ text: 'Отказ отправлен партнёру' });
        dismiss(r.id);
      },
    });
  };

  /* «Только ждущие решения» — но свежий отказ остаётся видимым неделю:
     иначе заявка исчезает, и партнёр не знает, отказали ему или он
     забыл отправить. */
  const fresh = (r: TenantRequestRow) => {
    if (r.status !== 'REJECTED' || !r.decidedAt) return false;
    return Date.now() - new Date(r.decidedAt).getTime() < 7 * 86_400_000;
  };
  const rows = (data ?? [])
    .filter((r) => !gone.includes(r.id))
    .filter((r) => !onlyPending || r.status === 'PENDING' || fresh(r));

  return (
    <>
      <PageHead
        title={isSuper ? 'Заявки' : 'Мои заявки'}
        sub={isSuper
          ? 'Партнёры просят то, что меняет деньги: лимиты, тарифы, отсрочки. Решаете вы.'
          : 'Ваши заявки владельцу платформы. Решение приходит сюда же.'}
      />

      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={onlyPending}
            onChange={(e) => setOnlyPending(e.target.checked)} />
          Только ждущие решения
        </label>
      </div>

      {isPending && <SkeletonCards count={3} height={150} />}
      {isError && <Failed text={humanError(error)} onRetry={() => void refetch()} />}

      {data && rows.length > 0 && (
        <div className="req-list">
          {rows.map((r) => (
            <article key={r.id} className={`req ${r.status === 'PENDING' ? 'waiting' : ''} ${leaving[r.id] ? 'leaving' : ''}`}>
              <div className="req-head">
                <b>{r.tenantName}</b>
                <span className="sub">{r.createdByName} · {new Date(r.createdAt).toLocaleString('ru-RU')}</span>
              </div>
              {r.client && <ClientMoney c={r.client} onPayments={onPayments} />}

              <div className="req-what">{describeRequest(r.kind, r.payload)}</div>
              <div className="req-why">{r.reason}</div>

              <div className="req-state">
                {r.status === 'PENDING' && <span className="badge st-pending"><i className="dot" />ждёт решения</span>}
                {r.status === 'APPROVED' && <span className="badge st-active"><i className="dot" />одобрено</span>}
                {r.status === 'REJECTED' && <span className="badge st-expired"><i className="dot" />отказано</span>}
                {r.decision && <span className="pay-note">{r.decision}</span>}
              </div>

              {isSuper && r.status === 'PENDING' && (
                <div className="pay-actions">
                  <button className="btn" disabled={decide.isPending} onClick={() => void reject(r)}>Отказать…</button>
                  <button className="btn primary" disabled={decide.isPending} onClick={() => void approve(r)}>Одобрить…</button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {data && rows.length === 0 && (
        <Empty
          title={onlyPending ? 'Заявок на рассмотрении нет' : 'Заявок пока не было'}
          text={isSuper
            ? 'Здесь появятся просьбы партнёров: больше устройств, другой тариф, отсрочка.'
            : 'Отправьте заявку из карточки клиента — решение придёт сюда.'}
          actionLabel={onlyPending ? 'Показать все' : undefined}
          onAction={onlyPending ? () => setOnlyPending(false) : undefined}
        />
      )}
    </>
  );
}

/** Форма запроса: партнёр объясняет, что нужно клиенту и почему. */
function AskForm({ token, tenant, onDone }: {
  token: string; tenant: AskTarget; onDone: () => void;
}) {
  const toast = useToast();
  const prices = usePriceBook(token);
  const [kind, setKind] = useState<'DEVICE_LIMIT' | 'PLAN' | 'GRACE' | 'OTHER'>('DEVICE_LIMIT');
  const [device, setDevice] = useState('POS');
  const [limit, setLimit] = useState(2);
  const [unitPrice, setUnitPrice] = useState(0);
  const [planName, setPlanName] = useState(tenant.planName);
  const [planPrice, setPlanPrice] = useState(Math.round(tenant.planPrice / 100));
  const [days, setDays] = useState(7);
  const [reason, setReason] = useState('');

  const priceKey = DEVICE_PRICE[device];
  const listPrice = priceKey ? prices.data?.[priceKey] ?? null : null;
  /* Пока партнёр не трогал цену, идёт прайс. */
  const price = unitPrice || listPrice || 0;
  const limitKey = DEVICES.find((d) => d.kind === device)?.limitKey ?? 'maxPos';

  const payload = kind === 'DEVICE_LIMIT' ? { [limitKey]: limit, unitPrice: price }
    : kind === 'PLAN' ? { planName, planPrice: planPrice * 100 }
      : kind === 'GRACE' ? { days } : {};

  const send = useMutation({
    mutationFn: () => call('/requests', {
      method: 'POST', token,
      body: { tenantId: tenant.id, kind, payload, reason: reason.trim() },
    }),
    onSuccess: () => { toast({ text: 'Заявка отправлена платформе' }); onDone(); },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <div className="modal-card">
        <div className="sheet-head">
          <h2>Запрос по клиенту «{tenant.name}»</h2>
          <button className="btn small ghost sheet-x" aria-label="Закрыть" onClick={onDone}>×</button>
        </div>
        <p className="hint">
          Всё, что меняет деньги, решает владелец платформы. Опишите,
          что нужно клиенту и почему — так решение придёт быстрее.
        </p>

        <label>Что просим
          <select value={kind} onChange={(e) => setKind(e.target.value as 'PLAN')}>
            <option value="DEVICE_LIMIT">Больше устройств</option>
            <option value="PLAN">Другой тариф</option>
            <option value="GRACE">Отсрочку оплаты</option>
            <option value="OTHER">Прочее</option>
          </select>
        </label>

        {kind === 'DEVICE_LIMIT' && (
          <>
            <div className="row2">
              <label>Что подключаем
                <select value={device} onChange={(e) => { setDevice(e.target.value); setUnitPrice(0); }}>
                  {DEVICES.map((d) => <option key={d.kind} value={d.kind}>{d.title}</option>)}
                </select>
              </label>
              <label>Поднять лимит до
                <input type="number" min={1} max={30} value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))} />
              </label>
            </div>
            <PriceChoice
              label="Цена за штуку"
              listPrice={listPrice}
              value={price}
              onChange={setUnitPrice}
              note="Владелец платформы увидит вашу цену в заявке и может поправить её перед одобрением."
            />
          </>
        )}

        {kind === 'PLAN' && (
          <div className="row2">
            <label>Название
              <input value={planName} onChange={(e) => setPlanName(e.target.value)} />
            </label>
            <label>Цена в месяц, ₸
              <input type="number" value={planPrice}
                onChange={(e) => setPlanPrice(Number(e.target.value))} />
            </label>
          </div>
        )}

        {kind === 'GRACE' && (
          <label>Дней отсрочки
            <input type="number" min={1} max={90} value={days}
              onChange={(e) => setDays(Number(e.target.value))} />
          </label>
        )}

        <label>Зачем это клиенту
          <input value={reason} placeholder="Открывают вторую точку, нужна ещё касса"
            onChange={(e) => setReason(e.target.value)} />
        </label>

        <div className="modal-actions">
          <button className="btn" onClick={onDone}>Отмена</button>
          <button className="btn primary" disabled={reason.trim().length < 5 || send.isPending}
            onClick={() => send.mutate()}>Отправить запрос</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────── реквизиты платформы

/**
 * Куда заведения платят. Раньше деньги шли через партнёра, и владелец
 * платформы зависел от его добросовестности. Теперь клиент видит эти
 * реквизиты у себя в офисе и платит напрямую — партнёр получает долю
 * расчётом, а не тем, что деньги проходят через его руки.
 */
/*
 * Проверка картинки QR.
 *
 * Битую ссылку иначе замечает только клиент — и молчит. Три состояния
 * вместо одного пустого места: не заполнено, проверяем, не открылась.
 */
function QrCheck({ url }: { url: string }) {
  const src = url.trim();
  const [state, setState] = useState<'wait' | 'ok' | 'fail'>('wait');

  useEffect(() => { setState('wait'); }, [src]);

  if (src === '') {
    return (
      <div className="qr-check empty">
        <div className="qr-box" />
        <p>Пока не заполнено — клиент увидит только ссылку и номер для перевода.</p>
      </div>
    );
  }

  return (
    <div className={`qr-check ${state}`}>
      <div className="qr-box">
        <img
          src={src}
          alt="Проверка картинки QR"
          onLoad={() => setState('ok')}
          onError={() => setState('fail')}
        />
      </div>
      {state === 'wait' && <p>Проверяем ссылку…</p>}
      {state === 'ok' && <p>Картинка открывается — клиент увидит именно её.</p>}
      {state === 'fail' && (
        <p className="bad">
          Ссылка не работает: клиент увидит пустое место. Нужна прямая ссылка
          на картинку, а не страница, где она показана.
        </p>
      )}
    </div>
  );
}

/*
 * Как это увидит клиент.
 *
 * Владелец заполняет реквизиты вслепую и узнаёт о криво выглядящем
 * блоке от клиента. Здесь тот же блок из тех же данных — включая
 * пустое состояние: если не заполнено ничего, платить будет некуда.
 */
function ClientPreview({ pay }: {
  pay: { payUrl: string; payQrUrl: string; payPhone: string; payName: string; payNote: string };
}) {
  const nothing = pay.payUrl.trim() === '' && pay.payQrUrl.trim() === '' && pay.payPhone.trim() === '';
  return (
    <section className="client-preview">
      <h3>Как это увидит клиент</h3>
      <div className={`cp-frame ${nothing ? 'empty' : ''}`}>
        {nothing ? (
          <div className="cp-none">
            <b>Реквизиты не настроены</b>
            <p>Клиент не увидит, куда платить, и позвонит вам.</p>
          </div>
        ) : (
          <>
            <div className="cp-main">
              <span className="cp-label">К оплате</span>
              <b className="cp-sum">25 000 ₸</b>
              {pay.payUrl.trim() !== '' && <span className="cp-btn">Оплатить 25 000 ₸</span>}
              {pay.payName.trim() !== '' && <span className="cp-line">Получатель: {pay.payName}</span>}
              {pay.payPhone.trim() !== '' && <span className="cp-line">Перевод: {pay.payPhone}</span>}
              {pay.payNote.trim() !== '' && <span className="cp-line">В комментарии: {pay.payNote}</span>}
            </div>
            {pay.payQrUrl.trim() !== '' && (
              <img className="cp-qr" src={pay.payQrUrl} alt="" />
            )}
          </>
        )}
      </div>
      <p className="hint">Сумма в примере условная — у клиента подставится его счёт.</p>
    </section>
  );
}

function PaySettings({ token }: { token: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<{ payUrl: string; payQrUrl: string; payPhone: string; payName: string; payNote: string } | null>(null);

  const { data, isPending } = useQuery({
    queryKey: ['pay-settings'],
    queryFn: () => call<{ payUrl: string | null; payQrUrl: string | null; payPhone: string | null; payName: string | null; payNote: string | null }>('/pay-settings', { token }),
  });

  /* Массовым действиям нужен список клиентов для оценки денег. Ключ тот же. */
  const tenants = useQuery({
    queryKey: ['tenants'],
    queryFn: () => call<TenantList>('/tenants', { token }),
  });

  /* Прайс: правка на месте, поле за полем — это настройка, а не сделка. */
  const prices = usePriceBook(token);
  const savePrices = useMutation({
    mutationFn: (v: Partial<PriceBook>) =>
      call('/price-book', { method: 'POST', token, body: { ...prices.data, ...v } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['price-book'] });
      toast({ text: 'Цена сохранена' });
    },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const cur = f ?? {
    payUrl: data?.payUrl ?? '', payQrUrl: data?.payQrUrl ?? '', payPhone: data?.payPhone ?? '',
    payName: data?.payName ?? '', payNote: data?.payNote ?? '',
  };

  const save = useMutation({
    mutationFn: () => call('/pay-settings', { method: 'POST', token, body: cur }),
    onSuccess: () => {
      setF(null);
      void qc.invalidateQueries({ queryKey: ['pay-settings'] });
      toast({ text: 'Реквизиты сохранены' });
    },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  return (
    <>
      <PageHead
        title="Настройки"
        sub="Реквизиты видит владелец каждого заведения у себя в разделе «Подписка». Он платит напрямую вам — партнёр получает долю расчётом."
      />

      <h2 className="section-title">Куда платят заведения</h2>
      <p className="hint settings-hint">
        Клиент видит это у себя в разделе «Подписка» и платит напрямую вам.
        Ссылка удобна с компьютера, QR — с телефона, а приложения нужного банка
        у клиента может не оказаться вовсе: заполните оба пути и номер для перевода,
        тогда заплатить сможет каждый.
      </p>

      {isPending && <SkeletonCards count={1} height={280} />}

      {!isPending && (
        <div className="pay-setup">
          <section className="pay-group">
            <h3>Как платят</h3>
            <p className="hint">Достаточно одного пути, но лучше оба.</p>

            <label>Ссылка на оплату
              <input value={cur.payUrl} placeholder="https://pay.kaspi.kz/..."
                onChange={(e) => setF({ ...cur, payUrl: e.target.value })} />
              <i className="split">Kaspi, Halyk — любая ссылка, по которой можно заплатить</i>
            </label>

            <label>Картинка QR
              <input value={cur.payQrUrl} placeholder="https://.../qr.png"
                onChange={(e) => setF({ ...cur, payQrUrl: e.target.value })} />
              <i className="split">
                Нужна прямая ссылка на картинку, а не файл в галерее: сохраните QR,
                отправьте его себе в Telegram, откройте и выберите «Поделиться» →
                «Копировать ссылку».
              </i>
            </label>

            <QrCheck url={cur.payQrUrl} />
          </section>

          <section className="pay-group">
            <h3>Перевод руками</h3>
            <p className="hint">Запасной путь: показывается, если ссылка не открылась.</p>

            <label>Номер для перевода
              <input value={cur.payPhone} placeholder="+7 701 123-45-67"
                onChange={(e) => setF({ ...cur, payPhone: e.target.value })} />
            </label>

            <label>Получатель
              <input value={cur.payName} placeholder="ИП Мағжан"
                onChange={(e) => setF({ ...cur, payName: e.target.value })} />
              <i className="split">Владелец заведения должен видеть, кому платит</i>
            </label>

            <label>Что писать в комментарии
              <input value={cur.payNote} placeholder="Дастархан, название заведения"
                onChange={(e) => setF({ ...cur, payNote: e.target.value })} />
            </label>
          </section>

          <ClientPreview pay={cur} />

          <div className="form-actions pay-save">
            <button className="btn primary" disabled={!f || save.isPending}
              onClick={() => save.mutate()}>
              {save.isPending ? 'Сохраняем…' : f ? 'Сохранить реквизиты' : 'Сохранено'}
            </button>
            {f && <button className="btn" onClick={() => setF(null)}>Отменить правки</button>}
          </div>
        </div>
      )}

      <h2 className="section-title">Цены по умолчанию</h2>
      <p className="hint settings-hint">
        Партнёр подставляет их сам — и при заведении клиента, и в заявке на устройство.
        Отступить от прайса он может, но вы увидите это в заявке и решите сами.
        Уже выставленные счета не меняются: прайс действует на новые строки.
      </p>
      {prices.isPending && <SkeletonCards count={1} height={220} />}
      {prices.data && (
        <div className="price-book">
          {PRICE_FIELDS.map((f) => (
            <div className="price-row" key={f.key}>
              <div>
                <b>{f.title}</b>
                <div className="sub">{f.hint}</div>
              </div>
              <InlineText
                value={money(prices.data[f.key])}
                label={`${f.title}, ₸ в месяц`}
                mono
                onSave={(next) => {
                  const digits = next.replace(/[^\d-]/g, '');
                  const tiyn = Math.round(Number(digits) * 100);
                  if (!digits || !Number.isFinite(tiyn) || tiyn < 0) {
                    toast({ text: 'Нужно число не меньше нуля', kind: 'err' });
                    return;
                  }
                  savePrices.mutate({ [f.key]: tiyn });
                }}
              />
            </div>
          ))}
        </div>
      )}

      <h2 className="section-title">Скидка за длинную оплату</h2>
      <p className="hint settings-hint">
        Клиент видит их у себя в кабинете при выборе срока. Уже подтверждённые
        оплаты не пересчитываются. Выше пятидесяти процентов сервер не примет.
      </p>
      {prices.data && (
        <div className="price-book">
          {DISCOUNT_FIELDS.map((f) => {
            const pct = Number(prices.data[f.key]) || 0;
            const full = prices.data.base * f.months;
            const withPct = Math.round(full * (1 - pct / 100));
            return (
              <div className="price-row" key={f.key}>
                <div>
                  <b>{f.title}</b>
                  <div className="sub">
                    {pct > 0 && prices.data.base > 0
                      ? `при ${money(prices.data.base)}/мес — ${money(withPct)} вместо ${money(full)}`
                      : 'скидки нет — срок считается по полной цене'}
                  </div>
                </div>
                <InlineText
                  value={`${pct}%`}
                  label={`Скидка за ${f.title}, %`}
                  mono
                  onSave={(next) => {
                    const digits = next.replace(/[^\d]/g, '');
                    const val = Number(digits);
                    if (!digits || !Number.isFinite(val) || val < 0 || val > 50) {
                      toast({ text: 'Скидка — от 0 до 50%', kind: 'err' });
                      return;
                    }
                    savePrices.mutate({ [f.key]: val });
                  }}
                />
              </div>
            );
          })}
        </div>
      )}

      <h2 className="section-title danger-title">Массовые действия</h2>
      <p className="hint settings-hint">
        Меняет деньги сразу у многих и живёт здесь, а не среди ежедневной работы.
        Чтобы применить к отдельным заведениям — отметьте их галочками во вкладке «Клиенты».
      </p>
      <BulkPanel
        token={token}
        rows={tenants.data?.rows ?? []}
        selected={[]}
        onClear={() => undefined}
        onShowSelected={() => undefined}
      />
    </>
  );
}

// ─────────────────────────────────────────── счётчики для навигации

/** Те же запросы и ключи, что у вкладок: кэш общий, лишней нагрузки нет. */
function useCounts(token: string, isSuper: boolean): Counts {
  const tenants = useQuery({
    queryKey: ['tenants'],
    queryFn: () => call<TenantList>('/tenants', { token }),
    refetchInterval: 30_000,
  });
  const payments = useQuery({
    queryKey: ['payments', true],
    queryFn: () => call<PaymentRow[]>('/payments?pending=1', { token }),
    refetchInterval: 20_000,
  });
  const requests = useQuery({
    queryKey: ['requests', true],
    queryFn: () => call<TenantRequestRow[]>('/requests?pending=1', { token }),
    refetchInterval: 20_000,
  });

  /* Счётчик «Сегодня» считает ровно то, что покажет экран: очередь
     строится одной и той же функцией, поэтому цифра не разойдётся. */
  const queue = buildQueue({
    tenants: tenants.data?.rows ?? [],
    payments: payments.data ?? [],
    requests: requests.data ?? [],
    isSuper,
  }).filter((i) => i.group !== 'soon');

  return {
    today: queue.length,
    payments: payments.data?.length ?? 0,
    requests: requests.data?.length ?? 0,
    approvals: (tenants.data?.rows ?? []).filter((r) => r.status === 'PENDING_APPROVAL').length,
  };
}

// ─────────────────────────────────────────── страница клиента

/** Карточка клиента живёт по адресу #/client/<id> и умеет всё, что нужно по нему сделать. */
function ClientScreen({ token, isSuper, tenantId }: { token: string; isSuper: boolean; tenantId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ask = useAsk();
  const { assign } = useAssign(token, isSuper);
  const [paying, setPaying] = useState<PayTarget | null>(null);
  const [asking, setAsking] = useState<AskTarget | null>(null);

  const status = useMutation({
    mutationFn: (v: { tenantId: string; status: 'ACTIVE' | 'SUSPENDED' }) =>
      call('/tenants/status', { method: 'POST', token, body: v }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tenants'] });
      void qc.invalidateQueries({ queryKey: ['tenant-card', tenantId] });
    },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const suspend = async (t: { id: string; name: string; status: string; monthly: number; paidUntil: string | null }) => {
    const off = t.status !== 'SUSPENDED';
    const answer = await ask({
      title: off ? `Отключить «${t.name}»` : `Включить «${t.name}»`,
      sub: off
        ? 'Кассы и экраны кухни перестанут работать сразу после подтверждения.'
        : 'Заведение снова начнёт работать на прежних условиях.',
      effects: [
        ['Заведение', t.name],
        ['Счёт в месяц', money(t.monthly)],
        ['Оплачено до', date(t.paidUntil)],
      ],
      danger: off,
      confirmLabel: off ? 'Отключить' : 'Включить',
    });
    if (!answer) return;
    status.mutate(
      { tenantId: t.id, status: off ? 'SUSPENDED' : 'ACTIVE' },
      { onSuccess: () => toast({ text: off ? `«${t.name}» отключён` : `«${t.name}» включён` }) },
    );
  };

  const done = () => {
    setPaying(null); setAsking(null);
    void qc.invalidateQueries({ queryKey: ['tenant-card', tenantId] });
    void qc.invalidateQueries({ queryKey: ['tenants'] });
    void qc.invalidateQueries({ queryKey: ['payments'] });
    void qc.invalidateQueries({ queryKey: ['requests'] });
  };

  return (
    <>
      <TenantCard
        token={token}
        tenantId={tenantId}
        isSuper={isSuper}
        onBack={goList}
        onPay={(b) => setPaying({ id: b.id, name: b.name, planPrice: b.monthly })}
        onRequest={(b) => setAsking({ id: b.id, name: b.name, planName: b.planName, planPrice: b.monthly })}
        onSuspend={isSuper ? suspend : undefined}
        onAssign={isSuper ? ((t) => void assign(t)) : undefined}
      />
      {paying && <PayForm token={token} tenant={paying} onDone={done} />}
      {asking && <AskForm token={token} tenant={asking} onDone={done} />}
    </>
  );
}

// ─────────────────────────────────────────── оболочка

function Workspace({ session, onLogout }: { session: PlatformSession; onLogout: () => void }) {
  const [tab, setTab] = useState<TabKey>('today');
  const [clientId, setClientId] = useState<string | null>(() => clientFromHash());
  const isSuper = session.user.role === 'SUPER';
  const counts = useCounts(session.token, isSuper);

  useEffect(() => {
    const onHash = () => setClientId(clientFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  /* Партнёр не должен оказаться на закрытом разделе после смены роли. */
  useEffect(() => {
    if (!isSuper && (tab === 'partners' || tab === 'summary' || tab === 'pay')) setTab('tenants');
  }, [isSuper, tab]);

  return (
    <Shell
      userName={session.user.fullName}
      isSuper={isSuper}
      tab={tab}
      onTab={(t) => { if (clientId) window.location.hash = ''; setTab(t); }}
      counts={counts}
      onLogout={onLogout}
    >
      {clientId && <ClientScreen token={session.token} isSuper={isSuper} tenantId={clientId} />}
      {!clientId && (
        <>
          {tab === 'today' && (
            <Today token={session.token} isSuper={isSuper} onOpenClient={goClient} />
          )}
          {tab === 'tenants' && <Tenants token={session.token} isSuper={isSuper} />}
          {tab === 'summary' && isSuper && <Summary token={session.token} />}
          {tab === 'funnel' && <Funnel token={session.token} isSuper={isSuper} />}
          {tab === 'payments' && <Payments token={session.token} isSuper={isSuper} />}
          {tab === 'requests' && (
            <Requests token={session.token} isSuper={isSuper} onPayments={() => setTab('payments')} />
          )}
          {tab === 'partners' && isSuper && <Partners token={session.token} />}
          {tab === 'journal' && (
            <Journal token={session.token} isSuper={isSuper} onOpenClient={goClient} />
          )}
          {tab === 'pay' && isSuper && <PaySettings token={session.token} />}
        </>
      )}
    </Shell>
  );
}

function App() {
  const [session, setSession] = useState<PlatformSession | null>(() => {
    const token = localStorage.getItem(LS_TOKEN);
    const user = localStorage.getItem(LS_USER);
    return token && user ? { token, user: JSON.parse(user) } : null;
  });

  useEffect(() => {
    if (session) {
      localStorage.setItem(LS_TOKEN, session.token);
      localStorage.setItem(LS_USER, JSON.stringify(session.user));
    }
  }, [session]);

  if (!session) return <Login onIn={setSession} />;

  return (
    <Workspace
      session={session}
      onLogout={() => {
        localStorage.removeItem(LS_TOKEN);
        localStorage.removeItem(LS_USER);
        setSession(null);
      }}
    />
  );
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

/**
 * ЗАПУСК УБРАН. У них это отдельное приложение и оно само себя рисовало
 * в пустую страницу. У нас — раздел общего кабинета, поэтому запуск
 * делает страница Next.js рядом: она же держит хранилище запросов и
 * подложки для сообщений.
 *
 * Всё остальное — их: разметка, стили, поведение, тексты.
 */
export { App, qc };
