'use client';
/**
 * РАЗДЕЛ 3: «ДЕНЬГИ» — оплаты с итогами.
 *
 * Итоги считаются по тем же строкам, что показаны: при отборе «ждут»
 * доход ноль, а не итог по всем. Ждущие и отклонённые — это ещё не
 * деньги.
 *
 * Оплаченный отрезок записан при подтверждении и не пересчитывается:
 * это ответ на вопрос «за что я платил».
 */
import { useEffect, useState } from 'react';
import { C, Card, Btn, Input, ErrLine, EmptyState, Status } from '../../../lib/ui';
import { api, money, fullDate, dateTime, type Me } from '../lib';

const FILTERS = [
  { key: 'all',      label: 'Все' },
  { key: 'pending',  label: 'Ждут' },
  { key: 'approved', label: 'Подтверждены' },
  { key: 'rejected', label: 'Отклонены' },
];

export default function Money({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [status, setStatus] = useState('all');
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = async (s = status) => {
    try {
      setData(await api('/payments' + (s === 'all' ? '' : `?status=${s}`)));
      setErr('');
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (err && !data) return <ErrLine err={err} />;
  if (!data) return <div style={{ color: C.dim, padding: 20 }}>Загрузка…</div>;

  const t = data.totals;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {err && <ErrLine err={err} />}

      {/* Итоги — по показанным строкам. Подпись говорит, что именно
          посчитано, иначе цифра без отбора вводит в заблуждение. */}
      <Card>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <Sum title="Записей" value={String(t.count)} />
          <Sum title="Подтверждено" value={money(t.amount)} big />
          <Sum title="Партнёрам" value={money(t.partnerShare)} />
          <Sum title="Платформе" value={money(t.platformShare)} />
        </div>
        <div style={{ fontSize: 13, color: C.dim, marginTop: 8 }}>
          В доход идут только подтверждённые: ждущие и отклонённые — это ещё не деньги
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => { setStatus(f.key); load(f.key); }}
            style={{
              minHeight: 38, padding: '0 14px', borderRadius: 10, fontSize: 14, cursor: 'pointer',
              border: `1px solid ${status === f.key ? C.accent : C.line}`,
              background: status === f.key ? C.accent : C.card,
              color: status === f.key ? '#fff' : C.text,
            }}>{f.label}</button>
        ))}
      </div>

      {preview && (
        <Card title="Что произойдёт, если подтвердить">
          <div style={{ display: 'grid', gap: 6, fontSize: 15 }}>
            <div>{money(preview.amount)} за {preview.months} мес.</div>
            <div>Доступ продлится до <b>{fullDate(preview.paidUntil)}</b></div>
            <div style={{ color: C.dim }}>
              Партнёру {money(preview.partnerShare)} ({preview.partnerPercent}%) ·
              платформе {money(preview.platformShare)}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <Btn primary onClick={async () => {
              const id = preview.id; setPreview(null);
              try { await api(`/payments/${id}/approve`, { method: 'POST' }); await load(); }
              catch (e: any) { setErr(e.message); }
            }}>Да, подтвердить</Btn>
            <Btn onClick={() => setPreview(null)}>Отмена</Btn>
          </div>
        </Card>
      )}

      {data.rows.length === 0
        ? <EmptyState text="Оплат нет. При этом отборе записей не нашлось." />
        : data.rows.map((p: any) => (
          <Card key={p.id} style={{
            borderLeft: `3px solid ${p.status === 'pending' ? C.amber
              : p.status === 'approved' ? C.accent : C.red}` }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 16 }}>{p.client}</b>
              <Status value={p.status} kind="pay" />
              <span style={{ marginLeft: 'auto', fontSize: 18, fontWeight: 600,
                fontVariantNumeric: 'tabular-nums' }}>{money(p.amount)}</span>
            </div>

            <div style={{ fontSize: 14, color: C.dim, marginTop: 4,
              display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <span>{p.months} мес. · {p.method}</span>
              <span>{dateTime(p.createdAt)}</span>
              {p.partner && <span>партнёр: {p.partner}</span>}
              {/* Отрезок записан при подтверждении — это ответ на
                  вопрос «за что я платил», он не меняется потом. */}
              {p.periodFrom && (
                <span>за {fullDate(p.periodFrom)} — {fullDate(p.periodTo)}</span>
              )}
              {p.status === 'approved' && (
                <span>партнёру {money(p.partnerShare)} · платформе {money(p.platformShare)}</span>
              )}
            </div>

            {p.comment && <div style={{ fontSize: 14, fontStyle: 'italic', marginTop: 4 }}>«{p.comment}»</div>}
            {p.rejectReason && (
              <div style={{ fontSize: 14, color: C.red, marginTop: 4 }}>
                Отклонена: {p.rejectReason}
              </div>
            )}

            {p.canApprove && (rejecting === p.id ? (
              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                <Input value={reason} onChange={(e: any) => setReason(e.target.value)}
                  placeholder="Причина отказа — партнёр должен понять, что не так" autoFocus />
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn danger onClick={async () => {
                    if (!reason.trim()) { setErr('Напишите причину'); return; }
                    try {
                      await api(`/payments/${p.id}/reject`, { method: 'POST', body: { reason } });
                      setRejecting(null); setReason(''); await load();
                    } catch (e: any) { setErr(e.message); }
                  }}>Отклонить</Btn>
                  <Btn onClick={() => { setRejecting(null); setReason(''); }}>Отмена</Btn>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <Btn primary onClick={async () => {
                  try { setPreview({ ...(await api(`/payments/${p.id}/preview`)), id: p.id }); }
                  catch (e: any) { setErr(e.message); }
                }}>Подтвердить</Btn>
                <Btn onClick={() => setRejecting(p.id)}>Отклонить</Btn>
              </div>
            ))}
          </Card>
        ))}
    </div>
  );
}

function Sum({ title, value, big }: { title: string; value: string; big?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 13, color: C.dim }}>{title}</div>
      <div style={{ fontSize: big ? 26 : 20, fontWeight: 600,
        fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}
