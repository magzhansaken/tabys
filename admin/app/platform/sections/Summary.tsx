'use client';
/**
 * РАЗДЕЛ 7: «СВОДКА».
 *
 * Разметка из их Summary.tsx: cards, card ok/bad/money, chart-grid,
 * chart-box, chart-head, section-title, grid ranking, place, animal,
 * num, note, sub.
 *
 * Их приёмы: два графика рядом, таблица партнёров с местом и знаком.
 * График рисуется столбиками без библиотеки — у них так же.
 */
import { useEffect, useState } from 'react';
import { api, cached, putCache, money, type Me } from '../lib';

/** Знаки партнёров: у них у каждого свой, чтобы различать в списке
 *  быстрее, чем читая имя. */
const SIGNS = ['◆', '●', '▲', '■', '★', '✦', '◈', '▼'];

const short = (iso: string) =>
  new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

export default function Summary({ me }: { me: Me }) {
  const [data, setData] = useState<any>(null);
  const [partners, setPartners] = useState<any[]>([]);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState('');

  const load = async (d = days) => {
    const path = `/metrics?days=${d}`;
    const hit = cached(path);
    if (hit) setData(hit.data);
    try {
      const [m, p] = await Promise.all([
        api(path),
        api('/partners').catch(() => ({ rows: [] })),
      ]);
      setData(m); putCache(path, m); setPartners(p.rows ?? []); setErr('');
    } catch (e: any) { if (!hit) setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (err && !data) return <div className="err">{err}</div>;
  if (!data) return <div className="muted">Загрузка…</div>;

  const t = data.now;
  const ch = data.change;
  const maxAmount = Math.max(1, ...data.series.map((d: any) => d.amount));
  const maxMrr = Math.max(1, ...data.series.map((d: any) => d.mrr));

  return (
    <>
      {err && <div className="err">{err}</div>}

      <div className="chips">
        {[7, 30, 90].map((d) => (
          <button key={d} className={`chip${days === d ? ' on' : ''}`}
            onClick={() => { setDays(d); load(d); }}>{d} дней</button>
        ))}
      </div>

      <div className="cards">
        <div className="card"><span>Всего магазинов</span><b>{t.tenants}</b></div>
        <div className="card ok"><span>Работают</span><b>{t.active}</b></div>
        <div className="card bad"><span>Срок вышел</span><b>{t.expired}</b></div>
        <div className="card money"><span>Доход в месяц</span><b>{money(t.mrr)}</b></div>
        <div className="card money"><span>Пришло за {data.days} дн.</span>
          <b>{money(data.period.amount)}</b></div>
      </div>

      <div className="chart-grid">
        <section className="chart-box">
          <div className="chart-head">
            <b>Оплаты по дням</b>
            {/* Цифра без сравнения ничего не значит: «140 тысяч» — это
                много или мало? */}
            <span>
              {data.period.payments} за период ·{' '}
              {ch.amount >= 0 ? '+' : '−'}{money(Math.abs(ch.amount))} к прошлым {data.days} дн.
            </span>
          </div>
          <Bars series={data.series} max={maxAmount} pick={(d: any) => d.amount} />
        </section>

        <section className="chart-box">
          <div className="chart-head">
            <b>Доход в месяц</b>
            <span>{money(t.mrr)} сейчас</span>
          </div>
          <Bars series={data.series} max={maxMrr} pick={(d: any) => d.mrr} />
        </section>
      </div>

      <h2 className="section-title">Партнёры за {data.days} дней</h2>
      {partners.length === 0 ? (
        <p className="note">Партнёров пока нет — заведите их во вкладке «Партнёры».</p>
      ) : (
        <table className="grid ranking">
          <thead>
            <tr>
              <th>Партнёр</th>
              <th className="num">Клиентов</th>
              <th className="num">Привёл</th>
              <th className="num">Заработал</th>
              <th className="num">Дают в месяц</th>
            </tr>
          </thead>
          <tbody>
            {partners.map((p: any, i: number) => (
              <tr key={p.id}>
                <td>
                  <span className="place">{i + 1}</span>
                  <span className="animal" title="знак партнёра">{SIGNS[i % SIGNS.length]}</span>
                  {p.name}
                  <div className="sub">{p.commissionPercent}%</div>
                </td>
                <td className="num">
                  {p.clients}
                  <div className="sub">работают {p.activeClients}</div>
                </td>
                {/* Привёл и заработал — разные числа, и первое важнее:
                    партнёр с малой комиссией может приносить больше. */}
                <td className="num">{money(p.brought)}</td>
                <td className="num">{money(p.earned)}</td>
                <td className="num">{money(p.mrr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.note && <p className="note">{data.note}</p>}
    </>
  );
}

/** Столбики без библиотеки — как у них: лишние сотни килобайт на
 *  странице, которую открывают с телефона в дороге, ни к чему. */
function Bars({ series, max, pick }: { series: any[]; max: number; pick: (d: any) => number }) {
  return (
    <div className="bars">
      {series.map((d) => (
        <span key={d.day} title={`${short(d.day)}: ${money(pick(d))}`}
          style={{ height: `${Math.max(2, (pick(d) / max) * 100)}%` }}
          className={pick(d) > 0 ? 'on' : ''} />
      ))}
    </div>
  );
}
