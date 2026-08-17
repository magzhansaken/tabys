'use client';
/**
 * РАЗДЕЛ 1: «СЕГОДНЯ» — лента решений.
 *
 * Раскладка списана с кабинета соседнего проекта до мелочей:
 *   «Сегодня, 17 августа» — с датой: кабинет открывают утром и держат
 *     весь день, без даты непонятно, свежее ли это;
 *   «1 решение ждёт вас» — числом словами, голая цифра не говорит,
 *     что с ней делать;
 *   заголовок очереди с числом и объяснением под ним;
 *   ПОСЛЕДСТВИЕ ПРЯМО В КАРТОЧКЕ: «продлит до 01.10.2026». Владелец
 *     видит результат НЕ НАЖИМАЯ — это лучше окна с предпросмотром;
 *   «отметил Ерлан · 01.08, 17:01» — чьё решение подтверждаешь;
 *   многоточие на кнопках: «Подтвердить…» значит, что спросят ещё раз.
 *     Кнопка без многоточия должна делать сразу.
 */
import { useEffect, useState } from 'react';
import { P, api, cached, putCache, dropCache, money, dateTime, type Me } from '../lib';

type Item = {
  id: string; kind: string; accountId: string; client: string;
  what: string; why: string | null; meta: string; amount: number | null;
  effect: string | null; actor: string | null; at: string | null;
  paymentId: string | null; requestId: string | null;
  can: { approve: boolean; decide: boolean; signup: boolean; call: boolean };
};
type Group = { key: string; title: string; hint: string; items: Item[] };

const TONE: Record<string, string> = {
  overdue: '#8f3a2c', today: '#b8761c', waiting: '#7a4e10', soon: '#8b9391',
};

