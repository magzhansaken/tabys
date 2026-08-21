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
import { api, cached, putCache, dropCache, money, fullDate, dateTime, daysWord, type Me } from '../lib';
import { useAsk } from '../ui/Ask';
import { useToast } from '../ui/Toast';
import { humanError } from '../ui/errors';
import { useLive } from '../ui/useLive';
import { describeRequest } from '../ui/describeRequest';
import { Failed, SkeletonCards, Empty , PageHead } from '../ui/States';


export default function Requests({ me }: { me: Me }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [onlyPending, setOnlyPending] = useState(true);
  const [err, setErr] = useState('');
  const [leaving, setLeaving] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const ask = useAsk();
  const toast = useToast();

  const load = async (pending = onlyPending) => {
    const path = '/requests' + (pending ? '?status=pending' : '');
    const hit = cached(path);
    if (hit) setRows(hit.data);
    try {
      const d = await api(path);
      setRows(d); putCache(path, d); setErr('');
    } catch (e: any) { if (!hit) setErr(humanError(e)); }
  };
  useEffect(() => { load(); }, []);

  // Обновляем сами: панель держат открытой весь день, и
  // отмеченная партнёром оплата должна появиться без нажатий.
  useLive(() => load(), 20_000);

  /** Решение по заявке. Одобрение САМО выполняет действие. */
  const decide = async (r: any, yes: boolean) => {
    /* ЗАЯВКА НА НОВОГО КЛИЕНТА — предпросмотра НЕТ и быть не может: он
       считает, как правка изменит счёт магазина, а магазина ещё нет.
       Без этой оговорки владелец платформы нажал бы «одобрить» и
       получил ошибку — а решить не смог бы вовсе. */
    const isNewTenant = r.kind === 'new_tenant';

    let pv: any = null;
    if (yes && !isNewTenant) {
      try { pv = await api(`/requests/${r.id}/preview`); }
      catch (e: any) { toast({ text: humanError(e), kind: 'err' }); return; }
    }

    const isDevice = r.kind === 'device';
    const listed = pv?.listedPrice ?? 0;

    const answer = await ask(yes ? {
      title: 'Одобрить заявку',
      sub: isNewTenant
        ? 'Магазин будет заведён и записан на партнёра. '
          + 'Пароль владельцу покажется один раз — запишите его.'
        : isDevice
          ? 'Предел вырастет, и цена уйдёт в ежемесячный счёт клиента.'
          : 'Решение вступит в силу сразу после подтверждения.',
      effects: [
        [isNewTenant ? 'Просят завести' : 'Магазин', r.client],
        ['Просят', describeRequest(r.kind, r.payload)],
        ['Просил', r.author ?? '—'],
        ['Что произойдёт', pv?.effect ?? '—'],
        ...(pv?.proRata > 0
          ? [['Доплата за остаток периода', `${pv.proRata} ₸`] as [string, string]]
          : []),
      ],
      // ЦЕНА ЗАДАЁТСЯ РУКАМИ. Партнёр мог договориться с клиентом не
      // по прайсу — при молчаливом прайсе это выяснится через месяц,
      // когда клиент откажется платить по счёту.
      value: isDevice ? {
        label: 'Цена за штуку в месяц, ₸',
        initial: String(listed),
        numeric: true,
        hint: 'ноль — бесплатно, строка всё равно появится в счёте',
      } : undefined,
      confirmLabel: isDevice ? 'Одобрить и добавить в счёт' : 'Одобрить',
    } : {
      title: 'Отказать по заявке',
      sub: 'Партнёр увидит причину — напишите так, чтобы было понятно.',
      effects: [['Магазин', r.client], ['Просят', describeRequest(r.kind, r.payload)]],
      reason: { label: 'Причина отказа — её увидит партнёр', required: true,
                placeholder: 'Обсудим на встрече' },
      danger: true,
      confirmLabel: 'Отказать',
    });

    if (!answer) return;

    setBusy(true);
    try {
      const res = await api(`/requests/${r.id}/decide`, { method: 'POST', body: {
        approve: yes,
        note: answer.reason || undefined,
        unitPrice: yes && isDevice ? Number(answer.value) || 0 : undefined,
      }});
      // Тост разный по виду заявки: «одобрено» само по себе не
      // говорит, появилась ли строка в счёте.
      toast({ text: yes ? `${r.client}: ${res.effect}` : 'Отказ отправлен партнёру' });
      setLeaving((prev) => ({ ...prev, [r.id]: true }));
      setTimeout(async () => { dropCache(); await load(); setLeaving({}); }, 280);
    } catch (e: any) {
      toast({ text: humanError(e), kind: 'err' });
    } finally { setBusy(false); }
  };

  if (err && !rows) return <Failed text={err} onRetry={() => load()} />;
  if (!rows) return <SkeletonCards count={3} height={120} />;

  const isSuper = me.role === 'super';

  return (
    <>
      <PageHead title={isSuper ? 'Заявки' : 'Мои заявки'} sub={isSuper
          ? 'Партнёры просят то, что меняет деньги: лимиты, тарифы, отсрочки. Решаете вы.'
          : 'Ваши заявки владельцу платформы. Решение приходит сюда же.'} />

      {err && <div className="err">{err}</div>}

      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={onlyPending}
            onChange={(e) => { setOnlyPending(e.target.checked); load(e.target.checked); }} />
          Только ждущие решения
        </label>
      </div>

      {rows.length === 0 ? (
        <Empty title={onlyPending ? 'Всё решено' : 'Заявок нет'}
          text={onlyPending
            ? 'Ни одна заявка не ждёт ответа.'
            : 'При этом отборе записей не нашлось.'}
          actionLabel={onlyPending ? 'Показать все заявки' : undefined}
          onAction={() => { setOnlyPending(false); load(false); }} />
      ) : (
        <div className="req-list">
          {rows.map((r: any) => (
            <article key={r.id}
              className={`req ${r.status === 'pending' ? 'waiting' : ''} ${leaving[r.id] ? 'leaving' : ''}`}>
              <div className="req-head">
                {/* МАГАЗИНА ЕЩЁ НЕТ — ОТКРЫВАТЬ НЕЧЕГО.
                    У заявки на нового клиента account_id пуст: магазин
                    появится только после одобрения. Кнопка вела на
                    #/client/null, кабинет просил несуществующий
                    магазин, и сервер отвечал ошибкой.
                    Владелец видел «Internal server error» и не понимал,
                    что сломано — а сломано ничего. */}
                {r.account_id ? (
                  <button className="link-name"
                    onClick={() => { window.location.hash = `#/client/${r.account_id}`; }}>
                    {r.client}
                  </button>
                ) : (
                  <span className="link-name is-new" title="Магазин появится после одобрения">
                    {r.client}
                  </span>
                )}
                <span className="sub">{r.author ?? '—'} · {dateTime(r.created_at)}</span>
              </div>

              {/* Словами и с числами: «Просит устройство» ничего не
                  говорит — надо видеть, ЧТО просят, не открывая. */}
              <div className="req-what">{describeRequest(r.kind, r.payload)}</div>
              {r.comment && <div className="req-why">{r.comment}</div>}

              {/* Деньги клиента прямо в заявке — их приём. Решая
                  «дать ли отсрочку», надо видеть, сколько он платит и
                  не просрочен ли уже. Иначе идёшь смотреть в другой
                  раздел и теряешь место в списке. */}
              {r.monthly != null && (
                <div className={`req-money ${r.expired ? 'late' : r.expiringSoon ? 'soon' : ''}`}>
                  <span className="req-money-main">
                    <b>{money(r.monthly)}</b>/мес
                  </span>
                  <span>
                    {r.paidUntil
                      ? `оплачено до ${fullDate(r.paidUntil)}`
                      : 'без подписки'}
                    {r.daysLeft != null &&
                      ` · ${r.daysLeft < 0 ? 'просрочен: ' : ''}${daysWord(r.daysLeft)}`}
                  </span>
                  {r.pendingAmount > 0 && (
                    <span className="req-money-pay">
                      ждёт подтверждения {money(r.pendingAmount)}
                    </span>
                  )}
                </div>
              )}

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
                    {/* Кто решил: когда владельцев несколько, вопрос
                        «к кому идти переспрашивать» встаёт первым. */}
                    {r.decidedBy && (
                      <span className="sub"> · решил {r.decidedBy}</span>
                    )}

                {r.status === 'pending' && isSuper && (
                  <div className="pay-actions">
                    <button className="btn" disabled={busy}
                      onClick={() => decide(r, false)}>Отказать…</button>
                    <button className="btn primary" disabled={busy}
                      onClick={() => decide(r, true)}>Одобрить…</button>
                  </div>
                )}

                {/* ОТЗЫВ. Партнёр передумал: клиент отказался, телефон
                    записан неверно. Без кнопки заявка висит вечно, и
                    владелец платформы разбирает мусор. */}
                {r.status === 'pending' && !isSuper && (
                  <div className="pay-actions">
                    <button className="btn" disabled={busy}
                      onClick={async () => {
                        const да = await ask({
                          title: 'Отозвать заявку?',
                          sub: 'Владелец платформы её больше не увидит. '
                            + 'Отправить заново можно в любой момент.',
                          effects: [['Просили', describeRequest(r.kind, r.payload)]],
                        });
                        if (!да) return;
                        setBusy(true);
                        try {
                          await api(`/requests/${r.id}/withdraw`, { method: 'POST' });
                          toast({ text: 'Заявка отозвана' });
                          await load();
                        } catch (e: any) {
                          toast({ text: humanError(e), kind: 'err' });
                        } finally { setBusy(false); }
                      }}>Отозвать…</button>
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
