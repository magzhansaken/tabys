'use client';
/**
 * РАЗДЕЛ 2: «КЛИЕНТЫ» — таблица, как у донора.
 *
 * Раскладка списана до мелочей: подзаголовок, две кнопки справа, пять
 * чисел, поиск с подсказкой что ищется, порядок, отбор по партнёру,
 * семь вкладок состояний, группировка по партнёру, таблица с семью
 * столбцами и тремя действиями в строке.
 *
 * В каждой ячейке две строки: главное сверху, уточнение снизу.
 * «Кафе Дастархан / Astana · точек 2» — это их приём и он экономит
 * половину столбцов.
 */
import { useEffect, useState } from 'react';
import { P, api, cached, putCache, dropCache, money, fullDate, type Me } from '../lib';

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

const STATE: Record<string, { text: string; tone: string }> = {
  active:      { text: 'Работает',            tone: 'ok' },
  pending_pay: { text: 'Ждёт подтверждения',  tone: 'warn' },
  approval:    { text: 'Ждёт одобрения',      tone: 'warn' },
  setup:       { text: 'Настройка',           tone: 'dim' },
  expired:     { text: 'Срок вышел',          tone: 'bad' },
  suspended:   { text: 'Отключён',            tone: 'bad' },
};

export default function Clients({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('due');
  const [partner, setPartner] = useState('all');
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [menu, setMenu] = useState<string | null>(null);

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

  if (err && !data) return <div className="pl-err">{err}</div>;
  if (!data) return <div className="pl-load">Загрузка…</div>;

  const st = data.stats;
  const c = data.counts;

  // Группировка по партнёру — их приём: сразу видно, у кого сколько и
  // кто остался ничей.
  const groups: { key: string; title: string; rows: any[] }[] = [];
  const byPartner = new Map<string, any[]>();
  for (const r of data.rows) {
    const k = r.partnerId ?? '—';
    if (!byPartner.has(k)) byPartner.set(k, []);
    byPartner.get(k)!.push(r);
  }
  for (const [k, rows] of byPartner) {
    groups.push({ key: k, title: k === '—' ? 'Ничьи' : rows[0].partner ?? 'Партнёр', rows });
  }
  // Ничьи первыми: это те, кем никто не занимается.
  groups.sort((a, b) => (a.key === '—' ? -1 : b.key === '—' ? 1 : 0));

  return (
    <>
      <style>{CSS}</style>

      <div className="cl-top">
        <div>
          <p className="cl-sub">Все магазины платформы: состояние, срок оплаты и кто ведёт.</p>
        </div>
        {me.role === 'super' && (
          <div className="cl-acts">
            <button onClick={async () => {
              try { await api('/demo', { method: 'POST' }); dropCache(); await load(); }
              catch (e: any) { setErr(e.message); }
            }}>Учебный магазин</button>
            <button className="ok">+ Новый клиент</button>
          </div>
        )}
      </div>

      {/* Пять чисел, как у них. Просроченные красным — единственное,
          что требует действия прямо сейчас. */}
      <div className="cl-stats">
        <Stat title="Всего" value={String(st.total)} />
        <Stat title="Работают" value={String(st.active)} />
        <Stat title="Ждут подтверждения" value={String(st.pendingPay)} warn={st.pendingPay > 0} />
        <Stat title="Срок вышел" value={String(st.expired)} bad={st.expired > 0} />
        <Stat title="Доход в месяц" value={money(st.mrr)} wide />
      </div>

      <div className="cl-filters">
        <input className="cl-search" value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(filter, sort, partner, q); }}
          placeholder="Поиск: магазин, владелец, телефон, город, партнёр" />

        <select value={sort} onChange={(e) => { setSort(e.target.value); load(filter, e.target.value, partner, q); }}>
          {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>

        {me.role === 'super' && (
          <select value={partner}
            onChange={(e) => { setPartner(e.target.value); load(filter, sort, e.target.value, q); }}>
            <option value="all">Все партнёры</option>
            <option value="none">Ничьи · {c.nobody}</option>
            {data.partners.map((p: any) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      <div className="cl-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={filter === t.key ? 'on' : ''}
            onClick={() => { setFilter(t.key); load(t.key, sort, partner, q); }}>
            {t.label}
            {c[t.key] ? <b>{c[t.key]}</b> : null}
          </button>
        ))}
      </div>

      {data.rows.length === 0 ? (
        <div className="cl-empty">
          <b>Никого не нашлось</b>
          <span>Проверьте отбор или поиск. Телефон можно вводить как угодно: +7, 8 или без кода.</span>
        </div>
      ) : groups.map((g) => (
        <section key={g.key} className="cl-group">
          <div className="cl-group-h">{g.title} · {g.rows.length}</div>

          <div className="cl-table-wrap">
            <table className="cl-table">
              <thead>
                <tr>
                  <th>Магазин</th>
                  <th>Владелец</th>
                  <th>Состояние</th>
                  <th>Оплачено до</th>
                  <th>Тариф</th>
                  <th className="num">Выручка 30 дн.</th>
                  <th>Партнёр</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r: any) => (
                  <tr key={r.id} className={r.expired ? 'bad' : r.expiringSoon ? 'warn' : ''}>
                    <td>
                      <b>{r.name}</b>
                      <span>
                        {r.city ?? '—'}
                        {r.stores > 1 ? ` · точек ${r.stores}` : ''}
                        {r.isDemo ? ' · учебный' : ''}
                      </span>
                    </td>
                    <td>
                      <b>{r.owner ?? '—'}</b>
                      {r.ownerPhone && (
                        <a href={`tel:${r.ownerPhone}`}>{r.ownerPhone}</a>
                      )}
                    </td>
                    <td>
                      <span className={`cl-badge ${STATE[r.state]?.tone ?? 'dim'}`}>
                        {STATE[r.state]?.text ?? r.state}
                      </span>
                      {r.pendingPayments > 0 && <span>оплат: {r.pendingPayments}</span>}
                    </td>
                    <td>
                      <b>{r.paidUntil ? fullDate(r.paidUntil) : '—'}</b>
                      {r.daysLeft != null && (
                        <span className={r.expired ? 'red' : r.expiringSoon ? 'amber' : ''}>
                          {r.daysLeft < 0
                            ? `просрочен ${Math.abs(r.daysLeft)} дн.`
                            : `осталось ${r.daysLeft} дн.`}
                        </span>
                      )}
                    </td>
                    <td>
                      <b>{r.tariff ?? '—'}</b>
                      <span>{money(r.monthly)}/мес</span>
                    </td>
                    {/* Выручка магазина — главный столбец: он отвечает,
                        живёт ли клиент. Продаж нет — продлевать не будет. */}
                    <td className="num">{money(r.revenue30d)}</td>
                    <td>{r.partner ?? <i>без партнёра</i>}</td>
                    <td className="cl-row-acts">
                      <button className="ok">Оплата</button>
                      <button>Карточка</button>
                      <button className="dots"
                        onClick={() => setMenu(menu === r.id ? null : r.id)}>···</button>

                      {menu === r.id && (
                        <div className="cl-menu">
                          <button onClick={async () => {
                            setMenu(null);
                            try {
                              const x = await api(`/clients/${r.id}/activation`);
                              alertBox(`Код для кассы: ${x.code}`);
                            } catch (e: any) { setErr(e.message); }
                          }}>Код для кассы</button>
                          <button onClick={async () => {
                            setMenu(null);
                            try {
                              const x = await api(`/clients/${r.id}/reset-password`,
                                { method: 'POST', body: { tenantId: r.id } });
                              alertBox(`Новый пароль владельцу: ${x.password}`);
                            } catch (e: any) { setErr(e.message); }
                          }}>Сбросить пароль</button>
                          {me.role === 'super' && (
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
          </div>
        </section>
      ))}

      {err && <div className="pl-err">{err}</div>}
    </>
  );
}

function Stat({ title, value, warn, bad, wide }: {
  title: string; value: string; warn?: boolean; bad?: boolean; wide?: boolean;
}) {
  return (
    <div className={`cl-stat ${bad ? 'bad' : warn ? 'warn' : ''} ${wide ? 'wide' : ''}`}>
      <span>{title}</span>
      <b>{value}</b>
    </div>
  );
}

/** Показ кода и пароля: своё окно, а не системное. */
function alertBox(text: string) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;z-index:1000;display:grid;place-items:center;'
    + 'background:rgba(20,24,22,.45);padding:16px';
  d.innerHTML = `<div style="background:#fff;border-radius:16px;padding:24px;max-width:380px;
    font-size:19px;font-weight:600;text-align:center;letter-spacing:1px">${text}
    <div style="font-size:13px;color:#5f6866;font-weight:400;margin-top:10px;letter-spacing:0">
    Показан один раз — продиктуйте сейчас</div></div>`;
  d.onclick = () => d.remove();
  document.body.append(d);
}

const CSS = `
.cl-top { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 16px; flex-wrap: wrap; }
.cl-sub { font-size: 14px; color: ${P.dim}; margin: 0; }
.cl-acts { margin-left: auto; display: flex; gap: 8px; }
.cl-acts button {
  min-height: 38px; padding: 0 14px; border-radius: ${P.r.sm}px;
  border: 1px solid ${P.line}; background: ${P.card}; color: ${P.ink};
  font-size: 14px; cursor: pointer; white-space: nowrap;
}
.cl-acts button.ok { background: ${P.accent}; border-color: ${P.accent};
  color: ${P.accentInk}; font-weight: 600; }

.cl-stats { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.cl-stat { background: ${P.card}; border: 1px solid ${P.line};
  border-radius: ${P.r.md}px; padding: 12px 16px; min-width: 118px; }
.cl-stat span { display: block; font-size: 12.5px; color: ${P.dim}; }
.cl-stat b { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
.cl-stat.wide b { font-size: 20px; }
.cl-stat.warn { border-color: ${P.accentSoft}; }
.cl-stat.warn b { color: ${P.accentSoft}; }
.cl-stat.bad { border-color: ${P.danger}; }
.cl-stat.bad b { color: ${P.danger}; }

.cl-filters { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.cl-search { flex: 1; min-width: 260px; min-height: 40px; padding: 0 12px;
  font-size: 15px; border: 1px solid ${P.line}; border-radius: ${P.r.sm}px;
  background: ${P.card}; box-sizing: border-box; }
.cl-filters select { min-height: 40px; padding: 0 10px; font-size: 14px;
  border: 1px solid ${P.line}; border-radius: ${P.r.sm}px; background: ${P.card};
  color: ${P.ink}; cursor: pointer; }

.cl-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 14px; }
.cl-tabs button {
  min-height: 36px; padding: 0 12px; border-radius: ${P.r.sm}px; font-size: 13.5px;
  border: 1px solid ${P.line}; background: ${P.card}; color: ${P.dim}; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
}
.cl-tabs button:hover { background: ${P.sunk}; }
.cl-tabs button.on { background: ${P.accent}; border-color: ${P.accent};
  color: ${P.accentInk}; font-weight: 600; }
.cl-tabs button b { font-variant-numeric: tabular-nums; }

.cl-group { margin-bottom: 20px; }
.cl-group-h { font-size: 13px; color: ${P.dim}; margin-bottom: 6px;
  text-transform: uppercase; letter-spacing: .04em; }

.cl-table-wrap { background: ${P.card}; border: 1px solid ${P.line};
  border-radius: ${P.r.md}px; overflow-x: auto; }
.cl-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.cl-table th {
  text-align: left; font-size: 12px; font-weight: 500; color: ${P.dim};
  padding: 10px 12px; border-bottom: 1px solid ${P.line}; white-space: nowrap;
}
.cl-table th.num, .cl-table td.num { text-align: right; }
.cl-table td { padding: 10px 12px; border-bottom: 1px solid ${P.lineSoft};
  vertical-align: top; }
.cl-table tr:last-child td { border-bottom: 0; }
.cl-table tr:hover td { background: ${P.sunk}; }
/* Подсветка строки: просрочен — тревога, кончается — предупреждение.
   Эти два состояния решают, звонить сегодня или нет. */
.cl-table tr.bad td:first-child { box-shadow: inset 3px 0 0 ${P.danger}; }
.cl-table tr.warn td:first-child { box-shadow: inset 3px 0 0 ${P.accentSoft}; }

/* Две строки в ячейке: главное сверху, уточнение снизу. Приём донора —
   он экономит половину столбцов. */
.cl-table td b { display: block; font-weight: 500; color: ${P.ink}; }
.cl-table td span { display: block; font-size: 12.5px; color: ${P.dim}; margin-top: 1px; }
.cl-table td a { display: block; font-size: 12.5px; color: ${P.accentSoft};
  text-decoration: none; margin-top: 1px; }
.cl-table td i { color: ${P.faint}; font-style: normal; }
.cl-table td span.red { color: ${P.danger}; }
.cl-table td span.amber { color: ${P.accentSoft}; }
.cl-table td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }

.cl-badge { display: inline-block !important; font-size: 12px; padding: 2px 8px;
  border-radius: 999px; margin: 0 !important; }
.cl-badge.ok { background: rgba(56,98,74,.12); color: #38624a; }
.cl-badge.warn { background: rgba(184,118,28,.14); color: ${P.accentSoft}; }
.cl-badge.bad { background: rgba(143,58,44,.12); color: ${P.danger}; }
.cl-badge.dim { background: ${P.lineSoft}; color: ${P.dim}; }

.cl-row-acts { position: relative; white-space: nowrap; }
.cl-row-acts button {
  min-height: 32px; padding: 0 10px; border-radius: ${P.r.sm}px; font-size: 13px;
  border: 1px solid ${P.line}; background: ${P.card}; color: ${P.ink};
  cursor: pointer; margin-left: 4px;
}
.cl-row-acts button.ok { background: ${P.accent}; border-color: ${P.accent};
  color: ${P.accentInk}; }
.cl-row-acts button.dots { padding: 0 8px; letter-spacing: 1px; }
.cl-menu {
  position: absolute; right: 0; top: 36px; z-index: 5;
  background: ${P.card}; border: 1px solid ${P.line}; border-radius: ${P.r.sm}px;
  box-shadow: 0 8px 24px rgba(0,0,0,.12); padding: 4px; min-width: 180px;
}
.cl-menu button { display: block; width: 100%; text-align: left; margin: 0;
  border: 0; background: none; min-height: 36px; }
.cl-menu button:hover { background: ${P.sunk}; }

.cl-empty { background: ${P.card}; border: 1px solid ${P.line};
  border-radius: ${P.r.md}px; padding: 40px 20px; text-align: center; }
.cl-empty b { display: block; font-family: ${P.display}; font-size: 19px;
  color: ${P.ink}; margin-bottom: 6px; }
.cl-empty span { font-size: 14px; color: ${P.dim}; }

@media (max-width: 860px) {
  .cl-stat { flex: 1; min-width: 90px; padding: 10px 12px; }
  .cl-stat b { font-size: 20px; }
  .cl-table { font-size: 13px; }
}
`;
