/*
 * Журнал платформы: кто что сделал.
 *
 * Источник — общий журнал одним адресом (/audit): в нём есть всё,
 * чего не хватало ленте, собранной на клиенте, — правки цен в счёте,
 * массовые действия, смены уровня, сдвиги воронки, одобрения
 * регистраций.
 *
 * Отбор делает сервер: человек и заведение уходят в запрос, партнёру
 * записи по чужим клиентам не приходят вовсе. Лента листается по
 * курсору — время последней показанной записи.
 *
 * Денежные записи весомее прочих: цена ошибки в них другая.
 */
import { useState } from 'react';
import { humanError } from './ui/errors';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { PartnerRow, TenantList } from '@dastarhan/contracts';
import { call, money } from './main';
import { Empty, Failed, PageHead, SkeletonCards } from './ui/States';

type AuditRow = {
  id: string;
  at: string;
  actorId: string;
  actorName: string;
  tenantId: string | null;
  tenantName: string;
  kind: string;
  message: string;
  amount: number | null;
};

type AuditPage = { rows: AuditRow[]; nextCursor: string | null };

/** Что считается деньгами: подтверждение, отказ, массовая правка. */
const MONEY_KINDS = ['PAYMENT_APPROVED', 'PAYMENT_REJECTED', 'BULK'];

const TONE: Record<string, 'ok' | 'bad' | 'plain'> = {
  PAYMENT_APPROVED: 'ok',
  SIGNUP: 'ok',
  PAYMENT_REJECTED: 'bad',
  BULK: 'plain',
  TIER: 'plain',
};

const KIND_TITLE: Record<string, string> = {
  PAYMENT_APPROVED: 'оплата',
  PAYMENT_REJECTED: 'отказ',
  BULK: 'массово',
  TIER: 'уровень',
  LEAD_STAGE: 'воронка',
  SIGNUP: 'заявка',
};

const dayKey = (iso: string): string => iso.slice(0, 10);

const dayTitle = (key: string): string => {
  const d = new Date(key);
  const today = new Date();
  const diff = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
      - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400_000,
  );
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};

const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function Journal({ token, isSuper, onOpenClient }: {
  token: string;
  isSuper: boolean;
  onOpenClient: (tenantId: string) => void;
}) {
  const [actorId, setActorId] = useState('all');
  const [tenantId, setTenantId] = useState('all');
  const [onlyMoney, setOnlyMoney] = useState(false);

  const feed = useInfiniteQuery({
    queryKey: ['audit', actorId, tenantId],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '50' });
      if (pageParam) q.set('cursor', String(pageParam));
      if (actorId !== 'all') q.set('actorId', actorId);
      if (tenantId !== 'all') q.set('tenantId', tenantId);
      return call<AuditPage>(`/audit?${q.toString()}`, { token });
    },
    getNextPageParam: (last: AuditPage) => last.nextCursor ?? undefined,
  });

  /* Списки для отбора: те же ключи, что у вкладок — кэш общий. */
  const tenants = useQuery({
    queryKey: ['tenants'],
    queryFn: () => call<TenantList>('/tenants', { token }),
  });
  const partners = useQuery({
    queryKey: ['partners'],
    queryFn: () => call<PartnerRow[]>('/partners', { token }),
    enabled: isSuper,
  });

  const loaded = feed.data?.pages.flatMap((p) => p.rows) ?? [];
  const rows = onlyMoney
    ? loaded.filter((r) => r.amount !== null || MONEY_KINDS.includes(r.kind))
    : loaded;

  const dirty = actorId !== 'all' || tenantId !== 'all' || onlyMoney;
  const reset = () => { setActorId('all'); setTenantId('all'); setOnlyMoney(false); };
  const days = [...new Set(rows.map((r) => dayKey(r.at)))];

  return (
    <>
      <PageHead
        title={isSuper ? 'Журнал' : 'Мои события'}
        sub={isSuper
          ? 'Кто что сделал на платформе: оплаты, цены, отсрочки, уровни, воронка. Денежные записи выделены.'
          : 'Что происходило по вашим клиентам и что решила платформа.'}
      />

      <div className="toolbar">
        {isSuper && (partners.data ?? []).length > 0 && (
          <select className="sorter" value={actorId} onChange={(e) => setActorId(e.target.value)}>
            <option value="all">Все люди</option>
            {(partners.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.fullName}</option>
            ))}
          </select>
        )}
        {(tenants.data?.rows ?? []).length > 1 && (
          <select className="sorter" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="all">Все заведения</option>
            {(tenants.data?.rows ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <label className="check">
          <input type="checkbox" checked={onlyMoney} onChange={(e) => setOnlyMoney(e.target.checked)} />
          Только про деньги
        </label>
        {dirty && <button className="btn small ghost" onClick={reset}>Сбросить</button>}
      </div>

      {feed.isPending && <SkeletonCards count={3} height={120} />}
      {feed.isError && (
        <Failed text={humanError(feed.error)} onRetry={() => void feed.refetch()} />
      )}

      {!feed.isPending && !feed.isError && rows.length === 0 && (
        <Empty
          title={dirty ? 'По этому отбору записей нет' : 'Записей пока нет'}
          text={dirty
            ? 'Смените человека или заведение — или снимите отбор.'
            : 'Здесь появится всё, что делают на платформе: оплаты, цены, отсрочки, решения по заявкам.'}
          actionLabel={dirty ? 'Сбросить отбор' : undefined}
          onAction={dirty ? reset : undefined}
        />
      )}

      {!feed.isPending && !feed.isError && days.map((day) => (
        <section className="journal-day" key={day}>
          <h2>{dayTitle(day)}</h2>
          <div className="journal-list">
            {rows.filter((r) => dayKey(r.at) === day).map((r) => {
              const weighty = r.amount !== null || MONEY_KINDS.includes(r.kind);
              const tone = TONE[r.kind] ?? 'plain';
              return (
                <article key={r.id} className={`entry ${weighty ? 'weighty' : ''} ${tone}`}>
                  <span className="entry-time">{time(r.at)}</span>
                  <div className="entry-body">
                    <div className="entry-text">
                      <b>{r.actorName}</b> {r.message}
                    </div>
                    <div className="entry-meta">
                      {KIND_TITLE[r.kind] && <span className="entry-kind">{KIND_TITLE[r.kind]}</span>}
                      {r.tenantId
                        ? (
                          <button className="link-name entry-tenant" onClick={() => onOpenClient(r.tenantId as string)}>
                            {r.tenantName}
                          </button>
                        )
                        : <span className="entry-tenant">{r.tenantName}</span>}
                    </div>
                  </div>
                  {r.amount !== null && <span className="entry-amount">{money(r.amount)}</span>}
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {!feed.isPending && !feed.isError && rows.length > 0 && (
        <div className="journal-more">
          {feed.hasNextPage
            ? (
              <button
                className="btn"
                disabled={feed.isFetchingNextPage}
                onClick={() => void feed.fetchNextPage()}
              >
                {feed.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
              </button>
            )
            : <p className="table-foot">Это всё — показано {rows.length} записей</p>}
        </div>
      )}
    </>
  );
}
