'use client';
/**
 * Журнал решений.
 *
 * Нужен не для отчётности, а для разговора: «почему у клиента открыт
 * доступ, хотя оплаты нет» — ответ должен находиться, а не
 * восстанавливаться по памяти. Поэтому здесь не таблица с кодами, а
 * человеческая строка: кто, что, по какому клиенту и на каких условиях.
 *
 * Перевод действий один на весь раздел (ACTIONS в platform/lib.ts) — по
 * той же причине, по которой статусы переводит Status: второй перевод
 * разъедется с первым, и журнал начнёт показывать служебные слова.
 */
import React, { useEffect, useState } from 'react';
import { C, MONO, PageHeader, ErrLine, EmptyState, money } from '../../../lib/ui';
import { papi, ACTIONS, dateOnly, plural } from '../lib';

/** Подробности решения человеческой строкой: суммы, срок, причина. */
function detailsText(d: any) {
  if (!d || typeof d !== 'object') return '';
  const out: string[] = [];
  if (d.amount != null) out.push(money(d.amount));
  if (d.months != null) out.push(`${d.months} ${plural(Number(d.months), ['месяц', 'месяца', 'месяцев'])}`);
  if (d.paidUntil) out.push(`доступ до ${dateOnly(d.paidUntil)}`);
  if (d.partnerShare != null) out.push(`партнёру ${money(d.partnerShare)}`);
  if (d.commissionBp != null) out.push(`комиссия ${Number(d.commissionBp) / 100}%`);
  if (d.partner) out.push(String(d.partner));
  if (d.reason) out.push(`причина: ${d.reason}`);
  return out.join(' · ');
}

export default function PlatformAuditPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');

  useEffect(() => {
    papi('/platform/audit').then((r) => setRows(Array.isArray(r) ? r : [])).catch((e) => setErr(e.message));
    // Имена клиентов: в журнале лежит только account_id, а разговор идёт
    // про «Береке», а не про строку из тридцати шести знаков.
    papi('/platform/clients').then((c: any[]) => {
      const map: Record<string, string> = {};
      (Array.isArray(c) ? c : []).forEach((x) => { map[x.id] = x.name; });
      setNames(map);
    }).catch(() => {});
  }, []);

  // Дни идут группами: «когда это было» человек держит в голове датой, а
  // не временем.
  const days: { date: string; items: any[] }[] = [];
  rows.forEach((r) => {
    const date = dateOnly(r.at);
    const last = days[days.length - 1];
    if (last && last.date === date) last.items.push(r);
    else days.push({ date, items: [r] });
  });

  return (
    <>
      <PageHeader
        title="Журнал решений"
        fact={rows.length
          ? `${rows.length} ${plural(rows.length, ['запись', 'записи', 'записей'])} · последняя ${dateOnly(rows[0]?.at)}`
          : 'записей пока нет'}
        note="Кто что решил и когда. Оплаты, партнёры, назначения — всё, из-за чего у клиента может быть открыт или закрыт доступ."
      />

      <ErrLine err={err} />

      {rows.length === 0 ? (
        <EmptyState text="Записей пока нет. Здесь появятся подтверждения оплат, отклонения с причиной и решения по партнёрам." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {days.map((d) => (
            <div key={d.date}>
              <div style={{ fontSize: 12.5, color: C.faint, marginBottom: 8 }}>{d.date}</div>
              <div data-card="" style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden' }}>
                {d.items.map((a, i) => (
                  <div key={i} style={{
                    display: 'flex', gap: 14, padding: '13px 16px', flexWrap: 'wrap',
                    borderBottom: i === d.items.length - 1 ? 0 : `1px solid ${C.lineIn}`,
                  }}>
                    <div style={{ flex: '0 0 62px', fontSize: 13, color: C.dim, fontFamily: MONO }}>
                      {new Date(a.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div style={{ fontSize: 14.5, lineHeight: 1.5 }}>
                        <strong style={{ fontWeight: 600 }}>{a.actor_name || 'Платформа'}</strong>{' '}
                        {ACTIONS[a.action] ?? a.action}
                        {a.account_id && names[a.account_id] ? ` — ${names[a.account_id]}` : ''}
                      </div>
                      {detailsText(a.details) && (
                        <div style={{ fontSize: 13.5, color: C.prose, lineHeight: 1.5, marginTop: 3 }}>
                          {detailsText(a.details)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
