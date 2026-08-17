'use client';
/**
 * РАЗДЕЛ 5: «ВОРОНКА».
 *
 * Разметка из их Funnel.tsx: funnel-cols, funnel-col, col-top, count,
 * col-sum, lead, lead-top, grip, sub, phone, touched, lead-price,
 * lead-note, lead-note-edit, lead-actions, empty, sorter.
 *
 * Их приёмы взяты целиком: перетаскивание карточки за ручку, сумма на
 * каждом столбце, заметка правится прямо в карточке.
 *
 * Отличие по делу: этап выводится из фактов на СЕРВЕРЕ, а не при
 * отрисовке — два человека, открывшие воронку разом, видят одно и то же.
 */
import { useEffect, useState } from 'react';
import { api, cached, putCache, dropCache, money, fullDate, type Me } from '../lib';

export default function Funnel({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState<{ id: string; from: string; over?: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const load = async () => {
    const hit = cached('/funnel');
    if (hit) setData(hit.data);
    try {
      const d = await api('/funnel');
      setData(d); putCache('/funnel', d); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const move = async (id: string, stage: string, text?: string) => {
    try {
      await api(`/funnel/${id}`, { method: 'POST', body: { stage, note: text } });
      setEditing(null); setNote(''); dropCache(); await load();
    } catch (e: any) { setErr(e.message); }
  };

  if (err && !data) return <div className="err">{err}</div>;
  if (!data) return <div className="muted">Загрузка…</div>;

  return (
    <>
      {err && <div className="err">{err}</div>}

      <div className="funnel-cols">
        {data.stages.map((st: any) => (
          <section key={st.key}
            className={`funnel-col ${drag && drag.over === st.key && drag.from !== st.key ? 'over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); if (drag) setDrag({ ...drag, over: st.key }); }}
            onDrop={() => { if (drag && drag.from !== st.key) move(drag.id, st.key); setDrag(null); }}>

            <div className="col-top">
              <b>{st.title}</b>
              <span className="count">{st.cards.length}</span>
            </div>
            <div className="sub">{st.hint}</div>
            {/* Сумма на этапе: воронка про деньги, а не про карточки. */}
            <div className="col-sum">{st.sum > 0 ? `${money(st.sum)}/мес` : '—'}</div>

            {st.cards.length === 0 && <p className="empty">пусто</p>}

            {st.cards.map((r: any) => (
              <article key={r.id} className={`lead ${drag?.id === r.id ? 'dragging' : ''}`}
                draggable onDragStart={() => setDrag({ id: r.id, from: st.key })}
                onDragEnd={() => setDrag(null)}>

                <div className="lead-top">
                  <span className="grip" title="перетащить в другой этап">⋮⋮</span>
                  <b>{r.name}</b>
                </div>

                <div className="sub">{[r.city, r.owner].filter(Boolean).join(' · ') || '—'}</div>
                {r.ownerPhone && <a className="sub phone" href={`tel:${r.ownerPhone}`}>{r.ownerPhone}</a>}
                {me.role === 'super' && r.partner && <div className="sub">партнёр: {r.partner}</div>}

                {r.monthly > 0 && <div className="lead-price">{money(r.monthly)}/мес</div>}
                {r.paidUntil && <div className="sub">оплачено до {fullDate(r.paidUntil)}</div>}

                {/* Молчание — главный признак умирающей сделки: она
                    умирает не от отказа, а от того, что о ней забыли. */}
                {r.daysSilent != null && (
                  <div className={`sub touched${r.cold ? ' cold' : ''}`}>
                    молчим {r.daysSilent} дн.
                  </div>
                )}

                {/* Откуда взялся этап: выведен из фактов или поставлен
                    руками. Это разные вещи, и путать их нельзя. */}
                <div className="sub">
                  {r.isManual ? 'этап поставлен вручную' : 'этап выведен из фактов'}
                </div>

                {editing === r.id ? (
                  <div className="lead-note-edit">
                    <input value={note} autoFocus
                      onChange={(e) => setNote(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') move(r.id, r.stage, note); }}
                      placeholder="О чём договорились" />
                    <div className="lead-actions">
                      <button className="btn small primary"
                        onClick={() => move(r.id, r.stage, note)}>Сохранить</button>
                      <button className="btn small ghost"
                        onClick={() => { setEditing(null); setNote(''); }}>Отмена</button>
                    </div>
                  </div>
                ) : (
                  <>
                    {r.note && <div className="lead-note">{r.note}</div>}
                    <div className="lead-actions">
                      <button className="btn small ghost"
                        onClick={() => { setEditing(r.id); setNote(r.note ?? ''); }}>
                        {r.note ? 'Заметка' : '+ заметка'}
                      </button>
                      {/* Кому перетаскивать неудобно — тот же сдвиг
                          списком. Их приём. */}
                      <select className="sorter" value={r.stage}
                        onChange={(e) => move(r.id, e.target.value)}>
                        {data.stages.map((x: any) => (
                          <option key={x.key} value={x.key}>{x.title}</option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
              </article>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
