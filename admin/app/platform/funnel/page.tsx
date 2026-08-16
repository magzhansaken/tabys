'use client';
/**
 * Воронка.
 *
 * Столбцами: где клиент в разговоре, а не в оплате. Этап меняется прямо
 * в карточке — иначе его не меняют вовсе, и воронка через месяц врёт.
 *
 * ДАТА ПОСЛЕДНЕГО КАСАНИЯ важнее этапа: клиент, о котором две недели не
 * вспоминали, уходит не к конкуренту, а в тишину. Сервер в списке
 * клиентов её пока не отдаёт (в `platform_clients` нет `touched_at` и
 * `deal_note`) — просить об этом нельзя, обращения к серверу не меняем.
 * Поэтому здесь то, что отдаётся: выручка за 30 дней как признак жизни и
 * срок оплаты. Оба числа отвечают на тот же вопрос: пора звонить или нет.
 */
import React, { useEffect, useState } from 'react';
import { C, MONO, PageHeader, Select, Status, money, ErrLine, EmptyState } from '../../../lib/ui';
import { papi, STAGES, leftText, phoneHref, phoneNice, plural, dateOnly } from '../lib';

export default function PlatformFunnelPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');

  const load = async () => {
    try { setRows(await papi('/platform/clients')); setErr(''); }
    catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const move = async (c: any, dealStage: string) => {
    setBusy(c.id); setMsg('');
    try {
      await papi(`/platform/clients/${c.id}`, { method: 'PATCH', body: JSON.stringify({ dealStage }) });
      setMsg(`${c.name}: этап «${STAGES.find((s) => s.value === dealStage)?.label}». Отмечено как касание сегодня.`);
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(''); }
  };

  const cold = rows.filter((c) => Number(c.revenue30d) === 0 && c.dealStage === 'won').length;

  return (
    <>
      <PageHeader
        title="Воронка"
        fact={`${rows.length} ${plural(rows.length, ['клиент', 'клиента', 'клиентов'])} в работе${cold ? ` · ${cold} проданных без продаж за 30 дней` : ''}`}
        note="Проданный клиент без выручки — не победа, а повод звонить: система у него не работает, и продлевать он не будет."
      />

      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13.5, margin: '0 0 14px' }}>{msg}</div>}

      {rows.length === 0 ? (
        <EmptyState text="Клиентов пока нет. Первый появится, как только его заведёт партнёр или придёт заявка с сайта." />
      ) : (
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 10, alignItems: 'flex-start' }}>
          {STAGES.map((s) => {
            const items = rows.filter((c) => (c.dealStage || 'new') === s.value);
            return (
              <div key={s.value} style={{
                flex: '0 0 272px', minWidth: 272, background: C.card, border: `1px solid ${C.line}`,
                borderRadius: 12, padding: '14px 13px', display: 'flex', flexDirection: 'column', gap: 9,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{s.label}</div>
                  <div style={{ fontSize: 13, color: C.faint, fontVariantNumeric: 'tabular-nums' }}>{items.length}</div>
                </div>

                {items.length === 0 && (
                  <div style={{ fontSize: 13, color: C.faint, lineHeight: 1.5, padding: '4px 2px' }}>
                    {s.value === 'new' ? 'Новых заявок нет' : 'Пусто'}
                  </div>
                )}

                {items.map((c) => {
                  const l = leftText(c.daysLeft);
                  const zero = Number(c.revenue30d) === 0;
                  return (
                    <div key={c.id} style={{
                      background: C.sunken, border: `1px solid ${C.lineIn}`, borderRadius: 10,
                      padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 7,
                    }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{c.name}</div>
                      <div style={{ fontSize: 12.5, color: C.dim }}>
                        {[c.city, c.partner].filter(Boolean).join(' · ') || 'без партнёра'}
                      </div>
                      {c.ownerPhone && (
                        <a data-btn="" href={phoneHref(c.ownerPhone)} style={{ fontFamily: MONO, fontSize: 13 }}>
                          {phoneNice(c.ownerPhone)}
                        </a>
                      )}
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Status value={c.status} kind="tenant" />
                        <span style={{ fontSize: 12.5, color: l.color }}>{l.text}</span>
                      </div>
                      <div style={{ fontSize: 12.5, color: zero ? C.red : C.dim, fontVariantNumeric: 'tabular-nums' }}>
                        {zero ? 'выручки за 30 дней нет' : `выручка 30 дней: ${money(c.revenue30d)}`}
                      </div>
                      <div style={{ fontSize: 12.5, color: C.faint }}>оплачено до {dateOnly(c.paidUntil)}</div>
                      <Select value={c.dealStage || 'new'} options={STAGES} disabled={busy === c.id}
                        onChange={(e: any) => move(c, e.target.value)} style={{ height: 34, fontSize: 14 }} />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
