'use client';
/**
 * РАЗДЕЛ 8: «ЖУРНАЛ».
 *
 * Разметка и классы из их Journal.tsx дословно: journal-day,
 * journal-list, entry, entry-time, entry-body, entry-text, entry-meta,
 * entry-kind, entry-tenant, entry-amount, journal-more, link-name.
 *
 * Их приёмы, взятые целиком:
 *   группировка по дням с заголовком «Сегодня», «Вчера», датой;
 *   денежные записи помечены классом weighty — цена ошибки в них другая;
 *   листание кнопкой «Показать ещё» курсором по времени.
 */
import { useEffect, useState } from 'react';
import { api, money, type Me } from '../lib';

const WEIGHT = [
  { key: 'all',    label: 'Все' },
  { key: 'money',  label: 'Деньги' },
  { key: 'access', label: 'Доступ' },
  { key: 'other',  label: 'Прочее' },
];

/** Заголовок дня: сегодня и вчера словами, дальше датой. */
const dayTitle = (iso: string): string => {
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.round((now.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export default function Journal({ me }: { me: Me }) {
  const [rows, setRows] = useState<any[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [weight, setWeight] = useState('all');
  const [actorId, setActorId] = useState('all');
  const [tenantId, setTenantId] = useState('all');
  const [people, setPeople] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(true);

  const load = async (w = weight, before?: string) => {
    setBusy(true);
    try {
      const p = new URLSearchParams({ limit: '40' });
      if (w !== 'all') p.set('weight', w);
      if (actorId !== 'all') p.set('actorId', actorId);
      if (tenantId !== 'all') p.set('accountId', tenantId);
      if (before) p.set('before', before);
      const d = await api('/audit?' + p.toString());
      setRows(before ? [...rows, ...d.rows] : d.rows);
      setNext(d.nextBefore); setHasMore(d.hasMore); setErr('');
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { if (rows.length === 0) load(weight); }, [actorId, tenantId]);

  // Списки для отбора: кто действовал и по какому клиенту. У них так
  // же — журнал без отбора бесполезен, когда записей тысяча.
  useEffect(() => {
    if (me.role !== 'super') return;
    api('/partners').then((p: any) => setPeople(p.rows ?? [])).catch(() => {});
    api('/clients').then((c: any) => setClients(c.rows ?? [])).catch(() => {});
  }, []);

  // Группировка по дням: в журнале ищут «что было вчера», а не запись
  // номер сорок.
  const days = new Map<string, any[]>();
  for (const r of rows) {
    const k = String(r.at).slice(0, 10);
    if (!days.has(k)) days.set(k, []);
    days.get(k)!.push(r);
  }

  return (
    <>
      {me.role === 'super' && (
        <div className="toolbar">
          <select className="sorter" value={actorId}
            onChange={(e) => { setActorId(e.target.value); setRows([]); }}>
            <option value="all">Все люди</option>
            {people.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <select className="sorter" value={tenantId}
            onChange={(e) => { setTenantId(e.target.value); setRows([]); }}>
            <option value="all">Все магазины</option>
            {clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>

          <button className="btn small ghost"
            onClick={() => { setActorId('all'); setTenantId('all'); setRows([]); load(weight); }}>
            Сбросить
          </button>
        </div>
      )}

      <div className="chips">
        {WEIGHT.map((w) => (
          <button key={w.key} className={`chip${weight === w.key ? ' on' : ''}`}
            onClick={() => { setWeight(w.key); setRows([]); load(w.key); }}>
            {w.label}
          </button>
        ))}
      </div>

      {err && <div className="err">{err}</div>}

      {rows.length === 0 && !busy ? (
        <div className="all-clear">
          <b>Записей нет</b>
          <p>При этом отборе ничего не нашлось.</p>
        </div>
      ) : [...days.entries()].map(([day, list]) => (
        <section className="journal-day" key={day}>
          <h2>{dayTitle(day)}</h2>

          <div className="journal-list">
            {list.map((r: any) => (
              /* Денежные записи весомее прочих: цена ошибки в них
                 другая. Их класс weighty. */
              <article key={r.id}
                className={`entry ${r.weight === 'money' ? 'weighty' : ''} ${r.weight}`}>
                <span className="entry-time">{time(r.at)}</span>

                <div className="entry-body">
                  <div className="entry-text">
                    <b>{r.actor}</b> {r.title.toLowerCase()}
                  </div>

                  <div className="entry-meta">
                    {r.detail && <span className="entry-kind">{r.detail}</span>}
                    {r.client && (
                      <button className="link-name entry-tenant"
                        onClick={() => { setTenantId(r.accountId); setRows([]); }}>
                        {r.client}
                      </button>
                    )}
                  </div>
                </div>

                {r.amount != null && <span className="entry-amount">{money(r.amount)}</span>}
              </article>
            ))}
          </div>
        </section>
      ))}

      {hasMore && (
        <div className="journal-more">
          <button className="btn ghost" disabled={busy}
            onClick={() => load(weight, next ?? undefined)}>
            {busy ? 'Загрузка…' : 'Показать ещё'}
          </button>
        </div>
      )}
    </>
  );
}
