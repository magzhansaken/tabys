'use client';
/**
 * Клиенты — главный экран платформы.
 *
 * Столбцы взяты у донора, они обкатаны: магазин, владелец с телефоном,
 * статус, оплачено до, тариф и ВЫРУЧКА ЗА 30 ДНЕЙ.
 *
 * ПОСЛЕДНИЙ СТОЛБЕЦ — ГЛАВНЫЙ, И ЭТО НЕОЧЕВИДНО. Он отвечает не на
 * вопрос «сколько мы заработали», а на вопрос «нужна ли клиенту
 * система». Если продаж нет — продлевать он не будет, и звонить надо
 * сейчас, а не когда кончится срок. Поэтому ноль в этом столбце красный,
 * а не серый: это не «нет данных», это признак ухода.
 *
 * ТЕЛЕФОН ВЛАДЕЛЬЦА — ССЫЛКОЙ. Нажал и звонишь. Для партнёра это
 * половина работы, и лишний шаг «выделить, скопировать» он делает
 * двадцать раз в день.
 */
import React, { useEffect, useState } from 'react';
import {
  C, MONO, PageHeader, Stat, DataTable, Status, Btn, Input, Select, Field,
  money, ErrLine,
} from '../../lib/ui';
import {
  papi, session, leftText, rowTone, phoneHref, phoneNice, plural,
  STAGES, stageLabel, dateOnly, dateLong, PlatformUser,
} from './lib';

