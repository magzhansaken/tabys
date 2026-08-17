'use client';
/**
 * РАЗДЕЛ 6: «ПАРТНЁРЫ».
 *
 * Разметка из их main.tsx: grid partners, cards, toolbar, btn primary,
 * sub, num, badge st-*.
 *
 * Их столбцы: Имя, Почта, Клиентов, Доля партнёра, Заработал 30 дн.,
 * Был в системе. Добавлено сверх них: ПРИВЁЛ ДЕНЕГ — это другое число,
 * и оно важнее заработка: партнёр с малой комиссией может приносить
 * платформе больше.
 */
import { useEffect, useState } from 'react';
import { api, cached, putCache, dropCache, money, dateTime, type Me } from '../lib';

export default function Partners({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', commissionPercent: 15 });
  const [shown, setShown] = useState<{ title: string; value: string; note: string } | null>(null);
  const [offAsk, setOffAsk] = useState<any>(null);

  const load = async () => {
    const hit = cached('/partners');
    if (hit) setData(hit.data);
    try {
      const d = await api('/partners');
      setData(d); putCache('/partners', d); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (err && !data) return <div className="err">{err}</div>;
  if (!data) return <div className="muted">Загрузка…</div>;

  return (
    <>
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

      {offAsk && (
        <div className="reveal" onClick={(e) => { if (e.target === e.currentTarget) setOffAsk(null); }}>
          <div className="ask-card">
            <b>{offAsk.name}</b>
            {/* Опасное действие показывает последствие до нажатия. */}
            <p className="pay-note">{offAsk.effect}</p>
            {offAsk.activeClients > 0 && (
              <p>Работающих клиентов: {offAsk.activeClients} · дают {money(offAsk.mrr)}/мес</p>
            )}
            <div className="pay-actions">
              <button className="btn ghost" onClick={() => setOffAsk(null)}>Отмена</button>
              <button className="btn danger" onClick={async () => {
                const id = offAsk.id; setOffAsk(null);
                try {
                  await api(`/partners/${id}`, { method: 'PATCH', body: { isActive: false } });
                  dropCache(); await load();
                } catch (e: any) { setErr(e.message); }
              }}>Да, закрыть вход</button>
            </div>
          </div>
        </div>
      )}

      <div className="cards">
        <div className="card"><span>Партнёров</span><b>{data.totals.partners}</b></div>
        <div className="card money"><span>Привели за 30 дн.</span><b>{money(data.totals.brought)}</b></div>
        <div className="card"><span>К выплате</span><b>{money(data.totals.paidOut)}</b></div>
      </div>

      <div className="toolbar">
        <button className="btn primary" onClick={() => setAdding(!adding)}>
          {adding ? 'Отмена' : '+ Новый партнёр'}
        </button>
      </div>

      {adding && (
        <div className="pay-grid">
          <article className="pay">
            <div className="pay-top"><div className="pay-who"><b>Новый партнёр</b></div></div>
            <label className="sub">Имя</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <label className="sub">Почта</label>
            <input value={form.email} type="email"
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <label className="sub">Пароль — от 8 знаков, передайте лично</label>
            <input value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <label className="sub">Доля партнёра, % — с каждой подтверждённой оплаты его клиентов</label>
            <input value={String(form.commissionPercent)} inputMode="numeric"
              onChange={(e) => setForm({ ...form, commissionPercent: Number(e.target.value) || 0 })} />
            <div className="pay-actions">
              <button className="btn primary" onClick={async () => {
                try {
                  await api('/partners', { method: 'POST', body: form });
                  setShown({ title: 'Пароль партнёра', value: form.password,
                    note: 'Показан один раз — передайте лично. В базе хранится отпечатком.' });
                  setAdding(false);
                  setForm({ name: '', email: '', password: '', commissionPercent: 15 });
                  dropCache(); await load();
                } catch (e: any) { setErr(e.message); }
              }}>Завести</button>
            </div>
          </article>
        </div>
      )}

      {data.rows.length === 0 ? (
        <div className="all-clear">
          <b>Партнёров нет</b>
          <p>Заведите первого — он сможет вести своих клиентов.</p>
        </div>
      ) : (
        <table className="grid partners">
          <thead>
            <tr>
              <th>Имя</th>
              <th>Почта</th>
              <th className="num">Клиентов</th>
              <th className="num">Доля партнёра</th>
              {/* Привёл и заработал — разные числа, и первое важнее. */}
              <th className="num">Привёл 30 дн.</th>
              <th className="num">Заработал 30 дн.</th>
              <th>Был в системе</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((p: any) => (
              <tr key={p.id}>
                <td>
                  {p.name}
                  {!p.isActive && <div className="sub">вход закрыт</div>}
                </td>
                <td>
                  {p.email}
                  {p.phone && <div className="sub">{p.phone}</div>}
                </td>
                <td className="num">
                  {p.clients}
                  <div className="sub">
                    работают {p.activeClients}
                    {p.lostClients ? `, ушло ${p.lostClients}` : ''}
                  </div>
                </td>
                <td className="num">{p.commissionPercent}%</td>
                <td className="num">
                  {money(p.brought)}
                  <div className="sub">всего {money(p.broughtTotal)}</div>
                </td>
                <td className="num">
                  {money(p.earned)}
                  <div className="sub">клиенты дают {money(p.mrr)}/мес</div>
                </td>
                <td>
                  {p.neverLoggedIn
                    ? <span className="badge st-expired"><i className="dot" />ни разу</span>
                    : p.inactive
                      ? <span className="badge st-pending"><i className="dot" />{p.daysSilent} дн. назад</span>
                      : dateTime(p.lastLoginAt)}
                </td>
                <td className="actions">
                  {p.isActive ? (
                    <button className="btn small" onClick={async () => {
                      try { setOffAsk({ ...(await api(`/partners/${p.id}/off-preview`)), id: p.id }); }
                      catch (e: any) { setErr(e.message); }
                    }}>Закрыть вход</button>
                  ) : (
                    <button className="btn small" onClick={async () => {
                      try {
                        await api(`/partners/${p.id}`, { method: 'PATCH', body: { isActive: true } });
                        dropCache(); await load();
                      } catch (e: any) { setErr(e.message); }
                    }}>Открыть вход</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
