'use client';
/**
 * РАЗДЕЛ 3: «ДЕНЬГИ».
 *
 * Разметка из их main.tsx: pay-grid, pay, waiting, pay-top, pay-who,
 * pay-amount, pay-state, badge st-*, dot, pay-note, pay-comment,
 * pay-actions, toolbar, check, sub.
 *
 * У них это НЕ таблица, а сетка карточек: у оплаты мало полей и они
 * разной длины — в таблице половина ячеек пустует.
 *
 * Итоги считаются по показанным строкам: при отборе «ждут» доход ноль,
 * а не итог по всем. Ждущие — это ещё не деньги.
 */
import { useEffect, useState } from 'react';
import { api, cached, putCache, dropCache, money, fullDate, dateTime, type Me } from '../lib';

export default function Money({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [onlyPending, setOnlyPending] = useState(true);
  const [err, setErr] = useState('');
  const [ask, setAsk] = useState<{ p: any; yes: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);

  const load = async (pending = onlyPending) => {
    const path = '/payments' + (pending ? '?status=pending' : '');
    const hit = cached(path);
    if (hit) setData(hit.data);
    try {
      const d = await api(path);
      setData(d); putCache(path, d); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const open = async (p: any, yes: boolean) => {
    setReason('');
    if (yes) {
      try { setPreview(await api(`/payments/${p.id}/preview`)); }
      catch (e: any) { setErr(e.message); return; }
    } else setPreview(null);
    setAsk({ p, yes });
  };

  const run = async () => {
    if (!ask) return;
    if (!ask.yes && !reason.trim()) { setErr('Напишите причину'); return; }
    setBusy(true);
    try {
      ask.yes
        ? await api(`/payments/${ask.p.id}/approve`, { method: 'POST' })
        : await api(`/payments/${ask.p.id}/reject`, { method: 'POST', body: { reason } });
      setAsk(null); setPreview(null); setReason(''); dropCache(); await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (err && !data) return <div className="err">{err}</div>;
  if (!data) return <div className="muted">Загрузка…</div>;

  const t = data.totals;

  return (
    <>
      {err && <div className="err">{err}</div>}

      {ask && (
        <div className="reveal" onClick={(e) => { if (e.target === e.currentTarget) setAsk(null); }}>
          <div className="ask-card">
            <b>{ask.p.client}</b>
            <p>{money(ask.p.amount)} · {ask.p.months} мес.</p>
            {ask.yes ? (
              <>
                {/* Последствие до нажатия: до какой даты продлит и
                    сколько достанется партнёру. Считает сервер. */}
                {preview && (
                  <p className="pay-note">
                    продлит до {fullDate(preview.paidUntil)} · партнёру {money(preview.partnerShare)}
                    {' '}({preview.partnerPercent}%) · платформе {money(preview.platformShare)}
                  </p>
                )}
              </>
            ) : (
              <input value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
                placeholder="Причина — партнёр должен понять, что не так" />
            )}
            <div className="pay-actions">
              <button className="btn ghost" onClick={() => { setAsk(null); setReason(''); }}>
                Отмена
              </button>
              <button className={`btn ${ask.yes ? 'primary' : 'danger'}`}
                disabled={busy} onClick={run}>
                {ask.yes ? 'Да, подтвердить' : 'Отклонить'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="cards">
        <div className="card"><span>Записей</span><b>{t.count}</b></div>
        <div className="card money"><span>Подтверждено</span><b>{money(t.amount)}</b></div>
        <div className="card"><span>Партнёрам</span><b>{money(t.partnerShare)}</b></div>
        <div className="card ok"><span>Платформе</span><b>{money(t.platformShare)}</b></div>
      </div>

      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={onlyPending}
            onChange={(e) => { setOnlyPending(e.target.checked); load(e.target.checked); }} />
          Только ждущие подтверждения
        </label>
        <span className="sub">
          В доход идут только подтверждённые: ждущие и отклонённые — это ещё не деньги
        </span>
      </div>

      {data.rows.length === 0 ? (
        <div className="all-clear">
          <b>{onlyPending ? 'Всё подтверждено' : 'Оплат нет'}</b>
          <p>{onlyPending
            ? 'Ни одна оплата не ждёт решения.'
            : 'При этом отборе записей не нашлось.'}</p>
        </div>
      ) : (
        <div className="pay-grid">
          {data.rows.map((p: any) => (
            <article key={p.id} className={`pay ${p.status === 'pending' ? 'waiting' : ''}`}>
              <div className="pay-top">
                <div className="pay-who">
                  <b>{p.client}</b>
                  <div className="sub">
                    {p.method} · отметил {p.partner ?? 'клиент'} · {dateTime(p.createdAt)}
                  </div>
                </div>
                <div className="pay-amount">
                  <b>{money(p.amount)}</b>
                  <div className="sub">{p.months} мес.</div>
                </div>
              </div>

              <div className="pay-state">
                {p.status === 'pending' && (
                  <span className="badge st-pending"><i className="dot" />ждёт подтверждения</span>
                )}
                {p.status === 'approved' && (
                  <span className="badge st-active"><i className="dot" />подтверждена</span>
                )}
                {p.status === 'rejected' && (
                  <span className="badge st-expired"><i className="dot" />отклонена</span>
                )}

                {/* Оплаченный отрезок записан при подтверждении и не
                    пересчитывается: это ответ на вопрос «за что я
                    платил», он не меняется от того, что было потом. */}
                {p.status === 'approved' && p.periodFrom && (
                  <span className="pay-note">
                    за {fullDate(p.periodFrom)} — {fullDate(p.periodTo)} ·
                    {' '}партнёру {money(p.partnerShare)} · платформе {money(p.platformShare)}
                  </span>
                )}
                {p.status === 'rejected' && p.rejectReason && (
                  <span className="pay-note">{p.rejectReason}</span>
                )}
              </div>

              {p.comment && <div className="pay-comment">{p.comment}</div>}

              {p.canApprove && (
                <div className="pay-actions">
                  <button className="btn" disabled={busy}
                    onClick={() => open(p, false)}>Отклонить…</button>
                  <button className="btn primary" disabled={busy}
                    onClick={() => open(p, true)}>Подтвердить…</button>
                </div>
              )}
              {/* Партнёру решение не рисуем: он всё равно не решает. */}
              {p.status === 'pending' && !p.canApprove && (
                <div className="pay-actions">
                  <span className="sub waiting-note">Ждёт решения платформы</span>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </>
  );
}
