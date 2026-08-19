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
import { Chart } from '../ui/Chart';
import { humanError } from '../ui/errors';
import { Empty, Failed, SkeletonCards, SkeletonMetrics, PageHead } from '../ui/States';

/** Знаки партнёров: у них у каждого свой, чтобы различать в списке
 *  быстрее, чем читая имя. */
const SIGNS = ['◆', '●', '▲', '■', '★', '✦', '◈', '▼'];

const short = (iso: string) =>
  new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

export default function Summary({ me, goTo }: { me: Me; goTo?: (t: any) => void }) {
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
    } catch (e: any) { if (!hit) setErr(humanError(e)); }
  };
  useEffect(() => { load(); }, []);

  if (err && !data) return <Failed text={err} onRetry={() => load()} />;
  if (!data) return <><SkeletonMetrics count={5} /><SkeletonCards count={2} height={210} /></>;

  const t = data.now;
  const ch = data.change;
  // ПЕРВЫЙ ДЕНЬ: клиентов нет, и графики из нулей дают прямую линию по
  // низу. Человек видит пустоту и не понимает — система сломалась или
  // данных ещё нет. Говорим прямо.
  if (t.tenants === 0) return (
    <>
      <PageHead title="Сводка платформы" sub="За 30 дней" />
      <Empty
        title="Клиентов пока нет"
        text="Здесь появится картина платформы: сколько магазинов платят, сколько денег приходит и как это меняется. Заведите первого клиента — и через сутки будет что показать."
        actionLabel="Завести клиента"
        onAction={goTo ? () => goTo('clients') : undefined} />
    </>
  );

  const maxAmount = Math.max(1, ...data.series.map((d: any) => d.amount));
  const maxMrr = Math.max(1, ...data.series.map((d: any) => d.mrr));

  return (
    <>
      <PageHead title={'Сводка платформы'} sub={`За ${data.days} дней`} />

      {err && <div className="err">{err}</div>}

      <div className="chips">
        {[7, 30, 90].map((d) => (
          <button key={d} className={`chip${days === d ? ' on' : ''}`}
            onClick={() => { setDays(d); load(d); }}>{d} дней</button>
        ))}
      </div>

      <div className="cards">
        <div className="card"><span>Всего магазинов</span><b>{t.tenants}</b></div>
        {/* «Платят», а не «работают»: пробный тоже работает, и при
            прежней подписи карточки пересекались — человек складывал
            и получал больше, чем всего. */}
        {/* «Платят» — уже была подтверждённая оплата. В «Клиентах»
            рядом стоит «Работают» — там больше, потому что туда
            входят и пробные. Подписи объясняют разницу. */}
        <div className="card ok">
          <span>Платят</span><b>{t.active}</b>
          <i>была хоть одна оплата</i>
        </div>
        <div className="card warn"><span>На пробном</span><b>{t.trial}</b></div>
        <div className="card bad"><span>Просрочены</span><b>{t.expired}</b></div>
        {/* Ждут одобрения: кто-то стоит у двери. Их карточка. */}
        <div className="card warn"><span>Ждут одобрения</span><b>{t.pending}</b></div>
        <div className="card money"><span>Доход в месяц</span><b>{money(t.mrr)}</b></div>
        {/* «Поступило сегодня» — вопрос, с которого начинается день
            владельца платформы. Их карточка. */}
        <div className="card money">
          <span>Поступило сегодня</span>
          <b>{money(t.revenueToday)}</b>
          {/* Только ПОДТВЕРЖДЁННОЕ: отмеченное, но не подтверждённое
              сюда не входит — денег ещё нет, а строка уже есть. */}
          <i>подтверждённые оплаты</i>
        </div>
      </div>

      <div className="chart-grid">
        {/* ПЛАТЯЩИЕ КЛИЕНТЫ, а не оплаты по дням. Их выбор, и он
            вернее: оплаты скачут — сегодня три, завтра ноль, и по
            такому графику ничего не понять. Число платящих растёт или
            падает ровно, и это единственная линия, которая отвечает
            на вопрос «мы растём?». */}
        <section className="chart-box">
          <div className="chart-head">
            <b>Платящие клиенты за {data.days} дней</b>
            <span>{t.active} сейчас</span>
          </div>
          <Chart title={`Платящие клиенты за ${data.days} дней`}
            format={(v) => String(Math.round(v))}
            points={data.series.map((d: any) => ({ label: short(d.day), value: d.active }))} />
        </section>

        <section className="chart-box">
          <div className="chart-head">
            <b>Доход в месяц за {data.days} дней</b>
            <span>{money(t.mrr)} сейчас</span>
          </div>
          <Chart title={`Доход в месяц за ${data.days} дней`} format={(v) => money(v)}
            points={data.series.map((d: any) => ({ label: short(d.day), value: d.mrr }))} />
        </section>

        {/* Третий график сверх их двух: приход по дням. Он скачет, и
            смотреть на него как на «растём ли мы» нельзя — но ответить
            «когда именно пришли деньги» больше нечем. Стоит третьим,
            а не первым, чтобы не путать с двумя ровными линиями. */}
        <section className="chart-box">
          <div className="chart-head">
            <b>Приход по дням</b>
            <span>
              {data.period.payments} оплат ·{' '}
              {ch.amount >= 0 ? '+' : '−'}{money(Math.abs(ch.amount))} к прошлым {data.days} дн.
            </span>
          </div>
          <Chart title="Приход по дням" format={(v) => money(v)}
            points={data.series.map((d: any) => ({ label: short(d.day), value: d.amount }))} />
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
              <th className="num">Платят</th>
              <th className="num">Привёл</th>
              <th className="num">Заработал</th>
              <th className="num">Дают в месяц</th>
            </tr>
          </thead>
          <tbody>
            {partners.map((p: any, i: number) => (
              <tr key={p.id}>
                <td data-label="Место">
                  <span className="place">{i + 1}</span>
                  <span className="animal" title="знак партнёра">{SIGNS[i % SIGNS.length]}</span>
                  {p.name}
                  <div className="sub">{p.commissionPercent}%</div>
                </td>
                <td className="num" data-label="Клиентов">{p.clients}</td>
                {/* «Платят» отдельным столбцом — их приём: заведено
                    десять, а платят двое, и это разные вещи. */}
                <td className="num" data-label="Платят"><b>{p.activeClients}</b></td>
                {/* Привёл и заработал — разные числа, и первое важнее:
                    партнёр с малой комиссией может приносить больше. */}
                <td className="num" data-label="Привёл">{money(p.brought)}</td>
                <td className="num" data-label="Заработал">{money(p.earned)}</td>
                <td className="num" data-label="Их доход в месяц">{money(p.mrr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.note && <p className="note">{data.note}</p>}
    </>
  );
}
