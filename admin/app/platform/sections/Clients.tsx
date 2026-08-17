'use client';
/**
 * РАЗДЕЛ 2: «КЛИЕНТЫ» — список с отборами и карточка.
 *
 * Карточка — не окно-тупик: она разворачивается прямо в списке со
 * всеми действиями. Изучил клиента — свернул и работаешь дальше, не
 * теряя место в списке.
 *
 * Счётчики на вкладках приходят с сервера вместе со списком: цифра и
 * её содержимое считаются в одном месте и не могут разойтись.
 */
import { useEffect, useState } from 'react';
import { C, Card, Btn, Input, Field, Select, ErrLine, EmptyState, Status } from '../../../lib/ui';
import { P, api, cached, putCache, dropCache, money, fullDate, daysWord, type Me } from '../lib';

type Row = {
  id: string; name: string; phone: string; city: string | null;
  owner: string | null; ownerPhone: string | null;
  status: string; tariff: string | null;
  partner: string | null; partnerId: string | null; partnerPercent: number;
  dealStage: string | null; dealNote: string | null; isDemo: boolean;
  paidUntil: string | null; daysLeft: number | null; monthly: number;
  expiringSoon: boolean; expired: boolean;
  revenue30d: number; stores: number; registers: number;
};

const FILTERS = [
  { key: 'all',      label: 'Все' },
  { key: 'active',   label: 'Работают' },
  { key: 'expiring', label: 'Кончается' },
  { key: 'expired',  label: 'Просрочены' },
  { key: 'trial',    label: 'Пробные' },
  { key: 'demo',     label: 'Учебные' },
];

