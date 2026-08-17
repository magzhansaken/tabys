'use client';
/**
 * РАЗДЕЛ 6: «ПАРТНЁРЫ» — кто продаёт и сколько заработал.
 *
 * «Привёл денег» и «заработал» показаны рядом и это разные числа:
 * партнёр с комиссией 10% может приносить платформе больше, чем с 15%.
 *
 * Отключение показывает последствие: сколько клиентов останется без
 * сопровождения.
 */
import { useEffect, useState } from 'react';
import { C, Card, Btn, Input, Field, ErrLine, EmptyState, RevealOnce } from '../../../lib/ui';
import { api, money, dateTime, type Me } from '../lib';

export default function Partners({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', commissionPercent: 15 });
  const [created, setCreated] = useState<string | null>(null);
  const [offPreview, setOffPreview] = useState<any>(null);

  const load = async () => {
    try { setData(await api('/partners')); setErr(''); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (err && !data) return <ErrLine err={err} />;
  if (!data) return <div style={{ color: C.dim, padding: 20 }}>Загрузка…</div>;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {err && <ErrLine err={err} />}

      <Card>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, color: C.dim }}>Партнёров</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{data.totals.partners}</div>
          </div>
          <div>
            <div style={{ fontSize: 13, color: C.dim }}>Привели за 30 дней</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{money(data.totals.brought)}</div>
          </div>
          <div>
            <div style={{ fontSize: 13, color: C.dim }}>К выплате</div>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{money(data.totals.paidOut)}</div>
          </div>
          <Btn primary style={{ marginLeft: 'auto' }}
            onClick={() => setAdding(!adding)}>Завести партнёра</Btn>
        </div>
      </Card>

      {adding && (
        <Card title="Новый партнёр">
          <div style={{ display: 'grid', gap: 10, maxWidth: 420 }}>
            <Field label="Имя">
              <Input value={form.name} onChange={(e: any) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Почта">
              <Input value={form.email} type="email"
                onChange={(e: any) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Пароль" hint="от 8 знаков — передайте партнёру лично">
              <Input value={form.password} type="text"
                onChange={(e: any) => setForm({ ...form, password: e.target.value })} />
            </Field>
            <Field label="Комиссия, %" hint="доля с каждой подтверждённой оплаты его клиентов">
              <Input value={String(form.commissionPercent)} inputMode="numeric"
                onChange={(e: any) => setForm({ ...form, commissionPercent: Number(e.target.value) || 0 })} />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn primary onClick={async () => {
                try {
                  const r = await api('/partners', { method: 'POST', body: form });
                  setCreated(form.password); setAdding(false);
                  setForm({ name: '', email: '', password: '', commissionPercent: 15 });
                  await load();
                } catch (e: any) { setErr(e.message); }
              }}>Завести</Btn>
              <Btn onClick={() => setAdding(false)}>Отмена</Btn>
            </div>
          </div>
        </Card>
      )}

      {created && (
        <RevealOnce title="Пароль партнёра" value={created}
          note="Показан один раз — передайте лично. В базе хранится отпечатком." />
      )}

      {offPreview && (
        <Card title="Что произойдёт при отключении">
          <div style={{ fontSize: 15 }}>{offPreview.effect}</div>
          {offPreview.activeClients > 0 && (
            <div style={{ fontSize: 14, color: C.dim, marginTop: 6 }}>
              Работающих клиентов: {offPreview.activeClients} · дают {money(offPreview.mrr)}/мес
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <Btn danger onClick={async () => {
              const id = offPreview.id; setOffPreview(null);
              try { await api(`/partners/${id}`, { method: 'PATCH', body: { isActive: false } }); await load(); }
              catch (e: any) { setErr(e.message); }
            }}>Да, закрыть вход</Btn>
            <Btn onClick={() => setOffPreview(null)}>Отмена</Btn>
          </div>
        </Card>
      )}

      {data.rows.length === 0
        ? <EmptyState text="Партнёров нет. Заведите первого — он сможет вести своих клиентов." />
        : data.rows.map((p: any) => (
          <Card key={p.id} style={{ opacity: p.isActive ? 1 : 0.6 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 17 }}>{p.name}</b>
              <span style={{ fontSize: 14, color: C.dim }}>{p.email}</span>
              <span style={{ fontSize: 15, fontWeight: 600, color: C.accent }}>
                {p.commissionPercent}%
              </span>
              {!p.isActive && (
                <span style={{ fontSize: 13, color: C.red }}>вход закрыт</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 10 }}>
              <Num title="Клиентов" value={`${p.clients}`}
                sub={`работают ${p.activeClients}${p.lostClients ? `, ушло ${p.lostClients}` : ''}`} />
              {/* Привёл и заработал — разные числа, и первое важнее. */}
              <Num title="Привёл за 30 дн." value={money(p.brought)}
                sub={`всего ${money(p.broughtTotal)}`} />
              <Num title="Заработал" value={money(p.earned)}
                sub={`всего ${money(p.earnedTotal)}`} />
              <Num title="Его клиенты дают" value={`${money(p.mrr)}/мес`}
                sub="будущий доход" />
            </div>

            <div style={{ fontSize: 13, color: p.inactive || p.neverLoggedIn ? C.amber : C.dim,
              marginTop: 8 }}>
              {p.neverLoggedIn ? 'ни разу не заходил'
                : p.inactive ? `не заходил ${p.daysSilent} дн. — возможно, перестал работать`
                : `заходил ${dateTime(p.lastLoginAt)}`}
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              {p.isActive ? (
                <Btn onClick={async () => {
                  try { setOffPreview({ ...(await api(`/partners/${p.id}/off-preview`)), id: p.id }); }
                  catch (e: any) { setErr(e.message); }
                }}>Закрыть вход</Btn>
              ) : (
                <Btn onClick={async () => {
                  try { await api(`/partners/${p.id}`, { method: 'PATCH', body: { isActive: true } }); await load(); }
                  catch (e: any) { setErr(e.message); }
                }}>Открыть вход</Btn>
              )}
            </div>
          </Card>
        ))}
    </div>
  );
}

function Num({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: C.dim }}>{title}</div>
      <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: C.dim }}>{sub}</div>}
    </div>
  );
}
