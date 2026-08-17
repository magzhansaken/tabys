'use client';
/**
 * РАЗДЕЛ 4: «ЗАЯВКИ» — партнёр просит, платформа решает.
 *
 * Одобрение САМО выполняет действие: одобрил вторую кассу — строка
 * счёта появилась. Перед этим показывается последствие: одобряя, надо
 * видеть, что клиенту прилетит доплата.
 */
import { useEffect, useState } from 'react';
import { C, Card, Btn, Input, ErrLine, EmptyState, Status } from '../../../lib/ui';
import { api, money, dateTime, type Me } from '../lib';

const KIND: Record<string, string> = {
  device: 'Устройство', tariff: 'Смена тарифа', grace: 'Отсрочка', other: 'Прочее',
};

export default function Requests({ me }: { me: Me }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [status, setStatus] = useState('pending');
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = async (s = status) => {
    try { setRows(await api('/requests' + (s === 'all' ? '' : `?status=${s}`))); setErr(''); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (err && !rows) return <ErrLine err={err} />;
  if (!rows) return <div style={{ color: C.dim, padding: 20 }}>Загрузка…</div>;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {err && <ErrLine err={err} />}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[['pending', 'Ждут решения'], ['all', 'Все']].map(([k, l]) => (
          <button key={k} onClick={() => { setStatus(k); load(k); }}
            style={{
              minHeight: 38, padding: '0 14px', borderRadius: 10, fontSize: 14, cursor: 'pointer',
              border: `1px solid ${status === k ? C.accent : C.line}`,
              background: status === k ? C.accent : C.card,
              color: status === k ? '#fff' : C.text,
            }}>{l}</button>
        ))}
      </div>

      {preview && (
        <Card title="Что произойдёт, если одобрить">
          <div style={{ display: 'grid', gap: 6, fontSize: 15 }}>
            <div><b>{preview.client}</b> · {preview.what}</div>
            <div style={{ color: C.dim }}>{preview.effect}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <Btn primary onClick={async () => {
              const id = preview.id; setPreview(null);
              try { await api(`/requests/${id}/decide`, { method: 'POST', body: { approve: true } }); await load(); }
              catch (e: any) { setErr(e.message); }
            }}>Да, одобрить</Btn>
            <Btn onClick={() => setPreview(null)}>Отмена</Btn>
          </div>
        </Card>
      )}

      {rows.length === 0
        ? <EmptyState text="Заявок нет. status === 'pending' ? 'Всё решено — ничего не ждёт ответа.' : 'Записей не нашлось.'" />
        : rows.map((r: any) => (
          <Card key={r.id} style={{
            borderLeft: `3px solid ${r.status === 'pending' ? C.amber
              : r.status === 'approved' ? C.accent : C.red}` }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <b style={{ fontSize: 16 }}>{r.client}</b>
              <span style={{ fontSize: 15 }}>{KIND[r.kind] ?? r.kind}</span>
              <span style={{ marginLeft: 'auto', fontSize: 13, color: C.dim }}>
                {dateTime(r.created_at)}
              </span>
            </div>

            {r.comment && <div style={{ fontSize: 14, fontStyle: 'italic', marginTop: 4 }}>«{r.comment}»</div>}
            <div style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>
              подал: {r.author ?? '—'}
              {r.decision_note && ` · решение: ${r.decision_note}`}
            </div>

            {r.status === 'pending' && me.role === 'super' && (rejecting === r.id ? (
              <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
                <Input value={reason} onChange={(e: any) => setReason(e.target.value)}
                  placeholder="Причина отказа — партнёр должен понять, что не так" autoFocus />
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn danger onClick={async () => {
                    if (!reason.trim()) { setErr('Напишите причину'); return; }
                    try {
                      await api(`/requests/${r.id}/decide`,
                        { method: 'POST', body: { approve: false, note: reason } });
                      setRejecting(null); setReason(''); await load();
                    } catch (e: any) { setErr(e.message); }
                  }}>Отказать</Btn>
                  <Btn onClick={() => { setRejecting(null); setReason(''); }}>Отмена</Btn>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <Btn primary onClick={async () => {
                  try { setPreview({ ...(await api(`/requests/${r.id}/preview`)), id: r.id }); }
                  catch (e: any) { setErr(e.message); }
                }}>Одобрить</Btn>
                <Btn onClick={() => setRejecting(r.id)}>Отказать</Btn>
              </div>
            ))}

            {/* Партнёру решение не показывается: он всё равно не решает,
                а мёртвая кнопка хуже отсутствующей. */}
            {r.status === 'pending' && me.role === 'partner' && (
              <div style={{ fontSize: 13, color: C.amber, marginTop: 8 }}>
                Ждёт решения платформы
              </div>
            )}
          </Card>
        ))}
    </div>
  );
}
