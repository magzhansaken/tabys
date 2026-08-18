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
import { api, cached, putCache, dropCache, money, fullDate, dateTime, type Me } from '../lib';
import { useAsk } from '../ui/Ask';
import { useToast } from '../ui/Toast';
import { humanError } from '../ui/errors';
import { useLive } from '../ui/useLive';
import { Failed, SkeletonCards, PageHead } from '../ui/States';

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
  // Карточка уходит плавно, а не пропадает рывком: видно, что действие
  // сработало именно с ней. Их приём.
  const [leaving, setLeaving] = useState<Record<string, boolean>>({});

  const ask = useAsk();
  const toast = useToast();

  const load = async () => {
    const hit = cached('/today');
    if (hit) setData(hit.data);
    try {
      const d = await api('/today');
      setData(d); putCache('/today', d); setErr('');
    } catch (e: any) { if (!hit) setErr(humanError(e)); }
  };
  useEffect(() => { load(); }, []);

  // Обновляем сами: панель держат открытой весь день, и
  // отмеченная партнёром оплата должна появиться без нажатий.
  useLive(() => load(), 20_000);

  const isSuper = me.role === 'super';

  /**
   * Решение по делу из ленты. Всё через их лист подтверждения:
   * последствия парами, причина отказа полем, Escape возвращает.
   */
  const decide = async (it: Item, yes: boolean) => {
    const isPay = it.kind === 'payment';
    const isReq = it.kind === 'request';

    // Последствия парами «что → сколько» — их приём: читаются глазами
    // перед решением, а не после.
    const effects: [string, string][] = [
      ['Магазин', it.client],
      ...(it.amount != null ? [['Сумма', money(it.amount)] as [string, string]] : []),
      ...(it.effect ? [['Что будет', it.effect] as [string, string]] : []),
    ];

    const r = await ask(yes ? {
      title: isPay ? 'Подтвердить оплату' : isReq ? 'Одобрить заявку' : 'Открыть доступ',
      sub: isPay
        ? 'Доступ клиента продлится сразу. Отменить подтверждение нельзя.'
        : isReq
          ? 'Действие выполнится сразу: строка счёта или срок изменятся.'
          : 'Клиент получит пробный период на 14 дней.',
      effects,
      confirmLabel: isPay ? 'Да, подтвердить' : 'Да, одобрить',
    } : {
      title: isPay ? 'Отклонить оплату' : isReq ? 'Отказать по заявке' : 'Отклонить регистрацию',
      sub: 'Тот, кого это касается, увидит причину — напишите так, чтобы было понятно.',
      effects: [['Магазин', it.client]],
      reason: { label: 'Причина', required: true,
                placeholder: isPay ? 'Деньги не поступили на счёт' : 'Обсудим на встрече' },
      danger: true,
      confirmLabel: 'Отклонить',
    });

    if (!r) return;                        // человек отменил — молча

    setBusy(it.id);
    try {
      if (isPay) {
        yes ? await api(`/payments/${it.paymentId}/approve`, { method: 'POST' })
            : await api(`/payments/${it.paymentId}/reject`, { method: 'POST', body: { reason: r.reason } });
      } else if (isReq) {
        await api(`/requests/${it.requestId}/decide`,
          { method: 'POST', body: { approve: yes, note: r.reason || undefined } });
      } else {
        yes ? await api(`/signups/${it.accountId}/approve`, { method: 'POST', body: { trialDays: 14 } })
            : await api(`/signups/${it.accountId}/reject`, { method: 'POST', body: { reason: r.reason } });
      }
      // Ответ на действие. Без него человек жмёт второй раз — их урок.
      toast({ text: yes
        ? `${it.client}: ${it.effect ?? 'готово'}`
        : `${it.client}: отклонено` });
      // Сначала уход, потом перезагрузка: иначе карточка исчезнет
      // рывком и непонятно, та ли это была.
      setLeaving((p) => ({ ...p, [it.id]: true }));
      setTimeout(async () => { dropCache(); await load(); setLeaving({}); }, 260);
    } catch (e: any) {
      toast({ text: humanError(e), kind: 'err' });
    } finally { setBusy(null); }
  };

  // Их состояния: скелетон показывает форму будущего содержимого,
  // а отказ говорит, что данные целы.
  if (err && !data) return <Failed text={err} onRetry={load} />;
  if (!data) return <SkeletonCards count={3} height={104} />;

  return (
    <>
      {/* Заголовок их частью: дата в названии, счёт дел подписью.
          Ошибки идут ТОЛЬКО тостом, как у них — полоса поверх ленты
          дублировала бы то, что уже сказано в тосте. */}
      <PageHead title={`Сегодня, ${data.dateLabel}`} sub={data.headline ?? undefined} />

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
              <article key={item.id}
                className={`queue-item ${g.key} ${leaving[item.id] ? 'leaving' : ''}`}>
                <div className="queue-main">
                  {/* Имя ведёт прямо в карточку клиента: у неё есть
                      адрес, и возвращаться в список не нужно. */}
                  <button className="link-name"
                    onClick={() => { window.location.hash = `#/client/${item.accountId}`; goTo('clients'); }}>
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
                        onClick={() => decide(item, false)}>Отклонить…</button>
                      <button className="btn small primary" disabled={busy === item.id}
                        onClick={() => decide(item, true)}>Подтвердить…</button>
                    </>
                  )}
                  {isSuper && item.kind === 'request' && (
                    <>
                      <button className="btn small" disabled={busy === item.id}
                        onClick={() => decide(item, false)}>Отказать…</button>
                      <button className="btn small primary" disabled={busy === item.id}
                        onClick={() => decide(item, true)}>Одобрить…</button>
                    </>
                  )}
                  {isSuper && item.kind === 'signup' && (
                    <>
                      <button className="btn small"
                        onClick={() => decide(item, false)}>Отклонить…</button>
                      <button className="btn small primary"
                        onClick={() => decide(item, true)}>Одобрить…</button>
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
                  <button className="btn small ghost"
                    onClick={() => { window.location.hash = `#/client/${item.accountId}`; goTo('clients'); }}>
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
