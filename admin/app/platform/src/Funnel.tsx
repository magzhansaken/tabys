/*
 * Воронка: от знакомства до оплаты.
 *
 * Партнёр видит своих, владелец платформы — всех и может отобрать по
 * партнёру. Этап выводится из фактов, пока его не двигали руками:
 * заплатил — «Оплатил», идёт пробный — «Пробный». Ручной сдвиг
 * сильнее, потому что человек знает о клиенте больше, чем база.
 *
 * Карточку двигают перетаскиванием — мышью и пальцем одинаково:
 * события указателя, а не мыши, и ручка с touch-action: none, чтобы
 * палец таскал карточку, а не прокручивал колонку. Кому перетаскивать
 * неудобно — тот же сдвиг лежит в меню карточки.
 *
 * Заметка правится прямо в карточке. Системных окошек больше нет.
 */
import { useRef, useState } from 'react';
import { humanError } from './ui/errors';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TenantList, TenantRequestRow } from './contracts';
import { call, money, requestMark } from './main';
import { RowMenu } from './ui/RowMenu';
import { Failed, PageHead, SkeletonCards } from './ui/States';
import { useToast } from './ui/Toast';

type Lead = {
  id: string; name: string; city: string | null;
  ownerName: string | null; ownerPhone: string | null;
  status: string; paidUntil: string | null;
  stage: string; note: string | null;
  touchedAt: string | null; partnerName: string | null;
};

const STAGES: { key: string; title: string; hint: string }[] = [
  { key: 'NEW', title: 'Новые', hint: 'нашли, ещё не говорили' },
  { key: 'CONTACTED', title: 'Связались', hint: 'разговор идёт' },
  { key: 'TRIAL', title: 'Пробный', hint: 'работает бесплатно' },
  { key: 'PAID', title: 'Оплатил', hint: 'деньги пришли' },
  { key: 'LOST', title: 'Отказ', hint: 'не сложилось' },
];

const dt = (v: string | null) => (v ? new Date(v).toLocaleDateString('ru-RU') : '—');

type Drag = {
  id: string; name: string; from: string;
  x: number; y: number; over: string | null;
};

