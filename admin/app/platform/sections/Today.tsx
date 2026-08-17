'use client';
/**
 * РАЗДЕЛ 1: «СЕГОДНЯ».
 *
 * Разметка и классы — из их Today.tsx дословно: queue-group, queue-head,
 * count, hint, queue-list, queue-item, queue-main, link-name, queue-what,
 * sub, queue-why, pay-note, queue-actions, waiting-note, all-clear.
 *
 * Оформление к ним — их файл style/admin.css целиком.
 *
 * Отличается только дело: магазины вместо заведений.
 */
import { useEffect, useState } from 'react';
import { api, cached, putCache, dropCache, money, dateTime, type Me } from '../lib';

type Item = {
  id: string; kind: string; accountId: string; client: string;
  what: string; why: string | null; meta: string; amount: number | null;
  effect: string | null; actor: string | null; at: string | null;
  paymentId: string | null; requestId: string | null;
  can: { approve: boolean; decide: boolean; signup: boolean; call: boolean };
};

export default function Today({ me, goTo }: { me: Me; goTo: (t: any) => void }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ item: Item; yes: boolean } | null>(null);
  const [reason, setReason] = useState('');

  const load = async () => {
    const hit = cached('/today');
    if (hit) setData(hit.data);
    try {
      const d = await api('/today');
      setData(d); putCache('/today', d); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const isSuper = me.role === 'super';

  const run = async () => {
    if (!ask) return;
    const { item: it, yes } = ask;
    if (!yes && !reason.trim()) { setErr('Напишите причину — партнёр должен понять, что не так'); return; }
    setBusy(it.id);
    try {
      if (it.kind === 'payment') {
        yes ? await api(`/payments/${it.paymentId}/approve`, { method: 'POST' })
            : await api(`/payments/${it.paymentId}/reject`, { method: 'POST', body: { reason } });
      } else if (it.kind === 'request') {
        await api(`/requests/${it.requestId}/decide`,
          { method: 'POST', body: { approve: yes, note: reason || undefined } });
      } else if (it.kind === 'signup') {
        yes ? await api(`/signups/${it.accountId}/approve`, { method: 'POST', body: { trialDays: 14 } })
            : await api(`/signups/${it.accountId}/reject`, { method: 'POST', body: { reason } });
      }
      setAsk(null); setReason(''); dropCache(); await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  };

  if (err && !data) return <div className="err">{err}</div>;
  if (!data) return <div className="muted">Загрузка…</div>;

  return (
    <>
      {err && <div className="err">{err}</div>}

      {/* Их окно подтверждения: последствие крупно, две кнопки. */}
      {ask && (
        <div className="reveal" onClick={(e) => { if (e.target === e.currentTarget) setAsk(null); }}>
          <div className="ask-card">
            <b>{ask.item.client}</b>
            <p>{ask.item.what}</p>
            {ask.yes
              ? <p className="pay-note">{ask.item.effect ?? 'Подтвердить?'}</p>
              : <input value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
                  placeholder="Причина — партнёр должен понять, что не так" />}
            <div className="queue-actions">
              <button className="btn small ghost" onClick={() => { setAsk(null); setReason(''); }}>
                Отмена
              </button>
              <button className={`btn small ${ask.yes ? 'primary' : 'danger'}`}
                disabled={busy === ask.item.id} onClick={run}>
                {ask.yes ? 'Да, подтвердить' : 'Отклонить'}
              </button>
            </div>
          </div>
        </div>
      )}

      {data.total === 0 ? (
        <div className="all-clear">
          <b>Разобрано. Ни одного решения не ждёт</b>
          <p>{data.empty}</p>
          <p className="hint">
            {isSuper
              ? 'Новые оплаты, заявки и регистрации попадут на этот экран, а на пункте «Сегодня» загорится счётчик.'
              : 'Здесь появятся ваши клиенты, которым пора платить, и ответы платформы по заявкам.'}
          </p>
        </div>
      ) : data.groups.map((g: any) => (
        <section key={g.key} className="queue-group">
          <div className="queue-head">
            <h2>{g.title}</h2>
            <span className="count">{g.items.length}</span>
            <i>{g.hint}</i>
          </div>

          <div className="queue-list">
            {g.items.map((item: Item) => (
              <article key={item.id} className={`queue-item ${g.key}`}>
                <div className="queue-main">
                  <button className="link-name" onClick={() => goTo('clients')}>
                    {item.client}
                  </button>
                  <div className="queue-what">{item.what}</div>
                  <div className="sub">
                    {item.meta}
                    {item.actor && item.at ? ` · отметил ${item.actor}, ${dateTime(item.at)}` : ''}
                  </div>
                  {item.why && <div className="queue-why">{item.why}</div>}
                  {/* Последствие без нажатия — их приём: «продлит до
                      01.10.2026». Владелец читает результат, не трогая
                      мышь. */}
                  {item.effect && <div className="pay-note">{item.effect}</div>}
                </div>

                <div className="queue-actions">
                  {isSuper && item.kind === 'payment' && (
                    <>
                      <button className="btn small" disabled={busy === item.id}
                        onClick={() => setAsk({ item, yes: false })}>Отклонить…</button>
                      <button className="btn small primary" disabled={busy === item.id}
                        onClick={() => setAsk({ item, yes: true })}>Подтвердить…</button>
                    </>
                  )}
                  {isSuper && item.kind === 'request' && (
                    <>
                      <button className="btn small" disabled={busy === item.id}
                        onClick={() => setAsk({ item, yes: false })}>Отказать…</button>
                      <button className="btn small primary" disabled={busy === item.id}
                        onClick={() => setAsk({ item, yes: true })}>Одобрить…</button>
                    </>
                  )}
                  {isSuper && item.kind === 'signup' && (
                    <>
                      <button className="btn small"
                        onClick={() => setAsk({ item, yes: false })}>Отклонить…</button>
                      <button className="btn small primary"
                        onClick={() => setAsk({ item, yes: true })}>Одобрить…</button>
                    </>
                  )}
                  {/* Партнёру решение не рисуем: он всё равно не решает,
                      а мёртвая кнопка хуже отсутствующей. */}
                  {!isSuper && (item.kind === 'payment' || item.kind === 'request') && (
                    <span className="sub waiting-note">Ждёт решения платформы</span>
                  )}
                  {item.meta?.match(/\+?\d[\d\s()-]{8,}/) && (
                    <a className="btn small"
                      href={`tel:${item.meta.match(/\+?\d[\d\s()-]{8,}/)![0].replace(/\s/g, '')}`}>
                      Позвонить
                    </a>
                  )}
                  <button className="btn small ghost" onClick={() => goTo('clients')}>
                    Карточка
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
