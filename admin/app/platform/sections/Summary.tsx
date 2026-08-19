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

const short = (iso: string) =>
  new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

export default function Summary({ me, goTo }: { me: Me; goTo?: (t: any) => void }) {
  const [data, setData] = useState<any>(null);
  const [partners, setPartners] = useState<any[]>([]);
  const [rank, setRank] = useState<any[]>([]);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState('');

  const load = async (d = days) => {
    const path = `/metrics?days=${d}`;
    const hit = cached(path);
    if (hit) setData(hit.data);
    try {
      const [m, p, r] = await Promise.all([
        api(path),
        api('/partners').catch(() => ({ rows: [] })),
        // Рейтинг ОТДЕЛЬНЫМ адресом: сводка закрыта партнёру, а
        // рейтинг ему открыт — чужие имена и суммы в нём скрыты.
        api('/ranking').catch(() => ({ rows: [] })),
      ]);
      setData(m); putCache(path, m); setPartners(p.rows ?? []);
      setRank(r.rows ?? []); setErr('');
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

      {/* РЕЙТИНГ ПАРТНЁРОВ. Взято у донора: восемь зверей от крысы до
          орла, место по числу ПЛАТЯЩИХ клиентов, зверь по ДОЛЕ в
          списке — восемь растягиваются на любое число участников.

          Их комментарий: «Дешёвая мотивация, которая работает: люди
          смотрят, кто выше».

          ОТЛИЧИЕ: у донора рейтинг лежит в сводке, а сводка закрыта
          партнёру целиком — соревнование видит только тот, кто в нём
          не участвует. У нас партнёр его видит, но ЧУЖИЕ ИМЕНА И
          СУММЫ СКРЫТЫ: вместо имени зверь, вместо дохода прочерк.

          Он видит, на каком месте и насколько отстал, но не знает, у
          кого переманивать клиентов. */}
      <h2 className="section-title">Партнёры за 30 дней</h2>
      {rank.length === 0 ? (
        <p className="note">Партнёров пока нет — заведите их во вкладке «Партнёры».</p>
      ) : (
        <table className="grid ranking">
          <thead>
            <tr>
              <th>Место</th><th>Партнёр</th>
              <th className="num">Клиентов</th>
              <th className="num">Платят</th>
              <th className="num">Их доход в месяц</th>
            </tr>
          </thead>
          <tbody>
            {rank.map((p: any) => (
              <tr key={p.place} className={p.isMe ? 'me-row' : undefined}>
                <td data-label="Место">
                  <span className="place">{p.place}</span>
                  <span className="animal" title="знак партнёра">{p.animal}</span>
                </td>
                <td data-label="Партнёр">
                  {/* Чужое имя скрыто — вместо него зверь слева. Своя
                      строка подписана: без пометки человек ищет себя
                      глазами по всей таблице. */}
                  <b>{p.name ?? '—'}</b>
                  {p.isMe && <span className="badge st-ok" style={{ marginLeft: 8 }}>вы</span>}
                </td>
                <td data-label="Клиентов" className="num">{p.clients}</td>
                <td data-label="Платят" className="num"><b>{p.paid}</b></td>
                <td data-label="Их доход в месяц" className="num">
                  {p.mrr == null ? '—' : money(p.mrr)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.note && <p className="note">{data.note}</p>}
    </>
  );
}