export function Funnel({ token, isSuper }: { token: string; isSuper: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [partner, setPartner] = useState('all');
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  const grab = useRef<{ id: string; name: string; from: string; x: number; y: number; moved: boolean; pointerId: number } | null>(null);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['leads'],
    queryFn: () => call<{ rows: Lead[] }>('/leads', { token }),
  });

  /* Цену берём из списка клиентов: тот же ключ, что у вкладки «Клиенты». */
  const tenants = useQuery({
    queryKey: ['tenants'],
    queryFn: () => call<TenantList>('/tenants', { token }),
  });

  /* Заявки — тем же ключом, что вкладка «Заявки»: партнёр должен
     видеть решение там, где ведёт клиента, а не искать его отдельно. */
  const reqs = useQuery({
    queryKey: ['requests', false],
    queryFn: () => call<TenantRequestRow[]>('/requests', { token }),
  });
  const markFor = (tenantId: string) => {
    for (const r of (reqs.data ?? []).filter((x) => x.tenantId === tenantId)) {
      const m = requestMark(r);
      if (m) return m;
    }
    return null;
  };
  const priceOf = (id: string): number =>
    (tenants.data?.rows ?? []).find((t) => t.id === id)?.planPrice ?? 0;

  const set = useMutation({
    mutationFn: (v: { tenantId: string; stage?: string; note?: string }) =>
      call('/leads/set', { method: 'POST', token, body: v }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['leads'] });
      void qc.invalidateQueries({ queryKey: ['tenants'] });
    },
    onError: (e: Error) => toast({ text: humanError(e), kind: 'err' }),
  });

  const move = (lead: Lead, stage: string) => {
    if (stage === lead.stage) return;
    const title = STAGES.find((s) => s.key === stage)?.title ?? stage;
    set.mutate({ tenantId: lead.id, stage }, {
      onSuccess: () => toast({ text: `«${lead.name}» → ${title}` }),
    });
  };

  const saveNote = (lead: Lead) => {
    const text = noteText.trim();
    setNoteFor(null);
    if (text === (lead.note ?? '')) return;
    set.mutate({ tenantId: lead.id, note: text }, {
      onSuccess: () => toast({ text: text ? 'Заметка сохранена' : 'Заметка убрана' }),
    });
  };

  // ── перетаскивание: одни и те же события для мыши и пальца
  const onDown = (e: React.PointerEvent<HTMLElement>, lead: Lead) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = {
      id: lead.id, name: lead.name, from: lead.stage,
      x: e.clientX, y: e.clientY, moved: false, pointerId: e.pointerId,
    };
  };

  const onMove = (e: React.PointerEvent<HTMLElement>) => {
    const g = grab.current;
    if (!g || g.pointerId !== e.pointerId) return;
    if (!g.moved && Math.abs(e.clientX - g.x) + Math.abs(e.clientY - g.y) < 6) return;
    g.moved = true;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const col = under?.closest('[data-stage]');
    const over = col instanceof HTMLElement ? col.dataset.stage ?? null : null;
    setDrag({ id: g.id, name: g.name, from: g.from, x: e.clientX, y: e.clientY, over });
  };

  const onUp = (e: React.PointerEvent<HTMLElement>, lead: Lead) => {
    const g = grab.current;
    const d = drag;
    grab.current = null;
    setDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!g || !g.moved || !d || !d.over) return;
    move(lead, d.over);
  };

  const rows = (data?.rows ?? []).filter((r) => partner === 'all' || (r.partnerName ?? '—') === partner);
  const partnerNames = [...new Set((data?.rows ?? []).map((r) => r.partnerName ?? '—'))]
    .sort((a, b) => a.localeCompare(b, 'ru'));

  return (
    <>
      <PageHead
        title="Воронка"
        sub={isSuper
          ? 'Все клиенты платформы. Сумма в колонке — сколько денег в месяц стоит на этапе.'
          : 'Ваши клиенты. Двигайте карточку по мере работы — этап видит и платформа.'}
        actions={isSuper && partnerNames.length > 1 ? (
          <select className="sorter" value={partner} onChange={(e) => setPartner(e.target.value)}>
            <option value="all">Все партнёры</option>
            {partnerNames.map((p) => (
              <option key={p} value={p}>{p === '—' ? 'Без партнёра' : p}</option>
            ))}
          </select>
        ) : undefined}
      />

      {isPending && <SkeletonCards count={5} height={220} />}
      {isError && <Failed text={humanError(error)} onRetry={() => void refetch()} />}

      {data && (
        <div className="funnel-cols">
          {STAGES.map((st) => {
            const cards = rows.filter((r) => r.stage === st.key);
            const sum = cards.reduce((a, r) => a + priceOf(r.id), 0);
            return (
              <section
                key={st.key}
                className={`funnel-col ${drag && drag.over === st.key && drag.from !== st.key ? 'over' : ''}`}
                data-stage={st.key}
              >
                <header>
                  <div className="col-top">
                    <b>{st.title}</b>
                    <span className="count">{cards.length}</span>
                  </div>
                  <div className="sub">{st.hint}</div>
                  <div className="col-sum">{sum > 0 ? `${money(sum)}/мес` : '—'}</div>
                </header>

                {cards.length === 0 && <p className="empty">пусто</p>}

                {cards.map((r) => (
                  <article key={r.id} className={`lead ${drag?.id === r.id ? 'dragging' : ''}`}>
                    <div className="lead-top">
                      <button
                        className="grip"
                        aria-label={`Перетащить «${r.name}»`}
                        onPointerDown={(e) => onDown(e, r)}
                        onPointerMove={onMove}
                        onPointerUp={(e) => onUp(e, r)}
                        onPointerCancel={() => { grab.current = null; setDrag(null); }}
                      >
                        ⠿
                      </button>
                      <b>{r.name}</b>
                      <RowMenu
                        label="Этап"
                        actions={STAGES.filter((s) => s.key !== r.stage).map((s) => ({
                          label: `→ ${s.title}`,
                          onClick: () => move(r, s.key),
                        }))}
                      />
                    </div>

                    <div className="sub">{[r.city, r.ownerName].filter(Boolean).join(' · ') || '—'}</div>
                    {r.ownerPhone && <a className="sub phone" href={`tel:${r.ownerPhone}`}>{r.ownerPhone}</a>}
                    {isSuper && r.partnerName && <div className="sub">партнёр: {r.partnerName}</div>}
                    {priceOf(r.id) > 0 && <div className="lead-price">{money(priceOf(r.id))}/мес</div>}
                    {(() => {
                      const m = markFor(r.id);
                      return m ? <div className={`req-mark ${m.tone}`}>{m.text}</div> : null;
                    })()}
                    {r.paidUntil && <div className="sub">оплачено до {dt(r.paidUntil)}</div>}

                    {noteFor === r.id ? (
                      <div className="lead-note-edit">
                        <textarea
                          autoFocus
                          rows={3}
                          value={noteText}
                          placeholder="О чём договорились, когда перезвонить"
                          onChange={(e) => setNoteText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setNoteFor(null);
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNote(r);
                          }}
                        />
                        <div className="lead-actions">
                          <button className="btn small" onClick={() => setNoteFor(null)}>Отмена</button>
                          <button className="btn small primary" onClick={() => saveNote(r)}>Сохранить</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {r.note && <p className="lead-note">{r.note}</p>}
                        <div className="lead-actions">
                          <button
                            className="btn small ghost"
                            onClick={() => { setNoteFor(r.id); setNoteText(r.note ?? ''); }}
                          >
                            {r.note ? 'Изменить заметку' : 'Заметка'}
                          </button>
                        </div>
                      </>
                    )}

                    <div className="sub touched">
                      {r.touchedAt ? `касались ${dt(r.touchedAt)}` : 'ещё не касались'}
                    </div>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      )}

      {data && rows.length === 0 && (
        <p className="note">
          {partner === 'all'
            ? 'Клиентов в воронке пока нет — заведите первого во вкладке «Клиенты».'
            : 'У этого партнёра пока нет клиентов.'}
        </p>
      )}

      {drag && (
        <div className="drag-ghost" style={{ left: drag.x, top: drag.y }}>{drag.name}</div>
      )}
    </>
  );
}
