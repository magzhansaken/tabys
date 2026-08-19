'use client';
/**
 * Подписка (вынесена из «Настроек»).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ РАЗДЕЛ. В «Настройках» было шесть вкладок, пять из
 * которых настраивают один раз при запуске — фискализация, оборудование,
 * граница дня, логотип. И одна про деньги, куда возвращаются каждый месяц.
 * Владелец искал её не там: платёж — это не настройка.
 *
 * Право у раздела своё — `billing`, а не `settings`. Это важно: бухгалтеру
 * можно дать оплату счетов, не открывая ему настройку кассовых аппаратов.
 */
import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { Card, Table, DataTable, PageHeader, Toggle, Btn, Field, Input,
  money, dt, C, ErrLine, Badge } from '../../../lib/ui';

export default function BillingPage() {
  const [access, setAccess] = useState<any>(null);
  const [tariffs, setTariffs] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [payAmount, setPayAmount] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [sub, setSub] = useState<any>(null);

  const load = async () => {
    try {
      setAccess(await api('/billing/access'));
      setTariffs(await api('/billing/tariffs'));
      setHistory(await api('/billing/history'));
      // КУДА ПЛАТИТЬ. Сервер это отдавал всегда, а страница не
      // спрашивала: владелец магазина открывал «Подписку» и не видел
      // ни реквизитов, ни суммы — платить было некуда, и он звонил
      // партнёру спрашивать номер.
      setSub(await api('/billing/subscription'));
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { setErr(''); load(); }, []);

  const subscribe = async (code: string) => {
    setErr(''); setMsg('');
    try { await api('/billing/subscribe', { method: 'POST', body: JSON.stringify({ tariffCode: code }) });
      setMsg('Тариф выбран'); load(); }
    catch (e: any) { setErr(e.message); }
  };

  const fact = access
    ? `${access.canSell ? 'Продажи открыты' : 'Продажи закрыты'}`
      + `${access.paidUntil ? ` · оплачено до ${new Date(access.paidUntil).toLocaleDateString('ru-RU')}` : ''}`
      + ` · баланс ${money(access.balance)}`
    : 'Загрузка…';

  return (
    <>
      <PageHeader title="Подписка" fact={fact} />
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13, margin: '8px 0' }}>{msg}</div>}

      {/* КУДА ПЛАТИТЬ — первым блоком. Человек заходит сюда с одним
          вопросом: «куда перевести деньги». Держать ответ под
          тарифами и историей значит заставлять его листать. */}
      {/* Реквизитов ЕЩЁ НЕТ — говорим прямо. Раньше блок просто не
          показывался: человек видел тариф и историю, а куда платить —
          нигде, и не понимал, забыли или надо звонить. На новой
          платформе это первое, что увидит первый клиент. */}
      {sub && !(sub.pay?.url || sub.pay?.qr || sub.pay?.phone) && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Куда платить</div>
          <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.6 }}>
            Реквизиты пока не указаны. Позвоните тому, кто вас подключал —
            он назовёт счёт и подтвердит оплату.
            {sub.monthly ? ` К оплате ${money(sub.monthly)}/мес.` : ''}
          </div>
        </Card>
      )}

      {sub?.pay && (sub.pay.url || sub.pay.qr || sub.pay.phone) && (
        <Card>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Куда платить</div>
          <div style={{ fontSize: 13, color: C.dim, marginBottom: 10 }}>
            К оплате {money(sub.monthly)}/мес
            {sub.state?.paidUntil
              ? ` · оплачено до ${new Date(sub.state.paidUntil).toLocaleDateString('ru-RU')}`
              : ''}
          </div>

          {sub.pay.url && (
            <a href={sub.pay.url} target="_blank" rel="noreferrer"
              style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 8,
                background: C.accent, color: '#fff', fontWeight: 600, marginBottom: 10 }}>
              Оплатить {money(sub.monthly)}
            </a>
          )}

          {sub.pay.qr && (
            <div style={{ marginBottom: 10 }}>
              <img src={sub.pay.qr} alt="QR для оплаты"
                style={{ width: 160, height: 160, objectFit: 'contain' }} />
            </div>
          )}

          {/* Перевод руками: показываем каждое поле ОТДЕЛЬНО. Слитую
              строку человек копирует целиком и вставляет в поле
              номера — перевод не проходит. */}
          {(sub.pay.name || sub.pay.phone || sub.pay.note) && (
            <div style={{ fontSize: 14, lineHeight: 1.7 }}>
              {sub.pay.name && <div>Получатель: <b>{sub.pay.name}</b></div>}
              {sub.pay.phone && <div>Перевод на: <b>{sub.pay.phone}</b></div>}
              {sub.pay.note && <div>В комментарии: <b>{sub.pay.note}</b></div>}
            </div>
          )}

          {/* Реквизиты словами — для тех, кто платит С БАНКОВСКОГО
              СЧЁТА, а не переводом с телефона. БИН, КБе и номер счёта
              не влезают в «получателя» и «номер». */}
          {sub.pay.details && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
              <div style={{ fontSize: 13, color: C.dim, marginBottom: 4 }}>
                Со счёта организации:
              </div>
              <pre style={{ margin: 0, fontSize: 13, lineHeight: 1.6,
                fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>{sub.pay.details}</pre>
            </div>
          )}

          {sub.periods?.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 13, color: C.dim }}>
              Выгоднее вперёд:{' '}
              {sub.periods.filter((x: any) => x.percent > 0)
                .map((x: any) => `${x.months} мес. — ${money(x.amount)} (−${x.percent}%)`)
                .join(' · ') || 'скидок за срок нет'}
            </div>
          )}
        </Card>
      )}

      <Card>
        {access ? (
          <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ minWidth: 210 }}>
              <div style={cap}>Доступ</div>
              <div style={{ marginTop: 10 }}>
                {access.canSell ? <Badge tone="ok">Продажи открыты</Badge> : <Badge tone="bad">{access.reason ?? 'Продажи закрыты'}</Badge>}
              </div>
              <div style={{ fontSize: 13.5, color: C.dim, marginTop: 12, lineHeight: 1.55 }}>
                {access.status ?? '—'}
                {access.paidUntil ? `, оплачено до ${new Date(access.paidUntil).toLocaleDateString('ru-RU')}` : ''}
              </div>
            </div>
            {access.priceLocked != null && (
              <div style={col}>
                <div style={cap}>Цена зафиксирована</div>
                <div style={big}>{money(access.priceLocked)}</div>
                <div style={{ fontSize: 13.5, color: C.dim, marginTop: 9 }}>в месяц, не изменится</div>
              </div>
            )}
            <div style={col}>
              <div style={cap}>Баланс</div>
              <div style={{ ...big, color: Number(access.balance) < 0 ? C.red : C.text }}>{money(access.balance)}</div>
              {Number(access.balance) < 0 && (
                <div style={{ fontSize: 13.5, color: C.red, marginTop: 9, lineHeight: 1.5 }}>
                  минус — пополните, иначе продажи закроются
                </div>
              )}
            </div>
          </div>
        ) : 'Загрузка…'}
      </Card>

      <Card title="Пополнить онлайн" style={{ marginTop: 14 }}
        right={access && (
          <Toggle checked={!!access.autoRenew} on="Автопродление включено" off="Автопродление выключено"
            onChange={async (v) => { await api('/billing/auto-renew', { method: 'POST', body: JSON.stringify({ enabled: v }) }); load(); }} />
        )}>
        <p style={{ fontSize: 13.5, color: C.dim, marginTop: 0, lineHeight: 1.55, maxWidth: '80ch' }}>
          Оплата через Kaspi или картой. Создайте счёт — откроется ссылка, после
          оплаты баланс пополнится сам. С автопродлением платить вручную не нужно:
          доступ не закроется в выходной, когда позвонить некому.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="Сумма, ₸">
            <Input type="number" placeholder="6900" value={payAmount} style={{ textAlign: 'right' }}
              onChange={(e: any) => setPayAmount(e.target.value)} w={150} />
          </Field>
          <Btn disabled={!payAmount} onClick={async () => {
            setErr(''); setMsg('');
            try { const inv = await api('/billing/invoice', { method: 'POST', body: JSON.stringify({ amount: +payAmount, provider: 'mock' }) });
              setMsg(`Счёт создан. Оплатите по ссылке: ${inv.payUrl}`); setPayAmount(''); load(); }
            catch (e: any) { setErr(e.message); }
          }}>Создать счёт</Btn>
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, marginTop: 14 }}>
        <Card title="Тарифы">
          <DataTable storageKey="billing-tariffs" exportName="billing-tariffs" search={false}
            hint="Скидки за длинный срок нет: три месяца стоят ровно втрое."
            empty="Тарифы не загрузились. Обновите страницу — если не помогло, напишите нам в поддержку" cols={[
            { h: 'Тариф', k: 'name' },
            { h: 'В месяц', right: true, r: (r) => money(r.price_month) },
            { h: 'Доп. точка', right: true, r: (r) => money(r.price_extra_store) },
            { h: '', r: (r) => <Btn kind="ghost" onClick={() => subscribe(r.code)}>Выбрать</Btn> },
          ]} rows={tariffs} />
        </Card>
        <Card title="История платежей">
          <DataTable storageKey="billing-history" exportName="billing-history" search={false}
            hint="Платежи через Kaspi зачисляются вручную и могут появиться не сразу. Если оплата прошла, а строки нет больше часа — пришлите чек в поддержку."
            empty="Платежей ещё не было"
            cols={[
              { h: 'Когда', r: (r) => dt(r.ts ?? r.created_at) },
              { h: 'Что', r: (r) => r.kind ?? r.comment ?? <span style={{ color: C.faint }}>—</span> },
              { h: 'Сумма', right: true, r: (r) => money(r.amount) },
            ]} rows={history} />
        </Card>
      </div>
    </>
  );
}

const cap: any = { fontSize: 11, fontWeight: 500, letterSpacing: '.1em', textTransform: 'uppercase', color: '#9A9E95' };
const col: any = { paddingLeft: 40, borderLeft: '1px solid #EFEFE9', minWidth: 190 };
const big: any = { fontSize: 30, fontWeight: 600, letterSpacing: '-.015em', lineHeight: 1.1, marginTop: 8,
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };
