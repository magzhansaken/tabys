'use client';
/**
 * РАЗДЕЛ 1: «СЕГОДНЯ» — лента решений на утро.
 *
 * День начинается не со списка клиентов, а с того, что требует решения
 * сегодня. Четыре очереди по срочности, решение принимается прямо
 * в ленте — без перехода в другой раздел.
 *
 * Партнёру денежные кнопки не рисуются: сервер сам говорит, что он
 * может, в поле can. Кабинет не решает это за него — иначе правило
 * будет жить в двух местах и разъедется.
 */
import { useEffect, useState } from 'react';
import { C, Card, Btn, Input, ErrLine, EmptyState } from '../../../lib/ui';
import { P, api, cached, putCache, dropCache, money, type Me } from '../lib';

type Item = {
  id: string; kind: string; accountId: string; client: string;
  what: string; why: string | null; meta: string; amount: number | null;
  paymentId: string | null; requestId: string | null;
  can: { approve: boolean; decide: boolean; signup: boolean; call: boolean };
};
type Group = { key: string; title: string; hint: string; items: Item[] };

const TONE: Record<string, string> = {
  overdue: P.danger, today: P.accent, waiting: P.accentSoft, soon: P.dim,
};

export default function Today({ me, goTo }: { me: Me; goTo: (t: any) => void }) {
  const [data, setData] = useState<{ groups: Group[]; total: number; empty: string | null } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = async (silent = false) => {
    // Показываем известное сразу, свежее подъезжает в фоне: пустой
    // экран при каждом входе ощущался как «всё тормозит», хотя сервер
    // отвечает за 10-20 миллисекунд.
    const hit = cached('/today');
    if (hit && !silent) setData(hit.data);
    try {
      const d = await api('/today');
      setData(d); putCache('/today', d); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const approve = async (it: Item) => {
    setBusy(it.id);
    try {
      // Показываем последствие ДО действия: сколько продлится и сколько
      // достанется партнёру. Считает сервер — цифры не разойдутся.
      const p = await api(`/payments/${it.paymentId}/preview`);
      setBusy(null);
      setPreview({ item: it, ...p });
    } catch (e: any) { setErr(e.message); setBusy(null); }
  };

  const [preview, setPreview] = useState<any>(null);

  const doApprove = async () => {
    const it: Item = preview.item;
    setBusy(it.id); setPreview(null);
    try { await api(`/payments/${it.paymentId}/approve`, { method: 'POST' }); dropCache(); await load(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const doReject = async (it: Item) => {
    if (!reason.trim()) { setErr('Напишите причину — партнёр должен понять, что не так'); return; }
    setBusy(it.id);
    try {
      await api(`/payments/${it.paymentId}/reject`, { method: 'POST', body: { reason } });
      setRejecting(null); setReason(''); dropCache(); await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const decide = async (it: Item, approve: boolean) => {
    if (!approve && !reason.trim()) { setErr('Напишите причину отказа'); return; }
    setBusy(it.id);
    try {
      await api(`/requests/${it.requestId}/decide`,
        { method: 'POST', body: { approve, note: reason || undefined } });
      setRejecting(null); setReason(''); dropCache(); await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  };

  const signup = async (it: Item, approve: boolean) => {
    if (!approve && !reason.trim()) { setErr('Напишите причину отказа'); return; }
    setBusy(it.id);
    try {
      await api(`/signups/${it.accountId}/${approve ? 'approve' : 'reject'}`,
        { method: 'POST', body: approve ? { trialDays: 14 } : { reason } });
      setRejecting(null); setReason(''); dropCache(); await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(null); }
  };

  if (err && !data) return <ErrLine err={err} />;
  if (!data) return <div style={{ color: P.dim, padding: 20 }}>Загрузка…</div>;

  // Пустая лента — хорошая новость, и сказать об этом надо словами:
  // пустой экран читается как поломка.
  if (data.empty) return (
    <EmptyState text="Ничего не ждёт решения. data.empty" />
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {err && <ErrLine err={err} />}

      {preview && (
        <Card title="Что произойдёт, если подтвердить">
          <div style={{ display: 'grid', gap: 8, fontSize: 15 }}>
            <div><b>{preview.item.client}</b> · {money(preview.amount)} за {preview.months} мес.</div>
            <div>Доступ продлится до <b>{new Date(preview.paidUntil).toLocaleDateString('ru-RU')}</b></div>
            <div style={{ color: P.dim }}>
              Партнёру {money(preview.partnerShare)} ({preview.partnerPercent}%) ·
              платформе {money(preview.platformShare)}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <Btn primary onClick={doApprove}>Да, подтвердить</Btn>
            <Btn onClick={() => setPreview(null)}>Отмена</Btn>
          </div>
        </Card>
      )}

      {data.groups.map((g) => (
        <Card key={g.key} title={`${g.title} · ${g.items.length}`}>
          <p style={{ marginTop: -4, marginBottom: 12, fontSize: 13, color: P.dim }}>{g.hint}</p>

          <div style={{ display: 'grid', gap: 10 }}>
            {g.items.map((it) => (
              <div key={it.id} style={{
                border: `1px solid ${P.line}`, borderLeft: `3px solid ${TONE[g.key] ?? P.line}`,
                borderRadius: 12, padding: 12,
                display: 'grid', gap: 6,
              }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 16.5, fontFamily: P.display, fontWeight: 400 }}>{it.client}</b>
                  <span style={{ fontSize: 15 }}>{it.what}</span>
                  {it.amount != null && (
                    <span style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums' }}>{money(it.amount)}</span>
                  )}
                </div>

                {/* Причина словами клиента — по ней и принимают решение. */}
                {it.why && (
                  <div style={{ fontSize: 14, color: P.ink, fontStyle: 'italic' }}>«{it.why}»</div>
                )}
                {it.meta && <div style={{ fontSize: 13, color: P.dim }}>{it.meta}</div>}

                {rejecting === it.id ? (
                  <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
                    <Input value={reason} onChange={(e: any) => setReason(e.target.value)}
                      placeholder="Причина отказа — партнёр должен понять, что не так" autoFocus />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Btn danger onClick={() => {
                        if (it.kind === 'payment') doReject(it);
                        else if (it.kind === 'request') decide(it, false);
                        else signup(it, false);
                      }}>Отклонить</Btn>
                      <Btn onClick={() => { setRejecting(null); setReason(''); }}>Отмена</Btn>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                    {it.can.approve && (
                      <>
                        <Btn primary disabled={busy === it.id}
                          onClick={() => approve(it)}>Подтвердить</Btn>
                        <Btn onClick={() => setRejecting(it.id)}>Отклонить</Btn>
                      </>
                    )}
                    {it.can.decide && (
                      <>
                        <Btn primary disabled={busy === it.id}
                          onClick={() => decide(it, true)}>Одобрить</Btn>
                        <Btn onClick={() => setRejecting(it.id)}>Отказать</Btn>
                      </>
                    )}
                    {it.can.signup && (
                      <>
                        <Btn primary disabled={busy === it.id}
                          onClick={() => signup(it, true)}>Открыть доступ</Btn>
                        <Btn onClick={() => setRejecting(it.id)}>Отклонить</Btn>
                      </>
                    )}
                    <Btn onClick={() => goTo('clients')}>Открыть клиента</Btn>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
