'use client';
/**
 * Оплаты.
 *
 * ГЛАВНОЕ ПРАВИЛО: партнёр доводит клиента до работы, деньги включает
 * владелец. Партнёр отмечает полученные деньги — доступ пока не
 * продлевается; подтверждение одно на всю систему.
 *
 * ПАРТНЁРУ КНОПКА «ПОДТВЕРДИТЬ» НЕ РИСУЕТСЯ ВОВСЕ. Не серой и не с
 * ответом «нельзя»: он видит «ждёт решения платформы». Так не нужно
 * объяснять, почему нажатие ничего не делает.
 *
 * ПОДТВЕРЖДЕНИЕ ПОКАЗЫВАЕТ ПОСЛЕДСТВИЕ ДО НАЖАТИЯ: до какой даты
 * продлится доступ и сколько получит партнёр. Дату и долю считает
 * сервер — здесь предпросмотр по тому же правилу, а окончательные числа
 * показываем из ответа на подтверждение.
 *
 * ОТКЛОНЕНИЕ ТРЕБУЕТ ПРИЧИНЫ: партнёр должен понять, что не так, а не
 * гадать. Кнопка без причины не работает, и рядом сказано почему.
 */
import React, { useEffect, useState } from 'react';
import {
  C, MONO, PageHeader, Card, Tabs, Status, Btn, Input, Select, Field, money, dt, ErrLine, EmptyState,
} from '../../../lib/ui';
import {
  papi, session, methodLabel, METHODS, MONTH_OPTS, extendPreview, dateLong,
  plural, PlatformUser,
} from '../lib';

const TABS = [
  { key: 'pending', label: 'Ждут подтверждения' },
  { key: 'approved', label: 'Подтверждённые' },
  { key: 'rejected', label: 'Отклонённые' },
  { key: 'all', label: 'Все' },
];

