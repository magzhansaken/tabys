'use client';
/**
 * КАРТОЧКА КЛИЕНТА — СТРАНИЦА, А НЕ ТУПИК.
 *
 * Перенесено из их TenantCard.tsx. Их довод: раньше это было окно,
 * которое показывало всё и не давало сделать ничего — единственная
 * кнопка «Закрыть». Изучил клиента, закрывай и ищи его в таблице
 * заново.
 *
 * Теперь у карточки есть АДРЕС (#/client/<id>): её можно оставить
 * открытой, вернуться к ней, отправить ссылку. Деньги сверху, действия
 * рядом с данными, состав счёта правится прямо здесь.
 *
 * Их приёмы, взятые целиком:
 *   «Из чего складывается месяц» — разбивка одной строкой: тариф,
 *     устройства, модули, скидка, итого;
 *   «Есть 2 из 3» — сколько устройств заведено против оплаченного:
 *     клиент может платить за три кассы и работать на одной;
 *   ПРЕДУПРЕЖДЕНИЕ О ПРОСТОЕ: «платит, но не подключил 9 дней — деньги
 *     идут, работы нет. Стоит позвонить и довести до кассы». Это
 *     единственное место, где видно, что клиент вот-вот уйдёт;
 *   правка города, владельца и телефона на месте.
 */
import { useEffect, useState } from 'react';
import { api, money, fullDate, dateTime, daysWord, type Me } from '../lib';
import { InlineText } from '../ui/InlineText';
import { PlanLines } from '../ui/PlanLines';
import { RowMenu } from '../ui/RowMenu';
import { CopyValue } from '../ui/access';
import { statusView } from '../ui/status';
import { useToast } from '../ui/Toast';
import { humanError } from '../ui/errors';
import { Failed, SkeletonMetrics, SkeletonCards, Empty } from '../ui/States';

const STAGE: Record<string, string> = {
  new: 'новый', contacted: 'связались', trial: 'пробный',
  paid: 'оплатил', lost: 'отказ',
};

export default function TenantCard({ me, accountId, onBack, onPay, onRequest }: {
  me: Me;
  accountId: string;
  onBack: () => void;
  onPay: (c: any) => void;
  onRequest: (c: any) => void;
}) {
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'devices' | 'payments' | 'audit'>('devices');
  const [err, setErr] = useState('');

  const toast = useToast();
  const isSuper = me.role === 'super';

  const load = async () => {
    try { setData(await api(`/clients/${accountId}/card`)); setErr(''); }
    catch (e: any) { setErr(humanError(e)); }
  };
  useEffect(() => { load(); }, [accountId]);

  const save = async (body: any, ok: string) => {
    try {
      await api(`/clients/${accountId}`, { method: 'PATCH', body });
      toast({ text: ok });
      await load();
    } catch (e: any) { toast({ text: humanError(e), kind: 'err' }); }
  };

  if (err && !data) return <Failed text={err} onRetry={load} />;
  if (!data) return <><SkeletonMetrics count={4} /><SkeletonCards count={2} height={180} /></>;

  const s = statusView(data.status === 'active' && data.daysLeft != null && data.daysLeft < 0
    ? 'expired' : data.status);

  // Разбивка месяца: из чего сложилась сумма.
  const live = (data.lines ?? []).filter((l: any) => l.active);
  const part = (kinds: string[]) => live
    .filter((l: any) => kinds.includes(l.kind))
    .reduce((a: number, l: any) => a + l.price * (l.qty ?? 1), 0);
  const breakdown = {
    base: part(['base']),
    devices: part(['pos', 'store']),
    modules: part(['module']),
    discounts: Math.abs(part(['discount'])),
  };

  return (
    <>
      <button className="btn small ghost back" onClick={onBack}>← Все клиенты</button>

      <div className="client-head">
        <div>
          <h1>
            <InlineText value={data.name} label="Название магазина"
                onSame={() => toast({ text: 'Не изменилось' })}
              onSave={(v) => save({ name: v }, 'Название изменено')} />
          </h1>

          <p className="hint client-fields">
            <InlineText value={data.city ?? ''} label="Город" placeholder="город"
                onSame={() => toast({ text: 'Не изменилось' })}
              onSave={(v) => save({ city: v }, 'Город изменён')} />
            {' · '}
            <InlineText value={data.owner ?? ''} label="Владелец" placeholder="владелец"
                onSame={() => toast({ text: 'Не изменилось' })}
              onSave={(v) => save({ ownerName: v }, 'Владелец изменён')} />
            {' · '}
            <InlineText value={data.ownerPhone ?? ''} label="Телефон владельца" mono
                onSame={() => toast({ text: 'Не изменилось' })}
              placeholder="телефон"
              onSave={(v) => save({ ownerPhone: v }, 'Телефон изменён')} />
            {data.ownerPhone && (
              <a className="call-link" href={`tel:${data.ownerPhone}`}>позвонить</a>
            )}
          </p>

          <div className="client-badges">
            <span className={`badge ${s.cls}`}>{s.text}</span>
            {data.tariff && <span className="badge">{data.tariff}</span>}
            {data.dealStage && <span className="badge">{STAGE[data.dealStage] ?? data.dealStage}</span>}
            {data.isDemo && <span className="badge">учебный</span>}
          </div>
        </div>

        <div className="client-actions">
          <button className="btn primary" onClick={() => onPay(data)}>Оплата</button>
          {!isSuper && (
            <button className="btn" onClick={() => onRequest(data)}>Запросить у платформы</button>
          )}
        </div>
      </div>

      {/* Деньги сверху: за этим сюда и заходят. */}
      <div className="cards">
        <div className="card money">
          <span>В месяц</span>
          <b>{money(data.monthly)}</b>
          {live.length > 0 && <div className="sub">разбивка месяца ниже</div>}
        </div>
        <div className="card">
          <span>Оплачено до</span>
          <b>{data.paidUntil ? fullDate(data.paidUntil) : '—'}</b>
          {data.daysLeft != null && <div className="sub">{daysWord(data.daysLeft)}</div>}
        </div>
        <div className="card">
          <span>Выручка за 30 дней</span>
          <b>{money(data.revenue30d)}</b>
          <div className="sub">живёт ли клиент</div>
        </div>
        <div className="card">
          <span>{isSuper ? 'Ведёт партнёр' : 'Ваша доля'}</span>
          <b>{isSuper ? (data.partner ?? 'ничей') : `${data.partnerPercent ?? 0}%`}</b>
        </div>
      </div>

      {/* Из чего складывается месяц — их приём: одной строкой видно,
          откуда взялась сумма. */}
      {live.length > 0 && (
        <div className="breakdown">
          <span className="breakdown-label">Из чего складывается месяц</span>
          <div className="breakdown-parts">
            <span><i>за тариф</i><b>{money(breakdown.base)}</b></span>
            {breakdown.devices > 0 && (
              <span><i>за устройства</i><b>{money(breakdown.devices)}</b></span>
            )}
            {breakdown.modules > 0 && (
              <span><i>за модули</i><b>{money(breakdown.modules)}</b></span>
            )}
            {breakdown.discounts > 0 && (
              <span className="minus"><i>скидка</i><b>−{money(breakdown.discounts)}</b></span>
            )}
            <span className="breakdown-total"><i>итого</i><b>{money(data.monthly)}</b></span>
          </div>
        </div>
      )}

      {/* ДВЕ РАЗНЫЕ ЗАМЕТКИ, и обе нужны.
          О сделке — «позвонил, ждёт счёт до пятницы»: устаревает.
          О клиенте — «владелец глухой на левое ухо, звонить громче»:
          нужна всегда. Вторая писалась в базу и нигде не
          показывалась — человек записывал важное и терял. */}
      {data.dealNote && <p className="client-note">По сделке: {data.dealNote}</p>}
      {data.note && <p className="client-note">О клиенте: {data.note}</p>}

      <div className="tabs" role="tablist">
        {([
          ['devices', `Устройства · ${data.registers}`],
          ['payments', `Оплаты · ${data.payments.length}`],
          ['audit', 'События'],
        ] as const).map(([k, label]) => (
          <button key={k} role="tab" className={tab === k ? 'on' : ''}
            onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'devices' && <Devices data={data} isSuper={isSuper} />}

      {tab === 'payments' && (
        data.payments.length === 0
          ? <Empty title="Оплат не было" text="Как только партнёр отметит оплату, она появится здесь." />
          : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Когда</th><th className="num">Сумма</th>
                  <th>Период</th><th>Состояние</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p: any) => (
                  <tr key={p.id}>
                    <td data-label="Когда">{dateTime(p.at)}</td>
                    <td className="num" data-label="Сумма">{money(p.amount)}</td>
                    <td data-label="Период">{p.months} мес.</td>
                    <td data-label="Состояние">
                      <span className={`badge ${
                        p.status === 'approved' ? 'st-active'
                        : p.status === 'pending' ? 'st-pending' : 'st-expired'}`}>
                        {p.status === 'approved' ? 'подтверждена'
                          : p.status === 'pending' ? 'ждёт' : 'отклонена'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
      )}

      {tab === 'audit' && (
        data.requests.length === 0
          ? <Empty title="Событий нет" text="Заявки и решения по этому клиенту появятся здесь." />
          : (
            <div className="audit">
              {data.requests.map((r: any) => (
                <div key={r.id} className="entry">
                  <span className="entry-time">{dateTime(r.created_at)}</span>
                  <div className="entry-body">
                    <div className="entry-text">{r.comment ?? r.kind}</div>
                    <div className="entry-meta">
                      <span className="entry-kind">{r.status}</span>
                      {r.decision_note && <span>{r.decision_note}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
      )}

      {/* Состав счёта правится прямо здесь — их приём: не надо уходить
          в другое место, чтобы поменять цену. */}
      {isSuper && (
        <>
          <h2 className="section-title">Счёт</h2>
          <PlanLines accountId={accountId} lines={data.lines}
            monthly={data.monthly}
            tier={/стандарт|pro/i.test(data.tariff ?? '') ? 'pro' : 'base'}
            onChanged={load} />
        </>
      )}
    </>
  );
}

/**
 * Устройства: сколько заведено против оплаченного и кто простаивает.
 *
 * Их приём «есть 2 из 3»: клиент может платить за три кассы и работать
 * на одной — это видно только здесь.
 */
function Devices({ data, isSuper }: { data: any; isSuper: boolean }) {
  const paid = (data.lines ?? []).filter((l: any) => l.active && l.kind === 'pos')
    .reduce((a: number, l: any) => a + (l.qty ?? 1), 0) + 1;   // одна в тарифе

  return (
    <>
      <div className="dev-mix">
        <div className="dev-mix-cell">
          <span>Кассы</span>
          <b>{data.registers} из {paid}</b>
          {data.registers < paid && (
            <span className="dev-mix-sum">оплачено больше, чем заведено</span>
          )}
        </div>
        <div className="dev-mix-cell">
          <span>Точки</span>
          <b>{data.stores}</b>
        </div>
      </div>

      {/* Деньги идут, работы нет — единственное место, где видно, что
          клиент вот-вот уйдёт. Их приём. */}
      {data.registers < paid && (
        <p className="dev-stale">
          Оплачено касс: {paid}, заведено: {data.registers} — деньги идут, работы нет.
          Стоит позвонить и довести до кассы.
        </p>
      )}

      <p className="hint">
        Устройство подключается одним действием из списка клиентов:
        там же поднимется предел и появится код привязки.
      </p>
    </>
  );
}