export default function PlatformClientsPage() {
  const [me, setMe] = useState<PlatformUser | null>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [sum, setSum] = useState<any>(null);
  const [partners, setPartners] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setMe(session.user()); }, []);

  const load = async (query: string) => {
    try {
      const list = await papi('/platform/clients' + (query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''));
      setRows(Array.isArray(list) ? list : []);
      setErr('');
    } catch (e: any) { setErr(e.message); }
  };

  useEffect(() => { load(''); papi('/platform/summary').then(setSum).catch(() => {}); }, []);

  // Партнёров подгружаем один раз и только владельцу: у партнёра этого
  // права нет, и запрос вернул бы 403 — а с ним красную строку на пустом
  // месте.
  useEffect(() => {
    if (me?.role !== 'super') return;
    papi('/platform/partners').then((p) => setPartners(Array.isArray(p) ? p : [])).catch(() => {});
  }, [me]);

  // Поиск ищет на СЕРВЕРЕ: телефон он сравнивает по последним десяти
  // цифрам (люди пишут номер то с +7, то с 8), и повторять это правило в
  // браузере — значит однажды разойтись с ним.
  useEffect(() => {
    const id = setTimeout(() => load(q), 350);
    return () => clearTimeout(id);
  }, [q]);

  const patch = async (id: string, body: any) => {
    setBusy(true);
    try {
      await papi(`/platform/clients/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await load(q);
      setMsg('Сохранено. Отмечено как касание сегодня.');
      setOpen(null);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const assign = async (id: string, partnerId: string) => {
    setBusy(true);
    try {
      await papi(`/platform/clients/${id}/partner`, {
        method: 'POST', body: JSON.stringify({ partnerId: partnerId || null }),
      });
      await load(q);
      const p = partners.find((x) => x.id === partnerId);
      setMsg(p ? `Клиента ведёт ${p.name}, комиссия ${p.commissionPercent}%.` : 'Клиент без партнёра — ведём сами.');
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const maxRev = Math.max(1, ...rows.map((r) => Number(r.revenue30d) || 0));

  const cols = [
    {
      h: 'Магазин', r: (c: any) => (
        <div>
          <div style={{ fontWeight: 600 }}>{c.name}</div>
          <div style={{ color: C.dim, fontSize: 13, marginTop: 2 }}>
            {[c.city, `${c.stores} ${plural(c.stores, ['точка', 'точки', 'точек'])}`,
              `${c.registers} ${plural(c.registers, ['касса', 'кассы', 'касс'])}`]
              .filter(Boolean).join(' · ')}
          </div>
        </div>
      ),
    },
    {
      h: 'Владелец', r: (c: any) => (
        <div>
          <div>{c.owner || '—'}</div>
          {c.ownerPhone
            ? <a data-btn="" href={phoneHref(c.ownerPhone)} onClick={(e) => e.stopPropagation()}
                style={{ fontFamily: MONO, fontSize: 13.5, display: 'inline-flex', alignItems: 'center' }}>
                {phoneNice(c.ownerPhone)}
              </a>
            : <span style={{ color: C.faint, fontSize: 13.5 }}>телефона нет</span>}
        </div>
      ),
    },
    { h: 'Статус', r: (c: any) => <Status value={c.status} kind="tenant" /> },
    {
      h: 'Оплачено до', r: (c: any) => {
        const l = leftText(c.daysLeft);
        return (
          <div style={{ whiteSpace: 'nowrap' }}>
            <div>{dateOnly(c.paidUntil)}</div>
            <div style={{ fontSize: 13, marginTop: 2, color: l.color }}>{l.text}</div>
          </div>
        );
      },
    },
    { h: 'Тариф', r: (c: any) => c.tariff || <span style={{ color: C.faint }}>—</span> },
    {
      h: 'Выручка 30 дней', right: true, r: (c: any) => {
        const v = Number(c.revenue30d) || 0;
        const zero = v === 0;
        return (
          <div style={{ whiteSpace: 'nowrap' }}>
            <div style={{ fontWeight: 600, color: zero ? C.red : C.text }}>{money(v)}</div>
            <div data-bar="" style={{
              height: 5, borderRadius: 3, margin: '6px 0 0 auto',
              width: zero ? '100%' : `${Math.max(4, Math.round((v / maxRev) * 100))}%`,
              background: zero ? '#E6C7C0' : C.accent,
            }} />
            <div style={{ fontSize: 13, marginTop: 4, color: zero ? C.red : C.faint }}>
              {zero ? 'продаж нет — звонить сейчас' : 'за 30 дней'}
            </div>
          </div>
        );
      },
    },
  ];

  const stats = sum ? (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
      <Stat label={me?.role === 'super' ? 'Всего клиентов' : 'Мои клиенты'} value={sum.total} />
      <Stat label="Работают" value={sum.active} sub="оплата в силе" />
      {/* Счётчик с нулём обучает себя игнорировать — его просто нет. */}
      {Number(sum.pendingPayments) > 0 && (
        <Stat label="Ждут подтверждения" value={sum.pendingPayments} sub="решает владелец платформы" />
      )}
      {Number(sum.expired) > 0 && <Stat label="Срок вышел" value={sum.expired} tone="bad" sub="доступ ещё открыт" />}
      <Stat label={me?.role === 'super' ? 'Доход в месяц' : 'Оплата клиентов в месяц'}
        value={money(sum.mrr)} sub="по работающим тарифам" />
    </div>
  ) : null;

  return (
    <>
      <PageHeader
        title="Клиенты"
        fact={rows.length
          ? `${rows.length} ${plural(rows.length, ['клиент', 'клиента', 'клиентов'])} в списке · ${rows.filter((r) => Number(r.revenue30d) === 0).length} без продаж за 30 дней`
          : 'список пуст'}
        note="Столбец «Выручка 30 дней» отвечает на вопрос, нужна ли клиенту система. Если продаж нет — продлевать он не будет, и звонить надо сейчас, а не когда кончится срок."
      />

      {stats}
      <ErrLine err={err} />
      {msg && <div style={{ color: C.accentDark, fontSize: 13.5, margin: '0 0 14px' }}>{msg}</div>}

      <DataTable
        cols={cols}
        rows={rows}
        rowStyle={rowTone}
        onRowClick={(c: any) => { setOpen(c); setMsg(''); }}
        search={false}
        storageKey="platform-clients"
        exportName="klienty-platformy"
        empty="Клиентов пока нет. Появятся, как только партнёр заведёт первого."
        hint="Строка за неделю до конца срока подсвечивается тёплым, после срока — красным. Нажмите строку, чтобы открыть карточку: партнёр, этап и заметка внутри."
        extra={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Input w={300} value={q} onChange={(e: any) => setQ(e.target.value)}
              placeholder="Название, владелец, город, телефон" />
            <span style={{ fontSize: 12.5, color: C.faint }}>
              Номер сравнивается по последним десяти цифрам — можно с +7, с 8 или без кода
            </span>
          </div>
        }
      />

      {/* Карточка клиента: партнёр, этап, заметка — то, из-за чего иначе
          пришлось бы звонить владельцу платформы. */}
      {open && (
        <ClientCard
          c={open}
          me={me}
          partners={partners}
          busy={busy}
          onClose={() => setOpen(null)}
          onSave={(body: any) => patch(open.id, body)}
          onAssign={(pid: string) => assign(open.id, pid)}
        />
      )}
    </>
  );
}

/**
 * Карточка клиента листом справа: список остаётся на месте, и после
 * правки человек продолжает с той же строки, а не ищет её заново.
 *
 * ЗАМЕТКА И ЭТАП уходят одним запросом; пустая заметка НЕ стирает
 * прежнюю — сервер оставляет старое значение. Так безопаснее: список
 * заметку не отдаёт, и стирать вслепую нельзя.
 */
function ClientCard({ c, me, partners, busy, onClose, onSave, onAssign }: any) {
  const [stage, setStage] = useState(c.dealStage || 'new');
  const [note, setNote] = useState('');
  const l = leftText(c.daysLeft);
  const rev = Number(c.revenue30d) || 0;

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(23,33,29,.44)', zIndex: 50 }} />
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 51, width: 470, maxWidth: '100%',
        background: C.bg, borderLeft: `1px solid ${C.line}`, overflowY: 'auto',
      }}>
        <div style={{
          position: 'sticky', top: 0, background: C.card, borderBottom: `1px solid ${C.line}`,
          padding: '16px 20px', display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'flex-start',
        }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.25 }}>{c.name}</div>
            <div style={{ fontSize: 13, color: C.dim, marginTop: 4 }}>
              {[c.city, c.partner ? `партнёр: ${c.partner}` : 'без партнёра'].filter(Boolean).join(' · ')}
            </div>
          </div>
          <Btn kind="ghost" onClick={onClose}>Закрыть</Btn>
        </div>

        <div style={{ padding: '18px 20px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {c.ownerPhone && (
            <a data-btn="" href={phoneHref(c.ownerPhone)} style={{
              background: C.accent, color: '#fff', borderRadius: 12, padding: '15px 18px',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, textDecoration: 'none',
            }}>
              <span>
                <span style={{ display: 'block', fontSize: 12.5, opacity: .82 }}>{c.owner || 'Владелец'} — нажмите, звонок</span>
                <span style={{ display: 'block', fontFamily: MONO, fontSize: 20, fontWeight: 500, marginTop: 4 }}>
                  {phoneNice(c.ownerPhone)}
                </span>
              </span>
            </a>
          )}

          <div style={{
            background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: '16px 18px',
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16,
          }}>
            <div>
              <div style={{ fontSize: 12.5, color: C.dim }}>Статус</div>
              <div style={{ marginTop: 5 }}><Status value={c.status} kind="tenant" /></div>
            </div>
            <div>
              <div style={{ fontSize: 12.5, color: C.dim }}>Оплачено до</div>
              <div style={{ fontSize: 15, marginTop: 5 }}>{dateLong(c.paidUntil)}</div>
              <div style={{ fontSize: 12.5, marginTop: 3, color: l.color }}>{l.text}</div>
            </div>
            <div>
              <div style={{ fontSize: 12.5, color: C.dim }}>Тариф</div>
              <div style={{ fontSize: 15, marginTop: 5 }}>{c.tariff || '—'}</div>
              <div style={{ fontSize: 12.5, color: C.dim, marginTop: 3 }}>
                {c.stores} {plural(c.stores, ['точка', 'точки', 'точек'])} · {c.registers} {plural(c.registers, ['касса', 'кассы', 'касс'])}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 12.5, color: C.dim }}>Выручка 30 дней</div>
              <div style={{ fontSize: 19, fontWeight: 600, marginTop: 5, color: rev === 0 ? C.red : C.text, fontVariantNumeric: 'tabular-nums' }}>
                {money(rev)}
              </div>
              <div style={{ fontSize: 12.5, marginTop: 3, color: rev === 0 ? C.red : C.faint }}>
                {rev === 0 ? 'система не работает — повод для звонка' : 'клиент торгует'}
              </div>
            </div>
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 12, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {me?.role === 'super' ? (
              <Field label="Партнёр ведёт клиента">
                <Select value={c.partnerId ?? ''} onChange={(e: any) => onAssign(e.target.value)}
                  options={[{ value: '', label: 'Без партнёра — ведём сами' },
                    ...partners.map((p: any) => ({ value: p.id, label: `${p.name} · ${p.commissionPercent}%` }))]} />
              </Field>
            ) : (
              <div>
                <div style={{ fontSize: 12.5, color: C.dim }}>Партнёр ведёт клиента</div>
                <div style={{ fontSize: 15, marginTop: 4 }}>{c.partner || 'вы'}</div>
              </div>
            )}

            <Field label="Этап воронки">
              <Select value={stage} onChange={(e: any) => setStage(e.target.value)} options={STAGES} />
            </Field>

            <Field label="Заметка — пустое поле прежнюю не стирает">
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                placeholder="Что решили, о чём договорились"
                style={{
                  width: '100%', padding: '11px 13px', border: `1px solid #D8D8CF`, borderRadius: 10,
                  fontSize: 16, lineHeight: 1.5, background: C.card, color: C.text, outline: 'none', resize: 'vertical',
                }} />
            </Field>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Btn onClick={() => onSave({ dealStage: stage, dealNote: note.trim() || null })} disabled={busy}>
                {busy ? 'Сохраняем…' : 'Сохранить'}
              </Btn>
              <span style={{ fontSize: 13, color: C.faint }}>
                Сейчас этап «{stageLabel(stage)}»
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
