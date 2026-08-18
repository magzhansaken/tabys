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
import { useAsk } from '../ui/Ask';
import { useToast } from '../ui/Toast';
import { humanError } from '../ui/errors';
import { useLive } from '../ui/useLive';
import { Failed, SkeletonMetrics, SkeletonCards, Empty , PageHead } from '../ui/States';

export default function Money({ me }: { me: Me }) {
  const isSuper = me.role === 'super';
  const [data, setData] = useState<any>(null);
  const [onlyPending, setOnlyPending] = useState(true);
  const [err, setErr] = useState('');
  const [leaving, setLeaving] = useState<Record<string, boolean>>({});

  const load = async (pending = onlyPending) => {
    const path = '/payments' + (pending ? '?status=pending' : '');
    const hit = cached(path);
    if (hit) setData(hit.data);
    try {
      const d = await api(path);
      setData(d); putCache(path, d); setErr('');
    } catch (e: any) { if (!hit) setErr(humanError(e)); }
  };
  useEffect(() => { load(); }, []);

  // Обновляем сами: панель держат открытой весь день, и
  // отмеченная партнёром оплата должна появиться без нажатий.
  useLive(() => load(), 20_000);

  const [busy, setBusy] = useState(false);

  const ask = useAsk();
  const toast = useToast();

  /**
   * Решение по оплате. Последствия ПЯТЬЮ строками, как у них: имя
   * партнёра с процентом читается, а «партнёру 3 750» заставляет
   * вспоминать, кому именно.
   */
  const decide = async (p: any, yes: boolean) => {
    let pv: any = null;
    if (yes) {
      try { pv = await api(`/payments/${p.id}/preview`); }
      catch (e: any) { toast({ text: humanError(e), kind: 'err' }); return; }
    }

    const answer = await ask(yes ? {
      title: 'Подтвердить оплату',
      sub: 'Доступ клиента продлится сразу. Отменить подтверждение нельзя.',
      effects: [
        ['Магазин', p.client],
        ['Сумма', money(p.amount)],
        ['Период', `${p.months} мес.`],
        ['Продлит доступ до', fullDate(pv.paidUntil)],
        ...(pv.partnerName
          ? [[`Партнёру · ${pv.partnerName} (${pv.partnerPercent}%)`,
              money(pv.partnerShare)] as [string, string]]
          : [['Партнёра нет', 'всё платформе'] as [string, string]]),
      ],
      confirmLabel: 'Да, подтвердить',
    } : {
      title: 'Отклонить оплату',
      sub: 'Партнёр увидит причину — напишите так, чтобы было понятно.',
      effects: [['Магазин', p.client], ['Сумма', money(p.amount)]],
      reason: { label: 'Причина отказа — её увидит партнёр', required: true,
                placeholder: 'Деньги не поступили на счёт' },
      danger: true,
      confirmLabel: 'Отклонить',
    });

    if (!answer) return;

    setBusy(true);
    try {
      if (yes) {
        const r = await api(`/payments/${p.id}/approve`, { method: 'POST' });
        // Тост с датой, а не «готово»: видно, что именно произошло.
        toast({ text: `${money(p.amount)} подтверждены · доступ до ${fullDate(r.paidUntil)}` });
      } else {
        await api(`/payments/${p.id}/reject`, { method: 'POST', body: { reason: answer.reason } });
        toast({ text: 'Оплата отклонена, партнёр увидит причину' });
      }
      // Карточка уходит плавно — то же движение, что в ленте.
      setLeaving((prev) => ({ ...prev, [p.id]: true }));
      setTimeout(async () => { dropCache(); await load(); setLeaving({}); }, 280);
    } catch (e: any) {
      toast({ text: humanError(e), kind: 'err' });
    } finally { setBusy(false); }
  };

  if (err && !data) return <Failed text={err} onRetry={() => load()} />;
  if (!data) return <><SkeletonMetrics count={4} /><SkeletonCards count={3} /></>;

  const t = data.totals;

  return (
    <>
      <PageHead title={isSuper ? 'Деньги' : 'Оплаты моих клиентов'} sub={isSuper
          ? 'Очередь платежей. Подтверждение продлевает доступ и начисляет долю партнёру.'
          : 'Оплаты ваших клиентов и их состояние.'} />

      {err && <div className="err">{err}</div>}

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
        <Empty title={onlyPending ? 'Всё подтверждено' : 'Оплат нет'}
          text={onlyPending
            ? 'Ни одна оплата не ждёт решения.'
            : 'При этом отборе записей не нашлось.'}
          actionLabel={onlyPending ? 'Показать все оплаты' : undefined}
          onAction={() => { setOnlyPending(false); load(false); }} />
      ) : (
        <div className="pay-grid">
          {data.rows.map((p: any) => (
            <article key={p.id}
              className={`pay ${p.status === 'pending' ? 'waiting' : ''} ${leaving[p.id] ? 'leaving' : ''}`}>
              <div className="pay-top">
                <div className="pay-who">
                  {/* Имя ссылкой в карточку. У донора здесь просто
                      текст — их упущение: в остальных разделах имя
                      ведёт в карточку, а решая про деньги, посмотреть
                      на клиента хочется чаще всего. */}
                  <button className="link-name"
                    onClick={() => { window.location.hash = `#/client/${p.accountId}`; }}>
                    {p.client}
                  </button>
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

                {/* У ждущих — что будет, если подтвердить. Считает
                    сервер тем же способом, что и подтверждение. */}
                {p.status === 'pending' && p.willExtendTo && (
                  <span className="pay-note">
                    продлит до {fullDate(p.willExtendTo)}
                    {p.willPartnerShare ? ` · партнёру ${money(p.willPartnerShare)}` : ''}
                  </span>
                )}

                {/* У подтверждённых — КТО и КОГДА. Когда владельцев
                    несколько, вопрос «кто это пропустил» возникает
                    первым, и отвечать на него журналом — лишний шаг в
                    разговоре, который уже нервный. */}
                {p.status === 'approved' && (
                  <span className="pay-note">
                    {p.approvedBy ?? '—'} · {dateTime(p.approvedAt)}
                  </span>
                )}

                {/* Отрезок записан при подтверждении и не
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
                    onClick={() => decide(p, false)}>Отклонить…</button>
                  <button className="btn primary" disabled={busy}
                    onClick={() => decide(p, true)}>Подтвердить…</button>
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
