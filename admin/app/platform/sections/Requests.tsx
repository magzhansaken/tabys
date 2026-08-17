'use client';
/**
 * РАЗДЕЛ 4: «ЗАЯВКИ».
 *
 * Разметка из их main.tsx: req-list, req, waiting, req-head, req-what,
 * req-why, req-state, badge st-*, dot, pay-note, pay-actions, toolbar,
 * check, sub.
 *
 * Одобрение САМО выполняет действие: одобрил вторую кассу — строка
 * счёта появилась. Перед этим показывается последствие — у них кнопка
 * просто делала.
 */
import { useEffect, useState } from 'react';
import { api, cached, putCache, dropCache, dateTime, type Me } from '../lib';

const KIND: Record<string, string> = {
  device: 'Просит устройство', tariff: 'Просит смену тарифа',
  grace: 'Просит отсрочку', other: 'Прочее',
};

export default function Requests({ me }: { me: Me }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [onlyPending, setOnlyPending] = useState(true);
  const [err, setErr] = useState('');
  const [ask, setAsk] = useState<{ r: any; yes: boolean } | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (pending = onlyPending) => {
    const path = '/requests' + (pending ? '?status=pending' : '');
    const hit = cached(path);
    if (hit) setRows(hit.data);
    try {
      const d = await api(path);
      setRows(d); putCache(path, d); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const open = async (r: any, yes: boolean) => {
    setReason('');
    if (yes) {
      try { setPreview(await api(`/requests/${r.id}/preview`)); }
      catch (e: any) { setErr(e.message); return; }
    } else setPreview(null);
    setAsk({ r, yes });
  };

  const run = async () => {
    if (!ask) return;
    if (!ask.yes && !reason.trim()) { setErr('Напишите причину отказа'); return; }
    setBusy(true);
    try {
      await api(`/requests/${ask.r.id}/decide`,
        { method: 'POST', body: { approve: ask.yes, note: reason || undefined } });
      setAsk(null); setPreview(null); setReason(''); dropCache(); await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  if (err && !rows) return <div className="err">{err}</div>;
  if (!rows) return <div className="muted">Загрузка…</div>;

  const isSuper = me.role === 'super';

  return (
    <>
      {err && <div className="err">{err}</div>}

      {ask && (
        <div className="reveal" onClick={(e) => { if (e.target === e.currentTarget) setAsk(null); }}>
          <div className="ask-card">
            <b>{ask.r.client}</b>
            <p>{KIND[ask.r.kind] ?? ask.r.kind}</p>
            {ask.yes ? (
              /* Что именно произойдёт: одобрение выполняет действие,
                 а не ставит отметку. */
              preview && <p className="pay-note">{preview.effect}</p>
            ) : (
              <input value={reason} autoFocus onChange={(e) => setReason(e.target.value)}
                placeholder="Причина отказа — партнёр должен понять, что не так" />
            )}
            <div className="pay-actions">
              <button className="btn ghost" onClick={() => { setAsk(null); setReason(''); }}>
                Отмена
              </button>
              <button className={`btn ${ask.yes ? 'primary' : 'danger'}`}
                disabled={busy} onClick={run}>
                {ask.yes ? 'Да, одобрить' : 'Отказать'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={onlyPending}
            onChange={(e) => { setOnlyPending(e.target.checked); load(e.target.checked); }} />
          Только ждущие решения
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="all-clear">
          <b>{onlyPending ? 'Всё решено' : 'Заявок нет'}</b>
          <p>{onlyPending
            ? 'Ни одна заявка не ждёт ответа.'
            : 'При этом отборе записей не нашлось.'}</p>
        </div>
      ) : (
        <div className="req-list">
          {rows.map((r: any) => (
            <article key={r.id} className={`req ${r.status === 'pending' ? 'waiting' : ''}`}>
              <div className="req-head">
                <b>{r.client}</b>
                <span className="sub">{r.author ?? '—'} · {dateTime(r.created_at)}</span>
              </div>

              <div className="req-what">{KIND[r.kind] ?? r.kind}</div>
              {r.comment && <div className="req-why">{r.comment}</div>}

              <div className="req-state">
                {r.status === 'pending' && (
                  <span className="badge st-pending"><i className="dot" />ждёт решения</span>
                )}
                {r.status === 'approved' && (
                  <span className="badge st-active"><i className="dot" />одобрено</span>
                )}
                {r.status === 'rejected' && (
                  <span className="badge st-expired"><i className="dot" />отказано</span>
                )}
                {r.decision_note && <span className="pay-note">{r.decision_note}</span>}

                {r.status === 'pending' && isSuper && (
                  <div className="pay-actions">
                    <button className="btn" disabled={busy}
                      onClick={() => open(r, false)}>Отказать…</button>
                    <button className="btn primary" disabled={busy}
                      onClick={() => open(r, true)}>Одобрить…</button>
                  </div>
                )}
                {/* Партнёру решение не рисуем: мёртвая кнопка хуже
                    отсутствующей. */}
                {r.status === 'pending' && !isSuper && (
                  <span className="sub waiting-note">Ждёт решения платформы</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
