'use client';
/**
 * РАЗДЕЛ 2: «КЛИЕНТЫ».
 *
 * Разметка и КЛАССЫ взяты из кабинета проекта автоматизации
 * ресторанов: grid tenants, badge st-*, btn small ghost, chips, cards,
 * toolbar, partner-strip. Оформление к ним лежит в style/admin.css —
 * их файл целиком, ни одна строка не переписана.
 *
 * Отличия от ресторана только там, где отличается дело:
 *   «заведение» → «магазин»;
 *   вместо экранов кухни и официантов — точки и кассы;
 *   выручка магазина вместо выручки заведения.
 * Всё остальное — их: цвета, размеры, поведение при наведении.
 */
import { useEffect, useState } from 'react';
import { api, cached, putCache, dropCache, money, fullDate, type Me } from '../lib';

const TABS = [
  { key: 'all',         label: 'Все' },
  { key: 'approval',    label: 'Ждут одобрения' },
  { key: 'active',      label: 'Работают' },
  { key: 'pending_pay', label: 'Ждут подтверждения' },
  { key: 'setup',       label: 'Настройка' },
  { key: 'expired',     label: 'Просрочены' },
  { key: 'suspended',   label: 'Отключены' },
];

const SORTS = [
  { key: 'due',     label: 'Сначала просроченные' },
  { key: 'price',   label: 'Сначала дорогие' },
  { key: 'revenue', label: 'По выручке магазина' },
  { key: 'name',    label: 'По названию' },
];

/** Значки состояний — их классы st-*, оформление в их же файле. */
const STATE: Record<string, { text: string; cls: string }> = {
  active:      { text: 'Работает',           cls: 'st-active' },
  pending_pay: { text: 'Ждёт подтверждения', cls: 'st-pending' },
  approval:    { text: 'Ждёт одобрения',     cls: 'st-approval' },
  setup:       { text: 'Настройка',          cls: 'st-setup' },
  expired:     { text: 'Срок вышел',         cls: 'st-expired' },
  suspended:   { text: 'Отключён',           cls: 'st-suspended' },
};

