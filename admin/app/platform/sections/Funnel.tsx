'use client';
/**
 * РАЗДЕЛ 5: «ВОРОНКА» — от знакомства до оплаты.
 *
 * Разметка и приёмы из их Funnel.tsx.
 *
 * ПЕРЕТАСКИВАНИЕ МЫШЬЮ И ПАЛЬЦЕМ ОДИНАКОВО — их главный приём здесь:
 * события УКАЗАТЕЛЯ, а не мыши, и ручка с touch-action: none, чтобы
 * палец таскал карточку, а не прокручивал столбец. Кому перетаскивать
 * неудобно — тот же сдвиг лежит в меню карточки.
 *
 * Порог в 6 пикселей: без него любой клик считался бы перетаскиванием,
 * и карточка прыгала бы от случайного движения руки.
 *
 * Заметка правится прямо в карточке. Отметка заявки показывает, что по
 * клиенту уже запрошено — иначе партнёр попросит второй раз.
 */
import { useRef, useState } from 'react';
import { useEffect } from 'react';
import { api, cached, putCache, dropCache, money, fullDate, daysWord, type Me } from '../lib';
import { RowMenu } from '../ui/RowMenu';
import { useToast } from '../ui/Toast';
import { humanError } from '../ui/errors';
import { requestMark } from '../ui/requestMark';
import { Failed, SkeletonCards, Empty , PageHead } from '../ui/States';

type Drag = { id: string; name: string; from: string; x: number; y: number; over: string | null };
type Grab = Drag & { moved: boolean; pointerId: number };

export default function Funnel({ me }: { me: Me }) {
  const isSuper = me.role === 'super';
  const [data, setData] = useState<any>(null);
  const [reqs, setReqs] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [partner, setPartner] = useState('all');
  const [noteText, setNoteText] = useState('');
  const grab = useRef<Grab | null>(null);

  const toast = useToast();

  const load = async () => {
    const hit = cached('/funnel');
    if (hit) setData(hit.data);
    try {
      const [f, r] = await Promise.all([
        api('/funnel'),
        api('/requests').catch(() => []),
      ]);
      setData(f); putCache('/funnel', f); setReqs(Array.isArray(r) ? r : []); setErr('');
    } catch (e: any) { if (!hit) setErr(humanError(e)); }
  };
  useEffect(() => { load(); }, []);

  const move = async (lead: any, stage: string) => {
    if (stage === lead.stage) return;
    const title = data.stages.find((s: any) => s.key === stage)?.title ?? stage;
    try {
      await api(`/funnel/${lead.id}`, { method: 'POST', body: { stage } });
      toast({ text: `«${lead.name}» → ${title}` });
      dropCache(); await load();
    } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
  };

  const saveNote = async (lead: any, text: string) => {
    if (text === (lead.note ?? '')) return;
    try {
      await api(`/funnel/${lead.id}`, { method: 'POST', body: { stage: lead.stage, note: text } });
      toast({ text: text ? 'Заметка сохранена' : 'Заметка убрана' });
      dropCache(); await load();
    } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
  };

  // ── перетаскивание: одни и те же события для мыши и пальца ──
  const onDown = (e: React.PointerEvent<HTMLElement>, lead: any) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = {
      id: lead.id, name: lead.name, from: lead.stage,
      x: e.clientX, y: e.clientY, over: null, moved: false, pointerId: e.pointerId,
    };
  };

  const onMove = (e: React.PointerEvent<HTMLElement>) => {
    const g = grab.current;
    if (!g || g.pointerId !== e.pointerId) return;
    // Порог: без него любой клик считался бы перетаскиванием, и
    // карточка прыгала бы от случайного движения руки.
    if (!g.moved && Math.abs(e.clientX - g.x) + Math.abs(e.clientY - g.y) < 6) return;
    g.moved = true;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const col = under?.closest('[data-stage]');
    const over = col instanceof HTMLElement ? col.dataset.stage ?? null : null;
    setDrag({ id: g.id, name: g.name, from: g.from, x: e.clientX, y: e.clientY, over });
  };

  const onUp = (e: React.PointerEvent<HTMLElement>, lead: any) => {
    const g = grab.current;
    const d = drag;
    grab.current = null;
    setDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (!g || !g.moved || !d || !d.over) return;
    move(lead, d.over);
  };

  /** Что уже запрошено по клиенту: чтобы не попросили второй раз. */
  const markFor = (id: string) => {
    for (const r of reqs.filter((x) => x.account_id === id)) {
      const m = requestMark({
        kind: r.kind, status: r.status,
        decidedAt: r.decided_at, decisionNote: r.decision_note,
      });
      if (m) return m;
    }
    return null;
  };

  if (err && !data) return <Failed text={err} onRetry={load} />;
  if (!data) return <SkeletonCards count={5} height={220} />;
  if (data.total === 0) return (
    <Empty title="Воронка пуста"
      text="Клиентов в воронке пока нет — заведите первого во вкладке «Клиенты»." />
  );

  // Отбор по партнёру появляется, только если партнёров больше одного:
  // список из одного пункта — это шум. Их приём.
  const partnerNames = Array.from(new Set(
    data.stages.flatMap((st: any) => st.cards.map((c: any) => c.partner ?? '—'))));

  const shown = data.stages.map((st: any) => {
    const cards = partner === 'all'
      ? st.cards
      : st.cards.filter((c: any) => (c.partner ?? '—') === partner);
    return {
      ...st,
      cards,
      // Сумма считается ИЗ ПОКАЗАННЫХ карточек, а не приходит со всей
      // воронки. Иначе при отборе по партнёру счётчик показывает
      // двоих, а сумма — деньги всех тридцати: цифра и содержимое
      // расходятся, и доверять столбцу больше нельзя.
      sum: cards.reduce((a: number, c: any) => a + (c.monthly ?? 0), 0),
    };
  });

  return (
    <>
      <PageHead title={'Воронка'} sub={isSuper
          ? 'Все клиенты платформы. Сумма в колонке — сколько денег в месяц стоит на этапе.'
          : 'Ваши клиенты. Двигайте карточку по мере работы — этап видит и платформа.'} />

      {me.role === 'super' && partnerNames.length > 1 && (
        <div className="toolbar">
          <select className="sorter" value={partner} onChange={(e) => setPartner(e.target.value)}>
            <option value="all">Все партнёры</option>
            {partnerNames.map((p: any) => (
              <option key={p} value={p}>{p === '—' ? 'Без партнёра' : p}</option>
            ))}
          </select>
        </div>
      )}

      {/* Пустой отбор объясняется словами: пустые столбцы читаются
          как поломка, а не как «у этого партнёра нет клиентов». */}
      {shown.every((st: any) => st.cards.length === 0) && (
        <p className="note">У этого партнёра пока нет клиентов.</p>
      )}

      <div className="funnel-cols">
        {shown.map((st: any) => (
          <section key={st.key} data-stage={st.key}
            className={`funnel-col ${drag && drag.over === st.key && drag.from !== st.key ? 'over' : ''}`}>

            <div className="col-top">
              <b>{st.title}</b>
              <span className="count">{st.cards.length}</span>
            </div>
            <div className="sub">{st.hint}</div>
            {/* Сумма на этапе: воронка про деньги, а не про карточки. */}
            <div className="col-sum">{st.sum > 0 ? `${money(st.sum)}/мес` : '—'}</div>

            {st.cards.length === 0 && <p className="empty">пусто</p>}

            {st.cards.map((r: any) => {
              const mark = markFor(r.id);
              return (
                <article key={r.id} className={`lead ${drag?.id === r.id ? 'dragging' : ''}`}>
                  <div className="lead-top">
                    {/* Ручка с touch-action: none — палец таскает
                        карточку, а не прокручивает столбец. */}
                    <span className="grip" title="перетащить в другой этап"
                      onPointerDown={(e) => onDown(e, r)}
                      onPointerMove={onMove}
                      onPointerUp={(e) => onUp(e, r)}
                      onPointerCancel={() => { grab.current = null; setDrag(null); }}>⋮⋮</span>
                    <button className="link-name"
                      onClick={() => { window.location.hash = `#/client/${r.id}`; }}>
                      {r.name}
                    </button>

                    {/* Кому перетаскивать неудобно — тот же сдвиг здесь. */}
                    <RowMenu label="Сдвинуть" actions={[
                      ...data.stages.filter((x: any) => x.key !== st.key).map((x: any) => ({
                        label: `→ ${x.title}`,
                        hint: x.hint,
                        onClick: () => move(r, x.key),
                      })),
                      // Вернуть к выводу из фактов. Без этого карточка,
                      // двинутая в сердцах, застревала навсегда: клиент
                      // платит, а в воронке лежит в «Отказе».
                      ...(r.isManual ? [{
                        label: 'Снова по фактам',
                        hint: 'этап будет выводиться сам',
                        onClick: () => move(r, 'auto'),
                      }] : []),
                    ]} />
                  </div>

                  <div className="sub">{[r.city, r.owner].filter(Boolean).join(' · ') || '—'}</div>
                  {r.ownerPhone && (
                    <a className="sub phone" href={`tel:${r.ownerPhone}`}>{r.ownerPhone}</a>
                  )}
                  {me.role === 'super' && r.partner && (
                    <div className="sub">партнёр: {r.partner}</div>
                  )}

                  {r.monthly > 0 && <div className="lead-price">{money(r.monthly)}/мес</div>}
                  {r.paidUntil && <div className="sub">оплачено до {fullDate(r.paidUntil)}</div>}

                  {/* Молчание — главный признак умирающей сделки: она
                      умирает не от отказа, а от того, что о ней забыли.

                      Их формулировка вернее моей: ДАТА точнее счёта
                      дней, а «ещё не касались» — отдельное состояние,
                      которого у меня не было вовсе. Клиент, к которому
                      не притрагивались ни разу, опаснее того, с кем
                      говорили неделю назад. */}
                  <div className={`sub touched${r.cold ? ' cold' : ''}`}>
                    {r.touchedAt
                      ? `касались ${fullDate(r.touchedAt)}${
                          r.daysSilent != null && r.daysSilent >= 7
                            ? ` · молчим ${daysWord(-r.daysSilent).replace(' назад', '')}` : ''}`
                      : 'ещё не касались'}
                  </div>

                  {/* Что уже запрошено: иначе партнёр попросит второй
                      раз, а владелец решит дважды. */}
                  {mark && <div className={`req-mark ${mark.tone}`}>{mark.text}</div>}

                  <div className="sub">
                    {!r.isManual
                      ? 'этап выведен из фактов'
                      : r.derivedStage && r.derivedStage !== r.stage
                        // Факты СПОРЯТ с ручным этапом: клиент платит,
                        // а карточка в «Отказе». Ручной этап сильнее —
                        // но молчать об этом нельзя, иначе живой
                        // клиент так и останется в архиве.
                        ? `поставлен вручную · по фактам «${
                            data.stages.find((x: any) => x.key === r.derivedStage)?.title
                            ?? r.derivedStage}»`
                        : 'этап поставлен вручную'}
                  </div>

                  {/* Заметка правится прямо в карточке: это не
                      деньги, лист подтверждения тут лишний. */}
                  {noteFor === r.id ? (
                    <div className="lead-note-edit">
                      <input value={noteText} autoFocus
                        placeholder="О чём договорились"
                        onChange={(e) => setNoteText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { saveNote(r, noteText); setNoteFor(null); }
                          if (e.key === 'Escape') setNoteFor(null);
                        }} />
                      <div className="lead-actions">
                        <button className="btn small" onClick={() => setNoteFor(null)}>Отмена</button>
                        <button className="btn small primary"
                          onClick={() => { saveNote(r, noteText); setNoteFor(null); }}>
                          Сохранить
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {r.note && <p className="lead-note">{r.note}</p>}
                      <div className="lead-actions">
                        <button className="btn small ghost"
                          onClick={() => { setNoteFor(r.id); setNoteText(r.note ?? ''); }}>
                          {r.note ? 'Изменить заметку' : '+ заметка'}
                        </button>
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </section>
        ))}
      </div>

      {/* Призрак под пальцем: видно, что именно тащишь. */}
      {drag && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>{drag.name}</div>
      )}
    </>
  );
}