export default function Clients({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const load = async (f = filter, search = q) => {
    const p = new URLSearchParams();
    if (f !== 'all') p.set('filter', f);
    if (search.trim()) p.set('q', search.trim());
    const path = '/clients?' + p.toString();

    // Известное показываем сразу — переключение отбора не должно
    // очищать экран. Ключ памяти включает отбор и поиск: у каждого
    // сочетания свой ответ.
    const hit = cached(path);
    if (hit) setData(hit.data);
    try {
      const d = await api(path);
      setData(d); putCache(path, d); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (err && !data) return <ErrLine err={err} />;
  if (!data) return <div style={{ color: P.dim, padding: 20 }}>Загрузка…</div>;

  const c = data.counts;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {err && <ErrLine err={err} />}

      {/* Отборы со счётчиками. Пустые не рисуем: счётчик с нулём
          обучает себя игнорировать. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {FILTERS.filter((f) => f.key === 'all' || c[f.key] > 0).map((f) => (
          <button key={f.key}
            onClick={() => { setFilter(f.key); load(f.key, q); }}
            style={{
              minHeight: 38, padding: '0 12px', borderRadius: 10, fontSize: 14, cursor: 'pointer',
              border: `1px solid ${filter === f.key ? P.accent : P.line}`,
              background: filter === f.key ? P.accent : P.card,
              color: filter === f.key ? '#fff' : P.ink,
            }}>
            {f.label} <b>{c[f.key]}</b>
          </button>
        ))}
        <div style={{ flex: 1, minWidth: 200 }}>
          <Input value={q} onChange={(e: any) => setQ(e.target.value)}
            onKeyDown={(e: any) => { if (e.key === 'Enter') load(filter, q); }}
            placeholder="Название, владелец, город или телефон" />
        </div>
      </div>

      {data.rows.length === 0 ? (
        <EmptyState text="Никого не нашлось. Проверьте отбор или поиск. Телефон можно вводить как угодно: +7, 8 или без кода." />
      ) : data.rows.map((r: Row) => (
        <ClientRow key={r.id} r={r} me={me}
          open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)}
          onChanged={() => load()} />
      ))}
    </div>
  );
}

function ClientRow({ r, me, open, onToggle, onChanged }: {
  r: Row; me: Me; open: boolean; onToggle: () => void; onChanged: () => void;
}) {
  const [card, setCard] = useState<any>(null);
  const [err, setErr] = useState('');
  const [pass, setPass] = useState<string | null>(null);
  const [code, setCode] = useState<any>(null);

  useEffect(() => {
    if (open && !card) api(`/clients/${r.id}/card`).then(setCard).catch((e) => setErr(e.message));
  }, [open]);

  // Подсветка строки: просрочен — тревога, кончается — предупреждение.
  // Эти два состояния решают, звонить сегодня или нет.
  const edge = r.expired ? P.danger : r.expiringSoon ? P.accentSoft : P.line;

  return (
    <Card style={{ borderLeft: `3px solid ${edge}` }}>
      <div onClick={onToggle} style={{ cursor: 'pointer', display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <b style={{ fontSize: 17, fontFamily: P.display, fontWeight: 400 }}>{r.name}</b>
          {r.isDemo && <Status value="demo" kind="tenant" />}
          <span style={{ fontSize: 14, color: P.dim }}>{r.city}</span>
          <span style={{ marginLeft: 'auto', fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>
            {money(r.monthly)}/мес
          </span>
        </div>

        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 14, color: P.dim }}>
          <span>{r.owner ?? '—'}</span>
          {r.ownerPhone && (
            <a href={`tel:${r.ownerPhone}`} onClick={(e) => e.stopPropagation()}
              style={{ color: P.accent, textDecoration: 'none' }}>{r.ownerPhone}</a>
          )}
          <span style={{ color: r.expired ? P.danger : r.expiringSoon ? P.accentSoft : P.dim }}>
            {r.paidUntil ? `оплачено до ${fullDate(r.paidUntil)} · ${daysWord(r.daysLeft)}` : 'без подписки'}
          </span>
          {/* Выручка за 30 дней — главный столбец: он отвечает, живёт ли
              клиент. Продаж нет — продлевать не будет. */}
          <span title="выручка магазина за 30 дней — живёт ли клиент">
            выручка {money(r.revenue30d)}
          </span>
          {r.partner && <span>партнёр: {r.partner}</span>}
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${P.line}` }}>
          {err && <ErrLine err={err} />}
          {!card ? <div style={{ color: P.dim }}>Загрузка карточки…</div> : (
            <div style={{ display: 'grid', gap: 14 }}>
              {/* Состав счёта строками: клиент добавил кассу — цена
                  выросла на понятную величину, а не стала другой цифрой. */}
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
                  Счёт · {money(card.monthly)}/мес
                </div>
                {card.lines.length === 0
                  ? <div style={{ fontSize: 14, color: P.dim }}>Строк нет — платит по тарифу</div>
                  : card.lines.filter((l: any) => l.active).map((l: any) => (
                    <div key={l.id} style={{ display: 'flex', fontSize: 14, padding: '3px 0' }}>
                      <span>{l.title}</span>
                      <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums',
                        color: l.price < 0 ? P.accent : P.ink }}>
                        {money(l.price)}{l.qty > 1 ? ` × ${l.qty}` : ''}
                      </span>
                    </div>
                  ))}
              </div>

              <div style={{ display: 'flex', gap: 20, fontSize: 14, color: P.dim, flexWrap: 'wrap' }}>
                <span>точек: {card.stores}</span>
                <span>касс: {card.registers}</span>
                <span>оплат: {card.payments.length}</span>
                {card.dealNote && <span>заметка: {card.dealNote}</span>}
              </div>

              {pass && (
                <div style={{ background: P.bg, border: `1px solid ${P.accentSoft}`,
                  borderRadius: 10, padding: 12 }}>
                  <div style={{ fontSize: 14, marginBottom: 4 }}>Новый пароль владельцу:</div>
                  <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: 1 }}>{pass}</div>
                  <div style={{ fontSize: 13, color: P.dim, marginTop: 4 }}>
                    Показан один раз — продиктуйте владельцу сейчас
                  </div>
                </div>
              )}

              {code && (
                <div style={{ background: P.bg, border: `1px solid ${P.accent}`,
                  borderRadius: 10, padding: 12 }}>
                  <div style={{ fontSize: 14, marginBottom: 4 }}>Код привязки кассы:</div>
                  <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: 3 }}>{code.code}</div>
                  <div style={{ fontSize: 13, color: P.dim, marginTop: 4 }}>{code.note}</div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Btn onClick={async () => {
                  try { setCode(await api(`/clients/${r.id}/activation`)); setErr(''); }
                  catch (e: any) { setErr(e.message); }
                }}>Код для кассы</Btn>

                <Btn onClick={async () => {
                  try {
                    const x = await api(`/clients/${r.id}/reset-password`, { method: 'POST',
                      body: { tenantId: r.id } });
                    setPass(x.password); setErr('');
                  } catch (e: any) { setErr(e.message); }
                }}>Сбросить пароль владельцу</Btn>

                {me.role === 'super' && (
                  <Btn onClick={async () => {
                    try {
                      await api(`/clients/${r.id}/status`, { method: 'POST',
                        body: { active: r.status !== 'active' } });
                      onChanged();
                    } catch (e: any) { setErr(e.message); }
                  }}>{r.status === 'active' ? 'Заморозить' : 'Разморозить'}</Btn>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