export default function Clients({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('due');
  const [partner, setPartner] = useState('all');
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [shown, setShown] = useState<{ title: string; value: string; note: string } | null>(null);

  const load = async (f = filter, s = sort, p = partner, search = q) => {
    const u = new URLSearchParams();
    if (f !== 'all') u.set('filter', f);
    if (s !== 'due') u.set('sort', s);
    if (p !== 'all') u.set('partnerId', p);
    if (search.trim()) u.set('q', search.trim());
    const path = '/clients?' + u.toString();

    const hit = cached(path);
    if (hit) setData(hit.data);
    try {
      const d = await api(path);
      setData(d); putCache(path, d); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (err && !data) return <div className="err">{err}</div>;
  if (!data) return <div className="muted">Загрузка…</div>;

  const st = data.stats;
  const c = data.counts;
  const isSuper = me.role === 'super';

  // Группировка по партнёру: ничьи первыми — это те, кем никто не
  // занимается, и они теряются первыми.
  const byPartner = new Map<string, any[]>();
  for (const r of data.rows) {
    const k = r.partnerId ?? '—';
    if (!byPartner.has(k)) byPartner.set(k, []);
    byPartner.get(k)!.push(r);
  }
  const groups = [...byPartner.entries()]
    .map(([k, rows]) => ({ key: k, title: k === '—' ? 'Ничьи' : rows[0].partner, rows }))
    .sort((a, b) => (a.key === '—' ? -1 : b.key === '—' ? 1 : 0));

  return (
    <>
      <div className="page-head">
        <div>
          <p className="muted">Все магазины платформы: состояние, срок оплаты и кто ведёт.</p>
        </div>
        {isSuper && (
          <div className="head-actions">
            <button className="btn" onClick={async () => {
              try { await api('/demo', { method: 'POST' }); dropCache(); await load(); }
              catch (e: any) { setErr(e.message); }
            }}>Учебный магазин</button>
            <button className="btn primary">+ Новый клиент</button>
          </div>
        )}
      </div>

      {/* Пять чисел — их блок cards с видами ok / warn / bad / money. */}
      <div className="cards">
        <div className="card"><span>Всего</span><b>{st.total}</b></div>
        <div className="card ok"><span>Работают</span><b>{st.active}</b></div>
        <div className="card warn"><span>Ждут подтверждения</span><b>{st.pendingPay}</b></div>
        <div className="card bad"><span>Срок вышел</span><b>{st.expired}</b></div>
        <div className="card money"><span>Доход в месяц</span><b>{money(st.mrr)}</b></div>
      </div>

      <div className="toolbar">
        <input className="search" value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(filter, sort, partner, q); }}
          placeholder="Поиск: магазин, владелец, телефон, город, партнёр" />

        <select className="sorter" value={sort}
          onChange={(e) => { setSort(e.target.value); load(filter, e.target.value, partner, q); }}>
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>

        {isSuper && (
          <select className="sorter" value={partner}
            onChange={(e) => { setPartner(e.target.value); load(filter, sort, e.target.value, q); }}>
            <option value="all">Все партнёры</option>
            <option value="none">Ничьи · {c.nobody}</option>
            {data.partners.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>

      <div className="chips">
        {TABS.map((t) => (
          <button key={t.key} className={`chip${filter === t.key ? ' on' : ''}`}
            onClick={() => { setFilter(t.key); load(t.key, sort, partner, q); }}>
            {t.label}{c[t.key] ? <b> {c[t.key]}</b> : null}
          </button>
        ))}
      </div>

      {err && <div className="err">{err}</div>}

      {shown && (
        <div className="reveal" onClick={() => setShown(null)}>
          <div className="reveal-card">
            <span>{shown.title}</span>
            <b>{shown.value}</b>
            <i>{shown.note}</i>
          </div>
        </div>
      )}

      {data.rows.length === 0 ? (
        <div className="empty">
          <b>Никого не нашлось</b>
          <span>Проверьте отбор или поиск. Телефон можно вводить как угодно: +7, 8 или без кода.</span>
        </div>
      ) : groups.map((g) => (
        <section key={g.key}>
          <div className="partner-strip">
            <span className={g.key === '—' ? 'nobody' : ''}>{g.title}</span>
            <span className="strip-money">· {g.rows.length}</span>
          </div>

          <table className="grid tenants">
            <thead>
              <tr>
                <th>Магазин</th>
                <th>Владелец</th>
                <th>Статус</th>
                <th>Оплачено до</th>
                <th>Тариф</th>
                <th className="num">Выручка 30 дн.</th>
                <th>Партнёр</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r: any) => (
                <tr key={r.id}>
                  <td>
                    <span className="link-name">{r.name}</span>
                    <div className="sub">
                      {r.city ?? '—'}
                      {r.stores > 1 ? ` · точек ${r.stores}` : ''}
                      {r.registers > 1 ? ` · касс ${r.registers}` : ''}
                      {r.isDemo ? ' · учебный' : ''}
                    </div>
                  </td>
                  <td>
                    {r.owner ?? '—'}
                    {r.ownerPhone && <div className="sub">
                      <a href={`tel:${r.ownerPhone}`}>{r.ownerPhone}</a>
                    </div>}
                  </td>
                  <td>
                    <span className={`badge ${STATE[r.state]?.cls ?? 'st-unknown'}`}>
                      {STATE[r.state]?.text ?? r.state}
                    </span>
                    {r.pendingPayments > 0 && <div className="sub">оплат: {r.pendingPayments}</div>}
                  </td>
                  <td>
                    {r.paidUntil ? fullDate(r.paidUntil) : '—'}
                    {r.daysLeft != null && (
                      <div className="sub">
                        {r.daysLeft < 0
                          ? `просрочен ${Math.abs(r.daysLeft)} дн.`
                          : `осталось ${r.daysLeft} дн.`}
                      </div>
                    )}
                  </td>
                  <td>
                    {r.tariff ?? '—'}
                    <div className="sub">{money(r.monthly)}/мес</div>
                  </td>
                  {/* Выручка магазина: отвечает, живёт ли клиент.
                      Продаж нет — продлевать не будет. */}
                  <td className="num">{money(r.revenue30d)}</td>
                  <td>{r.partner ?? <span className="nobody">без партнёра</span>}</td>
                  <td className="actions">
                    <button className="btn small accent">Оплата</button>
                    <button className="btn small">Карточка</button>
                    <button className="btn small ghost"
                      onClick={() => setMenu(menu === r.id ? null : r.id)}>···</button>

                    {menu === r.id && (
                      <div className="row-menu">
                        <button onClick={async () => {
                          setMenu(null);
                          try {
                            const x = await api(`/clients/${r.id}/activation`);
                            setShown({ title: 'Код для кассы', value: x.code, note: x.note });
                          } catch (e: any) { setErr(e.message); }
                        }}>Код для кассы</button>
                        <button onClick={async () => {
                          setMenu(null);
                          try {
                            const x = await api(`/clients/${r.id}/reset-password`,
                              { method: 'POST', body: { tenantId: r.id } });
                            setShown({ title: 'Новый пароль владельцу', value: x.password, note: x.note });
                          } catch (e: any) { setErr(e.message); }
                        }}>Сбросить пароль</button>
                        {isSuper && (
                          <button onClick={async () => {
                            setMenu(null);
                            try {
                              await api(`/clients/${r.id}/status`, { method: 'POST',
                                body: { active: r.state === 'suspended' } });
                              dropCache(); await load();
                            } catch (e: any) { setErr(e.message); }
                          }}>{r.state === 'suspended' ? 'Разморозить' : 'Заморозить'}</button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