export default function PlatformPaymentsPage() {
  const [me, setMe] = useState<PlatformUser | null>(null);
  const [tab, setTab] = useState('pending');
  const [rows, setRows] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [partners, setPartners] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  // Отметить полученную оплату — дело партнёра, но владелец тоже
  // принимает деньги напрямую, поэтому форма нужна обоим.
  const [markOpen, setMarkOpen] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [months, setMonths] = useState('1');
  const [method, setMethod] = useState('kaspi');
  const [comment, setComment] = useState('');

  useEffect(() => { setMe(session.user()); }, []);

  const load = async (status: string) => {
    try {
      setRows(await papi('/platform/payments' + (status === 'all' ? '' : `?status=${status}`)));
      setErr('');
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(tab); }, [tab]);

  useEffect(() => {
    papi('/platform/clients').then((c) => setClients(Array.isArray(c) ? c : [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (me?.role !== 'super') return;
    papi('/platform/partners').then((p) => setPartners(Array.isArray(p) ? p : [])).catch(() => {});
  }, [me]);

  const clientOf = (p: any) => clients.find((c) => c.id === p.account_id);
  const partnerOf = (p: any) => partners.find((x) => x.name === p.partner);

  const approve = async (p: any) => {
    setBusy(p.id); setMsg('');
    try {
      const r = await papi(`/platform/payments/${p.id}/approve`, { method: 'POST' });
      // Показываем то, что посчитал сервер, а не наш предпросмотр.
      setMsg(`${p.client}: ${r.note}. Партнёру начислено ${money(r.partnerShare)}, платформе ${money(r.platformShare)}.`);
      await load(tab);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(''); }
  };

  const reject = async (p: any) => {
    if (reason.trim().length < 3) return;
    setBusy(p.id); setMsg('');
    try {
      await papi(`/platform/payments/${p.id}/reject`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      });
      setMsg(`Оплата ${p.client} отклонена. ${p.partner || 'Партнёр'} увидит причину, доступ не менялся.`);
      setRejectId(null); setReason('');
      await load(tab);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(''); }
  };

  const record = async () => {
    const n = Number(String(amount).replace(/\s/g, ''));
    if (!accountId || !(n > 0)) return;
    setBusy('new'); setMsg('');
    try {
      const r = await papi('/platform/payments', {
        method: 'POST',
        body: JSON.stringify({ accountId, amount: n, months: Number(months), method, comment: comment.trim() || null }),
      });
      setMsg(r.note ?? 'Оплата записана.');
      setMarkOpen(false); setAmount(''); setComment('');
      setTab('pending'); await load('pending');
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(''); }
  };

  const pending = rows.filter((r) => r.status === 'pending');
  const pendingSum = pending.reduce((a, r) => a + Number(r.amount || 0), 0);
  const amountOk = Number(String(amount).replace(/\s/g, '')) > 0;
  const reasonOk = reason.trim().length >= 3;

  return (
    <>
      <PageHeader
        title="Оплаты"
        fact={tab === 'pending' && pending.length
          ? `${pending.length} ${plural(pending.length, ['оплата ждёт', 'оплаты ждут', 'оплат ждут'])} подтверждения на ${money(pendingSum)}`
          : `${rows.length} ${plural(rows.length, ['запись', 'записи', 'записей'])} в списке`}
        note={me?.role === 'super'
          ? 'Подтверждение — единственное место, где оплата превращается в работающий доступ. До нажатия видно, до какой даты продлится доступ и сколько получит партнёр.'
          : 'Вы отмечаете полученные деньги, доступ включает владелец платформы. Так спешка или ошибка одного человека не открывает доступ по неоплаченному счёту.'}
        actions={
          <Btn onClick={() => { setMarkOpen(!markOpen); setMsg(''); }}>
            {markOpen ? 'Скрыть' : 'Отметить полученную оплату'}
          </Btn>
        }
      />

      <ErrLine err={err} />
      {msg && (
        <div style={{
          background: '#E8F1EC', color: C.accentDark, borderRadius: 10, padding: '12px 14px',
          fontSize: 14, lineHeight: 1.5, margin: '0 0 16px',
        }}>{msg}</div>
      )}

      {markOpen && (
        <Card title="Полученная оплата" style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.55, margin: '0 0 16px', maxWidth: '70ch' }}>
            Сумма — та, что уже у вас на счёте или на руках. Продление и долю посчитает платформа при
            подтверждении: здесь ничего не считается, чтобы клиент не увидел одну цифру, а заплатил другую.
          </p>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Клиент">
              <Select value={accountId} onChange={(e: any) => setAccountId(e.target.value)}
                options={[{ value: '', label: 'Выберите клиента' },
                  ...clients.map((c) => ({ value: c.id, label: `${c.name}${c.city ? ' · ' + c.city : ''}` }))]}
                style={{ minWidth: 260 }} />
            </Field>
            <Field label="Месяцев">
              <Select value={months} onChange={(e: any) => setMonths(e.target.value)} options={MONTH_OPTS} />
            </Field>
            <Field label="Сумма, ₸">
              <Input w={140} value={amount} inputMode="numeric" style={{ fontFamily: MONO }}
                onChange={(e: any) => setAmount(e.target.value)} placeholder="12900" />
            </Field>
            <Field label="Способ">
              <Select value={method} onChange={(e: any) => setMethod(e.target.value)} options={METHODS} />
            </Field>
            <Field label="Примечание">
              <Input w={220} value={comment} onChange={(e: any) => setComment(e.target.value)}
                placeholder="Номер чека, кто передал" />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 16 }}>
            <Btn onClick={record} disabled={!accountId || !amountOk || busy === 'new'}>
              {busy === 'new' ? 'Отправляем…' : 'Отправить на подтверждение'}
            </Btn>
            <span style={{ fontSize: 13, color: C.faint }}>
              {!accountId ? 'Выберите клиента' : !amountOk ? 'Впишите полученную сумму' : 'Доступ включится после подтверждения владельцем'}
            </span>
          </div>
        </Card>
      )}

      <Tabs tabs={TABS} active={tab} onChange={(k) => { setTab(k); setRejectId(null); setReason(''); }} />

      {rows.length === 0 ? (
        <EmptyState text={tab === 'pending'
          ? 'Ждущих оплат нет. Как только партнёр отметит полученные деньги, они появятся здесь первыми.'
          : 'В этом состоянии оплат нет.'} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((p) => {
            const c = clientOf(p);
            const pr = partnerOf(p);
            const isPending = p.status === 'pending';
            const canDecide = me?.role === 'super' && isPending;
            const until = extendPreview(c?.paidUntil, Number(p.months));
            return (
              <div key={p.id} data-card="" style={{
                background: C.card, border: `1px solid ${isPending ? '#D8D8CF' : C.line}`,
                borderRadius: 12, padding: '17px 19px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 15.5, fontWeight: 600 }}>{p.client}</div>
                    <div style={{ fontSize: 13, color: C.dim, marginTop: 3, lineHeight: 1.5 }}>
                      {[c?.city, `${p.months} ${plural(p.months, ['месяц', 'месяца', 'месяцев'])}`, methodLabel(p.method)]
                        .filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
                      {money(p.amount)}
                    </div>
                    <div style={{ fontSize: 12.5, color: C.faint, marginTop: 4 }}>{dt(p.created_at)}</div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
                  <Status value={p.status} kind="pay" />
                  <span style={{ fontSize: 13, color: C.dim }}>
                    {p.partner ? `партнёр: ${p.partner}` : 'без партнёра — привели сами'}
                  </span>
                  {p.comment && <span style={{ fontSize: 13, color: C.dim }}>{p.comment}</span>}
                </div>

                {canDecide && rejectId !== p.id && (
                  <>
                    <div style={{
                      marginTop: 14, background: C.sunken, border: `1px solid ${C.lineIn}`, borderRadius: 10,
                      padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 5,
                    }}>
                      <div style={{ fontSize: 12.5, color: C.dim }}>Если подтвердить</div>
                      <div style={{ fontSize: 14.5, lineHeight: 1.5 }}>
                        Доступ продлится до <strong>{dateLong(until)}</strong>
                        {c?.paidUntil && new Date(c.paidUntil) > new Date()
                          ? ' — остаток оплаченного не сгорает' : ''}
                      </div>
                      <div style={{ fontSize: 14.5, lineHeight: 1.5 }}>
                        {p.partner
                          ? <>{p.partner} получит <strong>{money(Math.round(Number(p.amount) * Number(pr?.commissionPercent ?? 0)) / 100)}</strong>
                              {pr ? ` — ${pr.commissionPercent}% от суммы` : ''}</>
                          : 'Партнёрской доли нет — клиент пришёл напрямую'}
                      </div>
                      <div style={{ fontSize: 12.5, color: C.faint, marginTop: 2 }}>
                        Предпросмотр по правилам платформы. Окончательные дату и долю посчитает сервер и покажет после подтверждения.
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 13, flexWrap: 'wrap' }}>
                      <Btn onClick={() => approve(p)} disabled={busy === p.id}>
                        {busy === p.id ? 'Подтверждаем…' : 'Подтвердить оплату'}
                      </Btn>
                      <Btn kind="danger" onClick={() => { setRejectId(p.id); setReason(''); }}>Отклонить</Btn>
                    </div>
                  </>
                )}

                {canDecide && rejectId === p.id && (
                  <div style={{ marginTop: 13, borderTop: `1px solid ${C.lineIn}`, paddingTop: 14 }}>
                    <div style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.5, marginBottom: 8 }}>
                      Что не так? {p.partner || 'Партнёр'} увидит причину и сможет исправить.
                    </div>
                    <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
                      placeholder="Платежа в выписке нет. Пришлите чек Kaspi — сверю и подтвержу."
                      style={{
                        width: '100%', padding: '11px 13px', border: `1px solid #D8D8CF`, borderRadius: 10,
                        fontSize: 16, lineHeight: 1.5, background: C.card, color: C.text, outline: 'none', resize: 'vertical',
                      }} />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
                      <Btn kind="danger" onClick={() => reject(p)} disabled={!reasonOk || busy === p.id}>
                        {busy === p.id ? 'Отклоняем…' : 'Отклонить оплату'}
                      </Btn>
                      <Btn kind="ghost" onClick={() => { setRejectId(null); setReason(''); }}>Отмена</Btn>
                      <span style={{ fontSize: 13, color: C.faint }}>
                        {reasonOk ? 'Партнёр увидит причину в своём кабинете' : 'Напишите причину — без неё партнёр будет гадать'}
                      </span>
                    </div>
                  </div>
                )}

                {me?.role !== 'super' && isPending && (
                  <div style={{
                    marginTop: 13, background: '#F7EFDF', borderRadius: 10, padding: '12px 14px',
                    fontSize: 14, color: C.amber, lineHeight: 1.5,
                  }}>
                    Ждёт решения платформы. Доступ включает владелец сервиса — обычно в течение дня.
                    Долю посчитают при подтверждении.
                  </div>
                )}

                {!isPending && (
                  <div style={{ marginTop: 12, borderTop: `1px solid ${C.lineIn}`, paddingTop: 11, fontSize: 13.5, color: C.dim, lineHeight: 1.55 }}>
                    {p.status === 'approved'
                      ? `Подтверждена ${dt(p.approved_at)}. Партнёру ${money(p.partnerShare)}, платформе ${money(p.platformShare)}.`
                      : `Отклонена ${dt(p.approved_at)}.`}
                  </div>
                )}

                {p.reject_reason && (
                  <div style={{ marginTop: 9, fontSize: 14, color: C.red, lineHeight: 1.55 }}>
                    Причина: {p.reject_reason}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