export default function Today({ me, goTo }: { me: Me; goTo: (t: any) => void }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ id: string; mode: 'ok' | 'no' } | null>(null);
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

  const act = async (it: Item, yes: boolean) => {
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
      setAsking(null); setReason(''); dropCache(); await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  };

  if (err && !data) return <div className="pl-err">{err}</div>;
  if (!data) return <div className="pl-load">Загрузка…</div>;

  return (
    <>
      <style>{CSS}</style>

      {/* Дата и счёт дел словами — как у них. */}
      <div className="td-head">
        <div className="td-date">Сегодня, {data.dateLabel}</div>
        <div className="td-count">
          {data.headline ?? 'ничего не ждёт решения'}
        </div>
      </div>

      {err && <div className="pl-err">{err}</div>}

      {data.total === 0 ? (
        <div className="td-empty">
          <b>Ничего не ждёт решения</b>
          <span>{data.empty}</span>
        </div>
      ) : data.groups.map((g: Group) => (
        <section key={g.key} className="td-group">
          <h2 style={{ color: TONE[g.key] }}>{g.title}</h2>
          <div className="td-hint"><b>{g.items.length}</b> {g.hint}</div>

          {g.items.map((it) => (
            <article key={it.id} className="td-card"
              style={{ borderLeftColor: TONE[g.key] }}>
              <div className="td-client">{it.client}</div>
              <div className="td-what">{it.what}</div>

              {/* Кто отметил и когда — чьё решение подтверждаешь. */}
              {(it.actor || it.at) && (
                <div className="td-actor">
                  {it.actor ? `отметил ${it.actor}` : ''}
                  {it.at ? ` · ${dateTime(it.at)}` : ''}
                </div>
              )}

              {it.why && <div className="td-why">«{it.why}»</div>}
              {it.meta && <div className="td-meta">{it.meta}</div>}

              {/* ПОСЛЕДСТВИЕ БЕЗ НАЖАТИЯ. Главное, что взято у донора:
                  владелец читает результат, не трогая мышь. */}
              {it.effect && <div className="td-effect">{it.effect}</div>}

              {asking?.id === it.id ? (
                <div className="td-ask">
                  {asking.mode === 'no' ? (
                    <>
                      <input value={reason} autoFocus
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Причина — партнёр должен понять, что не так" />
                      <div className="td-btns">
                        <button className="no" disabled={busy === it.id}
                          onClick={() => { if (!reason.trim()) { setErr('Напишите причину'); return; } act(it, false); }}>
                          Отклонить
                        </button>
                        <button onClick={() => { setAsking(null); setReason(''); }}>Отмена</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="td-confirm">{it.effect ?? 'Подтвердить?'}</div>
                      <div className="td-btns">
                        <button className="ok" disabled={busy === it.id}
                          onClick={() => act(it, true)}>Да, подтвердить</button>
                        <button onClick={() => setAsking(null)}>Отмена</button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="td-btns">
                  {/* Многоточие значит: спросят ещё раз. Кнопка без
                      многоточия должна делать сразу.

                      У просроченных и «скоро платить» решать нечего —
                      там только позвонить и открыть карточку. Рисовать
                      «Подтвердить» было бы обманом: подтверждать
                      нечего. */}
                  {(it.can.approve || it.can.decide || it.can.signup) && (
                    <>
                      <button onClick={() => setAsking({ id: it.id, mode: 'no' })}>
                        Отклонить…
                      </button>
                      <button className="ok" onClick={() => setAsking({ id: it.id, mode: 'ok' })}>
                        {it.kind === 'signup' ? 'Открыть доступ…' : 'Подтвердить…'}
                      </button>
                    </>
                  )}
                  {/* Телефон ссылкой: половина работы — это позвонить. */}
                  {it.kind === 'tenant' && it.meta?.match(/\+?\d[\d\s()-]{8,}/) && (
                    <a className="td-call"
                      href={`tel:${it.meta.match(/\+?\d[\d\s()-]{8,}/)![0].replace(/\s/g, '')}`}>
                      Позвонить
                    </a>
                  )}
                  <button onClick={() => goTo('clients')}>Карточка</button>
                </div>
              )}
            </article>
          ))}
        </section>
      ))}
    </>
  );
}

const CSS = `
.td-head { margin-bottom: 20px; }
.td-date { font-family: ${P.display}; font-size: 26px; color: ${P.ink};
  letter-spacing: -.01em; }
.td-count { font-size: 14px; color: ${P.dim}; margin-top: 2px; }

.td-group { margin-bottom: 26px; }
.td-group h2 { font-family: ${P.display}; font-weight: 400; font-size: 19px;
  margin: 0; letter-spacing: -.01em; }
.td-hint { font-size: 13px; color: ${P.dim}; margin: 2px 0 10px; }
.td-hint b { color: ${P.ink}; font-weight: 600; }

.td-card {
  background: ${P.card}; border: 1px solid ${P.line}; border-left: 3px solid;
  border-radius: ${P.r.md}px; padding: 14px 16px; margin-bottom: 10px;
}
.td-client { font-family: ${P.display}; font-size: 17px; color: ${P.ink}; }
.td-what { font-size: 15px; color: ${P.ink}; margin-top: 3px; }
.td-actor { font-size: 12.5px; color: ${P.faint}; margin-top: 3px; }
.td-why { font-size: 14px; color: ${P.ink}; font-style: italic; margin-top: 6px; }
.td-meta { font-size: 13px; color: ${P.dim}; margin-top: 3px; }

/* Последствие: тише названия, но заметно — это ответ на вопрос
   «что будет, если я нажму». */
.td-effect {
  font-size: 13.5px; color: ${P.accentSoft}; margin-top: 8px;
  background: ${P.sunk}; border-radius: ${P.r.sm}px; padding: 6px 9px;
  display: inline-block;
}

.td-btns { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.td-btns button {
  min-height: 38px; padding: 0 14px; border-radius: ${P.r.sm}px;
  border: 1px solid ${P.line}; background: ${P.card}; color: ${P.ink};
  font-size: 14px; cursor: pointer;
}
.td-btns button:hover { background: ${P.sunk}; }
.td-btns button.ok { background: ${P.accent}; border-color: ${P.accent};
  color: ${P.accentInk}; font-weight: 600; }
.td-btns button.ok:hover { background: ${P.accentDark}; }
.td-btns button.no { background: ${P.danger}; border-color: ${P.danger};
  color: #fff; font-weight: 600; }
.td-btns button:disabled { opacity: .6; cursor: default; }
.td-call {
  min-height: 38px; padding: 0 14px; border-radius: ${P.r.sm}px;
  border: 1px solid ${P.line}; background: ${P.card}; color: ${P.accentSoft};
  font-size: 14px; text-decoration: none; display: inline-flex; align-items: center;
}
.td-call:hover { background: ${P.sunk}; }

.td-ask { margin-top: 12px; }
.td-ask input {
  width: 100%; min-height: 42px; padding: 0 12px; font-size: 15px;
  border: 1px solid ${P.line}; border-radius: ${P.r.sm}px; box-sizing: border-box;
}
.td-confirm { font-size: 14.5px; color: ${P.ink}; }

.td-empty { background: ${P.card}; border: 1px solid ${P.line};
  border-radius: ${P.r.md}px; padding: 40px 20px; text-align: center; }
.td-empty b { display: block; font-family: ${P.display}; font-size: 19px;
  color: ${P.ink}; margin-bottom: 6px; }
.td-empty span { font-size: 14px; color: ${P.dim}; }

.pl-load { color: ${P.dim}; padding: 20px; }
`;
