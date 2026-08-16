'use client';
/**
 * Партнёры.
 *
 * ПАРОЛЬ ПОКАЗЫВАЕТСЯ ОДИН РАЗ — как ключ API в кабинете магазина. В базе
 * он хранится отпечатком: подсмотреть его потом не может никто, включая
 * владельца платформы. Значит сказать об этом надо ДО того, как окно
 * закроют, а не после. Придумывает пароль кабинет: человек придумает
 * «12345678» и пришлёт в переписке.
 *
 * «ЗАКРЫТЬ ВХОД» — опасное действие, и оно показывает последствие ДО
 * нажатия: сколько клиентов продолжат работать и что теперь их оплаты
 * отмечает владелец. Системного окна нет: в нём последствие выглядит
 * продолжением вопроса, и человек жмёт «ОК», не дочитав.
 *
 * Открыть вход обратно — не опасно, поэтому спрашивать не о чем.
 */
import React, { useEffect, useState } from 'react';
import {
  C, MONO, PageHeader, Card, Btn, Input, Field, RevealOnce, Badge, money, dt, ErrLine, EmptyState,
} from '../../../lib/ui';
import { papi, newPassword, phoneHref, phoneNice, plural } from '../lib';

export default function PlatformPartnersPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('+7');
  const [pct, setPct] = useState('30');
  const [created, setCreated] = useState<{ name: string; password: string } | null>(null);
  const [offAsk, setOffAsk] = useState<string | null>(null);

  const load = async () => {
    try { setRows(await papi('/platform/partners')); setErr(''); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name.trim() || !email.trim()) return;
    const password = newPassword();
    setBusy('new'); setMsg('');
    try {
      await papi('/platform/partners', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(), email: email.trim(), password,
          commissionPercent: Number(pct) || 0, phone: phone.trim() || null,
        }),
      });
      setCreated({ name: name.trim(), password });
      setAddOpen(false);
      setName(''); setEmail(''); setPhone('+7'); setPct('30');
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(''); }
  };

  const toggle = async (p: any, isActive: boolean) => {
    setBusy(p.id); setMsg('');
    try {
      const r = await papi(`/platform/partners/${p.id}`, {
        method: 'PATCH', body: JSON.stringify({ isActive }),
      });
      setMsg(`${p.name}: ${r.note}.`);
      setOffAsk(null);
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(''); }
  };

  const totalEarn = rows.reduce((a, p) => a + Number(p.earned30d || 0), 0);
  const totalClients = rows.reduce((a, p) => a + Number(p.clients || 0), 0);
  const addOk = !!name.trim() && !!email.trim();

  return (
    <>
      <PageHeader
        title="Партнёры"
        fact={rows.length
          ? `${rows.length} ${plural(rows.length, ['партнёр', 'партнёра', 'партнёров'])} · ${totalClients} ${plural(totalClients, ['клиент', 'клиента', 'клиентов'])} на них · ${money(totalEarn)} начислено за 30 дней`
          : 'партнёров пока нет'}
        note="Партнёр доводит клиента до работы и отмечает полученные деньги. Включает доступ платформа — это одна точка на всю систему."
        actions={<Btn onClick={() => { setAddOpen(!addOpen); setCreated(null); setMsg(''); }}>
          {addOpen ? 'Скрыть' : 'Завести партнёра'}
        </Btn>}
      />

      <ErrLine err={err} />
      {msg && (
        <div style={{ background: '#E8F1EC', color: C.accentDark, borderRadius: 10, padding: '12px 14px', fontSize: 14, lineHeight: 1.5, margin: '0 0 16px' }}>
          {msg}
        </div>
      )}

      {created && (
        <div style={{ marginBottom: 16 }}>
          <RevealOnce
            value={created.password}
            title={`Пароль для ${created.name} — показывается один раз`}
            note="В базе он хранится отпечатком: посмотреть его потом не сможет никто, включая вас. Передайте лично — в переписке пароль остаётся навсегда. Забудет — выпишете новый."
          />
          <Btn kind="ghost" onClick={() => setCreated(null)} style={{ marginTop: 10, color: C.dim }}>Записал, скрыть</Btn>
        </div>
      )}

      {addOpen && (
        <Card title="Новый партнёр" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Имя и фамилия">
              <Input w={220} value={name} onChange={(e: any) => setName(e.target.value)} placeholder="Асхат Жумабек" />
            </Field>
            <Field label="Почта — по ней он входит">
              <Input w={240} value={email} inputMode="email" style={{ fontFamily: MONO }}
                onChange={(e: any) => setEmail(e.target.value)} placeholder="ashat@tabys.kz" />
            </Field>
            <Field label="Телефон">
              <Input w={180} value={phone} inputMode="tel" style={{ fontFamily: MONO }}
                onChange={(e: any) => setPhone(e.target.value)} />
            </Field>
            <Field label="Комиссия, %">
              <Input w={110} value={pct} inputMode="numeric" style={{ fontFamily: MONO }}
                onChange={(e: any) => setPct(e.target.value)} />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 16 }}>
            <Btn onClick={create} disabled={!addOk || busy === 'new'}>
              {busy === 'new' ? 'Заводим…' : 'Завести партнёра'}
            </Btn>
            <span style={{ fontSize: 13, color: C.faint }}>
              {addOk ? 'Пароль придумает кабинет и покажет один раз' : 'Нужны имя и почта: по почте партнёр входит'}
            </span>
          </div>
        </Card>
      )}

      {rows.length === 0 ? (
        <EmptyState text="Партнёров пока нет. Заведите первого — он получит свой вход и увидит только своих клиентов." />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 12 }}>
          {rows.map((p) => (
            <div key={p.id} data-card="" style={{
              background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: '18px 20px',
              display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 15.5, fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 13, color: C.dim, marginTop: 3 }}>комиссия {p.commissionPercent}%</div>
                </div>
                <Badge tone={p.isActive ? 'ok' : 'dim'}>{p.isActive ? 'Вход открыт' : 'Вход закрыт'}</Badge>
              </div>

              <div style={{
                display: 'flex', flexWrap: 'wrap', gap: 18,
                borderTop: `1px solid ${C.lineIn}`, borderBottom: `1px solid ${C.lineIn}`, padding: '13px 0',
              }}>
                <div style={{ minWidth: 96 }}>
                  <div style={{ fontSize: 12.5, color: C.dim, whiteSpace: 'nowrap' }}>Клиентов</div>
                  <div style={{ fontSize: 19, fontWeight: 600, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{p.clients}</div>
                  <div style={{ fontSize: 12.5, color: C.dim, marginTop: 3, whiteSpace: 'nowrap' }}>
                    {p.activeClients} {plural(p.activeClients, ['работает', 'работают', 'работают'])}
                  </div>
                </div>
                <div style={{ minWidth: 170 }}>
                  <div style={{ fontSize: 12.5, color: C.dim, whiteSpace: 'nowrap' }}>Заработано за 30 дней</div>
                  <div style={{ fontSize: 19, fontWeight: 600, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{money(p.earned30d)}</div>
                  <div style={{ fontSize: 12.5, color: C.dim, marginTop: 3 }}>
                    {p.lastLoginAt ? `был ${dt(p.lastLoginAt)}` : 'ещё не заходил'}
                  </div>
                </div>
              </div>

              <div style={{ fontSize: 13, color: C.dim, fontFamily: MONO, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                {p.phone && <a data-btn="" href={phoneHref(p.phone)}>{phoneNice(p.phone)}</a>}
                <span>{p.email}</span>
              </div>

              {offAsk === p.id ? (
                <div style={{ background: '#FBEAE6', borderRadius: 10, padding: '12px 14px', fontSize: 14, lineHeight: 1.55 }}>
                  Вход закроется сразу. {p.clients} {plural(p.clients, ['клиент', 'клиента', 'клиентов'])} продолжат
                  работать — их оплаты придётся отмечать вам. Начисленные {money(p.earned30d)} останутся за ним.
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                    <Btn kind="danger" onClick={() => toggle(p, false)} disabled={busy === p.id}>
                      {busy === p.id ? 'Закрываем…' : 'Закрыть вход'}
                    </Btn>
                    <Btn kind="ghost" onClick={() => setOffAsk(null)}>Оставить</Btn>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {p.isActive
                    ? <Btn kind="danger" onClick={() => setOffAsk(p.id)}>Закрыть вход</Btn>
                    : <Btn kind="ghost" onClick={() => toggle(p, true)} disabled={busy === p.id}>
                        {busy === p.id ? 'Открываем…' : 'Открыть вход'}
                      </Btn>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
